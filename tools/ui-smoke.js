#!/usr/bin/env node
'use strict';
// Vykreslení všech pohledů UI bez prohlížeče (minimální náhrada DOM). Chytá ReferenceError/TypeError v šablonách,
// projde všechna řazení a filtry seznamu zařízení, přehled jobů, nápovědu, nastavení i správu. Spouští tools/preflight.sh.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const mk = () => { const el = { innerHTML: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, hidden: false, open: false, elements: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, children: [], querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, insertAdjacentHTML() {}, insertAdjacentElement() {}, appendChild() {}, remove() {}, focus() {}, reset() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ top: 0 }) }; for (const k of ['onclick', 'onchange', 'onsubmit', 'ontoggle', 'oninput', 'onkeydown']) Object.defineProperty(el, k, { set() {}, get() { return null; } }); return el; };
global.window = { location: { search: '', pathname: '/mikrotik/', href: 'http://x/mikrotik/' }, innerHeight: 800, scrollY: 0, addEventListener() {}, matchMedia: () => ({ matches: false }), scrollTo() {} };
global.document = { body: mk(), documentElement: { scrollHeight: 0 }, getElementById: () => mk(), querySelector: () => mk(), querySelectorAll: () => [], createElement: () => mk(), addEventListener() {}, title: '' };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = window.location; global.EventSource = function () { this.close = () => {}; }; global.FormData = function () { return { get: () => '', entries: () => [] }; };
global.fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '', headers: { get: () => 'application/json' } });
global.MutationObserver = function () { this.observe = () => {}; };
global.confirm = () => false; global.prompt = () => null; global.alert = () => {}; global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
let m = { exports: {} };
try { new Function('module', src + '\nmodule.exports = { state, renderDevices, renderSettings, renderJobs, renderHelp, renderJobDetail };')(m); }
catch (e) { console.error('app.js se nenačetl:', e.message); process.exit(1); }
const { state: S, renderDevices, renderSettings, renderJobs, renderHelp, renderJobDetail } = m.exports;
const dev = (id, extra) => ({ id, host: `10.0.0.${id}`, port: 22, name: `d${id}`, identity: `d${id}`, version: '7.24.2', board_name: 'RB', arch: 'arm', scan_status: 'ok', enabled: true, managed: true, track: 'v7-stable', owner_id: 1, flags: { uplink: { gateway: '10.0.0.1', iface: 'ether1', neighbor: null }, poe_children: [] }, parent_id: 0, packages: [], priority: 100, fw_current: '7.24.2', fw_upgrade: '7.24.2', total_hdd: 16e6, free_hdd: 2e6, total_mem: 64e6, free_mem: 30e6, last_seen_at: 1, last_scan_at: 1, ...extra });
const job = (id, extra) => ({ id, name: `job ${id}`, status: 'running', status_note: '', options: {}, counts: {}, total: 1, owner_id: 1, owner_name: 'x', created_at: 1, ...extra });
Object.assign(S, { authed: true, admin: true, auth: { sso: true, passwordLogin: false, user: { id: 1, name: 'x' }, userdb: { enabled: true, uid: 1, nick: 'n' }, serverStartedAt: Date.now(), sourceIp: '192.0.2.10', draining: false }, users: [{ id: 1, name: 'x', role: 'admin', userdb_uid: 1, userdb_nick: 'n' }], settings: { min_uptime_min: 10, default_track: 'v7-stable', allow_registration: false }, settingsOwn: {}, settingsGlobal: { min_uptime_min: 10, default_track: 'v7-stable' }, tracks: ['v7-stable', 'v7-long-term', 'v6-long-term', 'hold'], stats: { total: 3, upToDate: 1, needs: 1, stayV6: 0, unreachable: 1, upgrading: 0, hold: 0, never: 0, dead: 0, upgradedToday: 0, upgradedTotal: 0, failedTotal: 0, failedToday: 0, jobsRunning: 0, users: 1 }, runner: { running: false, busy: [], jobs: [], others: [{ uid: 5, user: 'u', total: 3, done: 1, jobs: 1 }] }, scanning: [], selected: new Set(), latest: { versions: { 'v7-stable': { version: '7.24.2' }, 'v7-long-term': { version: '7.23.5' }, 'v6-long-term': { version: '6.49.21' } } } });
S.devices = [dev(1), dev(2, { version: '6.49.10', parent_id: 1, userdb_member: 5, userdb_ap: 'AP', dup_of: 0 }), dev(3, { scan_status: 'unreachable', parent_id: 99, parent_foreign: { name: 'cizí', user: 'jiný' }, track: 'v6-long-term' }), dev(4, { dup_of: 1, enabled: false })];
S.jobs = [job(1, { current: { dev: 'd1', step: 'čekám na návrat routeru (1 min)', status: 'reboot' } }), job(2, { status: 'paused', status_note: 'aktualizace serveru — job pokračuje automaticky po restartu' }), job(3, { status: 'scheduled', options: { start_at: 1e10, early_precheck: { at: Date.now(), ready: 1, blocked: 1, warned: 0, reasons: ['x: y'], warns: [] } } }), job(4, { status: 'done', counts: { done: 1 } }), job(5, { status: 'queued', status_note: 'server se za chvíli aktualizuje — job se spustí hned po restartu' })];
let fail = 0;
const run = (name, f) => { const el = mk(); try { f(el); if (!el.innerHTML || el.innerHTML.length < 50) throw new Error('prázdný výstup'); console.log(`  ${name}: OK (${el.innerHTML.length} znaků)`); } catch (e) { fail++; console.log(`  ${name}: CHYBA ${e.message}`); } };
for (const adv of [false, true]) {
  S.advanced = adv;
  for (const srt of ['tree', 'priority', 'name', 'version', 'model', 'seen', 'status', 'firmware', 'track', 'owner', 'host']) for (const dir of ['asc', 'desc']) { S.sort = srt; S.sortDir = dir; run(`zařízení adv=${adv} sort=${srt}/${dir}`, renderDevices); }
  for (const vf of ['', 'v6', 'v7', 'need', 'ok', 'bad']) { S.vf = vf; run(`zařízení filtr=${vf || 'vše'}`, renderDevices); }
  S.vf = ''; S.owner = 1; run(`zařízení vlastník adv=${adv}`, renderDevices); S.owner = 0;
  run(`upgrady adv=${adv}`, renderJobs);
  run(`nastavení adv=${adv}`, (el) => renderSettings(el));
  run(`správa adv=${adv}`, (el) => renderSettings(el, true));
}
run('nápověda', renderHelp);
// detail jobu s položkami a logem (prefix zařízení, filtr důležitých řádků, filtr podle zařízení)
{
  const items = [{ id: 1, job_id: 1, device_id: 1, status: 'done', host: '10.0.0.1', dev_name: 'd1', identity: 'd1', board_name: 'RB', from_version: '7.23.1', to_version: '7.24.2', warnings: ['w'], plan: { canary: true } }, { id: 2, job_id: 1, device_id: 2, status: 'reboot', host: '10.0.0.2', dev_name: '', identity: 'd2', board_name: 'RB', step: 'restart', warnings: [] }];
  S.job = { job: job(1, { current: { dev: 'd2', step: 'restart', status: 'reboot' } }), items };
  S.jobLog = [{ id: 1, job_id: 1, item_id: 0, device_id: 0, ts: Date.now(), level: 'info', msg: 'Job "x" spuštěn' }, { id: 2, job_id: 1, item_id: 1, device_id: 1, ts: Date.now(), level: 'info', msg: '=== d1 (10.0.0.1) — začínám ===' }, { id: 3, job_id: 1, item_id: 1, device_id: 1, ts: Date.now(), level: 'info', msg: 'SSH připojeno' }, { id: 4, job_id: 1, item_id: 2, device_id: 2, ts: Date.now(), level: 'warn', msg: 'varování' }, { id: 5, job_id: 1, item_id: 2, device_id: 2, ts: Date.now(), level: 'error', msg: 'CHYBA: x' }];
  const held = document.querySelector; const det = mk(); document.querySelector = (s) => s === '#jobdetail' ? det : mk();
  for (const adv of [false, true]) { S.advanced = adv; S.logDev = adv ? 2 : 0; run(`detail jobu adv=${adv}`, (el) => { renderJobDetail(); el.innerHTML = det.innerHTML; if (!det.innerHTML.includes('d1 · 10.0.0.1')) throw new Error('chybí prefix zařízení v logu'); if (!det.innerHTML.includes('class="info lo"')) throw new Error('chybí označení nedůležitého řádku'); }); }
  document.querySelector = held;
}
S.admin = false; S.users = null; S.settingsGlobal = undefined; run('zařízení jako uživatel', renderDevices); run('nastavení jako uživatel', (el) => renderSettings(el)); run('upgrady jako uživatel', renderJobs);
if (fail) { console.error(`UI smoke: ${fail} chyb`); process.exit(1); }
console.log('UI smoke OK');
