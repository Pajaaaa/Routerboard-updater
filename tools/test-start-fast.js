#!/usr/bin/env node
'use strict';
// Rychlostní audit 9.11.2026 (vlna 2) — start bez čekání na mikrotik.com a userdb:
// verze z paměti vydání platí hned, 6 kanálů se stahuje naráz a souběžná volání sdílejí jedno stažení; mapa účet → APčka se načte
// ze souboru hned při startu a při nedostupné userdb platí dál; listJobsOpen vrací jen otevřené joby s rozparsovanými options;
// /api/state na refresh nečeká, runJob nevynucuje stažení, klient filtruje SSE podle otevřeného jobu.
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-startfast-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234';
// userdb zapnutá, ale nedostupná (odmítnuté spojení) = situace po restartu, kdy userdb neodpovídá: mapa ze souboru musí platit dál
process.env.MTU_USERDB_URL = 'http://127.0.0.1:1/userdb/api'; process.env.MTU_USERDB_USER = 'x'; process.env.MTU_USERDB_PASS = 'y';
let fail = 0; const chk = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); if (!ok) fail++; };

// paměť vydání + mapa přístupu připravené z minula ještě před načtením modulů
fs.writeFileSync(path.join(DATA, 'releases.json'), JSON.stringify({
  'v7-stable': [{ version: '7.24.2', releasedAt: 1760000000 }, { version: '7.24.1', releasedAt: 1750000000 }],
  'v6-long-term': [{ version: '6.49.23', releasedAt: 1740000000 }],
}));
fs.writeFileSync(path.join(DATA, 'access-cache.json'), JSON.stringify({ at: Date.now(), users: { 7: [101, 102] } }));

const db = require('../lib/db');
const V = require('../lib/versions');
const access = require('../lib/access');

(async () => {
  // 1. verze hned po startu
  const l0 = V.getLatest();
  const vs = (l0.versions || l0.mikrotik || {});
  chk('v7-stable ze souboru hned po startu', vs['v7-stable'] && vs['v7-stable'].version === '7.24.2', JSON.stringify(vs['v7-stable']));
  chk('v6-long-term ze souboru hned po startu', vs['v6-long-term'] && vs['v6-long-term'].version === '6.49.23');

  // 2. souběžné stažení 6 kanálů: každé ~200 ms → celkem pod 600 ms, souběžná volání = jedno stažení
  let calls = 0;
  global.fetch = async (url) => { calls++; await new Promise(r => setTimeout(r, 200)); const m = /NEWEST(a7|6)\.(\S+)$/.exec(url); return { ok: true, text: async () => (m[1] === 'a7' ? '7.99.1 1760000001' : '6.99.1 1760000002') }; };
  const t0 = Date.now();
  const p1 = V.refreshLatest(true); const p2 = V.refreshLatest(true);
  const l1 = await p1; await p2;
  const dt = Date.now() - t0;
  chk(`6 kanálů staženo naráz (${dt} ms < 600)`, dt < 600);
  chk('souběžná volání sdílejí jedno stažení (právě 6 fetchů)', calls === 6, String(calls));
  chk('nová v7-stable 7.99.1', l1.versions['v7-stable'].version === '7.99.1');
  chk('nová v6-long-term 6.99.1', l1.versions['v6-long-term'].version === '6.99.1');
  chk('bez chyb', !l1.error, l1.error);
  // chyba jednoho kanálu nechá starou hodnotu a nezastaví ostatní
  global.fetch = async (url) => { calls++; if (/a7\.stable/.test(url)) throw new Error('simulovaný výpadek'); return { ok: true, text: async () => '7.98.0 1' }; };
  const l2 = await V.refreshLatest(true);
  chk('výpadek kanálu = stará hodnota + chyba v error', l2.versions['v7-stable'].version === '7.99.1' && /v7-stable: simulovaný výpadek/.test(l2.error), l2.error);
  chk('ostatní kanály se přesto obnovily', l2.versions['v7-testing'].version === '7.98.0');
  calls = 0; await V.refreshLatest();
  chk('keš do 30 min bez dalšího stahování', calls === 0);

  // 3. mapa přístupu ze souboru hned
  chk('apsOf ze souboru hned po startu', access.apsOf(7).has(101) && access.apsOf(7).has(102) && access.apsOf(7).size === 2, JSON.stringify([...access.apsOf(7)]));
  chk('canAccess podle APčka hned', access.canAccess(7, { owner_id: 1, userdb_ap_id: 102 }) === true);
  chk('cizí APčko ne', access.canAccess(7, { owner_id: 1, userdb_ap_id: 999 }) === false);
  await new Promise(r => setTimeout(r, 300)); // userdb na pozadí selže (odmítnuté spojení) → stará mapa zůstává
  chk('po neúspěšné obnově mapa ze souboru platí dál', access.apsOf(7).has(101));

  // 4. listJobsOpen
  const did = db.insertDevice({ host: '10.0.0.1', port: 22 });
  const j1 = db.createJob('otevřený', { mode: 'upload', x: 1 }, [did], 0);
  const j2 = db.createJob('hotový', { mode: 'upload' }, [did], 0);
  db.updateJob(j2, { status: 'done' });
  const open = db.listJobsOpen();
  chk('listJobsOpen vrací jen otevřené', open.length === 1 && open[0].id === j1, JSON.stringify(open.map(j => [j.id, j.status])));
  chk('options rozparsované', open[0].options && open[0].options.x === 1);
  db.updateJob(j1, { status: 'scheduled' }); chk('scheduled je otevřený', db.listJobsOpen().length === 1);
  db.updateJob(j1, { status: 'failed' }); chk('failed není otevřený', db.listJobsOpen().length === 0);

  // 5. zdrojové kontroly
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const srv = src('server.js'), run = src('lib/runner.js'), app = src('public/app.js'), udb = src('lib/userdb.js');
  const si = srv.indexOf("p === '/api/state')"); const stateRoute = srv.slice(si, srv.indexOf('\n  if (', si + 10));
  chk('/api/state nečeká na refreshLatest', si > 0 && !/await V\.refreshLatest/.test(stateRoute));
  chk('runJob nevynucuje refreshLatest(true)', !/await V\.refreshLatest\(true\)\.catch/.test(run));
  chk('recoverAfterRestart/tickScheduled používají listJobsOpen', (run.match(/db\.listJobsOpen\(\)/g) || []).length >= 2);
  chk('SSE filtr ?job= na serveru', /searchParams\.has\('job'\)/.test(srv));
  chk('klient se připojuje s ?job=', /\/api\/events\?job=/.test(app));
  chk('klient při změně otevřeného jobu přepojí SSE', /function watchJob\(\)/.test(app));
  chk('klient dedupuje řádky logu podle id', /function onLog\(/.test(app));
  chk('userdb má pevný strop odpovědi', /cfg\.timeoutMs \* 3/.test(udb));
  chk('access perzistuje mapu', /access-cache\.json/.test(src('lib/access.js')));

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} kontrol selhalo` : '\nvše OK');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
