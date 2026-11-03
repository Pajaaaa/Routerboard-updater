#!/usr/bin/env node
'use strict';
// Hledání zařízení (lib/discovery.js) s poškozeným SSH host key: výchozí spojení končí KEY_EXCHANGE_FAILED, přes druhý typ klíče
// (v6 DSA) kus odpoví → zařízení se založí (bez uloženého otisku), ve výpisu je poznámka; špatný login přes náhradní klíč = „bez platného
// loginu“; nejvýš 2 náhradní pokusy. 3.11.2026: natažení z RB-DB 4 kusů selhalo a hláška slibovala opravu „po založení“, které neproběhlo.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-disc-'));
process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x'; process.env.MTU_SCAN_ALLOW = '10.0.0.0/8';
const ros = require('../lib/ros');
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } };

// napodobený kus: 10.0.0.1 má poškozený RSA klíč (výchozí i RSA → KEY_EXCHANGE_FAILED), přes DSA jde; 10.0.0.2 v pořádku; 10.0.0.3 nejde žádný typ
const connects = []; // [host, typ klíče, login]
class FakeRos {
  constructor(o) { this.o = o; this.hostKey = ''; }
  async connect() {
    const set = (this.o.algorithms || {}).serverHostKey || null;
    const kind = !set ? 'default' : set[0] === 'ssh-dss' ? 'DSA' : 'RSA';
    connects.push([this.o.host, kind, this.o.username]);
    if (this.o.host === '10.0.0.3') throw new Error('SSH: KEY_EXCHANGE_FAILED');
    if (this.o.host === '10.0.0.1' && kind !== 'DSA') throw new Error('SSH: KEY_EXCHANGE_FAILED');
    if (this.o.password !== 'ok') throw new Error('SSH: All configured authentication methods failed');
    this.hostKey = 'SHA256:' + kind;
  }
  async kv(cmd) { return cmd === '/system identity' ? { name: 'kus-' + this.o.host } : cmd === '/system routerboard' ? { model: 'RB911', 'serial-number': 'SN' + this.o.host } : { version: '6.42.7 (stable)', 'board-name': '911 Lite5', 'architecture-name': 'mipsbe' }; }
  close() {}
}
ros.RosClient = FakeRos;
ros.probeTcpWhy = async () => 'open';
const { Discovery } = require('../lib/discovery');
const db = require('../lib/db');
const bus = new (require('events'))();

(async () => {
  const d = new Discovery(bus);
  // 1) login z RB-DB/userdb správný: výchozí klíč nejde, DSA jde → založeno, bez otisku, s poznámkou
  let st = await d.run({ ownerId: 1, entries: [{ host: '10.0.0.1', username: 'admin', password: 'ok' }, { host: '10.0.0.2', username: 'admin', password: 'ok' }] });
  chk(st.added === 2 && st.errors.length === 0, `oba kusy založeny (added=${st.added}, chyby: ${st.errors.join('; ')})`);
  const f1 = st.found.find(f => f.host === '10.0.0.1'), f2 = st.found.find(f => f.host === '10.0.0.2');
  chk(f1 && /poškozený SSH host key/.test(f1.note || '') && /DSA/.test(f1.note), 'poznámka o náhradním klíči u kusu s poškozeným klíčem');
  chk(f2 && !f2.note, 'kus v pořádku bez poznámky');
  chk(st.keyFixed === 1, `počet kusů přes náhradní klíč (${st.keyFixed})`);
  const d1 = db.getDeviceRaw(f1.id), d2 = db.getDeviceRaw(f2.id);
  chk(d1 && d1.host_key === '' && d1.version === '6.42.7' && d1.scan_status === 'ok' && d1.identity === 'kus-10.0.0.1', 'kus přes náhradní klíč: bez otisku, verze a identita načtené');
  chk(d2 && d2.host_key === 'SHA256:default', 'kus v pořádku: otisk uložený');
  const c1 = connects.filter(c => c[0] === '10.0.0.1').map(c => c[1]);
  chk(c1.join(',') === 'default,DSA', `pořadí pokusů u poškozeného klíče: ${c1.join(',')} (čekáno default,DSA)`);
  chk(connects.filter(c => c[0] === '10.0.0.2').length === 1, 'kus v pořádku jen jedno spojení');

  // 2) žádný typ klíče nejde → chyba s poškozeným klíčem, nejvýš 2 náhradní pokusy, další loginy se nezkouší
  connects.length = 0;
  st = await d.run({ ownerId: 1, ranges: ['10.0.0.3/32'], creds: [{ username: 'a', password: 'ok' }, { username: 'b', password: 'ok' }] });
  chk(st.added === 0 && st.errors.length === 1 && /poškozený SSH host key/.test(st.errors[0]), `chyba poškozeného klíče hlášena: ${st.errors.join('; ')}`);
  chk(connects.length === 3 && connects.every(c => c[2] === 'a'), `3 pokusy jedním loginem (${connects.map(c => c[1] + '/' + c[2]).join(',')})`);

  // 3) náhradní klíč jde, první login neseděl → další login přes stejný náhradní klíč; všechny špatné = bez platného loginu
  connects.length = 0;
  db.deleteDevice(f1.id);
  st = await d.run({ ownerId: 1, entries: [{ host: '10.0.0.1', username: 'admin', password: 'spatne' }], creds: [{ username: 'hkf', password: 'ok' }] });
  chk(st.added === 1 && st.found[0].note && db.getDevice(st.found[0].id).username === 'hkf', `druhý login přes náhradní klíč (added=${st.added})`);
  chk(connects.map(c => c[1] + '/' + c[2]).join(',') === 'default/admin,DSA/admin,DSA/hkf', `pořadí pokusů: ${connects.map(c => c[1] + '/' + c[2]).join(',')}`);
  connects.length = 0;
  db.deleteDevice(st.found[0].id);
  st = await d.run({ ownerId: 1, entries: [{ host: '10.0.0.1', username: 'admin', password: 'spatne' }] });
  chk(st.added === 0 && st.authFailed.length === 1 && st.errors.length === 0, `špatný login přes náhradní klíč = bez platného loginu (auth=${st.authFailed.length}, chyby=${st.errors.length})`);

  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  if (bad) { console.error(`test-discovery-altkey: ${bad} chyb`); process.exit(1); }
  console.log('test-discovery-altkey: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
