'use strict';
const { devLabel } = require('./lib/label');
const { hostAllowed } = require('./lib/netaddr');
const http = require('http');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const cfg = require('./lib/config');
const db = require('./lib/db');
const { encrypt, decrypt, makeSession, checkSession, hashPassword, verifyPassword } = require('./lib/crypto');
const V = require('./lib/versions');
const { RunnerPool } = require('./lib/runner');
const { Scanner } = require('./lib/scanner');
const { plan, effectiveTrack, NO_V7, KNOWN_BAD, GLOBAL_BAD } = require('./lib/planner');
const sso = require('./lib/sso');
const { Discovery } = require('./lib/discovery');

const bus = new EventEmitter();
bus.setMaxListeners(200);
const runner = new RunnerPool(); // jeden runner na uživatele
runner.on('event', (ev) => bus.emit('event', ev));
const scanner = new Scanner(runner, bus);
const discovery = new Discovery(bus);
// nově nalezená zařízení ze skenu rozsahu hned plně naskenovat (uptime, místo, topologie…)
bus.on('event', (ev) => { if (ev.type === 'discovery-done' && ev.state) { const ids = (ev.state.found || []).filter(f => f.id).map(f => f.id); if (ids.length) scanner.scanAll(ids, { ownerId: ev.state.ownerId || 0, tag: 'discovery' }).catch(() => {}); } });

const { suggestParent } = require('./lib/topology');
const userdb = require('./lib/userdb');
/** do seznamu zařízení jdou jen příznaky, které UI používá; velké struktury (sousedé, rádia, balíčky) zůstávají v detailu zařízení */
const SLIM_FLAG_KEYS = ['bgp', 'caps_client', 'capsman', 'device_mode', 'flash_dir', 'mpls', 'ospf', 'platform', 'poe_ports', 'routing_filter', 'wifi', 'wireless', 'partitions', 'partitions_list', 'routerboard', 'w60g', 'wifiwave2', 'protected_routerboot', 'voltage', 'temperature', 'user_policy_missing', 'log_symptoms'];
function slimFlags(f) {
  if (!f || typeof f !== 'object') return f;
  const o = {};
  for (const k of SLIM_FLAG_KEYS) if (k in f) o[k] = f[k];
  if (f.uplink) o.uplink = { gateway: f.uplink.gateway, iface: f.uplink.iface, neighbor: f.uplink.neighbor || null };
  if (Array.isArray(f.poe_children)) o.poe_children = f.poe_children.map(k => ({ iface: k.iface, address: k.address, identity: k.identity }));
  return o;
}
const slimDevice = (d) => d && d.flags ? { ...d, flags: slimFlags(d.flags), packages: undefined } : d;
// nastavení podle vlastníka zařízení (per uživatel), načtené jednou za volání — ne dotaz do DB na každé zařízení
function settingsByOwner() { const m = new Map(); return (uid) => { const k = uid || 0; if (!m.has(k)) m.set(k, db.getSettings(k || undefined)); return m.get(k); }; }
function withSuggestions(devs) {
  // no_v7: pravidla ze seznamu HW bez v7, která na zařízení sedí (UI podle toho ukáže „povolit v7“ jen tam, kde má smysl)
  // parent_foreign: rodič, kterého uživatel nevidí (zařízení jiného vlastníka) — jen název a kdo ho má
  // suggested_parent jen u zařízení bez rodiče (jinde se nepoužije); vyhledávání přes index, ne O(n²)
  const visible = new Set(devs.map(d => d.id));
  const byId = new Map(devs.map(d => [d.id, d]));
  let allMap = null; const userNames = new Map();
  const foreignParent = (d) => {
    if (!d.parent_id || visible.has(d.parent_id)) return null;
    if (!allMap) allMap = new Map(db.listDevices().map(x => [x.id, x]));
    const p = allMap.get(d.parent_id); if (!p) return null;
    if (!userNames.has(p.owner_id)) { const u = db.getUser(p.owner_id); userNames.set(p.owner_id, u ? (u.userdb_nick || u.name) : ''); }
    return { name: devLabel(p), user: userNames.get(p.owner_id) };
  };
  void byId;
  const sc = settingsByOwner();
  return devs.map(d => { const rules = NO_V7.filter(r => { try { return r.test(d); } catch { return false; } }); const eff = effectiveTrack(d, sc(d.owner_id)); return { ...slimDevice(d), suggested_parent: d.parent_id ? null : suggestParent(d, devs), parent_foreign: foreignParent(d), no_v7: rules.map(r => r.why), no_v7_hard: rules.some(r => r.hard), eff_track: eff }; });
}

const { targetFor } = require('./lib/planner');
let statsCache = { at: 0, value: null };
/** statistika sítě pro proužek nahoře — počítá se nejvýš jednou za 15 s (prochází všechna zařízení; ptá se každý otevřený prohlížeč)
 */
function networkStats() {
  if (statsCache.value && Date.now() - statsCache.at < 15000) return statsCache.value;
  const value = networkStatsCompute();
  statsCache = { at: Date.now(), value };
  return value;
}
function networkStatsCompute() {
  const latest = V.getLatest();
  const devs = db.listDevices().filter(d => d.managed);
  const busy = new Set(runner.running().map(x => x.deviceId).filter(Boolean));
  const st = { total: devs.length, upToDate: 0, needs: 0, stayV6: 0, unreachable: 0, upgrading: busy.size, hold: 0, never: 0, dead: 0 };
  const sc = settingsByOwner();
  for (const d of devs) {
    const eff = effectiveTrack(d, sc(d.owner_id));
    if (eff === 'hold') st.hold++;
    if (eff === 'v6-long-term') st.stayV6++;
    if (!d.enabled) continue;
    if (d.scan_status === 'never' || !d.version) { st.never++; continue; }
    if (d.scan_status !== 'ok') {
      st.unreachable++;
      // umřelo po upgradu: nedostupné od svého upgradu, nebo poslední položka jobu skončila „nevrátil se"
      const lastItem = db.db.prepare('SELECT status, error FROM job_items WHERE device_id=? ORDER BY id DESC LIMIT 1').get(d.id);
      if ((d.last_upgrade_at && (!d.last_seen_at || d.last_seen_at <= d.last_upgrade_at + 60)) || (lastItem && lastItem.status === 'failed' && /nevrátil/.test(lastItem.error || ''))) st.dead++;
      continue;
    }
    const t = targetFor(eff, latest);
    if (!t) continue;
    const c = V.cmpVersion(d.version, t);
    if (Number.isFinite(c) && c < 0) st.needs++; else st.upToDate++;
  }
  const day0 = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
  const q = (sql, ...a) => db.db.prepare(sql).get(...a).n;
  st.upgradedToday = q("SELECT COUNT(DISTINCT device_id) n FROM version_history WHERE source='upgrade' AND seen_at>=?", day0);
  st.upgradedTotal = q("SELECT COUNT(DISTINCT device_id) n FROM version_history WHERE source='upgrade'");
  st.failedTotal = q("SELECT COUNT(*) n FROM job_items ji JOIN jobs j ON j.id=ji.job_id WHERE ji.status='failed' AND j.options NOT LIKE '%\"dry_run\":true%'");
  st.failedToday = q("SELECT COUNT(*) n FROM job_items ji JOIN jobs j ON j.id=ji.job_id WHERE ji.status='failed' AND ji.finished_at>=? AND j.options NOT LIKE '%\"dry_run\":true%'", day0);
  st.jobsRunning = runner.running().length;
  st.users = db.listUsers().filter(u => !u.disabled).length;
  return st;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const TRACKS = ['v7-stable', 'v7-long-term', 'v6-long-term', 'hold'];

// ---------- pomocné ----------
function send(res, code, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > limit) { reject(new Error('tělo požadavku je příliš velké')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('neplatný JSON')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const loginAttempts = new Map();
/** přihlášení heslem: podle MTU_PASSWORD_LOGIN (yes / local = jen přímo z localhostu bez proxy / no) */
function pwLoginAllowed(req) {
  const m = cfg.passwordLogin;
  if (m === 'yes' || m === 'true' || m === '1') return true;
  if (m === 'local') { const sock = req.socket && req.socket.remoteAddress; return !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(sock); }
  return false;
}
function clientIp(req) { return (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

function validateDevice(d) {
  if (!d.host || !/^[A-Za-z0-9.:_-]+$/.test(d.host)) throw new Error('neplatný host');
  if (!hostAllowed(d.host, cfg.scanAllow)) throw new Error(`adresa ${d.host} je mimo povolené rozsahy (${cfg.scanAllow}) — přidávat jde jen IP adresy vlastní sítě`);
  if (!d.username && d.managed !== false) throw new Error('chybí uživatel');
  d.port = parseInt(d.port || 22, 10);
  if (!(d.port > 0 && d.port < 65536)) throw new Error('neplatný port');
  if (d.track && !TRACKS.includes(d.track)) throw new Error('neplatný track');
}

const who = (req) => (req.user && req.user.name) || '?';
const isAdmin = (req) => !!(req.user && req.user.role === 'admin');
// každý vidí jen svá zařízení a joby; správce vše
const canSee = (req, dev) => !!dev && (isAdmin(req) || dev.owner_id === req.user.id);
const ownsJob = (req, job) => !!job && (isAdmin(req) || job.owner_id === req.user.id);
const visDevices = (req) => isAdmin(req) ? db.listDevices() : db.listDevices(req.user.id);
const visJobs = (req, n) => isAdmin(req) ? db.listJobs(n) : db.listJobs(n, req.user.id);
const runnerStatusFor = (req) => {
  const st = runner.status(req.user.id);
  st.busy = runner.running().map(x => x.deviceId).filter(Boolean); // zařízení právě v jobu (kohokoli) — jen id
  // cizí běžící joby jen informačně: kdo (userdb uid + přezdívka), kolik zařízení, kolik hotovo; otevřít je smí jen správce
  const byUser = new Map();
  for (const x of runner.running().filter(x => x.ownerId !== req.user.id)) {
    const u = db.getUser(x.ownerId); const items = db.getJobItems(x.jobId);
    const done = items.filter(i => !['pending', 'checking', 'backup', 'upload', 'reboot', 'verify', 'firmware', 'running'].includes(i.status)).length;
    const k = x.ownerId; const cur = byUser.get(k) || { user: u ? (u.userdb_nick || u.name) : '?', uid: u ? (u.userdb_uid || 0) : 0, total: 0, done: 0, jobs: 0, jobId: 0 };
    cur.total += items.length; cur.done += done; cur.jobs++; if (isAdmin(req) && !cur.jobId) cur.jobId = x.jobId;
    byUser.set(k, cur);
  }
  const others = [...byUser.values()];
  st.others = isAdmin(req) ? others : others.map(o => ({ ...o, jobId: 0 })); // všichni vidí kdo (uid + přezdívka) a kolik; detail jobu jen správce
  return st;
};
/** import z userdb na pozadí (viz POST /api/userdb/import): stažení loginů, doplnění existujících, nové do fronty skenu */
async function runUserdbImport({ acct, allMode, onlyAps, key, prog, byName, isAdm, ip, track }) {
  void isAdm; void ip;
  let r;
  if (allMode) { if (!onlyAps) throw new Error('vyber APčka'); prog.phase = `stahuji loginy pro ${onlyAps.size} APček`; r = await userdb.devicesForAps([...onlyAps]); r.admin = { nick: `správce ${acct.userdb_nick || acct.name} (celá síť)`, apCount: onlyAps.size }; }
  else { prog.phase = 'stahuji loginy'; r = await userdb.devicesFor({ uid: acct.userdb_uid }, { apIds: onlyAps ? [...onlyAps] : null }); if (!r.admin) throw new Error('správce v userdb nenalezen'); }
  prog.phase = 'zakládám';
  // vlastník: v běžném importu účet uživatele; při importu celé sítě účet správce oblasti (SO, jinak ZSO) podle vazby na userdb —
  // když účet ještě nemá, založí se dopředu (jméno = e-mail, při SSO přihlášení se napojí); oblast bez správce připadne importujícímu
  const ownerCache = new Map();
  const ownerFor = (d) => {
    if (!allMode) return acct.id;
    const so = (d.areaAdmins || []).find(x => x.role === 'SO') || (d.areaAdmins || [])[0];
    if (!so) return acct.id;
    if (ownerCache.has(so.id)) return ownerCache.get(so.id);
    let u = db.getUserByUserdbUid(so.id);
    if (!u && so.email) { const ex = db.getUserAuth(so.email); if (ex && !ex.userdb_uid) { db.updateUser(ex.id, { userdb_uid: so.id, userdb_nick: so.nick }); u = db.getUser(ex.id); } }
    if (!u && so.email) { const id = db.insertUser({ name: so.email, pass_hash: '', role: 'user' }); db.updateUser(id, { userdb_uid: so.id, userdb_nick: so.nick, email: so.email }); u = db.getUser(id); db.audit(byName, 'účet založen (import celé sítě)', `${so.email} = ${so.nick} (uid ${so.id})`); }
    ownerCache.set(so.id, u ? u.id : acct.id);
    return u ? u.id : acct.id;
  };
  const sum = { at: Date.now(), by: byName, running: false, aps: 0, total: 0, updated: 0, foreign: [], missingLogin: r.missing.filter(d => !onlyAps || onlyAps.has(d.apId)).map(d => `${d.ip} (${d.name || d.ap})`), entries: 0, owners: {} };
  const entries = [];
  for (const d of r.devices) {
    if (onlyAps && !onlyAps.has(d.apId)) continue;
    sum.total++;
    const ownerId = ownerFor(d);
    const extra = { userdb_ap_id: d.apId, userdb_ap: d.ap, userdb_member: d.member ? d.userId : 0 };
    const ex = db.findDeviceByHost(d.ip, 22);
    if (ex) {
      if (ex.owner_id && ex.owner_id !== ownerId) { const o = db.getUser(ex.owner_id); sum.foreign.push(`${d.ip} (${d.name || d.ap}) má u sebe ${o ? (o.userdb_nick || o.name) : 'jiný uživatel'}`); continue; }
      const f = { ...extra };
      if (!ex.owner_id) f.owner_id = ownerId;
      if (ex.username !== d.login || decrypt(ex.password_enc || '') !== d.password) { f.username = d.login; f.password_enc = encrypt(d.password); }
      if (!ex.group_name) f.group_name = d.ap;
      if (!ex.name && (d.name || d.note)) f.name = d.name || d.note;
      db.updateDevice(ex.id, f); sum.updated++;
      continue;
    }
    const ou = db.getUser(ownerId); sum.owners[ou ? ou.name : ownerId] = (sum.owners[ou ? ou.name : ownerId] || 0) + 1;
    entries.push({ host: d.ip, port: 0, username: d.login, password: d.password, name: d.name || d.note || '', group_name: d.ap, extra, ownerId });
  }
  sum.aps = onlyAps ? onlyAps.size : r.admin.apCount; sum.entries = entries.length;
  userdbImports.set(key, sum);
  db.audit(byName, allMode ? 'import celé sítě z userdb' : 'import z userdb', `${r.admin.nick}: ${sum.total} zařízení z userdb, ${entries.length} nových ke skenu, ${sum.updated} aktualizováno, ${sum.foreign.length} u jiného uživatele${allMode ? `; vlastníci: ${Object.entries(sum.owners).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
  // do výsledku skenu se přidá i to, co se skenovat nebude: zařízení jiného uživatele a IP bez loginu v userdb
  const foreign = sum.foreign.map(x => `${x} — každé zařízení může mít jen jednoho vlastníka, o předání požádej jeho nebo správce`);
  const errors = sum.missingLogin.map(x => `${x}: v userdb chybí login/heslo — doplň je v userdb a načti znovu`);
  if (entries.length) {
    // sken bere max. 4096 adres na běh → větší import se rozdělí do víc běhů ve frontě
    const CH = 2000;
    for (let i = 0; i < entries.length; i += CH) {
      const part = entries.slice(i, i + CH);
      const o = { entries: part, creds: [], port: 22, track: track || db.getSettings(acct.id).default_track || 'v7-stable', parallel: 24, ownerId: acct.id, label: entries.length > CH ? `část ${i / CH + 1}/${Math.ceil(entries.length / CH)}` : '', foreign: i === 0 ? foreign : [], errors: i === 0 ? errors : [] };
      discovery.prepare(o);
      discovery.run(o).catch(e => bus.emit('event', { type: 'discovery-error', error: e.message }));
    }
    await new Promise(res2 => setTimeout(res2, 50));
  } else { discovery.setResult({ ownerId: acct.id, foreign, errors }); bus.emit('event', { type: 'devices-changed' }); }
  return sum;
}
const SERVER_STARTED_AT = Date.now(); // pro UI: kdy se služba naposledy (re)startovala
const userdbImports = new Map(); // userId -> souhrn posledního importu z userdb (jen v paměti)
/** účet ↔ správce v userdb (podle uid, e-mailu nebo přezdívky); vrací záznam správce nebo null */
async function linkUserdb(userId, who) {
  if (!userdb.enabled()) return null;
  const u = db.getUser(userId);
  if (u && u.userdb_uid) return userdb.whoIs({ uid: u.userdb_uid });
  const w = await userdb.whoIs(who);
  if (!w) return null;
  const other = db.getUserByUserdbUid(w.id);
  if (other && other.id !== userId) { console.warn(`userdb: správce ${w.nick} (uid ${w.id}) je už navázaný na účet ${other.name}, účet ${u && u.name} zůstává bez vazby`); return null; }
  db.updateUser(userId, { userdb_uid: w.id, userdb_nick: w.nick, email: (u && u.email) || w.email || '' });
  db.audit(u ? u.name : String(userId), 'účet navázán na userdb', `${w.nick} (uid ${w.id}), ${w.areas.length} oblastí`);
  return w;
}
const userdbFor = (req) => { if (!userdb.enabled()) return { enabled: false }; const u = req.user && db.getUser(req.user.id); return { enabled: true, uid: (u && u.userdb_uid) || 0, nick: (u && u.userdb_nick) || '' }; };
const discoveryFor = (req) => discovery.status(req.user.id);
/** SSE: událost projde jen tomu, kdo smí vidět dotčené zařízení / job */
const jobOwnerCache = new Map(); // jobId -> { at, owner } (SSE: každý log řádek × každý klient by jinak dělal dotaz do DB)
function jobOwner(jobId) { const c = jobOwnerCache.get(jobId); if (c && Date.now() - c.at < 60000) return c.owner; const j = db.getJob(jobId); const owner = j ? j.owner_id : -1; jobOwnerCache.set(jobId, { at: Date.now(), owner }); return owner; }
function eventFor(req, ev) {
  if (ev.type === 'device' && ev.device) ev = { ...ev, device: slimDevice(ev.device) }; // do prohlížeče jen štíhlá verze (bez sousedů/rádií)
  if (isAdmin(req)) return ev;
  const uid = req.user.id;
  switch (ev.type) {
    case 'device': return ev.device && ev.device.owner_id === uid ? ev : null;
    case 'device-deleted': return ev.owner_id === uid ? ev : null;
    case 'job': return ev.job && ev.job.owner_id === uid ? ev : null;
    case 'item': return ev.item && jobOwner(ev.item.job_id) === uid ? ev : null;
    case 'log': return ev.log && jobOwner(ev.log.job_id) === uid ? ev : null;
    case 'progress': return jobOwner(ev.job_id) === uid ? ev : null;
    case 'runner': return ev.status && ev.status.ownerId === uid ? ev : null;
    case 'discovery': case 'discovery-done': return ev.state && ev.state.ownerId === uid ? ev : null;
    case 'scan-progress': return ev.ownerId === uid ? ev : null;
    case 'discovery-error': case 'devices-changed': case 'latest': case 'scan-done': return ev;
    default: return null;
  }
}
const audit = (req, action, detail) => db.audit(who(req), action, detail, clientIp(req));
function adminOnly(req, res) { if (isAdmin(req)) return true; send(res, 403, { error: 'tuhle akci smí jen správce' }); return false; }

// ---------- API ----------
async function api(req, res, method, p, url) {
  const parts = p.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;
  const seg = parts.slice(1);

  // stav
  if (method === 'GET' && p === '/api/state') {
    const latest = V.getLatest();
    if (!latest.fetchedAt) await V.refreshLatest().catch(() => {});
    return send(res, 200, { latest: V.getLatest(), settings: db.getSettings(req.user.id), settingsOwn: db.getUserSettings(req.user.id), settingsGlobal: isAdmin(req) ? db.getSettings() : undefined, devices: withSuggestions(visDevices(req)), jobs: visJobs(req, 30), runner: runnerStatusFor(req), tracks: TRACKS, scanning: [...scanner.inProgress], discovery: discoveryFor(req), admin: isAdmin(req), user: req.user });
  }
  if (method === 'POST' && p === '/api/versions/refresh') { const l = await V.refreshLatest(true); bus.emit('event', { type: 'latest', latest: l }); return send(res, 200, l); }
  if (method === 'GET' && seg[0] === 'changelog' && seg[1]) return send(res, 200, await V.getChangelog(seg[1]));
  // statistika celé sítě (jen počty, bez cizích detailů) — proužek nahoře pro všechny
  if (method === 'GET' && p === '/api/stats') return send(res, 200, networkStats());
  // seznamy z plánovače pro nápovědu (vždy odpovídají kódu)
  if (method === 'GET' && p === '/api/rules') return send(res, 200, { noV7: NO_V7.map(r => ({ hw: r.hw, why: r.why, src: r.src, hard: !!r.hard })), knownBad: KNOWN_BAD.map(r => ({ hw: r.hw, versions: r.versions, why: r.why || r.warn || r.firmwareWarn })), globalBad: Object.entries(GLOBAL_BAD).map(([v, why]) => ({ version: v, why })) });

  // nastavení
  // nastavení: společné (správce) + vlastní přepsání každého uživatele (platí pro jeho joby, skeny a plány)
  if (method === 'GET' && p === '/api/settings') return send(res, 200, { settings: db.getSettings(req.user.id), own: db.getUserSettings(req.user.id), global: isAdmin(req) ? db.getSettings() : undefined });
  if (method === 'PUT' && p === '/api/settings/mine') { const b = await readBody(req); const own = db.setUserSettings(req.user.id, b); audit(req, 'vlastní nastavení', JSON.stringify(own)); return send(res, 200, { settings: db.getSettings(req.user.id), own }); }
  if (method === 'DELETE' && p === '/api/settings/mine') { db.clearUserSettings(req.user.id); audit(req, 'vlastní nastavení zrušeno', ''); return send(res, 200, { settings: db.getSettings(req.user.id), own: {} }); }
  if (method === 'PUT' && p === '/api/settings') { if (!adminOnly(req, res)) return; const b = await readBody(req); db.setSettings(b); audit(req, 'nastavení', JSON.stringify(b)); return send(res, 200, db.getSettings()); }
  if (method === 'GET' && p === '/api/audit') { if (!adminOnly(req, res)) return; return send(res, 200, db.listAudit(300)); }

  // uživatelé (jen správce) + změna vlastního hesla
  if (method === 'POST' && p === '/api/me/password') {
    const b = await readBody(req);
    const me = db.getUserAuth(req.user.name);
    if (me.pass_hash && !verifyPassword(b.old || '', me.pass_hash)) throw new Error('současné heslo nesouhlasí');
    if (String(b.password || '').length < 8) throw new Error('nové heslo musí mít aspoň 8 znaků');
    db.updateUser(me.id, { pass_hash: hashPassword(b.password) });
    audit(req, 'změna vlastního hesla', '');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/users' || seg[0] === 'users') {
    if (!adminOnly(req, res)) return;
    if (method === 'GET' && p === '/api/users') return send(res, 200, db.listUsers());
    if (method === 'POST' && p === '/api/users') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!/^[\w.@+-]{2,64}$/.test(name)) throw new Error('jméno: 2–64 znaků, písmena/číslice/._@+-');
      if (String(b.password || '').length < 8) throw new Error('heslo musí mít aspoň 8 znaků');
      if (db.getUserAuth(name)) throw new Error('uživatel už existuje');
      const id = db.insertUser({ name, pass_hash: hashPassword(b.password), role: b.role === 'admin' ? 'admin' : 'user' });
      audit(req, 'uživatel založen', `${name} (${b.role === 'admin' ? 'správce' : 'uživatel'})`);
      return send(res, 200, db.getUser(id));
    }
    const uid = parseInt(seg[1], 10);
    const u = db.getUser(uid);
    if (!u) return send(res, 404, { error: 'uživatel neexistuje' });
    if (method === 'PUT') {
      const b = await readBody(req);
      const f = {};
      if (b.password) { if (String(b.password).length < 8) throw new Error('heslo musí mít aspoň 8 znaků'); f.pass_hash = hashPassword(b.password); }
      if (b.role) f.role = b.role === 'admin' ? 'admin' : 'user';
      if ('userdb' in b) { // vazba na správce v userdb: uid, e-mail nebo přezdívka; prázdné = zrušit
        const q = String(b.userdb || '').trim();
        if (!q) { f.userdb_uid = 0; f.userdb_nick = ''; }
        else { const w = await userdb.whoIs(/^\d+$/.test(q) ? { uid: q } : q.includes('@') ? { email: q } : { nick: q }); if (!w) throw new Error(`správce „${q}“ v userdb není (nebo nemá žádnou oblast)`); const other = db.getUserByUserdbUid(w.id); if (other && other.id !== uid) throw new Error(`na ${w.nick} (uid ${w.id}) je už navázaný účet ${other.name}`); f.userdb_uid = w.id; f.userdb_nick = w.nick; if (w.email && !u.email) f.email = w.email; }
      }
      if ('disabled' in b) f.disabled = !!b.disabled;
      const losesAdmin = u.role === 'admin' && ((f.role && f.role !== 'admin') || f.disabled);
      if (losesAdmin && db.countAdmins() <= 1) throw new Error('nelze odebrat posledního správce');
      if (uid === req.user.id && losesAdmin) throw new Error('sám sobě správce neodebereš');
      db.updateUser(uid, f);
      audit(req, 'uživatel upraven', `${u.name}: ${Object.keys(f).map(k => k === 'pass_hash' ? 'heslo' : k).join(',')}`);
      return send(res, 200, db.getUser(uid));
    }
    if (method === 'DELETE') {
      if (uid === req.user.id) throw new Error('sám sebe nesmažeš');
      if (u.role === 'admin' && db.countAdmins() <= 1) throw new Error('nelze smazat posledního správce');
      const b = await readBody(req).catch(() => ({}));
      const target = parseInt(b.transfer_to || 0, 10);
      const owned = db.listDevices(uid).length;
      if (owned && !target) throw new Error(`uživatel vlastní ${owned} zařízení — zadej, komu je předat (transfer_to)`);
      if (target) { if (!db.getUser(target)) throw new Error('cílový uživatel neexistuje'); db.bumpDevices(); db.db.prepare('UPDATE devices SET owner_id=? WHERE owner_id=?').run(target, uid); db.db.prepare('UPDATE jobs SET owner_id=? WHERE owner_id=?').run(target, uid); }
      db.deleteUser(uid);
      audit(req, 'uživatel smazán', `${u.name}${target ? ` (zařízení předána #${target})` : ''}`);
      return send(res, 200, { ok: true });
    }
  }

  // zařízení
  if (method === 'GET' && p === '/api/devices') return send(res, 200, withSuggestions(visDevices(req)));
  // sken rozsahů
  // ---- userdb (evidence hkfree): oblasti/APčka správce a import zařízení včetně loginů ----
  if (seg[0] === 'userdb') {
    if (!userdb.enabled()) return send(res, 404, { error: 'napojení na userdb není nakonfigurováno (MTU_USERDB_USER/PASS)' });
    // správce může pracovat s účtem jiného uživatele (?user=ID), ostatní jen se sebou
    const forId = isAdmin(req) && parseInt(url.searchParams.get('user') || 0, 10) ? parseInt(url.searchParams.get('user'), 10) : req.user.id;
    const acct = db.getUser(forId);
    if (!acct) return send(res, 404, { error: 'uživatel neexistuje' });
    // správce: přehled všech oblastí a APček v userdb (import celé sítě); vlastníkem importovaných zařízení bude účet správce dané oblasti
    if (method === 'GET' && p === '/api/userdb/me' && url.searchParams.get('all') && isAdmin(req)) {
      const all = await userdb.areas();
      const allDevs = db.listDevices();
      const areasOut = [];
      const queue = all.flatMap(a => a.aps.map(ap => ({ a, ap })));
      const results = new Map();
      let qi = 0;
      await Promise.all(Array.from({ length: 8 }, async () => { while (qi < queue.length) { const { ap } = queue[qi++]; results.set(ap.id, await userdb.devicesForAp(ap.id).catch(() => [])); } }));
      for (const a of all) {
        const so = a.admins.find(x => x.role === 'SO') || a.admins[0] || null;
        const ownerAcct = so ? db.getUserByUserdbUid(so.id) : null;
        const aps = a.aps.map(ap => { const list = results.get(ap.id) || []; return { id: ap.id, name: ap.name, active: ap.active, address: ap.address, total: list.length, members: list.filter(d => d.member).length, imported: allDevs.filter(d => d.userdb_ap_id === ap.id).length }; });
        areasOut.push({ id: a.id, name: a.name, role: '', admins: a.admins.map(x => `${x.nick} (${x.id}, ${x.role})`).join(', '), owner: so ? `${so.nick} (${so.id})${ownerAcct ? '' : ' — účet vznikne'}` : '— bez správce → ' + acct.name, aps });
      }
      return send(res, 200, { linked: true, all: true, user: { id: acct.id, name: acct.name }, admin: { id: acct.userdb_uid, nick: acct.userdb_nick || acct.name, email: acct.email }, areas: areasOut, lastImport: userdbImports.get(-1) || null });
    }
    if (method === 'GET' && p === '/api/userdb/me') {
      if (!acct.userdb_uid) return send(res, 200, { linked: false, user: { id: acct.id, name: acct.name } });
      const w = await userdb.whoIs({ uid: acct.userdb_uid });
      if (!w) return send(res, 200, { linked: false, user: { id: acct.id, name: acct.name }, error: `uid ${acct.userdb_uid} už v userdb není správcem žádné oblasti` });
      const mine = db.listDevices(acct.id);
      const areas = [];
      for (const a of w.areas) {
        const aps = [];
        for (const ap of a.aps) {
          const list = await userdb.devicesForAp(ap.id).catch(() => []);
          const inDb = mine.filter(d => d.userdb_ap_id === ap.id).length;
          aps.push({ id: ap.id, name: ap.name, active: ap.active, address: ap.address, total: list.length, members: list.filter(d => d.member).length, imported: inDb });
        }
        areas.push({ id: a.id, name: a.name, role: a.role, aps });
      }
      return send(res, 200, { linked: true, user: { id: acct.id, name: acct.name }, admin: { id: w.id, nick: w.nick, email: w.email }, areas, lastImport: userdbImports.get(acct.id) || null });
    }
    if (method === 'POST' && p === '/api/userdb/import') {
      const b = await readBody(req).catch(() => ({}));
      const allMode = !!b.all && isAdmin(req);
      if (!allMode && !acct.userdb_uid) throw new Error('účet není navázaný na správce v userdb');
      const onlyAps = Array.isArray(b.aps) && b.aps.length ? new Set(b.aps.map(Number)) : null;
      const track = ['v7-stable', 'v7-long-term'].includes(b.track) ? b.track : ''; // kanál pro nová zařízení z dialogu; prázdné = z nastavení uživatele
      const key = allMode ? -1 : acct.id;
      const prev = userdbImports.get(key);
      if (prev && prev.running) throw new Error('import z userdb ještě běží (' + (prev.phase || '') + ')');
      // stahování loginů z userdb trvá (1 dotaz na IP; celá síť = tisíce) → běží na pozadí, UI se ptá na /api/userdb/import-status
      const prog = { at: Date.now(), by: req.user.name, running: true, phase: 'načítám seznam zařízení z userdb', progress: '' };
      userdbImports.set(key, prog);
      const byName = req.user.name, isAdm = isAdmin(req), ip = clientIp(req);
      setImmediate(async () => { try { await runUserdbImport({ acct, allMode, onlyAps, key, prog, byName, isAdm, ip, track }); } catch (e) { userdbImports.set(key, { at: Date.now(), by: byName, error: e.message, running: false }); bus.emit('event', { type: 'discovery-error', error: 'import z userdb: ' + e.message }); } });
      return send(res, 200, { started: true });
    }
    if (method === 'GET' && p === '/api/userdb/import-status') {
      const key = url.searchParams.get('all') && isAdmin(req) ? -1 : acct.id;
      return send(res, 200, { summary: userdbImports.get(key) || null, discovery: discovery.status(acct.id) });
    }
    return send(res, 404, { error: 'neznámá akce' });
  }
  if (method === 'POST' && p === '/api/discover') {

    const b = await readBody(req);
    const ranges = String(b.ranges || '').split(/[\s,;]+/).filter(Boolean);
    const creds = String(b.creds || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { const [username, ...rest] = l.split(/\s+/); let password = rest.join(' '); if (password === '""' || password === "''") password = ''; return { username, password }; }).filter(c => c.username);
    // seznam zařízení: řádky "host[:port] uživatel heslo [název…]" (oddělovač mezera/tab/;, prázdné heslo jako "")
    const entries = [], entryErrors = [];
    String(b.entries || '').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim(); if (!t || t.startsWith('#')) return;
      const parts = t.split(/[;\t]+|\s+/).filter(Boolean);
      if (parts.length < 2) { entryErrors.push(`řádek ${i + 1}: očekávám "ip uživatel heslo"`); return; }
      let [hostport, username, password = '', ...rest] = parts;
      if (password === '""' || password === "''") password = '';
      let host = hostport, port = 0; const m = hostport.match(/^(.+):(\d+)$/); if (m) { host = m[1]; port = +m[2]; }
      if (!/^[A-Za-z0-9.:_-]+$/.test(host)) { entryErrors.push(`řádek ${i + 1}: neplatná adresa ${host}`); return; }
      entries.push({ host, port, username, password, name: rest.join(' ') });
    });
    if (entryErrors.length) throw new Error(entryErrors.join('; '));
    const o = { ranges, entries, creds, port: parseInt(b.port || 22, 10), group_name: b.group_name || '', track: b.track || 'v7-stable', parallel: parseInt(b.parallel || 24, 10), ownerId: req.user.id };
    discovery.prepare(o); // validace → 400 s popisem chyby (sken se zařadí do fronty, když jiný běží)
    audit(req, 'sken rozsahu', [...ranges, ...(entries.length ? [`${entries.length} zařízení ze seznamu`] : [])].join(' '));
    discovery.run(o).catch(e => bus.emit('event', { type: 'discovery-error', error: e.message }));
    await new Promise(r => setTimeout(r, 50));
    return send(res, 200, discovery.status(req.user.id));
  }
  if (method === 'GET' && p === '/api/discover') return send(res, 200, discoveryFor(req));
  // hromadné smazání vybraných zařízení
  if (method === 'POST' && p === '/api/devices/bulk-delete') {
    const b = await readBody(req);
    const ids = (b.ids || []).map(Number).filter(Number.isFinite);
    let deleted = 0; const skipped = [];
    for (const id of ids) {
      const d = db.getDevice(id);
      if (!canSee(req, d)) continue;
      if (runner.isDeviceBusy(id)) { skipped.push(`${d.host} je právě v jobu`); continue; }
      db.deleteDevice(id); deleted++;
      audit(req, 'zařízení smazáno', `${d.host} ${devLabel(d)}`);
      bus.emit('event', { type: 'device-deleted', id, owner_id: d.owner_id });
    }
    return send(res, 200, { deleted, skipped });
  }
  // hromadné předání zařízení jinému vlastníkovi (jen správce)
  if (method === 'POST' && p === '/api/devices/bulk-owner') {
    if (!adminOnly(req, res)) return;
    const b = await readBody(req);
    const target = parseInt(b.owner_id, 10);
    const tu = db.getUser(target);
    if (!tu) throw new Error('cílový uživatel neexistuje');
    const ids = (b.ids || []).map(Number).filter(i => db.getDevice(i));
    let n = 0;
    for (const id of ids) { const d = db.getDevice(id); if (d.owner_id === target) continue; db.updateDevice(id, { owner_id: target }); n++; bus.emit('event', { type: 'device', device: db.getDevice(id) }); }
    audit(req, 'zařízení předána', `${n}× → ${tu.name}`);
    bus.emit('event', { type: 'devices-changed' });
    return send(res, 200, { moved: n, owner: tu.name });
  }
  // hromadná změna kanálu RouterOS u vlastních zařízení (zařízení držená na v6 nebo hold se nemění)
  if (method === 'POST' && p === '/api/devices/bulk-track') {
    const b = await readBody(req);
    if (!['v7-stable', 'v7-long-term'].includes(b.track)) throw new Error('kanál: v7-stable nebo v7-long-term');
    let n = 0;
    for (const d of visDevices(req)) { if (['v6-long-term', 'hold'].includes(d.track) || d.track === b.track) continue; db.updateDevice(d.id, { track: b.track }); n++; }
    audit(req, 'kanál změněn hromadně', `${n}× → ${b.track}`);
    bus.emit('event', { type: 'devices-changed' });
    return send(res, 200, { changed: n });
  }
  // hromadné přebrání detekovaných rodičů (jen kde není nastaven)
  if (method === 'POST' && p === '/api/devices/accept-parents') {
    const b = await readBody(req).catch(() => ({}));
    const all = db.listDevices().filter(d => !d.dup_of); // kandidáti na rodiče napříč účty
    const mine = new Set(visDevices(req).map(d => d.id));
    let n = 0;
    for (const d of all) {
      if (!mine.has(d.id)) continue;
      if (d.parent_id && !b.overwrite) continue;
      const sp = suggestParent(d, all);
      if (sp && sp.id && sp.id !== d.parent_id && !db.descendantIds(d.id).includes(sp.id)) { db.updateDevice(d.id, { parent_id: sp.id, parent_src: sp.src || '' }); n++; }
    }
    bus.emit('event', { type: 'devices-changed' });
    return send(res, 200, { updated: n });
  }
  if (method === 'POST' && p === '/api/scan') {
    const b = await readBody(req).catch(() => ({}));
    const mine = new Set(visDevices(req).map(d => d.id));
    const ids = (b.ids ? b.ids.map(Number) : [...mine]).filter(i => mine.has(i));
    scanner.scanAll(ids).catch(() => {});
    return send(res, 200, { started: true });
  }
  if (seg[0] === 'devices' && seg[1]) {
    const id = parseInt(seg[1], 10);
    const dev = db.getDevice(id);
    if (!canSee(req, dev)) return send(res, 404, { error: 'zařízení neexistuje' });
    if (method === 'GET' && !seg[2]) return send(res, 200, { device: dev, history: db.getVersionHistory(id), backups: db.listBackups(id), log: db.getDeviceLog(id) });
    if (method === 'PUT' && !seg[2]) {
      const b = await readBody(req);
      const f = {};
      for (const k of ['host', 'port', 'username', 'name', 'group_name', 'priority', 'enabled', 'track', 'notes', 'parent_id', 'managed', 'allow_v7', 'ignore_poe', 'ignore_flagged']) if (k in b) f[k] = b[k];
      if ('owner_id' in b && isAdmin(req)) { f.owner_id = +b.owner_id || 0; if (f.owner_id && !db.getUser(f.owner_id)) throw new Error('vlastník neexistuje'); }
      if ('parent_id' in f) { f.parent_id = +f.parent_id || 0; if (f.parent_id !== dev.parent_id) f.parent_src = f.parent_id ? 'manual' : ''; if (f.parent_id === id || db.descendantIds(id).includes(f.parent_id)) throw new Error('nadřazený prvek nemůže být zařízení samo ani jeho potomek'); if (f.parent_id && !canSee(req, db.getDevice(f.parent_id))) throw new Error('nadřazený prvek neexistuje'); }
      if (f.host || f.port) { validateDevice({ ...dev, ...f }); const ex = db.findDeviceByHost(f.host || dev.host, f.port || dev.port); if (ex && ex.id !== id) throw new Error('jiné zařízení se stejným host:port už existuje'); }
      if (f.track && !TRACKS.includes(f.track)) throw new Error('neplatný track');
      if (b.password) f.password_enc = encrypt(b.password);
      if (f.host && f.host !== dev.host) f.host_key = '';
      db.updateDevice(id, f);
      audit(req, 'zařízení upraveno', `${dev.host}: ${Object.keys(f).filter(k => k !== 'password_enc').join(',')}${b.password ? ',heslo' : ''}`);
      const d2 = db.getDevice(id); bus.emit('event', { type: 'device', device: d2 });
      return send(res, 200, d2);
    }
    if (method === 'DELETE' && !seg[2]) { if (runner.isDeviceBusy(id)) throw new Error('zařízení je právě v jobu'); db.deleteDevice(id); audit(req, 'zařízení smazáno', `${dev.host} ${dev.name || dev.identity || ''}`); bus.emit('event', { type: 'device-deleted', id, owner_id: dev.owner_id }); return send(res, 200, { ok: true }); }
    if (method === 'POST' && seg[2] === 'scan') { const r = await scanner.scanOne(id); return send(res, 200, { ...r, device: db.getDevice(id) }); }
    if (method === 'POST' && seg[2] === 'reset-hostkey') { db.updateDevice(id, { host_key: '', scan_status: 'never', scan_error: '' }); scanner.scanOne(id).catch(() => {}); return send(res, 200, { ok: true }); }
    if (method === 'GET' && seg[2] === 'plan') {
      await V.refreshLatest().catch(() => {});
      const opts = { mode: q.get('mode') || 'upload', allow_routing_migration: q.get('allow_routing') === '1', allow_small_flash: q.get('allow_small_flash') === '1', allow_v7: !!dev.allow_v7 };
      const pl = await plan(dev, { track: q.get('track') || dev.track, settings: db.getSettings(dev.owner_id), latest: V.getLatest(), options: opts });
      return send(res, 200, pl);
    }
    if (method === 'GET' && seg[2] === 'password') { if (!adminOnly(req, res)) return; audit(req, 'zobrazení hesla', dev.host); return send(res, 200, { password: decrypt(db.getDeviceRaw(id).password_enc) }); }
    if (method === 'POST' && seg[2] === 'repartition') { if (!adminOnly(req, res)) return; const b = await readBody(req).catch(() => ({})); audit(req, 'rozdělení flash', dev.host); const jobId = runner.repartition(id, parseInt(b.count || 2, 10)); return send(res, 200, { jobId }); }
  }

  // zálohy
  if (method === 'GET' && seg[0] === 'backups' && seg[1]) {
    const b = db.getBackup(parseInt(seg[1], 10));
    if (!b || !canSee(req, db.getDevice(b.device_id))) return send(res, 404, { error: 'záloha neexistuje' });
    const file = path.join(cfg.backupDir, b.filename);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'soubor zálohy chybí' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(file)}"`, 'Content-Length': fs.statSync(file).size });
    return fs.createReadStream(file).pipe(res);
  }

  // joby
  if (method === 'GET' && p === '/api/jobs') return send(res, 200, visJobs(req, 100));
  if (method === 'POST' && p === '/api/jobs') {
    const b = await readBody(req);
    let ids = (b.deviceIds || []).map(Number).filter(n => canSee(req, db.getDevice(n)));
    if (!ids.length) throw new Error('žádná zařízení');
    const o = b.options || {};
    const options = {
      dry_run: !!o.dry_run, mode: o.mode === 'router' ? 'router' : 'upload', firmware: o.firmware !== false, stop_on_failure: o.stop_on_failure !== false,
      canary: !!o.canary, pause_sec: Number.isFinite(+o.pause_sec) ? +o.pause_sec : undefined,
      require_binary_backup: !!o.require_binary_backup, allow_routing_migration: !!o.allow_routing_migration, allow_small_flash: !!o.allow_small_flash,
      device_mode: o.device_mode !== false,
      precheck: o.precheck !== false,
    };
    // naplánovaný start: čas v sekundách; v minulosti nebo prázdné = hned
    if (o.start_at) {
      const t = Math.floor(new Date(o.start_at).getTime() / 1000);
      if (!Number.isFinite(t)) throw new Error(`čas spuštění nejde přečíst: ${o.start_at}`);
      if (t < Date.now() / 1000 - 60) throw new Error(`čas spuštění ${new Date(t * 1000).toLocaleString('cs-CZ')} je v minulosti — pro dnešní noc vyber zítřejší datum`);
      if (t > Date.now() / 1000 + 60) options.start_at = t;
    }
    // pořadí: nejdřív potomci (hloubka v topologii sestupně), pak priorita; u kanárků první zařízení každého modelu napřed
    const depth = (id) => db.ancestorIds(id).length;
    const devs = ids.map(id => db.getDevice(id)).filter(d => d.managed).map(d => ({ ...d, depth: depth(d.id) })).sort((a, b2) => b2.depth - a.depth || a.priority - b2.priority || a.host.localeCompare(b2.host));
    if (!devs.length) throw new Error('žádná řízená zařízení (neřízené prvky topologie se neupgradují)');
    let canaryIds = new Set();
    if (options.canary) {
      const seen = new Set();
      for (const d of devs) { const key = d.board_name || d.model || 'unknown'; if (!seen.has(key)) { seen.add(key); canaryIds.add(d.id); } }
      devs.sort((a, b2) => (canaryIds.has(b2.id) - canaryIds.has(a.id)) || b2.depth - a.depth || a.priority - b2.priority || a.host.localeCompare(b2.host));
    }
    options.by = who(req);
    const jobId = db.createJob(b.name || `Upgrade ${new Date().toLocaleString('cs-CZ')}`, options, devs.map(d => d.id), req.user.id);
    if (options.canary) for (const it of db.getJobItems(jobId)) if (canaryIds.has(it.device_id)) db.updateJobItem(it.id, { plan: { canary: true } });
    db.addLog(jobId, 0, 0, 'info', `Job vytvořen (${options.by}): ${devs.length} zařízení, ${JSON.stringify(options)}`);
    if (b.start && options.start_at) { db.updateJob(jobId, { status: 'scheduled', status_note: `spustí se ${new Date(options.start_at * 1000).toLocaleString('cs-CZ')}` }); db.addLog(jobId, 0, 0, 'info', `Naplánováno na ${new Date(options.start_at * 1000).toLocaleString('cs-CZ')} (${who(req)}).`); }
    let queued = null;
    if (b.start && !options.start_at) queued = runner.startOrQueue(jobId);
    else if (b.start && options.start_at && options.precheck && !options.dry_run) runner.earlyPrecheck(jobId).catch(e => db.addLog(jobId, 0, 0, 'warn', 'předběžná kontrola se nepovedla: ' + e.message));
    bus.emit('event', { type: 'job', job: db.getJobSummary(jobId) });
    return send(res, 200, { id: jobId, queued: !!(queued && queued.queued), behind: queued && queued.behind });
  }
  if (seg[0] === 'jobs' && seg[1]) {
    const id = parseInt(seg[1], 10);
    const job = db.getJob(id);
    if (!ownsJob(req, job)) return send(res, 404, { error: 'job neexistuje' });
    if (method === 'GET' && !seg[2]) return send(res, 200, { job, items: db.getJobItems(id), log: db.getLog(id, parseInt(q.get('after') || '0', 10)) });
    if (method === 'GET' && seg[2] === 'log') return send(res, 200, db.getLog(id, parseInt(q.get('after') || '0', 10)));
    const rj = runner.runnerOfJob(id); // runner, ve kterém job právě běží (null = neběží)
    if (method === 'POST' && seg[2] === 'start') { db.addLog(id, 0, 0, 'info', `Spuštění: ${who(req)}`); audit(req, 'job spuštěn', `#${id} ${job.name}`); const q = runner.startOrQueue(id); return send(res, 200, { ...runnerStatusFor(req), queued: q.queued, behind: q.behind }); }
    if (method === 'POST' && seg[2] === 'precheck') { if (rj) throw new Error('job právě běží'); db.addLog(id, 0, 0, 'info', `Předběžná kontrola na vyžádání: ${who(req)}`); runner.earlyPrecheck(id).catch(e => db.addLog(id, 0, 0, 'warn', 'předběžná kontrola se nepovedla: ' + e.message)); await new Promise(r2 => setTimeout(r2, 50)); return send(res, 200, { ok: true }); }
    if (method === 'POST' && seg[2] === 'pause') { if (!rj) throw new Error('tento job neběží'); db.addLog(id, 0, 0, 'info', `Pozastavení: ${who(req)}`); audit(req, 'job pozastaven', `#${id}`); rj.pause(); return send(res, 200, runnerStatusFor(req)); }
    if (method === 'POST' && seg[2] === 'cancel') {
      db.addLog(id, 0, 0, 'warn', `Zrušení: ${who(req)}`); audit(req, 'job zrušen', `#${id}`);
      if (rj) rj.cancel();
      else { db.updateJob(id, { status: 'cancelled', status_note: 'zrušeno', finished_at: db.now() }); for (const it of db.getJobItems(id)) if (it.status === 'pending') db.updateJobItem(it.id, { status: 'skipped', error: 'job zrušen' }); }
      bus.emit('event', { type: 'job', job: db.getJobSummary(id) });
      return send(res, 200, runnerStatusFor(req));
    }
    if (method === 'POST' && seg[2] === 'continue') {
      db.addLog(id, 0, 0, 'info', `Pokračování: ${who(req)}`); audit(req, 'job pokračuje', `#${id}`);
      if (job.options.canary && job.status === 'waiting' && !/^kontrola hotová/.test(job.status_note || '')) db.updateJob(id, { options: { ...job.options, canaryDone: true } });
      const q = runner.startOrQueue(id);
      return send(res, 200, { ...runnerStatusFor(req), queued: q.queued, behind: q.behind });
    }
    if (method === 'POST' && seg[2] === 'skip-current') { if (!rj) throw new Error('tento job neběží'); db.addLog(id, 0, 0, 'warn', `Přeskočení aktuálního: ${who(req)}`); audit(req, 'job přeskočení', `#${id}`); rj.skipCurrent(); return send(res, 200, { ok: true }); }
    if (method === 'DELETE' && !seg[2]) { if (rj) throw new Error('job právě běží'); audit(req, 'job smazán', `#${id} ${job.name}`); db.deleteJob(id); bus.emit('event', { type: 'job-deleted', id }); return send(res, 200, { ok: true }); }
  }
  if (seg[0] === 'items' && seg[1] && method === 'POST') {
    const it = db.getJobItem(parseInt(seg[1], 10));
    if (!it || !ownsJob(req, db.getJob(it.job_id))) return send(res, 404, { error: 'položka neexistuje' });
    if (runner.isItemBusy(it.id)) throw new Error('položka právě běží');
    if (seg[2] === 'skip') { db.updateJobItem(it.id, { status: 'skipped', error: `přeskočeno (${who(req)})`, finished_at: db.now() }); db.addLog(it.job_id, it.id, it.device_id, 'warn', `Položka přeskočena: ${who(req)}`); }
    else if (seg[2] === 'retry') { db.addLog(it.job_id, it.id, it.device_id, 'info', `Položka znovu do fronty: ${who(req)}`); db.updateJobItem(it.id, { status: 'pending', error: '', step: '', started_at: 0, finished_at: 0 }); const j = db.getJob(it.job_id); if (['done', 'cancelled'].includes(j.status)) db.updateJob(it.job_id, { status: 'paused', status_note: 'položka vrácena do fronty', finished_at: 0 }); }
    else return send(res, 404, { error: 'neznámá akce' });
    runner.emitItem(it.id); runner.emitJob(it.job_id);
    return send(res, 200, db.getJobItem(it.id));
  }

  // SSE
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    const h = (ev) => { try { const e2 = eventFor(req, ev); if (e2) res.write(`data: ${JSON.stringify(e2)}\n\n`); } catch {} };
    bus.on('event', h);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { bus.off('event', h); clearInterval(ping); });
    return;
  }
  send(res, 404, { error: 'neznámé API' });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (cfg.basePath && p.startsWith(cfg.basePath + '/')) p = p.slice(cfg.basePath.length);
    else if (cfg.basePath && p === cfg.basePath) p = '/';
    const method = req.method;

    // balíčky pro /tool fetch z routeru (token místo session)
    if (method === 'GET' && p.startsWith('/pkg/')) {
      const [, , tk, file] = p.split('/');
      const pk = runner.getPkg(tk);
      if (!pk || pk.file !== file) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(pk.local).size });
      return fs.createReadStream(pk.local).pipe(res);
    }

    const cookieAttrs = `Path=${cfg.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionDays * 86400}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
    // SSO (OpenID Connect)
    if (method === 'GET' && p === '/auth/login') {
      if (!sso.enabled()) return send(res, 404, 'SSO není nakonfigurováno');
      try { const u = await sso.loginUrl(); res.writeHead(302, { Location: u, 'Cache-Control': 'no-store' }); return res.end(); }
      catch (e) { return send(res, 502, 'SSO nedostupné: ' + e.message); }
    }
    if (method === 'GET' && p === '/auth/callback') {
      if (!sso.enabled()) return send(res, 404, 'SSO není nakonfigurováno');
      const err = url.searchParams.get('error');
      if (err) return send(res, 401, `SSO odmítlo přihlášení: ${url.searchParams.get('error_description') || err}`);
      try {
        const su = await sso.callback(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
        if (cfg.sso.allowedEmails.length && !cfg.sso.allowedEmails.includes(su.email.toLowerCase())) return send(res, 403, 'tenhle účet nemá přístup');
        let u = db.getUserAuth(su.email);
        if (!u) { const id = db.insertUser({ name: su.email, pass_hash: '', role: cfg.sso.adminEmails.includes(su.email.toLowerCase()) ? 'admin' : 'user' }); u = db.getUserAuth(su.email); db.audit(su.email, 'uživatel založen (SSO)', ''); void id; }
        if (u.disabled) return send(res, 403, 'účet je vypnutý');
        db.updateUser(u.id, { last_login_at: Date.now(), email: su.email });
        await linkUserdb(u.id, { email: su.email }).catch(e => console.warn(`userdb: vazbu účtu ${u.name} se nepodařilo zjistit: ${e.message}`));
        const tok = makeSession(u);
        console.log(`SSO přihlášení: ${u.name} z ${clientIp(req)}`);
        db.audit(u.name, 'přihlášení SSO', clientIp(req));
        res.writeHead(302, { Location: (cfg.basePath || '') + '/', 'Set-Cookie': `mtu_session=${tok}; ${cookieAttrs}`, 'Cache-Control': 'no-store' });
        return res.end();
      } catch (e) { return send(res, 401, `Přihlášení přes SSO se nezdařilo: ${e.message}`); }
    }
    // login
    if (method === 'POST' && p === '/api/login') {
      if (!pwLoginAllowed(req)) return send(res, 400, { error: 'přihlášení heslem je vypnuté, použij SSO' });
      const ip = clientIp(req);
      const a = loginAttempts.get(ip) || { n: 0, t: 0 };
      if (a.n >= 8 && Date.now() - a.t < 10 * 60e3) return send(res, 429, { error: 'příliš mnoho pokusů, zkus to za 10 minut' });
      const b = await readBody(req);
      const u = db.getUserAuth(b.username || '');
      if (!u || u.disabled || !verifyPassword(b.password || '', u.pass_hash)) { loginAttempts.set(ip, { n: a.n + 1, t: Date.now() }); db.audit(String(b.username || '').slice(0, 64), 'neúspěšné přihlášení', ip); return send(res, 401, { error: 'špatné jméno nebo heslo' }); }
      loginAttempts.delete(ip);
      db.updateUser(u.id, { last_login_at: Date.now() });
      db.audit(u.name, 'přihlášení', ip);
      const tok = makeSession(u);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `mtu_session=${tok}; ${cookieAttrs}` });
    }
    // samoregistrace: jméno + heslo, role uživatel; správce ji může v nastavení vypnout
    if (method === 'POST' && p === '/api/register') {
      if (!pwLoginAllowed(req) || !db.getSettings().allow_registration) return send(res, 403, { error: 'registrace je vypnutá, přihlas se přes SSO' });
      const ip = clientIp(req);
      const a = loginAttempts.get('reg:' + ip) || { n: 0, t: 0 };
      if (a.n >= 5 && Date.now() - a.t < 60 * 60e3) return send(res, 429, { error: 'příliš mnoho registrací z této adresy, zkus to za hodinu' });
      const b = await readBody(req);
      const name = String(b.username || '').trim();
      if (!/^[\w.@+-]{2,64}$/.test(name)) return send(res, 400, { error: 'jméno: 2–64 znaků, písmena/číslice/._@+-' });
      if (String(b.password || '').length < 8) return send(res, 400, { error: 'heslo musí mít aspoň 8 znaků' });
      if (db.getUserAuth(name)) return send(res, 409, { error: 'tohle jméno už někdo má' });
      loginAttempts.set('reg:' + ip, { n: a.n + 1, t: Date.now() });
      const id = db.insertUser({ name, pass_hash: hashPassword(b.password), role: 'user' });
      db.updateUser(id, { last_login_at: Date.now() });
      db.audit(name, 'registrace účtu', ip);
      const tok = makeSession({ id, name, role: 'user' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': `mtu_session=${tok}; ${cookieAttrs}` });
    }
    const session = checkSession(cookies(req).mtu_session);
    // uživatel se načte z DB při každém požadavku: změna role, hesla nebo vypnutí účtu platí hned
    const dbUser = session ? db.getUser(session.user.id) : null;
    req.user = dbUser && !dbUser.disabled ? { id: dbUser.id, name: dbUser.name, role: dbUser.role } : null;
    const authed = !!req.user;
    if (method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': `mtu_session=; Path=${cfg.basePath || '/'}; HttpOnly; Max-Age=0` });
    // pro deploy: co právě běží (bez přihlášení, jen počty) — restart služby by to přerušil
    if (p === '/api/busy') return send(res, 200, { jobs: runner.running().length, discovery: discovery.busy, scanning: scanner.inProgress.size, draining: runner.draining });
    // pro deploy (jen přímo z localhostu): drain = běžící joby dokončí aktuální zařízení a pozastaví se, nové se jen zařadí; po restartu pokračují
    if (p === '/api/drain') {
      const sock = req.socket && req.socket.remoteAddress;
      if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(sock)) return send(res, 403, { error: 'jen z localhostu' });
      const on = url.searchParams.get('on');
      if (on != null) { runner.setDraining(on === '1'); console.log(`drain ${on === '1' ? 'zapnut' : 'vypnut'} (deploy)`); }
      return send(res, 200, { draining: runner.draining, jobs: runner.running().length });
    }
    if (p === '/api/whoami') return send(res, 200, { authed, user: req.user, admin: authed && isAdmin(req), userdb: userdbFor(req), serverStartedAt: SERVER_STARTED_AT, sourceIp: cfg.sourceIp, draining: runner.draining, sso: sso.enabled(), passwordLogin: pwLoginAllowed(req), registration: !!db.getSettings().allow_registration, netHint: cfg.netHint });

    if (p.startsWith('/api/')) {
      if (!authed) return send(res, 401, { error: 'nepřihlášen' });
      return await api(req, res, method, p, url);
    }
    // statika
    if (p === '/') p = '/index.html';
    const file = path.join(cfg.publicDir, path.normalize(p));
    if (!file.startsWith(cfg.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: e.message });
    else try { res.end(); } catch {}
  }
});

// první spuštění: účet správce z MTU_ADMIN_USER + MTU_PASSWORD, dosavadní zařízení a joby připadnou jemu
if (cfg.password) { const id = db.bootstrapAdmin(cfg.adminUser, hashPassword(cfg.password)); if (id) console.log(`založen účet správce „${cfg.adminUser}" (#${id}); heslo = MTU_PASSWORD, změň si ho v aplikaci`); }
else if (!db.listUsers().length) { console.error('žádný uživatel a MTU_PASSWORD není nastaveno — nastav MTU_ADMIN_USER + MTU_PASSWORD pro založení správce'); }

server.listen(cfg.port, cfg.host, () => {
  console.log(`mikrotik-upgrader běží na http://${cfg.host}:${cfg.port}${cfg.basePath}/ (data v ${cfg.dataDir})`);
  V.refreshLatest().then(l => console.log('nejnovější verze:', JSON.stringify(Object.fromEntries(Object.entries(l.versions).map(([k, v]) => [k, v.version]))))).catch(e => console.error('verze:', e.message));
  scanner.startPeriodic();
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
