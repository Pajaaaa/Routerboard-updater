#!/usr/bin/env node
'use strict';
// Automatický upgrade (lib/autoupgrade.js, 20.11.2026): zrání verze, noční okno, výběr kusů (jen vlastní, stejná hlavní verze, páteř jen
// s povolením, nikdy rodič s potomkem), vlny, zastavení po chybě a uvolnění, povolené účty, konec okna v runneru.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-auto-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x'; process.env.USERDB_URL = '';
const NOW = new Date(2026, 10, 24, 1, 30, 0); // úterý 24.11.2026 01:30
const nowSec = NOW.getTime() / 1000, day = 86400;
// paměť vydání = co „nabízí MikroTik“: long-term 7.24.6 (6 dní), stable 7.25.1 (2 dny), v6 6.49.24 (40 dní)
fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({
  'v7-long-term': [{ version: '7.24.6', releasedAt: nowSec - 6 * day }], 'v7-stable': [{ version: '7.25.1', releasedAt: nowSec - 2 * day }], 'v6-long-term': [{ version: '6.49.24', releasedAt: nowSec - 40 * day }] }));
const db = require('../lib/db');
const V = require('../lib/versions');
const auto = require('../lib/autoupgrade');
const { RunnerPool } = require('../lib/runner');
const mail = require('../lib/mail');
const mails = []; mail.enabled = () => true; mail.send = async (m) => { mails.push(m); return 'ok'; };
const tickWait = () => new Promise(r => setTimeout(r, 20));
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const mkUser = (name, nick) => { const id = db.insertUser({ name, pass_hash: '', role: 'user' }); db.updateUser(id, { userdb_nick: nick }); return db.listUsers().find(u => u.id === id); };
let n = 0;
const mkDev = (owner, f = {}) => { const id = db.insertDevice({ host: `10.9.0.${++n}`, port: 22, owner_id: owner, username: 'a', password: 'b' }); db.updateDevice(id, { version: '7.24.4', scan_status: 'ok', userdb_member: 1, model: 'SXTsq', board_name: 'SXTsq', track: 'v7-long-term', ...f }); return db.getDevice(id); };

(async () => {
  const me = mkUser('paja@x.cz', 'pajavlk'), other = mkUser('jiny@x', 'jiny');
  const S = () => db.getSettings(me.id);
  // --- povolené účty
  chk(auto.allowed(me) && !auto.allowed(other), 'automat smí jen účet ze seznamu auto_users (výchozí pajavlk)');
  // --- zrání
  let tg = auto.targets(S(), nowSec);
  chk(tg['v7-long-term'].version === '7.24.6' && tg['v7-long-term'].mature, 'long-term 7.24.6 vydaná před 6 dny je při zpoždění 5 dní zralá');
  chk(!tg['v7-stable'].mature, 'stable 7.25.1 vydaná před 2 dny zralá není');
  db.setUserSettings(me.id, { auto_delay_days: 10 });
  chk(!auto.targets(S(), nowSec)['v7-long-term'].mature, 'vlastní zpoždění 10 dní: 7.24.6 ještě nedozrála');
  db.setUserSettings(me.id, { auto_delay_days: 5, bad_versions: '7.24.6' });
  chk(!!auto.targets(S(), nowSec)['v7-long-term'].blocked, 'zakázaná verze se nenasazuje');
  db.setUserSettings(me.id, { auto_delay_days: 5 });
  // --- okno
  chk(auto.windowNow({ auto_window: '01:00-04:30' }, NOW).night === '2026-11-24', 'okno 01:00–04:30 ve 01:30 běží, noc 24.11.');
  chk(auto.windowNow({ auto_window: '01:00-04:30' }, new Date(2026, 10, 24, 5, 0)) === null, 'v 05:00 okno neběží');
  const wm = auto.windowNow({ auto_window: '23:00-04:00' }, NOW);
  chk(wm && wm.night === '2026-11-23' && wm.day === 1, 'okno přes půlnoc: ve 01:30 patří k noci, která začala v pondělí 23.11.');
  chk(auto.windowNow({ auto_window: 'nesmysl' }, NOW) === null, 'nečitelné okno = automat neběží');
  chk(!!auto.validate({ auto_window: '25:00-03:00' }).error && !!auto.validate({ auto_days: '' }).error && !auto.validate({ auto_delay_days: 7, auto_window: '00:30-04:00', auto_days: '1,3', auto_waves: '2,5' }).error, 'kontrola hodnot formuláře');
  // --- zařízení
  const leafA = mkDev(me.id, { model: 'SXTsq', board_name: 'SXTsq' }), leafB = mkDev(me.id, { model: 'LHG', board_name: 'LHG' }), leafC = mkDev(me.id, { model: 'LHG', board_name: 'LHG' });
  const infra = mkDev(me.id, { userdb_member: 0, model: 'CRS', board_name: 'CRS' });
  const kid = mkDev(me.id, { model: 'Disc', board_name: 'Disc', parent_id: infra.id });
  const v6 = mkDev(me.id, { version: '6.49.10' });
  const dead = mkDev(me.id, { scan_status: 'unreachable' });
  const done = mkDev(me.id, { version: '7.24.6' });
  const foreign = mkDev(other.id);
  tg = auto.targets(S(), nowSec);
  let c = auto.candidates(me.id, S(), tg);
  const ids = (l) => (l || []).map(x => x.d.id).sort((a, b) => a - b).join(',');
  chk(ids(c.byTrack['v7-long-term']) === [leafA.id, leafB.id, leafC.id, kid.id].join(','), 'kandidáti: jen vlastní dostupné kusy pod cílem ve stejné hlavní verzi, bez infrastruktury (' + ids(c.byTrack['v7-long-term']) + ')');
  chk(Object.keys(c.skipped).some(k => /6 → 7/.test(k)) && Object.keys(c.skipped).some(k => /nedostupné/.test(k)) && Object.keys(c.skipped).some(k => /infrastruktura/.test(k)), 'důvody vynechání: 6→7, nedostupné, infrastruktura');
  db.setUserSettings(me.id, { ...db.getUserSettings(me.id), auto_backbone: true });
  c = auto.candidates(me.id, S(), tg);
  chk(c.byTrack['v7-long-term'].some(x => x.d.id === infra.id), 'se zapnutou páteří je mezi kandidáty i infrastruktura');
  // --- výběr noci
  let p = auto.pickNight({ tracks: {} }, c, { ...S(), auto_waves: '2,10' }, tg);
  chk(p.length === 2 && new Set(p.map(x => x.d.board_name)).size === 2, 'kanárci: 2 kusy různých modelů');
  p = auto.pickNight({ tracks: { 'v7-long-term': { version: '7.24.6', wave: 5 } } }, c, S(), tg);
  chk(p.some(x => x.d.id === kid.id) !== p.some(x => x.d.id === infra.id) && p.length === 4, 'vlna bez omezení: všechno kromě dvojice rodič+potomek (z té jen jeden)');
  // --- noční běh
  const started = []; const pool = { draining: false, isDeviceBusy: () => false, startOrQueue: (id) => started.push(id) };
  auto.configure({ pool, notify: () => {} });
  V.refreshLatest = async () => {}; // žádná síť v testu
  await auto.tick(NOW);
  chk(started.length === 0, 'vypnutý automat nic nespustí');
  db.setUserSettings(me.id, { ...db.getUserSettings(me.id), auto_enable: true, auto_waves: '2,10', auto_backbone: false });
  db.setSettings({ auto_pause: true }); await auto.tick(NOW); chk(started.length === 0, 'nouzová brzda správce: nic se nespustí'); db.setSettings({ auto_pause: false });
  await auto.tick(new Date(2026, 10, 21, 1, 30)); chk(started.length === 0, 'sobotní noc není mezi povolenými dny');
  await auto.tick(new Date(2026, 10, 24, 4, 15)); chk(started.length === 0, 'čtvrt hodiny před koncem okna se už nezačíná');
  chk(mails.length === 0, 'bez plánu na noc žádný e-mail');
  await auto.tick(new Date(2026, 10, 23, 12, 0)); chk(mails.length === 0, 'v poledne (13 h před oknem) se ještě neoznamuje');
  await auto.tick(new Date(2026, 10, 23, 18, 0));
  chk(mails.length === 1 && /dnes v noci půjde 2 zařízení na 7\.24\.6/.test(mails[0].subject) && mails[0].to.join() === 'paja@x.cz' && /7\.24\.4 → 7\.24\.6/.test(mails[0].text), 'večer před nocí přijde oznámení se seznamem (' + (mails[0] && mails[0].subject) + ')');
  await auto.tick(new Date(2026, 10, 23, 18, 30)); chk(mails.length === 1, 'oznámení jen jednou na noc');
  await auto.tick(NOW);
  chk(started.length === 1, 'v okně se založí a spustí job');
  const job = db.getJob(started[0]); const items = db.getJobItems(job.id);
  chk(job.owner_id === me.id && job.options.auto === true && job.options.targets['v7-long-term'] === '7.24.6' && job.options.stop_on_failure === true && job.options.stop_at > nowSec && items.length === 2, `job: vlastník, auto, cíl 7.24.6, zastavit při chybě, konec okna, 2 kanárci (${items.length})`);
  chk(V.withTargets(V.getLatest({ pin_v7_long_term: '7.24.5' }), job.options.targets).versions['v7-long-term'].version === '7.24.6', 'cíl jobu přebije připnutou verzi');
  await auto.tick(NOW); chk(started.length === 1, 'tutéž noc se druhý job nezakládá');
  await auto.tick(new Date(2026, 10, 25, 1, 30)); chk(started.length === 1, 'další noc se čeká, dokud minulý job není uzavřený');
  // minulá noc v pořádku → vlna 2
  for (const it of items) db.updateJobItem(it.id, { status: 'done', finished_at: db.now() }); db.updateJob(job.id, { status: 'done', finished_at: db.now() });
  for (const it of items) db.updateDevice(it.device_id, { version: '7.24.6' });
  await auto.tick(new Date(2026, 10, 25, 1, 30));
  chk(started.length === 2 && db.getJobItems(started[1]).length === 2, 'po úspěšné noci jde další vlna (zbylé 2 kusy)');
  await tickWait();
  chk(mails.length === 2 && /noc 24\. 11\.: 2 zařízení upgradováno/.test(mails[1].subject), 'po noci přijde souhrn (' + (mails[1] && mails[1].subject) + ')');
  let st = auto.statusFor(me);
  chk(st.allowed && st.history.length === 1 && st.history[0].ok === 2 && st.tracks['v7-long-term'].wave === 1, 'stav: historie noci a posun vlny');
  chk(auto.statusFor(other).allowed === false, 'nepovolený účet stav nedostane');
  // chyba → zastavení, uvolnění
  const it2 = db.getJobItems(started[1]);
  db.updateJobItem(it2[0].id, { status: 'failed', error: 'nevrátilo se po restartu', finished_at: db.now() }); db.updateJobItem(it2[1].id, { status: 'skipped', finished_at: db.now() }); db.updateJob(started[1], { status: 'done', finished_at: db.now() });
  await auto.tick(new Date(2026, 10, 26, 1, 30));
  st = auto.statusFor(me);
  chk(started.length === 2 && /nevrátilo se/.test(st.halted) && st.failed.length === 1, 'po chybě se automat zastaví a další noc nic nespustí');
  await tickWait();
  chk(mails.length === 3 && /AUTOMAT ZASTAVEN/.test(mails[2].subject) && /nevrátilo se po restartu/.test(mails[2].text), 'chyba: e-mail o zastavení s důvodem');
  auto.skipNight(me, true); st = auto.statusFor(me); chk(st.nextNight && st.skipNight === st.nextNight, 'vynechání nejbližší noci se zapíše'); auto.skipNight(me, false);
  chk(!!auto.validate({ auto_mail_to: 'neni-adresa' }).error && auto.validate({ auto_mail_to: 'a@b.cz; c@d.cz' }).values.auto_mail_to === 'a@b.cz, c@d.cz', 'kontrola adres pro hlášení');
  auto.release(me.id);
  await auto.tick(new Date(2026, 10, 26, 1, 31));
  chk(started.length === 3 && !auto.statusFor(me).halted, 'po uvolnění pokračuje');
  // --- runner: job po konci okna nic nezačne a uzavře se
  const rp = new RunnerPool();
  const jid = db.createJob('po okně', { auto: true, stop_at: Math.floor(Date.now() / 1000) - 60, precheck: true, parallel: 2 }, [leafC.id], me.id);
  rp.start(jid);
  for (let i = 0; i < 40 && db.getJob(jid).status !== 'done'; i++) await new Promise(r => setTimeout(r, 100));
  const jj = db.getJob(jid);
  chk(jj.status === 'done' && db.getJobItems(jid).every(i => i.status === 'skipped'), `runner: po konci okna se zařízení přeskočí a job uzavře (${jj.status}: ${jj.status_note})`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(bad ? `\nSELHALO: ${bad}` : '\nvše v pořádku');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
