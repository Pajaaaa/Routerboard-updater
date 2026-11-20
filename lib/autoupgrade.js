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
try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && typeof j === 'object') state = { users: j.users || {}, fails: j.fails || {}, quarantine: j.quarantine || {} }; } catch {}
function save() { try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('auto-upgrade.json:', e.message); } }
function userState(uid) {
  const k = String(uid); const us = state.users[k] || (state.users[k] = { groups: [], open: [], halted: '', failed: {}, history: [] });
  if (!Array.isArray(us.groups)) us.groups = []; if (!Array.isArray(us.open)) us.open = []; if (!us.failed) us.failed = {}; if (!Array.isArray(us.history)) us.history = [];
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
function validate(b) {
  const out = {};
  if ('auto_enable' in b) out.auto_enable = !!b.auto_enable;
  if ('auto_mail' in b) out.auto_mail = !!b.auto_mail;
  if ('auto_mail_to' in b) { const l = String(b.auto_mail_to || '').split(/[\s,;]+/).filter(Boolean); if (!l.every(mail.validAddr)) return { error: 'adresa pro hlášení není platný e-mail' }; out.auto_mail_to = l.join(', '); }
  if ('auto_delay_days' in b) { const d = Number(b.auto_delay_days); if (!Number.isFinite(d) || d < 0 || d > 365) return { error: 'zpoždění: počet dní 0–365' }; out.auto_delay_days = d; }
  if ('auto_window' in b) { const w = String(b.auto_window || '').trim(); if (!parseWindow(w)) return { error: 'noční okno zadej jako HH:MM-HH:MM, např. 01:00-04:30' }; out.auto_window = w; }
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
/** uložení skupiny (nová bez id); zařízení se z ostatních skupin odeberou — kus je nejvýš v jedné. Vrací { group } nebo { error } */
function saveGroup(uid, b) {
  const us = userState(uid); const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return { error: 'job potřebuje název' };
  let delay = null;
  if (b.delay_days !== null && b.delay_days !== undefined && String(b.delay_days).trim() !== '') { delay = Number(b.delay_days); if (!Number.isFinite(delay) || delay < 0 || delay > 365) return { error: 'zpoždění: počet dní 0–365 (prázdné = výchozí)' }; }
  const ok = new Set(pickable(uid).map(d => d.id));
  const devs = [...new Set((Array.isArray(b.deviceIds) ? b.deviceIds : []).map(Number).filter(id => ok.has(id)))];
  if (!devs.length) return { error: 'vyber aspoň jedno zařízení' };
  let g = b.id ? us.groups.find(x => x.id === Number(b.id)) : null;
  if (b.id && !g) return { error: 'job neexistuje' };
  if (us.groups.some(x => x !== g && x.name.toLowerCase() === name.toLowerCase())) return { error: 'job s tímhle názvem už máš' };
  if (!g) { g = { id: (us.groups.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1, created: Date.now() }; us.groups.push(g); }
  Object.assign(g, { name, delay_days: delay, enabled: b.enabled !== false, devs });
  for (const x of us.groups) if (x !== g) x.devs = x.devs.filter(id => !devs.includes(id));
  save();
  return { group: g };
}
function deleteGroup(uid, id) { const us = userState(uid); us.groups = us.groups.filter(g => g.id !== Number(id)); save(); }

/** plán jedné skupiny k času `nowSec`: cíle podle jejího zpoždění, kusy pod zralým cílem (list) a proč zbytek nejde (waiting, skipped) */
function planGroup(uid, settings, g, nowSec) {
  const us = userState(uid);
  const gs = g.delay_days === null || g.delay_days === undefined ? settings : { ...settings, auto_delay_days: g.delay_days };
  const tg = targets(gs, nowSec);
  const inJob = new Set(db.pendingUpgrades().map(x => x.device_id));
  const list = [], waiting = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const id of g.devs) {
    const d = db.getDevice(id);
    if (!d || !access.canAccess(uid, d)) { skip('zařízení už nemáš ve správě'); continue; }
    if (!d.managed || d.enabled === false || d.dup_of) { skip('vypnuté / neřízené'); continue; }
    const eff = effectiveTrack(d, settings);
    if (eff === 'hold') { skip('kanál hold'); continue; }
    const t = tg[eff]; if (!t) continue;
    const cur = V.parseVersion(d.version), tv = V.parseVersion(t.version);
    if (!cur) { skip('neznámá verze (ještě neskenováno)'); continue; }
    if (!(V.cmpVersion(cur, tv) < 0)) continue; // už na cíli nebo výš
    if (cur.major !== tv.major) { skip('přechod na jinou hlavní verzi (6 → 7) dělej ručně'); continue; }
    const row = { id: d.id, name: d.name || d.identity || d.host, host: d.host, model: d.model || d.board_name || '', version: d.version, to: t.version, track: eff, depth: db.ancestorIds(d.id).length, priority: d.priority || 0 };
    if (t.blocked) { skip(`verze ${t.version}: ${t.blocked}`); continue; }
    if (!t.mature) { waiting.push({ ...row, matureAt: t.matureAt }); continue; }
    if (d.scan_status !== 'ok') { skip('při posledním skenu nedostupné'); continue; }
    if (us.failed[d.id]) { skip('minule v automatu selhalo (čeká na uvolnění)'); continue; }
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
  return { night: `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`, day: start.getDay(), endSec: Math.floor(end.getTime() / 1000), leftMin: (end.getTime() - now.getTime()) / 60000 };
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
function sendMail(user, settings, subject, lines) {
  if (!settings.auto_mail || !mail.enabled()) return Promise.resolve(false);
  const to = mailTo(user, settings); if (!to.length) return Promise.resolve(false);
  const text = [...lines, '', `Stav a nastavení: ${cfg.publicUrl}/ (vlevo Automat)`, '', 'Zprávu poslal MikroTik upgrader automaticky; hlášení vypneš na stránce Automat.'].join('\n');
  return mail.send({ to, subject: `[upgrader] ${subject}`, text }).then(() => true).catch(e => { console.error(`automat: e-mail pro ${to.join(', ')} se nepodařilo odeslat: ${e.message}`); userState(user.id).mailError = { at: Date.now(), error: e.message }; save(); return false; });
}
const devLine = (x) => `  ${x.name}  (${x.host}${x.model ? ', ' + x.model : ''})  ${x.version} → ${x.to}`;
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
  await sendMail(user, settings, `dnes v noci půjde ${all.length} zařízení na ${vers}`, [
    `Automatický upgrade: v noci ${czNight(key)} v okně ${hm(w.a)}–${hm(w.b)} se upgraduje ${all.length} zařízení na RouterOS ${vers}.`, '',
    ...plans.flatMap(x => [`Job „${x.g.name}“ (${x.list.length}):`, ...x.list.map(devLine), '']),
    'Nechceš-li to, na stránce Automat dej „Tuto noc vynechat“ nebo automat vypni. Při první chybě se automat zastaví sám.',
  ]);
}
/** po noci: souhrn uzavřeného jobu */
function summaryMail(user, settings, l, job, items, hard, counts) {
  const row = (it) => `  ${it.dev_name || it.host}  (${it.host})`;
  const ok = items.filter(it => it.status === 'done' && !(it.result && it.result.partial));
  const rest = items.filter(it => !ok.includes(it));
  const lines = [`Automatický upgrade „${l.group || ''}“, noc ${czNight(l.night)}, job #${l.jobId} (${job.status_note || job.status}): ${counts.ok} v pořádku, ${hard.length} chyb, ${counts.unreachable} nedostupných, ${counts.skipped} přeskočeno.`, ''];
  if (hard.length) lines.push('AUTOMAT SE ZASTAVIL. Zkontroluj zařízení a na stránce Automat dej „uvolnit“ — do té doby se další noci nic nespustí.', '', 'Chyby:', ...hard.map(h => `  ${h.label}: ${h.error}`), '');
  if (ok.length) lines.push('V pořádku:', ...ok.map(it => `${row(it)}  ${it.from_version || '?'} → ${it.to_version || '?'}`), '');
  if (rest.length - hard.length > 0) lines.push('Neprovedeno:', ...rest.filter(it => !['failed', 'unknown'].includes(it.status) || (it.result && it.result.untouched)).map(it => `${row(it)}: ${it.error || String(it.step || '').replace(/^přeskočí se: /, '') || it.status}`), '');
  lines.push(`Job: ${cfg.publicUrl}/ (Upgrady → #${l.jobId})`);
  return sendMail(user, settings, hard.length ? `AUTOMAT ZASTAVEN: ${hard.length} chyb v noci ${czNight(l.night)}` : `„${l.group || ''}“ ${czNight(l.night)}: ${counts.ok} zařízení upgradováno${counts.skipped + counts.unreachable ? `, ${counts.skipped + counts.unreachable} neprovedeno` : ''}`, lines);
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
    for (const it of items) {
      const label = it.dev_name || it.host || ('#' + it.device_id);
      if (it.status === 'done' && !(it.result && it.result.partial)) ok++;
      else if (['failed', 'unknown'].includes(it.status)) {
        if (it.result && it.result.untouched) { unreachable++; continue; } // nedostupné, nic se na něm nezměnilo — není to chyba upgradu
        hard.push({ id: it.device_id, label, error: it.error || it.status, version: (l.devs || {})[it.device_id] || it.to_version || '' });
      } else skippedN++;
    }
    if (hard.length) {
      us.halted = `job #${l.jobId} „${l.group}“: ${hard.map(h => `${h.label} — ${h.error}`).join('; ')}`.slice(0, 600); us.haltedAt = Date.now();
      for (const h of hard) {
        us.failed[h.id] = { version: h.version, at: Date.now(), error: String(h.error).slice(0, 300), label: h.label };
        if (!h.version) continue;
        const f = state.fails[h.version] || (state.fails[h.version] = []); if (!f.includes(Number(uid))) f.push(Number(uid));
        if (f.length >= 2 && !state.quarantine[h.version]) { state.quarantine[h.version] = `selhala u ${f.length} různých správců (naposledy ${h.label})`; db.audit('automat', 'verze v karanténě', `${h.version}: ${state.quarantine[h.version]}`); }
      }
      db.audit('automat', 'automatický upgrade zastaven', `uživatel #${uid}: ${us.halted}`);
    }
    us.history.unshift({ night: l.night, jobId: l.jobId, group: l.group, targets: l.targets, total: items.length, ok, failed: hard.length, unreachable, skipped: skippedN });
    const user = db.listUsers().find(u => u.id === Number(uid));
    if (user) summaryMail(user, db.getSettings(user.id), l, job, items, hard, { ok, unreachable, skipped: skippedN }).catch(() => {});
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
  const options = { dry_run: false, mode: 'upload', firmware: true, stop_on_failure: true, canary: false, precheck: true, device_mode: true, parallel: 4,
    auto: true, auto_group: g.name, targets: jobTargets, stop_at: win.endSec, by: 'automat' };
  const name = `Automat „${g.name}“ → ${[...new Set(Object.values(jobTargets))].join(', ')} (noc ${win.night.split('-').reverse().slice(0, 2).map(Number).join('.')}.)`;
  const jobId = db.createJob(name, options, list.map(x => x.id), user.id);
  db.addLog(jobId, 0, 0, 'info', `Job založil automat ze skupiny „${g.name}“: ${list.length} zařízení, cíl ${Object.entries(jobTargets).map(([t, v]) => `${t} ${v}`).join(', ')}, okno do ${new Date(win.endSec * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}. Při první chybě se zastaví.`);
  db.audit('automat', 'automatický upgrade spuštěn', `uživatel ${user.userdb_nick || user.name}: job #${jobId} „${g.name}“, ${list.length} zařízení → ${Object.values(jobTargets).join(', ')}`);
  us.open.push({ jobId, night: win.night, at: Date.now(), group: g.name, groupId: g.id, targets: jobTargets, devs: Object.fromEntries(list.map(x => [x.id, x.to])) });
  save();
  deps.pool.startOrQueue(jobId);
  deps.notify(jobId);
  return jobId;
}
function launch(user, settings, win, nowSec) {
  const us = userState(user.id); let n = 0;
  for (const g of us.groups.filter(x => x.enabled !== false)) {
    const plan = { g, ...planGroup(user.id, settings, g, nowSec) }; // každá skupina až po založení předchozího jobu — kus v něm už je „v jiném jobu“
    if (plan.list.length) { launchGroup(user, win, plan); n++; }
  }
  us.lastNight = win.night; us.lastCheck = { night: win.night, at: Date.now(), jobs: n };
  save();
  return n;
}

let ticking = false;
async function tick(now = new Date()) {
  if (ticking || !deps.pool) return; ticking = true;
  try {
    const g = db.getSettings();
    for (const user of db.listUsers()) {
      if (!allowed(user)) continue;
      const settings = db.getSettings(user.id);
      const us = userState(user.id);
      const idle = evaluate(user.id); // i mimo okno, ať je ráno vidět výsledek
      if (!settings.auto_enable || g.auto_pause || deps.pool.draining || us.halted || !us.groups.length) continue;
      await announce(user, settings, now).catch(e => console.error('automat (oznámení):', e.message));
      const win = windowNow(settings, now);
      if (!win || !parseDays(settings.auto_days).includes(win.day) || win.leftMin < MIN_LEFT_MIN) continue;
      if (us.lastNight === win.night || us.skipNight === win.night) continue; // dnes už bylo / uživatel tuhle noc vynechal
      if (!idle) continue; // minulý job automatu ještě není uzavřený
      await V.refreshLatest().catch(() => {});
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
  const mine = pickable(user.id); const byId = new Map(mine.map(d => [d.id, d]));
  const groups = us.groups.map(gr => {
    const p = planGroup(user.id, settings, gr, at); const now = targets(gr.delay_days === null || gr.delay_days === undefined ? settings : { ...settings, auto_delay_days: gr.delay_days });
    return { id: gr.id, name: gr.name, enabled: gr.enabled !== false, delay_days: gr.delay_days === undefined ? null : gr.delay_days, devs: gr.devs,
      devices: gr.devs.map(id => { const d = byId.get(id); return d ? { id, name: d.name || d.identity || d.host, host: d.host, model: d.model || d.board_name || '', version: d.version } : { id, name: '(už není ve správě)', host: '', model: '', version: '' }; }),
      targets: now, next: p.list.map(({ id, name, host, model, version, to }) => ({ id, name, host, model, version, to })), waiting: p.waiting.map(({ id, name, version, to, matureAt }) => ({ id, name, version, to, matureAt })), skipped: p.skipped };
  });
  const jobSt = (l) => { const j = db.getJobSummary(l.jobId); return { jobId: l.jobId, group: l.group, night: l.night, status: j ? j.status : 'smazán' }; };
  return {
    allowed: true, paused: !!g.auto_pause,
    settings: Object.fromEntries(KEYS.map(k => [k, settings[k]])),
    targets: targets(settings), groups, pickable: mine.map(d => d.id),
    nextNight: nw ? nightKey(nw) : '', skipNight: us.skipNight || '',
    mail: { enabled: mail.enabled(), to: mailTo(user, settings).join(', '), error: us.mailError || null },
    halted: us.halted || '', haltedAt: us.haltedAt || 0, failed: Object.entries(us.failed || {}).map(([id, f]) => ({ id: +id, ...f })),
    open: us.open.map(jobSt), lastCheck: us.lastCheck || null, lastError: us.lastError || null,
    history: us.history || [], nextWindow: nw, windowValid: !!parseWindow(settings.auto_window), quarantine: state.quarantine,
  };
}
/** ruční uvolnění po chybě: automat pokračuje další noc, selhané kusy se znovu zařadí */
function release(uid) { const us = userState(uid); us.halted = ''; us.haltedAt = 0; us.failed = {}; save(); }
/** vynechat / vrátit nejbližší noc */
function skipNight(user, on) { const us = userState(user.id); const nw = nextWindow(db.getSettings(user.id)); us.skipNight = on && nw ? nightKey(nw) : ''; save(); }
/** zkušební e-mail na adresu pro hlášení (chyba se vrací volajícímu) */
function testMail(user) {
  const settings = db.getSettings(user.id); const to = mailTo(user, settings);
  if (!to.length) return Promise.reject(new Error('účet nemá e-mail — vyplň adresu pro hlášení'));
  return mail.send({ to, subject: '[upgrader] zkušební e-mail automatu', text: `Zkušební zpráva z MikroTik upgraderu: hlášení automatického upgradu budou chodit na ${to.join(', ')}.\n\n${cfg.publicUrl}/\n` }).then(() => { const us = userState(user.id); delete us.mailError; save(); return to; });
}
/** správce: zrušit karanténu verze */
function unquarantine(version) { delete state.quarantine[version]; delete state.fails[version]; save(); }

let timer = null;
function start() { if (timer) return; timer = setInterval(() => tick().catch(e => console.error('automat:', e.message)), 60e3); timer.unref(); }

module.exports = { configure, start, tick, statusFor, release, skipNight, testMail, unquarantine, validate, allowed, targets, saveGroup, deleteGroup, planGroup, pickable, windowNow, nextWindow, evaluate, parseWindow, KEYS, _state: () => state };
