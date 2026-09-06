'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(cfg.backupDir, { recursive: true });
fs.mkdirSync(cfg.pkgDir, { recursive: true });

const db = new DatabaseSync(cfg.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  name TEXT DEFAULT '',
  group_name TEXT DEFAULT '',
  priority INTEGER DEFAULT 100,
  enabled INTEGER DEFAULT 1,
  track TEXT DEFAULT 'v7-stable',
  notes TEXT DEFAULT '',
  host_key TEXT DEFAULT '',
  -- stav ze skenu
  identity TEXT DEFAULT '',
  board_name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  serial TEXT DEFAULT '',
  arch TEXT DEFAULT '',
  version TEXT DEFAULT '',
  channel TEXT DEFAULT '',
  fw_current TEXT DEFAULT '',
  fw_upgrade TEXT DEFAULT '',
  total_hdd INTEGER DEFAULT 0,
  free_hdd INTEGER DEFAULT 0,
  total_mem INTEGER DEFAULT 0,
  free_mem INTEGER DEFAULT 0,
  uptime_sec INTEGER DEFAULT 0,
  cpu_load INTEGER DEFAULT 0,
  packages TEXT DEFAULT '[]',
  flags TEXT DEFAULT '{}',
  scan_status TEXT DEFAULT 'never',
  scan_error TEXT DEFAULT '',
  last_scan_at INTEGER DEFAULT 0,
  last_seen_at INTEGER DEFAULT 0,
  last_upgrade_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(host, port)
);
CREATE TABLE IF NOT EXISTS version_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  firmware TEXT DEFAULT '',
  seen_at INTEGER NOT NULL,
  source TEXT DEFAULT 'scan'
);
CREATE INDEX IF NOT EXISTS vh_dev ON version_history(device_id, seen_at);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  status_note TEXT DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  started_at INTEGER DEFAULT 0,
  finished_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ord INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  step TEXT DEFAULT '',
  from_version TEXT DEFAULT '',
  to_version TEXT DEFAULT '',
  from_fw TEXT DEFAULT '',
  to_fw TEXT DEFAULT '',
  plan TEXT DEFAULT '{}',
  result TEXT DEFAULT '{}',
  error TEXT DEFAULT '',
  warnings TEXT DEFAULT '[]',
  started_at INTEGER DEFAULT 0,
  finished_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ji_job ON job_items(job_id, ord);
CREATE TABLE IF NOT EXISTS job_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id INTEGER DEFAULT 0,
  device_id INTEGER DEFAULT 0,
  ts INTEGER NOT NULL,
  level TEXT DEFAULT 'info',
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jl_job ON job_log(job_id, id);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  job_item_id INTEGER DEFAULT 0,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  version TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bk_dev ON backups(device_id, created_at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const now = () => Math.floor(Date.now() / 1000);

// migrace sloupců
const devCols = new Set(db.prepare('PRAGMA table_info(devices)').all().map(r => r.name));
if (!devCols.has('parent_id')) db.exec('ALTER TABLE devices ADD COLUMN parent_id INTEGER DEFAULT 0');
if (!devCols.has('managed')) db.exec('ALTER TABLE devices ADD COLUMN managed INTEGER DEFAULT 1');

// ---- settings ----
const DEFAULT_SETTINGS = {
  allow_v7_small_flash: false,      // povolit v7 na zařízeních s <=16 MB flash
  allow_v7_routing_migration: false, // povolit v6->v7 na zařízeních s BGP/OSPF/filtry/MPLS
  min_free_mem_mb: 8,
  min_uptime_min: 10,
  space_margin_mb: 1.5,
  reboot_timeout_min: 15,
  pause_between_devices_sec: 60,
  ssh_timeout_sec: 20,
  min_release_age_days: 3,        // neupgradovat na verzi mladší než N dní (čerstvé verze mívají kernel bugy/bootloopy)
  bad_versions: '',               // seznam verzí, na které se nikdy neupgraduje (čárkou)
  v7_via_712_small_flash: true,   // u 16MB zařízení jít na v7 přes mezikrok 7.12.x (menší footprint, viz fórum)
  firmware_before_v7: true,       // před přechodem 6→7 nejdřív RouterBOOT z v6 (dle doporučení MikroTik)
  use_partition_fallback: true,   // pokud má zařízení víc oddílů, před upgradem zkopírovat běžící systém do záložního oddílu a nastavit fallback
  harden_services: false,         // při ostrém běhu nastavit /ip service: nepotřebné služby vypnout, zbytek omezit na adresy
  services_keep: 'ssh,winbox',    // služby, které zůstanou zapnuté (ssh vždy)
  services_address: '',           // povolené adresy/CIDR (čárkou) pro všechny služby; prázdné = adresy neměnit
  remote_log_enable: false,       // při ostrém běhu zajistit vzdálené logování (/system logging action target=remote + pravidla)
  remote_log_host: '',            // IP syslog serveru
  remote_log_name: 'remote',      // název logging action
  remote_log_topics: 'critical,error,info,warning', // topics, pro která se založí pravidlo → akce
};
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}
function setSettings(obj) {
  const st = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    st.run(k, JSON.stringify(v));
  }
}

// ---- devices ----
const DEVICE_COLS = ['id','host','port','username','name','group_name','priority','enabled','track','notes','parent_id','managed',
  'identity','board_name','model','serial','arch','version','channel','fw_current','fw_upgrade',
  'total_hdd','free_hdd','total_mem','free_mem','uptime_sec','cpu_load','packages','flags',
  'scan_status','scan_error','last_scan_at','last_seen_at','last_upgrade_at','created_at','updated_at','host_key'];

function rowToDevice(r) {
  if (!r) return null;
  const d = {};
  for (const c of DEVICE_COLS) d[c] = r[c];
  d.enabled = !!d.enabled;
  d.managed = d.managed !== 0;
  try { d.packages = JSON.parse(d.packages || '[]'); } catch { d.packages = []; }
  try { d.flags = JSON.parse(d.flags || '{}'); } catch { d.flags = {}; }
  d.has_host_key = !!d.host_key;
  delete d.host_key;
  return d;
}
function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY priority, group_name, name, host').all().map(rowToDevice);
}
function getDevice(id) {
  return rowToDevice(db.prepare('SELECT * FROM devices WHERE id=?').get(id));
}
function getDeviceRaw(id) {
  return db.prepare('SELECT * FROM devices WHERE id=?').get(id);
}
function findDeviceByHost(host, port) {
  return db.prepare('SELECT * FROM devices WHERE host=? AND port=?').get(host, port);
}
function insertDevice(d) {
  const t = now();
  const r = db.prepare(`INSERT INTO devices(host, port, username, password_enc, name, group_name, priority, enabled, track, notes, parent_id, managed, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.host, d.port, d.username || '', d.password_enc || '', d.name || '', d.group_name || '',
    d.priority ?? 100, d.enabled === false ? 0 : 1, d.track || 'v7-stable', d.notes || '', d.parent_id || 0, d.managed === false ? 0 : 1, t, t);
  return Number(r.lastInsertRowid);
}
function updateDevice(id, fields) {
  const allowed = ['host','port','username','password_enc','name','group_name','priority','enabled','track','notes','host_key','parent_id','managed',
    'identity','board_name','model','serial','arch','version','channel','fw_current','fw_upgrade','total_hdd','free_hdd',
    'total_mem','free_mem','uptime_sec','cpu_load','packages','flags','scan_status','scan_error','last_scan_at','last_seen_at','last_upgrade_at'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k}=?`);
    let val = v;
    if (typeof val === 'boolean') val = val ? 1 : 0;
    if (val !== null && typeof val === 'object') val = JSON.stringify(val);
    vals.push(val);
  }
  if (!sets.length) return;
  sets.push('updated_at=?'); vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}
function deleteDevice(id) { db.prepare('UPDATE devices SET parent_id=0 WHERE parent_id=?').run(id); db.prepare('DELETE FROM devices WHERE id=?').run(id); }
/** id všech potomků (rekurzivně) */
function descendantIds(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const r of db.prepare('SELECT id FROM devices WHERE parent_id=?').all(cur)) if (!out.has(r.id)) { out.add(r.id); stack.push(r.id); }
  }
  return [...out];
}
function ancestorIds(id) {
  const out = [];
  let cur = db.prepare('SELECT parent_id FROM devices WHERE id=?').get(id);
  while (cur && cur.parent_id && !out.includes(cur.parent_id) && out.length < 50) { out.push(cur.parent_id); cur = db.prepare('SELECT parent_id FROM devices WHERE id=?').get(cur.parent_id); }
  return out;
}
function children(id) { return db.prepare('SELECT * FROM devices WHERE parent_id=?').all(id).map(rowToDevice); }

function addVersionHistory(deviceId, version, firmware, source) {
  const last = db.prepare('SELECT version, firmware FROM version_history WHERE device_id=? ORDER BY seen_at DESC, id DESC LIMIT 1').get(deviceId);
  if (last && last.version === version && (last.firmware || '') === (firmware || '')) return false;
  db.prepare('INSERT INTO version_history(device_id, version, firmware, seen_at, source) VALUES (?,?,?,?,?)').run(deviceId, version, firmware || '', now(), source || 'scan');
  return true;
}
function getVersionHistory(deviceId) {
  return db.prepare('SELECT * FROM version_history WHERE device_id=? ORDER BY seen_at DESC, id DESC LIMIT 200').all(deviceId);
}

// ---- jobs ----
function createJob(name, options, deviceIds) {
  const t = now();
  const r = db.prepare('INSERT INTO jobs(name, status, options, created_at) VALUES (?,?,?,?)').run(name || '', 'queued', JSON.stringify(options || {}), t);
  const jobId = Number(r.lastInsertRowid);
  const st = db.prepare('INSERT INTO job_items(job_id, device_id, ord) VALUES (?,?,?)');
  deviceIds.forEach((id, i) => st.run(jobId, id, i));
  return jobId;
}
function getJob(id) {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!j) return null;
  try { j.options = JSON.parse(j.options); } catch { j.options = {}; }
  return j;
}
function listJobs(limit = 50) {
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit).map(j => {
    try { j.options = JSON.parse(j.options); } catch { j.options = {}; }
    const c = db.prepare(`SELECT status, COUNT(*) n FROM job_items WHERE job_id=? GROUP BY status`).all(j.id);
    j.counts = Object.fromEntries(c.map(x => [x.status, x.n]));
    j.total = c.reduce((a, x) => a + x.n, 0);
    return j;
  });
}
function updateJob(id, fields) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['status','status_note','started_at','finished_at','options','name'].includes(k)) continue;
    sets.push(`${k}=?`); vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}
function getJobItems(jobId) {
  return db.prepare(`SELECT ji.*, d.host, d.name AS dev_name, d.identity, d.board_name, d.version AS dev_version, d.arch, d.parent_id
    FROM job_items ji JOIN devices d ON d.id = ji.device_id WHERE ji.job_id=? ORDER BY ji.ord, ji.id`).all(jobId).map(parseItem);
}
function parseItem(it) {
  if (!it) return it;
  for (const k of ['plan', 'result', 'warnings']) { try { it[k] = JSON.parse(it[k] || (k === 'warnings' ? '[]' : '{}')); } catch { it[k] = k === 'warnings' ? [] : {}; } }
  return it;
}
function getJobItem(id) { return parseItem(db.prepare('SELECT * FROM job_items WHERE id=?').get(id)); }
function updateJobItem(id, fields) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['status','step','from_version','to_version','from_fw','to_fw','plan','result','error','warnings','started_at','finished_at','ord'].includes(k)) continue;
    sets.push(`${k}=?`); vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE job_items SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}
function addLog(jobId, itemId, deviceId, level, msg) {
  const r = db.prepare('INSERT INTO job_log(job_id, item_id, device_id, ts, level, msg) VALUES (?,?,?,?,?,?)').run(jobId, itemId || 0, deviceId || 0, Date.now(), level, msg);
  return Number(r.lastInsertRowid);
}
function getLog(jobId, afterId = 0, limit = 2000) {
  return db.prepare('SELECT * FROM job_log WHERE job_id=? AND id>? ORDER BY id LIMIT ?').all(jobId, afterId, limit);
}
function getDeviceLog(deviceId, limit = 500) {
  return db.prepare('SELECT * FROM job_log WHERE device_id=? ORDER BY id DESC LIMIT ?').all(deviceId, limit).reverse();
}
function deleteJob(id) { db.prepare('DELETE FROM jobs WHERE id=?').run(id); }

// ---- backups ----
function addBackup(b) {
  const r = db.prepare('INSERT INTO backups(device_id, job_item_id, kind, filename, size, version, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(b.device_id, b.job_item_id || 0, b.kind, b.filename, b.size || 0, b.version || '', now());
  return Number(r.lastInsertRowid);
}
function listBackups(deviceId) {
  return db.prepare('SELECT * FROM backups WHERE device_id=? ORDER BY created_at DESC, id DESC').all(deviceId);
}
function getBackup(id) { return db.prepare('SELECT * FROM backups WHERE id=?').get(id); }

function audit(user, action, detail) { db.prepare('INSERT INTO audit(ts, user, action, detail) VALUES (?,?,?,?)').run(Date.now(), user || '', action, String(detail || '').slice(0, 500)); }
function listAudit(limit = 200) { return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit); }

module.exports = {
  db, now, audit, listAudit, DEFAULT_SETTINGS, getSettings, setSettings,
  listDevices, getDevice, getDeviceRaw, findDeviceByHost, insertDevice, updateDevice, deleteDevice, descendantIds, ancestorIds, children,
  addVersionHistory, getVersionHistory,
  createJob, getJob, listJobs, updateJob, getJobItems, getJobItem, updateJobItem, addLog, getLog, getDeviceLog, deleteJob,
  addBackup, listBackups, getBackup,
};
