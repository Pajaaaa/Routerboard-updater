'use strict';
/**
 * Klient userdb.hkfree.org (evidence oblastí, APček a jejich správců + přihlašovací údaje k zařízením).
 *
 * Nastavení (env): MTU_USERDB_URL (výchozí https://userdb.hkfree.org/userdb/api), MTU_USERDB_USER, MTU_USERDB_PASS
 * (API klíč, HTTP basic). Bez uživatele/hesla je modul vypnutý (enabled() = false).
 * Zařízení APčka: GET /monitoring/get-zarizeni?ap=<apId>&uzivatele=1 (MonitoringPresenter::actionGetZarizeni, opraveno 9/2026):
 * vrátí zařízení samotného APčka (Ap_id) i zařízení členů pod ním (Uzivatel_id). Typ zařízení se neřeší — typy v userdb
 * plní lidé a nejsou spolehlivé; co je opravdu RouterOS, rozhodne až sken upgraderu po SSH.
 */
const https = require('https');
const http = require('http');

const cfg = {
  url: (process.env.MTU_USERDB_URL || 'https://userdb.hkfree.org/userdb/api').replace(/\/+$/, ''),
  user: process.env.MTU_USERDB_USER || '',
  pass: process.env.MTU_USERDB_PASS || '',
  cacheMs: parseInt(process.env.MTU_USERDB_CACHE_MIN || '10', 10) * 60 * 1000,
  timeoutMs: 15000,
};

function enabled() { return !!(cfg.user && cfg.pass); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { auth: `${cfg.user}:${cfg.pass}`, headers: { accept: 'application/json' }, timeout: cfg.timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`userdb ${u.pathname}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`userdb ${u.pathname}: odpověď není JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`userdb ${u.pathname}: timeout`)));
    req.on('error', reject);
  });
}

const vals = x => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

let areasCache = null; // { at, areas: [...] }
/** Všechny oblasti normalizované: [{ id, name, aps: [{id, name, active, gps, address}], admins: [{id, nick, email, role}] }] */
async function areas(force) {
  if (!force && areasCache && Date.now() - areasCache.at < cfg.cacheMs) return areasCache.areas;
  const raw = await getJson(cfg.url + '/areas');
  const list = vals(raw).map(a => ({
    id: Number(a.id), name: String(a.jmeno || a.id),
    aps: vals(a.aps).map(p => ({ id: Number(p.id), name: String(p.jmeno || p.id), active: p.aktivni == null ? true : !!Number(p.aktivni), gps: p.gps || '', address: [p.ulice_cp, p.mesto, p.psc].filter(Boolean).join(', ') })),
    admins: vals(a.admins).map(u => ({ id: Number(u.id), nick: String(u.nick || ''), email: String(u.email || '').trim().toLowerCase(), role: String(u.role || '') })),
  })).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  areasCache = { at: Date.now(), areas: list };
  return list;
}

/** Najde správce podle UID (userdb id), e-mailu nebo přezdívky. Vrátí { id, nick, email, areas:[{id,name,role,aps}] } nebo null. */
async function whoIs({ uid, email, nick } = {}, force) {
  const all = await areas(force);
  const em = email ? String(email).trim().toLowerCase() : '';
  const nk = nick ? String(nick).trim().toLowerCase() : '';
  const id = uid != null && uid !== '' ? Number(uid) : null;
  let found = null;
  const out = [];
  for (const a of all) {
    for (const u of a.admins) {
      const hit = (id != null && u.id === id) || (em && u.email === em) || (!id && !em && nk && u.nick.toLowerCase() === nk);
      if (!hit) continue;
      found = found || { id: u.id, nick: u.nick, email: u.email };
      out.push({ id: a.id, name: a.name, role: u.role, aps: a.aps });
    }
  }
  if (!found) return null;
  out.sort((a, b) => (a.role === 'SO' ? 0 : 1) - (b.role === 'SO' ? 0 : 1) || a.name.localeCompare(b.name, 'cs'));
  return { ...found, areas: out, apCount: out.reduce((n, a) => n + a.aps.length, 0) };
}

/** Přihlašovací údaje k zařízení podle IP: { ip, login, password } nebo null, když IP v userdb není. */
async function getCredentials(ip) {
  const r = await getJson(`${cfg.url}/device/get-credentials/${encodeURIComponent(String(ip).trim())}`);
  if (!r || !r.login) return null;
  return { ip: r.ip || ip, login: String(r.login), password: String(r.heslo == null ? '' : r.heslo) };
}

const devCache = new Map(); // apId -> { at, list }
/** Zařízení APčka i členů pod ním: [{ ip, name, note, member, userId }]. */
async function devicesForAp(apId, force) {
  const c = devCache.get(Number(apId));
  if (!force && c && Date.now() - c.at < cfg.cacheMs) return c.list;
  const r = await getJson(`${cfg.url}/monitoring/get-zarizeni?ap=${encodeURIComponent(apId)}&uzivatele=1`);
  if (!r || r.result !== 'OK') throw new Error(`userdb get-zarizeni ap=${apId}: ${r && r.result}`);
  const z = r.zarizeni && !Array.isArray(r.zarizeni) ? r.zarizeni : {};
  const list = Object.entries(z).filter(([, d]) => d).map(([ip, d]) => ({
    ip, name: String(d.hostname || '').trim(), note: String(d.popis || '').trim(),
    member: !!d.Uzivatel_id, userId: Number(d.Uzivatel_id || 0),
  }));
  devCache.set(Number(apId), { at: Date.now(), list });
  return list;
}

/** Kompletní seznam zařízení správce (APčka + členové pod nimi; volitelně jen vybraná APčka `apIds`) včetně loginů: [{ ip, login, password, name, note, member, userId, ap, apId, area, areaId }] */
async function devicesFor(who, { apIds = null, concurrency = 6 } = {}) {
  const w = typeof who === 'object' && who.areas ? who : await whoIs(who);
  if (!w) return { admin: null, devices: [], missing: [] };
  const only = apIds && apIds.length ? new Set(apIds.map(Number)) : null;
  const todo = [];
  for (const a of w.areas) for (const ap of a.aps) {
    if (only && !only.has(ap.id)) continue;
    for (const d of await devicesForAp(ap.id)) todo.push({ d, ap, a });
  }
  const devices = [], missing = [];
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const { d, ap, a } = todo[i++];
      const c = await getCredentials(d.ip).catch(() => null);
      if (c) devices.push({ ...c, name: d.name || '', note: d.note || '', member: d.member, userId: d.userId, ap: ap.name, apId: ap.id, area: a.name, areaId: a.id });
      else missing.push({ ip: d.ip, name: d.name || d.note || '', member: d.member, ap: ap.name, apId: ap.id, area: a.name });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length || 1)) }, worker));
  const key = x => x.ip.split('.').map(n => n.padStart(3, '0')).join('.');
  devices.sort((x, y) => x.apId - y.apId || key(x).localeCompare(key(y)));
  return { admin: w, devices, missing };
}

module.exports = { enabled, areas, whoIs, getCredentials, devicesForAp, devicesFor, cfg };
