#!/usr/bin/env node
'use strict';
// lib/mail.js: zpráva projde SMTP dialogem (EHLO, MAIL FROM, RCPT TO, DATA), česká diakritika v předmětu i těle, chyba serveru = výjimka
const net = require('net');
process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x';
let bad = 0; const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const got = { cmds: [], data: '' }; let reject = false;
const srv = net.createServer((s) => {
  let inData = false, buf = '';
  s.write('220 test ESMTP\r\n');
  s.on('data', (d) => { buf += d; let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      if (inData) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; got.data = buf.slice(0, e); buf = buf.slice(e + 5); inData = false; s.write('250 2.0.0 Ok: queued as TEST\r\n'); continue; }
      const line = buf.slice(0, i); buf = buf.slice(i + 2); got.cmds.push(line);
      if (/^EHLO/.test(line)) s.write('250-test\r\n250-SIZE 1000\r\n250 8BITMIME\r\n');
      else if (/^RCPT/.test(line) && reject) s.write('550 5.1.1 User unknown\r\n');
      else if (/^DATA/.test(line)) { inData = true; s.write('354 go\r\n'); }
      else if (/^QUIT/.test(line)) { s.end('221 bye\r\n'); }
      else s.write('250 Ok\r\n');
    } });
});
srv.listen(0, '127.0.0.1', async () => {
  process.env.MTU_SMTP_HOST = '127.0.0.1'; process.env.MTU_SMTP_PORT = String(srv.address().port); process.env.MTU_MAIL_FROM = 'Upgrader test <upg@example.org>';
  const mail = require('../lib/mail');
  try {
    const r = await mail.send({ to: 'kdo@example.com', subject: 'Automat: příští noc půjde 3 zařízení → 7.24.6 (žluťoučký kůň)', text: 'Řádek jedna\nŘádek dvě – česky.\n' });
    chk(/queued/.test(r), 'server zprávu přijal');
    chk(got.cmds.some(c => c === 'MAIL FROM:<upg@example.org>') && got.cmds.some(c => c === 'RCPT TO:<kdo@example.com>'), 'obálka: odesílatel a příjemce');
    const [head, body] = got.data.split('\r\n\r\n');
    chk(/^Subject: =\?UTF-8\?B\?/m.test(head) && /Content-Transfer-Encoding: base64/.test(head) && /^From: Upgrader test <upg@example.org>/m.test(head), 'hlavičky: zakódovaný předmět, base64, odesílatel');
    const subj = head.split('\r\n').filter((l, i, a) => /^Subject:/.test(l) || (/^ /.test(l) && a.slice(0, i).reverse().find(x => !/^ /.test(x)).startsWith('Subject:'))).join('').replace(/^Subject: /, '').split(/\s+/).map(w => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8')).join('');
    chk(subj === 'Automat: příští noc půjde 3 zařízení → 7.24.6 (žluťoučký kůň)', 'předmět se dekóduje zpět beze ztráty (' + subj + ')');
    chk(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') === 'Řádek jedna\r\nŘádek dvě – česky.\r\n', 'tělo se dekóduje zpět beze ztráty');
    reject = true; let err = '';
    try { await mail.send({ to: 'nikdo@example.com', subject: 'x', text: 'y' }); } catch (e) { err = e.message; }
    chk(/User unknown/.test(err), 'odmítnutý příjemce = chyba s hláškou serveru');
    let err2 = ''; try { await mail.send({ to: 'neni adresa', subject: 'x', text: 'y' }); } catch (e) { err2 = e.message; }
    chk(/neplatná adresa/.test(err2), 'neplatná adresa se neposílá');
  } catch (e) { console.error(e); bad++; }
  srv.close(); console.log(bad ? `\nSELHALO: ${bad}` : '\nvše v pořádku'); process.exit(bad ? 1 : 0);
});
