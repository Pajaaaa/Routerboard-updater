#!/usr/bin/env node
'use strict';
// Souhra při velké zátěži (20.11.2026, automat pro všechny správce): spravedlivé dělení míst pod stropem serveru (RunnerPool.slotGate),
// fronta předběžných kontrol (RunnerPool.precheckSlot) a rozložený start nočních jobů správců (autoupgrade.startOffsetMin).
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-load-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x'; process.env.USERDB_URL = '';
const { RunnerPool } = require('../lib/runner');
const auto = require('../lib/autoupgrade');
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const P = RunnerPool.prototype;
  // falešný pool: jen mapa pracovníků a metody, které slotGate potřebuje
  const pool = { runners: new Map(), activeCount: P.activeCount, activeOwner: P.activeOwner, slotGate: P.slotGate, precheckSlot: P.precheckSlot };
  Object.defineProperty(pool, 'precheckWaiting', Object.getOwnPropertyDescriptor(P, 'precheckWaiting'));
  let k = 0; const mk = (ownerId, active) => { const r = { ownerId, busy: true, currentItemId: active ? ++k : 0, prechecking: false, wantSlot: 0 }; pool.runners.set('r' + (++k), r); return r; };

  console.log('strop serveru a spravedlivé dělení');
  for (let i = 0; i < 20; i++) mk(1, true); // správce 1 má 20 rozpracovaných
  for (let i = 0; i < 4; i++) mk(2, true);  // správce 2 má 4 → server plný (24)
  const a = mk(1, false), b = mk(2, false), c = mk(3, false);
  chk(pool.slotGate(a) === 'cap' && pool.slotGate(b) === 'cap' && pool.slotGate(c) === 'cap' && a.wantSlot && b.wantSlot && c.wantSlot, 'plný server (24): nikdo další nezačne, zájemci se zapíšou');
  [...pool.runners.values()].find(r => r.ownerId === 1 && r.currentItemId).currentItemId = 0; // jedno místo se uvolní
  chk(pool.slotGate(a) === 'fair', 'uvolněné místo: správce s 19 rozpracovanými ustoupí, když čeká někdo s méně');
  chk(pool.slotGate(b) === 'fair', 'správce se 4 ustoupí správci, který nemá nic');
  chk(pool.slotGate(c) === '' && c.wantSlot === 0, 'místo dostane správce, který nemá rozpracované nic');
  c.currentItemId = ++k;
  chk(pool.slotGate(a) === 'cap', 'server je zase plný');
  // zájemce, který přestal čekat (job skončil / byl pozastaven), místo neblokuje
  pool.runners.clear(); for (let i = 0; i < 10; i++) mk(1, true); const a2 = mk(1, false), gone = mk(2, false);
  gone.wantSlot = Date.now() - 60000;
  chk(pool.slotGate(a2) === '', 'zájem starší než 20 s už neplatí — místo se nedrží pro někoho, kdo nečeká');
  gone.wantSlot = Date.now(); chk(pool.slotGate(a2) === 'fair', 'čerstvý zájem správce s méně rozpracovanými má přednost');
  // stejný počet → nikdo neustupuje (žádné vzájemné zablokování)
  pool.runners.clear(); mk(1, true); mk(2, true); const e1 = mk(1, false), e2 = mk(2, false); e1.wantSlot = e2.wantSlot = Date.now();
  chk(pool.slotGate(e1) === '' , 'stejně rozpracovaných: první, kdo přijde, jde (nikdo nečeká na nikoho)');
  // vlastní pracovníci téhož správce si neustupují
  pool.runners.clear(); mk(1, true); const s1 = mk(1, false), s2 = mk(1, false); s2.wantSlot = Date.now();
  chk(pool.slotGate(s1) === '', 'pracovníci téhož správce se navzájem neblokují');
  // simulace provozu: 3 správci s dlouhou frontou, první si na začátku zabere všech 24 míst; jak zařízení dobíhají, místa se vyrovnají
  pool.runners.clear(); const W = []; for (const o of [1, 2, 3]) for (let i = 0; i < 30; i++) W.push(mk(o, false));
  const tryAll = (list) => { for (const w of list) if (!w.currentItemId && pool.slotGate(w) === '') w.currentItemId = ++k; };
  const cnt = (o) => pool.activeOwner(o);
  tryAll(W);
  chk(pool.activeCount() === 24 && cnt(1) === 24, `na začátku bere, kdo dřív přijde (${cnt(1)}/${cnt(2)}/${cnt(3)}) — ostatní jsou zapsaní jako zájemci`);
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 60; round++) { const act = W.filter(w => w.currentItemId); act[rnd(act.length)].currentItemId = 0; const sh = [...W].sort(() => rnd(3) - 1); tryAll(sh); tryAll(sh); }
  chk(pool.activeCount() === 24 && Math.max(cnt(1), cnt(2), cnt(3)) - Math.min(cnt(1), cnt(2), cnt(3)) <= 2, `po 60 dokončených zařízeních jsou místa rozdělená rovnoměrně (${cnt(1)}/${cnt(2)}/${cnt(3)})`);
  let worst = 0; for (let round = 0; round < 200; round++) { const act = W.filter(w => w.currentItemId); act[rnd(act.length)].currentItemId = 0; const sh = [...W].sort(() => rnd(3) - 1); tryAll(sh); tryAll(sh); worst = Math.max(worst, Math.max(cnt(1), cnt(2), cnt(3)) - Math.min(cnt(1), cnt(2), cnt(3))); if (pool.activeCount() !== 24) worst = 99; }
  chk(worst <= 3, `dalších 200 dokončení: server je pořád plný a rozdíl mezi správci nikdy nepřekročí 3 (nejhůř ${worst})`);

  console.log('fronta předběžných kontrol');
  let running = 0, peak = 0; const order = [];
  const job = async (id) => { const free = await pool.precheckSlot(); running++; peak = Math.max(peak, running); order.push(id); await sleep(15); running--; free(); free(); };
  await Promise.all(Array.from({ length: 30 }, (_, i) => job(i)));
  chk(peak === 8 && order.join() === Array.from({ length: 30 }, (_, i) => i).join() && pool._preN === 0 && pool.precheckWaiting === 0, `30 jobů: naráz nejvýš 8 kontrol, pořadí podle příchodu, po doběhnutí je fronta prázdná (špička ${peak})`);
  { const f1 = await pool.precheckSlot(); f1(); f1(); const f2 = await pool.precheckSlot(); chk(pool._preN === 1, 'dvojí uvolnění téhož místa nic nerozbije'); f2(); }

  console.log('rozložený start nočních jobů');
  const S = { auto_window: '01:00-04:30' };
  chk(auto.startOffsetMin(5, '2026-11-24', S, 1) === 0, 'jediný správce se zapnutým automatem začíná hned');
  const offs = Array.from({ length: 100 }, (_, i) => auto.startOffsetMin(i + 1, '2026-11-24', S, 100));
  const buckets = new Set(offs).size;
  chk(Math.max(...offs) <= 30 && Math.min(...offs) >= 0 && buckets >= 20, `100 správců: starty rozložené do 0–30 min (${buckets} různých minut)`);
  chk(Math.max(...Array.from({ length: 5 }, () => offs.filter(o => o <= 0).length)) <= 15, 'v první minutě nezačíná víc než 15 % správců');
  chk(auto.startOffsetMin(7, '2026-11-24', S, 100) === auto.startOffsetMin(7, '2026-11-24', S, 100), 'posun je pro účet a noc pevný (mezi ticky se nemění)');
  chk(Array.from({ length: 20 }, (_, i) => auto.startOffsetMin(7, `2026-11-${10 + i}`, S, 100)).some((x, i, arr) => x !== arr[0]), 'mezi nocemi se pořadí správců střídá');
  chk(Math.max(...Array.from({ length: 50 }, (_, i) => auto.startOffsetMin(i + 1, '2026-11-24', S, 3))) <= 4, 'tři správci: posun nejvýš 4 minuty');
  chk(Math.max(...Array.from({ length: 50 }, (_, i) => auto.startOffsetMin(i + 1, '2026-11-24', { auto_window: '02:00-03:00' }, 100))) <= 15, 'krátké okno (60 min): posun nejvýš čtvrtina okna');
  chk(auto.startOffsetMin(1, '2026-11-24', { auto_window: 'nesmysl' }, 100) === 0, 'nečitelné okno: bez posunu');

  console.log(bad ? `SELHALO: ${bad}` : 'vše v pořádku');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
