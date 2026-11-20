'use strict';
/**
 * Automatický upgrade (20.11.2026). Uživatel si na stránce Automat sestaví vlastní „automatické joby“: pojmenované skupiny svých zařízení,
 * každou s vlastním zpožděním po vydání. Když MikroTik vydá novou verzi kanálu a ta pro skupinu „dozraje“ (zpoždění skupiny, jinak
 * auto_delay_days; opravné vydání odpočet spustí znovu, protože se sleduje vždy poslední verze kanálu), automat v nočním okně založí
 * pro skupinu job se všemi jejími kusy, které jsou pod cílem. Postupné nasazení si tak každý řídí sám (skupina kanárků s kratším
 * zpožděním, zbytek s delším); zařízení mimo skupiny se automaticky neupgradují.
 *
 * Automat nic neupgraduje sám: zakládá úplně obyčejné joby (options.auto) — kontroly, pořadí podle topologie (potomci před rodiči),
 * zámky, zálohy, logy i drain při aktualizaci serveru tak platí beze změny. Navíc jen:
 *   options.targets  — cíl kanálu pro tento job (bez ohledu na připnuté verze; lib/versions.withTargets)
 *   options.stop_at  — konec okna: rozdělaný kus se dokončí, nový se nezačíná, zbytek jde další noc
 *   stop_on_failure  — první skutečná chyba job ukončí a automat se uživateli zastaví, dokud ho ručně neuvolní
 *
 * Bere jen kusy dostupné při posledním skenu a jen upgrade v rámci stejné hlavní verze (6→7 nikdy). Selže-li stejná verze dvěma různým
 * uživatelům, jde do karantény a automat ji nenasazuje nikomu.
 *
 * Stav (skupiny, zastavení, historie nocí) je v data/auto-upgrade.json. Zapnout smí jen účty ze společného nastavení auto_users.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const V = require('./versions');
const access = require('./access');
const { effectiveTrack } = require('./planner');
const mail = require('./mail');

const TRACKS = ['v7-long-term', 'v7-stable', 'v6-long-term'];
const OPEN = new Set(['running', 'waiting', 'waiting-window', 'queued', 'scheduled', 'paused', 'batch-hold']);
const KEYS = ['auto_enable', 'auto_delay_days', 'auto_window', 'auto_days', 'auto_mail', 'auto_mail_to'];
const ANNOUNCE_H = 8;    // oznámení „dnes v noci půjde…“ nejdřív tolik hodin před začátkem okna
const MIN_LEFT_MIN = 30; // méně než půl hodiny do konce okna → už nezačínat
const FILE = path.join(cfg.dataDir, 'auto-upgrade.json');

let state = { users: {}, fails: {}, quarantine: {} };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
try {
  if (fs.existsSync(FILE)) {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!isObj(j)) throw new Error('není objekt');
    state = { users: isObj(j.users) ? j.users : {}, fails: isObj(j.fails) ? j.fails : {}, quarantine: isObj(j.quarantine) ? j.quarantine : {} };
  }
} catch (e) {
  // nečitelný soubor se nesmí potichu přepsat prázdným stavem (zmizely by joby všech správců): odložit stranou a ohlásit
  const bad = `${FILE}.bad-${Date.now()}`;
  try { fs.renameSync(FILE, bad); } catch {}
  console.error(`automat: ${FILE} nejde přečíst (${e.message}) — odložen jako ${bad}, začínám s prázdným stavem (joby automatu je potřeba založit znovu nebo soubor opravit)`);
}
function save() { try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('auto-upgrade.json:', e.message); } }
const normed = new WeakSet();
function userState(uid) {
  const k = String(uid); let us = state.users[k];
  if (!isObj(us)) us = state.users[k] = { groups: [], open: [], halted: '', failed: {}, history: [] };
  if (normed.has(us)) return us; normed.add(us);
  // tvar se opravuje při prvním použití (ručně upravený / starší soubor nesmí shodit stránku ani noční běh)
  us.groups = (Array.isArray(us.groups) ? us.groups : []).filter(isObj).map((g, i) => ({ ...g, id: Number.isInteger(Number(g.id)) && Number(g.id) > 0 ? Number(g.id) : 100000 + i, name: String(g.name == null ? '' : g.name) || `job ${i + 1}`,
    devs: [...new Set((Array.isArray(g.devs) ? g.devs : []).map(Number).filter(n => Number.isInteger(n) && n > 0))], enabled: g.enabled !== false, delay_days: Number.isFinite(g.delay_days) && g.delay_days >= 0 ? g.delay_days : null }));
  us.open = (Array.isArray(us.open) ? us.open : []).filter(l => isObj(l) && l.jobId);
  if (!isObj(us.failed)) us.failed = {}; if (!isObj(us.blocked)) us.blocked = {};
  if (!Array.isArray(us.history)) us.history = []; if (!Array.isArray(us.outbox)) us.outbox = [];
  return us;
}

let deps = { pool: null, notify: () => {} };
function configure(o) { deps = { ...deps, ...o }; }

// ---------- nastavení ----------
function parseWindow(win) {
  const m = String(win || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  if (+m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59 || a === b) return null;
  return { a, b };
}
const parseDays = (s) => [...new Set(String(s == null ? '' : s).split(/[\s,;]+/).filter(x => /^[0-6]$/.test(x)).map(Number))];
const delayDays = (settings) => { const d = Number(settings.auto_delay_days); return Number.isFinite(d) && d >= 0 ? d : 5; };

/** kontrola a očištění hodnot z formuláře; vrací { values } nebo { error } */
const BLOCKED_RETRY_MS = 7 * 86400e3; // kus zablokovaný kontrolou se pro tutéž verzi zkusí znovu až za týden (nebo po „uvolnit“ / změně verze)
const MIN_WINDOW_MIN = 60, MAX_MAIL_TO = 5;
const windowLen = (w) => (w.b - w.a + 1440) % 1440;
function validate(b) {
  if (!isObj(b)) return { error: 'neplatné tělo požadavku' };
  const out = {};
  if ('auto_enable' in b) out.auto_enable = !!b.auto_enable;
  if ('auto_mail' in b) out.auto_mail = !!b.auto_mail;
  if ('auto_mail_to' in b) { const l = String(b.auto_mail_to || '').split(/[\s,;]+/).filter(Boolean); if (!l.every(mail.validAddr)) return { error: 'adresa pro hlášení není platný e-mail' }; if (l.length > MAX_MAIL_TO) return { error: `nejvýš ${MAX_MAIL_TO} adres pro hlášení` }; out.auto_mail_to = l.join(', '); }
  if ('auto_delay_days' in b) { const r = b.auto_delay_days; const d = (typeof r === 'number' || (typeof r === 'string' && r.trim() !== '')) ? Number(r) : NaN; if (!Number.isFinite(d) || d < 0 || d > 365) return { error: 'zpoždění: počet dní 0–365' }; out.auto_delay_days = d; }
  if ('auto_window' in b) { const w = String(b.auto_window || '').trim(); const pw = parseWindow(w); if (!pw) return { error: 'noční okno zadej jako HH:MM-HH:MM, např. 01:00-04:30' }; if (windowLen(pw) < MIN_WINDOW_MIN) return { error: `noční okno musí mít aspoň ${MIN_WINDOW_MIN} minut (posledních ${MIN_LEFT_MIN} minut se už nic nezačíná)` }; out.auto_window = w; }
  if ('auto_days' in b) { const d = parseDays(Array.isArray(b.auto_days) ? b.auto_days.join(',') : b.auto_days); if (!d.length) return { error: 'vyber aspoň jeden den v týdnu' }; out.auto_days = d.sort().join(','); }
  return { values: out };
}

/** smí účet automat používat (společné nastavení auto_users: přezdívky z userdb / jména účtů / #id, čárkou; * = všichni) */
function allowed(user) {
  if (!user || user.disabled) return false;
  const list = String(db.getSettings().auto_users || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (list.includes('*')) return true;
  return [user.userdb_nick, user.name, '#' + user.id].filter(Boolean).some(x => list.includes(String(x).toLowerCase()));
}

// ---------- verze ----------
/** poslední verze každého kanálu podle MikroTiku a kdy dozraje: { track: { version, releasedAt, matureAt, mature, delayDays, blocked } } */
function targets(settings, nowSec = Date.now() / 1000) {
  const mt = V.getLatest().mikrotik || {}; const out = {};
  const bad = new Set(String(settings.bad_versions || '').split(/[\s,;]+/).filter(Boolean));
  for (const track of TRACKS) {
    const x = mt[track]; const pv = x && V.parseVersion(x.version); if (!pv) continue;
    // první vydání větve (x.y.0) čeká aspoň tak dlouho jako u ručního upgradu — planner by ho stejně zablokoval
    const need = Math.max(delayDays(settings), Number(settings.min_release_age_days) || 0, pv.patch === 0 && !pv.pre ? (Number(settings.zero_release_min_days) || 0) : 0);
    const k = V.releaseInfo(x.version);
    const rel = x.releasedAt || (k && (k.releasedAt || k.seenAt)) || 0;
    const matureAt = rel ? Math.round(rel + need * 86400) : 0;
    out[track] = { version: x.version, releasedAt: rel, matureAt, mature: !!rel && nowSec >= matureAt, delayDays: need,
      blocked: bad.has(x.version) ? 'verze je v seznamu zakázaných' : (state.quarantine[x.version] ? 'karanténa: ' + state.quarantine[x.version] : (pv.pre ? 'testovací vydání' : '')) };
  }
  return out;
}

// ---------- skupiny (automatické joby uživatele) ----------
/** zařízení, která smí účet do skupin dát: vlastní a sdílená přes APčko oblasti, jen řízená hlavní záznamy */
function pickable(uid) { return db.listDevices().filter(d => access.canAccess(uid, d) && d.managed && !d.dup_of); }
const cleanName = (x) => [...String(x == null ? '' : x).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim()].slice(0, 80).join('');
/**
 * Uložení skupiny (nová bez id). U existující se mění jen pole, která v těle jsou — { id, enabled } tedy jen zapne/vypne.
 * Nově přidávaná zařízení musí být ve výběru (pickable); kusy, které ve skupině už byly, zůstanou, i když jsou zrovna mimo výběr
 * (dočasně neřízené, duplicita, ztracený přístup) — vyřadí je jen výslovné odškrtnutí. Zařízení je nejvýš v jedné skupině.
 */
function saveGroup(uid, b) {
  if (!isObj(b)) return { error: 'neplatné tělo požadavku' };
  const us = userState(uid);
  let g = null;
  if (b.id !== undefined && b.id !== null && b.id !== '' && b.id !== 0) { g = us.groups.find(x => x.id === Number(b.id)); if (!g) return { error: 'job neexistuje' }; }
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const name = !g || has('name') ? cleanName(b.name) : g.name;
  if (!name) return { error: 'job potřebuje název' };
  let delay = g ? g.delay_days : null;
  if (has('delay_days')) {
    const r = b.delay_days;
    if (r === null || r === undefined || (typeof r === 'string' && r.trim() === '')) delay = null;
    else { delay = (typeof r === 'number' || typeof r === 'string') ? Number(r) : NaN; if (!Number.isFinite(delay) || delay < 0 || delay > 365) return { error: 'zpoždění: počet dní 0–365 (prázdné = výchozí)' }; }
  }
  let devs = g ? g.devs : [];
  if (!g || has('deviceIds')) {
    const ok = new Set(pickable(uid).map(d => d.id)); const was = new Set(g ? g.devs : []);
    devs = [...new Set((Array.isArray(b.deviceIds) ? b.deviceIds : []).map(Number).filter(id => Number.isInteger(id) && (ok.has(id) || was.has(id))))];
    if (!devs.length && !(g && !g.devs.length)) return { error: 'vyber aspoň jedno zařízení' };
  }
  if (us.groups.some(x => x !== g && x.name.toLowerCase() === name.toLowerCase())) return { error: 'job s tímhle názvem už máš' };
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : (g ? g.enabled !== false : true);
  if (!g) { g = { id: (us.groups.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1, created: Date.now() }; us.groups.push(g); }
  Object.assign(g, { name, delay_days: delay, enabled, devs });
  for (const x of us.groups) if (x !== g) x.devs = x.devs.filter(id => !devs.includes(id));
  save();
  return { group: g };
}
/** vrací smazanou skupinu nebo null */
/** posun jobu v pořadí (priorita): dir 'up' / 'down' / 'top' / 'bottom' */
function moveGroup(uid, id, dir) {
  const us = userState(uid); const i = us.groups.findIndex(x => x.id === Number(id)); if (i < 0) return { error: 'job neexistuje' };
  const to = dir === 'up' ? i - 1 : dir === 'down' ? i + 1 : dir === 'top' ? 0 : dir === 'bottom' ? us.groups.length - 1 : NaN;
  if (!Number.isInteger(to)) return { error: 'neplatný směr posunu' };
  if (to < 0 || to >= us.groups.length || to === i) return { group: us.groups[i], moved: false };
  const [g] = us.groups.splice(i, 1); us.groups.splice(to, 0, g); save();
  return { group: g, moved: true, order: to + 1 };
}
function deleteGroup(uid, id) { const us = userState(uid); const g = us.groups.find(x => x.id === Number(id)) || null; if (g) { us.groups = us.groups.filter(x => x !== g); save(); } return g; }

/** zařízení, která už čekají v jiném otevřeném jobu — i pozastaveném (db.pendingUpgrades pozastavené joby nezná) */
function busyDevices() {
  const set = new Set(db.pendingUpgrades().map(x => x.device_id));
  for (const j of db.listJobsOpen()) if (j.status === 'paused' || j.status === 'batch-hold') for (const it of db.getJobItems(j.id)) if (it.status === 'pending') set.add(it.device_id);
  return set;
}
/** plán jedné skupiny k času `nowSec`: cíle podle jejího zpoždění, kusy pod zralým cílem (list) a proč zbytek nejde (waiting, skipped) */
function planGroup(uid, settings, g, nowSec, inJob = busyDevices()) {
  const us = userState(uid);
  const gs = g.delay_days === null || g.delay_days === undefined ? settings : { ...settings, auto_delay_days: g.delay_days };
  const tg = targets(gs, nowSec);
  const list = [], waiting = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const id of g.devs) {
    const d = db.getDevice(id);
    if (!d || !access.canAccess(uid, d)) { skip('zařízení už nemáš ve správě'); continue; }
    if (!d.managed || d.enabled === false || d.dup_of) { skip('vypnuté / neřízené'); continue; }
    const eff = effectiveTrack(d, settings);
    if (eff === 'hold') { skip('kanál hold'); continue; }
    const t = tg[eff]; if (!t) { skip(TRACKS.includes(eff) ? `kanál ${eff}: MikroTik teď žádnou verzi nenabízí` : `kanál ${eff} automat nesleduje`); continue; }
    const cur = V.parseVersion(d.version), tv = V.parseVersion(t.version);
    if (!cur) { skip('neznámá verze (ještě neskenováno)'); continue; }
    if (!(V.cmpVersion(cur, tv) < 0)) continue; // už na cíli nebo výš
    if (cur.major !== tv.major) { skip('přechod na jinou hlavní verzi (6 → 7) dělej ručně'); continue; }
    const row = { id: d.id, name: d.name || d.identity || d.host, host: d.host, model: d.model || d.board_name || '', version: d.version, to: t.version, track: eff, depth: db.ancestorIds(d.id).length, priority: d.priority || 0 };
    if (t.blocked) { skip(`verze ${t.version}: ${t.blocked}`); continue; }
    if (!t.mature) { if (!t.matureAt) { skip(`verze ${t.version}: neznámé datum vydání`); continue; } waiting.push({ ...row, matureAt: t.matureAt }); continue; }
    if (d.scan_status !== 'ok') { skip('při posledním skenu nedostupné'); continue; }
    if (us.failed[d.id]) { skip('minule v automatu selhalo (čeká na uvolnění)'); continue; }
    { const bl = us.blocked[d.id]; if (bl && (bl.n || 0) >= 2 && bl.version === t.version && bl.from === d.version && Date.now() - (bl.at || 0) < BLOCKED_RETRY_MS) { skip(`kontrola před upgradem ho opakovaně zablokovala (zkusí se znovu za týden nebo po „uvolnit“): ${bl.reason}`); continue; } }
    if (inJob.has(d.id) || (deps.pool && deps.pool.isDeviceBusy(d.id))) { skip('už je v jiném jobu'); continue; }
    list.push(row);
  }
  list.sort((a, b) => b.depth - a.depth || a.priority - b.priority || String(a.host).localeCompare(String(b.host)));
  return { tg, list, waiting, skipped };
}

// ---------- okno ----------
/** běží teď okno? → { night: 'YYYY-MM-DD' (den, kdy okno začalo), day, endSec, leftMin } nebo null */
function windowNow(settings, now = new Date()) {
  const w = parseWindow(settings.auto_window); if (!w) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const inside = w.a < w.b ? (cur >= w.a && cur < w.b) : (cur >= w.a || cur < w.b);
  if (!inside) return null;
  const start = new Date(now); if (w.a > w.b && cur < w.b) start.setDate(start.getDate() - 1); // okno přes půlnoc: začalo včera
  start.setHours(Math.floor(w.a / 60), w.a % 60, 0, 0);
  const end = new Date(start); if (w.a > w.b) end.setDate(end.getDate() + 1); end.setHours(Math.floor(w.b / 60), w.b % 60, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return { night: `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`, day: start.getDay(), startSec: Math.floor(start.getTime() / 1000), endSec: Math.floor(end.getTime() / 1000), leftMin: (end.getTime() - now.getTime()) / 60000 };
}
/** začátek nejbližšího povoleného okna (ms) nebo 0 */
function nextWindow(settings, now = new Date()) {
  const w = parseWindow(settings.auto_window); const days = parseDays(settings.auto_days); if (!w || !days.length) return 0;
  for (let i = 0; i < 8; i++) { const s = new Date(now); s.setDate(s.getDate() + i); s.setHours(Math.floor(w.a / 60), w.a % 60, 0, 0); if (s.getTime() > now.getTime() && days.includes(s.getDay())) return s.getTime(); }
  return 0;
}

// ---------- e-maily ----------
const nightKey = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const czNight = (key) => key.split('-').reverse().slice(0, 2).map(Number).join('. ') + '.';
/** adresy pro hlášení: vlastní z nastavení, jinak e-mail účtu (u SSO je jím i jméno účtu) */
function mailTo(user, settings) {
  const own = String(settings.auto_mail_to || '').split(/[\s,;]+/).filter(mail.validAddr);
  if (own.length) return own;
  return [user.email, user.name].filter(mail.validAddr).slice(0, 1);
}
const pendingMail = new Set();
const track = (p) => { pendingMail.add(p); p.finally(() => pendingMail.delete(p)); return p; };
/** počká na právě odesílaná hlášení (testy) */
const settle = async () => { while (pendingMail.size) await Promise.allSettled([...pendingMail]); };
const oneLine = (x, max = 200) => String(x == null ? '' : x).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim().slice(0, max);
/** vrací true (odesláno), false (nepovedlo se), null (hlášení vypnutá / není kam) */
function sendMail(user, settings, subject, lines) {
  if (!settings.auto_mail || !mail.enabled()) return Promise.resolve(null);
  const to = mailTo(user, settings); if (!to.length) return Promise.resolve(null);
  const text = [...lines, '', `Stav a nastavení: ${cfg.publicUrl}/ (vlevo Automat)`, '', 'Zprávu poslal MikroTik upgrader automaticky; hlášení vypneš na stránce Automat.'].join('\n');
  const us0 = userState(user.id); let rej = null;
  return mail.send({ to, subject: `[upgrader] ${subject}`, text, onRejected: (r) => { rej = r; } }).then(() => {
    if (rej) us0.mailError = { at: Date.now(), error: 'server odmítl příjemce: ' + rej.join('; ') }; else delete us0.mailError;
    save(); return true;
  }).catch(e => { console.error(`automat: e-mail pro ${to.join(', ')} se nepodařilo odeslat: ${e.message}`); userState(user.id).mailError = { at: Date.now(), error: e.message }; save(); return false; });
}
const devLine = (x) => `  ${oneLine(x.name, 80)}  (${x.host}${x.model ? ', ' + oneLine(x.model, 40) : ''})  ${oneLine(x.version, 30)} → ${x.to}`;
/** co by šlo v noci, která začne v čase `atMs` (zralost verzí se počítá k začátku okna): [ { g, tg, list, waiting, skipped } ] zapnutých skupin */
function planFor(uid, settings, atMs) { return userState(uid).groups.filter(g => g.enabled !== false).map(g => ({ g, ...planGroup(uid, settings, g, atMs / 1000) })); }
const annChecked = new Map(); // uid → kdy se naposledy počítalo oznámení (počítá se nejvýš jednou za 10 min)
/** večer před nocí: co půjde. Posílá se jednou na noc, jen když je co dělat. */
async function announce(user, settings, now) {
  if (!settings.auto_mail || !mail.enabled()) return;
  const us = userState(user.id); const nw = nextWindow(settings, now);
  if (!nw || nw - now.getTime() > ANNOUNCE_H * 3600e3) return;
  const key = nightKey(nw);
  if (us.announced === key || us.skipNight === key || us.lastNight === key) return;
  if (now.getTime() - (annChecked.get(user.id) || 0) < 10 * 60e3) return; annChecked.set(user.id, now.getTime());
  const plans = planFor(user.id, settings, nw).filter(x => x.list.length); const all = plans.flatMap(x => x.list); if (!all.length) return;
  us.announced = key; save();
  const w = parseWindow(settings.auto_window); const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const vers = [...new Set(all.map(x => x.to))].join(', ');
  const sent = await sendMail(user, settings, `dnes v noci půjde ${all.length} zařízení na ${vers}`, [
    `Automatický upgrade: v noci ${czNight(key)} v okně ${hm(w.a)}–${hm(w.b)} se upgraduje ${all.length} zařízení na RouterOS ${vers}.`, '',
    ...plans.flatMap((x, i) => [`${plans.length > 1 ? `${i + 1}. ` : ''}Job „${oneLine(x.g.name, 80)}“ (${x.list.length}):`, ...x.list.map(devLine), '']),
    `${plans.length > 1 ? 'Joby jdou postupně v tomto pořadí; co se do konce okna nestihne, jde další noc. ' : ''}Nechceš-li to, vypni na stránce Automat job nebo celý automat. Chyba automat nezastaví — ráno přijde souhrn i s chybami.`,
  ]);
  if (sent === false && us.announced === key) { us.announced = ''; save(); } // nepovedené odeslání se zkusí znovu (nejdřív za 10 minut)
}
const ITEM_CS = { skipped: 'přeskočeno', cancelled: 'zrušeno', blocked: 'zablokováno kontrolou', pending: 'nezačalo', done: 'hotovo' };
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
/** po noci: souhrn uzavřeného jobu → { subject, lines } */
function summaryText(l, job, items, hard, counts) {
  const row = (it) => `  ${oneLine(it.dev_name || it.host, 80)}  (${it.host})`;
  const ok = items.filter(it => it.status === 'done' && !(it.result && it.result.partial));
  const part = items.filter(it => it.status === 'done' && it.result && it.result.partial);
  const hardIds = new Set(hard.map(h => h.id));
  const rest = items.filter(it => !ok.includes(it) && !part.includes(it) && !hardIds.has(it.device_id));
  const lines = [`Automatický upgrade „${l.group || ''}“, noc ${czNight(l.night)}, job #${l.jobId} (${oneLine(job.status_note || job.status)}): ${counts.ok} v pořádku, ${plural(hard.length, 'chyba', 'chyby', 'chyb')}${part.length ? `, ${part.length} částečně` : ''}, ${plural(counts.unreachable, 'nedostupné', 'nedostupná', 'nedostupných')}, ${counts.skipped} přeskočeno.`, ''];
  if (hard.length) lines.push('POZOR, CHYBY. Automat pokračoval dál; selhaná zařízení zkontroluj — znovu je zkusí, až je na stránce Automat uvolníš.', '', 'Chyby:', ...hard.map(h => `  ${oneLine(h.label, 80)}${h.host ? ` (${h.host})` : ''}: ${oneLine(h.error, 300)}`), '');
  if (ok.length) lines.push('V pořádku:', ...ok.map(it => `${row(it)}  ${it.from_version || '?'} → ${it.to_version || '?'}`), '');
  if (part.length) lines.push('Částečně (zůstalo na mezikroku, dokončí se další noc):', ...part.map(it => `${row(it)}  ${it.from_version || '?'} → ${it.to_version || '?'}`), '');
  if (rest.length) lines.push('Neprovedeno:', ...rest.map(it => `${row(it)}: ${oneLine(it.error || String(it.step || '').replace(/^přeskočí se: /, '') || ITEM_CS[it.status] || it.status, 300)}`), '');
  lines.push(`Job: ${cfg.publicUrl}/ (Upgrady → #${l.jobId})`);
  const undone = counts.skipped + counts.unreachable;
  const subject = hard.length ? `CHYBY: „${l.group || ''}“ ${czNight(l.night)}: ${plural(hard.length, 'chyba', 'chyby', 'chyb')}, ${counts.ok} upgradováno${undone ? `, ${undone} neprovedeno` : ''}` : `„${l.group || ''}“ ${czNight(l.night)}: ${counts.ok} zařízení upgradováno${part.length ? `, ${part.length} částečně` : ''}${undone ? `, ${undone} neprovedeno` : ''}`;
  return { subject, lines };
}
/** souhrn se nesmí ztratit kvůli krátkému výpadku pošty: neodeslaný jde do fronty a zkouší se znovu (nejdéle 24 h) */
const OUTBOX_MAX_AGE = 24 * 3600e3, OUTBOX_RETRY = 10 * 60e3;
function queueMail(user, settings, subject, lines) {
  return sendMail(user, settings, subject, lines).then(ok => { if (ok === false) { const us = userState(user.id); us.outbox.push({ subject, lines, at: Date.now(), tried: Date.now() }); us.outbox = us.outbox.slice(-20); save(); } return ok; });
}
/**
 * Jeden souhrnný e-mail za noc místo jednoho za každý job: výsledky uzavřených jobů se sbírají v us.digest a odešlou se naráz, až je noc
 * vyřízená (žádný job neběží a další už nepřijde — všechny byly na řadě, okno skončilo, noc je vynechaná) nebo hned, když se automat zastaví.
 */
function flushDigest(user, settings, now) {
  const us = userState(user.id); if (!Array.isArray(us.digest) || !us.digest.length) return;
  if (!us.halted) {
    if (us.open.length) return;
    const night = us.digest[us.digest.length - 1].night; const win = windowNow(settings, now);
    if (us.queue && us.queue.night === night && win && win.night === night && win.leftMin >= MIN_LEFT_MIN && settings.auto_enable && us.skipNight !== night && allowed(user)) return; // další job v pořadí ještě přijde
  }
  const d = us.digest; us.digest = []; save();
  let subject, lines;
  if (d.length === 1) ({ subject, lines } = d[0]);
  else {
    const ok = d.reduce((n, x) => n + x.ok, 0), undone = d.reduce((n, x) => n + x.undone, 0), bad = d.find(x => x.hard);
    const hardN = d.reduce((n, x) => n + (x.hard || 0), 0);
    subject = `${bad ? `CHYBY: ${plural(hardN, 'chyba', 'chyby', 'chyb')}, ` : ''}noc ${czNight(d[0].night)}: ${ok} zařízení upgradováno v ${d.length} jobech${undone ? `, ${undone} neprovedeno` : ''}`;
    lines = [`Automatický upgrade, noc ${czNight(d[0].night)} — ${plural(d.length, 'job', 'joby', 'jobů')}:`, ...d.map((x, i) => `  ${i + 1}. „${oneLine(x.group || '', 80)}“ (job #${x.jobId}): ${x.ok} v pořádku${x.hard ? `, ${plural(x.hard, 'chyba', 'chyby', 'chyb')}` : ''}${x.undone ? `, ${x.undone} neprovedeno` : ''}`), ''];
    for (const x of d) lines.push('----------------------------------------', ...x.lines, '');
  }
  track(queueMail(user, settings, subject, lines).catch(() => {}));
}
function flushOutbox(user, settings, tickMs = Date.now()) {
  const us = userState(user.id); if (!us.outbox.length) return;
  const nowMs = Date.now(); const keep = us.outbox.filter(m => nowMs - m.at < OUTBOX_MAX_AGE);
  if (keep.length !== us.outbox.length) { us.outbox = keep; save(); }
  for (const m of us.outbox.filter(x => Math.abs(tickMs - (x.tried || 0)) >= OUTBOX_RETRY)) {
    m.tried = tickMs;
    track(sendMail(user, settings, m.subject, m.lines).then(ok => { if (ok !== false) { us.outbox = us.outbox.filter(x => x !== m); save(); } }).catch(() => {}));
  }
}

// ---------- vyhodnocení uzavřených jobů ----------
/** projde rozjeté joby automatu; uzavřené vyhodnotí (historie, zastavení po chybě, e-mail). Vrací true, když už žádný neběží. */
function evaluate(uid) {
  const us = userState(uid); if (!us.open.length) return true;
  const still = [];
  for (const l of us.open) {
    const job = db.getJob(l.jobId);
    if (job && OPEN.has(job.status)) { still.push(l); continue; }
    if (!job) continue;
    const items = db.getJobItems(l.jobId); const hard = []; let ok = 0, skippedN = 0, unreachable = 0;
    const blockedNow = new Set();
    const cleanup = () => { for (const it of items) if (!blockedNow.has(it.device_id) && it.status !== 'skipped') delete us.blocked[it.device_id]; };
    for (const it of items) {
      const label = it.dev_name || it.host || ('#' + it.device_id);
      if (it.status === 'done' && !(it.result && it.result.partial)) ok++;
      else if (['failed', 'unknown'].includes(it.status)) {
        if (it.result && it.result.untouched) { unreachable++; continue; } // nedostupné, nic se na něm nezměnilo — není to chyba upgradu
        // pád serveru uprostřed kroku není selhání verze: automat se zastaví (stav kusu je nejistý), ale do karantény se to nepočítá
        hard.push({ id: it.device_id, label, host: it.host || '', error: it.error || it.status, version: (l.devs || {})[it.device_id] || it.to_version || '', noBlame: /^server restartován/.test(String(it.error || '')) || /nesouhlasí$/.test(String(it.error || '')) });
      } else {
        skippedN++;
        // kus, který kontrola před upgradem zablokovala (málo RAM, hardware bez v7…), by jinak dostal job každou noc znovu
        const why = oneLine(it.error || String(it.step || '').replace(/^přeskočí se: /, ''), 200);
        if (it.status === 'blocked' && why) {
          // dočasná překážka (krátký uptime, soused právě upgraduje) do další noci zmizí; teprve druhé zablokování po sobě kus na týden odstaví
          const ver = (l.devs || {})[it.device_id] || '', from = (db.getDevice(it.device_id) || {}).version || '', prev = us.blocked[it.device_id];
          us.blocked[it.device_id] = { version: ver, from, reason: why, at: Date.now(), n: prev && prev.version === ver && prev.from === from ? (prev.n || 1) + 1 : 1 }; blockedNow.add(it.device_id);
        }
      }
    }
    if (hard.length) {
      // chyba automat nezastavuje (20.11.2026): job i další joby v pořadí pokračují, chyby se vypíšou v ranním e-mailu. Selhaný kus se ale
      // sám znovu nezkouší, dokud ho správce na stránce Automat neuvolní; verze, která selže u dvou správců, jde dál do karantény.
      for (const h of hard) {
        us.failed[h.id] = { version: h.version, at: Date.now(), error: String(h.error).slice(0, 300), label: h.label };
        if (!h.version || h.noBlame) continue;
        const f = state.fails[h.version] || (state.fails[h.version] = []); if (!f.includes(Number(uid))) f.push(Number(uid));
        if (f.length >= 2 && !state.quarantine[h.version]) { state.quarantine[h.version] = `selhala u ${f.length} různých správců`; db.audit('automat', 'verze v karanténě', `${h.version}: ${state.quarantine[h.version]}`); }
      }
      db.audit('automat', 'automatický upgrade: chyby', `uživatel #${uid}, job #${l.jobId} „${l.group}“: ${hard.map(h => `${h.label} — ${h.error}`).join('; ')}`.slice(0, 700));
    }
    cleanup();
    us.history.unshift({ night: l.night, jobId: l.jobId, group: l.group, targets: l.targets, total: items.length, ok, failed: hard.length, unreachable, skipped: skippedN });
    const user = db.listUsers().find(u => u.id === Number(uid));
    if (user) { const m = summaryText(l, job, items, hard, { ok, unreachable, skipped: skippedN }); if (!Array.isArray(us.digest)) us.digest = []; us.digest.push({ night: l.night, group: l.group, jobId: l.jobId, subject: m.subject, lines: m.lines, ok, undone: skippedN + unreachable, hard: hard.length }); us.digest = us.digest.slice(-60); }
  }
  us.open = still; us.history = us.history.slice(0, 40);
  save();
  return !still.length;
}

// ---------- noční běh ----------
/** job pro jednu skupinu; vrací id jobu */
function launchGroup(user, win, plan) {
  const us = userState(user.id); const { g, list } = plan;
  const jobTargets = {}; for (const x of list) jobTargets[x.track] = x.to;
  const options = { dry_run: false, mode: 'upload', firmware: true, stop_on_failure: false, canary: false, precheck: true, device_mode: true, parallel: 4,
    auto: true, auto_group: g.name, targets: jobTargets, stop_at: win.endSec, by: 'automat' };
  const name = `Automat „${g.name}“ → ${[...new Set(Object.values(jobTargets))].join(', ')} (noc ${win.night.split('-').reverse().slice(0, 2).map(Number).join('.')}.)`;
  const jobId = db.createJob(name, options, list.map(x => x.id), user.id);
  db.addLog(jobId, 0, 0, 'info', `Job založil automat ze skupiny „${g.name}“: ${list.length} zařízení, cíl ${Object.entries(jobTargets).map(([t, v]) => `${t} ${v}`).join(', ')}, okno do ${new Date(win.endSec * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}. Při chybě pokračuje dalším zařízením.`);
  db.audit('automat', 'automatický upgrade spuštěn', `uživatel ${user.userdb_nick || user.name}: job #${jobId} „${g.name}“, ${list.length} zařízení → ${Object.values(jobTargets).join(', ')}`);
  us.open.push({ jobId, night: win.night, at: Date.now(), group: g.name, groupId: g.id, targets: jobTargets, devs: Object.fromEntries(list.map(x => [x.id, x.to])) });
  save();
  deps.pool.startOrQueue(jobId);
  deps.notify(jobId);
  return jobId;
}
/**
 * Joby se spouštějí postupně v pořadí, v jakém je má uživatel seřazené (shora dolů): jedno volání založí nejvýš jeden job, další přijde
 * na řadu, až ten předchozí doběhne (tick à 60 s). Chyba v jobu automat zastaví dřív, než se rozjedou joby s nižší prioritou; co se
 * do konce okna nestihne, jde další noc znovu od prvního. us.queue = { night, done: [id skupin, které už dnes byly na řadě], jobs }.
 */
function launch(user, settings, win, nowSec) {
  const us = userState(user.id);
  if (!isObj(us.queue) || us.queue.night !== win.night || !Array.isArray(us.queue.done)) us.queue = { night: win.night, done: [], jobs: 0, errs: [] };
  const q = us.queue; if (!Array.isArray(q.errs)) q.errs = [];
  let started = 0;
  for (const g of us.groups.filter(x => x.enabled !== false && !q.done.includes(x.id))) {
    q.done.push(g.id);
    // chyba u jednoho jobu nesmí vzít noc ostatním — zapíše se a pokračuje se dalším v pořadí
    try { const plan = { g, ...planGroup(user.id, settings, g, nowSec) }; if (plan.list.length) { launchGroup(user, win, plan); started = 1; q.jobs++; us.lastRunAt = nowSec * 1000; break; } }
    catch (e) { q.errs.push(`„${g.name}“: ${e.message}`); console.error(`automat (${user.name}, job „${g.name}“): ${e.stack || e.message}`); }
  }
  us.lastCheck = { night: win.night, at: Date.now(), jobs: q.jobs };
  if (q.errs.length) us.lastError = { at: Date.now(), error: q.errs.join('; ').slice(0, 500) }; else delete us.lastError;
  // všechny joby už dnes byly na řadě (nebo právě odstartoval poslední) → noc je vyřízená
  if (!started || !us.groups.some(x => x.enabled !== false && !q.done.includes(x.id))) { us.lastNight = win.night; delete us.queue; }
  save();
  return started;
}

/**
 * Rozložení startu: když má automat zapnutý víc správců se stejným oknem, nezačnou všichni v první minutě — každý dostane pevný posun
 * 0…spread minut (podle účtu a noci, takže se mezi nocemi střídá, kdo jde dřív). spread = 2 min na každého dalšího správce, nejvýš 30 min
 * a nejvýš čtvrtina okna; jediný správce začíná hned.
 */
const SPREAD_MAX_MIN = 30;
function activeUsers() { let n = 0; for (const u of db.listUsers()) { const us = state.users[String(u.id)]; if (us && us.groups.some(g => g.enabled !== false) && allowed(u) && db.getSettings(u.id).auto_enable) n++; } return n; }
function startOffsetMin(uid, night, settings, nActive = activeUsers()) {
  const w = parseWindow(settings.auto_window); if (!w) return 0;
  const len = ((w.b - w.a) + 1440) % 1440 || 1440;
  const spread = Math.max(0, Math.min(SPREAD_MAX_MIN, Math.floor(len / 4), 2 * (nActive - 1)));
  if (!spread) return 0;
  let h = Number(uid) * 2654435761 % 4294967296; for (const ch of String(night)) h = (h * 31 + ch.charCodeAt(0)) % 4294967296;
  return h % (spread + 1);
}
let ticking = false;
async function tick(now = new Date()) {
  if (ticking || !deps.pool) return; ticking = true;
  try {
    const g = db.getSettings(); let nActive = -1;
    for (const user of db.listUsers()) {
      if (!state.users[String(user.id)]) { if (!allowed(user)) continue; }
      const us = userState(user.id);
      // vyhodnocení i pro účet, kterému správce mezitím povolení odebral — rozjetý job se musí uzavřít (zastavení, historie, e-mail)
      const idle = us.open.length ? evaluate(user.id) : true; // i mimo okno, ať je ráno vidět výsledek
      const settings = db.getSettings(user.id);
      flushDigest(user, settings, now);
      if (!allowed(user)) continue;
      flushOutbox(user, settings, now.getTime());
      if (!settings.auto_enable || g.auto_pause || deps.pool.draining || us.halted || !us.groups.length) continue;
      track(announce(user, settings, now).catch(e => console.error('automat (oznámení):', e.message))); // nečeká se: pomalý SMTP nesmí zdržet spouštění ostatním
      const win = windowNow(settings, now);
      if (!win || !parseDays(settings.auto_days).includes(win.day) || win.leftMin < MIN_LEFT_MIN) continue;
      if (us.lastNight === win.night || us.skipNight === win.night) continue; // dnes už bylo / uživatel tuhle noc vynechal
      if (!idle) continue; // minulý job automatu ještě není uzavřený
      if (!(us.queue && us.queue.night === win.night)) { if (nActive < 0) nActive = activeUsers(); if (now.getTime() / 1000 < win.startSec + startOffsetMin(user.id, win.night, settings, nActive) * 60) continue; } // rozložený start noci
      if (!(us.queue && us.queue.night === win.night) && us.lastRunAt && now.getTime() - us.lastRunAt < 12 * 3600e3 && now.getTime() >= us.lastRunAt) continue; // změna okna uprostřed noci nesmí založit druhou sadu jobů
      await V.refreshLatest().catch(() => {});
      if (db.getSettings().auto_pause || deps.pool.draining || !db.getSettings(user.id).auto_enable || us.halted) continue; // stav se mohl změnit během čekání na verze
      try { launch(user, settings, win, now.getTime() / 1000); }
      catch (e) { console.error(`automat (${user.name}): ${e.stack || e.message}`); us.lastNight = win.night; us.lastError = { at: Date.now(), error: e.message }; save(); }
    }
  } finally { ticking = false; }
}

// ---------- pro UI ----------
function statusFor(user) {
  const ok = allowed(user);
  if (!ok) return { allowed: false };
  const settings = db.getSettings(user.id); const g = db.getSettings();
  const us = userState(user.id); const nw = nextWindow(settings); const at = (nw || Date.now()) / 1000;
  const mine = pickable(user.id); const byId = new Map(mine.map(d => [d.id, d])); const inJob = busyDevices();
  const ranTonight = us.queue && Array.isArray(us.queue.done) ? us.queue.done : [];
  const groups = us.groups.map((gr, gi) => {
    const p = planGroup(user.id, settings, gr, at, inJob); const now = targets(gr.delay_days === null || gr.delay_days === undefined ? settings : { ...settings, auto_delay_days: gr.delay_days });
    return { id: gr.id, order: gi + 1, ran: ranTonight.includes(gr.id), name: gr.name, enabled: gr.enabled !== false, delay_days: gr.delay_days === undefined ? null : gr.delay_days, devs: gr.devs,
      devices: gr.devs.map(id => { const d = byId.get(id); return d ? { id, name: d.name || d.identity || d.host, host: d.host, model: d.model || d.board_name || '', version: d.version } : { id, name: '(už není ve správě)', host: '', model: '', version: '' }; }),
      targets: now, next: p.list.map(({ id, name, host, model, version, to }) => ({ id, name, host, model, version, to })), waiting: p.waiting.map(({ id, name, version, to, matureAt }) => ({ id, name, version, to, matureAt })), skipped: p.skipped };
  });
  const jobSt = (l) => { const j = db.getJobSummary(l.jobId); return { jobId: l.jobId, group: l.group, night: l.night, status: j ? j.status : 'smazán' }; };
  return {
    allowed: true, paused: !!g.auto_pause, startOffsetMin: nw ? startOffsetMin(user.id, (windowNow(settings, new Date(nw + 1000)) || {}).night || '', settings) : 0,
    settings: Object.fromEntries(KEYS.map(k => [k, settings[k]])),
    targets: targets(settings), groups, pickable: mine.map(d => d.id),
    nextNight: nw ? nightKey(nw) : '', skipNight: us.skipNight || '', skipped: (() => { const cur = windowNow(settings); return !!us.skipNight && ((nw && us.skipNight === nightKey(nw)) || (!!cur && us.skipNight === cur.night)); })(),
    mail: { enabled: mail.enabled(), to: mailTo(user, settings).join(', '), error: us.mailError || null },
    halted: us.halted || '', haltedAt: us.haltedAt || 0, failed: Object.entries(us.failed || {}).map(([id, f]) => ({ id: +id, ...f })),
    open: us.open.map(jobSt), outbox: us.outbox.length, lastCheck: us.lastCheck || null, lastError: us.lastError || null,
    history: us.history || [], nextWindow: nw, windowValid: !!parseWindow(settings.auto_window), quarantine: state.quarantine,
  };
}
/** ruční uvolnění po chybě: automat pokračuje další noc, selhané kusy se znovu zařadí */
function release(uid) { const us = userState(uid); us.halted = ''; us.haltedAt = 0; us.failed = {}; us.blocked = {}; save(); }
/** vynechat / vrátit nejbližší noc */
function skipNight(user, on, now = new Date()) {
  const us = userState(user.id); const settings = db.getSettings(user.id);
  // uvnitř běžícího okna, které ještě nic nespustilo (čeká třeba na minulý job), se vynechává právě tahle noc, ne až příští
  const cur = windowNow(settings, now); const key = cur && us.lastNight !== cur.night && parseDays(settings.auto_days).includes(cur.day) ? cur.night : (nextWindow(settings, now) ? nightKey(nextWindow(settings, now)) : '');
  us.skipNight = on ? key : ''; save();
}
/** zkušební e-mail na adresu pro hlášení (chyba se vrací volajícímu) */
const testMailAt = new Map();
function testMail(user, toRaw) {
  const settings = db.getSettings(user.id);
  // adresa rozepsaná ve formuláři (ještě neuložená) má přednost — zkouší se to, co uživatel vidí
  let to = mailTo(user, settings);
  if (toRaw !== undefined && String(toRaw).trim() !== '') { const v = validate({ auto_mail_to: toRaw }); if (v.error) return Promise.reject(new Error(v.error)); to = v.values.auto_mail_to.split(', '); }
  if (Date.now() - (testMailAt.get(user.id) || 0) < 20e3) return Promise.reject(new Error('zkušební e-mail jde poslat jednou za 20 sekund'));
  testMailAt.set(user.id, Date.now());
  if (!to.length) return Promise.reject(new Error('účet nemá e-mail — vyplň adresu pro hlášení'));
  return mail.send({ to, subject: '[upgrader] zkušební e-mail automatu', text: `Zkušební zpráva z MikroTik upgraderu: hlášení automatického upgradu budou chodit na ${to.join(', ')}.\n\n${cfg.publicUrl}/\n` }).then(() => { const us = userState(user.id); delete us.mailError; save(); return to; });
}
/** správce: zrušit karanténu verze */
function unquarantine(version) { delete state.quarantine[version]; delete state.fails[version]; save(); }

let timer = null;
function start() { if (timer) return; timer = setInterval(() => tick().catch(e => console.error('automat:', e.message)), 60e3); timer.unref(); }

module.exports = { startOffsetMin, flushDigest, settle, busyDevices, summaryText, flushOutbox, configure, start, tick, statusFor, release, skipNight, testMail, unquarantine, validate, allowed, targets, saveGroup, moveGroup, deleteGroup, planGroup, pickable, windowNow, nextWindow, evaluate, parseWindow, KEYS, _state: () => state };
