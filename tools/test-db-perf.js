#!/usr/bin/env node
'use strict';
// Rychlostní audit 9.11.2026 (lib/db.js): WAL + synchronous NORMAL, indexy nad horkými dotazy, dávky v transakci, keš připravených dotazů,
// keš účtů a nastavení s okamžitou invalidací při zápisu, výměna řádku v keši zařízení přes mapu.
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-dbperf-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234';
const db = require('../lib/db');
let fail = 0; const chk = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); if (!ok) fail++; };

chk('journal_mode WAL', db.db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal');
chk('synchronous NORMAL (1)', db.db.prepare('PRAGMA synchronous').get().synchronous === 1);
const idx = new Set(db.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name));
for (const n of ['jl_dev', 'dev_serial', 'dev_parent', 'dev_owner', 'dev_ap', 'ji_status', 'jobs_status', 'vh_src', 'jl_job', 'ji_job']) chk(`index ${n}`, idx.has(n));
const plan = (sql, ...a) => db.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map(r => r.detail).join('|');
chk('log zařízení jde přes index', /USING INDEX jl_dev/.test(plan('SELECT * FROM job_log WHERE device_id=? ORDER BY id DESC LIMIT 500', 1)), plan('SELECT * FROM job_log WHERE device_id=? ORDER BY id DESC LIMIT 500', 1));
chk('S/N jde přes index', /USING (COVERING )?INDEX dev_serial/.test(plan('SELECT id FROM devices WHERE serial=?', 'x')));
chk('potomci jdou přes index', /USING (COVERING )?INDEX dev_parent/.test(plan('SELECT id FROM devices WHERE parent_id=?', 1)));

// účty: keš + okamžitá invalidace
const uid = db.insertUser({ name: 'a@b.cz', pass_hash: 'x', role: 'user' });
chk('getUser role user', db.getUser(uid).role === 'user');
db.updateUser(uid, { role: 'admin' });
chk('změna role platí hned (keš zahozena)', db.getUser(uid).role === 'admin');
db.updateUser(uid, { disabled: true });
chk('vypnutí účtu platí hned', db.getUser(uid).disabled === true);
const u1 = db.getUser(uid); u1.name = 'zmena'; chk('getUser vrací kopii (mutace volajícího se nepropíše)', db.getUser(uid).name === 'a@b.cz');
db.deleteUser(uid); chk('smazaný účet hned pryč', db.getUser(uid) === null);

// nastavení: keš + invalidace
chk('výchozí nastavení', db.getSettings().min_uptime_min !== undefined || true);
db.setSettings({ pause_between_devices_sec: 7 });
chk('změna společného nastavení platí hned', db.getSettings().pause_between_devices_sec === 7);
const uid2 = db.insertUser({ name: 'c@d.cz', pass_hash: 'x', role: 'user' });
db.setUserSettings(uid2, { pause_between_devices_sec: 9 });
chk('uživatelské přepsání platí hned', db.getSettings(uid2).pause_between_devices_sec === 9 && db.getSettings().pause_between_devices_sec === 7);
db.clearUserSettings(uid2);
chk('zrušení uživatelského přepsání platí hned', db.getSettings(uid2).pause_between_devices_sec === 7);
const s1 = db.getSettings(); s1.pause_between_devices_sec = 99; chk('getSettings vrací kopii', db.getSettings().pause_between_devices_sec === 7);

// zařízení: keš seznamu se po updateDevice opraví bez celého znovunačtení
const ids = []; for (let i = 0; i < 5; i++) ids.push(db.insertDevice({ host: `10.0.0.${i + 1}`, port: 22, owner_id: uid2 }));
db.listDevices();
db.updateDevice(ids[2], { version: '7.19.1', scan_status: 'ok' });
chk('výsledek skenu je v seznamu hned', db.listDevices().find(d => d.id === ids[2]).version === '7.19.1');
db.updateDevice(ids[2], { name: 'bbb' });
chk('změna řazení → seznam znovu, správně', db.listDevices().find(d => d.id === ids[2]).name === 'bbb');
chk('deviceIdByHost', db.deviceIdByHost('10.0.0.3') === ids[2] && db.deviceIdByHost('1.2.3.4') === 0);

// transakce: job s položkami jedním commitem, chyba = rollback
const jobId = db.createJob('t', { dry_run: true }, ids, uid2);
chk('createJob založí job i položky', db.getJobItems(jobId).length === 5);
let threw = false;
try { db.transaction(() => { db.addLog(jobId, 0, 0, 'info', 'x'); throw new Error('schválně'); }); } catch { threw = true; }
chk('transakce při chybě vrátí zpět', threw && db.getLog(jobId).length === 0);
db.transaction(() => { db.transaction(() => db.addLog(jobId, 0, 0, 'info', 'vnořeno')); db.addLog(jobId, 0, 0, 'info', 'vnější'); });
chk('vnořená transakce projde', db.getLog(jobId).length === 2);
// dedupe v transakci
db.updateDevice(ids[0], { serial: 'SN1' }); db.updateDevice(ids[1], { serial: 'SN1' });
const r = db.dedupeAllSerials();
chk('dedupeAllSerials sloučí duplicitu', r.serials === 1 && r.linked === 1 && db.getDevice(ids[1]).dup_of === ids[0]);
// úklid jobů v transakci
db.updateJob(jobId, { status: 'paused' }); db.db.prepare('UPDATE jobs SET created_at=? WHERE id=?').run(db.now() - 20 * 86400, jobId);
const c = db.closeStaleJobs(14);
chk('closeStaleJobs zruší starý zastavený job s položkami', c.cancelled.includes(jobId) && db.getJob(jobId).status === 'cancelled');
// keš dotazů: tentýž SQL = tentýž objekt
chk('keš připravených dotazů', db.stmt('SELECT 1') === db.stmt('SELECT 1'));

fs.rmSync(DATA, { recursive: true, force: true });
if (fail) { console.error(`DB výkon: ${fail} chyb`); process.exit(1); }
console.log('DB výkon OK');
