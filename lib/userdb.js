'use strict';
/**
 * Klient userdb.hkfree.org (evidence oblastí, APček a jejich správců + přihlašovací údaje k zařízením).
 *
 * Nastavení (env): MTU_USERDB_URL (výchozí https://userdb.hkfree.org/userdb/api), MTU_USERDB_USER, MTU_USERDB_PASS
 * (API klíč, HTTP basic). Bez uživatele/hesla je modul vypnutý (enabled() = false).
 * Zařízení APčka: GET /monitoring/get-zarizeni?typ=<typ>&ap=<apId> (MonitoringPresenter::actionGetZarizeni; typ 2 = RouterBoard,
 * 7 = Switch, viz /monitoring/get-typy-zarizeni). Bez &ap= vrátí všechna zařízení daného typu na všech APčkách (Ap_id u každé IP),
 * což je jeden dotaz na typ místo stovek → drží se v cache. Berou se VŠECHNY typy zařízení (seznam z /monitoring/get-typy-zarizeni):
 * typy v userdb plní lidé a nejsou spolehlivé, co je opravdu RouterOS rozhodne až sken upgraderu po SSH. Typ se nese jen jako
 * poznámka. MTU_USERDB_DEVICE_TYPES může výběr zúžit (např. "2,7"), výchozí prázdné = vše.
 *
 * Oblast (area) má správce (admins: id, nick, email, role SO = správce oblasti / ZSO = zástupce) a APčka (aps: id, jmeno,
 * gps, adresa). Správci jsou vždy "oblastí", ne jednotlivých APček.
 */
const https = require('https');
const http = require('http');

const cfg = {
  url: (process.env.MTU_USERDB_URL || 'https://userdb.hkfree.org/userdb/api').replace(/\/+$/, ''),
  user: process.env.MTU_USERDB_USER || '',
  pass: process.env.MTU_USERDB_PASS || '',
  deviceTypes: String(process.env.MTU_USERDB_DEVICE_TYPES || '').split(/[\s,;]+/).filter(Boolean), // prázdné = všechny typy
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

let typesCache = null;
/** Číselník typů zařízení { <id>: název } (jen informativní). */
async function deviceTypes(force) {
  if (!force && typesCache) return typesCache;
  const r = await getJson(`${cfg.url}/monitoring/get-typy-zarizeni`);
  if (!r || r.result !== 'OK' || !r.typyZarizeni) throw new Error('userdb get-typy-zarizeni: ' + (r && r.result));
  typesCache = Object.fromEntries(Object.entries(r.typyZarizeni).map(([k, v]) => [Number(k), String(v)]));
  return typesCache;
}

let devCache = null; // { at, byAp: Map<apId, [...]>, unassigned: [...] }
const c24 = ip => ip.split('.').slice(0, 3).join('.');
/**
 * Všechna zařízení importovaných typů: zařízení APček i zařízení členů pod APčky (uzivatele=1), seskupená podle AP.
 * Členská zařízení mají v userdb jen Uzivatel_id. Pokud API vrací i Ap_id člena (patch docs/userdb-monitoring-ap-clenu.patch),
 * je přiřazení přesné (member: true). Bez něj se AP odhaduje ze subnetu (apGuess: true): 3. oktet = id starého AP,
 * nebo /24, ve kterém má zařízení jen jedno APčko. Nejednoznačné IP zůstanou v `unassigned`.
 */
async function devicesByAp(force) {
  if (!force && devCache && Date.now() - devCache.at < cfg.cacheMs) return devCache.byAp;
  const byAp = new Map();
  const types = await deviceTypes();
  const wanted = cfg.deviceTypes.length ? cfg.deviceTypes.map(Number) : Object.keys(types).map(Number);
  const members = [];
  const add = (apId, d) => { const l = byAp.get(Number(apId)) || []; l.push(d); byAp.set(Number(apId), l); };
  for (const typ of wanted) {
    const r = await getJson(`${cfg.url}/monitoring/get-zarizeni?typ=${encodeURIComponent(typ)}&uzivatele=1`);
    if (!r || r.result !== 'OK') throw new Error(`userdb get-zarizeni typ=${typ}: ${r && r.result}`);
    const z = r.zarizeni && !Array.isArray(r.zarizeni) ? r.zarizeni : {};
    for (const [ip, d] of Object.entries(z)) {
      if (!d) continue;
      const rec = { ip, name: String(d.hostname || '').trim(), note: String(d.popis || '').trim(), type: typ, typeName: types[typ] || String(typ) };
      if (d.Ap_id && !d.Uzivatel_id) add(d.Ap_id, rec);
      else if (d.Uzivatel_id) { rec.member = true; rec.userId = Number(d.Uzivatel_id); if (d.Ap_id) add(d.Ap_id, rec); else members.push(rec); }
    }
  }
  // odhad AP pro členy bez Ap_id (API bez patche)
  const unassigned = [];
  if (members.length) {
    const sub = new Map(); // /24 → Set(apId) podle zařízení APček
    for (const [ap, list] of byAp) for (const d of list) if (!d.member) { const k = c24(d.ip); if (!sub.has(k)) sub.set(k, new Set()); sub.get(k).add(ap); }
    for (const m of members) {
      const oct = Number(m.ip.split('.')[2]); const set = sub.get(c24(m.ip));
      let ap = null;
      if (m.ip.startsWith('10.107.') && byAp.has(oct) && (!set || set.has(oct))) ap = oct;
      else if (set && set.size === 1) ap = [...set][0];
      if (ap != null) add(ap, { ...m, apGuess: true }); else unassigned.push(m);
    }
  }
  devCache = { at: Date.now(), byAp, unassigned };
  return byAp;
}

/** Členská zařízení, která nešlo přiřadit k žádnému APčku (jen bez patche API). */
async function unassignedMembers() { await devicesByAp(); return devCache.unassigned; }

/** Zařízení (IP) patřící k APčku: [{ ip, name, note, type }]. */
async function devicesForAp(apId, force) { return (await devicesByAp(force)).get(Number(apId)) || []; }

/** Kompletní seznam zařízení správce (přes všechny jeho oblasti a APčka) včetně loginů: [{ ip, login, password, name, ap, area }] */
async function devicesFor(who) {
  const w = typeof who === 'object' && who.areas ? who : await whoIs(who);
  if (!w) return { admin: null, devices: [], missing: [] };
  const devices = [], missing = [];
  for (const a of w.areas) for (const ap of a.aps) {
    for (const d of await devicesForAp(ap.id)) {
      const c = await getCredentials(d.ip).catch(() => null);
      if (c) devices.push({ ...c, name: d.name || '', note: d.note || '', type: d.type, typeName: d.typeName, member: !!d.member, userId: d.userId || 0, apGuess: !!d.apGuess, ap: ap.name, apId: ap.id, area: a.name, areaId: a.id });
      else missing.push({ ip: d.ip, name: d.name || d.note || '', typeName: d.typeName, member: !!d.member, apGuess: !!d.apGuess, ap: ap.name, area: a.name });
    }
  }
  return { admin: w, devices, missing };
}

module.exports = { enabled, areas, whoIs, getCredentials, deviceTypes, devicesByAp, unassignedMembers, devicesForAp, devicesFor, cfg };
