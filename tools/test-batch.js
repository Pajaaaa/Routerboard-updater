#!/usr/bin/env node
'use strict';
// Rozdělení upgradu do dávek (4.11.2026): výběr > N zařízení se rozdělí na víc jobů po N, seřazených potomci→rodiče, zřetězených tak,
// že další dávka (status batch-hold) se spustí teprve po dokončení předchozí (runner.advanceBatch). Test: (1) HTTP vytvoření jobu s
// batch_size rozdělí a zřetězí; bez dávek vznikne jeden job. (2) advanceBatch spustí následující jen po status done a jen z batch-hold.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-batch-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin';
process.env.PORT = '28977'; process.env.MTU_SCAN_ALLOW = '10.0.0.0/8'; process.env.MTU_USERDB_USER = ''; process.env.MTU_USERDB_PASS = '';
const db = require('../lib/db');
let fail = 0; const chk = (n, ok, e='') => { console.log(`  ${ok?'✓':'✗'} ${n}${e?' — '+e:''}`); if (!ok) fail++; };

// --- část 1: HTTP vytvoření ---
const BASE = 'http://127.0.0.1:28977';
let cookie = '';
const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie?{cookie}:{}) , ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } }, (res) => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { const sc = res.headers['set-cookie']; if (sc) cookie = sc[0].split(';')[0]; let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
  }); r.on('error', reject); if (data) r.write(data); r.end();
});

(async () => {
  require('../server.js');
  await new Promise(r => setTimeout(r, 1500));
  const login = await req('POST', '/api/login', { username: 'admin', password: 'heslotest1234' });
  chk('přihlášení správce', login.status === 200, 'status ' + login.status);
  // vlož 5 řízených zařízení (bez topologie)
  const ids = [];
  for (let i = 1; i <= 5; i++) { const id = db.insertDevice({ host: '10.0.0.' + i, port: 22, owner_id: 1 }); db.updateDevice(id, { managed: 1, enabled: 1, board_name: 'hEX', version: '7.10', scan_status: 'ok' }); ids.push(id); }

  // dávky po 2 z 5 → 3 joby [2,2,1], jen vytvořit (start:false), ať nic neběží
  const r1 = await req('POST', '/api/jobs', { name: 'test', deviceIds: ids, start: false, options: { dry_run: true, batch_size: 2, precheck: false } });
  chk('odpověď nese batch', r1.status === 200 && r1.body && r1.body.batch && r1.body.batch.count === 3, JSON.stringify(r1.body && r1.body.batch));
  const created = (r1.body.batch && r1.body.batch.ids) || [];
  const jobs = created.map(id => db.getJob(id));
  chk('3 joby vytvořeny', jobs.length === 3 && jobs.every(Boolean));
  const counts = jobs.map(j => db.getJobItems(j.id).length);
  chk('velikosti dávek 2,2,1', JSON.stringify(counts) === '[2,2,1]', JSON.stringify(counts));
  chk('první není batch-hold, zbytek ano', jobs[0].status !== 'batch-hold' && jobs[1].status === 'batch-hold' && jobs[2].status === 'batch-hold', jobs.map(j=>j.status).join(','));
  chk('zřetězení next', jobs[0].options.batch.next === jobs[1].id && jobs[1].options.batch.next === jobs[2].id && !jobs[2].options.batch.next);
  chk('index/total', jobs.map(j=>`${j.options.batch.index}/${j.options.batch.total}`).join(' ') === '1/3 2/3 3/3');
  chk('batch-hold je ve výpisu jobů', db.listJobs(50).filter(j => created.includes(j.id)).length === 3);

  // bez dávek → jeden job
  const r2 = await req('POST', '/api/jobs', { name: 'jeden', deviceIds: ids, start: false, options: { dry_run: true, batch_size: 0, precheck: false } });
  chk('bez dávek jeden job, žádné batch', r2.body && !r2.body.batch && db.getJob(r2.body.id) && !db.getJob(r2.body.id).options.batch);
  // batch_size >= počet → jeden job
  const r3 = await req('POST', '/api/jobs', { name: 'velka davka', deviceIds: ids, start: false, options: { dry_run: true, batch_size: 10, precheck: false } });
  chk('dávka větší než výběr → jeden job', r3.body && !r3.body.batch);

  // --- část 2: advanceBatch (jednotkově) ---
  const { RunnerPool } = require('../lib/runner');
  const pool = new RunnerPool();
  const startedNow = [];
  pool.startOrQueue = (jid) => { startedNow.push(jid); db.updateJob(jid, { status: 'running' }); return { queued: false }; };

  // řetěz A→B→C; A done → spustí jen B
  const A = jobs[0].id, B = jobs[1].id, C = jobs[2].id;
  db.updateJob(A, { status: 'done' });
  pool.advanceBatch(A);
  chk('po dokončení A se spustí B (ne C)', startedNow.join(',') === String(B), 'spuštěno: ' + startedNow.join(','));
  chk('B už není batch-hold', db.getJob(B).status === 'running');
  startedNow.length = 0;
  // B ještě neskončil (running) → advanceBatch(A) znovu nic (B není batch-hold)
  pool.advanceBatch(A); chk('opakované dokončení A nespustí nic (B už neběží v hold)', startedNow.length === 0);
  // B done → spustí C
  db.updateJob(B, { status: 'done' }); pool.advanceBatch(B);
  chk('po dokončení B se spustí C', startedNow.join(',') === String(C));
  startedNow.length = 0;
  // zastavená dávka řetěz nepustí dál: nový řetěz D(paused)→E(hold)
  const D = db.createJob('D', { batch: { group:'g', index:1, total:2, next:0 } }, [ids[0]], 1);
  const E = db.createJob('E', { batch: { group:'g', index:2, total:2, next:0 } }, [ids[1]], 1);
  db.updateJob(D, { status: 'paused', options: { batch: { group:'g', index:1, total:2, next: E } } });
  db.updateJob(E, { status: 'batch-hold' });
  pool.advanceBatch(D);
  chk('zastavená dávka (paused) nespustí další', startedNow.length === 0 && db.getJob(E).status === 'batch-hold');

  console.log(fail ? `\n${fail} chyb` : '\nvše v pořádku');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
