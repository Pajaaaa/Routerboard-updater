'use strict';
/**
 * Odesílání e-mailů přes SMTP relay bez přihlášení (20.11.2026, pro hlášení automatického upgradu). Bez závislostí: holé SMTP nad net,
 * STARTTLS, když ho server nabízí (certifikát se neověřuje — relay je ve vlastní síti a jde jen o šifrování po cestě).
 * Zapíná se nastavením MTU_SMTP_HOST; bez něj enabled() = false a nic se neposílá.
 */
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const cfg = require('./config');

const enabled = () => !!(cfg.mail && cfg.mail.host);
const addrOf = (s) => { const m = String(s || '').match(/<([^<>\s]+@[^<>\s]+)>/); return (m ? m[1] : String(s || '')).trim(); };
const validAddr = (s) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(String(s || ''));
const encWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : s.match(/[\s\S]{1,30}/gu).map(p => `=?UTF-8?B?${Buffer.from(p, 'utf8').toString('base64')}?=`).join('\r\n ');

/** jedna zpráva; to = adresa nebo pole adres. Vrací odpověď serveru na konec DATA, při chybě vyhodí výjimku. */
function send({ to, subject, text }) {
  if (!enabled()) return Promise.reject(new Error('odesílání e-mailů není nastavené (MTU_SMTP_HOST)'));
  const rcpt = (Array.isArray(to) ? to : String(to || '').split(/[\s,;]+/)).map(x => x.trim()).filter(Boolean);
  if (!rcpt.length || !rcpt.every(validAddr)) return Promise.reject(new Error('neplatná adresa příjemce: ' + rcpt.join(', ')));
  const from = cfg.mail.from, fromAddr = addrOf(from);
  const helo = (cfg.mail.helo || os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  const fromName = from.includes('<') ? from.slice(0, from.indexOf('<')).trim().replace(/^"|"$/g, '') : '';
  const msg = [
    `From: ${fromName ? encWord(fromName) + ' ' : ''}<${fromAddr}>`, `To: ${rcpt.join(', ')}`, `Subject: ${encWord(String(subject || '').replace(/[\r\n]+/g, ' '))}`,
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
    const say = (cmd, expect, then) => { steps.push({ expect, then }); if (cmd != null) sock.write(cmd + (cmd.endsWith('\r\n') ? '' : '\r\n')); };
    const afterEhlo = (r) => {
      if (!secure && /STARTTLS/i.test(r)) return say('STARTTLS', 220, () => {
        const plain = sock; plain.removeAllListeners('data');
        sock = tls.connect({ socket: plain, servername: cfg.mail.host, rejectUnauthorized: false }, () => { secure = true; say(`EHLO ${helo}`, 250, afterEhlo); });
        sock.on('data', onData); sock.on('error', fail);
      });
      say(`MAIL FROM:<${fromAddr}>`, 250, () => {
        let i = 0; const next = () => { if (i < rcpt.length) return say(`RCPT TO:<${rcpt[i++]}>`, 250, next); say('DATA', 354, () => say(msg, 250, (ok) => { done = true; clearTimeout(timer); try { sock.end('QUIT\r\n'); } catch {} resolve(ok.trim()); })); };
        next();
      });
    };
    function onData(d) {
      buf += d;
      for (;;) {
        const m = buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/); if (!m) return;
        const reply = m[0]; buf = buf.slice(reply.length);
        const lines = reply.trim().split('\n'); const code = parseInt(lines[lines.length - 1], 10);
        const st = steps.shift(); if (!st) continue;
        if (code !== st.expect) return fail(new Error(`SMTP ${cfg.mail.host}: ${reply.trim().split('\n').pop().trim()}`));
        st.then(reply);
      }
    }
    sock.on('data', onData); sock.on('error', fail); sock.on('close', () => fail(new Error(`SMTP ${cfg.mail.host}: spojení ukončeno`)));
    steps.push({ expect: 220, then: () => say(`EHLO ${helo}`, 250, afterEhlo) });
  });
}
module.exports = { enabled, send, validAddr };
