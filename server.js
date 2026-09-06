'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const cfg = require('./lib/config');
const db = require('./lib/db');
const { encrypt, decrypt, makeSession, checkSession, hashPassword, verifyPassword } = require('./lib/crypto');
const V = require('./lib/versions');
const { Runner } = require('./lib/runner');
const { Scanner } = require('./lib/scanner');
const { plan } = require('./lib/planner');
const sso = require('./lib/sso');
const { Discovery } = require('./lib/discovery');

const bus = new EventEmitter();
bus.setMaxListeners(200);
const runner = new Runner();
runner.on('event', (ev) => bus.emit('event', ev));
const scanner = new Scanner(runner, bus);
const discovery = new Discovery(bus);
// nově nalezená zařízení ze skenu rozsahu hned plně naskenovat (uptime, místo, topologie…)
bus.on('event', (ev) => { if (ev.type === 'discovery-done' && ev.state) { const ids = (ev.state.found || []).filter(f => f.id).map(f => f.id); if (ids.length) scanner.scanAll(ids).catch(() => {}); } });

const { suggestParent } = require('./lib/topology');
function withSuggestions(devs) {
  return devs.map(d => ({ ...d, suggested_parent: suggestParent(d, devs) }));
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
function clientIp(req) { return (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

function validateDevice(d) {
  if (!d.host || !/^[A-Za-z0-9.:_-]+$/.test(d.host)) throw new Error('neplatný host');
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
  const st = runner.status();
  if (!st.running || isAdmin(req)) return st;
  const job = db.getJob(st.jobId);
  return ownsJob(req, job) ? st : { running: true, foreign: true, jobId: 0, itemId: 0, deviceId: 0 };
};
const discoveryFor = (req) => { const st = discovery.status(); return st && (isAdmin(req) || st.ownerId === req.user.id) ? st : null; };
/** SSE: událost projde jen tomu, kdo smí vidět dotčené zařízení / job */
function eventFor(req, ev) {
  if (isAdmin(req)) return ev;
  const uid = req.user.id;
  switch (ev.type) {
    case 'device': return ev.device && ev.device.owner_id === uid ? ev : null;
    case 'device-deleted': return ev.owner_id === uid ? ev : null;
    case 'job': return ev.job && ev.job.owner_id === uid ? ev : null;
    case 'item': { const j = ev.item && db.getJob(ev.item.job_id); return j && j.owner_id === uid ? ev : null; }
    case 'log': { const j = ev.log && db.getJob(ev.log.job_id); return j && j.owner_id === uid ? ev : null; }
    case 'runner': return { ...ev, status: runnerStatusFor(req) };
    case 'discovery': case 'discovery-done': return ev.state && ev.state.ownerId === uid ? ev : null;
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
    return send(res, 200, { latest: V.getLatest(), settings: db.getSettings(), devices: withSuggestions(visDevices(req)), jobs: visJobs(req, 30), runner: runnerStatusFor(req), tracks: TRACKS, scanning: [...scanner.inProgress], discovery: discoveryFor(req), admin: isAdmin(req), user: req.user });
  }
  if (method === 'POST' && p === '/api/versions/refresh') { const l = await V.refreshLatest(true); bus.emit('event', { type: 'latest', latest: l }); return send(res, 200, l); }
  if (method === 'GET' && seg[0] === 'changelog' && seg[1]) return send(res, 200, await V.getChangelog(seg[1]));

  // nastavení
  if (method === 'GET' && p === '/api/settings') return send(res, 200, db.getSettings());
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
      if (target) { if (!db.getUser(target)) throw new Error('cílový uživatel neexistuje'); db.db.prepare('UPDATE devices SET owner_id=? WHERE owner_id=?').run(target, uid); db.db.prepare('UPDATE jobs SET owner_id=? WHERE owner_id=?').run(target, uid); }
      db.deleteUser(uid);
      audit(req, 'uživatel smazán', `${u.name}${target ? ` (zařízení předána #${target})` : ''}`);
      return send(res, 200, { ok: true });
    }
  }

  // zařízení
  if (method === 'GET' && p === '/api/devices') return send(res, 200, withSuggestions(visDevices(req)));
  // sken rozsahů
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
    discovery.prepare(o); // validace → 400 s popisem chyby
    audit(req, 'sken rozsahu', [...ranges, ...(entries.length ? [`${entries.length} zařízení ze seznamu`] : [])].join(' '));
    discovery.run(o).catch(e => bus.emit('event', { type: 'discovery-error', error: e.message }));
    await new Promise(r => setTimeout(r, 50));
    return send(res, 200, discovery.status());
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
      audit(req, 'zařízení smazáno', `${d.host} ${d.name || d.identity || ''}`);
      bus.emit('event', { type: 'device-deleted', id, owner_id: d.owner_id });
    }
    return send(res, 200, { deleted, skipped });
  }
  // hromadné přebrání detekovaných rodičů (jen kde není nastaven)
  if (method === 'POST' && p === '/api/devices/accept-parents') {
    const b = await readBody(req).catch(() => ({}));
    const all = visDevices(req);
    let n = 0;
    for (const d of all) {
      if (d.parent_id && !b.overwrite) continue;
      const sp = suggestParent(d, all);
      if (sp && sp.id && sp.id !== d.parent_id && !db.descendantIds(d.id).includes(sp.id)) { db.updateDevice(d.id, { parent_id: sp.id }); n++; }
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
      for (const k of ['host', 'port', 'username', 'name', 'group_name', 'priority', 'enabled', 'track', 'notes', 'parent_id', 'managed']) if (k in b) f[k] = b[k];
      if ('owner_id' in b && isAdmin(req)) { f.owner_id = +b.owner_id || 0; if (f.owner_id && !db.getUser(f.owner_id)) throw new Error('vlastník neexistuje'); }
      if ('parent_id' in f) { f.parent_id = +f.parent_id || 0; if (f.parent_id === id || db.descendantIds(id).includes(f.parent_id)) throw new Error('nadřazený prvek nemůže být zařízení samo ani jeho potomek'); if (f.parent_id && !canSee(req, db.getDevice(f.parent_id))) throw new Error('nadřazený prvek neexistuje'); }
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
      const opts = { mode: q.get('mode') || 'upload', allow_routing_migration: q.get('allow_routing') === '1', allow_small_flash: q.get('allow_small_flash') === '1' };
      const pl = await plan(dev, { track: q.get('track') || dev.track, settings: db.getSettings(), latest: V.getLatest(), options: opts });
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
      canary: !!o.canary, window: (o.window || '').trim(), pause_sec: Number.isFinite(+o.pause_sec) ? +o.pause_sec : undefined,
      require_binary_backup: !!o.require_binary_backup, allow_routing_migration: !!o.allow_routing_migration, allow_small_flash: !!o.allow_small_flash,
      device_mode: o.device_mode !== false,
      precheck: o.precheck !== false,
    };
    if (options.window && !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(options.window)) throw new Error('servisní okno zadej jako HH:MM-HH:MM');
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
    if (b.start) runner.start(jobId);
    bus.emit('event', { type: 'job', job: db.listJobs(1)[0] });
    return send(res, 200, { id: jobId });
  }
  if (seg[0] === 'jobs' && seg[1]) {
    const id = parseInt(seg[1], 10);
    const job = db.getJob(id);
    if (!ownsJob(req, job)) return send(res, 404, { error: 'job neexistuje' });
    if (method === 'GET' && !seg[2]) return send(res, 200, { job, items: db.getJobItems(id), log: db.getLog(id, parseInt(q.get('after') || '0', 10)) });
    if (method === 'GET' && seg[2] === 'log') return send(res, 200, db.getLog(id, parseInt(q.get('after') || '0', 10)));
    if (method === 'POST' && seg[2] === 'start') { db.addLog(id, 0, 0, 'info', `Spuštění: ${who(req)}`); audit(req, 'job spuštěn', `#${id} ${job.name}`); runner.start(id); return send(res, 200, runner.status()); }
    if (method === 'POST' && seg[2] === 'pause') { if (runner.currentJobId !== id) throw new Error('tento job neběží'); db.addLog(id, 0, 0, 'info', `Pozastavení: ${who(req)}`); audit(req, 'job pozastaven', `#${id}`); runner.pause(); return send(res, 200, runner.status()); }
    if (method === 'POST' && seg[2] === 'cancel') {
      db.addLog(id, 0, 0, 'warn', `Zrušení: ${who(req)}`); audit(req, 'job zrušen', `#${id}`);
      if (runner.currentJobId === id) runner.cancel();
      else { db.updateJob(id, { status: 'cancelled', status_note: 'zrušeno', finished_at: db.now() }); for (const it of db.getJobItems(id)) if (it.status === 'pending') db.updateJobItem(it.id, { status: 'skipped', error: 'job zrušen' }); }
      bus.emit('event', { type: 'job', job: db.listJobs(200).find(j => j.id === id) });
      return send(res, 200, runner.status());
    }
    if (method === 'POST' && seg[2] === 'continue') {
      db.addLog(id, 0, 0, 'info', `Pokračování: ${who(req)}`); audit(req, 'job pokračuje', `#${id}`);
      if (job.options.canary && job.status === 'waiting' && !/^kontrola hotová/.test(job.status_note || '')) db.updateJob(id, { options: { ...job.options, canaryDone: true } });
      runner.start(id);
      return send(res, 200, runner.status());
    }
    if (method === 'POST' && seg[2] === 'skip-current') { if (runner.currentJobId !== id) throw new Error('tento job neběží'); db.addLog(id, 0, 0, 'warn', `Přeskočení aktuálního: ${who(req)}`); audit(req, 'job přeskočení', `#${id}`); runner.skipCurrent(); return send(res, 200, { ok: true }); }
    if (method === 'DELETE' && !seg[2]) { if (runner.currentJobId === id) throw new Error('job právě běží'); audit(req, 'job smazán', `#${id} ${job.name}`); db.deleteJob(id); bus.emit('event', { type: 'job-deleted', id }); return send(res, 200, { ok: true }); }
  }
  if (seg[0] === 'items' && seg[1] && method === 'POST') {
    const it = db.getJobItem(parseInt(seg[1], 10));
    if (!it || !ownsJob(req, db.getJob(it.job_id))) return send(res, 404, { error: 'položka neexistuje' });
    if (runner.currentItemId === it.id) throw new Error('položka právě běží');
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
        db.updateUser(u.id, { last_login_at: Date.now() });
        const tok = makeSession(u);
        console.log(`SSO přihlášení: ${u.name} z ${clientIp(req)}`);
        db.audit(u.name, 'přihlášení SSO', clientIp(req));
        res.writeHead(302, { Location: (cfg.basePath || '') + '/', 'Set-Cookie': `mtu_session=${tok}; ${cookieAttrs}`, 'Cache-Control': 'no-store' });
        return res.end();
      } catch (e) { return send(res, 401, `Přihlášení přes SSO se nezdařilo: ${e.message}`); }
    }
    // login
    if (method === 'POST' && p === '/api/login') {
      if (!cfg.passwordLogin) return send(res, 400, { error: 'přihlášení heslem je vypnuté, použij SSO' });
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
      if (!db.getSettings().allow_registration) return send(res, 403, { error: 'registrace je vypnutá, požádej správce o účet' });
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
    if (p === '/api/whoami') return send(res, 200, { authed, user: req.user, admin: authed && isAdmin(req), sso: sso.enabled(), passwordLogin: cfg.passwordLogin, registration: !!db.getSettings().allow_registration, netHint: cfg.netHint });

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
