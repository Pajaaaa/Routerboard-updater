'use strict';
/**
 * Odesílání e-mailů přes SMTP relay bez přihlášení (20.11.2026, pro hlášení automatického upgradu). Bez závislostí: holé SMTP nad net,
 * STARTTLS, když ho server nabízí (certifikát se neověřuje — relay je ve vlastní síti a jde jen o šifrování po cestě); když se šifrování
 * nepovede (starý server), pošle se zpráva znovu nešifrovaně. MTU_SMTP_TLS=no šifrování nezkouší, =require bez něj neposílá.
 * Zapíná se nastavením MTU_SMTP_HOST; bez něj enabled() = false a nic se neposílá.
 */
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const cfg = require('./config');

const enabled = () => !!(cfg.mail && cfg.mail.host);
const addrOf = (s) => { const m = String(s || '').match(/<([^<>\s]+@[^<>\s]+)>/); return (m ? m[1] : String(s || '')).trim(); };
/** jen tisknutelné ASCII, místní část ≤ 64, celkem ≤ 254, doména po labelech (bez prázdných, bez pomlčky na kraji) */
const validAddr = (s) => {
  s = String(s == null ? '' : s);
  if (s.length > 254 || !/^[\x21-\x7e]+$/.test(s) || /[<>,;"()\[\]\\:]/.test(s)) return false;
  const at = s.lastIndexOf('@'); if (at < 1 || s.indexOf('@') !== at || at > 64) return false;
  const loc = s.slice(0, at), labels = s.slice(at + 1).split('.');
  if (loc.startsWith('.') || loc.endsWith('.') || loc.includes('..')) return false;
  return labels.length >= 2 && labels.every(l => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
};
/** hodnota hlavičky: krátké ASCII beze změny, jinak RFC 2047 encoded-words po nejvýš 39 bajtech (s názvem hlavičky ≤ 76 znaků na řádek), dělené na hranici znaku */
const encWord = (s) => {
  if (/^[\x20-\x7e]*$/.test(s) && s.length <= 60 && !s.includes('=?')) return s;
  const parts = []; let cur = '';
  for (const ch of s) { if (Buffer.byteLength(cur + ch, 'utf8') > 39) { parts.push(cur); cur = ''; } cur += ch; }
  if (cur) parts.push(cur);
  return parts.map(p => `=?UTF-8?B?${Buffer.from(p, 'utf8').toString('base64')}?=`).join('\r\n ');
};
const MAX_RCPT = 10;

/** jedna zpráva; to = adresa nebo pole adres. Vrací odpověď serveru na konec DATA, při chybě vyhodí výjimku. */
function send(m) {
  // relay se starým TLS (smtp.hkfree.org umí jen TLS 1.0/1.1, Node ho odmítne): šifrování se nepovedlo → jednou znovu bez STARTTLS
  return sendOnce(m, cfg.mail.tls !== 'no').catch((e) => { if (e && e.tlsFailed && cfg.mail.tls !== 'require') return sendOnce(m, false); throw e; });
}
function sendOnce({ to, subject, text, onRejected }, useTls) {
  if (!enabled()) return Promise.reject(new Error('odesílání e-mailů není nastavené (MTU_SMTP_HOST)'));
  const rcpt = (Array.isArray(to) ? to : String(to || '').split(/[\s,;]+/)).map(x => x.trim()).filter(Boolean);
  if (!rcpt.length || rcpt.length > MAX_RCPT || !rcpt.every(validAddr)) return Promise.reject(new Error('neplatná adresa příjemce: ' + rcpt.join(', ')));
  const from = cfg.mail.from, fromAddr = addrOf(from);
  const helo = (cfg.mail.helo || os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  const fromName = from.includes('<') ? from.slice(0, from.indexOf('<')).trim().replace(/^"|"$/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ') : '';
  // jméno se zvláštními znaky (čárka, závorka…) musí zůstat v uvozovkách, jinak by z něj byly dvě adresy; ne-ASCII jde jako encoded-word
  const fromDisp = !fromName ? '' : /^[\x20-\x7e]*$/.test(fromName) ? (/^[A-Za-z0-9 !#$%&'*+\/=?^_`{|}~-]*$/.test(fromName) ? fromName : `"${fromName.replace(/(["\\])/g, '\\$1')}"`) : encWord(fromName);
  const msg = [
    `From: ${fromDisp ? fromDisp + ' ' : ''}<${fromAddr}>`, `To: ${rcpt.join(',\r\n ')}`, `Subject: ${encWord(String(subject || '').replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${fromAddr.split('@')[1] || helo}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'Auto-Submitted: auto-generated', '',
    Buffer.from(String(text || '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'), '.', '',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    let sock = net.connect({ host: cfg.mail.host, port: cfg.mail.port });
    let buf = '', done = false, secure = false;
    const steps = []; // fronta: { cmd, expect, then }
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error(`SMTP ${cfg.mail.host}: vypršel čas`)), 30000);
    const say = (cmd, expect, then, soft) => { steps.push({ expect, then, soft }); if (cmd != null) sock.write(cmd + (cmd.endsWith('\r\n') ? '' : '\r\n')); };
    const afterEhlo = (r) => {
      if (cfg.mail.tls === 'require' && !secure && !/STARTTLS/i.test(r)) return fail(new Error(`SMTP ${cfg.mail.host}: server nenabízí STARTTLS a šifrování je vyžadované (MTU_SMTP_TLS=require)`));
      if (useTls && !secure && /STARTTLS/i.test(r)) return say('STARTTLS', 220, () => {
        const plain = sock; plain.removeAllListeners('data');
        sock = tls.connect({ socket: plain, servername: cfg.mail.host, rejectUnauthorized: false }, () => { secure = true; say(`EHLO ${helo}`, 250, afterEhlo); });
        sock.on('close', () => fail(new Error(`SMTP ${cfg.mail.host}: spojení ukončeno`)));
        sock.on('data', onData); sock.on('error', (e) => { if (!secure) { e = new Error(`SMTP ${cfg.mail.host}: TLS se nepodařilo navázat (${e.message})`); e.tlsFailed = true; } fail(e); });
      }, 'tls');
      say(`MAIL FROM:<${fromAddr}>`, 250, () => {
        // odmítnutý příjemce nezahodí zprávu ostatním: pokračuje se, dokud server přijal aspoň jednoho
        let i = 0; const rejected = [];
        const next = () => {
          if (i < rcpt.length) { const a = rcpt[i++]; return say(`RCPT TO:<${a}>`, 250, next, (line) => { rejected.push(`${a}: ${line}`); next(); }); }
          if (rejected.length === rcpt.length) return fail(new Error(`SMTP ${cfg.mail.host}: ${rejected.join('; ')}`));
          say('DATA', 354, () => say(msg, 250, (ok) => { done = true; clearTimeout(timer); try { sock.end('QUIT\r\n'); const s0 = sock; setTimeout(() => { try { s0.destroy(); } catch {} }, 5000).unref(); } catch {} if (rejected.length && typeof onRejected === 'function') { try { onRejected(rejected); } catch {} } resolve(ok.trim() + (rejected.length ? ` (odmítnutí příjemci: ${rejected.join('; ')})` : '')); }));
        };
        next();
      });
    };
    function onData(d) {
      buf += d;
      for (;;) {
        const m = buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3}(?: [^\n]*)?\r?\n/); if (!m) return;
        const reply = m[0]; buf = buf.slice(reply.length);
        const lines = reply.trim().split('\n'); const code = parseInt(lines[lines.length - 1], 10);
        const st = steps.shift(); if (!st) continue;
        const ok = code === st.expect || (st.expect === 250 && code === 251);
        const last = reply.trim().split('\n').pop().trim();
        if (!ok && typeof st.soft === 'function') { st.soft(last); continue; }
        if (!ok) { const e = new Error(`SMTP ${cfg.mail.host}: ${last}`); if (st.soft === 'tls') e.tlsFailed = true; return fail(e); } // odmítnutý příkaz STARTTLS = šifrování nejde

        st.then(reply);
      }
    }
    sock.on('data', onData); sock.on('error', fail); sock.on('close', () => fail(new Error(`SMTP ${cfg.mail.host}: spojení ukončeno`)));
    steps.push({ expect: 220, then: () => say(`EHLO ${helo}`, 250, afterEhlo) });
  });
}
module.exports = { enabled, send, validAddr, MAX_RCPT };
