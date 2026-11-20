#!/usr/bin/env node
'use strict';
// Pohled řadového správce (20.11.2026): správce nástroje si přepne cookie mtu_asuser a server ho vyhodnotí jako roli „user“ —
// nevidí cizí zařízení ani správcovská API; přepnout smí jen skutečný správce a jde to vrátit.
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-viewas-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, DATA_DIR: dir, MTU_SECRET: 'test-secret-1234567890', MTU_PASSWORD: 'heslo-spravce-1', PORT: String(PORT), BASE_PATH: '', USERDB_URL: '', USERDB_KEY: '', RBDB_URL: '', SSO_ISSUER: '' };
process.env.DATA_DIR = dir; process.env.MTU_SECRET = env.MTU_SECRET; process.env.MTU_PASSWORD = env.MTU_PASSWORD;
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
const base = `http://127.0.0.1:${PORT}`;
const jar = {};
async function call(p, opts = {}) {
  const r = await fetch(base + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: Object.entries(opts.jar || jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) (opts.jar || jar)[k] = v; else delete (opts.jar || jar)[k]; }
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
(async () => {
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 250)); try { up = (await fetch(base + '/api/whoami')).ok; } catch {} }
    if (!up) throw new Error('server nenaběhl:\n' + out);
    let w = (await call('/api/whoami')).j;
    const adminName = (w.user && w.user.name) || 'admin';
    if (!w.authed) { const r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: env.MTU_PASSWORD } }); if (r.status !== 200) throw new Error('přihlášení správce selhalo: ' + JSON.stringify(r.j)); w = (await call('/api/whoami')).j; }
    chk(w.admin === true && w.user.canAdmin === true && !w.user.asUser, 'správce: admin=true, canAdmin, bez asUser');
    // cizí zařízení (jiný vlastník) + vlastní
    const r1 = await call('/api/users', { method: 'POST', body: { name: 'kolega', password: 'heslo-kolega-1', role: 'user' } });
    chk(r1.status === 200, 'správce založí účet');
    const users = (await call('/api/users')).j; const kolega = users.find(u => u.name === 'kolega'); const me = users.find(u => u.role === 'admin');
    const db = require('../lib/db');
    db.insertDevice({ host: '10.0.0.1', port: 22, owner_id: me.id }); db.insertDevice({ host: '10.0.0.2', port: 22, owner_id: kolega.id });
    // server drží seznam zařízení v keši → vynutit přes restart není třeba: /api/state čte db.listDevices (jiný proces zapisuje do téže SQLite)
    const devs = async () => ((await call('/api/state')).j.devices || []).map(d => d.host).sort().join(',');
    // zařízení zapsal tento proces vedle běžícího serveru — ten drží seznam v keši až 60 s, tak chvíli počkat
    for (let i = 0; i < 140 && await devs() !== '10.0.0.1,10.0.0.2'; i++) await new Promise(r => setTimeout(r, 500));
    const before = await devs();
    chk(before === '10.0.0.1,10.0.0.2', 'správce vidí obě zařízení (' + before + ')');
    const sw = await call('/api/view-as', { method: 'POST', body: { user: true } });
    chk(sw.status === 200 && jar.mtu_asuser === '1', 'přepnutí do pohledu řadového správce nastaví cookie');
    w = (await call('/api/whoami')).j;
    chk(w.admin === false && w.user.role === 'user' && w.user.asUser === true && w.user.canAdmin === true, 'po přepnutí: admin=false, role user, asUser, canAdmin zůstává');
    const after = await devs();
    chk(after === '10.0.0.1', 'v pohledu řadového vidí jen své zařízení (' + after + ')');
    chk((await call('/api/users')).status === 403, 'správcovské API (/api/users) vrací 403');
    const st = (await call('/api/state')).j;
    chk(st.admin === false && st.settingsGlobal === undefined, 'stav: admin=false, bez společného nastavení');
    const back = await call('/api/view-as', { method: 'POST', body: { user: false } });
    w = (await call('/api/whoami')).j;
    chk(back.status === 200 && !jar.mtu_asuser && w.admin === true && !w.user.asUser, 'přepnutí zpět vrátí správce');
    chk(await devs() === '10.0.0.1,10.0.0.2', 'správce zase vidí všechno');
    // běžný účet přepínat nesmí a cookie mu nic nedá
    const j2 = {};
    const l2 = await call('/api/login', { method: 'POST', body: { username: 'kolega', password: 'heslo-kolega-1' }, jar: j2 });
    chk(l2.status === 200, 'běžný účet se přihlásí');
    chk((await call('/api/view-as', { method: 'POST', body: { user: false }, jar: j2 })).status === 403, 'běžný účet nesmí /api/view-as');
    const w2 = (await call('/api/whoami', { jar: j2 })).j;
    chk(w2.admin === false && !w2.user.canAdmin, 'běžný účet nemá canAdmin');
  } catch (e) { console.error(e.stack || e); bad++; }
  srv.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(bad ? `\nSELHALO: ${bad}` : '\nvše v pořádku');
  process.exit(bad ? 1 : 0);
})();
