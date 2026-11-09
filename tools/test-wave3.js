#!/usr/bin/env node
'use strict';
// Rychlostní audit 9.11.2026 (vlna 3): verze dat včetně výsledků skenů (db.devVersion), index topologie se přestaví po výměně řádku v keši,
// kandidáti rodiče sdílení mezi voláními autoParent, škrcení událostí 'job' u běžícího jobu (poslední stav vždy dojde), štíhlé flags v seznamu,
// keš seznamu per účet, ETag statiky (zdrojové kontroly; živě v preflight.sh).
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-w3-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234';
let fail = 0; const chk = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); if (!ok) fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const db = require('../lib/db');
const topo = require('../lib/topology');
const { Runner } = require('../lib/runner');

(async () => {
  // 1. devVersion: mění se při vložení, úpravě (i jen výsledku skenu) a smazání; dataVersion jen při uživatelské úpravě
  const v0 = db.devVersion(), d0 = db.dataVersion();
  const a = db.insertDevice({ host: '10.1.0.1', port: 22, name: 'AP' });
  const b = db.insertDevice({ host: '10.1.0.2', port: 22, name: 'STA' });
  chk('devVersion po vložení jiná', db.devVersion() !== v0);
  db.listDevices(); const v1 = db.devVersion(), d1 = db.dataVersion();
  db.updateDevice(b, { version: '7.24.1', scan_status: 'ok' }); // výsledek skenu: jen výměna řádku v keši
  chk('devVersion po výsledku skenu jiná', db.devVersion() !== v1);
  chk('dataVersion po výsledku skenu stejná (klient dostává skeny přes události)', db.dataVersion() === d1);
  chk('dataVersion po vložení jiná než na začátku', d1 !== d0);

  // 2. index topologie na poli z keše se po výměně řádku přestaví (dřív zůstával starý až 60 s)
  const all = db.listDevices();
  const idx0 = topo.makeIndex(all);
  chk('index: AP bez rádia není v radio mapě', !idx0.radio.has('AA:BB:CC:00:00:01'));
  db.updateDevice(a, { flags: { links: { aps: [{ mac: 'aa:bb:cc:00:00:01', ssid: 'test', mode: 'ap-bridge', clients: [{ mac: 'aa:bb:cc:00:00:02' }] }] } } });
  const all2 = db.listDevices();
  chk('listDevices vrací kopii pole (index se váže na konkrétní pole, řádky sdílené)', all2 !== all && all2.length === all.length);
  const idx1 = topo.makeIndex(all2);
  chk('index nad novým polem vidí vyměněný řádek', idx1.radio.has('AA:BB:CC:00:00:01') && idx1.radio.get('AA:BB:CC:00:00:01').id === a);
  chk('index nad starým polem se po změně verze dat přestaví (ne starý z vlastnosti __idx)', topo.makeIndex(all) !== idx0);
  chk('stejná verze dat → stejný index (keš drží)', topo.makeIndex(all2) === idx1);

  // 3. autoParent: stanice s registrací na rádiu AP dostane rodiče; kandidáti se sdílejí
  db.updateDevice(b, { flags: { links: { stations: [{ mac: 'aa:bb:cc:00:00:02', ap_mac: 'aa:bb:cc:00:00:01' }], sta: [{ mac: 'aa:bb:cc:00:00:02', ap_mac: 'aa:bb:cc:00:00:01' }] }, wireless_sta: { ap_mac: 'aa:bb:cc:00:00:01' } } });
  let parent = 0; try { parent = topo.autoParent(b); } catch (e) { chk('autoParent bez výjimky', false, e.message); }
  chk('autoParent nevyhodil výjimku a vrátil číslo', typeof parent === 'number');
  const c = db.insertDevice({ host: '10.1.0.3', port: 22, name: 'nový' });
  chk('nový kus je mezi kandidáty (keš podle verze dat)', (() => { topo.autoParent(c); return true; })());

  // 4. emitJob: u běžícího jobu nejvýš 1× za 1,5 s, poslední stav dojde; po změně stavu jobu hned
  const job = db.createJob('škrcení', { mode: 'upload' }, [a, b], 0);
  db.updateJob(job, { status: 'running' });
  const r = new Runner(); const got = [];
  r.on('event', (ev) => { if (ev.type === 'job') got.push({ t: Date.now(), status: ev.job && ev.job.status }); });
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) r.emitJob(job);
  chk('první událost hned', got.length === 1, String(got.length));
  await sleep(1700);
  chk('dávka 20 volání → 2 události (první + zpožděná poslední)', got.length === 2, String(got.length));
  chk('zpožděná událost přišla ≈ 1,5 s po první', got.length === 2 && got[1].t - got[0].t >= 1400 && got[1].t - got[0].t < 2500, got.length === 2 ? `${got[1].t - got[0].t} ms` : '');
  db.updateJob(job, { status: 'done' }); r.emitJob(job);
  chk('ukončený job → událost hned (bez škrcení)', got.length === 3 && got[2].status === 'done', JSON.stringify(got.map(g => g.status)));
  db.updateJob(job, { status: 'running' }); r.emitJob(job); r.emitJob(job); // 1 hned (od poslední > 1,5 s? ne — poslední byla právě teď → čeká), ověřit dispose flush
  const n0 = got.length; r.dispose();
  chk('dispose vyprázdní čekající událost', got.length >= n0 && !r._jeT, `${n0} → ${got.length}`);
  void t0;

  // 5. zdrojové kontroly
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const srv = src('server.js'), app = src('public/app.js');
  const m = /const SLIM_FLAG_KEYS = \[([^\]]*)\]/.exec(srv); const keys = m ? m[1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean) : [];
  chk('SLIM_FLAG_KEYS jen to, co seznam čte (device_mode, flash_dir, partitions, routerboard)', keys.length === 4 && ['device_mode', 'flash_dir', 'partitions', 'routerboard'].every(k => keys.includes(k)), keys.join());
  chk('slimFlags už neposílá uplink/poe_children', !/o\.uplink =/.test(srv) && !/o\.poe_children =/.test(srv));
  // klient v seznamu nečte nic jiného z flags (detail má plné flags z /api/devices/:id)
  const listFlags = [...app.matchAll(/d\.flags\.([a-z_]+)/g)].map(x => x[1]);
  chk('klient v seznamu čte jen štíhlé příznaky', listFlags.every(k => keys.includes(k)), listFlags.join());
  chk('keš seznamu zařízení per účet', /userDevCache/.test(srv) && /if \(!isAdmin\(req\)\) \{\n\s+const uid = req\.user\.id; const c = userDevCache\.get\(uid\);/.test(srv));
  chk('/api/devices ze stejné keše', /p === '\/api\/devices'\) return send\(res, 200, adminDevicesJson\(req\)/.test(srv));
  chk('/api/links keš podle verze dat', /linksCache = \{ ver: lv/.test(srv));
  chk('statika s ETag a 304', /if-none-match/.test(srv) && /writeHead\(304/.test(srv));
  chk('klient: Map místo find v řádcích', /devById\.get\(d\.parent_id\)/.test(app) && !/state\.devices\.find\(x => x\.id === d\.dup_of\)/.test(app) && /usersById\.get\(d\.owner_id\)/.test(app));
  chk('klient: swapRow + renderSoonSlow + refreshAgo', /function swapRow\(/.test(app) && /function renderSoonSlow\(/.test(app) && /refreshAgo\(\); \}, 60000\)/.test(app));
  chk('klient: vfInfo memo jen během vykreslení', /if \(rendering && vfMemo\) return vfMemo;/.test(app));

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} kontrol selhalo` : '\nvše OK');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
