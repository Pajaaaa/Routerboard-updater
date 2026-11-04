#!/usr/bin/env node
'use strict';
// Rozdělení upgradu do dávek (4.11.2026): výběr > N zařízení se rozdělí na víc jobů po N (seřazeno potomci→rodiče), které běží SOUBĚŽNĚ —
// každá dávka je samostatný job spuštěný/naplánovaný hned, žádné čekání na předchozí. Test: HTTP vytvoření s batch_size rozdělí správně,
// dávky NEjsou uspané (batch-hold se nepoužívá), bez dávek / dávka ≥ výběr = jeden job; řetězení (advanceBatch) už v poolu není.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-batch-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin';
process.env.PORT = '28977'; process.env.MTU_SCAN_ALLOW = '10.0.0.0/8'; process.env.MTU_USERDB_USER = ''; process.env.MTU_USERDB_PASS = '';
const db = require('../lib/db');
let fail = 0; const chk = (n, ok, e='') => { console.log(`  ${ok?'✓':'✗'} ${n}${e?' — '+e:''}`); if (!ok) fail++; };
const BASE = 'http://127.0.0.1:28977';
let cookie = '';
const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie?{cookie}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } }, (res) => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { const sc = res.headers['set-cookie']; if (sc) cookie = sc[0].split(';')[0]; let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
  }); r.on('error', reject); if (data) r.write(data); r.end();
});

(async () => {
  require('../server.js');
  await new Promise(r => setTimeout(r, 1500));
  const login = await req('POST', '/api/login', { username: 'admin', password: 'heslotest1234' });
  chk('přihlášení správce', login.status === 200, 'status ' + login.status);
  const ids = [];
  for (let i = 1; i <= 5; i++) { const id = db.insertDevice({ host: '10.0.0.' + i, port: 22, owner_id: 1 }); db.updateDevice(id, { managed: 1, enabled: 1, board_name: 'hEX', version: '7.10', scan_status: 'ok' }); ids.push(id); }

  // dávky po 2 z 5 → 3 joby [2,2,1], jen vytvořit (start:false), ať nic nezkouší SSH
  const r1 = await req('POST', '/api/jobs', { name: 'test', deviceIds: ids, start: false, options: { dry_run: true, batch_size: 2, precheck: false } });
  chk('odpověď nese batch count 3', r1.status === 200 && r1.body && r1.body.batch && r1.body.batch.count === 3, JSON.stringify(r1.body && r1.body.batch));
  const created = (r1.body.batch && r1.body.batch.ids) || [];
  const jobs = created.map(id => db.getJob(id));
  chk('3 joby vytvořeny', jobs.length === 3 && jobs.every(Boolean));
  chk('velikosti dávek 2,2,1', JSON.stringify(jobs.map(j => db.getJobItems(j.id).length)) === '[2,2,1]', JSON.stringify(jobs.map(j => db.getJobItems(j.id).length)));
  chk('ŽÁDNÁ dávka není batch-hold (souběžně, ne řetěz)', jobs.every(j => j.status !== 'batch-hold'), jobs.map(j=>j.status).join(','));
  chk('batch metadata index/total', jobs.map(j=>`${j.options.batch.index}/${j.options.batch.total}`).join(' ') === '1/3 2/3 3/3');
  chk('dávky mají disjunktní zařízení (lze spustit naráz)', (() => { const all = jobs.flatMap(j => db.getJobItems(j.id).map(it => it.device_id)); return new Set(all).size === all.length && all.length === 5; })());
  chk('všechny dávky ve výpisu jobů', db.listJobs(50).filter(j => created.includes(j.id)).length === 3);

  const r2 = await req('POST', '/api/jobs', { name: 'jeden', deviceIds: ids, start: false, options: { dry_run: true, batch_size: 0, precheck: false } });
  chk('bez dávek jeden job, žádné batch', r2.body && !r2.body.batch && db.getJob(r2.body.id) && !db.getJob(r2.body.id).options.batch);
  const r3 = await req('POST', '/api/jobs', { name: 'velka davka', deviceIds: ids, start: false, options: { dry_run: true, batch_size: 10, precheck: false } });
  chk('dávka ≥ výběr → jeden job', r3.body && !r3.body.batch);

  const { RunnerPool } = require('../lib/runner');
  chk('advanceBatch (řetězení) v poolu už není', typeof RunnerPool.prototype.advanceBatch === 'undefined');

  console.log(fail ? `\n${fail} chyb` : '\nvše v pořádku');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
