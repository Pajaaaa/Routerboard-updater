#!/usr/bin/env node
'use strict';
// UI v opravdovém DOM (jsdom) proti běžícímu serveru: přihlásí se, projde všechny pohledy jako správce i uživatel,
// s přihlášením heslem i bez něj (jen SSO), a hlídá, že nic nevyhodí výjimku a že klíčové prvky existují.
// Doplňuje tools/ui-smoke.js (ten má jen náhradu DOM a neodhalí chybějící prvky). Spouští tools/preflight.sh.
// Použití: node tools/ui-real.js <url serveru> <uživatel> <heslo>
const fs = require('fs'), path = require('path');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch { console.log('ui-real: jsdom není nainstalován (npm install), přeskakuji'); process.exit(0); }
const [BASEURL, USER, PASS] = [process.argv[2] || 'http://127.0.0.1:28999', process.argv[3] || 'preflight', process.argv[4] || 'preflight-heslo'];
const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');
const errors = [];
const { VirtualConsole } = require('jsdom');
const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(String(e && e.message || e))); vc.on('error', (m) => errors.push(String(m)));
const dom = new JSDOM(html, { url: BASEURL + '/mikrotik/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
let cookie = '';
w.fetch = async (url, opts = {}) => {
  const r = await fetch(url.startsWith('http') ? url : BASEURL + url, { ...opts, headers: { ...(opts.headers || {}), cookie }, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r;
};
w.EventSource = function () { this.close = () => {}; };
w.scrollTo = () => {}; w.confirm = () => false; w.prompt = () => null; w.alert = () => {};
// app.js se vkládá jako obyčejný skript (jeho const/function musí zůstat globální); pozdější úryvky se balí do try, aby výjimka doputovala sem
const run = (code, raw = false) => { const sc = w.document.createElement('script'); sc.textContent = raw ? code : `try { ${code} } catch (e) { window.__p = Promise.reject(e); }`; w.document.body.appendChild(sc); return w.__p; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${name}: ${ok ? 'OK' : 'CHYBA'}${extra ? ' ' + extra : ''}`); if (!ok) fail++; };
(async () => {
  run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), true);
  await sleep(500);
  await run(`window.__p = api('/login', { method: 'POST', body: { username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} } })`);
  await run('window.__p = loadState()');
  await run('state.authed = true; render(); window.__p = 1');
  await sleep(300);
  // klíčové prvky, které musí v daném pohledu existovat
  const expect = { devices: ['#vfilter', '#sort'], jobs: [], help: [], settings: ['#setf-mine'], admin: ['#setf', '#userlist', '#auditbox'] };
  for (const pw of [true, false]) {
    for (const admin of [true, false]) {
      for (const view of ['devices', 'jobs', 'help', 'settings', 'admin']) {
        if (view === 'admin' && !admin) continue;
        const before = errors.length;
        let err = '';
        try { await run(`state.auth.passwordLogin = ${pw}; state.admin = ${admin}; state.view = '${view}'; render(); window.__p = 1`); } catch (e) { err = e && e.message || String(e); }
        await sleep(400);
        const m = w.document.querySelector('#main');
        const missing = (expect[view] || []).filter(sel => !w.document.querySelector(sel));
        const newErr = errors.slice(before);
        check(`${view} (heslo=${pw ? 'ano' : 'ne'}, ${admin ? 'správce' : 'uživatel'})`, !err && m && m.innerHTML.length > 200 && !missing.length && !newErr.length, [err, missing.length ? 'chybí ' + missing.join(', ') : '', newErr.join('; ')].filter(Boolean).join(' | '));
      }
    }
  }
  // detail zařízení (modální okno) s několika řádky logu — logLine má 2. parametr, map(logLine) by podstrčil index (9.9.2026)
  {
    const before = errors.length; let err = '';
    try { await run("state.modal = { type: 'detail', data: { device: { id: 1, host: '10.0.0.1', port: 22, name: 'd1', identity: 'd1', version: '7.24.2', channel: 'stable', board_name: 'RB', model: 'RB', arch: 'arm', scan_status: 'ok', enabled: true, managed: true, track: 'v7-stable', eff_track: 'v7-stable', owner_id: 1, fw_current: '7.24.2', fw_upgrade: '7.24.2', total_hdd: 16e6, free_hdd: 3e6, total_mem: 256e6, free_mem: 100e6, uptime_sec: 1000, packages: [], flags: { wireless: 1, links: { stations: [], aps: [], w60g: [] }, device_mode: { mode: 'enterprise', flagged: false }, ip_addresses: ['10.0.0.1'] }, last_scan_at: 1, last_seen_at: 1, no_v7: [], parent_id: 0 }, history: [{ version: '7.24.2', seen_at: 1, source: 'scan' }], backups: [], log: [1, 2, 3].map(i => ({ id: i, job_id: 1, item_id: 1, device_id: 1, ts: Date.now(), level: 'info', msg: 'řádek ' + i })), plan: null } }; renderModal(); window.__p = 1"); } catch (e) { err = e && e.message || String(e); }
    await sleep(200);
    const modal = w.document.querySelector('#modalbg .modal');
    check('detail zařízení (modal, 3 řádky logu)', !err && !!modal && !errors.slice(before).length, [err, errors.slice(before).join('; ')].filter(Boolean).join(' | '));
    await run('closeModal(); window.__p = 1');
  }
  // Upgrady: výběr počtu (10/20/30/50/vše) musí reagovat na změnu — přenastavit stav, znovu vykreslit a dotáhnout širší seznam ze serveru (9.9.2026)
  {
    const before = errors.length; let err = '';
    try { await run("state.admin = true; state.jobOwner = 0; state.view = 'jobs'; render(); window.__p = 1"); await sleep(300);
      await run("const sel = document.querySelector('#joblimit'); if (!sel) throw new Error('chybí #joblimit'); sel.value = '50'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); window.__p = 1"); await sleep(800);
      await run("if (state.jobsLimit !== 50) throw new Error('jobsLimit=' + state.jobsLimit); const s2 = document.querySelector('#joblimit'); if (!s2 || s2.value !== '50') throw new Error('select po překreslení: ' + (s2 && s2.value)); window.__p = 1");
      await run("const sel = document.querySelector('#joblimit'); sel.value = '0'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); window.__p = 1"); await sleep(800);
      await run("if (state.jobsLimit !== 0) throw new Error('jobsLimit=' + state.jobsLimit); if (!/všech/.test(document.querySelector('#main h2').textContent)) throw new Error('hlavička: ' + document.querySelector('#main h2').textContent.slice(0, 60)); window.__p = 1");
    } catch (e) { err = e && e.message || String(e); }
    check('Upgrady: výběr počtu reaguje (50, vše)', !err && !errors.slice(before).length, [err, errors.slice(before).join('; ')].filter(Boolean).join(' | '));
    await run("state.jobsLimit = 10; window.__p = 1");
  }
  // seznam účtů v Správě se musí naplnit (i bez přihlašování heslem)
  await run("state.auth.passwordLogin = false; state.admin = true; state.view = 'admin'; render(); window.__p = 1"); await sleep(800);
  const ul = w.document.querySelector('#userlist');
  check('Správa: seznam účtů naplněný', !!(ul && ul.querySelector('table tbody tr')), ul ? ul.textContent.slice(0, 80) : 'chybí #userlist');
  if (fail) { console.error(`UI real DOM: ${fail} chyb`); process.exit(1); }
  console.log('UI real DOM OK');
  process.exit(0);
})().catch(e => { console.error('ui-real selhal:', e && e.stack || e); process.exit(1); });
