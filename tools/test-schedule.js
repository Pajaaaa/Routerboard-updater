#!/usr/bin/env node
'use strict';
// Souběh uvnitř jobu (6.11.2026, lib/schedule.js + pracovníci v runneru): koncové kusy členů jedou naráz, sektor až po svých klientech,
// infrastruktura (switch, router, 60 GHz spoj) výhradně a jeden po druhém, nic se nespustí vedle rozpracovaného předka/potomka/souseda.
// Scénáře z noci 5./6.11.: Na Kotli (ROUTER → SWITCH → sektor S1 → CPE členů; kruh čekání) a Malhota (MAINv2 → sektory, switch CRS bez potomků).
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-sched-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin';
const db = require('../lib/db');
const S = require('../lib/schedule');
const { Runner, RunnerPool } = require('../lib/runner');
let fail = 0; const chk = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); if (!ok) fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const dev = (host, name, f = {}, extra = {}) => { const id = db.insertDevice({ host, port: 22, owner_id: 1 }); db.updateDevice(id, { name, managed: 1, enabled: 1, board_name: 'x', version: '7.10', flags: JSON.stringify(f), ...extra }); return id; };
// Na Kotli
const ROUTER = dev('10.9.0.1', 'NaKotli-ROUTER', { links: {} , ip_addresses: ['10.9.0.1'] });
const SWITCH = dev('10.9.0.2', 'NaKotli-SWITCH', { uplink: { iface: 'ether1', neighbor: { address: '10.9.0.1' } } }, { parent_id: ROUTER });
const S1 = dev('10.9.0.3', 'NaKotli-S1', { links: { aps: [{ iface: 'wlan1', clients: 2 }] }, uplink: { iface: 'ether1', neighbor: { address: '10.9.0.2' } } }, { parent_id: SWITCH });
const S2 = dev('10.9.0.4', 'NaKotli-S2', { links: { aps: [{ iface: 'wlan1', clients: 1 }] } }, { parent_id: SWITCH });
const C1 = dev('10.9.1.1', 'clen-1', { links: { stations: [{ iface: 'wlan1' }] } }, { parent_id: S1, userdb_member: 1 });
const C2 = dev('10.9.1.2', 'clen-2', { links: { stations: [{ iface: 'wlan1' }] } }, { parent_id: S1, userdb_member: 1 });
const C3 = dev('10.9.1.3', 'clen-3', { links: { stations: [{ iface: 'wlan1' }] } }, { parent_id: S2, userdb_member: 1 });
const W60 = dev('10.9.0.5', 'NaKotli-60G', { links: { w60g: [{ iface: 'wlan60' }] }, w60g: 1 }, { parent_id: ROUTER });
// Malhota: CRS v DB bez potomků (sektory visí přímo pod MAINv2) — přesto je infra, ne leaf
const MAIN = dev('10.8.0.1', 'MalhotaA-MAINv2', { links: {} });
const CRS = dev('10.8.0.2', 'MalhotaA-CRS', { uplink: { iface: 'sfp1', neighbor: { address: '10.8.0.1' } } }, { parent_id: MAIN });
const MS1 = dev('10.8.0.3', 'Malhota-sektor1', { links: { aps: [{ iface: 'wlan1', clients: 3 }] } }, { parent_id: MAIN });
const MC1 = dev('10.8.1.1', 'clen-m1', { links: { stations: [{}] } }, { parent_id: MS1, userdb_member: 1 });
const STA = dev('10.8.2.1', 'cizi-stanice', { links: { stations: [{}] } }, { parent_id: MS1 }); // stanice bez člena = infra (spoj)
const raw = (id) => db.getDeviceRaw(id);

console.log('třídy:');
chk('CPE člena = leaf', S.classify(raw(C1)) === 'leaf');
chk('sektor s klienty = sector', S.classify(raw(S1)) === 'sector');
chk('switch = infra', S.classify(raw(SWITCH)) === 'infra');
chk('router = infra', S.classify(raw(ROUTER)) === 'infra');
chk('60 GHz spoj = infra', S.classify(raw(W60)) === 'infra');
chk('CRS bez potomků v DB = infra (ne leaf)', S.classify(raw(CRS)) === 'infra');
chk('stanice bez člena = infra', S.classify(raw(STA)) === 'infra');
chk('člen se potomkem (AP doma) = ne leaf', (() => { const k = dev('10.9.1.9', 'clen-ap', { links: { aps: [{ clients: 1 }] } }, { userdb_member: 1 }); dev('10.9.1.10', 'clen-ap-dite', {}, { parent_id: k, userdb_member: 1 }); return S.classify(raw(k)) === 'sector'; })());
chk('switch vidí router na uplinku → switch před routerem', S.seesOnUplink(raw(SWITCH), raw(ROUTER)) && !S.seesOnUplink(raw(ROUTER), raw(SWITCH)));

console.log('výběr další položky (pickNext):');
const all = [ROUTER, SWITCH, S1, S2, C1, C2, C3, W60];
const jobId = db.createJob('t', { parallel: 4 }, all, 1);
const items = () => db.getJobItems(jobId);
const classes = S.classMap(items()); const ctx = { classOf: (id) => classes.get(id) };
const byDev = (id) => items().find(i => i.device_id === id);
const set = (id, status) => db.updateJobItem(byDev(id).id, { status, finished_at: status === 'done' ? db.now() : 0 });
const pick = (c = ctx) => S.pickNext(items(), c);
chk('první vybraný je koncový kus (leaf, nejhlouběji)', ['leaf'].includes(classes.get(pick().item.device_id)), String(pick().item && pick().item.dev_name));
set(C1, 'checking');
let p = pick();
chk('při běžícím C1 se vybere další leaf (C2/C3), ne sektor', p.item && classes.get(p.item.device_id) === 'leaf', p.item && p.item.dev_name);
chk('sektor S1 čeká na své klienty (není vybrán)', !(p.item && p.item.device_id === S1));
set(C1, 'done'); set(C2, 'done'); set(C3, 'checking');
p = pick();
chk('klienti S1 hotovi → S1 připraven i když C3 (pod S2) ještě běží', p.item && p.item.device_id === S1, p.item && p.item.dev_name);
chk('infra (W60) zatím ne — běží C3; SWITCH má rozpracované potomky', p.waiting.some(w => /60G.*infrastruktura/.test(w)) && !p.waiting.some(w => /SWITCH/.test(w)), p.waiting.join(' | '));
set(S1, 'checking');
p = pick();
chk('S2 čeká (klient C3 běží), switch čeká (něco běží)', !p.item, p.item && p.item.dev_name);
set(C3, 'done'); p = pick();
chk('C3 hotov → S2 ready souběžně s běžícím S1', p.item && p.item.device_id === S2);
set(S1, 'done'); set(S2, 'done'); p = pick();
chk('vše neinfra hotovo → infra: SWITCH (nejhlouběji) před ROUTER', p.item && p.item.device_id === SWITCH, p.item && p.item.dev_name);
set(SWITCH, 'reboot'); p = pick();
chk('při restartu switche nic dalšího (W60 čeká, ROUTER má rozpracovaného potomka)', !p.item && p.waiting.length === 1 && /60G/.test(p.waiting[0]), p.waiting.join(' | '));
set(SWITCH, 'done'); p = pick();
chk('pak W60 (sourozenec pod ROUTER, hloubka 1) před ROUTER', p.item && p.item.device_id === W60, p.item && p.item.dev_name);
set(W60, 'done'); p = pick();
chk('nakonec ROUTER', p.item && p.item.device_id === ROUTER);
// konflikt s cizím jobem: předek/soused rozpracovaný jinde → položka se nevybere
p = pick({ ...ctx, conflict: (it) => it.device_id === ROUTER ? 'cizi-job (10.0.0.9, job #5, Franta)' : null });
chk('cizí konflikt → ROUTER čeká, důvod v waiting', !p.item && p.waiting.some(w => /ROUTER čeká na cizi-job/.test(w)), p.waiting.join(' | '));
// selhaný potomek → rodič zablokován
set(ROUTER, 'pending'); set(SWITCH, 'failed'); p = pick();
chk('SWITCH failed → ROUTER v blockedItems s důvodem', !p.item && p.blockedItems.length === 1 && /SWITCH/.test(p.blockedItems[0].blockReason), p.blockedItems.map(b => b.blockReason).join());
// nedotčený potomek (chyba před připojením, result.untouched) rodiče neblokuje
db.updateJobItem(byDev(SWITCH).id, { result: { untouched: true } }); p = pick();
chk('SWITCH failed, ale nedotčený (untouched) → ROUTER jde', p.item && p.item.device_id === ROUTER && !p.blockedItems.length, p.blockedItems.map(b => b.blockReason).join());
db.updateJobItem(byDev(SWITCH).id, { result: {} });
// kanárci
set(SWITCH, 'done'); db.updateJobItem(byDev(ROUTER).id, { plan: { canary: true } }); set(C1, 'pending'); p = pick({ ...ctx, onlyCanary: true });
chk('fáze kanárků: C1 (nekanárek) se nebere; ROUTER (kanárek) čeká na pending C1', !p.item && !p.blockedItems.length, p.item && p.item.dev_name);
p = pick();
chk('mimo fázi kanárků se C1 vezme', p.item && p.item.device_id === C1);

console.log('pracovníci v runneru (stubovaný upgrade):');
(async () => {
  const pool = new RunnerPool();
  const log = []; let active = 0, maxActive = 0; const t0 = Date.now();
  // runItem nahrazen: 80 ms „upgrade“, záznam souběhu a pořadí
  Runner.prototype.runItem = async function (job, item) {
    active++; maxActive = Math.max(maxActive, active);
    const cls = (this.lead || this).classes.get(item.device_id);
    const now = db.getJobItems(job.id).filter(i => S.ACTIVE.has(i.status));
    log.push({ dev: item.dev_name, cls, t: Date.now() - t0, with: now.filter(i => i.id !== item.id).map(i => i.dev_name) });
    db.updateJobItem(item.id, { status: 'running', step: 'test' });
    await sleep(80);
    db.updateJobItem(item.id, { status: 'done', finished_at: db.now() });
    active--;
    return 'done';
  };
  const j2 = db.createJob('souběh', { parallel: 4, precheck: false, pause_sec: 0 }, [MAIN, CRS, MS1, MC1, STA, ROUTER, SWITCH, S1, S2, C1, C2, C3, W60], 1);
  pool.start(j2);
  chk('vedoucí runner je v poolu pod číslem jobu', !!pool.runnerOfJob(j2));
  let st = null; for (let i = 0; i < 100; i++) { await sleep(20); st = pool.runnerOfJob(j2) && pool.runnerOfJob(j2).status(); if (st && st.items && st.items.length >= 2) break; }
  chk('stav vedoucího nese seznam rozpracovaných položek (items)', st && Array.isArray(st.items) && st.items.length >= 2, JSON.stringify(st && st.items));
  chk('running() vrací jen vedoucí (1 job), busyDeviceIds všechny kusy', pool.running().length === 1 && pool.busyDeviceIds().length >= 2, `${pool.running().length}/${pool.busyDeviceIds().length}`);
  for (let i = 0; i < 100 && pool.runnerOfJob(j2); i++) await sleep(50);
  await sleep(700);
  const job = db.getJob(j2);
  chk('job doběhl do stavu done/hotovo', job.status === 'done' && job.status_note === 'hotovo', `${job.status} ${job.status_note}`);
  chk('všechny položky done', db.getJobItems(j2).every(i => i.status === 'done'));
  chk('souběh opravdu nastal (max ≥ 3 naráz)', maxActive >= 3, 'max ' + maxActive);
  chk('souběh nepřekročil parallel=4', maxActive <= 4, 'max ' + maxActive);
  const infra = log.filter(l => l.cls === 'infra');
  chk('infra nikdy neběžela vedle ničeho', infra.every(l => l.with.length === 0), infra.filter(l => l.with.length).map(l => `${l.dev} s ${l.with.join(',')}`).join('; '));
  const lastNonInfra = Math.max(...log.filter(l => l.cls !== 'infra').map(l => l.t)), firstInfra = Math.min(...infra.filter(l => l.dev !== 'cizi-stanice').map(l => l.t));
  chk('infra (mimo stanici pod sektorem) až po všech koncových kusech a sektorech', firstInfra >= lastNonInfra, `infra od ${firstInfra} ms, poslední neinfra ${lastNonInfra} ms`);
  const idx = (n) => log.findIndex(l => l.dev === n);
  chk('stanice bez člena pod sektorem: sama (infra), ale před svým sektorem', idx('cizi-stanice') < idx('Malhota-sektor1') && idx('cizi-stanice') > idx('clen-m1'));
  chk('CPE před svým sektorem (clen-1 < S1, clen-m1 < sektor1)', idx('clen-1') < idx('NaKotli-S1') && idx('clen-m1') < idx('Malhota-sektor1'));
  chk('switch před routerem, CRS před MAINv2', idx('NaKotli-SWITCH') < idx('NaKotli-ROUTER') && idx('MalhotaA-CRS') < idx('MalhotaA-MAINv2'));
  chk('pracovníci po skončení z poolu pryč', [...pool.runners.keys()].every(k => typeof k === 'number' && !String(k).includes('#')) && pool.runners.size === 0, [...pool.runners.keys()].join());

  // kruh čekání: A čeká na B, B na C, C na A → nejhlubší (C) jde
  const r = (jobId, devId, waitFor) => { const x = new Runner(); x.ownerId = 1; x.currentJobId = jobId; x.currentItemId = devId; x.currentDeviceId = devId; x.waitingLockFor = waitFor; x.pool = pool; pool.runners.set(jobId, x); return x; };
  const rA = r(901, ROUTER, SWITCH), rB = r(902, SWITCH, S1), rC = r(903, S1, ROUTER);
  const cyc = pool.waitCycle(rA);
  chk('kruh ROUTER→SWITCH→S1→ROUTER rozpoznán (3 runnery)', cyc && cyc.length === 3, cyc && cyc.length);
  chk('bez kruhu null', (() => { rC.waitingLockFor = 0; const n = pool.waitCycle(rA); rC.waitingLockFor = ROUTER; return n === null; })());
  // rebootingNear: cizí kus v restartu na stejné /24 nebo nad/pod
  db.updateJobItem(byDev(SWITCH).id, { status: 'reboot' }); rB.currentItemId = byDev(SWITCH).id;
  chk('rebootingNear: S1 vidí restartující SWITCH (předek)', /SWITCH/.test(pool.rebootingNear(raw(S1), rC) || ''), pool.rebootingNear(raw(S1), rC));
  chk('rebootingNear: kus z jiné sítě a jiného jobu ne', pool.rebootingNear(raw(MC1), rC) === null, pool.rebootingNear(raw(MC1), rC));
  pool.runners.clear();
  console.log(fail ? `\nSELHALO: ${fail}` : '\nvše v pořádku');
  process.exit(fail ? 1 : 0);
})();
