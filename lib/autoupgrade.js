'use strict';
/**
 * Automatický upgrade (20.11.2026). Když MikroTik vydá novou verzi kanálu a ta „dozraje“ (auto_delay_days po vydání; opravné vydání
 * odpočet spustí znovu, protože se sleduje vždy poslední verze kanálu), automat ji v nočním okně po vlnách nasadí na zařízení uživatele.
 *
 * Automat nic neupgraduje sám: jednou za noc založí úplně obyčejný job (options.auto) — kontroly, pořadí podle topologie, zámky, zálohy,
 * logy i drain při aktualizaci serveru tak platí beze změny. Navíc jen:
 *   options.targets  — cíl kanálu pro tento job (bez ohledu na připnuté verze; lib/versions.withTargets)
 *   options.stop_at  — konec okna: rozdělaný kus se dokončí, nový se nezačíná, zbytek jde další noc
 *   stop_on_failure  — první skutečná chyba job ukončí a automat se uživateli zastaví, dokud ho ručně neuvolní
 *
 * Výběr kusů: jen vlastní zařízení uživatele, dostupná při posledním skenu, jen upgrade v rámci stejné hlavní verze (6→7 nikdy),
 * infrastruktura jen s auto_backbone. První noc kanárci (různé modely, od koncových kusů), další noci vlny podle auto_waves; vlna se
 * posune, jen když se předchozí noc aspoň jeden kus povedl. V jedné noci nikdy rodič s potomkem ani oba konce spoje.
 * Selže-li stejná verze dvěma různým uživatelům, jde do karantény a automat ji nenasazuje nikomu.
 *
 * Stav (vlny, zastavení, historie nocí) je v data/auto-upgrade.json. Zapnout smí jen účty ze společného nastavení auto_users.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const V = require('./versions');
const SCHED = require('./schedule');
const { effectiveTrack } = require('./planner');
const { physicallyAdjacent, sameVerticalChain } = require('./runner');
const mail = require('./mail');

const TRACKS = ['v7-long-term', 'v7-stable', 'v6-long-term'];
const OPEN = new Set(['running', 'waiting', 'waiting-window', 'queued', 'scheduled', 'paused', 'batch-hold']);
const KEYS = ['auto_enable', 'auto_delay_days', 'auto_window', 'auto_days', 'auto_backbone', 'auto_waves', 'auto_mail', 'auto_mail_to'];
const ANNOUNCE_H = 8;    // oznámení „dnes v noci půjde…“ nejdřív tolik hodin před začátkem okna
const MIN_LEFT_MIN = 30; // méně než půl hodiny do konce okna → už nezačínat
const FILE = path.join(cfg.dataDir, 'auto-upgrade.json');

let state = { users: {}, fails: {}, quarantine: {} };
try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && typeof j === 'object') state = { users: j.users || {}, fails: j.fails || {}, quarantine: j.quarantine || {} }; } catch {}
function save() { try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('auto-upgrade.json:', e.message); } }
function userState(uid) { const k = String(uid); return state.users[k] || (state.users[k] = { tracks: {}, halted: '', failed: {}, last: null, history: [] }); }

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
const parseWaves = (s) => String(s == null ? '' : s).split(/[\s,;]+/).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
const waveSize = (settings, wave) => { const w = parseWaves(settings.auto_waves); return wave < w.length ? w[wave] : Infinity; };
const delayDays = (settings) => { const d = Number(settings.auto_delay_days); return Number.isFinite(d) && d >= 0 ? d : 5; };

/** kontrola a očištění hodnot z formuláře; vrací { values } nebo { error } */
function validate(b) {
  const out = {};
  if ('auto_enable' in b) out.auto_enable = !!b.auto_enable;
  if ('auto_backbone' in b) out.auto_backbone = !!b.auto_backbone;
  if ('auto_mail' in b) out.auto_mail = !!b.auto_mail;
  if ('auto_mail_to' in b) { const l = String(b.auto_mail_to || '').split(/[\s,;]+/).filter(Boolean); if (!l.every(mail.validAddr)) return { error: 'adresa pro hlášení není platný e-mail' }; out.auto_mail_to = l.join(', '); }
  if ('auto_delay_days' in b) { const d = Number(b.auto_delay_days); if (!Number.isFinite(d) || d < 0 || d > 365) return { error: 'zpoždění: počet dní 0–365' }; out.auto_delay_days = d; }
  if ('auto_window' in b) { const w = String(b.auto_window || '').trim(); if (!parseWindow(w)) return { error: 'noční okno zadej jako HH:MM-HH:MM, např. 01:00-04:30' }; out.auto_window = w; }
  if ('auto_days' in b) { const d = parseDays(Array.isArray(b.auto_days) ? b.auto_days.join(',') : b.auto_days); if (!d.length) return { error: 'vyber aspoň jeden den v týdnu' }; out.auto_days = d.sort().join(','); }
  if ('auto_waves' in b) { const raw = String(b.auto_waves || '').trim(); const w = parseWaves(raw); if (raw && w.length !== raw.split(/[\s,;]+/).filter(Boolean).length) return { error: 'vlny: kladná čísla oddělená čárkou, např. 3,10,25' }; out.auto_waves = w.join(','); }
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

// ---------- zařízení ----------
const CLASS_RANK = { leaf: 0, sector: 1, infra: 2 };
/** kusy uživatele, které by automat mohl vzít: { byTrack: { track: [ { d, raw, cls, depth } ] }, skipped: { důvod: počet } } */
function candidates(uid, settings, tg) {
  const us = userState(uid);
  const inJob = new Set(db.pendingUpgrades().map(x => x.device_id));
  const byTrack = {}, skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const d of db.listDevices(Number(uid))) {
    if (!d.managed || d.enabled === false || d.enabled === 0 || d.dup_of) continue;
    const eff = effectiveTrack(d, settings);
    const t = tg[eff]; if (eff === 'hold') { skip('kanál hold'); continue; }
    if (!t) continue;
    const cur = V.parseVersion(d.version), tv = V.parseVersion(t.version);
    if (!cur) { skip('neznámá verze (ještě neskenováno)'); continue; }
    if (!(V.cmpVersion(cur, tv) < 0)) continue; // už na cíli nebo výš
    if (cur.major !== tv.major) { skip('přechod na jinou hlavní verzi (6 → 7) dělej ručně'); continue; }
    if (!t.mature || t.blocked) continue;
    if (d.scan_status !== 'ok') { skip('při posledním skenu nedostupné'); continue; }
    if (us.failed[d.id]) { skip('minule v automatu selhalo (čeká na uvolnění)'); continue; }
    if (inJob.has(d.id) || (deps.pool && deps.pool.isDeviceBusy(d.id))) { skip('už je v jiném jobu'); continue; }
    const raw = db.getDeviceRaw(d.id); if (!raw) continue;
    const cls = SCHED.classify(raw);
    if (cls === 'infra' && !settings.auto_backbone) { skip('infrastruktura (páteř není povolená)'); continue; }
    (byTrack[eff] || (byTrack[eff] = [])).push({ d, raw, cls, depth: db.ancestorIds(d.id).length });
  }
  for (const l of Object.values(byTrack)) l.sort((a, b) => CLASS_RANK[a.cls] - CLASS_RANK[b.cls] || b.depth - a.depth || String(a.d.host).localeCompare(String(b.d.host)));
  return { byTrack, skipped };
}

/** výběr na jednu noc: velikost vlny na kanál, kanárci po modelech, nikdy rodič s potomkem ani oba konce spoje */
function pickNight(us, cands, settings, tg) {
  const picked = []; // { d, raw, cls, depth, track }
  const clash = (x) => picked.some(p => sameVerticalChain(x.raw, p.raw) || physicallyAdjacent(x.raw, p.raw));
  for (const track of TRACKS) {
    const list = cands.byTrack[track]; if (!list || !list.length) continue;
    const wave = us.tracks[track] && us.tracks[track].version === tg[track].version ? (us.tracks[track].wave || 0) : 0;
    const n = waveSize(settings, wave); let cnt = 0;
    const take = (x) => { picked.push({ ...x, track }); cnt++; };
    if (wave === 0) { // kanárci: od každého modelu jeden
      const seen = new Set();
      for (const x of list) { if (cnt >= n) break; const key = x.d.board_name || x.d.model || '?'; if (seen.has(key) || clash(x)) continue; seen.add(key); take(x); }
    }
    for (const x of list) { if (cnt >= n) break; if (picked.some(p => p.d.id === x.d.id) || clash(x)) continue; take(x); }
  }
  return picked;
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
/** co by šlo v noci, která začne v čase `atMs` (zralost verzí se počítá k začátku okna) */
function planFor(uid, settings, atMs) {
  const us = userState(uid); const tg = targets(settings, atMs / 1000); const c = candidates(uid, settings, tg);
  const picked = pickNight({ ...us, tracks: Object.fromEntries(TRACKS.map(t => [t, us.tracks[t] && tg[t] && us.tracks[t].version === tg[t].version ? us.tracks[t] : { wave: 0, version: tg[t] ? tg[t].version : '' }])) }, c, settings, tg);
  return { tg, c, list: picked.map(x => ({ id: x.d.id, name: x.d.name || x.d.identity || x.d.host, host: x.d.host, model: x.d.model || x.d.board_name || '', version: x.d.version, to: tg[x.track].version, cls: x.cls })) };
}
const annChecked = new Map(); // uid → kdy se naposledy počítalo oznámení (počítá se nejvýš jednou za 10 min)
/** večer před nocí: co půjde. Posílá se jednou na noc, jen když je co dělat. */
async function announce(user, settings, now) {
  if (!settings.auto_mail || !mail.enabled()) return;
  const us = userState(user.id); const nw = nextWindow(settings, now);
  if (!nw || nw - now.getTime() > ANNOUNCE_H * 3600e3) return;
  const key = nightKey(nw);
  if (us.announced === key || us.skipNight === key || us.lastNight === key) return;
  if (now.getTime() - (annChecked.get(user.id) || 0) < 10 * 60e3) return; annChecked.set(user.id, now.getTime());
  const p = planFor(user.id, settings, nw); if (!p.list.length) return;
  us.announced = key; save();
  const w = parseWindow(settings.auto_window); const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const vers = [...new Set(p.list.map(x => x.to))].join(', ');
  await sendMail(user, settings, `dnes v noci půjde ${p.list.length} zařízení na ${vers}`, [
    `Automatický upgrade: v noci ${czNight(key)} v okně ${hm(w.a)}–${hm(w.b)} se upgraduje ${p.list.length} zařízení na RouterOS ${vers}.`, '',
    ...p.list.map(devLine), '',
    'Nechceš-li to, na stránce Automat dej „Tuto noc vynechat“ nebo automat vypni. Při první chybě se automat zastaví sám.',
  ]);
}
/** po noci: souhrn uzavřeného jobu */
function summaryMail(user, settings, l, job, items, hard, counts) {
  const row = (it) => `  ${it.dev_name || it.host}  (${it.host})`;
  const ok = items.filter(it => it.status === 'done' && !(it.result && it.result.partial));
  const rest = items.filter(it => !ok.includes(it));
  const lines = [`Automatický upgrade, noc ${czNight(l.night)}, job #${l.jobId} (${job.status_note || job.status}): ${counts.ok} v pořádku, ${hard.length} chyb, ${counts.unreachable} nedostupných, ${counts.skipped} přeskočeno.`, ''];
  if (hard.length) lines.push('AUTOMAT SE ZASTAVIL. Zkontroluj zařízení a na stránce Automat dej „uvolnit“ — do té doby se další noci nic nespustí.', '', 'Chyby:', ...hard.map(h => `  ${h.label}: ${h.error}`), '');
  if (ok.length) lines.push('V pořádku:', ...ok.map(it => `${row(it)}  ${it.from_version || '?'} → ${it.to_version || '?'}`), '');
  if (rest.length - hard.length > 0) lines.push('Neprovedeno:', ...rest.filter(it => !['failed', 'unknown'].includes(it.status) || (it.result && it.result.untouched)).map(it => `${row(it)}: ${it.error || String(it.step || '').replace(/^přeskočí se: /, '') || it.status}`), '');
  lines.push(`Job: ${cfg.publicUrl}/ (Upgrady → #${l.jobId})`);
  return sendMail(user, settings, hard.length ? `AUTOMAT ZASTAVEN: ${hard.length} chyb v noci ${czNight(l.night)}` : `noc ${czNight(l.night)}: ${counts.ok} zařízení upgradováno${counts.skipped + counts.unreachable ? `, ${counts.skipped + counts.unreachable} neprovedeno` : ''}`, lines);
}

// ---------- vyhodnocení minulé noci ----------
/** true = minulý job automatu je uzavřený a vyhodnocený (nebo žádný nebyl); false = ještě otevřený */
function evaluate(uid) {
  const us = userState(uid); const l = us.last;
  if (!l || l.evaluated) return true;
  const job = db.getJob(l.jobId);
  if (job && OPEN.has(job.status)) return false;
  l.evaluated = true;
  if (!job) { save(); return true; }
  const okTracks = new Set(); const hard = []; let ok = 0, skippedN = 0, unreachable = 0;
  for (const it of db.getJobItems(l.jobId)) {
    const track = (l.devs || {})[it.device_id]; const label = it.dev_name || it.host || ('#' + it.device_id);
    if (it.status === 'done' && !(it.result && it.result.partial)) { ok++; if (track) okTracks.add(track); }
    else if (['failed', 'unknown'].includes(it.status)) {
      if (it.result && it.result.untouched) { unreachable++; continue; } // nedostupné, nic se na něm nezměnilo — není to chyba upgradu
      hard.push({ id: it.device_id, label, error: it.error || it.status, version: (l.targets || {})[track] || it.to_version || '' });
    } else skippedN++;
  }
  for (const t of okTracks) if (us.tracks[t] && us.tracks[t].version === (l.targets || {})[t]) us.tracks[t].wave = (us.tracks[t].wave || 0) + 1;
  if (hard.length) {
    us.halted = `job #${l.jobId}: ${hard.map(h => `${h.label} — ${h.error}`).join('; ')}`.slice(0, 600); us.haltedAt = Date.now();
    for (const h of hard) {
      us.failed[h.id] = { version: h.version, at: Date.now(), error: String(h.error).slice(0, 300), label: h.label };
      if (!h.version) continue;
      const f = state.fails[h.version] || (state.fails[h.version] = []); if (!f.includes(Number(uid))) f.push(Number(uid));
      if (f.length >= 2 && !state.quarantine[h.version]) { state.quarantine[h.version] = `selhala u ${f.length} různých správců (naposledy ${h.label})`; db.audit('automat', 'verze v karanténě', `${h.version}: ${state.quarantine[h.version]}`); }
    }
    db.audit('automat', 'automatický upgrade zastaven', `uživatel #${uid}: ${us.halted}`);
  }
  us.history.unshift({ night: l.night, jobId: l.jobId, targets: l.targets, total: Object.keys(l.devs || {}).length, ok, failed: hard.length, unreachable, skipped: skippedN });
  us.history = us.history.slice(0, 30);
  save();
  const user = db.listUsers().find(u => u.id === Number(uid));
  if (user) summaryMail(user, db.getSettings(user.id), l, job, db.getJobItems(l.jobId), hard, { ok, unreachable, skipped: skippedN }).catch(() => {});
  return true;
}

// ---------- noční běh ----------
function launch(user, settings, win, tg) {
  const us = userState(user.id);
  for (const track of TRACKS) { const t = tg[track]; if (t && t.mature && !t.blocked && (!us.tracks[track] || us.tracks[track].version !== t.version)) us.tracks[track] = { version: t.version, wave: 0, since: Date.now() }; }
  const picked = pickNight(us, candidates(user.id, settings, tg), settings, tg);
  us.lastCheck = { night: win.night, at: Date.now(), picked: picked.length };
  if (!picked.length) { us.lastNight = win.night; save(); return 0; } // dnes není co dělat — znovu až další noc
  const jobTargets = {}; for (const x of picked) jobTargets[x.track] = tg[x.track].version;
  const waves = [...new Set(picked.map(x => (us.tracks[x.track].wave || 0) + 1))].join('/');
  const options = { dry_run: false, mode: 'upload', firmware: true, stop_on_failure: true, canary: false, precheck: true, device_mode: true, parallel: 4,
    auto: true, targets: jobTargets, stop_at: win.endSec, by: 'automat' };
  const devs = picked.slice().sort((a, b) => b.depth - a.depth || (a.d.priority || 0) - (b.d.priority || 0) || String(a.d.host).localeCompare(String(b.d.host)));
  const name = `Automatický upgrade → ${[...new Set(Object.values(jobTargets))].join(', ')} (noc ${win.night.split('-').reverse().slice(0, 2).map(Number).join('.')}., vlna ${waves})`;
  const jobId = db.createJob(name, options, devs.map(x => x.d.id), user.id);
  db.addLog(jobId, 0, 0, 'info', `Job založil automat: ${devs.length} zařízení, cíl ${Object.entries(jobTargets).map(([t, v]) => `${t} ${v}`).join(', ')}, okno do ${new Date(win.endSec * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}. Při první chybě se zastaví.`);
  db.audit('automat', 'automatický upgrade spuštěn', `uživatel ${user.userdb_nick || user.name}: job #${jobId}, ${devs.length} zařízení → ${Object.values(jobTargets).join(', ')}`);
  us.last = { jobId, night: win.night, at: Date.now(), targets: jobTargets, devs: Object.fromEntries(picked.map(x => [x.d.id, x.track])), evaluated: false };
  us.lastNight = win.night;
  save();
  deps.pool.startOrQueue(jobId);
  deps.notify(jobId);
  return jobId;
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
      if (us.last && !us.last.evaluated) evaluate(user.id); // i mimo okno, ať je ráno vidět výsledek
      if (!settings.auto_enable || g.auto_pause || deps.pool.draining || us.halted) continue;
      await announce(user, settings, now).catch(e => console.error('automat (oznámení):', e.message));
      const win = windowNow(settings, now);
      if (!win || !parseDays(settings.auto_days).includes(win.day) || win.leftMin < MIN_LEFT_MIN) continue;
      if (us.lastNight === win.night || us.skipNight === win.night) continue; // dnes už bylo / uživatel tuhle noc vynechal
      if (us.last && !us.last.evaluated) continue; // minulý job automatu ještě není uzavřený
      await V.refreshLatest().catch(() => {});
      try { launch(user, settings, win, targets(settings, now.getTime() / 1000)); }
      catch (e) { console.error(`automat (${user.name}): ${e.stack || e.message}`); us.lastNight = win.night; us.lastError = { at: Date.now(), error: e.message }; save(); }
    }
  } finally { ticking = false; }
}

// ---------- pro UI ----------
function statusFor(user) {
  const ok = allowed(user);
  if (!ok) return { allowed: false };
  const settings = db.getSettings(user.id); const g = db.getSettings();
  const us = userState(user.id); const nw = nextWindow(settings);
  const { tg, c, list } = planFor(user.id, settings, nw || Date.now());
  const lastJob = us.last ? db.getJobSummary(us.last.jobId) : null;
  return {
    allowed: true, paused: !!g.auto_pause,
    settings: Object.fromEntries(KEYS.map(k => [k, settings[k]])),
    targets: targets(settings), // stav verzí teď; náhled níže počítá se zralostí k začátku nejbližšího okna
    tracks: Object.fromEntries(TRACKS.filter(t => tg[t]).map(t => [t, { wave: us.tracks[t] && us.tracks[t].version === tg[t].version ? (us.tracks[t].wave || 0) : 0, waiting: (c.byTrack[t] || []).length }])),
    skipped: c.skipped,
    preview: list, nextNight: nw ? nightKey(nw) : '', skipNight: us.skipNight || '',
    mail: { enabled: mail.enabled(), to: mailTo(user, settings).join(', '), error: us.mailError || null },
    halted: us.halted || '', haltedAt: us.haltedAt || 0, failed: Object.entries(us.failed || {}).map(([id, f]) => ({ id: +id, ...f })),
    last: us.last ? { ...us.last, devs: undefined, status: lastJob ? lastJob.status : 'smazán', note: lastJob ? lastJob.status_note : '' } : null,
    lastCheck: us.lastCheck || null, lastError: us.lastError || null,
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

module.exports = { configure, start, tick, statusFor, release, skipNight, testMail, unquarantine, validate, allowed, targets, candidates, pickNight, windowNow, nextWindow, evaluate, parseWindow, KEYS, _state: () => state };
