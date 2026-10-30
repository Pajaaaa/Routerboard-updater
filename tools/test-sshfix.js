#!/usr/bin/env node
'use strict';
// Oprava SSH před upgradem (lib/sshfix.js, lib/rosapi.js): rozpoznání chyb, kódování API protokolu, přihlášení (nový i starý způsob),
// pořadí náhradních kanálů (SSH s jiným klíčem → API → api-ssl → REST → telnet) a hlášení do logu.
const net = require('net');
const http = require('http');
const SF = require('../lib/sshfix');
const { apiRun, restPost, encodeSentence, decodeSentences, encodeLength } = require('../lib/rosapi');
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } };

// --- rozpoznání chyb ---
const CORRUPT = ['SSH: KEY_EXCHANGE_FAILED', 'KEY_EXCHANGE_FAILED', 'SSH: Handshake failed: signature verification failed'];
const ALGO = ['SSH: Handshake failed: no matching key exchange algorithm', 'Handshake failed: no matching host key format', 'SSH: Handshake failed: no matching C->S cipher', 'SSH: Handshake failed: no matching S->C MAC'];
const OTHER = ['SSH: Timed out while waiting for handshake', 'SSH: connect ECONNREFUSED 10.0.0.1:22', 'SSH: All configured authentication methods failed', 'SSH: Host denied (verification failed)', 'SSH: connect EHOSTUNREACH 10.0.0.1:22', 'SSH: spojení uzavřeno', ''];
for (const m of CORRUPT) chk((SF.classifySshError(m) || {}).kind === 'corrupt-key', `poškozený klíč nerozpoznán: ${m}`);
for (const m of ALGO) chk((SF.classifySshError(m) || {}).kind === 'algo', `chybějící algoritmus nerozpoznán: ${m}`);
for (const m of OTHER) chk(SF.classifySshError(m) === null, `mylně bráno jako potíž s klíčem: ${m}`);
chk(/kex/.test(SF.classifySshError(ALGO[0]).text) && /šifru/.test(SF.classifySshError(ALGO[2]).text), 'text chyby algoritmu nepopisuje, co chybí');
// pořadí náhradních typů klíče: v6 nejdřív DSA, v7 nejdřív RSA; vždy nejvýš 2 pokusy (brute-force pravidla)
chk(SF.altHostKeySets('6.49.18')[0][0] === 'ssh-dss' && SF.altHostKeySets('7.24.2')[0].includes('ssh-rsa') && SF.altHostKeySets('').length === 2 && SF.altHostKeySets('7.1').length === 2, 'pořadí náhradních typů host key');
// zastaralé algoritmy musí být nadmnožinou bezpečné sady a obsahovat to, co bezpečná nemá
chk(SF.LEGACY_ALGORITHMS.cipher.includes('3des-cbc') && SF.LEGACY_ALGORITHMS.hmac.includes('hmac-md5') && SF.LEGACY_ALGORITHMS.kex.includes('diffie-hellman-group1-sha1') && SF.LEGACY_ALGORITHMS.serverHostKey.includes('ssh-dss'), 'zastaralá sada algoritmů neúplná');

// --- kódování API protokolu ---
chk(encodeLength(5).equals(Buffer.from([5])) && encodeLength(0x100).equals(Buffer.from([0x81, 0x00])) && encodeLength(0x4000).equals(Buffer.from([0xC0, 0x40, 0x00])) && encodeLength(0x200000).equals(Buffer.from([0xE0, 0x20, 0x00, 0x00])), 'kódování délky slova');
const words = ['/login', '=name=admin', '=password=' + 'x'.repeat(200), '=long=' + 'y'.repeat(20000)];
const enc = encodeSentence(words);
const d1 = decodeSentences(enc);
chk(d1.sentences.length === 1 && d1.rest.length === 0 && JSON.stringify(d1.sentences[0]) === JSON.stringify(words), 'věta se po zakódování nedekóduje stejně');
const part = decodeSentences(enc.subarray(0, 50));
chk(part.sentences.length === 0 && part.rest.length === 50, 'neúplná věta se nesmí vydat za hotovou');
const two = decodeSentences(Buffer.concat([encodeSentence(['!done']), encodeSentence(['!trap', '=message=x'])]));
chk(two.sentences.length === 2 && two.sentences[1][1] === '=message=x', 'dvě věty v jednom bufferu');

// --- falešný RouterOS API server: nový login (6.43+) i starý s challenge; pamatuje si, co dostal ---
function fakeApi({ legacy = false, rejectLogin = false } = {}) {
  const got = [];
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0), challenged = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { sentences, rest } = decodeSentences(buf); buf = rest;
      for (const s of sentences) {
        got.push(s);
        if (s[0] === '/login') {
          if (rejectLogin) { sock.write(encodeSentence(['!trap', '=message=invalid user name or password (6)'])); continue; }
          if (legacy && !challenged) { challenged = true; sock.write(encodeSentence(['!done', '=ret=00112233445566778899aabbccddeeff'])); continue; }
          if (legacy && !s.some(w => w.startsWith('=response=00'))) { sock.write(encodeSentence(['!trap', '=message=bez odpovědi na challenge'])); continue; }
          sock.write(encodeSentence(['!done'])); continue;
        }
        if (s[0] === '/ip/ssh/regenerate-host-key') { sock.write(encodeSentence(['!done'])); continue; }
        if (s[0] === '/system/reboot') { sock.write(encodeSentence(['!done'])); sock.end(); continue; }
        sock.write(encodeSentence(['!trap', '=message=no such command']));
      }
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, got, close: () => srv.close() })));
}
function fakeRest({ v6 = false } = {}) {
  const got = [];
  const srv = http.createServer((req, res) => {
    got.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (v6) { res.writeHead(404); return res.end('not found'); }
    if (!/^Basic /.test(req.headers.authorization || '')) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, got, close: () => srv.close() })));
}

(async () => {
  // apiRun: nový login
  let a = await fakeApi();
  let tr = await apiRun({ host: '127.0.0.1', port: a.port, username: 'admin', password: 'heslo', timeoutMs: 5000 }, [['/ip/ssh/regenerate-host-key'], ['/system/reboot']]);
  chk(a.got.length === 3 && a.got[0][0] === '/login' && a.got[0].includes('=password=heslo') && a.got[1][0] === '/ip/ssh/regenerate-host-key' && a.got[2][0] === '/system/reboot', 'API: pořadí vět (nový login)');
  chk(/regenerate-host-key/.test(tr), 'API: přepis neobsahuje příkaz');
  a.close();
  // apiRun: starý login s challenge (md5)
  a = await fakeApi({ legacy: true });
  await apiRun({ host: '127.0.0.1', port: a.port, username: 'admin', password: 'heslo', timeoutMs: 5000 }, [['/ip/ssh/regenerate-host-key'], ['/system/reboot']]);
  const resp = a.got[1] && a.got[1].find(w => w.startsWith('=response=00'));
  chk(a.got.length === 4 && a.got[1][0] === '/login' && resp && resp.length === 12 + 32 && a.got[2][0] === '/ip/ssh/regenerate-host-key', 'API: starý login s challenge');
  a.close();
  // apiRun: odmítnuté přihlášení → chyba, žádný příkaz
  a = await fakeApi({ rejectLogin: true });
  let err = null; try { await apiRun({ host: '127.0.0.1', port: a.port, username: 'admin', password: 'x', timeoutMs: 5000 }, [['/system/reboot']]); } catch (e) { err = e; }
  chk(err && /přihlášení odmítnuto/.test(err.message) && a.got.length === 1, 'API: špatné heslo musí skončit chybou bez příkazů');
  a.close();
  // restPost
  let r = await fakeRest();
  const rr = await restPost({ host: '127.0.0.1', port: r.port, username: 'admin', password: 'heslo', timeoutMs: 3000 }, 'ip/ssh/regenerate-host-key', {});
  chk(rr.status === 200 && r.got[0].url === '/rest/ip/ssh/regenerate-host-key' && r.got[0].method === 'POST' && r.got[0].auth === 'Basic ' + Buffer.from('admin:heslo').toString('base64'), 'REST: požadavek');
  r.close();

  // --- regenerateHostKey: pořadí kanálů s náhradními závislostmi ---
  const log = []; const L = (lvl, m) => log.push(`${lvl}:${m}`);
  const calls = [];
  const deps = (openPorts, { apiFail = false, restStatus = 200 } = {}) => ({
    probe: async (host, port) => openPorts.includes(port) ? 'open' : 'refused',
    api: async (o, cmds) => { calls.push(`api${o.ssl ? '-ssl' : ''}:${o.port}`); if (apiFail) throw new Error('API: přihlášení odmítnuto'); return cmds.map(c => c[0]).join(';'); },
    rest: async (o, p) => { calls.push(`rest:${o.port}:${p}`); return { status: restStatus, body: '[]' }; },
    telnet: async (o, cmds) => { calls.push('telnet'); return cmds.join(';'); },
  });
  const creds = { host: '10.0.0.1', port: 22, username: 'admin', password: 'x', timeoutMs: 1000 };
  // 1) SSH s jiným klíčem funguje hned → žádný jiný kanál
  let sshTries = 0;
  const fakeClient = { conn: { exec: (cmd, cb) => { const EventEmitter = require('events'); const s = new EventEmitter(); s.stderr = new EventEmitter(); s.write = () => {}; cb(null, s); setImmediate(() => { s.emit('data', Buffer.from('')); s.emit('close'); }); } }, closed: false, close() { this.closed = true; } };
  let res = await SF.regenerateHostKey({ creds, version: '6.49.18', log: L, deps: deps([8728, 23]), tryConnect: async (extra) => { sshTries++; chk(extra.expectedHostKey === '' && extra.algorithms && extra.algorithms.serverHostKey, 'náhradní SSH musí vypnout kontrolu otisku a přepsat jen serverHostKey'); return fakeClient; } });
  chk(/^SSH \(host key ssh-dss\)/.test(res.channel) && sshTries === 1 && calls.length === 0, `SSH s jiným klíčem má přednost (${res.channel}, pokusů ${sshTries}, další kanály ${calls.join(',')})`);
  chk(log.some(l => /regenerate-host-key proběhl/.test(l)) && log.some(l => /posílám \/system reboot/.test(l)), 'postup přes SSH musí být v logu');
  // 2) SSH nejde (2 pokusy, ne víc) → API 8728
  sshTries = 0; calls.length = 0; log.length = 0;
  res = await SF.regenerateHostKey({ creds, version: '7.24.2', log: L, deps: deps([8728, 8729, 80, 23]), tryConnect: async () => { sshTries++; throw new Error('SSH: KEY_EXCHANGE_FAILED'); } });
  chk(sshTries === 2, `náhradních SSH pokusů musí být právě 2 (brute-force pravidla), bylo ${sshTries}`);
  chk(/RouterOS api \(8728\)/.test(res.channel) && calls.join(',') === 'api:8728', `po SSH přijde API 8728 (${res.channel}; ${calls.join(',')})`);
  chk(log.some(l => /otevřené služby na zařízení: api \(8728\), api-ssl \(8729\), www \(80\), telnet \(23\)/.test(l)), 'log musí vypsat otevřené služby');
  // 3) API jen SSL a odmítá → REST www → úspěch
  sshTries = 0; calls.length = 0; log.length = 0;
  res = await SF.regenerateHostKey({ creds, version: '7.24.2', log: L, deps: deps([8729, 80, 23], { apiFail: true }), tryConnect: async () => { throw new Error('SSH: KEY_EXCHANGE_FAILED'); } });
  chk(/REST www \(80\)/.test(res.channel) && calls.join(',') === 'api-ssl:8729,rest:80:ip/ssh/regenerate-host-key,rest:80:system/reboot', `api-ssl → REST (${res.channel}; ${calls.join(',')})`);
  chk(log.some(l => /^warn:api-ssl nejde/.test(l)), 'neúspěšný kanál musí být v logu jako varování');
  // 4) REST na v6 (404) → telnet
  calls.length = 0; log.length = 0;
  res = await SF.regenerateHostKey({ creds, version: '6.49.18', log: L, deps: deps([80, 23], { restStatus: 404 }), tryConnect: async () => { throw new Error('SSH: KEY_EXCHANGE_FAILED'); } });
  chk(/telnet \(23\)/.test(res.channel) && calls.join(',') === 'rest:80:ip/ssh/regenerate-host-key,telnet', `REST 404 → telnet (${res.channel}; ${calls.join(',')})`);
  chk(log.some(l => /RouterOS 6 — Webfig bez REST/.test(l)), 'REST 404 musí v logu vysvětlit, že v6 REST nemá');
  // 5) nic otevřeného → chyba se souhrnem a návodem
  calls.length = 0; err = null;
  try { await SF.regenerateHostKey({ creds, version: '', log: L, deps: deps([]), tryConnect: async () => { throw new Error('SSH: KEY_EXCHANGE_FAILED'); } }); } catch (e) { err = e; }
  chk(err && /žádnou cestou/.test(err.message) && /api: port 8728 odmítá/.test(err.message) && /telnet: port 23 odmítá/.test(err.message) && /Winbox/.test(err.message) && calls.length === 0, `bez kanálu musí skončit chybou se souhrnem: ${err && err.message.slice(0, 200)}`);
  // bez tryConnect (jen jiné kanály) nesmí spadnout
  res = await SF.regenerateHostKey({ creds, log: L, deps: deps([23]) });
  chk(/telnet/.test(res.channel), 'bez tryConnect se musí použít jiné kanály');

  // runner: oprava je zapojená do připojení položky a „Handshake failed“ se už neopakuje jako přechodná chyba
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/runner.js'), 'utf8');
  chk(/c = await connectOrRepair\(\)/.test(src) && /SF\.regenerateHostKey\(/.test(src) && /SF\.connectLegacy\(/.test(src), 'runner nevolá opravu SSH při připojení položky');
  chk(/Timed out while waiting for handshake/.test(src) && !/transient = \/handshake\|/.test(src), 'runner: „Handshake failed“ nesmí být bráno jako přechodná chyba');
  chk(/let rebootedByUs = sshRepaired/.test(src), 'runner: po restartu kvůli opravě klíče se nesmí kontrolovat min. uptime');
  chk(/host_key: ''/.test(src.slice(src.indexOf('connectOrRepair'), src.indexOf('connectOrRepair') + 4000)), 'runner: po přegenerování klíče se musí smazat uložený otisk');

  if (bad) { console.error(`oprava SSH: ${bad} chyb`); process.exit(1); }
  console.log('oprava SSH OK');
})().catch((e) => { console.error(e); process.exit(1); });
