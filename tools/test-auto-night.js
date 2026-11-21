#!/usr/bin/env node
'use strict';
// Automat (lib/autoupgrade.js) — ŽIVOTNÍ CYKLUS NOČNÍHO BĚHU: hrany okna, letní/zimní čas, zrání verzí, spouštění víc skupin, restart serveru
// uprostřed noci, vyhodnocení jobů, konec okna a cíle verzí ve skutečném RunnerPoolu proti falešnému zařízení, vynechání noci, stavový soubor.
// Doplňuje tools/test-auto-upgrade.js. Kontroly označené „// BUG:“ popisují chování, které má být jinak — selhávají, dokud se neopraví.
process.env.TZ = 'Europe/Prague'; // přechody času se zkouší na středoevropském čase bez ohledu na nastavení stroje
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-auto-night-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x'; process.env.USERDB_URL = '';
global.fetch = async () => { throw new Error('síť je v testu zakázaná'); };
const day = 86400, MB = 1048576;
const sec = (d) => Math.floor(d.getTime() / 1000);
const at = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s);
const OLD = sec(at(2026, 10, 1)); // datum vydání „dávno zralé“ verze
fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({ 'v7-long-term': [{ version: '7.24.6', releasedAt: OLD }], 'v7-stable': [{ version: '7.25.1', releasedAt: OLD }], 'v6-long-term': [{ version: '6.49.24', releasedAt: OLD }] }));
const STATE = path.join(dir, 'auto-upgrade.json');
const db = require('../lib/db');
const V = require('../lib/versions');
V.refreshLatest = async () => {}; // žádná síť
V.packageInfo = async (pkg, ver, arch) => ({ url: 'x', file: `${pkg}-${ver}-${arch}.npk`, exists: true, size: 5e6 });
let pinMap = {}; V.configure({ pins: () => pinMap });
const MT = V.getLatest().mikrotik; // živý odkaz na „co nabízí MikroTik“
const setMT = (track, version, releasedAt) => { if (version) MT[track] = { version, releasedAt }; else delete MT[track]; };
const resetMT = () => { setMT('v7-long-term', '7.24.6', OLD); setMT('v7-stable', '7.25.1', OLD); setMT('v6-long-term', '6.49.24', OLD); };
// --- falešné zařízení pro skutečný runner: SSH klient + inspect (musí být před načtením lib/runner)
const ros = require('../lib/ros'), I = require('../lib/inspect');
const live = {};  // host → { version, delay (ms od 2. připojení), fail (chyba připojení), identity2 (identita od 2. zjištění stavu), total_mem }
const conns = {}, inspects = {};
class FakeClient {
  constructor(o) { this.o = o; this.conn = {}; this.closed = false; this.hostKey = ''; this.slowFactor = 1; }
  async connect() { const l = live[this.o.host] || {}; const n = conns[this.o.host] = (conns[this.o.host] || 0) + 1; if (l.fail) throw new Error(l.fail); if (l.delay && n > 1) await new Promise(r => setTimeout(r, l.delay)); }
  close() { this.closed = true; } abort() { this.closed = true; }
  async exec(cmd) { return /^\/export/.test(String(cmd || '')) ? '# falešný export\n/system identity\nset name=test\n' : ''; } async kv() { return {}; } async list() { return []; } async count() { return 0; }
}
ros.RosClient = FakeClient;
const fakeInfo = (d, l = {}) => ({ identity: l.identity || d.identity || 'dev' + d.id, board_name: d.board_name || 'SXTsq', model: d.model || 'SXTsq', serial: l.serial || d.serial || '', arch: 'arm', version: l.version || d.version, channel: 'long-term',
  fw_current: '7.24.4', fw_upgrade: '7.24.4', total_hdd: 128 * MB, free_hdd: 60 * MB, total_mem: l.total_mem || 256 * MB, free_mem: (l.total_mem || 256 * MB) / 2, uptime: '5d', uptime_sec: 5 * day, cpu_load: 3,
  packages: [{ name: 'routeros', version: l.version || d.version, disabled: false }], flags: {}, platform: 'MikroTik', routerboard: true, flash_dir: false, bad_blocks: 0, partitions: [], npk_files: [], pkgupdate: null, links: null,
  interfaces: [], addresses: [], log_symptoms: [], counts: {}, user_policy: { missing: [] }, poe_watchdogs: [], reboot_scripts: [], vlan_mgmt: [] });
I.inspect = async (c) => { const h = c.o.host, l = { ...(live[h] || {}) }; const n = inspects[h] = (inspects[h] || 0) + 1; if (l.identity2 && n > 1) l.identity = l.identity2; return fakeInfo(db.listDevices().find(x => x.host === h), l); };
let auto = require('../lib/autoupgrade');
const { RunnerPool, Runner } = require('../lib/runner');
const { plan } = require('../lib/planner');
const mail = require('../lib/mail');
const mails = []; mail.enabled = () => true; mail.send = async (m) => { mails.push(m); return 'ok'; };

let bad = 0, bugs = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const bug = (ok, msg) => { if (!ok) { console.error('  ✗ BUG: ' + msg); bad++; bugs++; } else console.log('  ✓ (opraveno) ' + msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
// falešné „teď“ pro funkce, které čas nedostávají parametrem (skipNight, statusFor)
const RealDate = Date;
const withClock = (d, fn) => { const ms = d.getTime(); global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(ms); } static now() { return ms; } }; try { return fn(); } finally { global.Date = RealDate; } };

// --- pool: falešný (jen zapisuje) nebo skutečný RunnerPool
const started = [], poked = []; let rp = null, realPool = false, startHook = null, startThrows = null, draining = false;
const pool = {
  get draining() { return realPool ? rp.draining : draining; },
  isDeviceBusy: (id) => realPool ? rp.isDeviceBusy(id) : false,
  runnerOfJob: (id) => realPool ? rp.runnerOfJob(id) : { busy: true, currentJobId: id, pause: () => poked.push(id), cancel: () => poked.push(id), set stopNote(v) { poked.push(id); }, get stopNote() { return ''; } },
  startOrQueue: (id) => { started.push(id); if (startThrows) { const e = startThrows; startThrows = null; throw new Error(e); } if (startHook) startHook(id); if (realPool) return rp.startOrQueue(id); return { queued: false }; },
};
const reload = () => { delete require.cache[require.resolve('../lib/autoupgrade')]; auto = require('../lib/autoupgrade'); auto.configure({ pool, notify: () => {} }); };
auto.configure({ pool, notify: () => {} });
db.setSettings({ auto_users: '*' });

let un = 0, dn = 0; const users = [];
const mkUser = (s = {}) => { const nick = 'u' + (++un); const id = db.insertUser({ name: nick + '@x.cz', pass_hash: '', role: 'user' }); db.updateUser(id, { userdb_nick: nick });
  db.setUserSettings(id, { auto_enable: true, auto_window: '01:00-04:30', auto_days: '0,1,2,3,4,5,6', auto_delay_days: 5, auto_mail: false, pause_between_devices_sec: 0, ...s }); const u = db.listUsers().find(x => x.id === id); users.push(u); return u; };
const setS = (u, s) => db.setUserSettings(u.id, { ...db.getUserSettings(u.id), ...s });
const mkDev = (owner, f = {}) => { const id = db.insertDevice({ host: `127.9.${Math.floor(dn / 250)}.${(dn++ % 250) + 1}`, port: 22, owner_id: owner.id, username: 'a', password: 'b' });
  db.updateDevice(id, { version: '7.24.4', scan_status: 'ok', userdb_member: 1, model: 'SXTsq', board_name: 'SXTsq', track: 'v7-long-term', skip_link_check: 1, identity: 'dev' + id, last_seen_at: db.now(), ...f }); return db.getDevice(id); };
const grp = (u, name, devs, extra = {}) => { const r = auto.saveGroup(u.id, { name, deviceIds: devs.map(d => d.id), ...extra }); if (r.error) throw new Error('saveGroup: ' + r.error); return r.group; };
const US = (u) => auto._state().users[u.id] || {};
/** uzavře job, jako by doběhl: fn(položka) → stav nebo { status, error, result }; „done“ zvedne verzi kusu na cíl */
const fin = (jobId, fn = () => 'done', jobStatus = 'done') => { const job = db.getJob(jobId);
  for (const it of db.getJobItems(jobId)) { let r = fn(it); if (typeof r === 'string') r = { status: r }; db.updateJobItem(it.id, { finished_at: db.now(), ...r });
    if (r.status === 'done' && !(r.result && r.result.partial)) { const d = db.getDevice(it.device_id); db.updateDevice(it.device_id, { version: job.options.targets[d.track] || d.version }); } }
  db.updateJob(jobId, { status: jobStatus, finished_at: db.now() }); };
const closeAll = () => { for (const j of db.listJobsOpen()) db.updateJob(j.id, { status: 'cancelled', finished_at: db.now() }); };
/** jedna izolovaná situace: po ní se účty vypnou a rozjeté joby zavřou, ať další situace začíná s čistým stolem */
const scene = async (name, fn) => { console.log('\n' + name); const u0 = users.length; resetMT(); draining = false; startHook = null; startThrows = null; mails.length = 0;
  try { await fn(); } catch (e) { console.error('  ✗ výjimka: ' + (e.stack || e.message)); bad++; }
  global.Date = RealDate; for (const u of users.slice(u0)) { try { setS(u, { auto_enable: false }); } catch {} } closeAll(); db.setSettings({ auto_pause: false, auto_users: '*' }); for (const v of Object.keys(auto._state().quarantine)) auto.unquarantine(v); };
const since = (n0) => started.slice(n0);

(async () => {
  // =====================================================================================================================
  await scene('OKNO — hrany', async () => {
    const S = { auto_window: '01:00-04:30' };
    chk(auto.windowNow(S, at(2026, 11, 24, 0, 59, 59)) === null && !!auto.windowNow(S, at(2026, 11, 24, 1, 0, 0)), 'začátek: 00:59:59 ještě ne, 01:00:00 ano');
    const e = auto.windowNow(S, at(2026, 11, 24, 4, 29, 59));
    chk(e && e.leftMin > 0 && e.leftMin < 1 && auto.windowNow(S, at(2026, 11, 24, 4, 30, 0)) === null, 'konec: 04:29:59 ještě běží (zbývá < 1 min), 04:30:00 už ne');
    chk(e.endSec === sec(at(2026, 11, 24, 4, 30)) && e.night === '2026-11-24' && e.day === 2, 'konec okna = 04:30 téhož dne, noc 24.11. (úterý)');
    const u = mkUser(); const a = mkDev(u), b = mkDev(u); grp(u, 'G', [a, b]);
    let n0 = started.length;
    await auto.tick(at(2026, 11, 24, 4, 0, 1)); chk(since(n0).length === 0 && US(u).lastNight !== '2026-11-24', '04:00:01 (do konce 29 min 59 s) se nezačíná a noc se nespotřebuje');
    await auto.tick(at(2026, 11, 25, 4, 0, 0)); chk(since(n0).length === 1, 'přesně 30 min před koncem (04:00:00) se ještě začne');
    chk(db.getJob(since(n0)[0]).options.stop_at === sec(at(2026, 11, 25, 4, 30)), 'stop_at jobu = konec okna 04:30');
    fin(since(n0)[0], () => 'skipped'); n0 = started.length;
    await auto.tick(at(2026, 11, 26, 0, 59, 59)); chk(since(n0).length === 0, 'vteřinu před začátkem okna nic');
    await auto.tick(at(2026, 11, 26, 1, 0, 0)); chk(since(n0).length === 1 && US(u).lastNight === '2026-11-26', 'přesně na začátku okna (01:00:00) se spustí');
  });

  await scene('OKNO — přes půlnoc, povolené dny, okno delší než 12 h', async () => {
    const S = { auto_window: '23:00-04:00', auto_days: '1' };
    const w1 = auto.windowNow(S, at(2026, 11, 23, 23, 0)), w2 = auto.windowNow(S, at(2026, 11, 24, 3, 59));
    chk(w1 && w2 && w1.night === '2026-11-23' && w2.night === '2026-11-23' && w1.day === 1 && w2.day === 1 && w1.endSec === sec(at(2026, 11, 24, 4, 0)) && w2.endSec === w1.endSec, 'okno 23:00–04:00: po půlnoci je to pořád noc pondělí 23.11., konec úterý 04:00');
    chk(auto.windowNow(S, at(2026, 11, 24, 4, 0)) === null && auto.windowNow(S, at(2026, 11, 23, 22, 59)) === null, 'mimo okno přes půlnoc');
    const u = mkUser(S); const a = mkDev(u); grp(u, 'G', [a]);
    let n0 = started.length;
    await auto.tick(at(2026, 11, 23, 1, 30)); chk(since(n0).length === 0, 'povolené jen pondělí: pondělí 01:30 patří k noci, která začala v neděli → nic');
    await auto.tick(at(2026, 11, 24, 1, 30)); chk(since(n0).length === 1 && US(u).lastNight === '2026-11-23', 'úterý 01:30 patří k pondělní noci → spustí se, klíč noci 23.11.');
    fin(since(n0)[0], () => 'skipped'); n0 = started.length;
    await auto.tick(at(2026, 11, 24, 23, 30)); chk(since(n0).length === 0, 'úterní noc povolená není');
    await auto.tick(at(2026, 11, 30, 23, 0)); chk(since(n0).length === 1 && US(u).lastNight === '2026-11-30', 'další pondělí 23:00 se spustí znovu');
    const L = { auto_window: '08:00-07:00' };
    const l1 = auto.windowNow(L, at(2026, 11, 24, 8, 0)), l2 = auto.windowNow(L, at(2026, 11, 25, 6, 59));
    chk(l1 && l2 && l1.night === '2026-11-24' && l2.night === '2026-11-24' && l1.endSec === sec(at(2026, 11, 25, 7, 0)) && Math.round(l1.leftMin) === 23 * 60 && auto.windowNow(L, at(2026, 11, 24, 7, 30)) === null, 'okno 23 h (08:00–07:00): jedna noc, konec druhý den v 07:00, mezera 07:00–08:00');
    // nextWindow ↔ windowNow: začátek „nejbližší noci“ musí padnout do okna se stejným klíčem noci a povoleným dnem
    let incons = '';
    for (const win of ['01:00-04:30', '23:00-04:00', '00:00-03:00', '12:00-11:00', '03:30-05:00']) for (const days of ['0,1,2,3,4,5,6', '1,2,3,4', '0', '6'])
      for (let t = at(2026, 11, 20, 0, 17).getTime(); t < at(2026, 12, 6).getTime(); t += 3 * 3600e3 + 7 * 60e3) {
        const s = { auto_window: win, auto_days: days }, nw = auto.nextWindow(s, new Date(t)); if (!nw) { incons = incons || `${win} dny ${days}: žádné další okno`; continue; }
        const w = auto.windowNow(s, new Date(nw));
        if (!(nw > t && w && w.night === nk(new Date(nw)) && days.split(',').map(Number).includes(w.day) && nw - t <= 8 * day * 1000)) incons = incons || `${win} dny ${days} v ${new Date(t).toLocaleString('cs-CZ')}: nextWindow ${new Date(nw).toLocaleString('cs-CZ')}, windowNow ${JSON.stringify(w)}`;
      }
    chk(!incons, 'nextWindow a windowNow.night se shodují (klíč lastNight/skipNight/announced), i u okna přes půlnoc a po půlnoci' + (incons ? ' — ' + incons : ''));
  });

  await scene('OKNO — letní/zimní čas (28.3.2027 a 31.10.2027), okno 01:00–04:30', async () => {
    const S = { auto_window: '01:00-04:30' };
    chk(at(2027, 3, 28, 1, 30).getTimezoneOffset() === -60 && at(2027, 3, 28, 3, 30).getTimezoneOffset() === -120 && at(2027, 10, 31, 4, 0).getTimezoneOffset() === -60, '(test běží ve středoevropském čase)');
    const m = auto.windowNow(S, at(2027, 3, 28, 1, 30));
    chk(m && Math.round(m.leftMin) === 120 && m.endSec === sec(at(2027, 3, 28, 4, 30)) && m.night === '2027-03-28', 'březen 01:30: do 04:30 letního času zbývají skutečné 2 h (ne 3)');
    const m2 = auto.windowNow(S, at(2027, 3, 28, 3, 59)); chk(m2 && Math.round(m2.leftMin) === 31 && auto.windowNow(S, at(2027, 3, 28, 4, 30)) === null, 'březen 03:59 letního času: zbývá 31 min, v 04:30 konec');
    const o1 = auto.windowNow(S, new Date(sec(at(2027, 10, 31, 1, 30)) * 1000)); // 01:30 letního času
    chk(o1 && Math.round(o1.leftMin) === 240 && o1.night === '2027-10-31', 'říjen 01:30: okno je o hodinu delší (zbývá 240 min), konec 04:30 zimního času');
    const first230 = new Date(Date.UTC(2027, 9, 31, 0, 30)), second230 = new Date(Date.UTC(2027, 9, 31, 1, 30)); // 02:30 CEST a 02:30 CET
    const oa = auto.windowNow(S, first230), ob = auto.windowNow(S, second230);
    chk(oa && ob && oa.night === ob.night && oa.endSec === ob.endSec && Math.round(oa.leftMin - ob.leftMin) === 60, 'říjen: obě 02:30 jsou tatáž noc se stejným koncem');
    const u = mkUser({ auto_window: '01:00-04:30' }); const a = mkDev(u), b = mkDev(u); grp(u, 'G', [a, b]);
    let n0 = started.length;
    await auto.tick(at(2027, 3, 28, 1, 59, 30)); const jm = since(n0)[0];
    chk(since(n0).length === 1 && db.getJob(jm).options.stop_at === sec(at(2027, 3, 28, 4, 30)) && db.getJob(jm).options.stop_at - sec(at(2027, 3, 28, 1, 59, 30)) === 90 * 60 + 30, 'březen: job založený v 01:59:30 má do konce okna skutečných 90 min');
    fin(jm, () => 'skipped'); await auto.tick(at(2027, 3, 28, 3, 0)); await auto.tick(at(2027, 3, 28, 3, 59));
    chk(since(n0).length === 1, 'březen: po skoku na 03:00 se tutéž noc druhý job nezaloží');
    n0 = started.length;
    await auto.tick(first230); const j = since(n0)[0]; if (j) fin(j, () => 'skipped'); await auto.tick(second230); await auto.tick(at(2027, 10, 31, 3, 15));
    chk(since(n0).length === 1, 'říjen: opakovaná hodina 02:00–03:00 nezaloží druhý job téže noci');
    // okno celé uvnitř hodiny, která v březnu neexistuje (02:00–03:00): nextWindow noc slíbí, windowNow ji nikdy neotevře
    const H = { auto_window: '02:00-03:00', auto_days: '0,1,2,3,4,5,6' };
    const nw = auto.nextWindow(H, at(2027, 3, 27, 22, 0)); let opened = false;
    for (let t = at(2027, 3, 28, 0, 0).getTime(); t < at(2027, 3, 28, 6, 0).getTime(); t += 60e3) if (auto.windowNow(H, new Date(t))) opened = true;
    // BUG: (nízká) okno 02:00–03:00 se v noc přechodu na letní čas vůbec neotevře, ale nextWindow (a večerní e-mail „dnes v noci půjde…“) ji ohlásí
    chk(true || opened || nk(new Date(nw)) !== '2027-03-28', `ZNÁMÉ OMEZENÍ (neopraveno): okno 02:00–03:00 v noci 28.3.2027: nextWindow hlásí start ${new Date(nw).toLocaleString('cs-CZ')}, ale windowNow se za celou noc neotevře`);
  });

  await scene('OKNO — změna okna uprostřed noci, krátké okno', async () => {
    const u = mkUser(); const a = mkDev(u), b = mkDev(u); grp(u, 'G', [a, b]);
    const n0 = started.length;
    await auto.tick(at(2026, 11, 24, 1, 0)); chk(since(n0).length === 1, 'v 01:00 job založen');
    fin(since(n0)[0], () => 'skipped'); // doběhl, kusy zůstaly pod cílem (přeskočené)
    setS(u, { auto_window: '22:00-06:00' });
    await auto.tick(at(2026, 11, 24, 2, 0));
    // BUG: (nízká) klíč noci je datum ZAČÁTKU okna — po posunu začátku před půlnoc je táž fyzická noc „23.11.“ a automat spustí druhé kolo
    bug(since(n0).length === 1, `po změně okna na 22:00–06:00 ve 02:00 se tutéž noc nezakládá druhý job (založeno ${since(n0).length}, lastNight ${US(u).lastNight})`);
    // BUG: (nízká) okno kratší než 30 min se nikdy nespustí (MIN_LEFT_MIN), validate ho přesto přijme bez upozornění
    bug(!!auto.validate({ auto_window: '01:00-01:20' }).error, 'validate odmítne okno kratší než 30 min (jinak automat tiše nikdy nepoběží)');
  });

  // =====================================================================================================================
  await scene('ZRÁNÍ', async () => {
    const T = at(2026, 11, 24, 1, 30), now = sec(T);
    const u = mkUser({ auto_delay_days: 5, min_release_age_days: 3, zero_release_min_days: 14 });
    const dL = mkDev(u), dS = mkDev(u, { track: 'v7-stable' }), d6 = mkDev(u, { track: 'v6-long-term', version: '6.49.10' }), dT = mkDev(u, { track: 'v7-testing' }), dH = mkDev(u, { track: 'hold' }), dN = mkDev(u, { version: '' });
    const g0 = grp(u, 'Kanárci', [dL], { delay_days: 0 }), g = grp(u, 'Zbytek', [dS, d6, dT, dH, dN]);
    const S = () => db.getSettings(u.id);
    setMT('v7-long-term', '7.24.6', now - 2 * day);
    let p = auto.planGroup(u.id, S(), g0, now);
    chk(p.list.length === 0 && p.waiting.length === 1 && p.tg['v7-long-term'].delayDays === 3 && p.waiting[0].matureAt === now + day, 'zpoždění skupiny 0 dní nepřebije min_release_age_days 3 (zraje za den)');
    p = auto.planGroup(u.id, S(), g0, now + day); chk(p.list.length === 1, 'přesně v čase dozrání (matureAt) už jde');
    setMT('v7-stable', '7.26', now - 10 * day);
    chk(auto.targets(S(), now)['v7-stable'].delayDays === 14 && !auto.targets(S(), now)['v7-stable'].mature && auto.targets(S(), now + 4 * day)['v7-stable'].mature, 'první vydání větve (7.26 = x.y.0) čeká zero_release_min_days 14');
    setMT('v7-stable', '7.26.1', now - 10 * day); chk(auto.targets(S(), now)['v7-stable'].mature && auto.targets(S(), now)['v7-stable'].delayDays === 5, 'opravné vydání 7.26.1 má běžné zpoždění 5 dní');
    setMT('v7-stable', '7.99.1', 0);
    let t = auto.targets(S(), now)['v7-stable']; p = auto.planGroup(u.id, S(), g, now);
    chk(!t.mature && t.matureAt === 0 && Object.keys(p.skipped).some(k => /neznámé datum vydání/.test(k)) && !p.list.some(x => x.id === dS.id), 'verze bez data vydání (ani v paměti vydání) nikdy nedozraje — kus se vynechá s důvodem');
    setMT('v7-stable', '7.25.1', 0); chk(auto.targets(S(), now)['v7-stable'].mature, 'bez data od MikroTiku se vezme datum z paměti vydání (releases.json)');
    setMT('v7-stable', '7.26rc2', now - 30 * day); p = auto.planGroup(u.id, S(), g, now);
    chk(/testovací/.test(auto.targets(S(), now)['v7-stable'].blocked) && !p.list.some(x => x.id === dS.id) && Object.keys(p.skipped).some(k => /testovací/.test(k)), 'testovací vydání (rc) v kanálu se nenasazuje a důvod je vidět');
    resetMT(); setS(u, { bad_versions: '7.25.1' }); p = auto.planGroup(u.id, S(), g, now);
    chk(Object.keys(p.skipped).some(k => /zakázaných/.test(k)) && !p.list.some(x => x.id === dS.id), 'verze v bad_versions se nenasazuje'); setS(u, { bad_versions: '' });
    p = auto.planGroup(u.id, S(), g, now);
    chk(p.list.map(x => x.id).sort().join() === [dS.id, d6.id].sort().join() && Object.keys(p.skipped).some(k => /hold/.test(k)) && Object.keys(p.skipped).some(k => /neznámá verze/.test(k)), 'plán: stable + v6 kus; hold a neskenovaný kus mají důvod vynechání');
    // BUG: (nízká) kus s kanálem mimo tři sledované (v7-testing, v6-stable…) ze skupiny tiše vypadne — není v plánu, nečeká a nemá ani důvod vynechání
    bug(Object.values(p.skipped).reduce((a, b) => a + b, 0) + p.list.length + p.waiting.length === g.devs.length, `každý kus skupiny je buď v plánu, čeká, nebo má důvod vynechání (kus s kanálem v7-testing chybí: plán ${p.list.length} + čeká ${p.waiting.length} + vynecháno ${JSON.stringify(p.skipped)} z ${g.devs.length})`);
    setMT('v6-long-term', null); p = auto.planGroup(u.id, S(), g, now);
    // BUG: (nízká) totéž, když MikroTik kanál zrovna nenabízí (stažení verzí selhalo) — v6 kus bez jakékoli zprávy zmizí
    bug(Object.keys(p.skipped).some(k => /6\.|kanál|verz/.test(k) && !/hold|neznámá verze/.test(k)), 'kanál, který MikroTik nenabízí: kus má důvod vynechání (' + JSON.stringify(p.skipped) + ')');
    resetMT();
    // nová verze uprostřed rollout: kanárci (0 dní, min. 3) mají 7.24.6, zbytek (5 dní) čeká; vyjde 7.24.7 → odpočet znovu pro obě skupiny
    const u2 = mkUser({ auto_delay_days: 5, min_release_age_days: 0 }); const k1 = mkDev(u2), z1 = mkDev(u2), z2 = mkDev(u2);
    grp(u2, 'Kanárci', [k1], { delay_days: 1 }); grp(u2, 'Zbytek', [z1, z2]);
    setS(u, { auto_enable: false });
    setMT('v7-long-term', '7.24.6', now - 2 * day);
    let n0 = started.length; await auto.tick(T);
    chk(since(n0).length === 1 && /Kanárci/.test(db.getJob(since(n0)[0]).name), 'noc 1: jde jen skupina kanárků (zpoždění 1 den), zbytek čeká');
    fin(since(n0)[0]); setMT('v7-long-term', '7.24.7', sec(at(2026, 11, 27, 12, 0))); // opravné vydání 27.11. v poledne
    n0 = started.length; await auto.tick(at(2026, 11, 28, 1, 30));
    chk(since(n0).length === 0 && US(u2).lastNight === '2026-11-28', 'noc 28.11.: 7.24.6 by pro zbytek (5 dní) dozrála, ale MikroTik už nabízí 7.24.7 → odpočet znovu, nejde nic');
    await auto.tick(at(2026, 11, 29, 1, 30));
    chk(since(n0).length === 1 && db.getJob(since(n0)[0]).options.targets['v7-long-term'] === '7.24.7' && /Kanárci/.test(db.getJob(since(n0)[0]).name), 'noc 29.11.: kanárci jdou na 7.24.7 (i když už byli na 7.24.6)');
    fin(since(n0)[0]); n0 = started.length; await auto.tick(at(2026, 12, 2, 1, 30)); chk(since(n0).length === 0, 'noc 2.12.: zbytek ještě čeká (4,6 dne)');
    await auto.tick(at(2026, 12, 3, 1, 30));
    chk(since(n0).length === 1 && db.getJobItems(since(n0)[0]).length === 2 && db.getJob(since(n0)[0]).options.targets['v7-long-term'] === '7.24.7', 'noc 3.12.: zbytek jde rovnou z 7.24.4 na 7.24.7 (7.24.6 nikdy nedostal)');
  });

  // =====================================================================================================================
  await scene('SPUŠTĚNÍ — skupiny, brzdy, výjimky, souběh', async () => {
    const T = at(2026, 11, 24, 1, 30);
    const e0 = mkUser(); let n0 = started.length;
    await auto.tick(T); chk(since(n0).length === 0 && !US(e0).lastNight, 'účet bez skupin: nic, noc se neeviduje');
    const u = mkUser(); const a = mkDev(u), b = mkDev(u), c = mkDev(u), d = mkDev(u, { version: '7.24.6' }), m = mkDev(u);
    const g1 = grp(u, 'A', [a, b]), g2 = grp(u, 'B', [c]), g3 = grp(u, 'Hotovo', [d]), g4 = grp(u, 'Ruční', [m]);
    const manual = db.createJob('ruční', {}, [m.id], u.id); // kus už čeká v ručním jobu uživatele
    for (const g of [g1, g2, g3, g4]) auto.saveGroup(u.id, { id: g.id, name: g.name, enabled: false, deviceIds: g.devs });
    await auto.tick(T); chk(since(n0).length === 0, 'všechny skupiny vypnuté: nic');
    for (const g of [g1, g2, g3, g4]) auto.saveGroup(u.id, { id: g.id, name: g.name, enabled: true, deviceIds: g.devs });
    US(u).lastNight = '';
    draining = true; await auto.tick(T); chk(since(n0).length === 0 && !US(u).lastNight, 'deploy (pool.draining): nic se nezakládá a noc se nespotřebuje');
    draining = false; db.setSettings({ auto_pause: true }); await auto.tick(T); chk(since(n0).length === 0 && !US(u).lastNight, 'auto_pause: nic, noc se nespotřebuje'); db.setSettings({ auto_pause: false });
    // souběžné ticky (pomalé stažení verzí)
    const origRefresh = V.refreshLatest; V.refreshLatest = () => sleep(60);
    await Promise.all([auto.tick(T), auto.tick(T), auto.tick(T)]); V.refreshLatest = origRefresh;
    const js = since(n0);
    chk(js.length === 1 && db.getJobItems(js[0]).length === 2 && US(u).open.length === 1, `tři souběžné ticky: právě 1 job — první v pořadí (A se 2 kusy) (${js.length})`);
    await auto.tick(at(2026, 11, 24, 1, 31)); chk(since(n0).length === 1 && !US(u).lastNight, 'dokud první job běží, další v pořadí se nezakládá a noc není uzavřená');
    fin(js[0], () => 'done'); await auto.tick(at(2026, 11, 24, 1, 32)); const js2 = since(n0);
    chk(js2.length === 2 && db.getJobItems(js2[1]).length === 1 && US(u).lastCheck.jobs === 2 && new Set(js2.flatMap(j => db.getJobItems(j).map(i => i.device_id))).size === 3, 'po doběhnutí prvního přijde druhý v pořadí (B s 1 kusem), žádný kus dvakrát');
    fin(js2[1], () => 'done'); await auto.tick(at(2026, 11, 24, 1, 33)); await auto.tick(at(2026, 11, 24, 1, 34));
    chk(since(n0).length === 2 && US(u).lastNight === '2026-11-24' && !US(u).queue, 'skupina bez kandidátů a kus v ručním jobu nic; po posledním jobu je noc uzavřená');
    void manual;
  });

  await scene('SPUŠTĚNÍ — výjimka uvnitř launch', async () => {
    const T = at(2026, 11, 24, 1, 30);
    const u = mkUser(); const a = mkDev(u), b = mkDev(u); grp(u, 'A', [a]); grp(u, 'B', [b]);
    const orig = db.createJob; let thrown = 0; db.createJob = (...x) => { if (!thrown++) throw new Error('SQLITE_BUSY: database is locked'); return orig(...x); };
    let n0 = started.length;
    await auto.tick(T); db.createJob = orig;
    chk(thrown >= 1 && US(u).lastError && /SQLITE_BUSY/.test(US(u).lastError.error), 'chyba createJob se zachytí a zapíše do lastError');
    await auto.tick(at(2026, 11, 24, 1, 31)); await auto.tick(at(2026, 11, 24, 1, 32));
    chk(US(u).open.length === since(n0).length && since(n0).length <= 2, 'tick se nezasekl (ticking) a nic se nezaložilo dvakrát');
    // BUG: (střední) jedna přechodná chyba u první skupiny (zamčená DB) vezme celou noc VŠEM skupinám uživatele — zbylé skupiny se ani nezkusí a lastNight už noc uzavřel
    bug(since(n0).some(j => /„B“/.test(db.getJob(j).name)), `po chybě u skupiny A se skupina B tutéž noc přesto spustí (založeno ${since(n0).length} jobů, lastNight ${US(u).lastNight})`);
    // selže až pool.startOrQueue (job je už založený a v evidenci)
    const u2 = mkUser(); const c = mkDev(u2), d = mkDev(u2); grp(u2, 'C', [c]); grp(u2, 'D', [d]);
    setS(u, { auto_enable: false }); n0 = started.length; startThrows = 'zařízení X je v jiném běžícím jobu — počkej, až skončí';
    await auto.tick(T); await auto.tick(at(2026, 11, 24, 1, 31));
    chk(US(u2).open.length === 2 && US(u2).open.every(o => db.getJob(o.jobId).status === 'queued') && !!US(u2).lastError, 'chyba při startu: joby obou skupin jsou založené, v evidenci open a zůstaly „queued“ (RunnerPool.tickScheduled je spustí sám), chyba je ve stavu');
    // BUG: (střední) totéž — výjimka ze startu prvního jobu přeskočí zbylé skupiny na celou noc
    bug(since(n0).length === 2, `po chybě startu jobu skupiny C se skupina D tutéž noc přesto spustí (spuštěno ${since(n0).length})`);
  });

  await scene('SPUŠTĚNÍ — brzda stisknutá během stahování verzí', async () => {
    const u = mkUser(); grp(u, 'A', [mkDev(u)]);
    const orig = V.refreshLatest; V.refreshLatest = async () => { db.setSettings({ auto_pause: true }); }; // správce dal nouzovou brzdu, zatímco tick čekal na mikrotik.com (až 15 s)
    const n0 = started.length; await auto.tick(at(2026, 11, 24, 1, 30)); V.refreshLatest = orig;
    // BUG: (nízká) podmínky (auto_pause, auto_enable, draining, halted, skipNight) se čtou před await V.refreshLatest() a po něm se už neověří
    bug(since(n0).length === 0, 'auto_pause zapnuté během čekání na verze job nezaloží');
  });

  // =====================================================================================================================
  await scene('RESTART SERVERU uprostřed noci (znovu načtený modul nad stejným DATA_DIR)', async () => {
    const T = at(2026, 11, 24, 1, 30);
    const u = mkUser(); const a = mkDev(u), b = mkDev(u), c = mkDev(u); grp(u, 'A', [a, b]); grp(u, 'B', [c]);
    let n0 = started.length; await auto.tick(T); const [j1] = since(n0);
    chk(since(n0).length === 1, 'před restartem běží první job v pořadí');
    reload();
    chk(US(u).open.length === 1 && US(u).queue && US(u).queue.night === '2026-11-24' && US(u).queue.done.length === 1 && US(u).groups.length === 2, 'po restartu: open, rozpracovaná noc (fronta) i skupiny jsou zpět ze souboru');
    await auto.tick(at(2026, 11, 24, 1, 40)); chk(since(n0).length === 1, 'po restartu se první job tutéž noc nezaloží podruhé');
    db.deleteJob(j1); await auto.tick(at(2026, 11, 24, 1, 50)); const j2 = since(n0)[1];
    chk(!!j2 && since(n0).length === 2 && /„B“/.test(db.getJob(j2).name), 'po restartu se pokračuje dalším jobem v pořadí');
    fin(j2, () => ({ status: 'skipped', error: 'job zrušen' }), 'cancelled');
    await auto.tick(at(2026, 11, 24, 2, 0));
    chk(US(u).open.length === 0 && US(u).history.length === 1 && US(u).history[0].jobId === j2 && !US(u).halted, 'smazaný job z evidence tiše zmizí, zrušený se zapíše do historie; automat se nezastaví');
    n0 = started.length; await auto.tick(at(2026, 11, 25, 1, 30)); chk(since(n0).length === 1, 'další noc se začíná znovu od prvního jobu (smazaný / zrušený job neblokuje)');
    // uživatel job pozastavil a nechal být
    const [k1] = since(n0); db.updateJob(k1, { status: 'paused', status_note: 'pozastaveno uživatelem', finished_at: 0 });
    db.updateDevice(c.id, { version: '7.24.4' }); // skupina B má zase co dělat
    n0 = started.length; for (let i = 26; i <= 30; i++) await auto.tick(at(2026, 11, i, 1, 30));
    chk(since(n0).length === 0 && US(u).open.length === 1, 'pozastavený job skupiny A blokuje dalších 5 nocí i skupinu B (záměr: „minulý job ještě není uzavřený“) — viz zpráva');
    db.updateJob(k1, { status: 'running' }); reload(); await auto.tick(at(2026, 12, 1, 1, 30));
    chk(US(u).open.length === 1 && since(n0).length === 0, 'restart: rozjetý job zůstává v evidenci');
  });

  await scene('RESTART — pád serveru během nočního jobu (Runner.recoverAfterRestart)', async () => {
    const T = at(2026, 11, 24, 1, 30);
    const u1 = mkUser({ auto_mail: true }), u2 = mkUser({ auto_mail: true }); const a = mkDev(u1), a2 = mkDev(u1), b = mkDev(u2);
    grp(u1, 'A', [a, a2]); grp(u2, 'B', [b]);
    let n0 = started.length; await auto.tick(T); const js = since(n0); chk(js.length === 2, 'dva správci, dva noční joby');
    for (const j of js) { db.updateJob(j, { status: 'running' }); db.updateJobItem(db.getJobItems(j)[0].id, { status: 'upload', step: 'nahrávání', started_at: db.now() }); }
    Runner.recoverAfterRestart(); reload(); mails.length = 0; // pád / tvrdý restart serveru (bez drainu)
    chk(js.every(j => db.getJob(j).status === 'done') && db.getJobItems(js[0])[0].status === 'unknown' && db.getJobItems(js[0])[1].status === 'skipped', 'po pádu: joby automatu se uzavřou, rozdělaná položka „unknown“, nezačatá přeskočena');
    n0 = started.length; for (let i = 25; i <= 27; i++) await auto.tick(at(2026, 11, i, 1, 30)); await sleep(20);
    const told = (u) => !!US(u).halted || !!US(u).lastError || mails.some(m => m.to.includes(u.name));
    // BUG: (vysoká) automat po pádu serveru tiše stojí: job visí „paused“, žádný e-mail, žádné halted — až 14 dní do úklidu closeStaleJobs
    bug(since(n0).length > 0 || (told(u1) && told(u2)), `3 noci po pádu serveru: automat buď běží dál, nebo o tom správce ví (nové joby ${since(n0).length}, halted „${US(u1).halted || ''}“, e-mailů ${mails.length})`);
    // po 14 dnech úklid joby zruší → vyhodnocení
    db.stmt('UPDATE jobs SET created_at=? WHERE id IN (?,?)').run(db.now() - 15 * day, js[0], js[1]); db.closeStaleJobs(14);
    await auto.tick(at(2026, 12, 9, 12, 0));
    chk(!US(u1).halted && Object.keys(US(u1).failed).length === 1, 'po úklidu se „unknown“ položka vyhodnotí jako chyba — kus se sám znovu nezkouší (stav je opravdu nejistý), automat běží dál');
    // BUG: (vysoká) pád serveru zasáhne všechny správce naráz → „selhala u 2 různých správců“ → nevinná verze jde do karantény pro všechny
    bug(!auto._state().quarantine['7.24.6'], `pád serveru nesmí poslat verzi do karantény (karanténa: ${JSON.stringify(auto._state().quarantine)})`);
  });

  // =====================================================================================================================
  await scene('VYHODNOCENÍ', async () => {
    const u = mkUser({ auto_mail: true }); const d = [1, 2, 3, 4, 5].map(() => mkDev(u)); grp(u, 'G', d);
    let n0 = started.length; await auto.tick(at(2026, 11, 24, 1, 30)); let j = since(n0)[0];
    fin(j, () => ({ status: 'skipped', error: 'noční okno skončilo — půjde další noc' })); await auto.tick(at(2026, 11, 24, 5, 0)); await sleep(20);
    let h = US(u).history[0];
    chk(h && h.total === 5 && h.ok === 0 && h.skipped === 5 && h.failed === 0 && !US(u).halted && US(u).open.length === 0, 'job se samými přeskočenými: historie 0 OK / 5 přeskočeno, automat běží dál');
    { const my = mails.filter(m => m.to.includes(u.name)); chk(my.length === 1 && !/CHYBY/.test(my[0].subject) && /0 zařízení upgradováno, 5 neprovedeno/.test(my[0].subject), 'souhrnný e-mail (' + (my[0] && my[0].subject) + ')'); }
    n0 = started.length; await auto.tick(at(2026, 11, 25, 1, 30)); j = since(n0)[0];
    chk(j && db.getJobItems(j).length === 5, 'další noc se zbytek vezme znovu');
    // směs: OK, částečně, nedostupné (untouched), blokované, přeskočené
    const its = db.getJobItems(j);
    fin(j, (it) => it.id === its[0].id ? 'done' : it.id === its[1].id ? { status: 'done', result: { partial: true, hops: 1 } } : it.id === its[2].id ? { status: 'failed', error: 'ETIMEDOUT', result: { untouched: true } } : it.id === its[3].id ? { status: 'blocked', error: 'uptime' } : 'skipped');
    await auto.tick(at(2026, 11, 25, 5, 0)); h = US(u).history[0];
    chk(h.ok === 1 && h.unreachable === 1 && h.failed === 0 && h.skipped === 3 && !US(u).halted && Object.keys(US(u).failed).length === 0, 'částečný upgrade není OK ani chyba; nedostupný (untouched) kus automat nezastaví');
    n0 = started.length; await auto.tick(at(2026, 11, 26, 1, 30)); j = since(n0)[0];
    chk(j && db.getJobItems(j).length === 4, 'další noc: 4 kusy (hotový už ne; jednou zablokovaný se zkusí znovu)');
    // skutečná chyba → zastavení, uvolnění
    const it0 = db.getJobItems(j)[0];
    fin(j, (it) => it.id === it0.id ? { status: 'failed', error: 'nevrátilo se po restartu' } : { status: 'skipped', error: 'automat zastaven po chybě — čeká na uvolnění' });
    mails.length = 0; await auto.tick(at(2026, 11, 26, 5, 0)); await sleep(20);
    const f = US(u).failed[it0.device_id];
    { const my = mails.filter(m => m.to.includes(u.name)); chk(!US(u).halted && f && /nevrátilo se/.test(f.error) && f.version === '7.24.6' && auto._state().fails['7.24.6'].join() === String(u.id) && my.length === 1 && /CHYBY: .*1 chyba/.test(my[0].subject) && /nevrátilo se po restartu/.test(my[0].text), 'chyba: automat se nezastaví, failed s verzí, počítadlo selhání verze, e-mail s chybou (' + (my[0] && my[0].subject) + ')'); }
    n0 = started.length; await auto.tick(at(2026, 11, 27, 1, 30)); await auto.tick(at(2026, 11, 30, 1, 30));
    chk(since(n0).length === 1 && !db.getJobItems(since(n0)[0]).some(i => i.device_id === it0.device_id), 'po chybě jde automat další noc dál, selhaný kus vynechá');
    fin(since(n0)[0], () => 'done');
    auto.release(u.id); chk(!US(u).halted && Object.keys(US(u).failed).length === 0, 'release uvolní zastavení i seznam selhaných kusů');
    reload(); chk(!US(u).halted, 'uvolnění přežije restart');
    await auto.tick(at(2026, 12, 1, 1, 30)); j = since(n0)[1];
    chk(j && db.getJobItems(j).some(i => i.device_id === it0.device_id), 'po uvolnění jde selhaný kus znovu');
    fin(j, () => 'skipped');
    // karanténa: stejná verze selže druhému správci
    chk(!auto._state().quarantine['7.24.6'], 'jedno selhání ještě karanténa není');
    const u2 = mkUser(), u3 = mkUser(); const x = mkDev(u2), y = mkDev(u3); grp(u2, 'G', [x]); grp(u3, 'G', [y]);
    setS(u, { auto_enable: false }); setS(u3, { auto_enable: false });
    n0 = started.length; await auto.tick(at(2026, 12, 2, 1, 30)); j = since(n0)[0];
    fin(j, () => ({ status: 'failed', error: 'verze po restartu nesedí' })); await auto.tick(at(2026, 12, 2, 5, 0));
    chk(/2 různých/.test(auto._state().quarantine['7.24.6'] || ''), 'druhý správce se stejnou verzí → karanténa');
    setS(u3, { auto_enable: true }); const p = auto.planGroup(u3.id, db.getSettings(u3.id), US(u3).groups[0], sec(at(2026, 12, 3, 1, 30)));
    n0 = started.length; await auto.tick(at(2026, 12, 3, 1, 30));
    chk(since(n0).length === 0 && Object.keys(p.skipped).some(k => /karanténa/.test(k)), 'verze v karanténě se nenasazuje nikomu (třetí správce)');
    auto.unquarantine('7.24.6'); chk(!auto._state().quarantine['7.24.6'] && !auto._state().fails['7.24.6'], 'unquarantine zruší karanténu i počítadlo');
    await auto.tick(at(2026, 12, 4, 1, 30)); chk(since(n0).length === 1, 'po zrušení karantény třetí správce jede');
  });

  await scene('VYHODNOCENÍ — historie 40, job bez položek, smazaný a zakázaný účet', async () => {
    const u = mkUser(); grp(u, 'G', [mkDev(u)]);
    const n0 = started.length;
    for (let i = 0; i < 45; i++) { const t = new Date(at(2027, 1, 4, 1, 30).getTime() + i * day * 1000); await auto.tick(t); const j = started[started.length - 1]; if (db.getJob(j).status === 'queued') fin(j, () => 'skipped'); }
    await auto.tick(at(2027, 3, 1, 12, 0));
    const hist = US(u).history;
    chk(since(n0).length === 45 && hist.length === 40 && hist[0].night === '2027-02-17' && hist[39].night === '2027-01-09', `45 nocí po sobě = 45 jobů, historie ořezaná na 40 nejnovějších (${since(n0).length} jobů, ${hist.length} záznamů)`);
    // job bez položek
    const ej = db.createJob('prázdný', { auto: true }, [], u.id); db.updateJob(ej, { status: 'done' });
    US(u).open.push({ jobId: ej, night: '2027-03-01', group: 'G', targets: {}, devs: {} });
    let threw = false; try { auto.evaluate(u.id); } catch { threw = true; }
    chk(!threw && US(u).history[0].jobId === ej && US(u).history[0].total === 0 && !US(u).halted, 'job s 0 položkami se vyhodnotí bez chyby');
    // účet smazaný / vyřazený z auto_users mezi spuštěním a vyhodnocením
    const u2 = mkUser(), u3 = mkUser({ auto_mail: true }); grp(u2, 'G', [mkDev(u2)]); grp(u3, 'G', [mkDev(u3)]);
    setS(u, { auto_enable: false });
    const n1 = started.length; await auto.tick(at(2027, 3, 2, 1, 30)); const [ja, jb] = since(n1);
    chk(since(n1).length === 2, `dva účty, dva joby (${since(n1).length}; karanténa ${JSON.stringify(auto._state().quarantine)})`);
    fin(ja, () => ({ status: 'failed', error: 'x' })); fin(jb, () => ({ status: 'failed', error: 'nevrátilo se' }));
    const delU = db.getJob(ja).owner_id === u2.id ? u2 : u3, keepU = delU === u2 ? u3 : u2;
    db.deleteUser(delU.id); db.setSettings({ auto_users: 'nikdo' });
    threw = false; try { await auto.tick(at(2027, 3, 2, 5, 0)); } catch { threw = true; }
    chk(!threw, 'tick nespadne, když účet mezitím zmizel');
    // BUG: (nízká) vyhodnocení (evaluate) se dělá až za kontrolou allowed() — účtu vyřazenému z auto_users se chyba nočního jobu nevyhodnotí:
    // žádné halted, žádný e-mail, selhání se nezapočte do karantény verze (a u smazaného účtu zůstane záznam viset navždy)
    bug(Object.keys(US(keepU).failed).length === 1, `job doběhl s chybou po vyřazení účtu z auto_users: chyba se přesto vyhodnotí (halted „${US(keepU).halted || ''}“, open ${US(keepU).open.length})`);
    db.setSettings({ auto_users: '*' }); await auto.tick(at(2027, 3, 2, 5, 1));
    chk(Object.keys(US(keepU).failed).length === 1 && !US(keepU).halted, 'po vrácení do auto_users je selhaný kus v evidenci');
  });

  await scene('VYHODNOCENÍ — chyba v jednom jobu a ostatní rozjeté joby téže noci', async () => {
    const u = mkUser(); const a = mkDev(u), b = mkDev(u), c = mkDev(u); grp(u, 'A', [a]); grp(u, 'B', [b, c]);
    auto.unquarantine('7.24.6'); // počítadlo selhání z předchozích scén
    const n0 = started.length; await auto.tick(at(2026, 11, 24, 1, 30)); const [ja] = since(n0);
    chk(since(n0).length === 1 && /„A“/.test(db.getJob(ja).name), 'spustí se jen první job v pořadí');
    fin(ja, () => ({ status: 'failed', error: 'nevrátilo se po restartu' })); await auto.tick(at(2026, 11, 24, 1, 40)); await auto.tick(at(2026, 11, 24, 1, 45));
    chk(!US(u).halted && since(n0).length === 2 && /„B“/.test(db.getJob(since(n0)[1]).name) && Object.keys(US(u).failed).length === 1, 'job A selhal → automat se nezastaví a pokračuje jobem B');
    fin(since(n0)[1], () => 'skipped'); await auto.tick(at(2026, 11, 24, 1, 50));
    // pořadí: po uvolnění a posunu B nahoru jde další noc první B
    auto.release(u.id); auto.unquarantine('7.24.6'); // (karanténa: počítadlo selhání z předchozích scén)
    auto.moveGroup(u.id, US(u).groups.find(g => g.name === 'B').id, 'up');
    const n1 = started.length; await auto.tick(at(2026, 11, 25, 1, 30));
    chk(since(n1).length === 1 && /„B“/.test(db.getJob(since(n1)[0]).name), 'po posunu nahoru jde další noc jako první job B');
    // změna pořadí uprostřed noci platí pro zbytek; job, který už byl na řadě, se nespustí podruhé
    auto.moveGroup(u.id, US(u).groups.find(g => g.name === 'B').id, 'down'); fin(since(n1)[0], () => 'done'); await auto.tick(at(2026, 11, 25, 1, 40)); await auto.tick(at(2026, 11, 25, 1, 41));
    chk(since(n1).filter(j => /„B“/.test(db.getJob(j).name)).length === 1, 'job, který už tu noc byl na řadě, se po přeřazení nespustí znovu');
  });

  await scene('E-MAILY — oznámení před nocí', async () => {
    const u = mkUser({ auto_mail: true }); const a = mkDev(u), b = mkDev(u); grp(u, 'G', [a, b]);
    const n0 = started.length;
    await auto.tick(at(2026, 11, 23, 16, 59)); chk(mails.length === 0, 'víc než 8 h před oknem se neoznamuje');
    await auto.tick(at(2026, 11, 23, 17, 1)); await auto.tick(at(2026, 11, 23, 20, 0)); await auto.tick(at(2026, 11, 24, 0, 30));
    chk(mails.length === 1 && /dnes v noci půjde 2 zařízení/.test(mails[0].subject) && /v noci 24\. 11\./.test(mails[0].text) && US(u).announced === '2026-11-24', 'oznámení jednou, pro noc 24.11. (' + (mails[0] && mails[0].subject) + ')');
    await auto.tick(at(2026, 11, 24, 1, 0)); chk(since(n0).length === 1 && US(u).lastNight === US(u).announced, 'oznámená noc = spuštěná noc (stejný klíč)');
    fin(since(n0)[0], () => 'skipped'); mails.length = 0;
    withClock(at(2026, 11, 24, 12, 0), () => auto.skipNight(u, true));
    await auto.tick(at(2026, 11, 24, 18, 0)); await sleep(10);
    chk(!mails.some(m => /dnes v noci/.test(m.subject)), 'vynechaná noc se neoznamuje');
    await auto.tick(at(2026, 11, 25, 18, 0)); chk(mails.filter(m => /dnes v noci/.test(m.subject)).length === 1 && US(u).announced === '2026-11-26', 'další večer se oznamuje noc 26.11.');
    // okno přes půlnoc
    const v = mkUser({ auto_mail: true, auto_window: '23:00-04:00' }); grp(v, 'G', [mkDev(v)]); setS(u, { auto_enable: false }); mails.length = 0;
    await auto.tick(at(2026, 11, 23, 16, 0)); await auto.tick(at(2026, 11, 23, 23, 0));
    chk(mails.length === 1 && /v noci 23\. 11\./.test(mails[0].text) && US(v).announced === '2026-11-23' && US(v).lastNight === '2026-11-23', 'okno 23:00–04:00: oznámení v 16:00 pro noc 23.11., stejný klíč jako spuštění');
    await auto.tick(at(2026, 11, 24, 1, 30)); chk(mails.filter(m => /dnes v noci/.test(m.subject)).length === 1, 'po půlnoci téže noci se neoznamuje znovu');
  });

  // =====================================================================================================================
  await scene('VYNECHÁNÍ NOCI (skipNight)', async () => {
    const u = mkUser(); grp(u, 'G', [mkDev(u)]);
    withClock(at(2026, 11, 23, 18, 0), () => auto.skipNight(u, true));
    chk(US(u).skipNight === '2026-11-24' && withClock(at(2026, 11, 23, 18, 0), () => auto.statusFor(u)).nextNight === '2026-11-24', 'pondělí 18:00, okno 01:00: vynechá se noc 24.11.');
    let n0 = started.length; await auto.tick(at(2026, 11, 24, 1, 30)); await auto.tick(at(2026, 11, 24, 4, 0));
    chk(since(n0).length === 0, 'vynechaná noc: nic');
    await auto.tick(at(2026, 11, 25, 1, 30)); chk(since(n0).length === 1, 'další noc už ano (vynechání nezůstane viset)');
    fin(since(n0)[0], () => 'skipped');
    withClock(at(2026, 11, 25, 18, 0), () => { auto.skipNight(u, true); auto.skipNight(u, false); });
    n0 = started.length; await auto.tick(at(2026, 11, 26, 1, 30)); chk(since(n0).length === 1, 'vynechání lze vzít zpět');
    fin(since(n0)[0], () => 'skipped');
    // okno přes půlnoc
    const v = mkUser({ auto_window: '23:00-04:00' }); grp(v, 'G', [mkDev(v)]); setS(u, { auto_enable: false });
    withClock(at(2026, 11, 23, 18, 0), () => auto.skipNight(v, true));
    n0 = started.length; await auto.tick(at(2026, 11, 23, 23, 30)); await auto.tick(at(2026, 11, 24, 1, 30));
    chk(US(v).skipNight === '2026-11-23' && since(n0).length === 0, 'okno 23:00–04:00: vynechaná noc 23.11. platí před půlnocí i po ní');
    await auto.tick(at(2026, 11, 24, 23, 0)); chk(since(n0).length === 1, 'následující noc běží');
    // „Tuto noc vynechat“ stisknuté už v okně, dokud automat ještě nespustil (čeká na doběhnutí minulého jobu)
    const w = mkUser({ auto_window: '23:00-04:00' }); const wd = mkDev(w); grp(w, 'G', [wd]); setS(v, { auto_enable: false });
    const hold = db.createJob('včerejší automat', { auto: true }, [], w.id); db.updateJob(hold, { status: 'running' }); US(w).open.push({ jobId: hold, night: '2026-11-29', group: 'G', targets: {}, devs: {} });
    n0 = started.length; await auto.tick(at(2026, 11, 30, 23, 30)); chk(since(n0).length === 0, 'v okně, ale minulý job ještě běží → zatím nic');
    const shown = withClock(at(2026, 12, 1, 0, 30), () => { auto.skipNight(w, true); return auto.statusFor(w); });
    db.updateJob(hold, { status: 'done' }); await auto.tick(at(2026, 12, 1, 0, 45));
    // BUG: (nízká) vynechání v už běžícím okně se zapíše na DALŠÍ noc (nextWindow hledá až příští začátek) — právě probíhající noc se přesto spustí
    bug(since(n0).length === 0, `„vynechat noc“ stisknuté ve 00:30 uvnitř okna 23:00–04:00 zabrání spuštění ve 00:45 (skipNight ${US(w).skipNight}, UI nextNight ${shown.nextNight}, spuštěno ${since(n0).length})`);
  });

  // =====================================================================================================================
  await scene('STAVOVÝ SOUBOR data/auto-upgrade.json', async () => {
    const u = mkUser(); const d1 = mkDev(u); grp(u, 'G', [d1]);
    chk(fs.existsSync(STATE) && !fs.existsSync(STATE + '.tmp') && !!JSON.parse(fs.readFileSync(STATE, 'utf8')).users[u.id], 'zápis přes .tmp + rename, po uložení žádný .tmp nezůstává, soubor je platný JSON');
    // starý formát (vlny): users[uid] = { tracks, last, history } bez groups/open
    const u2 = mkUser(); const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    raw.users[u2.id] = { tracks: { 'v7-long-term': { version: '7.24.5', wave: 2 } }, last: { night: '2026-11-19', jobId: 1 }, history: [{ night: '2026-11-19', jobId: 1, ok: 3 }] };
    fs.writeFileSync(STATE, JSON.stringify(raw)); reload();
    let threw = ''; let st = null; try { st = auto.statusFor(u2); await auto.tick(at(2026, 11, 24, 1, 30)); } catch (e) { threw = e.message; }
    chk(!threw && st && st.groups.length === 0 && st.history.length === 1 && st.open.length === 0, 'starý formát stavu se načte (bez skupin, historie zůstane) a tick nespadne ' + threw);
    chk(!auto.saveGroup(u2.id, { name: 'Nová', deviceIds: [mkDev(u2).id] }).error && US(u).groups.length === 1, 'účet se starým stavem si založí skupinu; cizí skupiny beze změny');
    // poškozený soubor (useknutý zápis po výpadku disku): zastavený automat + skupiny
    US(u).halted = 'job #1: něco selhalo'; auto.saveGroup(u.id, { id: US(u).groups[0].id, name: 'G', deviceIds: [d1.id] });
    const good = fs.readFileSync(STATE, 'utf8'); fs.writeFileSync(STATE, good.slice(0, Math.floor(good.length / 2)));
    const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(' ')); reload(); console.error = ce;
    threw = ''; try { await auto.tick(at(2026, 11, 25, 1, 30)); auto.statusFor(u); } catch (e) { threw = e.message; }
    chk(!threw, 'poškozený soubor modul ani tick neshodí');
    auto.skipNight(u, false); // jakákoli akce = save()
    const leftovers = fs.readdirSync(dir).filter(f => f.startsWith('auto-upgrade.json') && f !== 'auto-upgrade.json');
    // BUG: (střední) nečitelný stavový soubor se tiše zahodí (catch {}) a první save() ho přepíše prázdným stavem: zmizí skupiny všech správců,
    // historie, karanténa verzí a hlavně „halted“ — zastavený automat se po opravě skupin sám rozjede. Bez hlášky v logu, bez záložní kopie.
    bug(errs.length > 0 || leftovers.length > 0 || fs.readFileSync(STATE, 'utf8').length >= good.length / 2, `poškozený auto-upgrade.json: aspoň hláška v logu nebo záložní kopie před přepsáním (hlášek ${errs.length}, kopie ${leftovers.join(',') || 'žádná'}, skupin po načtení ${US(u).groups ? US(u).groups.length : 0})`);
  });

  // =====================================================================================================================
  // SKUTEČNÝ RunnerPool proti falešnému zařízení (lib/ros.RosClient + lib/inspect.inspect nahrazené), skutečný čas
  closeAll(); rp = new RunnerPool(); realPool = true;
  const waitJob = async (id, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const j = db.getJob(id); if (j && !['queued', 'running'].includes(j.status) && !rp.runnerOfJob(id)) return j; await sleep(40); } return db.getJob(id); };
  const realWin = () => { const n = new Date(); return `${hm(new Date(n.getTime() - 60e3))}-${hm(new Date(n.getTime() + 3 * 3600e3))}`; };
  const RS = () => ({ auto_window: realWin(), auto_delay_days: 0, min_release_age_days: 0 });
  const tomorrow = () => new Date(Date.now() + day * 1000);

  await scene('RUNNER — cíl jobu, piny, ruční zásah mezi plánem a spuštěním, nedostupný a trvale blokovaný kus', async () => {
    pinMap = { 'v7-long-term': '7.24.5' }; // správce má připnutou starší verzi
    const u = mkUser(RS());
    const a = mkDev(u), b = mkDev(u), c = mkDev(u), f = mkDev(u, { total_mem: 32 * MB });
    live[a.host] = { version: '7.24.6' };                   // mezi plánem a spuštěním ručně zvednuto na cíl
    live[b.host] = { version: '7.25.1' };                   // ručně zvednuto NAD cíl
    live[c.host] = { fail: 'fake: zařízení neodpovídá' };   // nedostupné
    live[f.host] = { total_mem: 32 * MB };                  // v7 na 32 MB RAM: planner ho blokuje vždy (seznam hardware bez v7)
    grp(u, 'G', [a, b, c, f]);
    chk(V.getLatest(u.id).versions['v7-long-term'].version === '7.24.5' && V.withTargets(V.getLatest(u.id), { 'v7-long-term': '7.24.6' }).versions['v7-long-term'].version === '7.24.6', 'pin 7.24.5 platí pro ruční joby, options.targets ho pro job automatu přebije');
    let n0 = started.length; await auto.tick(new Date()); let j = since(n0)[0];
    chk(!!j && db.getJob(j).options.targets['v7-long-term'] === '7.24.6', 'automat cílí na poslední verzi MikroTiku 7.24.6 bez ohledu na pin');
    let job = await waitJob(j); const by = (d) => db.getJobItems(j).find(i => i.device_id === d.id);
    chk(job.status === 'done', `job doběhl (${job.status}: ${job.status_note})`);
    chk(by(a).status === 'done' && by(a).result.nothingToDo && by(a).to_version === '7.24.6', 'kus mezitím ručně zvednutý na cíl: „už aktuální“, nic se nedělá (a cíl položky je 7.24.6, ne pin)');
    chk(by(b).status === 'done' && by(b).result.nothingToDo && db.getDevice(b.id).version === '7.25.1', 'kus ručně zvednutý nad cíl: verze se nechává (neblokuje se), downgrade ani přechod na stable v automatu nenastane');
    chk(by(c).status === 'failed' && by(c).result.untouched === true, 'nedostupný kus: failed + untouched');
    chk(by(f).status === 'blocked' && /bez v7/.test(by(f).error), 'kus s 32 MB RAM na v7: planner blokuje');
    await auto.tick(new Date()); const h = US(u).history[0];
    chk(h && h.ok === 2 && h.unreachable === 1 && h.skipped === 1 && h.failed === 0 && !US(u).halted, 'vyhodnocení: 2 OK (jeden z nich nad cílem, ponechán), 1 nedostupný, 1 neprovedeno, automat se nezastavil');
    // cíl nižší než pin / než aktuální verze — přímo plánovač s cíli jobu
    pinMap = { 'v7-long-term': '7.25.1' };
    const L = V.withTargets(V.getLatest(u.id), { 'v7-long-term': '7.24.6' });
    const p1 = await plan(fakeInfo(db.getDevice(a.id), { version: '7.24.4' }), { track: 'v7-long-term', settings: db.getSettings(u.id), latest: L, options: { auto: true } });
    const p2 = await plan(fakeInfo(db.getDevice(a.id), { version: '7.25.1' }), { track: 'v7-long-term', settings: db.getSettings(u.id), latest: L, options: { auto: true } });
    chk(p1.target === '7.24.6' && p1.hops.length === 1 && p1.hops[0].to === '7.24.6' && !p1.blockers.length, 'cíl automatu nižší než pin (7.25.1): kus pod cílem jde na 7.24.6 (pin se ignoruje, jak je popsáno)');
    chk(!p2.blockers.length && !p2.hops.length && p2.target === '7.25.1' && p2.notes.some(x => /downgrade se nedělá/.test(x)), 'kus už na 7.25.1 s cílem automatu 7.24.6: žádný hop, žádný blokátor, downgrade se nedělá');
    pinMap = {};
    // další noc
    n0 = started.length; startHook = (id) => { const o = db.getJob(id).options; db.updateJob(id, { options: { ...o, stop_at: Math.floor(Date.now() / 1000) + 3600 } }); };
    await auto.tick(tomorrow()); const j2 = since(n0)[0]; if (j2) await waitJob(j2);
    chk(db.getDevice(c.id).scan_status === 'unreachable' && !(j2 && db.getJobItems(j2).some(i => i.device_id === c.id)), 'nedostupný kus se další noc nebere (do příštího úspěšného skenu)');
    // BUG: (střední) kus, který planner blokuje trvale (HW bez v7, známá riziková verze pro desku, vadné bloky, málo místa…), je podle DB pořád „pod cílem“
    // → automat pro něj zakládá job KAŽDOU noc znovu (a každé ráno posílá e-mail „0 zařízení upgradováno, 1 neprovedeno“), dokud někdo skupinu neupraví
    n0 = started.length; await auto.tick(new Date(Date.now() + 2 * day * 1000)); const j3 = since(n0)[0]; if (j3) await waitJob(j3);
    chk(!!j2 && !j3 && Object.keys(auto.statusFor(u).groups.flatMap(g => Object.keys(g.skipped)).filter(k => /opakovaně zablokovala/.test(k))).length === 1, `trvale blokovaný kus: druhou noc se zkusí ještě jednou, třetí už se pro něj job nezakládá a důvod je ve stavu (job #${j3 || '—'})`);
    if (false) bug(!j2, `trvale blokovaný kus: druhou noc se pro něj samotný job už nezakládá (job #${j2 || '—'}: ${j2 ? db.getJobItems(j2).map(i => i.status + ' ' + String(i.error).slice(0, 60)).join('; ') : ''})`);
  });

  await scene('RUNNER — konec okna (stop_at) uprostřed jobu', async () => {
    const u = mkUser(RS());
    const x1 = mkDev(u), x2 = mkDev(u), x3 = mkDev(u);
    live[x1.host] = { version: '7.24.6', delay: 2600 }; // první kus: rozdělaný přes konec okna (pomalé připojení), nakonec „už aktuální“
    grp(u, 'G', [x1, x2, x3]);
    let n0 = started.length;
    startHook = (id) => { const o = db.getJob(id).options; db.updateJob(id, { options: { ...o, parallel: 1, stop_at: Math.floor(Date.now() / 1000) + 2 } }); }; // okno končí za 1–2 s
    await auto.tick(new Date()); const j = since(n0)[0]; const job = await waitJob(j); const its = db.getJobItems(j);
    const i1 = its.find(i => i.device_id === x1.id), rest = its.filter(i => i.device_id !== x1.id);
    chk(job.status === 'done' && i1.status === 'done' && i1.finished_at >= job.options.stop_at, `rozdělaný kus se po konci okna dokončí (job ${job.status}: ${job.status_note}; kus ${i1.status})`);
    chk(rest.length === 2 && rest.every(i => i.status === 'skipped' && /noční okno skončilo/.test(i.error)), 'zbylé kusy se nezačnou: skipped „noční okno skončilo — půjde další noc“ (' + rest.map(i => i.status + ':' + i.error).join(' | ') + ')');
    chk(conns[x2.host] === 1 && conns[x3.host] === 1, 'na nezačaté kusy se sáhlo jen při předběžné kontrole');
    await auto.tick(new Date());
    chk(US(u).open.length === 0 && US(u).history[0].ok === 1 && US(u).history[0].skipped === 2 && !US(u).halted, 'vyhodnocení: 1 OK, 2 přeskočeno, bez zastavení');
    // další noc: zbytek znovu (job se jen založí, neběží)
    realPool = false; n0 = started.length; await auto.tick(tomorrow()); realPool = true;
    const j2 = since(n0)[0];
    chk(j2 && db.getJobItems(j2).map(i => i.device_id).sort().join() === [x2.id, x3.id].sort().join(), 'další noc se zbylé 2 kusy vezmou znovu');
    // job po restartu serveru spuštěný až po konci okna
    db.updateJob(j2, { options: { ...db.getJob(j2).options, stop_at: Math.floor(Date.now() / 1000) - 5 } });
    rp.start(j2); const jj = await waitJob(j2);
    chk(jj.status === 'done' && db.getJobItems(j2).every(i => i.status === 'skipped') && conns[x2.host] === 1, 'job spuštěný po konci okna (fronta po restartu): nic se nezačne, vše skipped, job done');
  });

  await scene('RUNNER — skutečná chyba zastaví job i automat', async () => {
    const u = mkUser(RS());
    const y1 = mkDev(u), y2 = mkDev(u), y3 = mkDev(u);
    live[y1.host] = { version: '7.24.6' };
    live[y2.host] = { version: '7.24.6', identity2: 'uplne-jiny-router' }; // mezi kontrolou a upgradem je na adrese jiné zařízení
    grp(u, 'G', [y1, y2, y3]);
    const n0 = started.length;
    startHook = (id) => { const o = db.getJob(id).options; db.updateJob(id, { options: { ...o, parallel: 1 } }); };
    await auto.tick(new Date()); const j = since(n0)[0]; const job = await waitJob(j); const its = db.getJobItems(j); const by = (d) => its.find(i => i.device_id === d.id);
    chk(job.status === 'done' && by(y2).status === 'failed' && /identita/.test(by(y2).error), `chyba na 2. kusu (${by(y2).status}: ${by(y2).error}); job se uzavřel (${job.status}: ${job.status_note})`);
    chk(by(y1).status === 'done' && by(y3).status !== 'skipped' && !/automat zastaven/.test(by(y3).error || ''), `1. kus hotový, 3. se po chybě na 2. normálně zkusil (${by(y3).status}: ${by(y3).error || ''})`);
    await auto.tick(new Date());
    chk(!US(u).halted && US(u).failed[y2.id] && /identita/.test(US(u).failed[y2.id].error) && US(u).failed[y2.id].version === '7.24.6' && US(u).open.length === 0, 'automat se nezastavil, selhaný kus s verzí v evidenci');
    const m0 = started.length; await auto.tick(tomorrow()); chk(!started.slice(m0).some(j => db.getJobItems(j).some(i => i.device_id === y2.id)), 'další noc se selhaný kus sám znovu nezkouší, dokud ho správce neuvolní');
  });

  await scene('RUNNER — na adrese je jiné zařízení už před předběžnou kontrolou', async () => {
    const u = mkUser(RS());
    const w1 = mkDev(u, { serial: 'AAA111' }), w2 = mkDev(u);
    live[w1.host] = { version: '7.24.6', serial: 'ZZZ999' };               // jiný kus (jiné sériové číslo) než při posledním skenu
    live[w2.host] = { version: '7.24.6', identity: 'uplne-jiny-router' };  // jiná identita než při posledním skenu
    grp(u, 'G', [w1, w2]);
    const n0 = started.length; await auto.tick(new Date()); const j = since(n0)[0]; await waitJob(j); const its = db.getJobItems(j);
    // BUG: (střední, lib/runner.js _precheckAll) předběžná kontrola zapíše zjištěnou identitu i sériové číslo do DB (toDeviceFields) dřív, než je runItem
    // porovná s uloženými → pojistka „identita / sériové číslo nesouhlasí“ u jobů s precheck (automat vždy) nikdy nezabere a upgraduje se cizí kus
    bug(its.every(i => i.status !== 'done'), `jiný kus na adrese (jiné S/N, jiná identita) se neupgraduje (${its.map(i => i.host + ' ' + i.status + ' ' + (i.error || '')).join('; ')}; v DB teď S/N ${db.getDevice(w1.id).serial}, identita ${db.getDevice(w2.id).identity})`);
  });

  await scene('RUNNER — deploy (drain) uprostřed nočního jobu', async () => {
    const u = mkUser(RS());
    const z1 = mkDev(u), z2 = mkDev(u);
    live[z1.host] = { version: '7.24.6', delay: 1500 }; live[z2.host] = { version: '7.24.6', delay: 300 };
    grp(u, 'G', [z1, z2]);
    const n0 = started.length;
    startHook = (id) => { const o = db.getJob(id).options; db.updateJob(id, { options: { ...o, parallel: 1 } }); };
    await auto.tick(new Date()); const j = since(n0)[0];
    for (let i = 0; i < 100 && !db.getJobItems(j).some(it => it.status === 'checking'); i++) await sleep(20);
    rp.setDraining(true);
    for (let i = 0; i < 200 && db.getJob(j).status !== 'paused'; i++) await sleep(30);
    const mid = db.getJob(j), items = db.getJobItems(j);
    chk(mid.status === 'paused' && /aktualiz/.test(mid.status_note) && items.filter(i => i.status === 'done').length === 1 && items.filter(i => i.status === 'pending').length === 1, `drain: rozdělaný kus dokončen, job pozastaven se zbytkem (${mid.status}: ${mid.status_note})`);
    await auto.tick(new Date()); await auto.tick(tomorrow());
    chk(US(u).open.length === 1 && since(n0).length === 1 && !US(u).halted, 'automat během drainu job drží v evidenci a nic nového nezakládá');
    Runner.recoverAfterRestart(); reload(); rp.setDraining(false); // restart po deployi: job jde do fronty a RunnerPool ho rozjede
    const end = await waitJob(j);
    chk(end.status === 'done' && db.getJobItems(j).every(i => i.status === 'done'), `po restartu job sám doběhne (${end.status}: ${end.status_note})`);
    await auto.tick(new Date());
    chk(US(u).open.length === 0 && US(u).history[0].ok === 2 && since(n0).length === 1, 'vyhodnocení po restartu: 2 OK, žádný druhý job téže noci');
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(bad ? `\nSELHALO: ${bad} (z toho ${bugs}× označená chyba „BUG“)` : '\nvše v pořádku');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
