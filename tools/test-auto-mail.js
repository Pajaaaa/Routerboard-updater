#!/usr/bin/env node
'use strict';
// Odesílání e-mailů (lib/mail.js) a hlášení automatu (lib/autoupgrade.js) proti falešným SMTP serverům na 127.0.0.1 (20.11.2026):
// vkládání hlaviček/příkazů, validAddr, protokol (víceřádkové odpovědi, chyby ve všech fázích, ticho, zavření), STARTTLS (self-signed,
// nepovedený handshake, MTU_SMTP_TLS=auto/no/require), hlavičky zprávy, kdy se posílá oznámení a souhrn, co se stane při selhání.
// Kontroly označené „// BUG:“ odhalují skutečnou chybu a selhávají, dokud se neopraví. Nikam ven se nepřipojuje.
const net = require('net'), tls = require('tls'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-automail-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x'; process.env.USERDB_URL = '';
process.env.MTU_SMTP_HOST = '127.0.0.1'; process.env.MTU_SMTP_PORT = '1'; process.env.MTU_MAIL_FROM = 'Upgrader test <upg@example.org>';
process.env.MTU_PUBLIC_URL = 'https://upgrader.example/mikrotik'; delete process.env.MTU_SMTP_TLS; delete process.env.MTU_SMTP_HELO;
// časový limit SMTP (30 s) se v testu zkracuje na 400 ms; že je to 30 s, se ověřuje níž
const realST = global.setTimeout; const longTimers = [];
global.setTimeout = (fn, ms, ...a) => { if (ms >= 10000) longTimers.push(ms); return realST(fn, ms >= 10000 ? 400 : ms, ...a); };
const NOW = new Date(2026, 10, 24, 1, 30, 0); const nowSec = NOW.getTime() / 1000, day = 86400; // úterý 24.11.2026 01:30
fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({ 'v7-long-term': [{ version: '7.24.6', releasedAt: nowSec - 6 * day }], 'v7-stable': [{ version: '7.25.1', releasedAt: nowSec - 2 * day }], 'v6-long-term': [{ version: '6.49.24', releasedAt: nowSec - 40 * day }] }));
const cfg = require('../lib/config');
const mail = require('../lib/mail');
const db = require('../lib/db');
const V = require('../lib/versions');
const auto = require('../lib/autoupgrade');
{ const t0 = auto.tick; auto.tick = async (...a) => { await t0(...a); await auto.settle(); }; } // hlášení se v ticku neawaitují — test na ně počká

let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const sleep = (ms) => new Promise(r => realST(r, ms));
const logged = []; const origErr = console.error; // hlášky automatu o nepovedeném e-mailu nepatří do výstupu testu
const quiet = async (fn) => { console.error = (...a) => logged.push(a.join(' ')); try { return await fn(); } finally { console.error = origErr; } };
let unhandled = 0; process.on('unhandledRejection', (e) => { unhandled++; origErr('neošetřená rejection:', e); }); process.on('uncaughtException', (e) => { unhandled++; origErr('neošetřená výjimka:', e); });

// certifikát pro STARTTLS (self-signed, jen pro test); bez openssl se část TLS přeskočí
let tlsKey = null, tlsCert = null;
try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=fake-smtp.test'], { stdio: 'ignore' }); tlsKey = fs.readFileSync(path.join(dir, 'k.pem')); tlsCert = fs.readFileSync(path.join(dir, 'c.pem')); } catch {}

/** falešný SMTP server. Volby: banner/EHLO/MAIL/RCPT/DATA/DOT = vlastní odpověď | 'silent' | 'close'; rcpt(line, n) → odpověď;
 *  starttls: 'ok' | 'destroy' (spojení spadne při handshaku) | 'garbage' | '454'; split = odpovědi po N bajtech */
function fake(o = {}) {
  const S = { sessions: [], conns: 0, open: new Set() };
  S.srv = net.createServer((raw) => {
    S.conns++; S.open.add(raw); raw.on('close', () => S.open.delete(raw)); raw.on('error', () => {});
    const ses = { cmds: [], mails: [], secure: false }; S.sessions.push(ses);
    let s = raw, inData = false, buf = Buffer.alloc(0), rcptN = 0;
    const w = (txt) => { if (!o.split) return void s.write(txt); let i = 0; const go = () => { if (i < txt.length && !s.destroyed) { s.write(txt.slice(i, i + o.split)); i += o.split; realST(go, 1); } }; go(); };
    const rep = (phase, def) => { const r = o[phase]; if (r === 'silent') return; if (r === 'close') return void s.destroy(); w(r || def); };
    const onData = (d) => { buf = Buffer.concat([buf, d]);
      for (;;) {
        if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; ses.mails.push({ data: buf.slice(0, e), secure: ses.secure, rcpt: ses.cmds.filter(c => /^RCPT/.test(c)) }); buf = buf.slice(e + 5); inData = false; rep('DOT', '250 2.0.0 Ok: queued as TEST\r\n'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i).toString('latin1'); buf = buf.slice(i + 2); ses.cmds.push(line);
        if (/^EHLO/i.test(line)) rep('EHLO', `250-test\r\n250-SIZE 1000\r\n${o.starttls && !ses.secure ? '250-STARTTLS\r\n' : ''}250 8BITMIME\r\n`);
        else if (/^STARTTLS/i.test(line)) {
          if (o.starttls === '454') { w('454 4.7.0 TLS not available\r\n'); continue; }
          raw.write('220 go\r\n'); raw.removeAllListeners('data'); buf = Buffer.alloc(0);
          if (o.starttls === 'destroy') { raw.once('data', () => raw.destroy()); return; }
          if (o.starttls === 'garbage') { raw.once('data', () => raw.write('500 co to je\r\n')); return; }
          s = new tls.TLSSocket(raw, { isServer: true, key: tlsKey, cert: tlsCert, ...(o.tlsOpts || {}) }); s.on('error', () => {}); s.on('secure', () => { ses.secure = true; }); s.on('data', onData); return;
        }
        else if (/^MAIL/i.test(line)) rep('MAIL', '250 Ok\r\n');
        else if (/^RCPT/i.test(line)) { rcptN++; const r = o.rcpt && o.rcpt(line, rcptN); if (r) w(r); else rep('RCPT', '250 Ok\r\n'); }
        else if (/^DATA/i.test(line)) { if (!o.DATA) inData = true; rep('DATA', '354 go\r\n'); }
        else if (/^QUIT/i.test(line)) s.end('221 bye\r\n');
        else w('500 unknown\r\n');
      } };
    raw.on('data', onData);
    if (o.banner === 'close') raw.destroy(); else if (o.banner !== 'silent') w(o.banner || '220 test ESMTP\r\n');
  });
  S.start = () => new Promise(r => S.srv.listen(0, '127.0.0.1', () => { cfg.mail.port = S.srv.address().port; r(S); }));
  S.stop = () => new Promise(r => { for (const c of S.open) c.destroy(); S.srv.close(() => r()); });
  S.mails = () => S.sessions.flatMap(x => x.mails);
  S.cmds = () => S.sessions.flatMap(x => x.cmds);
  return S;
}
const M = { to: 'kdo@example.com', subject: 'x', text: 'y' };
async function attempt(m = M) { const t0 = Date.now(); try { return { ok: await mail.send(m), ms: Date.now() - t0 }; } catch (e) { return { err: e.message, ms: Date.now() - t0 }; } }
/** jedna zpráva proti čerstvému serveru s volbami o → { r, S } (server už zastavený) */
async function one(o, m = M) { const S = await fake(o).start(); const r = await attempt(m); await sleep(30); const left = S.open.size; await S.stop(); return { r, S, left }; }
function parse(data) {
  const s = data.toString('utf8'); const i = s.indexOf('\r\n\r\n'); const head = s.slice(0, i), body = s.slice(i + 4); const H = {};
  for (const l of head.replace(/\r\n[ \t]/g, ' ').split('\r\n')) { const k = l.indexOf(':'); H[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); }
  return { head, body, H, lines: s.split('\r\n'), headLines: head.split('\r\n'), text: Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') };
}
// dekódování po jednotlivých encoded-words (rozseknutý UTF-8 znak by se projevil jako U+FFFD)
const dec2047 = (v) => v.replace(/(=\?[^?]+\?B\?[^?]*\?=)\s+(?==\?)/g, '$1').replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
const maxLine = (p) => Math.max(...p.lines.map(l => Buffer.byteLength(l)));

async function testMailLib() {
  console.log('validAddr');
  chk(['a@b.c', 'jan.novak@hkfree.org', 'a+b@c.cz', 'A@B.CZ'].every(mail.validAddr), 'běžné adresy projdou');
  chk(!['a@b', '"a b"@c.cz', 'a b@c.cz', '<a@b.cz>', 'a@b.cz>', 'a,b@c.cz', 'a@@b.cz', '@b.cz', 'a@.cz', 'a@b.', 'Jan <a@b.cz>', '', null, undefined].some(mail.validAddr), 'bez domény s tečkou, s mezerou, závorkami, čárkou, jménem → neprojdou');
  chk(!['a@b.cz\r\nRCPT TO:<evil@x.cz>', 'a@b.cz\n', 'a@b.cz\r', 'a\t@b.cz', 'a @b.cz'].some(mail.validAddr), 'adresa s CR/LF/tabulátorem neprojde (příkaz RCPT nejde podvrhnout)');
  chk(!mail.validAddr('a\u0000@b.cz') && !mail.validAddr('a@b.cz\u0000') && !mail.validAddr('a\u001b[31m@b.cz') && !mail.validAddr('a\u007f@b.cz'), 'adresa s NUL / řídicím znakem neprojde'); // BUG: /[^\s@<>,;"]/ řídicí znaky pouští → NUL jde do RCPT TO i do hlavičky To
  chk(!mail.validAddr('a@příklad.cz') && !mail.validAddr('žluťoučký@kůň.cz'), 'ne-ASCII adresa (IDN bez punycode) neprojde — klient neumí SMTPUTF8'); // BUG: projde a do RCPT TO jdou holé UTF-8 bajty
  chk(!mail.validAddr('a@b..cz') && !mail.validAddr('a@-b.cz') && !mail.validAddr('x'.repeat(290) + '@example.cz'), 'a@b..cz, a@-b.cz a 300znaková adresa neprojdou'); // BUG: projdou (RFC 5321: adresa ≤ 254, místní část ≤ 64 znaků)

  console.log('vkládání hlaviček a příkazů');
  const S = await fake().start();
  const evilText = 'radek\n.\n..\n.tecka\r\n.\r\nRCPT TO:<evil@x.cz>\r\nQUIT\r\n\u0000NUL\n' + 'x'.repeat(3000) + '\nkonec';
  let r = await attempt({ to: 'kdo@example.com', subject: 'Job „ž“\r\nBcc: evil@x.cz\r\n\r\ntelo\r\n.\r\nMAIL FROM:<x@y.cz>', text: evilText });
  let ses = S.sessions[S.sessions.length - 1]; let p = parse(ses.mails[0].data);
  chk(r.ok && ses.mails.length === 1 && ses.cmds.filter(c => c !== 'QUIT').join('|') === `${ses.cmds[0]}|MAIL FROM:<upg@example.org>|RCPT TO:<kdo@example.com>|DATA`, 'CRLF, samotná tečka a „RCPT TO“ v předmětu i těle: jedna zpráva, obálka beze změny (' + ses.cmds.slice(1).join(' | ') + ')');
  chk(!p.headLines.some(l => /^Bcc:/i.test(l)) && dec2047(p.H.subject) === 'Job „ž“ Bcc: evil@x.cz telo . MAIL FROM:<x@y.cz>', 'předmět s CRLF zůstane jednou hlavičkou, žádné Bcc');
  chk(p.text === evilText.replace(/\r?\n/g, '\r\n'), 'tělo se samotnou tečkou, řádky od tečky, NUL a 3000znakovým řádkem dorazí beze změny');
  chk(maxLine(p) <= 76 && p.body.split('\r\n').every(l => /^[A-Za-z0-9+/=]*$/.test(l)), 'tělo je base64 s řádky ≤ 76 znaků');
  await attempt({ to: 'kdo@example.com', subject: 'ascii\nBcc: evil@x.cz', text: 'x' }); p = parse(S.mails().pop().data);
  chk(p.H.subject === 'ascii Bcc: evil@x.cz' && !p.headLines.some(l => /^Bcc:/i.test(l)), 'čistě ASCII předmět s LF: bez podvržené hlavičky');
  await attempt({ to: 'kdo@example.com', subject: 'a\u0000b\tc', text: 'x' }); p = parse(S.mails().pop().data);
  chk(/^=\?UTF-8\?B\?/.test(p.H.subject) && !/[\x00-\x08]/.test(p.head), 'NUL a tabulátor v předmětu se zakódují, do hlaviček nejdou');
  const before = S.conns;
  r = await attempt({ to: 'a@b.cz\r\nRCPT TO:<evil@x.cz>', subject: 'x', text: 'y' }); const r2 = await attempt({ to: ['a@b.cz\r\nDATA'], subject: 'x', text: 'y' });
  chk(/neplatná adresa/.test(r.err || '') && /neplatná adresa/.test(r2.err || '') && S.conns === before, 'příjemce s CRLF se odmítne dřív, než se naváže spojení');
  r = await attempt({ to: 'a@b.cz, c@d.cz;e@f.cz  g@h.cz', subject: 'x', text: 'y' });
  chk(r.ok && S.mails().pop().rcpt.join() === 'RCPT TO:<a@b.cz>,RCPT TO:<c@d.cz>,RCPT TO:<e@f.cz>,RCPT TO:<g@h.cz>', 'víc příjemců oddělených čárkou / středníkem / mezerou');
  cfg.mail.helo = 'muj host\r\nMAIL FROM:<x@y.cz>'; await attempt(); cfg.mail.helo = '';
  chk(/^EHLO [A-Za-z0-9.-]+$/.test(S.sessions[S.sessions.length - 1].cmds[0]), 'MTU_SMTP_HELO s CRLF se očistí');

  console.log('hlavičky zprávy');
  r = await attempt({ to: ['kdo@example.com', 'druhy@example.com'], subject: 'Příliš žluťoučký kůň', text: 'Řádek jedna\nŘádek dvě – „česky“ → šipka\n' }); p = parse(S.mails().pop().data);
  chk(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} \+0000$/.test(p.H.date) && Math.abs(Date.parse(p.H.date) - Date.now()) < 5000, 'Date podle RFC 5322 (' + p.H.date + ')');
  chk(/^<[0-9a-f]{24}@example\.org>$/.test(p.H['message-id']) && p.H.from === 'Upgrader test <upg@example.org>' && p.H.to === 'kdo@example.com, druhy@example.com', 'Message-ID, From, To');
  chk(p.H['mime-version'] === '1.0' && /^text\/plain; charset=utf-8$/i.test(p.H['content-type']) && p.H['content-transfer-encoding'] === 'base64' && p.H['auto-submitted'] === 'auto-generated', 'MIME-Version, Content-Type utf-8, base64, Auto-Submitted');
  chk(dec2047(p.H.subject) === 'Příliš žluťoučký kůň' && p.text === 'Řádek jedna\r\nŘádek dvě – „česky“ → šipka\r\n', 'čeština v předmětu i těle se dekóduje zpět beze ztráty');
  const subjects = { cz: 'žluťoučký kůň úpěl ďábelské ódy '.repeat(7), dense: 'x'.repeat(29) + 'ž'.repeat(200), emoji: '😀'.repeat(70), cjk: '漢字'.repeat(60) }; const words = {}; let roundtrip = true;
  for (const [k, s] of Object.entries(subjects)) { await attempt({ to: 'kdo@example.com', subject: s, text: 'x' }); p = parse(S.mails().pop().data); if (dec2047(p.H.subject) !== s) roundtrip = false; words[k] = Math.max(...p.H.subject.split(/\s+/).map(x => x.length)); }
  chk(roundtrip, 'dlouhý ne-ASCII předmět (čeština, emoji, CJK) se dělí na hranici znaku — po slovech se dekóduje zpět');
  chk(Object.values(words).every(n => n <= 75), 'RFC 2047: encoded-word má nejvýš 75 znaků (nejdelší: ' + JSON.stringify(words) + ')'); // BUG: dělí se po 30 znacích, ne po bajtech → až 92 (čeština) / 172 (emoji) znaků
  await attempt({ to: 'kdo@example.com', subject: 'A '.repeat(1000), text: 'x' }); p = parse(S.mails().pop().data);
  chk(maxLine(p) <= 998, 'dlouhý ASCII předmět se zalomí (řádek ≤ 998 znaků; je ' + maxLine(p) + ')'); // BUG: ASCII předmět se nezalamuje vůbec (automat ho zatím negeneruje — předměty mají vždy diakritiku)
  await attempt({ to: Array.from({ length: 80 }, (_, i) => `prijemce${i}@example-domena.cz`), subject: 'x', text: 'x' }); p = parse(S.mails().pop().data);
  chk(maxLine(p) <= 998, 'hlavička To s 80 příjemci se zalomí (řádek ≤ 998 znaků; je ' + maxLine(p) + ')'); // BUG: To je jeden řádek; auto_mail_to počet adres neomezuje
  cfg.mail.from = 'Žluťoučký Upgrader s velmi dlouhým jménem odesílatele <upg@example.org>'; await attempt(); p = parse(S.mails().pop().data);
  chk(dec2047(p.H.from) === 'Žluťoučký Upgrader s velmi dlouhým jménem odesílatele <upg@example.org>' && S.cmds().includes('MAIL FROM:<upg@example.org>'), 'jméno odesílatele s diakritikou (i dlouhé) se zakóduje, obálka má holou adresu');
  cfg.mail.from = '"Novak, Petr (upgrader)" <upg@example.org>'; await attempt(); p = parse(S.mails().pop().data);
  chk(/^"Novak, Petr \(upgrader\)" <upg@example\.org>$/.test(p.H.from), 'jméno odesílatele s čárkou / závorkou zůstane v uvozovkách (' + p.H.from + ')'); // BUG: uvozovky se odříznou → „From: Novak, Petr (upgrader) <…>“ = dvě adresy + komentář
  cfg.mail.from = 'upg@example.org'; await attempt(); p = parse(S.mails().pop().data);
  chk(p.H.from === '<upg@example.org>', 'MTU_MAIL_FROM jen s adresou');
  cfg.mail.from = 'Upgrader test <upg@example.org>';
  await S.stop();

  console.log('protokol');
  let x = await one({ split: 1, banner: '220-a\r\n220-b\r\n220 c\r\n' });
  chk(x.r.ok && x.S.mails().length === 1, 'víceřádkové odpovědi doručované po 1 bajtu');
  x = await one({ MAIL: '250 ok\n', DOT: '250-prvni\r\n250 2.0.0 queued X\r\n' });
  chk(x.r.ok && /queued X/.test(x.r.ok), 'odpověď s holým LF a víceřádková odpověď po tečce');
  x = await one({ MAIL: '250\r\n' });
  chk(!!x.r.ok, 'odpověď bez textu („250<CRLF>“) se bere jako odpověď'); // BUG: regulární výraz čeká mezeru za kódem → 30 s čekání a „vypršel čas“
  const codes = ['421', '450', '451', '452', '550', '554'], phases = ['banner', 'EHLO', 'MAIL', 'RCPT', 'DATA', 'DOT']; const wrong = [];
  for (const ph of phases) for (const c of codes) { x = await one({ [ph]: `${c}-vic radku\r\n${c} 4.0.0 chyba ${ph}\r\n` }); if (!(x.r.err || '').includes(`${c} 4.0.0 chyba ${ph}`) || x.left || (ph !== 'DOT' && x.S.mails().length)) wrong.push(ph + ':' + c); }
  chk(!wrong.length, 'chyba 421/450/451/452/550/554 v každé fázi (banner, EHLO, MAIL, RCPT, DATA, po tečce) = výjimka s hláškou serveru, spojení zavřené ' + wrong.join(' '));
  const slow = [];
  for (const ph of phases) { x = await one({ [ph]: 'silent' }); if (!/vypršel čas/.test(x.r.err || '') || x.left || x.r.ms > 2000) slow.push(ph + ' ticho'); x = await one({ [ph]: 'close' }); if (!/spojení ukončeno/.test(x.r.err || '') || x.r.ms > 300) slow.push(ph + ' zavření'); }
  chk(!slow.length && longTimers.length > 0 && longTimers.every(t => t === 30000), 'server, který přestane odpovídat (každá fáze), skončí časovým limitem 30 s a socket nezůstane viset; zavřené spojení = chyba hned ' + slow.join(', '));
  x = await one({ EHLO: '502 5.5.1 EHLO not implemented\r\n' });
  chk(/502/.test(x.r.err || '') && !x.S.cmds().some(c => /^HELO/.test(c)), 'server bez EHLO: chyba, HELO se nezkouší (známé omezení)');
  x = await one({ rcpt: (l, n) => n === 2 ? '550 5.1.1 User unknown\r\n' : null }, { ...M, to: ['a@x.cz', 'spatna@x.cz', 'c@x.cz'] });
  chk(/User unknown/.test(x.r.err || '') || /spatna@x\.cz/.test(String(x.r.ok || '')), 'odmítnutý jeden ze tří příjemců se volajícímu ohlásí');
  chk(x.S.mails().length === 1 && x.S.mails()[0].rcpt.length === 3, 'odmítnutý jeden ze tří příjemců: ostatním dvěma zpráva odejde'); // BUG: první odmítnuté RCPT celou zprávu zahodí — překlep v jedné adrese = hlášení nedostane nikdo
  cfg.mail.port = 1; let e1 = await attempt(); const host = cfg.mail.host; cfg.mail.host = 'neexistuje.invalid'; let e2 = await attempt(); cfg.mail.host = '';
  let e3 = await attempt(); chk(/ECONNREFUSED/.test(e1.err || '') && /ENOTFOUND|EAI_AGAIN/.test(e2.err || '') && /není nastavené/.test(e3.err || '') && !mail.enabled(), 'odmítnuté spojení, neexistující host a prázdný MTU_SMTP_HOST = výjimka, žádné čekání'); cfg.mail.host = host;
  const SS = await fake().start(); const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt({ to: `u${i}@example.com`, subject: 's' + i, text: 't' + i })));
  chk(rs.every(q => q.ok) && SS.mails().length === 20 && SS.mails().every(m => { const q = parse(m.data); const n = q.H.to.match(/\d+/)[0]; return m.rcpt.join() === `RCPT TO:<u${n}@example.com>` && q.H.subject === 's' + n && q.text === 't' + n; }) && new Set(SS.mails().map(m => parse(m.data).H['message-id'])).size === 20, '20 zpráv naráz: každá vlastním spojením, nepomíchané, různá Message-ID');
  await SS.stop();

  console.log('TLS');
  const secure = (S2) => S2.mails().map(m => m.secure).join();
  if (!tlsKey) console.log('  (openssl není k dispozici — kontroly se skutečným TLS handshakem přeskočeny)');
  for (const mode of ['auto', 'require', 'no']) {
    cfg.mail.tls = mode;
    if (tlsKey) {
      x = await one({ starttls: 'ok' });
      chk(x.r.ok && secure(x.S) === (mode === 'no' ? 'false' : 'true') && x.S.cmds().includes('STARTTLS') === (mode !== 'no'), `${mode}: server se STARTTLS a self-signed certifikátem → zpráva odejde ${mode === 'no' ? 'nešifrovaně, STARTTLS se nezkouší' : 'šifrovaně'}`);
      x = await one({ starttls: 'ok', tlsOpts: { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' } });
      if (mode === 'auto') chk(x.r.ok && x.S.conns === 2 && x.S.mails().length === 1 && secure(x.S) === 'false', 'auto: server jen s TLS 1.0/1.1 → druhé spojení bez šifrování, zpráva právě jednou');
      if (mode === 'require') chk(/TLS se nepodařilo/.test(x.r.err || '') && x.S.mails().length === 0 && x.S.conns === 1, 'require: server jen s TLS 1.0/1.1 → chyba, nic neodejde');
    }
    for (const how of ['destroy', 'garbage']) {
      x = await one({ starttls: how });
      if (mode === 'auto') chk(x.r.ok && x.S.conns === 2 && x.S.mails().length === 1, `auto: nepovedený handshake (${how}) → zpráva odejde právě jednou nešifrovaně`);
      if (mode === 'require') chk(/TLS se nepodařilo/.test(x.r.err || '') && x.S.mails().length === 0, `require: nepovedený handshake (${how}) → chyba, nic neodejde`);
      if (mode === 'no') chk(x.r.ok && !x.S.cmds().includes('STARTTLS'), `no: STARTTLS se nezkouší (${how})`);
    }
    x = await one({});
    if (mode === 'require') chk(!x.r.ok && x.S.mails().length === 0, 'require: server STARTTLS vůbec nenabízí → chyba, nic neodejde nešifrovaně'); // BUG: (bezpečnost) zpráva odejde v otevřeném textu — „require“ se uplatní jen při selhání handshaku, ne když STARTTLS v EHLO chybí (stačí ho po cestě vystřihnout)
    else chk(x.r.ok && secure(x.S) === 'false', `${mode}: server bez STARTTLS → nešifrovaně`);
    x = await one({ starttls: '454' });
    if (mode === 'auto') chk(x.r.ok && x.S.mails().length === 1, 'auto: server STARTTLS nabídne, ale odmítne (454) → zpráva odejde nešifrovaně'); // BUG: odmítnutý příkaz STARTTLS není „tlsFailed“ → žádný návrat na nešifrované spojení, zpráva neodejde
    if (mode === 'require') chk(!x.r.ok && x.S.mails().length === 0, 'require: odmítnuté STARTTLS (454) → chyba, nic neodejde');
  }
  cfg.mail.tls = 'auto';
  if (tlsKey) {
    x = await one({ starttls: 'ok', DOT: 'close' });
    chk(!x.r.ok && x.S.conns === 1 && x.S.mails().length === 1, 'spojení spadne až po odeslání zprávy přes TLS → chyba, ale žádný druhý (nešifrovaný) pokus = žádná duplicita');
    const t = tls.createServer({ key: tlsKey, cert: tlsCert }, (s) => { s.on('error', () => {}); s.write('220 smtps\r\n'); }); t.on('tlsClientError', () => {});
    await new Promise(r => t.listen(0, '127.0.0.1', r)); cfg.mail.port = t.address().port; const r465 = await attempt(); t.close();
    chk(/vypršel čas/.test(r465.err || ''), 'port s implicitním TLS (465) podporovaný není: skončí časovým limitem (známé omezení)');
  }
}

async function testAutomat() {
  let n = 0;
  const mkUser = (name, nick, email) => { const id = db.insertUser({ name, pass_hash: '', role: 'user' }); db.updateUser(id, { userdb_nick: nick, ...(email !== undefined ? { email } : {}) }); return db.listUsers().find(u => u.id === id); };
  const mkDev = (owner, f = {}) => { const id = db.insertDevice({ host: `10.9.${Math.floor(n / 250)}.${(n++ % 250) + 1}`, port: 22, owner_id: owner, username: 'a', password: 'b' }); db.updateDevice(id, { version: '7.24.4', scan_status: 'ok', userdb_member: 1, model: 'SXTsq', board_name: 'SXTsq', track: 'v7-long-term', ...f }); return db.getDevice(id); };
  const D = (h, m, d = 23) => new Date(2026, 10, d, h, m);
  const US = (u) => auto._state().users[String(u.id)];
  /** účet s jednou skupinou o jednom zařízení a zapnutým automatem */
  const mk = (nick, set = {}, f = {}) => { const u = mkUser(nick + '@x.cz', nick); const d = mkDev(u.id, f); auto.saveGroup(u.id, { name: 'G-' + nick, deviceIds: [d.id] }); db.setUserSettings(u.id, { auto_enable: true, ...set }); return u; };
  db.setSettings({ auto_users: '*' });
  const started = []; auto.configure({ pool: { draining: false, isDeviceBusy: () => false, startOrQueue: (id) => started.push(id) }, notify: () => {} }); V.refreshLatest = async () => {};
  let S = await fake().start();
  const mailsFor = (u, addr) => S.mails().map(m => ({ ...parse(m.data), rcpt: m.rcpt })).filter(p => p.H.to.split(', ').includes(addr || u.name));

  console.log('automat: příjemce');
  const uMail = mkUser('lokalni', 'lok', 'lok@example.cz'), uNone = mkUser('bezmailu', 'bez'), uOwn = mkUser('sso@x.cz', 'own', 'ucet@example.cz');
  db.setUserSettings(uOwn.id, { auto_mail_to: 'a@b.cz, c@d.cz' });
  chk(auto.statusFor(uMail).mail.to === 'lok@example.cz' && auto.statusFor(uNone).mail.to === '' && auto.statusFor(uOwn).mail.to === 'a@b.cz, c@d.cz', 'příjemce: e-mail účtu / nic (účet bez e-mailu) / vlastní adresy mají přednost');
  let tm = await auto.testMail(uOwn); let none = ''; try { await auto.testMail(uNone); } catch (e) { none = e.message; }
  chk(tm.join() === 'a@b.cz,c@d.cz' && S.mails().pop().rcpt.length === 2 && /nemá e-mail/.test(none), 'zkušební e-mail: na vlastní adresy; účet bez e-mailu = srozumitelná chyba');
  chk(!!auto.validate({ auto_mail_to: 'a@b' }).error && !!auto.validate({ auto_mail_to: 'Jan <a@b.cz>' }).error && !!auto.validate({ auto_mail_to: 'a@b.cz\r\nRCPT TO:<x@y.cz>, neni' }).error && auto.validate({ auto_mail_to: 'a@b.cz;;c@d.cz' }).values.auto_mail_to === 'a@b.cz, c@d.cz' && auto.validate({ auto_mail_to: '' }).values.auto_mail_to === '', 'validate auto_mail_to: neplatné odmítne, oddělovače sjednotí, prázdné povolí');
  chk(!!auto.validate({ auto_mail_to: 'a\u0000@b.cz' }).error, 'validate auto_mail_to: adresa s NUL bajtem se odmítne'); // BUG: projde (viz validAddr)
  chk(!!auto.validate({ auto_mail_to: Array.from({ length: 200 }, (_, i) => `u${i}@example.cz`).join(',') }).error, 'validate auto_mail_to: 200 adres se odmítne (rozumný strop)'); // BUG: počet adres není omezený → To přes 998 znaků, upgrader jako rozesílač

  console.log('automat: oznámení před nocí');
  const evilGroup = 'Kanárci\r\nBcc: evil@x.cz\r\n\r\n.\r\nMAIL FROM:<a@b.cz>';
  const A = mkUser('a@x.cz', 'a'); const dA = mkDev(A.id, { name: 'AP střecha\r\n.\r\nRCPT TO:<evil@x.cz>\r\nStav a nastavení: http://evil.example/' }), dA2 = mkDev(A.id, { name: '', identity: 'jen identita\n.\nDATA' });
  auto.saveGroup(A.id, { name: evilGroup, deviceIds: [dA.id, dA2.id] }); db.setUserSettings(A.id, { auto_enable: true });
  const B = mk('nomail', { auto_mail: false }), C = mk('hotovo', {}, { version: '7.24.6' }), Dd = mk('sobota', { auto_days: '6' }), E = mk('skip'), F = mk('vypnuty', { auto_enable: false }), G = mk('halted');
  US(E).skipNight = '2026-11-24'; US(G).halted = 'x';
  await auto.tick(D(16, 59));
  chk(mailsFor(A).length === 0, '8 h 01 min před oknem se ještě neoznamuje');
  await auto.tick(D(17, 10));
  let a = mailsFor(A);
  chk(a.length === 1 && dec2047(a[0].H.subject) === '[upgrader] dnes v noci půjde 2 zařízení na 7.24.6' && /v noci 24\. 11\. v okně 01:00–04:30/.test(a[0].text), '8 h před oknem přijde oznámení (' + (a[0] && dec2047(a[0].H.subject)) + ')');
  chk(a.length === 1 && a[0].rcpt.join() === 'RCPT TO:<a@x.cz>' && !a[0].headLines.some(l => /^Bcc:/i.test(l)) && S.sessions.every(s => s.cmds.filter(c => /^MAIL FROM/.test(c)).every(c => c === 'MAIL FROM:<upg@example.org>')) && maxLine(a[0]) <= 76, 'název skupiny a zařízení s CRLF / tečkou / „RCPT TO“: obálka ani hlavičky se nezmění');
  chk(a.length === 1 && /https:\/\/upgrader\.example\/mikrotik\/ \(vlevo Automat\)/.test(a[0].text), 'patička odkazuje na MTU_PUBLIC_URL (bez něj by to bylo http://127.0.0.1:2820/mikrotik)');
  chk(a.length === 1 && !/^Stav a nastavení: http:\/\/evil\.example/m.test(a[0].text) && !/^RCPT TO:/m.test(a[0].text), 'víceřádkový název / identita zařízení nepodvrhne v těle vlastní řádky'); // BUG: jméno (identita z routeru) se vkládá i s konci řádků → kdo ovládá router, vloží do hlášení libovolné řádky včetně falešného odkazu
  chk([B, C, Dd, E, F, G].every(u => mailsFor(u).length === 0), 'oznámení nepřijde: auto_mail vypnuté, nic k upgradu, nepovolený den, vynechaná noc, vypnutý automat, zastavený automat');
  await auto.tick(D(17, 30)); await auto.tick(D(23, 0));
  chk(mailsFor(A).length === 1, 'oznámení jen jednou na noc');
  const I = mk('nosmtp'); const host = cfg.mail.host; cfg.mail.host = ''; await auto.tick(D(23, 20));
  chk(mailsFor(I).length === 0 && !US(I).announced && auto.statusFor(I).mail.enabled === false, 'bez SMTP se neposílá nic a noc se neoznačí jako oznámená'); cfg.mail.host = host;
  await auto.tick(NOW); const c0 = S.mails().length; await auto.tick(D(2, 0, 24)); await auto.tick(D(12, 0, 24));
  chk(started.length >= 2 && US(A).lastNight === '2026-11-24' && S.mails().length === c0, 'během noci ani po ní se tatáž noc znovu neoznamuje');

  console.log('automat: souhrn po noci');
  /** uzavře otevřený job účtu se stavy položek podle pole, spustí vyhodnocení a vrátí poslední e-mail */
  async function closeJob(u, states, when, jobStatus = 'done') {
    const l = US(u).open[0]; db.getJobItems(l.jobId).forEach((it, i) => db.updateJobItem(it.id, { from_version: '7.24.4', to_version: '7.24.6', finished_at: db.now(), ...states[i] }));
    db.updateJob(l.jobId, { status: jobStatus, finished_at: db.now() }); await quiet(async () => { await auto.tick(when); await sleep(80); }); auto.unquarantine('7.24.6'); return mailsFor(u).pop();
  }
  async function scen(nick, states, dayN) {
    const u = mkUser(nick + '@x.cz', nick); const devs = states.map((s, i) => mkDev(u.id, { name: `${nick}-${i}` })); auto.saveGroup(u.id, { name: 'Skupina ' + nick, deviceIds: devs.map(d => d.id) }); db.setUserSettings(u.id, { auto_enable: true });
    await auto.tick(D(1, 30, dayN)); const jobId = US(u).open[0].jobId; const p = await closeJob(u, states, D(5, 0, dayN)); return { u, p, jobId, subj: p ? dec2047(p.H.subject) : '', text: p ? p.text : '' };
  }
  const ok = { status: 'done' }, fail = { status: 'failed', error: 'nevrátilo se po restartu' }, unr = { status: 'failed', error: 'nedostupné (SSH timeout)', result: { untouched: true } }, skip = { status: 'skipped', step: 'přeskočí se: konec okna' }, part = { status: 'done', result: { partial: true, hops: 1 } };
  let s1 = await scen('vse-ok', [ok, ok, ok], 25);
  chk(s1.subj === '[upgrader] „Skupina vse-ok“ 25. 11.: 3 zařízení upgradováno' && /3 v pořádku, 0 chyb, 0 nedostupných, 0 přeskočeno/.test(s1.text) && (s1.text.match(/7\.24\.4 → 7\.24\.6/g) || []).length === 3 && !/Neprovedeno|Chyby|ZASTAVIL/.test(s1.text) && s1.text.includes(`https://upgrader.example/mikrotik/ (Upgrady → #${s1.jobId})`), 'vše v pořádku: předmět, počty, seznam, odkaz na job');
  s1 = await scen('mix', [ok, fail, skip, unr], 25);
  chk(s1.subj === '[upgrader] AUTOMAT ZASTAVEN: 1 chyba v noci 25. 11.' && /1 v pořádku, 1 chyba, 1 nedostupných, 1 přeskočeno/.test(s1.text) && /AUTOMAT SE ZASTAVIL/.test(s1.text) && /Chyby:\r\n {2}mix-1 \(10\.9\.\d+\.\d+\): nevrátilo se po restartu/.test(s1.text) && /Neprovedeno:\r\n {2}mix-2 {2}\(10\.9\.\d+\.\d+\): konec okna\r\n {2}mix-3 {2}\(10\.9\.\d+\.\d+\): nedostupné \(SSH timeout\)\r\n\r\n/.test(s1.text) && !!US(s1.u).halted, 'ok + chyba + přeskočeno + nedostupné: AUTOMAT ZASTAVEN, počty sedí s tělem, „Neprovedeno“ má právě přeskočené a nedostupné');
  s1 = await scen('nedostupne', [ok, unr, skip, skip], 25);
  chk(s1.subj === '[upgrader] „Skupina nedostupne“ 25. 11.: 1 zařízení upgradováno, 3 neprovedeno' && /1 v pořádku, 0 chyb, 1 nedostupných, 2 přeskočeno/.test(s1.text) && (s1.text.split('Neprovedeno:\r\n')[1] || '').split('\r\n\r\n')[0].split('\r\n').length === 3 && !US(s1.u).halted, 'nedostupné kusy nejsou chyba: automat běží dál, „3 neprovedeno“ = 3 řádky v těle');
  s1 = await scen('castecne', [ok, part], 25);
  chk(!/castecne-1 {2}\(10\.9\.\d+\.\d+\): done/.test(s1.text) && /částečn/i.test(s1.text), 'částečně upgradovaný kus (zůstal na mezikroku) je v souhrnu popsaný jako částečný'); // BUG: počítá se do „přeskočeno“ a v „Neprovedeno“ je řádek „castecne-1 (…): done“
  s1 = await scen('evil-err', [{ status: 'failed', error: 'chyba\r\n.\r\nRCPT TO:<evil@x.cz>\r\n' + 'E'.repeat(5000) }, ok], 25);
  chk(s1.p && s1.p.rcpt.join() === 'RCPT TO:<evil-err@x.cz>' && maxLine(s1.p) <= 76 && US(s1.u).halted.length <= 600, 'text chyby ze zařízení s CRLF, tečkou a 5000 znaky: obálka beze změny, řádky ≤ 76');
  s1 = await scen('big', Array.from({ length: 300 }, (_, i) => i % 50 === 7 ? unr : i % 60 === 3 ? skip : ok), 25);
  chk(/289 zařízení upgradováno, 11 neprovedeno/.test(s1.subj) && s1.text.split('\r\n').filter(l => /^ {2}big-\d+ /.test(l)).length === 300 && s1.p.body.length < 100000 && maxLine(s1.p) <= 76, 'job s 300 zařízeními: všech 300 řádků, zpráva ' + (s1.p ? s1.p.body.length : 0) + ' B');
  const two = mkUser('dva@x.cz', 'dva'); auto.saveGroup(two.id, { name: 'První', deviceIds: [mkDev(two.id).id] }); auto.saveGroup(two.id, { name: 'Druhá', deviceIds: [mkDev(two.id).id] }); db.setUserSettings(two.id, { auto_enable: true });
  await auto.tick(D(1, 30, 25)); for (const l of US(two).open) { for (const it of db.getJobItems(l.jobId)) db.updateJobItem(it.id, { status: 'done' }); db.updateJob(l.jobId, { status: 'done' }); }
  await auto.tick(D(5, 0, 25)); await sleep(80);
  chk(mailsFor(two).map(p => dec2047(p.H.subject)).sort().join(' | ') === '[upgrader] „Druhá“ 25. 11.: 1 zařízení upgradováno | [upgrader] „První“ 25. 11.: 1 zařízení upgradováno', 'dva joby uzavřené naráz = dva souhrny (souběžná spojení)');

  console.log('automat: selhání odeslání');
  const H = mk('fail'), L = mk('ztraceny');
  await S.stop(); S = await fake({ RCPT: '451 4.3.0 greylisted, try later\r\n' }).start();
  await quiet(() => auto.tick(D(18, 0, 25))); // středa večer → noc na čtvrtek 26.11.
  chk(mailsFor(H).length === 0 && /451 4\.3\.0 greylisted/.test((US(H).mailError || {}).error || '') && /greylisted/.test((auto.statusFor(H).mail.error || {}).error || '') && logged.some(l => /fail@x\.cz se nepodařilo odeslat/.test(l)), 'nepovedené odeslání (451) tick neshodí, chyba se zapíše (mailError) a je vidět ve stavu');
  await S.stop(); S = await fake().start();
  await quiet(async () => { await auto.tick(D(18, 30, 25)); await auto.tick(D(21, 0, 25)); });
  chk(mailsFor(H).length === 1, 'oznámení, které se nepovedlo odeslat (dočasná chyba 451), se při dalším průchodu zopakuje'); // BUG: us.announced se nastaví před odesláním → po selhání se už nikdy nepošle
  await quiet(() => auto.tick(D(1, 30, 26))); const sum = await closeJob(H, [ok], D(5, 0, 26));
  chk(!!sum && /1 zařízení upgradováno/.test(dec2047(sum.H.subject)), 'další e-mail (souhrn) už odešel v pořádku');
  chk(!US(H).mailError && !auto.statusFor(H).mail.error, 'po úspěšně odeslaném hlášení chyba e-mailu ze stavu zmizí'); // BUG: mailError maže jen ruční zkušební e-mail → na stránce Automat visí stará chyba dál
  await auto.testMail(H); chk(!US(H).mailError, 'zkušební e-mail chybu smaže');
  await S.stop(); S = await fake({ MAIL: '451 4.3.0 try later\r\n' }).start();
  await closeJob(L, [fail], D(6, 0, 26));
  chk(!!US(L).halted && US(L).open.length === 0 && !!US(L).mailError, 'souhrn „AUTOMAT ZASTAVEN“ při výpadku SMTP: automat se zastaví, chyba e-mailu se zapíše');
  await S.stop(); S = await fake().start();
  await quiet(async () => { await auto.tick(D(7, 0, 26)); await auto.tick(D(9, 0, 26)); }); await sleep(80);
  chk(mailsFor(L).some(p => /AUTOMAT ZASTAVEN/.test(dec2047(p.H.subject))), 'souhrn „AUTOMAT ZASTAVEN“, který se nepovedlo odeslat, se po obnově SMTP doručí'); // BUG: jediný pokus, žádná fronta — o zastaveném automatu se správce e-mailem nedozví vůbec
  await S.stop(); S = await fake({ banner: 'silent' }).start();
  for (const u of db.listUsers()) db.setUserSettings(u.id, { auto_enable: false }); // ať oznámení čekají jen tři nové účty
  const J = mk('ticho1'), K = mk('ticho2'), K3 = mk('ticho3'); const t0 = Date.now();
  await quiet(() => auto.tick(D(18, 0, 29))); /* neděle večer → noc na pondělí 30.11. */ const took = Date.now() - t0;
  chk(US(J).mailError && US(K).mailError && US(K3).mailError, 'mlčící SMTP server: tick doběhne, chyby se zapíšou');
  chk(took < 2 * 400 + 300, `mlčící SMTP server nezdrží tick násobkem počtu účtů (3 oznámení trvala ${took} ms při limitu 400 ms na zprávu)`); // BUG: oznámení se v ticku posílají postupně s await → N účtů × 30 s; po tu dobu stojí vyhodnocení i spouštění jobů ostatních
  await S.stop();
  chk(unhandled === 0, 'žádná neošetřená rejection ani výjimka při selháních e-mailu');
}

(async () => {
  try { await testMailLib(); await testAutomat(); } catch (e) { console.error = origErr; console.error(e); bad++; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(bad ? `\nSELHALO: ${bad}` : '\nvše v pořádku');
  process.exit(bad ? 1 : 0);
})();
