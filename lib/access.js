'use strict';
/**
 * Sdílený přístup podle APčka (4.11.2026): zařízení pod APčkem z userdb vidí a spravují VŠICHNI správci jeho oblasti — správce (SO)
 * i zástupce (ZSO) — a účty, kterým správce nástroje APčko přidělil ve Správě (users.userdb_aps). Dřív ho viděl jen „vlastník“
 * (owner_id = kdo ho naimportoval), kolega z téže oblasti k němu neměl přístup a musel si ho přebírat.
 * Vlastník zůstává (kdo ho založil / komu ho správce přidělil): určuje nastavení kanálu u zařízení (effectiveTrack) a hlídá
 * zařízení bez APčka (ručně přidaná bez vazby na userdb vidí dál jen vlastník a správce nástroje).
 *
 * Mapa účet → APčka se skládá z userdb (oblasti → admins) a users.userdb_aps; obnovuje se s keší userdb (10 min) a hned po změně účtů
 * (invalidate). Všechny kontroly jsou synchronní nad mapou v paměti — volají se na každý požadavek i SSE událost.
 */
const db = require('./db');
const userdb = require('./userdb');

const EMPTY = new Set();
let apsByUser = new Map(); // id účtu → Set(id APčka)
let builtAt = 0;
let pending = null;
const ttl = () => (userdb.cfg && userdb.cfg.cacheMs) || 10 * 60e3;

/** přestaví mapu účet → APčka; při chybě userdb nechá starou (lepší než nikomu nic) */
function refresh(force) {
  if (pending) return pending;
  pending = (async () => {
    let areas = [];
    if (userdb.enabled()) {
      try { areas = await userdb.areas(force); } catch (e) { console.warn(`přístup podle APček: userdb nejde přečíst (${e.message}), nechávám ${apsByUser.size} účtů z minula`); if (builtAt) return; }
    }
    const byUid = new Map(); // userdb uid správce → APčka všech jeho oblastí (SO i ZSO i další role v userdb)
    for (const a of areas) for (const adm of a.admins) { let s = byUid.get(adm.id); if (!s) byUid.set(adm.id, (s = new Set())); for (const ap of a.aps) s.add(Number(ap.id)); }
    const m = new Map();
    for (const u of db.listUsers()) {
      if (u.disabled) continue;
      const s = new Set([...((u.userdb_uid && byUid.get(Number(u.userdb_uid))) || []), ...(u.userdb_aps || []).map(Number).filter(Boolean)]);
      if (s.size) m.set(u.id, s);
    }
    apsByUser = m; builtAt = Date.now();
  })().catch((e) => console.warn('přístup podle APček: ' + e.message)).finally(() => { pending = null; });
  return pending;
}
/** po změně účtů (vazba na userdb, přidělená APčka, založení/smazání) — mapa se přestaví hned */
function invalidate() { builtAt = 0; return refresh(); }

/** APčka, ke kterým má účet přístup (Set id); prošlá mapa se obnoví na pozadí, mezitím platí stará */
function apsOf(uid) {
  if (Date.now() - builtAt > ttl() && !pending) refresh().catch(() => {});
  return apsByUser.get(Number(uid)) || EMPTY;
}
/** smí účet se zařízením pracovat: vlastník, nebo zařízení pod APčkem jeho oblasti */
function canAccess(uid, dev) {
  if (!dev) return false;
  uid = Number(uid) || 0;
  if (dev.owner_id === uid) return true;
  const ap = Number(dev.userdb_ap_id || 0);
  return !!ap && apsOf(uid).has(ap);
}
/** zařízení přístupné účtu, ale vlastní ho kolega (UI: štítek „společné s …“) */
const isShared = (uid, dev) => canAccess(uid, dev) && dev.owner_id !== Number(uid);
function visibleDevices(uid) { return db.listDevices().filter(d => canAccess(uid, d)); }

// joby: vidí je ten, kdo je spustil, a každý, kdo smí na aspoň jedno zařízení v nich (kolega z téže oblasti) — rozsah jobu se keší,
// protože se ptá každá SSE událost (log řádky) × každý připojený prohlížeč
const scopeCache = new Map(); // jobId → { at, owner, devOwners:Set, devAps:Set }
function jobScope(jobId) {
  const id = Number(jobId) || 0;
  const c = scopeCache.get(id);
  if (c && Date.now() - c.at < 60e3) return c;
  const j = db.getJobOwner(id);
  const s = { at: Date.now(), owner: j == null ? -1 : j, devOwners: new Set(), devAps: new Set() };
  if (j != null) for (const r of db.jobDeviceScope(id)) { if (r.owner_id) s.devOwners.add(r.owner_id); if (r.userdb_ap_id) s.devAps.add(Number(r.userdb_ap_id)); }
  scopeCache.set(id, s);
  if (scopeCache.size > 2000) for (const [k, v] of scopeCache) if (Date.now() - v.at > 60e3) scopeCache.delete(k);
  return s;
}
/** job: { id, owner_id? } — owner_id stačí, když je po ruce (ušetří dotaz) */
function jobVisible(uid, job) {
  if (!job) return false;
  uid = Number(uid) || 0;
  if (job.owner_id != null && job.owner_id === uid) return true;
  const s = jobScope(job.id);
  if (s.owner === uid || s.devOwners.has(uid)) return true;
  const aps = apsOf(uid); if (!aps.size) return false;
  for (const a of s.devAps) if (aps.has(a)) return true;
  return false;
}
function visibleJobs(uid, limit) { return db.listJobsFor(limit, Number(uid) || 0, [...apsOf(uid)]); }
function forgetJob(jobId) { scopeCache.delete(Number(jobId)); }

module.exports = { refresh, invalidate, apsOf, canAccess, isShared, visibleDevices, jobVisible, visibleJobs, forgetJob };
