#!/usr/bin/env node
'use strict';
// Sdílený přístup podle APčka (lib/access.js, 4.11.2026): správce (SO) i zástupce (ZSO) téže oblasti vidí a spravují zařízení pod jejími
// APčky bez ohledu na to, kdo z nich je naimportoval; zařízení bez APčka vidí jen vlastník; joby vidí i kolega, když sahají na jeho zařízení;
// účet s APčkem přiděleným správcem nástroje (users.userdb_aps) má přístup taky; změna účtu mapu obnoví hned.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-access-'));
process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x';
const db = require('../lib/db');
const userdb = require('../lib/userdb');
// napodobená userdb: oblast 1 (APčka 10, 11) má SO uid 100 a ZSO uid 101; oblast 2 (APčko 20) má SO uid 200
userdb.enabled = () => true;
userdb.areas = async () => [
  { id: 1, name: 'Oblast A', aps: [{ id: 10, name: 'AP10' }, { id: 11, name: 'AP11' }], admins: [{ id: 100, nick: 'so-a', email: 'a@x', role: 'SO' }, { id: 101, nick: 'zso-a', email: 'b@x', role: 'ZSO' }] },
  { id: 2, name: 'Oblast B', aps: [{ id: 20, name: 'AP20' }], admins: [{ id: 200, nick: 'so-b', email: 'c@x', role: 'SO' }] },
];
const access = require('../lib/access');
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const mkUser = (name, uid) => { const id = db.insertUser({ name, pass_hash: '', role: 'user' }); if (uid) db.updateUser(id, { userdb_uid: uid, userdb_nick: name }); return id; };
const mkDev = (host, owner, apId) => { const id = db.insertDevice({ host, port: 22, owner_id: owner }); if (apId) db.updateDevice(id, { userdb_ap_id: apId, userdb_ap: 'AP' + apId }); return db.getDevice(id); };

(async () => {
  const A = mkUser('so-a', 100), B = mkUser('zso-a', 101), C = mkUser('so-b', 200), D = mkUser('assigned', 0);
  const d1 = mkDev('10.0.0.1', A, 10), d2 = mkDev('10.0.0.2', B, 11), d3 = mkDev('10.0.0.3', C, 20), d4 = mkDev('10.0.0.4', A, 0);
  await access.refresh(true);
  const ids = (uid) => access.visibleDevices(uid).map(d => d.id).sort().join(',');
  chk(ids(A) === [d1.id, d2.id, d4.id].sort().join(','), 'SO vidí své i zástupcovo zařízení pod APčky oblasti + své bez APčka');
  chk(ids(B) === [d1.id, d2.id].sort().join(','), 'ZSO vidí zařízení správce pod APčkem oblasti, ne jeho zařízení bez APčka');
  chk(ids(C) === String(d3.id), 'správce jiné oblasti vidí jen svou oblast');
  chk(ids(D) === '', 'účet bez vazby nevidí nic');
  chk(access.isShared(B, d1) && !access.isShared(A, d1), '„společné“ = přístupné, ale vlastní ho kolega');
  chk(!access.canAccess(B, { owner_id: C, userdb_ap_id: 20 }) && access.canAccess(B, { owner_id: C, userdb_ap_id: 11 }), 'canAccess podle APčka, ne podle vlastníka');
  // joby
  const j1 = db.createJob('oblast A', {}, [d1.id, d2.id], A), j2 = db.createJob('bez APčka', {}, [d4.id], A), j3 = db.createJob('oblast B', {}, [d3.id], C);
  chk(access.jobVisible(B, { id: j1 }) && !access.jobVisible(B, { id: j2 }) && !access.jobVisible(B, { id: j3 }), 'ZSO vidí job správce na společných zařízeních, ne na jeho soukromých ani cizí oblasti');
  chk(access.jobVisible(A, { id: j2, owner_id: A }) && access.jobVisible(C, { id: j3 }), 'vlastník jobu ho vidí vždy');
  chk(!access.jobVisible(B, { id: 99999 }), 'neexistující job nikdo nevidí');
  const lj = (uid) => access.visibleJobs(uid, 50).map(j => j.id).sort().join(',');
  chk(lj(B) === String(j1), `seznam jobů ZSO: jen job na společných zařízeních (${lj(B)})`);
  chk(lj(A) === [j1, j2].sort().join(','), 'seznam jobů SO: oba jeho joby');
  chk(lj(C) === String(j3), 'seznam jobů SO jiné oblasti');
  // APčko přidělené správcem nástroje
  db.updateUser(D, { userdb_aps: JSON.stringify([20]) }); await access.invalidate();
  chk(ids(D) === String(d3.id) && access.jobVisible(D, { id: j3 }), 'přidělené APčko (users.userdb_aps) dává přístup k zařízením i jobům pod ním');
  db.updateUser(D, { disabled: true }); await access.invalidate();
  chk(ids(D) === '', 'zakázaný účet přístup ztrácí');
  // změna APčka zařízení (dohledání z userdb) se projeví hned (bez keše na zařízení)
  db.updateDevice(d4.id, { userdb_ap_id: 11 });
  chk(access.canAccess(B, db.getDevice(d4.id)), 'po dohledání APčka u ručně přidaného kusu ho kolega hned vidí');
  console.log(bad ? `\n${bad} chyb` : '\nvše v pořádku');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
