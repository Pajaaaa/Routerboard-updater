'use strict';
const BASE = location.pathname.replace(/\/[^/]*$/, '');
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MB = 1048576;
let ADV = false; try { ADV = localStorage.getItem('mtu_adv') === '1'; } catch {}
/** připojí klik na prvek, když existuje (helper používaný napříč pohledy) */
const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
let VF = ''; try { VF = localStorage.getItem('mtu_vf') || ''; } catch {}
let SORT = 'tree', SORTDIR = 'asc'; try { const v = (localStorage.getItem('mtu_sort') || '').split(':'); if (v[0]) { SORT = v[0]; SORTDIR = v[1] || 'asc'; } } catch {}
const state = { vf: VF, scanProg: null, sortDir: SORTDIR, owner: 0, authed: false, auth: { sso: false, passwordLogin: true, user: null }, view: 'devices', advanced: ADV, devices: [], jobs: [], latest: { versions: {} }, settings: {}, runner: {}, tracks: [], selected: new Set(), filter: '', group: '', sort: SORT, modal: null, job: null, jobLog: [], detail: null, scanning: [] };

async function api(path, opts = {}) {
  const r = await fetch(BASE + '/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (r.status === 401) { state.authed = false; render(); throw new Error('nepřihlášen'); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
let toastTimer;
function toast(msg, err) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, err ? 8000 : 3500);
}
const fmtTs = (s) => s ? new Date(s * 1000).toLocaleString('cs-CZ') : '—';
const fmtMs = (ms) => new Date(ms).toLocaleTimeString('cs-CZ');
const ago = (s) => { if (!s) return 'nikdy'; const d = Math.floor(Date.now() / 1000 - s); if (d < 90) return `${d} s`; if (d < 5400) return `${Math.round(d / 60)} min`; if (d < 172800) return `${Math.round(d / 3600)} h`; return `${Math.round(d / 86400)} d`; };
const upt = (s) => { if (!s) return '—'; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const mb = (b) => b ? (b / MB).toFixed(b > 100 * MB ? 0 : 1) : '—';

function parseVer(s) { const m = String(s || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?(beta|rc|alpha)?(\d*)/); return m ? { major: +m[1], minor: +m[2], patch: +(m[3] || 0), pre: m[4] || '', preN: +(m[5] || 0) } : null; }
function cmpVer(a, b) { const A = parseVer(a), B = parseVer(b); if (!A || !B) return NaN; for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] - B[k]; const r = { alpha: 0, beta: 1, rc: 2, '': 9 }; if (r[A.pre] !== r[B.pre]) return r[A.pre] - r[B.pre]; return A.preN - B.preN; }
/** skutečný kanál: server u HW bez v7 (32 MB RAM apod.) posílá eff_track = v6-long-term, pokud v7 není výslovně povolena */
function trackOf(d) { return d.eff_track || d.track; }
function targetOf(d) { const t = trackOf(d); return t === 'hold' ? null : (state.latest.versions[t] || {}).version || null; }
function verStatus(d) {
  if (!d.version) return { cls: 'b-muted', txt: '?' , key: 'unknown' };
  const t = targetOf(d);
  if (!t) return { cls: 'b-muted', txt: 'hold', key: 'hold' };
  const c = cmpVer(d.version, t);
  if (c === 0) return { cls: 'b-ok', txt: 'aktuální', key: 'ok' };
  if (c > 0) return { cls: 'b-info', txt: 'novější', key: 'newer' };
  const pv = parseVer(d.version);
  if (pv && pv.major < 7 && parseVer(t).major >= 7) return { cls: 'b-v6', txt: 'v6 → v7', key: 'v6' };
  return { cls: 'b-warn', txt: `→ ${t}`, key: 'old' };
}
const STATUS_LABEL = { ok: ['b-ok', 'OK'], unreachable: ['b-err', 'nedostupný'], auth: ['b-err', 'špatný login'], hostkey: ['b-err', 'host key!'], never: ['b-muted', 'neskenováno'] };
const ITEM_LABEL = { pending: ['b-muted', 'čeká'], checking: ['b-info', 'kontrola'], backup: ['b-info', 'záloha'], upload: ['b-info', 'nahrávání'], reboot: ['b-warn', 'restart'], verify: ['b-info', 'ověření'], firmware: ['b-info', 'firmware'], done: ['b-ok', 'hotovo'], blocked: ['b-warn', 'přeskočeno'], failed: ['b-err', 'chyba'], skipped: ['b-muted', 'vynecháno'], unknown: ['b-err', 'neznámý stav'] };
const JOB_LABEL = { queued: ['b-muted', 'připraven'], running: ['b-info', 'probíhá'], paused: ['b-err', 'zastaven'], waiting: ['b-warn', 'čeká na potvrzení'], scheduled: ['b-warn', 'naplánován'], 'waiting-window': ['b-warn', 'čeká na okno'], done: ['b-ok', 'hotovo'], cancelled: ['b-muted', 'zrušen'] };
/** srozumitelný stav zařízení pro jednoduchý režim */
function plainStatus(d) {
  if (!d.managed) return { cls: 'b-muted', txt: 'jen v topologii', act: null };
  if (d.scan_status === 'never') return { cls: 'b-muted', txt: 'zatím nezkontrolováno', act: 'scan' };
  if (d.scan_status === 'auth') return { cls: 'b-err', txt: 'špatné přihlašovací údaje', act: 'edit' };
  if (d.scan_status === 'hostkey') return { cls: 'b-err', txt: 'změnil se SSH klíč, ověř zařízení', act: 'edit' };
  if (d.scan_status !== 'ok') return { cls: 'b-err', txt: 'nedostupné', act: 'scan' };
  const vs = verStatus(d);
  const t = targetOf(d);
  if (vs.key === 'ok') return { cls: 'b-ok', txt: d.fw_upgrade && d.fw_current !== d.fw_upgrade ? 'aktuální, jen firmware' : 'aktuální', act: d.fw_upgrade && d.fw_current !== d.fw_upgrade ? 'upgrade' : null };
  if (vs.key === 'v6') return { cls: 'b-v6', txt: `upgrade z v6 na ${t}`, act: 'upgrade' };
  if (vs.key === 'old') return { cls: 'b-warn', txt: `upgrade na ${t}`, act: 'upgrade' };
  if (vs.key === 'newer') return { cls: 'b-info', txt: 'novější než cíl', act: null };
  if (vs.key === 'hold') return { cls: 'b-muted', txt: 'neupgradovat (hold)', act: null };
  return { cls: 'b-muted', txt: 'neznámý stav', act: 'scan' };
}
function needsUpgrade(d) { const p = plainStatus(d); return p.act === 'upgrade'; }
function shortReason(txt) { const parts = String(txt || '').split(' | '); return parts[0] + (parts.length > 1 ? ` (+${parts.length - 1})` : ''); }
const badge = (map, k) => { const [c, t] = map[k] || ['b-muted', k]; return `<span class="badge ${c}">${esc(t)}</span>`; };

// ---------- render ----------
function render() {
  const app = $('#app');
  if (!state.authed) { app.innerHTML = `<div class="login panel"><h2>MikroTik upgrader</h2><p>Bezpečný hromadný upgrade RouterOS.</p>
      ${state.auth.sso ? `<a class="ssobtn" href="${BASE}/auth/login">Přihlásit přes hkfree SSO</a>` : ''}
      ${state.auth.passwordLogin ? `${state.auth.sso ? '<div class="hint" style="margin:14px 0 6px">nebo účtem</div>' : ''}<form id="loginf"><input type="text" id="un" placeholder="uživatel" autocomplete="username" ${state.auth.sso ? '' : 'autofocus'}><input type="password" id="pw" placeholder="heslo" autocomplete="current-password"><button class="${state.auth.sso ? '' : 'primary'}" style="width:100%">Přihlásit</button></form>
      ${state.auth.registration ? `<details id="regbox" style="margin-top:14px"><summary class="hint">Nemáš účet? Zaregistruj se</summary><form id="regf" style="margin-top:8px"><input type="text" id="run" placeholder="jméno (2–64 znaků)" autocomplete="username"><input type="password" id="rpw" placeholder="heslo (aspoň 8 znaků)" autocomplete="new-password"><input type="password" id="rpw2" placeholder="heslo znovu" autocomplete="new-password"><button style="width:100%">Založit účet a přihlásit</button><div class="hint" style="margin-top:6px">Uvidíš jen zařízení, která si sám přidáš.</div></form></details>` : ''}` : ''}
      ${location.search.includes('sso_error') ? '<div class="banner err">Přihlášení přes SSO se nezdařilo.</div>' : ''}</div>`;
    const lf = $('#loginf'); if (lf) lf.onsubmit = async (e) => { e.preventDefault(); try { await api('/login', { method: 'POST', body: { username: $('#un').value, password: $('#pw').value } }); state.authed = true; await loadState(); connectSSE(); render(); } catch (e2) { toast(e2.message, true); } };
    const rf = $('#regf'); if (rf) rf.onsubmit = async (e) => { e.preventDefault(); if ($('#rpw').value !== $('#rpw2').value) return toast('hesla se neshodují', true); try { await api('/register', { method: 'POST', body: { username: $('#run').value, password: $('#rpw').value } }); state.authed = true; await loadState(); connectSSE(); render(); toast('účet založen'); } catch (e2) { toast(e2.message, true); } };
    return; }
  const running = state.runner.running;
  const ownRuns = (state.runner.jobs || []).map(r => ({ r, job: state.jobs.find(j => j.id === r.jobId), dev: r.deviceId ? state.devices.find(d => d.id === r.deviceId) : null }));
  const navBtn = (v, ico, label) => `<button class="${state.view === v ? 'active' : ''}" data-view="${v}"><span class="ico">${ico}</span>${label}</button>`;
  app.innerHTML = `<div class="shell"><aside class="side">
    <div class="brand"><div class="mark">ROS</div><div><b>MikroTik upgrader</b><small>správa RouterOS</small></div></div>
    <nav>${navBtn('devices', '▤', 'Zařízení')}${navBtn('jobs', '▶', 'Upgrady')}${navBtn('help', '?', 'Nápověda')}${navBtn('settings', '⚙', 'Nastavení')}${state.admin ? navBtn('admin', '🛠', 'Správa') : ''}</nav>
    <div class="versions">${latestBar()}</div>
    <div class="spacer"></div>
    <div class="runner-pill ${running ? 'live' : ''}" id="runnerpill">${running ? ownRuns.map(({ r, job, dev }) => `<div class="clickable" data-job="${r.jobId}"><span class="pulse"></span><b>job #${r.jobId}</b>${job ? ` ${esc(job.name).slice(0, 40)}` : ''}${dev ? `<br><span class="hint">${esc(devName(dev))}</span>` : ''}</div>`).join('') : 'žádný tvůj job neběží'}${(state.runner.others || []).length ? `<div class="hint" style="margin-top:6px;line-height:1.4">${state.runner.others.map(o => `<b>${esc(o.user || 'jiný uživatel')}</b>: ${o.jobs > 1 ? `${o.jobs} joby, ` : ''}upgrade ${o.total} zařízení${o.done ? `, hotovo ${o.done}` : ''}`).join('<br>')}</div>` : ''}</div>
    <label class="check advtoggle"><input type="checkbox" id="advtoggle" ${state.advanced ? 'checked' : ''}> Pokročilé zobrazení</label>
    ${state.auth.user ? `<div class="hint" style="padding:0 10px 4px">👤 ${esc(state.auth.user.name)}${state.admin ? ' <span class="chip">správce</span>' : ''}${state.auth.passwordLogin ? ' · <a href="#" id="chpw">heslo</a>' : ''}</div>` : ''}
    ${state.auth.serverStartedAt ? `<div class="hint" style="padding:0 10px 4px" title="${new Date(state.auth.serverStartedAt).toLocaleString('cs-CZ')}">⟳ server od ${new Date(state.auth.serverStartedAt).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}${state.auth.draining ? ' · <b>aktualizuje se</b>' : ''}</div>` : ''}
    ${state.auth.sourceIp ? `<div class="hint" style="padding:0 10px 4px" title="Z této adresy se server připojuje na routery přes SSH. Povol ji ve firewallu routerů a v IP → Services → ssh (Available From), případně ve výjimce brute-force ochrany SSH."><span class="copyip clickable" data-ip="${esc(state.auth.sourceIp)}">🔑 SSH z ${esc(state.auth.sourceIp)}</span></div>` : ''}
    <div class="foot"><button class="small" id="refreshver" title="obnovit verze z upgrade.mikrotik.com">↻ verze</button><button class="small" id="logout">Odhlásit</button></div>
  </aside><main id="main"></main></div>
  <div class="pagenav" id="pagenav" hidden><button type="button" id="gotop" title="na začátek stránky">↑</button><button type="button" id="gobottom" title="na konec stránky">↓</button></div>`;
  on('#gotop', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  on('#gobottom', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
  updatePageNav();
  app.querySelectorAll('nav button').forEach(b => b.onclick = () => { state.view = b.dataset.view; render(); });
  app.querySelectorAll('.copyip').forEach(el => el.onclick = () => { try { navigator.clipboard.writeText(el.dataset.ip); toast('IP zkopírována: ' + el.dataset.ip); } catch {} });
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); state.authed = false; render(); };
  $('#refreshver').onclick = async () => { state.latest = await api('/versions/refresh', { method: 'POST' }); toast('verze obnoveny'); render(); };
  document.querySelectorAll('#runnerpill [data-job]').forEach(el => el.onclick = () => openJob(+el.dataset.job));
  const cp = $('#chpw'); if (cp) cp.onclick = (e) => { e.preventDefault(); openModal({ type: 'password' }); };
  $('#advtoggle').onchange = (e) => { state.advanced = e.target.checked; try { localStorage.setItem('mtu_adv', state.advanced ? '1' : '0'); } catch {} render(); };
  const m = $('#main');
  if (state.view === 'devices') renderDevices(m);
  else if (state.view === 'jobs') renderJobs(m);
  else if (state.view === 'help') renderHelp(m);
  else if (state.view === 'admin' && state.admin) renderSettings(m, true);
  else renderSettings(m);
  m.insertAdjacentHTML('afterbegin', statsStrip());
  renderModal();
}
function latestBar() {
  const v = state.latest.versions || {};
  const row = (k, l) => { const x = v[k]; if (!x) return ''; const age = x.releasedAt ? Math.floor((Date.now() / 1000 - x.releasedAt) / 86400) : null; const fresh = age !== null && age < (state.settings.min_release_age_days || 0); return `<div title="${fresh ? 'mladší než limit v nastavení, upgrade blokován' : 'stáří vydání'}">${l} <b>${esc(x.version)}</b>${age !== null ? ` <span class="${fresh ? 'fresh' : ''}">${age} d</span>` : ''}</div>`; };
  return row('v7-stable', 'v7 stable') + row('v7-long-term', 'v7 long-term') + row('v6-long-term', 'v6 long-term') + (state.latest.error ? `<div class="b-err" title="${esc(state.latest.error)}">verze nedostupné</div>` : '');
}
const devName = (d) => d ? (d.name || d.identity || d.host) : '';
function parentCell(d) {
  const par = d.parent_id ? state.devices.find(x => x.id === d.parent_id) : null;
  const sp = d.suggested_parent;
  let html = par ? `<span title="nadřazený prvek">${esc(devName(par))}</span>` : '<span class="muted">—</span>';
  if (sp && sp.id && sp.id !== d.parent_id) html += ` <button class="small acceptp" data-id="${d.id}" data-pid="${sp.id}" title="detekováno: uplink ${esc(sp.via)} → ${esc(sp.identity || sp.address)}">⇡ ${esc(sp.name)}?</button>`;
  else if (sp && !sp.id && !par) html += ` <span class="muted" title="soused na uplinku ${esc(sp.via)} není v seznamu">(${esc(sp.identity || sp.address)})</span>`;
  return html;
}
function treeOrder(devs) {
  // hloubkové procházení: kořeny (bez rodiče, nebo rodič mimo výběr) → potomci; každý dostane depth a tree-značky
  const byId = new Map(devs.map(d => [d.id, d]));
  const kids = new Map();
  for (const d of devs) { const pid = d.parent_id && byId.has(d.parent_id) && d.parent_id !== d.id ? d.parent_id : 0; if (!kids.has(pid)) kids.set(pid, []); kids.get(pid).push(d); }
  const byName = (a, b) => a.priority - b.priority || devName(a).localeCompare(devName(b), 'cs', { numeric: true });
  const out = [], seen = new Set();
  const walk = (pid, depth, prefix) => {
    const list = (kids.get(pid) || []).sort(byName);
    list.forEach((d, i) => {
      if (seen.has(d.id)) return; seen.add(d.id);
      const last = i === list.length - 1;
      out.push({ ...d, _depth: depth, _prefix: prefix, _last: last, _kids: (kids.get(d.id) || []).length });
      walk(d.id, depth + 1, prefix + (depth === 0 ? '' : (last ? '   ' : '│  ')));
    });
  };
  walk(0, 0, '');
  for (const d of devs) if (!seen.has(d.id)) { seen.add(d.id); out.push({ ...d, _depth: 0, _prefix: '', _last: true, _kids: 0 }); } // cykly
  return out;
}
// filtr podle verze/stavu: vše / v6 / v7 / k upgradu / aktuální / nedostupné (sdílí ho seznam i hlavička s počty)
function vfInfo() {
  const vf = state.vf || '';
  const vfMatch = (d) => { if (!vf) return true; const v = String(d.version || ''); if (vf === 'v6') return v.startsWith('6.'); if (vf === 'v7') return v.startsWith('7.'); if (vf === 'need') return needsUpgrade(d); if (vf === 'ok') return plainStatus(d).cls === 'b-ok'; if (vf === 'bad') return !!d.scan_status && !['ok', 'never'].includes(d.scan_status); return true; };
  const base = state.devices.filter(d => (!state.owner || d.owner_id === state.owner) && (!state.group || d.group_name === state.group));
  const vfCounts = { v6: base.filter(d => String(d.version || '').startsWith('6.')).length, v7: base.filter(d => String(d.version || '').startsWith('7.')).length, need: base.filter(needsUpgrade).length, ok: base.filter(d => plainStatus(d).cls === 'b-ok').length, bad: base.filter(d => !!d.scan_status && !['ok', 'never'].includes(d.scan_status)).length };
  return { vf, vfMatch, base, vfCounts };
}
function filteredDevices() {
  const f = state.filter.toLowerCase();
  const { vfMatch } = vfInfo();
  let list = state.devices.filter(d => vfMatch(d) && (!state.owner || d.owner_id === state.owner) && (!state.group || d.group_name === state.group) && (!f || [d.host, d.name, d.identity, d.board_name, d.model, d.version, d.group_name, d.notes].join(' ').toLowerCase().includes(f)));
  const s = state.sort;
  if (s === 'tree') return treeOrder(list);
  const dir = state.sortDir === 'desc' ? -1 : 1;
  const ownerName = (d) => { const u = (state.users || []).find(x => x.id === d.owner_id); return u ? (u.userdb_nick || u.name) : ''; };
  const statusRank = (d) => { const ps = plainStatus(d); return ps.act === 'upgrade' ? 0 : ps.cls === 'b-err' ? 1 : ps.cls === 'b-ok' ? 3 : 2; };
  list.sort((a, b) => {
    let r = 0;
    if (s === 'version') r = cmpVer(a.version || '0.0', b.version || '0.0');
    else if (s === 'name') r = (a.name || a.identity || a.host).localeCompare(b.name || b.identity || b.host);
    else if (s === 'model') r = (a.board_name || '').localeCompare(b.board_name || '');
    else if (s === 'seen') r = (b.last_seen_at || 0) - (a.last_seen_at || 0);
    else if (s === 'status') r = statusRank(a) - statusRank(b) || plainStatus(a).txt.localeCompare(plainStatus(b).txt);
    else if (s === 'firmware') r = cmpVer(a.fw_current || '0.0', b.fw_current || '0.0');
    else if (s === 'track') r = (a.track || '').localeCompare(b.track || '');
    else if (s === 'owner') r = ownerName(a).localeCompare(ownerName(b));
    else if (s === 'host') r = a.host.localeCompare(b.host, undefined, { numeric: true });
    else r = a.priority - b.priority || (a.group_name || '').localeCompare(b.group_name || '');
    return (r * dir) || a.host.localeCompare(b.host, undefined, { numeric: true });
  });
  return list;
}
function statsStrip() {
  const s = state.stats; if (!s) return '';
  const tile = (n, label, cls = '') => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  return `<div class="stats" title="celá síť, všichni uživatelé">${tile(s.total, 'zařízení celkem')}${tile(s.upToDate, 'aktuální', 'ok')}${tile(s.needs, 'čeká na upgrade', s.needs ? 'warn' : '')}${tile(s.stayV6, 'zůstává na v6')}${tile(s.upgrading, 'právě se upgraduje', s.upgrading ? 'info' : '')}${tile(`${s.upgradedToday} / ${s.upgradedTotal}`, 'upgradováno dnes / celkem', 'ok')}${tile(s.unreachable, 'nedostupné', s.unreachable ? 'warn' : '')}${tile(s.dead, 'umřelo po upgradu', s.dead ? 'err' : '')}${tile(`${s.failedToday} / ${s.failedTotal}`, 'chyb dnes / celkem', s.failedToday ? 'err' : '')}${tile(s.jobsRunning, 'běžících jobů')}${tile(s.users, 'uživatelů')}</div>`;
}
function renderDevices(m) {
  const devs = state.devices;
  const adv = state.advanced;
  const cnt = { ok: 0, old: 0, v6: 0, unreachable: 0, hold: 0, unknown: 0, newer: 0 };
  for (const d of devs) { if (!d.managed) { cnt.hold++; continue; } if (d.scan_status !== 'ok' && d.scan_status !== 'never') { cnt.unreachable++; continue; } cnt[verStatus(d).key]++; }
  const groups = [...new Set(devs.map(d => d.group_name).filter(Boolean))].sort();
  const list = filteredDevices();
  const allSel = list.length && list.every(d => state.selected.has(d.id));
  const toUpgrade = devs.filter(d => needsUpgrade(d));
  const segs = [['ok', 'aktuální', 'var(--ok)'], ['old', 'čeká na upgrade', 'var(--warn)'], ['v6', 'v6, čeká na v7', 'var(--v6)'], ['unreachable', 'nedostupné', 'var(--err)'], ['hold', 'neupgradují se', 'var(--muted)'], ['unknown', 'nezkontrolované', 'var(--line2)']];
  const total = devs.length || 1;
  const running = state.runner.running;
  const { vf, base, vfCounts } = vfInfo();
  const th = (key, label) => `<th class="clickable sorth" data-sort="${key}" title="seřadit podle: ${label} (druhý klik obrátí pořadí)">${label}${state.sort === key ? (state.sortDir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`;
  m.innerHTML = `<h1>Zařízení</h1><div class="fleet"><div class="head"><div class="count">${devs.length}<small>zařízení ve správě</small></div>
      <div class="row">${toUpgrade.length ? `<button class="primary" id="upall">▶ Upgradovat vše potřebné (${toUpgrade.length})</button>` : `<span class="hint">${devs.length ? 'Všechna dostupná zařízení jsou aktuální.' : 'Začni přidáním zařízení.'}</span>`}</div></div>
    <div class="bar">${segs.map(([k, , c]) => `<span style="width:${cnt[k] / total * 100}%;background:${c}" title="${cnt[k]}"></span>`).join('')}</div>
    <div class="legend">${segs.filter(([k]) => cnt[k]).map(([k, l, c]) => `<span><i class="sw" style="background:${c}"></i>${l} <b>${cnt[k]}</b></span>`).join('')}</div></div>
  <div class="panel"><div class="toolbar">
    <button id="discover">+ Přidat zařízení (sken)</button>
    <button id="scanall">⟳ Zkontrolovat stav</button>
    ${adv ? `<button id="scansel" ${state.selected.size ? '' : 'disabled'}>⟳ Zkontrolovat vybrané (${state.selected.size})</button>
    <button id="acceptparents" title="u zařízení bez nadřazeného prvku nastaví toho, koho vidí jako souseda na uplinku">⇡ Přebrat detekované rodiče</button>` : ''}
    <button class="ok" id="jobsel" ${state.selected.size ? '' : 'disabled'}>▶ Upgradovat vybrané (${state.selected.size})</button>
    ${state.admin && state.users && state.users.length > 1 ? `<button id="movesel" ${state.selected.size ? '' : 'disabled'} title="předat vybraná zařízení jinému uživateli">⇄ Přesunout vybrané (${state.selected.size})</button>` : ''}
    <button class="danger" id="delsel" ${state.selected.size ? '' : 'disabled'} title="smaže vybraná zařízení z evidence včetně historie a záloh (vlastní; správce jakákoli)">✕ Smazat vybrané (${state.selected.size})</button>
    <span class="spacer"></span>
    ${state.admin && state.users && state.users.length > 1 ? `<select id="ownerf" title="zobrazit zařízení jednoho uživatele"><option value="0" ${!state.owner ? 'selected' : ''}>všichni vlastníci</option>${state.users.map(u => `<option value="${u.id}" ${u.id === state.owner ? 'selected' : ''}>${esc(u.name)} (${state.devices.filter(d => d.owner_id === u.id).length})</option>`).join('')}</select>` : ''}
    <select id="vfilter" title="filtr podle verze a stavu"><option value="" ${!vf ? 'selected' : ''}>zobrazit vše (${base.length})</option><option value="need" ${vf === 'need' ? 'selected' : ''}>k upgradu (${vfCounts.need})</option><option value="v6" ${vf === 'v6' ? 'selected' : ''}>na v6 (${vfCounts.v6})</option><option value="v7" ${vf === 'v7' ? 'selected' : ''}>na v7 (${vfCounts.v7})</option><option value="ok" ${vf === 'ok' ? 'selected' : ''}>aktuální (${vfCounts.ok})</option><option value="bad" ${vf === 'bad' ? 'selected' : ''}>nedostupné / chyba (${vfCounts.bad})</option></select>
    ${groups.length ? `<select id="group"><option value="">všechny skupiny</option>${groups.map(g => `<option ${g === state.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}
    <select id="sort"><option value="tree" ${state.sort === 'tree' ? 'selected' : ''}>řadit: strom (topologie)</option><option value="priority" ${state.sort === 'priority' ? 'selected' : ''}>priorita</option><option value="name" ${state.sort === 'name' ? 'selected' : ''}>název</option><option value="version" ${state.sort === 'version' ? 'selected' : ''}>verze</option><option value="model" ${state.sort === 'model' ? 'selected' : ''}>model</option><option value="seen" ${state.sort === 'seen' ? 'selected' : ''}>naposledy viděno</option><option value="status" ${state.sort === 'status' ? 'selected' : ''}>stav</option><option value="firmware" ${state.sort === 'firmware' ? 'selected' : ''}>firmware</option><option value="host" ${state.sort === 'host' ? 'selected' : ''}>IP adresa</option></select>
    <input id="filter" placeholder="hledat…" value="${esc(state.filter)}" style="width:170px"></div>
  <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="selall" ${allSel ? 'checked' : ''}></th>${th('name', 'Zařízení')}${th('model', 'Model')}${th('version', 'RouterOS')}${th('status', 'Stav')}${adv ? th('firmware', 'Firmware') + '<th>Flash · RAM volné</th><th>Nadřazený</th>' + th('track', 'Track') + '<th>Sken</th>' + (state.admin && state.users ? th('owner', 'Vlastník') : '') : ''}<th></th></tr></thead><tbody>
  ${list.map(d => { const ps = plainStatus(d); const sc = STATUS_LABEL[d.scan_status] || ['b-muted', d.scan_status]; const scanning = state.scanning.includes(d.id); const busy = (state.runner.busy || []).includes(d.id);
    return `<tr class="${state.selected.has(d.id) ? 'selected' : ''} ${d.enabled ? '' : 'muted'} ${state.sort === 'tree' && d._depth === 0 && d._kids ? 'root-row' : ''}" data-id="${d.id}">
    <td><input type="checkbox" class="sel" data-id="${d.id}" ${state.selected.has(d.id) ? 'checked' : ''}></td>
    <td class="clickable detail name" data-id="${d.id}">${d._depth > 0 ? `<span class="tree mono">${esc(d._prefix)}${d._last ? '└─' : '├─'}</span>` : ''}${d._depth === 0 && d._kids ? '<span class="rootmark" title="hlavní prvek — napájí/připojuje podřízené">▣</span>' : ''}<b>${esc(d.name || d.identity || d.host)}</b>${d._kids ? ` <span class="muted" title="počet přímo podřízených">(${d._kids})</span>` : ''}${busy ? ' <span class="badge b-info">právě se upgraduje</span>' : ''}${d.enabled ? '' : ' <span class="badge b-muted">vypnuto</span>'}${d.track === 'v6-long-term' ? ' <span class="chip" title="zůstává na v6, na sedmičku se neupgraduje">zůstává na v6</span>' : trackOf(d) === 'v6-long-term' ? ` <span class="chip" title="hardware bez v7 (${esc((d.no_v7 || [''])[0].split(':')[0])}) — cíl je poslední v6; v7 jde povolit tužkou u zařízení">zůstává na v6 (HW)</span>` : d.track === 'hold' ? ' <span class="chip" title="nikdy neupgradovat">hold</span>' : ''}${d.userdb_member ? ` <span class="chip" title="zařízení člena (userdb uživatel ${d.userdb_member}) pod APčkem ${esc(d.userdb_ap)}">člen</span>` : ''}${d.parent_foreign ? ` <span class="chip" title="nadřazený prvek patří jinému uživateli — pořadí i zámky se hlídají i přes hranici účtů">pod: ${esc(d.parent_foreign.name)}${d.parent_foreign.user ? ` (${esc(d.parent_foreign.user)})` : ''}</span>` : ''}${d.dup_of ? ` <span class="chip" title="stejné sériové číslo jako ${esc((state.devices.find(x => x.id === d.dup_of) || {}).host || '#' + d.dup_of)} — jeden fyzický kus pod více IP, upgraduje se jen hlavní záznam">stejný kus jako ${esc((state.devices.find(x => x.id === d.dup_of) || {}).name || (state.devices.find(x => x.id === d.dup_of) || {}).host || '#' + d.dup_of)}</span>` : ''}<span class="sub"><span class="mono">${esc(d.host)}${d.port !== 22 ? ':' + d.port : ''}</span>${d.group_name ? ` · ${esc(d.group_name)}` : ''}${d.name && d.identity && d.name !== d.identity ? ` · ${esc(d.identity)}` : ''}</span></td>
    <td>${esc(d.board_name || d.model)}${adv && d.arch ? `<span class="sub">${esc(d.arch)}</span>` : ''}</td>
    <td class="mono"><b>${esc(d.version || '—')}</b>${adv && d.channel ? ` <span class="muted">${esc(d.channel)}</span>` : ''}${adv && d.uptime_sec ? `<span class="sub" title="uptime">${upt(d.uptime_sec)}</span>` : ''}</td>
    <td>${scanning ? '<span class="badge b-info">kontroluji…</span>' : `<span class="badge ${ps.cls}" title="${esc(d.scan_error || '')}">${esc(ps.txt)}</span>`}</td>
    ${adv ? `<td class="mono">${esc(d.fw_current || '—')}${d.fw_upgrade && d.fw_current !== d.fw_upgrade ? ` <span class="badge b-warn" title="k dispozici ${esc(d.fw_upgrade)}">→${esc(d.fw_upgrade)}</span>` : ''}</td>
    <td>${d.total_hdd ? `<span title="flash volné / celkem">${mb(d.free_hdd)}/${mb(d.total_hdd)}</span>${d.flags && d.flags.flash_dir ? '<span class="muted" title="kořen FS v RAM, adresář flash">ᶠ</span>' : ''} <span class="muted">·</span> <span title="RAM volná / celkem">${mb(d.free_mem)}/${mb(d.total_mem)}</span> <span class="muted">MB</span>` : '—'}</td>
    <td class="parent">${parentCell(d)}</td>
    <td>${d.managed ? `<select class="track small" data-id="${d.id}">${state.tracks.map(t => `<option value="${t}" ${t === d.track ? 'selected' : ''}>${t.replace('long-term', 'LT')}</option>`).join('')}</select>` : '<span class="badge b-muted">neřízený</span>'}</td>
    <td>${!d.managed ? '<span class="muted">—</span>' : `<span class="badge ${sc[0]}" title="${esc(d.scan_error)}">${esc(sc[1])}</span> <span class="muted" title="naposledy viděno ${fmtTs(d.last_seen_at)}">${ago(d.last_seen_at)}</span>`}</td>${state.admin && state.users ? `<td class="muted">${esc((state.users.find(u => u.id === d.owner_id) || {}).name || '—')}</td>` : ''}` : ''}
    <td class="acts">${ps.act === 'upgrade' && !busy ? `<button class="small ok up1" data-id="${d.id}">▶ Upgradovat</button>` : ''} ${ps.act === 'scan' ? `<button class="small scan1" data-id="${d.id}">⟳ Zkontrolovat</button>` : adv ? `<button class="small scan1" data-id="${d.id}" title="zkontrolovat">⟳</button>` : ''} <button class="small edit1" data-id="${d.id}" title="upravit">✎</button></td></tr>`; }).join('')}
  ${list.length ? '' : `<tr><td colspan="${adv ? 11 : 6}" class="empty">Zatím žádná zařízení. Přidej je skenem: zadáš IP adresy nebo rozsahy a loginy, nalezené routery se založí samy.</td></tr>`}
  </tbody></table></div></div>`;
  on('#discover', () => openModal({ type: 'discover' }));
  on('#scanall', async () => { await api('/scan', { method: 'POST', body: {} }); toast('kontrola všech zařízení spuštěna'); });
  on('#scansel', async () => { await api('/scan', { method: 'POST', body: { ids: [...state.selected] } }); toast('kontrola spuštěna'); });
  on('#jobsel', () => openModal({ type: 'newjob', ids: [...state.selected] }));
  on('#upall', () => openModal({ type: 'newjob', ids: toUpgrade.map(d => d.id) }));
  on('#acceptparents', async () => { try { const r = await api('/devices/accept-parents', { method: 'POST', body: {} }); toast(`nastaveno ${r.updated} nadřazených prvků`); await loadState(); render(); } catch (e) { toast(e.message, true); } });
  on('#delsel', async () => {
    const ids = [...state.selected];
    const names = ids.map(id => state.devices.find(d => d.id === id)).filter(Boolean).map(d => devName(d) + ' (' + d.host + ')');
    if (!confirm(`Smazat ${ids.length} zařízení ze seznamu včetně historie a evidence záloh?\n\n${names.slice(0, 15).join('\n')}${names.length > 15 ? `\n… a dalších ${names.length - 15}` : ''}`)) return;
    try { const r = await api('/devices/bulk-delete', { method: 'POST', body: { ids } }); state.selected.clear(); toast(`smazáno ${r.deleted}${r.skipped.length ? `, přeskočeno: ${r.skipped.join('; ')}` : ''}`, r.skipped.length > 0); await loadState(); render(); } catch (e) { toast(e.message, true); }
  });
  m.querySelectorAll('.acceptp').forEach(b => b.onclick = async () => { try { await api(`/devices/${b.dataset.id}`, { method: 'PUT', body: { parent_id: +b.dataset.pid } }); await loadState(); render(); } catch (e) { toast(e.message, true); } });
  const g = $('#group'); if (g) g.onchange = (e) => { state.group = e.target.value; render(); };
  const vfs = $('#vfilter'); if (vfs) vfs.onchange = (e) => { state.vf = e.target.value; state.selected.clear(); try { localStorage.setItem('mtu_vf', state.vf); } catch {} render(); };
  const of = $('#ownerf'); if (of) of.onchange = (e) => { state.owner = +e.target.value; try { localStorage.setItem('mtu_owner', String(state.owner)); } catch {} state.selected.clear(); render(); };
  const mv = $('#movesel'); if (mv) mv.onclick = () => openModal({ type: 'move', ids: [...state.selected] });
  $('#sort').onchange = (e) => { state.sort = e.target.value; state.sortDir = 'asc'; try { localStorage.setItem('mtu_sort', state.sort + ':asc'); } catch {} render(); };
  m.querySelectorAll('th.sorth').forEach(h => h.onclick = () => { const k = h.dataset.sort; if (state.sort === k) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc'; else { state.sort = k; state.sortDir = 'asc'; } try { localStorage.setItem('mtu_sort', state.sort + ':' + state.sortDir); } catch {} render(); });
  $('#filter').oninput = (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; render(); const f = $('#filter'); f.focus(); f.setSelectionRange(pos, pos); };
  $('#selall').onchange = (e) => { for (const d of list) e.target.checked ? state.selected.add(d.id) : state.selected.delete(d.id); render(); };
  m.querySelectorAll('.sel').forEach(c => c.onchange = (e) => { const id = +c.dataset.id; e.target.checked ? state.selected.add(id) : state.selected.delete(id); render(); });
  m.querySelectorAll('.detail').forEach(c => c.onclick = () => openDetail(+c.dataset.id));
  m.querySelectorAll('.up1').forEach(b => b.onclick = () => openModal({ type: 'newjob', ids: [+b.dataset.id] }));
  m.querySelectorAll('.scan1').forEach(b => b.onclick = async () => { b.disabled = true; state.scanning.push(+b.dataset.id); render(); try { const r = await api(`/devices/${b.dataset.id}/scan`, { method: 'POST' }); if (r.skipped) toast(r.skipped, true); else if (!r.ok) toast('kontrola selhala: ' + r.error, true); } catch (e) { toast(e.message, true); } state.scanning = state.scanning.filter(x => x !== +b.dataset.id); });
  m.querySelectorAll('.edit1').forEach(b => b.onclick = () => openModal({ type: 'edit', id: +b.dataset.id }));
  m.querySelectorAll('.track').forEach(s => s.onchange = async () => { try { await api(`/devices/${s.dataset.id}`, { method: 'PUT', body: { track: s.value } }); toast('track uložen'); } catch (e) { toast(e.message, true); } });
}

const JOB_PLAIN = { queued: 'připraven ke spuštění', running: 'probíhá', paused: 'zastaven', waiting: 'čeká na potvrzení', scheduled: 'naplánován', 'waiting-window': 'čeká na servisní okno', done: 'hotovo', cancelled: 'zrušen' };
/** štítek jobu: „hotovo" jen když všechno prošlo; jinak s chybou / s výhradami / nic neprovedeno */
/** skutečný stav běžícího/pozastaveného jobu podle rozpracované položky a poznámky (pro přehled) */
function jobLiveState(j) {
  const cur = j.current, step = (cur && cur.step) || '', note = j.status_note || '';
  if (j.status === 'running') {
    if (/předběžná kontrola/.test(note) && !cur) return ['b-info', 'kontrola zařízení'];
    if (!cur) return ['b-info', /pauza/i.test(note) ? 'pauza mezi zařízeními' : 'probíhá'];
    if (/čekám na cizí/i.test(step)) return ['b-warn', 'čeká na cizí upgrade (zámek)'];
    if (/čekám na potomky|potomk/i.test(step)) return ['b-warn', 'čeká na potomky'];
    if (/čekám na uptime/i.test(step)) return ['b-warn', 'čeká na uptime'];
    if (/čekám na návrat/i.test(step)) return ['b-info', 'restart, čeká na návrat'];
    if (/čekám na spoje|spoj/i.test(step) && cur.status === 'verify') return ['b-info', 'čeká na obnovení spojů'];
    return ['b-info', { checking: 'kontrola', backup: 'záloha', upload: 'nahrává balíčky', reboot: 'restart', verify: 'ověřuje po restartu', firmware: 'firmware RouterBOOT', running: 'probíhá' }[cur.status] || 'probíhá'];
  }
  if (j.status === 'paused') {
    if (/aktualizace serveru/.test(note)) return ['b-warn', 'pozastaven: aktualizace serveru'];
    if (/uživatelem/.test(note)) return ['b-muted', 'zastaven uživatelem'];
    if (/restartován/.test(note)) return ['b-err', 'přerušen restartem serveru'];
    if (/interní chyba/.test(note)) return ['b-err', 'interní chyba'];
    return ['b-err', 'zastaven po chybě'];
  }
  if (j.status === 'queued') return ['b-muted', /restart/.test(note) ? 'čeká na restart serveru' : /aktualizaci/.test(note) ? 'pokračuje po aktualizaci' : 'čeká na spuštění'];
  return null;
}
function jobBadge(j) {
  const c = j.counts || {};
  const live = jobLiveState(j); if (live) return `<span class="badge ${live[0]}" title="${esc(j.status_note || '')}">${live[1]}</span>`;
  if (j.status === 'scheduled') { const ep = j.options && j.options.early_precheck; if (ep && ep.blocked) return `<span class="badge b-err" title="předběžná kontrola: ${ep.blocked} zařízení se přeskočí">naplánován, ${ep.blocked} k opravě</span>`; if (ep && ep.warned) return '<span class="badge b-warn">naplánován, upozornění</span>'; if (ep) return '<span class="badge b-ok">naplánován, zkontrolováno</span>'; }
  if (j.status !== 'done') return badge(JOB_LABEL, j.status);
  if (c.failed || c.unknown) return '<span class="badge b-err">skončilo s chybou</span>';
  if ((c.blocked || 0) + (c.skipped || 0) > 0) return c.done ? '<span class="badge b-warn">hotovo s výhradami</span>' : '<span class="badge b-err">nic neprovedeno</span>';
  return badge(JOB_LABEL, 'done');
}
function renderJobs(m) {
  const cur = state.job;
  const adv = state.advanced;
  // aktivní joby (běžící, čekající, pozastavené, naplánované) vždy nahoře a vždy zobrazené; hotové/zrušené pod nimi podle data
  const ACTIVE_JOB = ['running', 'waiting', 'waiting-window', 'queued', 'scheduled', 'paused'];
  const rank = (j) => ({ running: 0, waiting: 1, 'waiting-window': 1, queued: 2, scheduled: 3, paused: 4 })[j.status] ?? 9;
  const active = state.jobs.filter(j => ACTIVE_JOB.includes(j.status)).sort((a, b) => rank(a) - rank(b) || b.id - a.id);
  const finished = state.jobs.filter(j => !ACTIVE_JOB.includes(j.status));
  const shown = [...active, ...(state.jobsAll ? finished : finished.slice(0, Math.max(0, 10 - active.length)))];
  m.innerHTML = `<h1>Upgrady</h1><div class="stack"><div class="panel"><h2>Přehled <span class="muted" style="font-weight:400;font-size:12px">${state.jobsAll ? `všech ${state.jobs.length}` : `posledních ${shown.length}`}</span>${state.jobs.length > 10 || state.jobsAll ? ` <button class="small" id="jobsall" style="margin-left:8px">${state.jobsAll ? 'jen posledních 10' : `zobrazit všechny (${state.jobs.length}${state.jobs.length >= 30 ? '+' : ''})`}</button>` : ''}</h2><div class="tablewrap"><table><thead><tr>${adv ? '<th>#</th>' : ''}<th>Název</th><th>Stav</th><th>Průběh</th><th>Vytvořen</th><th></th></tr></thead><tbody>
    ${shown.map((j, i) => { const c = j.counts || {}; const done = (c.done || 0) + (c.failed || 0) + (c.blocked || 0) + (c.skipped || 0) + (c.unknown || 0);
      void i;
      return `<tr class="clickable ${cur && cur.job.id === j.id ? 'selected' : ''}" data-id="${j.id}">${adv ? `<td>${j.id}</td>` : ''}<td>${esc(j.name)}${state.admin && j.owner_name ? ` <span class="chip" title="vlastník">${esc(j.owner_name)}</span>` : ''}${j.options.dry_run ? ' <span class="badge b-info">jen kontrola</span>' : ''}${j.options.op ? ' <span class="badge b-muted">operace</span>' : ''}</td><td>${jobBadge(j)}${j.current ? `<div class="muted" style="font-size:11px;white-space:normal">${esc(j.current.dev)}${j.current.step ? ` — ${esc(j.current.step)}` : ''}</div>` : ''}${(c.blocked || 0) && j.status !== 'done' ? `<div class="muted" style="font-size:11px">${c.blocked} přeskočeno (blokováno)</div>` : ''}${adv && j.status_note && !j.current ? `<div class="muted" style="font-size:11px;white-space:normal">${esc(j.status_note)}</div>` : ''}</td>
      <td>${done}/${j.total} <span class="muted">(${c.done || 0} ok${c.failed ? `, <span style="color:var(--err)">${c.failed} chyb</span>` : ''}${c.blocked ? `, ${c.blocked} přeskočeno` : ''})</span><div class="progress"><div style="width:${j.total ? done / j.total * 100 : 0}%"></div></div></td><td>${fmtTs(j.created_at)}</td>
      <td>${['queued', 'paused'].includes(j.status) ? `<button class="small ok jstart" data-id="${j.id}">▶ Spustit</button>` : ''} ${j.status === 'waiting' ? `<button class="small ok jcont" data-id="${j.id}">Pokračovat</button>` : ''} ${!['running'].includes(j.status) ? `<button class="small danger jdel" data-id="${j.id}" title="smazat">✕</button>` : ''}</td></tr>`; }).join('')}
    ${state.jobs.length ? '' : '<tr><td colspan="6" class="empty">Zatím žádný upgrade. V seznamu zařízení klikni na „Upgradovat vše potřebné" nebo na „Upgradovat" u zařízení.</td></tr>'}</tbody></table></div></div>
  <div id="jobdetail">${cur ? '' : '<div class="panel empty">Klikni na upgrade v přehledu, zobrazí se průběh.</div>'}</div></div>`;
  m.querySelectorAll('tr[data-id]').forEach(r => r.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; openJob(+r.dataset.id); });
  const ja = $('#jobsall'); if (ja) ja.onclick = async () => { if (state.jobsAll) { state.jobsAll = false; await loadState(); } else { try { state.jobs = await api('/jobs'); state.jobsAll = true; } catch (e) { return toast(e.message, true); } } render(); };
  m.querySelectorAll('.jstart').forEach(b => b.onclick = () => jobAction(+b.dataset.id, 'start'));
  m.querySelectorAll('.jcont').forEach(b => b.onclick = () => jobAction(+b.dataset.id, 'continue'));
  m.querySelectorAll('.jdel').forEach(b => b.onclick = async () => { if (!confirm(`Smazat záznam „${(state.jobs.find(j => j.id === +b.dataset.id) || {}).name}" včetně logu?`)) return; try { await api(`/jobs/${b.dataset.id}`, { method: 'DELETE' }); if (cur && cur.job.id === +b.dataset.id) state.job = null; await loadState(); render(); } catch (e) { toast(e.message, true); } });
  if (cur) renderJobDetail();
}
async function jobAction(id, a) { try { const r = await api(`/jobs/${id}/${a}`, { method: 'POST' }); if (r && r.queued) toast(`zařazeno do fronty, spustí se po dokončení jobu #${r.behind}`); await loadState(); render(); } catch (e) { toast(e.message, true); } }
function jobBanner(job, items) {
  const o = job.options || {};
  const rs = (state.runner.jobs || []).find(r => r.jobId === job.id) || null;
  const cur = rs ? items.find(i => i.id === rs.itemId) : null;
  const c = { done: 0, failed: 0, blocked: 0, skipped: 0, unknown: 0, pending: 0 };
  for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
  const sum = `${c.done} v pořádku${c.blocked ? `, ${c.blocked} přeskočeno (nesplněná podmínka)` : ''}${c.skipped ? `, ${c.skipped} vynecháno` : ''}${c.failed || c.unknown ? `, <b style="color:var(--err)">${(c.failed || 0) + (c.unknown || 0)} s chybou</b>` : ''}`;
  if (job.status === 'running') return { cls: 'info', html: `<b>Probíhá${o.dry_run || /kontrola/.test(job.status_note || '') ? ' kontrola' : ' upgrade'}.</b> ${cur ? `Teď: <b>${esc(cur.dev_name || cur.identity || cur.host)}</b> — ${esc(cur.step || 'připojení')}.` : ''} Zbývá ${c.pending || 0}. Stránku můžeš zavřít, běží to na serveru.` };
  if (job.status === 'waiting' && /^kontrola hotová/.test(job.status_note || '')) return { cls: 'warn', html: `<b>Kontrola hotová, upgrade ještě nezačal.</b> ${esc(job.status_note.replace(/^kontrola hotová: /, '').replace(/ — .*$/, ''))}. Projdi řádky s „přeskočí se" a upozorněními níže. Klikni <b>Pokračovat</b>, upgrade pojede jen na připravených zařízeních. Každé trvá obvykle 3–10 minut.` };
  if (job.status === 'waiting') return { cls: 'warn', html: `<b>Čeká na tebe.</b> První kus od každého modelu je hotový. Ověř, že fungují, a klikni <b>Pokračovat</b>.` };
  if (job.status === 'scheduled') {
    const ep = o.early_precheck;
    const head = `<b>Naplánováno na ${o.start_at ? new Date(o.start_at * 1000).toLocaleString('cs-CZ') : '?'}.</b> Spustí se samo; když bude v tu chvíli běžet jiný upgrade na stejných zařízeních, počká.`;
    if (!ep) return { cls: 'info', html: `${head} ${/předběžná kontrola/.test(job.status_note || '') ? '<br>⏳ Právě běží předběžná kontrola, výsledek se objeví tady a v logu.' : ''}` };
    const list = (arr, cls) => arr.length ? `<ul class="plain blocklist" style="margin:4px 0 0 0">${arr.map(x => `<li class="${cls}">${esc(x)}</li>`).join('')}</ul>` : '';
    if (ep.blocked) return { cls: 'err', html: `${head}<br><b>Předběžná kontrola (${fmtTs(Math.floor(ep.at / 1000))}): ${ep.blocked} zařízení by se přeskočilo.</b> Oprav to za dne, kontrola se před startem zopakuje.${list(ep.reasons || [], '')}${ep.warns && ep.warns.length ? `<div style="margin-top:6px">Upozornění (nebrání):</div>${list(ep.warns, 'muted')}` : ''}` };
    if (ep.warned) return { cls: 'warn', html: `${head}<br><b>Předběžná kontrola (${fmtTs(Math.floor(ep.at / 1000))}): vše připraveno, ${ep.warned} s upozorněním.</b>${list(ep.warns || [], 'muted')}` };
    return { cls: 'info', html: `${head}<br>✔ Předběžná kontrola (${fmtTs(Math.floor(ep.at / 1000))}): ${ep.ready} zařízení připraveno, nic nebrání.` };
  }
  if (job.status === 'waiting-window') return { cls: 'info', html: `<b>Čeká na servisní okno</b> ${esc(o.window)}. Spustí se samo.` };
  if (job.status === 'paused') return { cls: 'err', html: `<b>Zastaveno.</b> ${esc(job.status_note)}<br><span class="hint">Podívej se na řádek s chybou níže. Když je zařízení v pořádku, klikni <b>Pokračovat</b> (chybná položka se přeskočí), nebo ji dej <b>znovu</b>.</span>` };
  if (job.status === 'done') {
    const bad = (c.failed || 0) + (c.unknown || 0), skipped = (c.blocked || 0) + (c.skipped || 0);
    const cls = bad ? 'err' : skipped ? (c.done ? 'warn' : 'err') : 'ok';
    const head = bad ? 'Skončilo s chybou.' : skipped ? (c.done ? 'Hotovo s výhradami.' : 'Nic se neprovedlo.') : 'Hotovo.';
    return { cls, html: `<b>${head}</b> ${sum}.${skipped && !bad ? ' Přeskočená zařízení mají důvod u řádku; po nápravě dej u položky <b>znovu</b>.' : ''}${o.dry_run ? ' Byla to jen kontrola, nic se nezměnilo. Pokud je vše zelené, spusť to samé ostře.' : ''}` };
  }
  if (job.status === 'cancelled') return { cls: 'muted', html: `<b>Zrušeno.</b> ${sum}.` };
  return { cls: 'muted', html: `<b>Připraveno.</b> ${items.length} zařízení, klikni <b>Spustit</b>.` };
}
/** filtr logu podle zařízení (select nad logem): skryje řádky jiných zařízení, řádky jobu (bez zařízení) zůstávají */
function applyLogDevFilter() { const l = $('#joblog'); if (!l) return; const d = +l.dataset.dev || 0; l.querySelectorAll('div[data-dev]').forEach(x => { x.classList.toggle('od', !!d && +x.dataset.dev !== 0 && +x.dataset.dev !== d); }); }
function renderJobDetail() {
  const el = $('#jobdetail'); if (!el || !state.job) return;
  const { job, items } = state.job;
  const o = job.options || {};
  const adv = state.advanced;
  const rs = (state.runner.jobs || []).find(r => r.jobId === job.id) || null;
  const isCur = !!rs;
  const atBottom = LOGFOLLOW; // sledovat konec logu jen když u něj uživatel opravdu je (viz posluchač scroll); dřív se při překreslení bez #joblog bralo „jsi dole“ a stránka skákala na konec
  const prevLog = document.querySelector('details.logbox');
  if (prevLog) state.logOpen = prevLog.open; // pamatovat rozbalení logu přes překreslení
  const logOpen = state.logOpen === undefined ? true : state.logOpen; // podrobný log vždy otevřený, roste s obsahem
  const bn = jobBanner(job, items);
  const doneN = items.filter(i => !['pending'].includes(i.status) && !ACTIVE.has(i.status)).length;
  el.innerHTML = `<div class="panel"><h2>${esc(job.name)} ${jobBadge({ ...job, counts: Object.fromEntries(['done', 'failed', 'unknown', 'blocked', 'skipped'].map(k => [k, items.filter(i => i.status === k).length])) })}</h2>
    <div class="banner ${bn.cls}">${bn.html}</div>
    <div class="progress big"><div style="width:${items.length ? doneN / items.length * 100 : 0}%"></div></div>
    ${adv ? `<div class="row" style="margin:8px 0"><span class="badge ${o.dry_run ? 'b-info' : 'b-warn'}">${o.dry_run ? 'JEN KONTROLA' : 'OSTRÝ BĚH'}</span> <span class="badge b-muted">režim ${esc(o.mode || 'upload')}</span> ${o.firmware ? '<span class="badge b-muted">+ firmware</span>' : ''} ${o.canary ? '<span class="badge b-muted">kanárci</span>' : ''} ${o.device_mode ? '<span class="badge b-muted">device-mode</span>' : ''} ${o.window ? `<span class="badge b-muted">okno ${esc(o.window)}</span>` : ''} ${o.stop_on_failure ? '<span class="badge b-muted">stop při chybě</span>' : '<span class="badge b-warn">NEzastavit při chybě</span>'}</div>` : ''}
    <div class="row" style="margin:10px 0">
      ${['queued', 'paused'].includes(job.status) && !isCur ? `<button class="ok" id="jb-start">▶ ${job.status === 'paused' ? 'Pokračovat' : 'Spustit'}</button>` : ''}
      ${job.status === 'waiting' && !isCur ? `<button class="ok" id="jb-cont">▶ Pokračovat</button>` : ''}
      ${job.status === 'scheduled' && !isCur ? `<button id="jb-precheck" title="znovu ověří, co by v době startu bránilo upgradu">🔍 Zkontrolovat teď</button>` : ''}
      ${isCur ? `<button id="jb-pause" ${rs.pauseRequested ? 'disabled' : ''}>⏸ Zastavit po aktuálním zařízení</button><button id="jb-skip">⏭ Přeskočit aktuální</button><button class="danger" id="jb-cancel">■ Zrušit</button>` : ''}
      ${!['done', 'cancelled'].includes(job.status) && !isCur ? `<button class="danger" id="jb-cancel2">■ Zrušit</button>` : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Zařízení</th><th>Stav</th>${adv ? '<th>Krok</th>' : ''}<th>Verze</th>${adv ? '<th>Firmware</th>' : ''}<th>Poznámka</th><th></th></tr></thead><tbody>
    ${items.map((it, i) => `<tr><td>${i + 1}${it.plan && it.plan.canary ? ' 🐤' : ''}</td><td class="clickable detail" data-id="${it.device_id}"><b>${esc(it.dev_name || it.identity || it.host)}</b><div class="muted mono" style="font-size:11px">${esc(it.host)} · ${esc(it.board_name)}</div></td><td>${badge(ITEM_LABEL, it.status)}${!adv && (ACTIVE.has(it.status) || it.status === 'pending') && it.step ? `<div class="${/^přeskočí/.test(it.step) ? 'b-warn' : 'muted'}" style="font-size:11px;white-space:normal;max-width:260px">${esc(it.step)}</div>` : ''}</td>${adv ? `<td style="white-space:normal">${esc(it.step)}</td>` : ''}
      <td class="mono">${esc(it.from_version || it.dev_version || '')}${it.to_version && it.to_version !== it.from_version ? ` → <b>${esc(it.to_version)}</b>` : ''}</td>${adv ? `<td class="mono">${esc(it.from_fw || '')}${it.to_fw && it.to_fw !== it.from_fw ? ` → ${esc(it.to_fw)}` : ''}</td>` : ''}
      <td style="white-space:normal;max-width:${adv ? 420 : 520}px">${it.error ? `<span style="color:var(--err)" title="${esc(it.error)}">${esc(adv ? it.error : shortReason(it.error))}</span>` : ''}${(it.warnings || []).length ? (adv ? it.warnings.map(w => `<div style="color:var(--warn);font-size:12px">⚠ ${esc(w)}</div>`).join('') : `<details class="warns"><summary>⚠ ${it.warnings.length} upozornění</summary>${it.warnings.map(w => `<div style="color:var(--warn);font-size:12px">${esc(w)}</div>`).join('')}</details>`) : ''}</td>
      <td>${['pending'].includes(it.status) && !(rs && rs.itemId === it.id) ? `<button class="small iskip" data-id="${it.id}">přeskočit</button>` : ''} ${['failed', 'blocked', 'skipped', 'unknown', 'done'].includes(it.status) && !isCur ? `<button class="small iretry" data-id="${it.id}">znovu</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <details class="logbox" ${logOpen ? 'open' : ''}><summary>Podrobný log</summary>
      <div class="row logtools"><label class="check"><input type="checkbox" id="logimp" ${LOGIMP ? 'checked' : ''}> jen důležité (varování, chyby, začátek a výsledek zařízení)</label>
        <select id="logdev" title="jen řádky jednoho zařízení"><option value="0">všechna zařízení</option>${items.map(it => `<option value="${it.device_id}" ${state.logDev === it.device_id ? 'selected' : ''}>${esc(it.dev_name || it.identity || it.host)} · ${esc(it.host)}</option>`).join('')}</select></div>
      <div class="log ${LOGIMP ? 'imp' : ''}" id="joblog" data-dev="${state.logDev || 0}">${(() => { const nm = logNames(items); return state.jobLog.map(l => logLine(l, nm)).join(''); })()}</div></details></div>`;
  document.querySelector('details.logbox').ontoggle = (e) => { state.logOpen = e.target.open; };
  applyLogDevFilter();
  { const li = $('#logimp'); if (li) li.onchange = (e) => { LOGIMP = e.target.checked; try { localStorage.setItem('mtu_logimp', LOGIMP ? '1' : '0'); } catch {} $('#joblog').classList.toggle('imp', LOGIMP); }; }
  { const ld = $('#logdev'); if (ld) ld.onchange = (e) => { state.logDev = +e.target.value || 0; $('#joblog').dataset.dev = state.logDev; applyLogDevFilter(); }; }
  if (atBottom && state.jobLog.length) window.scrollTo(0, document.documentElement.scrollHeight);
  on('#jb-start', () => jobAction(job.id, 'start')); on('#jb-cont', () => jobAction(job.id, 'continue')); on('#jb-precheck', () => jobAction(job.id, 'precheck'));
  on('#jb-pause', () => jobAction(job.id, 'pause')); on('#jb-skip', () => jobAction(job.id, 'skip-current'));
  on('#jb-cancel', () => { if (confirm('Zrušit běžící upgrade? Aktuální zařízení se bezpečně dokončí nebo uklidí.')) jobAction(job.id, 'cancel'); });
  on('#jb-cancel2', () => { if (confirm('Zrušit tento upgrade?')) jobAction(job.id, 'cancel'); });
  el.querySelectorAll('.iskip').forEach(b => b.onclick = () => itemAction(+b.dataset.id, 'skip'));
  el.querySelectorAll('.iretry').forEach(b => b.onclick = () => itemAction(+b.dataset.id, 'retry'));
  el.querySelectorAll('.detail').forEach(c => c.onclick = () => openDetail(+c.dataset.id));
}
const ACTIVE = new Set(['checking', 'backup', 'upload', 'reboot', 'verify', 'firmware']);
async function itemAction(id, a) { try { await api(`/items/${id}/${a}`, { method: 'POST' }); await openJob(state.job.job.id); } catch (e) { toast(e.message, true); } }
// důležité řádky logu (pro filtr „jen důležité"): varování/chyby + začátek a výsledek každého zařízení + zprávy o jobu (start, pauza, blokátory, kontrola)
const LOG_IMPORTANT_RE = /^(===|♥|hotovo|Job |Server |STOP|BLOK|Předběžná|kontrola: |DRY RUN|Položka|přeskak|pozastav|zrušen)/i;
const logImportant = (l) => l.level !== 'info' || LOG_IMPORTANT_RE.test(String(l.msg || ''));
// prefix „zařízení · IP" podle device_id (names: Map device_id → text); v detailu zařízení se nepoužívá
const logLine = (l, names) => { const n = names && l.device_id ? names.get(l.device_id) : ''; return `<div class="${l.level}${logImportant(l) ? '' : ' lo'}" data-dev="${l.device_id || 0}"><span class="t">${fmtMs(l.ts)}</span>${n ? `<span class="dev">${esc(n)}</span> ` : ' '}${esc(l.msg)}</div>`; };
// prefix řádku: název a zkrácená IP (poslední dva oktety, např. 90.55); bez názvu celá IP
const shortIp = (h) => { const m = String(h || '').match(/^\d+\.\d+\.(\d+\.\d+)$/); return m ? m[1] : String(h || ''); };
const logNames = (items) => new Map((items || []).map(it => [it.device_id, `${it.dev_name || it.identity || it.host}${it.host && (it.dev_name || it.identity) ? ' · ' + shortIp(it.host) : ''}`]));
// sledování konce logu: true jen když je uživatel odrolovaný ke konci stránky; přepíná se podle skutečného rolování
/** plovoucí ↑/↓ vpravo dole: jen když je stránka delší než obrazovka */
function updatePageNav() { const n = $('#pagenav'); if (!n) return; n.hidden = document.documentElement.scrollHeight <= window.innerHeight + 300; }
try { window.addEventListener('resize', updatePageNav); new MutationObserver(() => updatePageNav()).observe(document.body, { childList: true, subtree: true }); } catch {}
let LOGFOLLOW = false;
try { window.addEventListener('scroll', () => { LOGFOLLOW = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120; }, { passive: true }); } catch {}
let LOGIMP = false; try { LOGIMP = localStorage.getItem('mtu_logimp') === '1'; } catch {}
async function openJob(id) { if (!state.job || state.job.job.id !== id) { state.logOpen = undefined; state.logDev = 0; LOGFOLLOW = false; } state.job = await api(`/jobs/${id}`); state.jobLog = state.job.log; state.view = 'jobs'; render(); }

function renderHelp(m) {
  m.innerHTML = `<h1>Nápověda</h1>
  <div class="panel help"><h2>K čemu to je</h2>
  <p>Nástroj hromadně upgraduje MikroTik routery a antény na nejnovější RouterOS a firmware. Dělá to opatrně: v každém jobu jedno zařízení po druhém, od antén k páteři, vždy se zálohou, s ověřením balíčků před restartem a s kontrolou verze i bezdrátových spojů po něm. Když něco nesedí, zastaví se dřív, než přijde na řadu nadřazený prvek. Nikdy se nerestartuje bez ověřených balíčků a staré kusy s 32 MB RAM zůstávají na poslední šestce.</p></div>

  <div class="panel help"><h2>Přihlášení a účty</h2>
  <ul class="plain">
    <li><b>Přihlášení</b> je přes hkfree SSO, stejným účtem jako do userdb. Účet v upgraderu vznikne sám při prvním přihlášení a podle e-mailu se naváže na tvoje oblasti v userdb. Odhlásit se dá tlačítkem vlevo dole. Přihlášení vydrží 30 dní.</li>
    <li><b>Co vidíš:</b> jen svoje zařízení, upgrady, zálohy a logy. Každé zařízení má jednoho vlastníka; adresu, kterou už má někdo jiný, ti sken nepřidá a napíše, kdo ji má. Předat zařízení může jen správce (tužka ✎ → vlastník, nebo ⇄ Přesunout vybrané).</li>
    <li><b>Nastavení:</b> každý má „Moje nastavení“ (kanál RouterOS pro nová zařízení: v7 stable nebo long-term, limity kontrol, čekání po restartu, prahy rádia, hardening služeb, syslog…), které platí pro jeho upgrady, kontroly a plány. Předvyplněné jsou společné hodnoty; po uložení se používají vlastní, „Vrátit na společné“ je zahodí.</li>
    <li><b>Správce</b> vidí všechno. Seznam má nahoře výběr vlastníka, výchozí je jeho vlastní pohled. V záložce Správa spravuje účty (vazba na userdb, role, vypnutí, smazání), společné nastavení výchozí pro všechny a vidí audit „kdo co dělal“.</li>
  </ul></div>

  <div class="panel help"><h2>Postup krok za krokem</h2>
  <ol>
    <li><b>Načti zařízení z userdb.</b> Tlačítko <b>+ Přidat zařízení (sken)</b> → dole červené <b>⇩ Natáhnout z userdb</b>. Ukáže se tabulka tvých oblastí a APček s počty zařízení; zaškrtni, která chceš, a dej <b>Načíst vybraná APčka</b>. Vezmou se zařízení APčka i zařízení členů pod ním, včetně loginů z userdb. Co není RouterOS, sken sám vyřadí; co nemá v userdb login, vypíše (doplň v userdb a načti znovu). Zařízení jde přidat i ručně: seznam řádků <code>ip uživatel heslo [název]</code> nebo rozsahy se společnými loginy. Když už sken jiného uživatele běží, tvůj se zařadí do fronty a spustí se po něm. Správce může zaškrtnout „celá síť“ a natáhnout všechny oblasti; zařízení pak připadnou účtům správců oblastí.</li>
    <li><b>Počkej na kontrolu.</b> Ve výsledku běží pruh „Kontrola zařízení a topologie X/N“. Každé zařízení se přečte (verze, model, místo, rádia, sousedé) a určí se mu rodič: sektor, ke kterému je registrované, PoE prvek, který ho napájí, CAPsMAN nebo brána. Po skončení se seznam seřadí jako strom.</li>
    <li><b>Zkontroluj strom.</b> Nahoře router nebo PoE switch, pod ním odsazené to, co napájí nebo připojuje. Na pořadí záleží: nejdřív antény, nakonec sektor a router, aby nikomu nevypadl proud ani spoj uprostřed zápisu. Kde rodič chybí nebo je špatně, nastav ho tužkou ✎ (ručně nastavený rodič už automatika nemění). Štítek „člen“ je zařízení člena, „stejný kus jako …“ je stejné sériové číslo pod jinou IP (jeden router s více rozhraními): upgraduje se jen hlavní záznam, „pod: …“ je rodič, který patří jinému uživateli (síť je jedna, pořadí i zámky se hlídají i přes hranici účtů).</li>
    <li><b>Spusť upgrade.</b> <b>Upgradovat vše potřebné</b> nahoře, zaškrtnutá zařízení a <b>Upgradovat vybrané</b>, nebo ▶ u řádku. V dialogu můžeš zadat <b>spustit v</b> (datum a čas; pro dnešní noc vyber zítřejší datum). Bez času se jede hned.</li>
    <li><b>Naplánovaný job se hned zkontroluje.</b> V seznamu upgradů uvidíš u jobu „naplánován, N k opravě“ a v jeho detailu, co by v noci bránilo upgradu (nedostupné zařízení, chybějící login, málo místa, riziková verze, neovladatelný PoE prvek nad zařízením…). Oprav to za dne; tlačítko <b>Zkontrolovat teď</b> kontrolu zopakuje a před startem se udělá znovu automaticky.</li>
    <li><b>Průběh.</b> Nejdřív se zařízení znovu zkontrolují a upgrade pokračuje sám; zařízení s překážkou se přeskočí a nedotknou. U každého zařízení: záloha (export + binární), případně preventivní restart při dlouhém uptime, nahrání balíčků, ověření názvu a velikosti na routeru, restart, kontrola verze, čekání na obnovení spojů a potomků, firmware RouterBOOT s dalším restartem. Stránku můžeš zavřít, běží to na serveru. Jedno zařízení trvá 3 až 10 minut, přechod v6 → v7 i 20. Vlevo dole vidíš své běžící joby a informačně i cizí.</li>
    <li><b>Když se to zastaví.</b> Červený pruh řekne proč. Podívej se na zařízení (ping, Winbox, spoj). Když je v pořádku, klikni <b>Pokračovat</b> (chybná položka se přeskočí) nebo u položky dej <b>znovu</b>. Nadřazený prvek chybného zařízení se neupgraduje, dokud chybu nevyřešíš.</li>
    <li><b>Hotovo.</b> Ve Stavu zařízení je „aktuální“, poslední řádek logu je poděkování se srdíčkem. Zálohy najdeš v detailu zařízení (klik na název).</li>
  </ol></div>

  <div class="panel help"><h2>Co se kontroluje před upgradem</h2>
  <p><b>Zařízení se přeskočí</b>, když: je nedostupné nebo neprojde login; uživatel na routeru nemá plná práva; cílová verze je riziková (známá regrese pro daný hardware nebo obecně, verze x.y.0 mladší než 14 dní, balíček pro architekturu neexistuje); hardware nemá mít v7 (cíl se sám přepne na poslední v6, viz seznam níže); ve flash není místo, v kořeni jsou cizí soubory .npk nebo RouterBOOT, vadné bloky flash přes 5 %; je málo volné RAM (nejdřív se zkusí restart); přechod v6 → v7 by měnil dynamický routing (BGP, OSPF, MPLS); nad zařízením je PoE prvek, který není v seznamu nebo nemá login (jde vypnout zaškrtávátkem „ignorovat PoE ovladatelnost“); druhý konec 60 GHz spoje chybí v seznamu nebo v jobu; zařízení je právě v jiném jobu.</p>
  <p><b>Jen varování</b> (do logu, jede se dál): dlouhý uptime (vyvolá preventivní restart), vysoká zátěž, nízké napájecí napětí, rostoucí vadné bloky, slabé rádio (signál pod −75 dBm, CCQ pod 60 %, 60 GHz kvalita pod 50 %, MCS 1, chybovost nad 5 %), nv2 striktně, CAPsMAN upgrade-policy, vlastní restartovací skripty a ping-watchdog (na dobu položky se vypnou), PoE watchdog na rodiči (dočasně se vypne), přísnější detekce PoE zkratu od 7.18, SFP moduly od 7.12, neznámé v6 balíčky, RouterBOOT starší než 6.41.4, brute-force pravidla SSH ve firewallu.</p>
  <p><b>Po restartu:</b> verze, balíčky, log, rozhraní a IP, bezdrátové spoje (stanice na stejném AP, sektoru se vrátí aspoň 80 % klientů, přičemž klienti přepojení na sousední sektor se stejným SSID se počítají jako vrácení; při kontrole radaru DFS se čeká déle; 60 GHz MCS ≥ 1 a kvalita/chybovost až po 90 s ustálení spoje z nejlepšího vzorku, CAP registrován), ping na bránu z routeru, sousedé, a počty položek v hlavních menu proti stavu před upgradem. Pokles je varování s odkazem na export v zálohách.</p></div>

  <div class="panel help"><h2>Časté otázky</h2>
  <details><summary>Zařízení má stav „nedostupné“</summary><p>Server se na něj nedostal přes SSH. Zkontroluj, že žije a má SSH zapnuté (IP → Services → ssh). Pak <b>Zkontrolovat</b>. Pokud má router brute-force ochranu SSH (address-list), přidej IP serveru do výjimky: ta ochrana počítá nová spojení, ne špatná hesla.</p></details>
  <details><summary>„Špatné přihlašovací údaje“</summary><p>Uživatel nebo heslo nesedí. Oprav v userdb a načti znovu, nebo v tužce ✎, a znovu <b>Zkontrolovat</b>.</p></details>
  <details><summary>„Změnil se SSH klíč, ověř zařízení“</summary><p>Router se hlásí jiným klíčem než minule. Buď byl přeinstalovaný (Netinstall, výměna kusu), nebo se na té IP ozývá něco jiného. Když víš, že je to v pořádku, dej v tužce ✎ <b>reset SSH host key</b>.</p></details>
  <details><summary>Ve výsledku načtení je „port 22 neodpovídá“</summary><p>Na té adrese neběží SSH: buď to není MikroTik, nebo má SSH vypnuté. Sken se k němu nedostane, takže ho nejde ověřit ani přidat. U MikroTiku zapni SSH a načti znovu.</p></details>
  <details><summary>„v7 se na tenhle HW nenahrává“ / cíl přepnut na v6</summary><p>Taková zařízení nástroj sám cílí na poslední v6 long-term. Kdo v7 chce i tak, zaškrtne u zařízení (tužka ✎) „povolit v7 i přes doporučení“ (zobrazí se jen u dotčených kusů); u MIPS-LE to nejde vůbec. Naopak „zůstat na v6“ drží libovolné zařízení na šestce.</p></details>
  <details><summary>„ve flash není místo“</summary><p>Zařízení s 16 MB flash mají na balíček málo místa. Nahrání se zkusí přes RAM a při neúspěchu se vše uklidí. Kusy na velmi staré verzi (pod 6.45) se blokují úplně, u nich instalace z RAM prokazatelně umírá. Pomůže jen Netinstall.</p></details>
  <details><summary>„málo volné RAM“</summary><p>Nástroj zařízení nejdřív restartuje (paměť se po měsících fragmentuje), počká na návrat spojů a zkusí kontrolu znovu. Přeskočí ho, až když je RAM málo i po čistém restartu.</p></details>
  <details><summary>„cizí balíčky .npk v kořeni“, „vadné bloky“, „device-mode flagged“</summary><p>Cizí .npk by se při restartu nainstaloval, smaž ho ve Winboxu (Files). Vadné bloky nad 5 % znamenají umírající NAND, nejdřív Netinstall nebo výměna. „Flagged“ je příznak, že RouterOS detekoval kompromitaci (SSH zranitelnosti 9/2026); zařízení prověř a příznak zruš.</p></details>
  <details><summary>Neovladatelný PoE switch nad zařízením</summary><p>Podle sousedů je nad zařízením PoE prvek, který není v seznamu nebo nemá login, takže není jistota, že mu během restartu neodpojí napájení (PoE watchdog). Přidej ho z userdb nebo skenem s loginem, v Nastavení přepni blokování na varování, nebo u konkrétního zařízení zaškrtni „ignorovat PoE ovladatelnost“.</p></details>
  <details><summary>Proč se zařízení před upgradem restartovalo</summary><p>Mělo uptime nad limit (Nastavení → preventivní restart, výchozí 180 dní). Po měsících provozu zařízení po upgradu častěji nenabootuje, po čistém restartu ne. Restart se ověří stejně jako po upgradu.</p></details>
  <details><summary>Zařízení se po upgradu neozvalo</summary><p>Nástroj čeká 15 minut (Nastavení). Když se neozve, položka selže a job se zastaví. Zkontroluj napájení a ping. Většinou jen déle bootuje. Až naběhne, dej u položky <b>znovu</b>; nástroj zjistí aktuální stav a dokončí, co chybí. Když neožije vůbec, viz postup obnovy níže.</p></details>
  <details><summary>Co znamená device-mode basic / home</summary><p>Nástroj chce plné ovládání (advanced). Změnu ale RouterOS vyžaduje potvrdit tlačítkem nebo odpojením napájení; nástroj to udělá jen tam, kde zařízení napájí nadřazený MikroTik přes PoE. Jinak jen upozorní a upgraduje dál, v basic to jde.</p></details>
  <details><summary>Jak upgrade zastavit</summary><p><b>Zastavit po aktuálním zařízení</b>: rozpracované zařízení se v klidu dokončí, pak se job zastaví a jde v něm pokračovat. <b>Zrušit</b>: přeruší se i běžící přenos; před restartem se nahrané balíčky z routeru smažou, po odeslaném restartu se počká na návrat a dokončí ověření. Naplánovaný job se zrušením jen odplánuje.</p></details>
  <details><summary>Job má poznámku „aktualizace serveru“ nebo „spustí se hned po restartu“</summary><p>Upgrader se aktualizuje za provozu. Před restartem služby běžící joby dokončí aktuální zařízení včetně ověření, pozastaví se s poznámkou „aktualizace serveru — job pokračuje automaticky po restartu“ a po restartu se samy rozjedou dál. Job spuštěný v té chvíli se jen zařadí a naskočí po restartu. Nic není potřeba dělat. Když se stránka po aktualizaci chová divně (hlásí neznámé API), stačí ji obnovit.</p></details>
  <details><summary>Může nás tu pracovat víc naráz?</summary><p>Ano. Jobů může běžet víc naráz, i od jednoho uživatele; každý zpracovává svá zařízení po jednom. Jedno zařízení nemůže být ve dvou běžících jobech a před restartem se čeká, když jiný job právě upgraduje zařízení fyzicky nad nebo pod ním (rodič, potomek, PoE, druhý konec spoje). V logu je, kdo job spustil, pozastavil nebo zrušil.</p></details>
  <details><summary>Firmware se upgraduje?</summary><p>Ano, po každém upgradu RouterOS se upgraduje i RouterBOOT a udělá se ještě jeden restart. Restart přijde až poté, co router v logu potvrdí zápis firmware („Firmware upgraded successfully…“); bez potvrzení do 2 minut se nerestartuje a firmware se aktivuje při příštím restartu. Stav „aktuální, jen firmware“ znamená, že RouterOS sedí a chybí jen tohle. U zařízení s protected-routerboot se firmware nedělá automaticky.</p></details>
  <details><summary>Co se při upgradu nastaví na routeru navíc</summary><p>Pokud to správce zapnul v Nastavení: služby v /ip service (nepotřebné se vypnou, ostatní dostanou povolené adresy; ssh se nikdy nevypne a adresy jen když obsahují IP tohoto serveru) a vzdálené logování na syslog server. Mění se jen to, co neodpovídá, vše je v logu jobu.</p></details>
  <details><summary>Kde jsou zálohy</summary><p>V detailu zařízení (klik na název) v části Zálohy: textový export (.rsc) a binární záloha (.backup) z doby těsně před upgradem. Export jde nahrát i na jinou verzi, binární záloha jen na stejnou verzi a stejný kus.</p></details>
  <details><summary>Co dělá „Rozdělit flash na 2 oddíly“ v detailu zařízení</summary><p>U větších zařízení (128 MB flash a víc) vytvoří záložní oddíl. Pokud pak nová verze nenabootuje, router sám naběhne ze záložního oddílu se starou verzí. Jednorázová akce s restartem, dělej ji mimo špičku. Jen správce.</p></details>
  </div>
  <div class="panel help"><h2>Když zařízení po upgradu neožije: Netinstall a obnova ze zálohy</h2>
  <p>Nástroj nikdy nerestartuje bez ověřených balíčků, přesto může zařízení zůstat mrtvé (výpadek napájení během zápisu, vadná flash, bootloop). Postup od nejjednoduššího:</p>
  <ol>
    <li><b>Nejdřív počkej a ověř.</b> Boot s instalací trvá až 5 minut, přechod v6 → v7 i víc. Zkus ping, Winbox přes MAC (Neighbors) a podívej se na LED. Nástroj čeká 15 minut a pak položku označí „nevrátil se“.</li>
    <li><b>Zkus záložní bootloader.</b> Odpoj napájení, <b>drž reset</b>, připoj napájení a reset pusť asi <b>3 s</b> po zapnutí. Nabootuje záložní RouterBOOT. Když se zařízení ozve, přihlas se a dej <code>/system routerboard upgrade</code> + restart. Tím je hotovo.</li>
    <li><b>Stáhni si zálohu z nástroje.</b> Zařízení → klik na název → <b>Zálohy</b>. Jsou tam dvě z doby těsně před upgradem: <code>.backup</code> (binární, úplná včetně hesel a klíčů) a <code>.rsc</code> (textový export). Zapiš si <b>verzi RouterOS</b>, se kterou vznikly (je v názvu souboru): binární zálohu jde nahrát <b>jen na stejnou verzi a stejný kus</b>, export jde i na jinou verzi.</li>
    <li><b>Připrav Netinstall.</b> Na PC stáhni z mikrotik.com <b>Netinstall</b> a balíčky pro architekturu zařízení (System → Resource, nebo v detailu zařízení) <b>ve stejné verzi jako záloha</b>: <code>routeros-&lt;verze&gt;-&lt;arch&gt;.npk</code> a u zařízení s rádiem i <code>wireless-&lt;verze&gt;-&lt;arch&gt;.npk</code> (od 7.13 je wireless zvlášť; bez něj nebude rádio). Nastav síťové kartě PC pevnou adresu <b>192.168.88.2/24</b>, vypni firewall a ostatní síťová rozhraní, propoj PC a zařízení <b>přímým kabelem</b> do ether1 (boot port). Přes bezdrát to nejde, Netinstall je jen po kabelu na stejném segmentu.</li>
    <li><b>Spusť Netinstall.</b> Ve Windows: Net booting → zapnout, Client IP <b>192.168.88.3</b>. V Linuxu: <code>netinstall-cli -r -a 192.168.88.3 routeros-…npk wireless-…npk</code>. Pak zařízení: odpoj napájení, drž reset, připoj napájení a drž reset dál, dokud LED nezhasne (u většiny kusů 15–20 s), pak pusť. Zařízení se objeví v seznamu Netinstallu. Vyber ho, zaškrtni oba balíčky, <b>„Keep old configuration“ nech vypnuté</b> (konfiguraci vrátíš ze zálohy), klikni Install a počkej na „OK“. Zařízení se restartuje s výchozí konfigurací (admin bez hesla, 192.168.88.1).</li>
    <li><b>Vrať konfiguraci.</b> Připoj se Winboxem na 192.168.88.1 (nebo přes MAC). <b>Binární záloha:</b> nahraj <code>.backup</code> do Files a dej <code>/system backup load name=&lt;soubor&gt;</code>, zařízení se restartuje s původní konfigurací včetně hesel, certifikátů a SSH klíčů. <b>Textový export</b> (když je Netinstall na jiné verzi než záloha): nahraj <code>.rsc</code> do Files, dej <code>/system reset-configuration no-defaults=yes skip-backup=yes run-after-reset=&lt;soubor&gt;</code>; hesla uživatelů, certifikáty a SSH klíče v exportu nejsou, nastav je ručně.</li>
    <li><b>Dokonči v nástroji.</b> Netinstall vygeneruje nový SSH klíč, proto u zařízení dej tužkou ✎ <b>reset SSH host key</b> a <b>Zkontrolovat</b>. Když jsi instaloval starší verzi, nástroj nabídne upgrade znovu, tentokrát s čerstvou zálohou.</li>
  </ol>
  <p><b>Bez fyzického přístupu:</b> od RouterOS 7.24 umí Netinstall spustit i sousední MikroTik po kabelu: na rodiči <code>/tool/netinstall/add interface=&lt;port&gt; mac-address=&lt;MAC zařízení&gt; version=&lt;verze&gt;</code> (rodič potřebuje balíčky ve Files a místo v RAM). Když má zařízení <b>protected-routerboot</b>, reset ani Netinstall nefungují a pomůže jen servis. Zařízení s víc oddíly (/partitions) nabootuje samo ze záložního oddílu se starou verzí, Netinstall pak není potřeba.</p></div>
  <div class="panel help"><h2>Hardware, na který se v7 nenahrává</h2><div class="hint" style="margin-bottom:8px">Seznam se bere přímo z plánovače, takže odpovídá tomu, co nástroj dělá. Cíl takových zařízení je poslední v6 long-term; povolit v7 jde u zařízení tužkou ✎ (kromě MIPS-LE).</div><div id="rules-nov7">načítám…</div></div>
  <div class="panel help"><h2>Verze s doloženou regresí</h2><div class="hint" style="margin-bottom:8px">Na tyto verze se neupgraduje (cílem je vždy nejnovější verze kanálu, seznam hraje roli při zpoždění opravných verzí). Zdroj: changelogy download.mikrotik.com a forum.mikrotik.com, rešerše 9/2026.</div><div id="rules-bad">načítám…</div></div>`;
  api('/rules').then(r => {
    $('#rules-nov7').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Hardware</th><th>Důvod</th><th>Zdroj</th><th>Povolit lze</th></tr></thead><tbody>${r.noV7.map(x => `<tr><td style="white-space:normal">${esc(x.hw)}</td><td style="white-space:normal">${esc(x.why)}</td><td class="muted" style="white-space:normal">${esc(x.src)}</td><td>${x.hard ? '<span class="badge b-err">ne</span>' : '<span class="badge b-ok">ano</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    $('#rules-bad').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Hardware</th><th>Verze</th><th>Proč</th></tr></thead><tbody>${r.knownBad.filter(x => x.versions.length).map(x => `<tr><td style="white-space:normal">${esc(x.hw)}</td><td class="mono" style="white-space:normal">${esc(x.versions.join(', '))}</td><td style="white-space:normal">${esc(x.why)}</td></tr>`).join('')}<tr><td>všechna zařízení</td><td class="mono" style="white-space:normal">${esc(r.globalBad.map(g => g.version).join(', '))}</td><td style="white-space:normal">${esc(r.globalBad.map(g => `${g.version}: ${g.why}`).join(' · '))}</td></tr></tbody></table></div>`;
  }).catch(e => { const n = $('#rules-nov7'); if (n) n.textContent = e.message; });
}
function settingsFields(s) {
  const f = (k, label, type = 'number', step = '1') => `<label>${label}<input name="${k}" type="${type}" step="${step}" value="${esc(s[k])}"></label>`;
  const c = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;
  return `<h2>Kontroly před upgradem</h2>
    ${f('min_uptime_min', 'min. uptime zařízení (min)')}${f('min_free_mem_mb', 'min. volná RAM (MB)')}${f('space_margin_mb', 'rezerva místa k balíčkům (MB)', 'number', '0.5')}${f('ssh_timeout_sec', 'SSH timeout připojení (s)')}
    <h2>Verze</h2>
    <label class="wide">kanál RouterOS pro nová zařízení<select name="default_track"><option value="v7-stable" ${s.default_track !== 'v7-long-term' ? 'selected' : ''}>v7 stable — nejnovější vydání (výchozí)</option><option value="v7-long-term" ${s.default_track === 'v7-long-term' ? 'selected' : ''}>v7 long-term — konzervativnější, jen prověřené verze</option></select><span class="hint">Platí pro zařízení přidaná od teď. Starý hardware bez v7 jde vždy na poslední v6. U existujících zařízení jde kanál změnit tužkou, nebo hromadně tlačítkem níže.</span></label>
    <div class="wide row"><button type="button" class="small" id="tracksel-stable">Přepnout všechna moje zařízení na v7 stable</button><button type="button" class="small" id="tracksel-lt">Přepnout všechna moje zařízení na v7 long-term</button><span class="hint">nemění zařízení držená na v6 ani hold</span></div>
    ${f('min_release_age_days', 'min. stáří verze (dní)', 'number', '0.5')}${f('zero_release_min_days', 'min. stáří první verze větve x.y.0 (dní)')}<label class="wide">zakázané verze (čárkou)<input name="bad_versions" type="text" value="${esc(s.bad_versions)}" placeholder="7.19.4, 7.23.4"></label>
    <h2>Průběh a bezdrátové spoje</h2>
    ${f('reboot_timeout_min', 'návrat po restartu (min)')}${f('pause_between_devices_sec', 'pauza mezi zařízeními (s)')}${f('link_wait_min', 'čekání na obnovení spojů (min)')}${f('link_return_pct', 'návrat klientů sektoru (%)')}${f('preventive_reboot_days', 'preventivní restart při uptime nad (dní, 0 = vypnuto)')}
    ${f('radio_min_signal', 'varovat při signálu pod (dBm, 5 GHz)')}${f('radio_min_ccq', 'varovat při CCQ pod (%)')}${f('radio_min_signal60', 'varovat při 60 GHz kvalitě pod (%)')}${f('radio_max_per', 'varovat při 60 GHz chybovosti nad (%)')}
    ${c('confirm_after_precheck', 'po předběžné kontrole čekat na „Pokračovat“, když má některé zařízení varování nebo se přeskočí (jinak se jede rovnou a zastaví až chyba)')}
    ${c('require_peer_in_job', 'blokovat upgrade, když druhý konec 60 GHz spoje není ve stejném jobu (jinak jen varování)')}
    ${c('block_unmanaged_poe', 'blokovat upgrade, když je nad zařízením PoE prvek bez přístupu (neovladatelný PoE switch; jinak jen varování)')}
    ${c('v7_via_712_small_flash', 'u 16 MB zařízení jít z v6 na v7 přes mezikrok 7.12.x')}
    ${c('firmware_before_v7', 'před přechodem 6 → 7 nejdřív upgradovat RouterBOOT ještě na v6')}
    ${c('use_partition_fallback', 'u zařízení s více oddíly zkopírovat běžící systém do záložního oddílu (fallback při nenabootování)')}
    <h2>Povolit rizikové (jinak blokováno)</h2>
    ${c('allow_v7_routing_migration', 'přechod v6 → v7 s BGP / OSPF / routing filtry / MPLS')}
    ${c('allow_v7_small_flash', 'přechod v6 → v7 na 16 MB flash bez adresáře flash')}
    ${c('allow_v7_low_ram', 'v7 na zařízeních s méně než 64 MB RAM (RB750, hAP lite — hrozí OOM bootloop)')}
    <h2>Služby routeru (/ip service)</h2>
    ${c('harden_services', 'při ostrém běhu vypnout služby mimo seznam a všem nastavit povolené adresy (ssh se nikdy nevypne, adresy jen když obsahují IP tohoto serveru)')}
    <label>zapnuté služby (čárkou)<input name="services_keep" type="text" value="${esc(s.services_keep)}" placeholder="ssh,winbox"></label>
    <label class="wide">povolené adresy / CIDR (čárkou; prázdné = adresy neměnit)<input name="services_address" type="text" value="${esc(s.services_address)}" placeholder="10.0.0.0/8,192.168.0.0/16,2001:db8::/32"></label>
    <h2>Vzdálené logování (syslog)</h2>
    ${c('remote_log_enable', 'při ostrém běhu zajistit logging action target=remote a pravidla pro témata (přidá se jen, co chybí)')}
    <label>IP syslog serveru<input name="remote_log_host" type="text" value="${esc(s.remote_log_host)}" placeholder="192.0.2.10"></label>
    <label>název logging action<input name="remote_log_name" type="text" value="${esc(s.remote_log_name)}" placeholder="remote"></label>
    <label>témata (čárkou)<input name="remote_log_topics" type="text" value="${esc(s.remote_log_topics)}" placeholder="critical,error,info,warning"></label>
    `;
}
function adminPanelsHtml(s) {
  return `<h1>Správa</h1>
  <div class="panel"><h2>Společné nastavení</h2><div class="hint" style="margin-bottom:8px">Výchozí hodnoty pro všechny; kdo si uložil „Moje nastavení“, používá svoje.</div><form id="setf" class="form">${settingsFields(state.settingsGlobal || s)}<div class="wide"><button class="primary">Uložit společné</button></div></form></div>
  <div class="panel"><h2>Uživatelé</h2><div class="hint" style="margin-bottom:8px">Každý vidí a upgraduje jen zařízení, která sám přidal (nebo mu je správce přidělil v editaci zařízení). Správce vidí vše a spravuje účty i nastavení.</div>
    ${state.auth.passwordLogin ? `<label class="check" style="margin-bottom:8px"><input type="checkbox" id="regtoggle" ${s.allow_registration ? 'checked' : ''}> povolit samoregistraci na přihlašovací stránce (nový účet = role uživatel)</label>
    <div id="userlist">načítám…</div>
    <form id="useradd" class="form" style="margin-top:12px"><h2>Nový účet</h2><label>jméno<input name="name" required autocomplete="off"></label><label>heslo (aspoň 8 znaků)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label><label>role<select name="role"><option value="user">uživatel</option><option value="admin">správce</option></select></label><label>&nbsp;<button class="primary">Založit</button></label></form>` : '<div class="hint" style="margin-bottom:8px">Účty vznikají samy při prvním přihlášení přes SSO (podle e-mailu) a navážou se na správce v userdb.</div>'}</div>
  <div class="panel"><details id="auditbox"><summary><b>Kdo co dělal</b> (audit posledních akcí)</summary><div id="auditlist" class="hint">načítám…</div></details></div>
`;
}
function renderSettings(m, adminMode = false) {
  const s = state.settings;
  const ownKeys = Object.keys(state.settingsOwn || {});
  m.innerHTML = adminMode ? adminPanelsHtml(s) : `<h1>Nastavení</h1>
  <div class="panel"><h2>Moje nastavení</h2><div class="hint" style="margin-bottom:8px">Platí pro tvoje upgrady, kontroly a plány. Předvyplněné jsou společné hodnoty od správce; po uložení se u tebe používají tyhle (společné změny se pak u tebe neprojeví, dokud nedáš „Vrátit na společné“).${ownKeys.length ? ` <b>Máš vlastní hodnoty.</b>` : ' Zatím používáš společné.'}</div>
    <form id="setf-mine" class="form">${settingsFields(s)}<div class="wide row"><button class="primary">Uložit moje nastavení</button>${ownKeys.length ? '<button type="button" id="setreset">Vrátit na společné</button>' : ''}</div></form></div>
  <div class="panel"><details ${state.advanced ? 'open' : ''}><summary><b>Jak to funguje</b> (podrobně)</summary><ul class="plain">
    <li><b>Sken</b> jen čte: verze, model, architektura, firmware, místo, RAM, balíčky, rizikové příznaky. Nikdy nic nemění.</li>
    <li><b>Job</b> zpracovává zařízení <b>sériově</b>, jedno po druhém (jobů může běžet víc naráz, každý po jednom zařízení; „spustit v“ naplánuje start na zadaný čas). Před každým krokem znovu zjistí živý stav a přepočítá plán.</li>
    <li>Pořadí hopů: v6.x → nejnovější v6 long-term → v7 (cíl podle tracku). Nikdy se nedowngraduje.</li>
    <li>Před hopem: export konfigurace (.rsc, vždy) + binární .backup (přes SFTP) se stáhnou sem na server.</li>
    <li>Balíčky (.npk) stahuje server z download.mikrotik.com, ověří velikost, nahraje přes SFTP a znovu ověří na routeru (název + velikost, žádný cizí .npk). Až potom restart.</li>
    <li>Po restartu: čekání na návrat (timeout výše), kontrola identity, verze, rozhraní, IP adres, bezdrátu. Pak volitelně firmware RouterBOOT + další restart.</li>
    <li>Při chybě se job <b>zastaví</b> (stop při chybě), nahrané balíčky se z routeru smažou, žádný restart. Blokátory (málo místa, cizí .npk, nízký uptime, změněný SSH klíč, dynamický routing při 6→7…) upgrade vůbec nespustí.</li>
    <li><b>Topologie:</b> u zařízení nastav nadřazený prvek (co ho napájí/připojuje — sektor, PoE switch, router). Job jde vždy od listů: nejdřív antény, pak sektory, pak nadřazené. Nadřazený prvek se nerestartuje, dokud jeho potomci v jobu neskončí v pořádku; po jeho restartu se čeká, až se potomci zase ozvou. Uplink se detekuje ze sousedů (neighbor discovery) — tlačítko „Přebrat detekované rodiče".</li>
    <li><b>Device-mode:</b> při ostrém běhu se nastaví „plné ovládání" (mode=advanced, partitions=yes). RouterOS to vyžaduje potvrdit tlačítkem nebo odpojením napájení, softwarový restart změnu zruší. Nástroj to proto udělá jen tam, kde má zařízení v seznamu nadřazený MikroTik, který ho napájí přes PoE: vydá update, vypne a zapne PoE na portu rodiče, počká na návrat a ověří. Jinak jen varuje (a nespotřebuje žádný ze 3 pokusů).</li>
    <li><b>Služby routeru:</b> je-li zapnuto v nastavení, u každého zařízení v ostrém běhu (i když už je na cílové verzi) se v <code>/ip service</code> vypnou služby mimo seznam a všem se nastaví povolené adresy. Mění se jen to, co nesedí, ssh se nikdy nevypne a omezení adres se použije jen tehdy, když seznam obsahuje i IP tohoto serveru. Dry run vypíše, co by se změnilo.</li>
    <li><b>Vzdálené logování:</b> je-li zapnuto v nastavení, u každého zařízení v ostrém běhu se zajistí <code>/system logging action</code> s target=remote na zadaný syslog server a pravidlo pro každé téma ze seznamu. Přidá se jen, co chybí; existující akce s jiným cílem se přenastaví.</li>
    <li><b>Bezdrátové spoje (aby se neuřízla anténa od sektoru):</b> sken si u každého zařízení zapamatuje, k jakému AP je stanice připojená, kolik klientů má sektor a s kým je spojený 60 GHz spoj (MAC, MCS, signál). Po každém restartu se čeká (výchozí 12 min), až se stanice zaregistruje ke stejnému AP, sektoru se vrátí aspoň 80 % klientů a 60 GHz spoj má MCS ≥ 1. Když ne, položka selže a job se zastaví dřív, než přijde na řadu nadřazený prvek. Ovladač rádia (wireless vs. wifi-qcom) se nikdy nemění — jen ten rozbíjí nv2/nstreme a station-bridge, rozdíl verzí na obou koncích doložený problém není. U 60 GHz se hlídají verze s regresí (7.19.4, 7.5, 6.47.x) a upozorní se, když druhý konec spoje není v jobu.</li>
    <li><b>Známé vadné verze:</b> první vydání větve (x.y.0) se neinstaluje, dokud není staré aspoň 14 dní (od 7.13 dostala každá do 14 dní opravu), plus seznam verzí s regresí pro konkrétní HW (RB2011, RB3011, hAP ac2/ax, CRS3xx, PPC, CHR, 60 GHz) a obecně (7.17, 7.19, 7.20, 7.23.4, 7.24…). Vadné bloky flash nad 5 % blokují, záznamy „kernel failure" v logu varují, otisk zneužití SSH zranitelnosti (9/2026) nebo device-mode „flagged" se hlásí.</li>
    <li><b>Dry run</b> = jen kontrola a plán, nic se nemění. <b>Kanárci</b> = nejdřív jedno zařízení od každého modelu, pak čekání na potvrzení.</li>
    <li><b>Nejčastější příčiny umrtvení dle fór/dokumentace MikroTik a opatření:</b> výpadek napájení během zápisu (→ kontrola napětí, nikdy nerestartovat nadřazený PoE prvek během upgradu potomka, servisní okno); neúplný/poškozený balíček a přesto restart (→ kontrola velikosti proti download.mikrotik.com, žádný cizí .npk, bez ověření se nerestartuje); chybějící wireless/wifi balíček po 7.13 (→ doplní se podle rozhraní, i 60GHz); „not enough space" na 16 MB flash (→ mezikrok 7.12.x, upload se při selhání uklidí); kernel bugy čerstvých verzí a bootloopy (→ min. stáří verze, zakázané verze, kanárci po modelech); starý RouterBOOT před v7 (→ firmware ještě na v6); konverze konfigurace 6→7 (BGP/OSPF/filtry/MPLS blokováno, VLAN filtering varování); protected-routerboot (varování, Netinstall nejde); auto-upgrade firmware routeru (→ RouterBOOT se zapíše sám při startu, nástroj ho aktivuje svým restartem); víc oddílů (→ kopie do záložního oddílu + fallback-to).</li>
    <li><b>Firewall na routerech:</b> nástroj se připojuje z IP serveru, na kterém běží — je vidět vlevo dole („SSH z …“, kliknutím se zkopíruje). Pokud mají routery brute-force ochranu SSH (address-list ssh_blacklist apod.), doporučuji tuto IP přidat do výjimky — nástroj sice rozestupuje opakovaná spojení na 65 s, ale sken + job dělají několik přihlášení za sebou.</li>
    <li>Čeho se nástroj netýká: fyzicky mrtvá zařízení (výpadek napájení během zápisu) řeší jen Netinstall — proto se nikdy nerestartuje bez ověřených balíčků a zálohy.</li></ul></details></div>`;
  const ul = $('#userlist');
  if (ul) {
    const renderUsers = async () => {
      try { state.users = await api('/users'); } catch (e) { ul.textContent = e.message; return; }
      const me = state.auth.user;
      ul.innerHTML = `<table><thead><tr><th>jméno</th><th>role</th>${state.auth.userdb && state.auth.userdb.enabled ? '<th>userdb</th>' : ''}<th>naposledy přihlášen</th><th>stav</th><th></th></tr></thead><tbody>${state.users.map(u => `<tr class="${u.disabled ? 'muted' : ''}"><td>${esc(u.name)}${me && u.id === me.id ? ' <span class="muted">(ty)</span>' : ''}</td><td>${u.role === 'admin' ? 'správce' : 'uživatel'}</td>${state.auth.userdb && state.auth.userdb.enabled ? `<td>${u.userdb_uid ? `${esc(u.userdb_nick)} <span class="muted">(${u.userdb_uid})</span> <button class="small" data-act="udbimp" data-id="${u.id}" title="načíst jeho zařízení z userdb">⇩ import</button>` : '<span class="muted">—</span>'} <button class="small" data-act="udb" data-id="${u.id}">vazba</button></td>` : ''}<td class="muted">${u.last_login_at ? fmtTs(Math.floor(u.last_login_at / 1000)) : '—'}</td><td>${u.disabled ? '<span class="badge b-err">vypnutý</span>' : '<span class="badge b-ok">aktivní</span>'}</td><td class="acts">
        ${state.auth.passwordLogin ? `<button class="small" data-act="pw" data-id="${u.id}">nové heslo</button> ` : ''}<button class="small" data-act="role" data-id="${u.id}">${u.role === 'admin' ? 'odebrat správce' : 'udělat správcem'}</button> <button class="small" data-act="dis" data-id="${u.id}">${u.disabled ? 'zapnout' : 'vypnout'}</button> <button class="small danger" data-act="del" data-id="${u.id}">smazat</button></td></tr>`).join('')}</tbody></table>`;
      ul.querySelectorAll('button[data-act]').forEach(b => b.onclick = async () => {
        const id = +b.dataset.id, u = state.users.find(x => x.id === id);
        try {
          if (b.dataset.act === 'pw') { const pw = prompt(`Nové heslo pro ${u.name} (aspoň 8 znaků):`); if (!pw) return; await api(`/users/${id}`, { method: 'PUT', body: { password: pw } }); toast('heslo nastaveno'); }
          else if (b.dataset.act === 'udb') { const q = prompt(`Správce v userdb pro účet ${u.name} — uid, e-mail nebo přezdívka (prázdné = zrušit vazbu):`, u.userdb_nick || u.email || ''); if (q === null) return; await api(`/users/${id}`, { method: 'PUT', body: { userdb: q } }); toast(q ? 'účet navázán na userdb' : 'vazba zrušena'); }
          else if (b.dataset.act === 'udbimp') { openModal({ type: 'discover', user: id }); return; }
          else if (b.dataset.act === 'role') { await api(`/users/${id}`, { method: 'PUT', body: { role: u.role === 'admin' ? 'user' : 'admin' } }); toast('role změněna'); }
          else if (b.dataset.act === 'dis') { await api(`/users/${id}`, { method: 'PUT', body: { disabled: !u.disabled } }); toast(u.disabled ? 'účet zapnut' : 'účet vypnut'); }
          else if (b.dataset.act === 'del') {
            if (!confirm(`Smazat účet ${u.name}?`)) return;
            const others = state.users.filter(x => x.id !== id);
            try { await api(`/users/${id}`, { method: 'DELETE', body: {} }); }
            catch (e) { if (!/transfer_to/.test(e.message)) throw e; const t = prompt(`${e.message.split(' — ')[0]}. Komu je předat? (${others.map(x => x.name).join(', ')})`); const tu = others.find(x => x.name === (t || '').trim()); if (!tu) return toast('nezadán platný uživatel', true); await api(`/users/${id}`, { method: 'DELETE', body: { transfer_to: tu.id } }); }
            toast('účet smazán');
          }
          await renderUsers();
        } catch (e) { toast(e.message, true); }
      });
    };
    renderUsers();
    if ($('#regtoggle')) $('#regtoggle').onchange = async (e) => { try { state.settings = await api('/settings', { method: 'PUT', body: { allow_registration: e.target.checked } }); toast(e.target.checked ? 'registrace povolena' : 'registrace vypnuta'); } catch (e2) { toast(e2.message, true); } };
    if ($('#useradd')) $('#useradd').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); try { await api('/users', { method: 'POST', body: b }); toast(`účet ${b.name} založen`); e.target.reset(); await renderUsers(); } catch (e2) { toast(e2.message, true); } };
  }
  const ab = $('#auditbox'); if (ab) ab.ontoggle = async () => { if (!ab.open) return; try { const rows = await api('/audit'); $('#auditlist').innerHTML = rows.length ? `<table>${rows.map(r => `<tr><td class="muted">${fmtTs(Math.floor(r.ts / 1000))}</td><td>${esc(r.user)}</td><td class="mono">${esc(r.ip || '')}</td><td>${esc(r.action)}</td><td class="muted" style="white-space:normal">${esc(r.detail)}</td></tr>`).join('')}</table>` : 'zatím nic'; } catch (e) { $('#auditlist').textContent = e.message; } };
  for (const [id, tr] of [['#tracksel-stable', 'v7-stable'], ['#tracksel-lt', 'v7-long-term']]) on(id, async () => { if (!confirm(`Přepnout všechna tvoje zařízení (kromě v6 a hold) na kanál ${tr}?`)) return; try { const r = await api('/devices/bulk-track', { method: 'POST', body: { track: tr } }); toast(`kanál změněn u ${r.changed} zařízení`); await loadState(); render(); } catch (e2) { toast(e2.message, true); } });
  const formBody = (form) => { const body = {}; for (const k of Object.keys(s)) { const el = form.elements[k]; if (!el) continue; body[k] = el.type === 'checkbox' ? el.checked : (el.type === 'text' || el.tagName === 'SELECT') ? el.value : parseFloat(el.value); } return body; };
  $('#setf-mine').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/settings/mine', { method: 'PUT', body: formBody(e.target) }); state.settings = r.settings; state.settingsOwn = r.own; toast('moje nastavení uloženo'); render(); } catch (e2) { toast(e2.message, true); } };
  on('#setreset', async () => { if (!confirm('Zahodit vlastní hodnoty a používat společné nastavení?')) return; try { const r = await api('/settings/mine', { method: 'DELETE' }); state.settings = r.settings; state.settingsOwn = r.own; toast('používáš společné nastavení'); render(); } catch (e2) { toast(e2.message, true); } });
  const sg = $('#setf'); if (sg) sg.onsubmit = async (e) => { e.preventDefault(); try { state.settingsGlobal = await api('/settings', { method: 'PUT', body: formBody(e.target) }); await loadState(); toast('společné nastavení uloženo'); render(); const d = $('#setglobal'); if (d) d.open = true; } catch (e2) { toast(e2.message, true); } };
}

// ---------- modaly ----------
function openModal(mod) { state.modal = mod; renderModal(); }
function closeModal() { state.modal = null; renderModal(); }
function renderModal() {
  let bg = $('#modalbg');
  if (!state.modal) { if (bg) bg.remove(); return; }
  if (!bg) { bg = document.createElement('div'); bg.id = 'modalbg'; bg.className = 'modal-bg'; document.body.appendChild(bg); bg.onclick = (e) => { if (e.target === bg) closeModal(); }; }
  const md = state.modal;
  if (md.type === 'move') {
    const devs = md.ids.map(i => state.devices.find(d => d.id === i)).filter(Boolean);
    bg.innerHTML = `<div class="modal" style="width:min(520px,96vw)"><h2>Přesunout ${devs.length} zařízení k uživateli</h2>
      <div class="hint" style="margin-bottom:10px">${esc(devs.map(devName).join(', ')).slice(0, 400)}</div>
      <form id="movef" class="form"><label class="wide">nový vlastník<select name="owner_id">${state.users.map(u => `<option value="${u.id}">${esc(u.name)}${u.role === 'admin' ? ' (správce)' : ''}</option>`).join('')}</select></label>
      <div class="wide hint">Zařízení uvidí a bude upgradovat nový vlastník. Vazba na nadřazený prvek jiného vlastníka se zruší.</div>
      <div class="wide row"><button class="primary">Přesunout</button><button type="button" id="mclose">Zavřít</button></div></form></div>`;
    $('#movef').onsubmit = async (e) => { e.preventDefault(); const owner_id = +new FormData(e.target).get('owner_id'); try { const r = await api('/devices/bulk-owner', { method: 'POST', body: { ids: md.ids, owner_id } }); toast(`předáno ${r.moved} zařízení → ${r.owner}`); state.selected.clear(); closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
  } else if (md.type === 'password') {
    bg.innerHTML = `<div class="modal" style="width:min(420px,96vw)"><h2>Změna hesla</h2><form id="pwf" class="form">
      <label class="wide">současné heslo<input name="old" type="password" autocomplete="current-password"></label>
      <label class="wide">nové heslo (aspoň 8 znaků)<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
      <label class="wide">nové heslo znovu<input name="again" type="password" autocomplete="new-password" required></label>
      <div class="wide row"><button class="primary">Změnit</button><button type="button" id="mclose">Zavřít</button></div></form></div>`;
    $('#pwf').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); if (b.password !== b.again) return toast('hesla se neshodují', true); try { await api('/me/password', { method: 'POST', body: { old: b.old, password: b.password } }); toast('heslo změněno'); closeModal(); } catch (e2) { toast(e2.message, true); } };
  } else if (md.type === 'discover') {
    const nh = esc(state.netHint || '192.0.2');
    const udbOn = state.auth.userdb && state.auth.userdb.enabled && (state.auth.userdb.uid || md.user);
    bg.innerHTML = `<div class="modal"><h2>Přidat zařízení skenem</h2><form id="discf" class="form">
      <label class="wide">seznam zařízení, jedno na řádek: <code>ip uživatel heslo [název]</code> (prázdné heslo jako <code>""</code>, port jako <code>ip:port</code>)<textarea name="entries" rows="7" placeholder="${nh}.12.7 admin tajne sektor sever&#10;${nh}.12.8 admin tajne&#10;${nh}.12.9:2222 admin &quot;&quot;"></textarea></label>
      <label class="wide">a/nebo rozsahy k prohledání (CIDR, a.b.c.x-y; více oddělených mezerou/čárkou)<input name="ranges" placeholder="${nh}.12.0/24 ${nh}.13.10-50"></label>
      <label class="wide">společné loginy k vyzkoušení (nutné pro rozsahy, u seznamu jen jako záloha), jeden na řádek: <code>uživatel heslo</code><textarea name="creds" rows="3" placeholder="admin tajneheslo&#10;admin &quot;&quot;"></textarea></label>
      <label>SSH port<input name="port" type="number" value="22"></label>
      <label>kanál pro nové<select name="track">${state.tracks.map(t => `<option ${t === (state.settings.default_track || 'v7-stable') ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>souběžně<input name="parallel" type="number" value="24" min="1" max="64"></label>
      <div class="wide row"><button class="primary" ${state.discovery && !state.discovery.finishedAt ? 'disabled' : ''}>Spustit sken</button></div></form>
      ${udbOn ? `<div class="panel" style="margin-top:10px"><h2>Z userdb</h2><div class="hint">Nebo si zařízení natáhni z evidence hkfree: ukáže se seznam tvých APček, zaškrtneš, která chceš, a načtou se i s loginy (zařízení APčka i zařízení členů pod ním; co není RouterOS, sken vyřadí).</div>
        <div class="row" style="margin-top:6px"><button id="udbload" style="background:var(--err);border-color:var(--err);color:#fff;font-weight:600">⇩ Natáhnout z userdb${state.auth.userdb.nick && !md.user ? ` (${esc(state.auth.userdb.nick)})` : ''}</button>${state.admin && !md.user ? ` <label class="check" style="margin-left:10px"><input type="checkbox" id="udball"> celá síť: všechny oblasti a APčka v userdb (zařízení připadnou účtům správců oblastí)</label>` : ''}</div><div id="udb"></div></div>` : ''}
      <div class="panel" style="margin-top:10px"><h2>Výsledek</h2><div id="discres">${discoveryHtml(state.discovery)}</div></div>
      <div class="row"><button id="mclose">Zavřít</button></div></div>`;
    $('#discf').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); try { state.scanProg = null; state.discovery = await api('/discover', { method: 'POST', body: b }); renderModal(); } catch (e2) { toast(e2.message, true); } };
    if (udbOn) {
      const forUser = md.user ? `?user=${md.user}` : '';
      const box = $('#udb');
      const sumHtml = (x) => x ? `<div class="hint" style="margin:8px 0">Poslední načtení ${fmtTs(Math.floor(x.at / 1000))} (${esc(x.by)}): ${x.total} zařízení z userdb, ${x.entries} nových posláno do skenu${x.owners && Object.keys(x.owners).length ? ` (${esc(Object.entries(x.owners).map(([k, v]) => `${k} ${v}`).join(', '))})` : ''}, ${x.updated} už tu bylo (doplněn login/APčko)${x.foreign.length ? `, <b>${x.foreign.length} má u sebe jiný uživatel</b>: ${esc(x.foreign.join('; '))}` : ''}${x.missingLogin.length ? `, ${x.missingLogin.length} bez loginu v userdb: <span class="mono">${esc(x.missingLogin.slice(0, 12).join(', '))}${x.missingLogin.length > 12 ? '…' : ''}</span>` : ''}</div>` : '';
      const load = async () => {
        $('#udbload').disabled = true; box.innerHTML = '<span class="muted">načítám oblasti a APčka z userdb…</span>';
        const allMode = !!($('#udball') && $('#udball').checked);
        if (allMode) box.innerHTML = '<span class="muted">načítám všechny oblasti a APčka z userdb (u každého APčka se počítají zařízení, chvíli to trvá)…</span>';
        let r; try { r = await api('/userdb/me' + (allMode ? '?all=1' : forUser)); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; $('#udbload').disabled = false; return; }
        if (!r.linked) { box.innerHTML = `<p>Účet <b>${esc(r.user.name)}</b> není navázaný na správce v userdb${r.error ? ` (${esc(r.error)})` : ''}. Vazbu nastaví správce v Nastavení → Uživatelé (nebo se udělá sama při přihlášení přes SSO).</p>`; return; }
        const nAps = r.areas.reduce((n, a) => n + a.aps.length, 0);
        box.innerHTML = `<p>${r.all ? `<b>Celá síť</b>: ${r.areas.length} oblastí, ${nAps} APček. Zařízení připadnou účtu správce oblasti (SO, jinak zástupce); kdo účet nemá, dostane ho založený dopředu a při přihlášení přes SSO do něj spadne. Oblast bez správce připadne tobě.` : `Správce <b>${esc(r.admin.nick)}</b> (uid ${r.admin.id}): ${r.areas.length} oblastí, ${nAps} APček.`}</p>
          <div class="tablewrap"><table class="grid"><thead><tr><th><input type="checkbox" id="apall" checked title="vše / nic"></th><th>oblast</th><th>APčko</th>${r.all ? '<th>vlastníkem bude</th>' : ''}<th class="num">zařízení AP</th><th class="num">zařízení členů</th><th class="num">už v upgraderu</th></tr></thead><tbody>${r.areas.map(a => a.aps.map(ap => `<tr><td><input type="checkbox" class="apsel" value="${ap.id}" ${ap.active ? 'checked' : ''}></td><td>${esc(a.name)} ${r.all ? `<span class="muted" title="${esc(a.admins)}">${esc(a.admins ? a.admins.split(',')[0] : '')}</span>` : `<span class="muted">(${a.role === 'SO' ? 'správce' : 'zástupce'})</span>`}</td>${r.all ? `<td>${esc(a.owner)}</td>` : ''}<td>${esc(ap.name)}${ap.active ? '' : ' <span class="badge b-muted">neaktivní</span>'}</td><td class="num">${ap.total - ap.members}</td><td class="num">${ap.members}</td><td class="num">${ap.imported ? `<b>${ap.imported}</b>` : '<span class="muted">0</span>'}</td></tr>`).join('')).join('')}</tbody></table></div>
          ${sumHtml(r.lastImport)}
          <div class="row" style="margin-top:8px"><button class="primary" id="udbgo" ${state.discovery && !state.discovery.finishedAt ? 'disabled' : ''}>⇩ Načíst vybraná APčka</button> <span class="hint">loginy se ověří skenem na serveru, u větších oblastí to trvá pár minut</span></div>`;
        $('#apall').onchange = (e) => box.querySelectorAll('.apsel').forEach(c => { c.checked = e.target.checked; });
        $('#udbgo').onclick = async () => {
          const aps = [...box.querySelectorAll('.apsel:checked')].map(c => +c.value);
          if (!aps.length) return toast('zaškrtni aspoň jedno APčko', true);
          $('#udbgo').disabled = true;
          try {
            state.scanProg = null;
            await api('/userdb/import' + forUser, { method: 'POST', body: { aps, all: allMode } });
            // import běží na pozadí (stahování loginů z userdb) → ptát se na stav, dokud neskončí
            let ph = $('#udbphase'); if (!ph) { ph = document.createElement('div'); ph.id = 'udbphase'; ph.className = 'hint'; ph.style.margin = '8px 0'; $('#udbgo').insertAdjacentElement('afterend', ph); }
            const statusUrl = '/userdb/import-status' + (allMode ? '?all=1' : forUser);
            for (let i = 0; i < 3600; i++) {
              const x = await api(statusUrl);
              const sm = x.summary;
              if (sm && sm.error) { ph.innerHTML = `<span class="err">import selhal: ${esc(sm.error)}</span>`; break; }
              if (sm && !sm.running) { ph.remove(); state.discovery = x.discovery; toast(`z userdb: ${sm.entries} nových do skenu, ${sm.updated} doplněno`); const r2 = $('#discres'); if (r2) r2.innerHTML = discoveryHtml(state.discovery); $('#udbgo').insertAdjacentHTML('afterend', sumHtml(sm)); break; }
              ph.textContent = `⏳ ${sm ? sm.phase || 'probíhá' : 'probíhá'}${sm && sm.progress ? ` ${sm.progress}` : ''}…`;
              await new Promise(r3 => setTimeout(r3, 2000));
            }
          }
          catch (e) { toast(e.message, true); }
          finally { const g = $('#udbgo'); if (g) g.disabled = false; }
        };
      };
      $('#udbload').onclick = load;
      if (md.user) load(); // správce otevřel import za jiného uživatele → rovnou načíst
    }
  } else if (md.type === 'edit') {
    const d = state.devices.find(x => x.id === md.id); if (!d) return closeModal();
    const adv = state.advanced;
    bg.innerHTML = `<div class="modal"><h2>Upravit ${esc(d.name || d.identity || d.host)}</h2><form id="editf" class="form">
      <label>IP adresa<input name="host" value="${esc(d.host)}" required></label>${adv ? `<label>port<input name="port" type="number" value="${d.port}"></label>` : `<input type="hidden" name="port" value="${d.port}">`}<label>uživatel<input name="username" value="${esc(d.username)}" required></label><label>nové heslo (prázdné = ponechat)<input name="password" type="password"></label>
      <label>název<input name="name" value="${esc(d.name)}"></label>${adv ? `<label>priorita<input name="priority" type="number" value="${d.priority}"></label>` : `<input type="hidden" name="priority" value="${d.priority}">`}
      ${adv ? `<label>track<select name="track">${state.tracks.map(t => `<option value="${t}" ${t === d.track ? 'selected' : ''}>${t === 'v6-long-term' ? 'v6-long-term (zůstat na v6)' : t === 'hold' ? 'hold (nikdy neupgradovat)' : t}</option>`).join('')}</select></label>` : `<input type="hidden" name="track" value="${esc(d.track)}">`}
      <input type="hidden" name="stay_v6_init" value="${d.track === 'v6-long-term' ? '1' : '0'}"><label class="check"><input type="checkbox" name="stay_v6" ${d.track === 'v6-long-term' ? 'checked' : ''}> zůstat na v6 (neupgradovat na sedmičku, jen poslední 6.49.x)</label>
      <label>nadřazený prvek (napájí / připojuje toto zařízení)<select name="parent_id">${parentOptions(d.parent_id, d.id)}</select></label>
      ${state.admin && state.users ? `<label>vlastník (kdo zařízení vidí)<select name="owner_id">${state.users.map(u => `<option value="${u.id}" ${u.id === d.owner_id ? 'selected' : ''}>${esc(u.name)}${u.role === 'admin' ? ' (správce)' : ''}</option>`).join('')}</select></label>` : ''}
      ${adv ? `<label class="wide">poznámka<input name="notes" value="${esc(d.notes)}"></label>` : `<input type="hidden" name="notes" value="${esc(d.notes)}">`}
      <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}> zapnuto (vypnuté se neskenuje ani neupgraduje)</label>
      <label class="check"><input type="checkbox" name="ignore_poe" ${d.ignore_poe ? 'checked' : ''}> ignorovat PoE ovladatelnost (neověřovat, že PoE prvek nad zařízením je pod kontrolou)</label>
      ${d.no_v7 && d.no_v7.length && !d.no_v7_hard ? `<label class="check"><input type="checkbox" name="allow_v7" ${d.allow_v7 ? 'checked' : ''}> povolit v7 i přes doporučení — na vlastní riziko <span class="muted">(${esc(d.no_v7[0].split(':')[0])})</span></label>` : d.no_v7_hard ? `<div class="hint">v7 pro tenhle hardware neexistuje (${esc(d.no_v7[0].split(':')[0])})</div>` : ''}
      ${d.suggested_parent && d.suggested_parent.via ? `<div class="wide muted">detekovaný uplink: ${esc(d.suggested_parent.via)} → ${esc(d.suggested_parent.identity || '')} ${esc(d.suggested_parent.address || '')}${d.suggested_parent.id ? ` = <b>${esc(d.suggested_parent.name)}</b>` : ' (není v seznamu)'}</div>` : ''}
      <div class="wide row"><button class="primary">Uložit</button>${state.admin ? '<button type="button" id="showpw">ukázat heslo</button>' : ''}<button type="button" id="resethk" title="po netinstallu/výměně zařízení">reset SSH host key</button><span style="flex:1"></span><button type="button" class="danger" id="del">Smazat zařízení</button><button type="button" id="mclose">Zavřít</button></div></form></div>`;
    $('#editf').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.enabled = !!b.enabled; b.allow_v7 = !!b.allow_v7; b.ignore_poe = !!b.ignore_poe; { const was = b.stay_v6_init === '1', now = !!b.stay_v6; if (now !== was) b.track = now ? 'v6-long-term' : 'v7-stable'; else if (!adv && now) b.track = 'v6-long-term'; } delete b.stay_v6; delete b.stay_v6_init; b.parent_id = +b.parent_id; b.port = +b.port; b.priority = +b.priority; if ('owner_id' in b) b.owner_id = +b.owner_id; if (!b.password) delete b.password; try { await api(`/devices/${d.id}`, { method: 'PUT', body: b }); toast('uloženo'); closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
    const sp = $('#showpw'); if (sp) sp.onclick = async () => { const r = await api(`/devices/${d.id}/password`); alert(`Heslo: ${r.password}`); };
    $('#resethk').onclick = async () => { await api(`/devices/${d.id}/reset-hostkey`, { method: 'POST' }); toast('host key smazán, skenuji'); };
    const delb = $('#del'); if (delb) delb.onclick = async () => { if (!confirm(`Smazat ${d.host} včetně historie a záloh z evidence?`)) return; try { await api(`/devices/${d.id}`, { method: 'DELETE' }); state.selected.delete(d.id); closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
  } else if (md.type === 'detail') {
    const { device: d, history, backups, log, plan } = md.data;
    const vs = verStatus(d);
    const fl = d.flags || {};
    const flagTxt = [fl.wireless ? `wireless ${fl.wireless}` : '', fl.wifi ? `wifi ${fl.wifi}` : '', fl.bgp ? `BGP ${fl.bgp}` : '', fl.ospf ? `OSPF ${fl.ospf}` : '', fl.routing_filter ? `filtry ${fl.routing_filter}` : '', fl.mpls ? 'MPLS' : '', fl.capsman ? 'CAPsMAN' : '', fl.caps_client ? 'CAP' : '', fl.flash_dir ? 'flash/ dir' : '', fl.platform ? fl.platform : ''].filter(Boolean).join(' · ');
    bg.innerHTML = `<div class="modal"><h2>${esc(d.name || d.identity || d.host)} <span class="badge ${vs.cls}">${esc(vs.txt)}</span></h2>
      <div class="grid2"><div>
        <table><tr><th>Host</th><td class="mono">${esc(d.host)}:${d.port} (${esc(d.username)})</td></tr><tr><th>Identita</th><td>${esc(d.identity)}</td></tr><tr><th>Model</th><td>${esc(d.board_name)} ${d.model && d.model !== d.board_name ? `(${esc(d.model)})` : ''} · ${esc(d.arch)} · SN ${esc(d.serial)}</td></tr>
        <tr><th>RouterOS</th><td class="mono">${esc(d.version)} ${esc(d.channel)} → cíl ${esc(targetOf(d) || 'hold')} (${esc(trackOf(d))}${trackOf(d) !== d.track ? `, nastaveno ${esc(d.track)} — hardware bez v7` : ''})</td></tr><tr><th>Firmware</th><td class="mono">${esc(d.fw_current)} ${d.fw_upgrade && d.fw_upgrade !== d.fw_current ? `→ ${esc(d.fw_upgrade)}` : '✓'}</td></tr>
        <tr><th>Flash / RAM</th><td>${mb(d.free_hdd)} / ${mb(d.total_hdd)} MB · ${mb(d.free_mem)} / ${mb(d.total_mem)} MB</td></tr><tr><th>Uptime / CPU</th><td>${upt(d.uptime_sec)} · ${d.cpu_load} %</td></tr>
        <tr><th>Balíčky</th><td style="white-space:normal">${(d.packages || []).map(p => `<span class="chip" style="${p.disabled ? 'opacity:.5' : ''}">${esc(p.name)} ${esc(p.version)}</span>`).join(' ')}</td></tr>
        <tr><th>Příznaky</th><td style="white-space:normal">${esc(flagTxt) || '—'}</td></tr>
        ${fl.device_mode ? `<tr><th>Device-mode</th><td style="white-space:normal">${esc(fl.device_mode.mode)} · partitions ${fl.device_mode.partitions === null ? '?' : fl.device_mode.partitions ? 'ano' : 'ne'} · fetch ${fl.device_mode.fetch === null ? '?' : fl.device_mode.fetch ? 'ano' : 'ne'}${fl.device_mode.attempts ? ` · pokusy ${fl.device_mode.attempts}/3` : ''}</td></tr>` : ''}
        <tr><th>Topologie</th><td style="white-space:normal">nadřazený: <b>${esc(devName(state.devices.find(x => x.id === d.parent_id)) || '—')}</b>${fl.uplink ? `<div class="muted">uplink ${esc(fl.uplink.iface || '?')} → gw ${esc(fl.uplink.gateway || '')}${fl.uplink.neighbor ? `, soused ${esc(fl.uplink.neighbor.identity || '')} ${esc(fl.uplink.neighbor.address || '')} (${esc(fl.uplink.neighbor.board || '')})` : ''}</div>` : ''}${(fl.poe_ports || []).length ? `<div class="muted">PoE-out porty: ${fl.poe_ports.map(p => esc(p.name)).join(', ')}${(fl.poe_children || []).length ? ` · napájí: ${fl.poe_children.map(c => `${esc(c.iface)} → ${esc(c.identity || c.address)}`).join(', ')}` : ''}</div>` : ''}${state.devices.filter(x => x.parent_id === d.id).length ? `<div>podřízené: ${state.devices.filter(x => x.parent_id === d.id).map(x => esc(devName(x))).join(', ')}</div>` : ''}</td></tr>
        <tr><th>Sken</th><td style="white-space:normal">${badge(STATUS_LABEL, d.scan_status)} ${esc(d.scan_error)} <span class="muted">(${fmtTs(d.last_scan_at)})</span></td></tr>
        ${d.notes ? `<tr><th>Poznámka</th><td style="white-space:normal">${esc(d.notes)}</td></tr>` : ''}</table>
        <h3 style="font-size:14px">Plán upgradu <span class="muted">(z posledního skenu)</span> <select id="planmode" class="small"><option value="upload">režim upload</option><option value="router">režim router</option></select></h3>
        <div id="planbox">${plan ? planHtml(plan) : '<span class="muted">načítám…</span>'}</div>
        </div><div>
        <h3 style="font-size:14px;margin-top:0">Historie verzí</h3><table>${history.map(h => `<tr><td>${fmtTs(h.seen_at)}</td><td class="mono"><b>${esc(h.version)}</b> fw ${esc(h.firmware)}</td><td class="muted">${esc(h.source)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table>
        <h3 style="font-size:14px">Zálohy</h3><table>${backups.map(b => `<tr><td>${fmtTs(b.created_at)}</td><td>${esc(b.kind)} <span class="muted">${esc(b.version)}</span></td><td>${(b.size / 1024).toFixed(1)} kB</td><td><a href="${BASE}/api/backups/${b.id}">stáhnout</a></td></tr>`).join('') || '<tr><td class="muted">zatím žádné</td></tr>'}</table>
        <h3 style="font-size:14px">Log z jobů</h3><div class="log" style="height:220px">${log.map(logLine).join('') || '<span class="muted">—</span>'}</div>
        </div></div>
      <div class="row" style="margin-top:10px"><button id="mscan">⟳ Skenovat</button><button id="medit">✎ Upravit</button><button id="mjob" class="ok">▶ Job jen pro toto zařízení</button>${canRepartition(d) && state.admin ? `<button id="mrepart" title="rozdělí flash na 2 oddíly = automatický fallback při nenabootování po upgradu">⛁ Rozdělit flash na 2 oddíly</button>` : ''}<span style="flex:1"></span><button id="mclose">Zavřít</button></div></div>`;
    $('#mscan').onclick = async () => { toast('skenuji…'); try { const r = await api(`/devices/${d.id}/scan`, { method: 'POST' }); if (!r.ok) toast(r.error || r.skipped, true); await openDetail(d.id); } catch (e) { toast(e.message, true); } };
    $('#medit').onclick = () => openModal({ type: 'edit', id: d.id });
    $('#mjob').onclick = () => openModal({ type: 'newjob', ids: [d.id] });
    const rp = $('#mrepart'); if (rp) rp.onclick = async () => {
      if (!confirm(`Rozdělit flash zařízení ${devName(d)} (${d.host}) na 2 oddíly?\n\nCo se stane:\n• uloží se export konfigurace a .backup na server\n• spustí se /partitions repartition 2\n• router zformátuje flash mimo běžící systém a RESTARTUJE SE (výpadek 1–3 min, podřízená zařízení krátce vypadnou)\n• soubory na routeru (zálohy, skripty v souborech) budou smazány, konfigurace zůstane\n\nOd RouterOS 7.17 to vyžaduje device-mode partitions=yes; pokud není, job se zastaví s návodem.`)) return;
      try { const r = await api(`/devices/${d.id}/repartition`, { method: 'POST', body: { count: 2 } }); closeModal(); await loadState(); await openJob(r.jobId); } catch (e) { toast(e.message, true); }
    };
    const l = bg.querySelector('.log'); if (l) l.scrollTop = l.scrollHeight;
  } else if (md.type === 'newjob') {
    const devs = md.ids.map(id => state.devices.find(d => d.id === id)).filter(Boolean);
    const adv = state.advanced;
    const skipped = devs.filter(d => !needsUpgrade(d));
    bg.innerHTML = `<div class="modal"><h2>Upgrade — ${devs.length} zařízení</h2>
      <div class="hint" style="margin-bottom:8px">Po spuštění se nejdřív všechna zařízení zkontrolují. Když je vše v pořádku, upgrade jede sám; jinak se ukáže, co se přeskočí, a počká na tvoje potvrzení. Zařízení se upgradují jedno po druhém, nejdřív koncová, nakonec ta, která ostatní napájí. Před každým se uloží záloha, po restartu se vše ověří. Při chybě se to zastaví a čeká na tebe.</div>
      <div style="max-height:180px;overflow:auto;margin-bottom:10px" class="mono">${devs.map(d => ({ d, depth: depthOf(d) })).sort((a, b) => b.depth - a.depth).map(({ d }) => { const ps = plainStatus(d); const par = state.devices.find(x => x.id === d.parent_id); return `<div>${esc(devName(d))} <span class="muted">${esc(d.host)} · ${esc(d.board_name)}</span> · ${esc(d.version || '?')} <span class="badge ${ps.cls}">${esc(ps.txt)}</span>${par ? ` <span class="muted">← ${esc(devName(par))}</span>` : ''}</div>`; }).join('')}</div>
      ${skipped.length ? `<div class="hint" style="margin-bottom:8px">${skipped.length} z vybraných nic nepotřebuje nebo není dostupné — přeskočí se.</div>` : ''}
      <form id="jobf" class="form"><label class="wide">název<input name="name" value="${esc(defaultJobName(devs))}"></label>
        ${adv ? `
        <label class="check"><input type="checkbox" name="firmware" checked> po upgradu i firmware RouterBOOT (+1 restart)</label>
        <label class="check"><input type="checkbox" name="stop_on_failure" checked> zastavit při první chybě</label>
        <label class="check"><input type="checkbox" name="canary"> kanárci: nejdřív 1 zařízení od každého modelu, pak čekat na potvrzení</label>
        <label class="check"><input type="checkbox" name="require_binary_backup"> vyžadovat i binární .backup (jinak stačí .rsc export)</label>
        <label class="check"><input type="checkbox" name="device_mode" checked> device-mode plné ovládání (potvrzení PoE restartem přes nadřazený MikroTik)</label>
        <label class="check"><input type="checkbox" name="precheck" checked> nejdřív zkontrolovat všechna zařízení; při přeskočení/upozornění počkat na potvrzení</label>
        <label>režim<select name="mode"><option value="upload">upload — server nahraje balíčky přes SFTP (doporučeno)</option><option value="router">router — vlastní updater routeru (potřebuje internet)</option></select></label>
        <label>spustit v (datum i čas; prázdné = hned)<input name="start_at" type="datetime-local" min="${localDt(Date.now())}"></label>
        <label>pauza mezi zařízeními (s)<input name="pause_sec" type="number" value="${esc(state.settings.pause_between_devices_sec)}"></label>
        <label class="check"><input type="checkbox" name="allow_routing_migration"> povolit v6→v7 i s BGP/OSPF/filtry (jen pro tento job)</label>
        <label class="check"><input type="checkbox" name="allow_small_flash"> povolit v6→v7 na 16 MB flash (jen pro tento job)</label>` : `
        <label>spustit v (datum i čas; prázdné = hned)<input name="start_at" type="datetime-local" min="${localDt(Date.now())}"></label>`}
        <div class="wide row"><button class="primary" name="go" value="start">▶ Spustit upgrade</button><button name="go" value="check">Jen zkontrolovat (nic se nezmění)</button>${adv ? '<button name="go" value="create">Jen vytvořit</button>' : ''}<button type="button" id="mclose">Zavřít</button></div></form></div>`;
    $('#jobf').onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); const go = e.submitter && e.submitter.value;
      const o = { dry_run: go === 'check', firmware: adv ? !!fd.get('firmware') : true, stop_on_failure: adv ? !!fd.get('stop_on_failure') : true, canary: !!fd.get('canary'), require_binary_backup: adv ? !!fd.get('require_binary_backup') : false, device_mode: adv ? !!fd.get('device_mode') : true, precheck: adv ? !!fd.get('precheck') : true, allow_routing_migration: adv ? !!fd.get('allow_routing_migration') : false, allow_small_flash: adv ? !!fd.get('allow_small_flash') : false, mode: adv ? fd.get('mode') : 'upload', start_at: fd.get('start_at') || '', pause_sec: adv ? +fd.get('pause_sec') : undefined };
      if (o.start_at && new Date(o.start_at).getTime() < Date.now() - 60000) return toast(`čas spuštění ${new Date(o.start_at).toLocaleString('cs-CZ')} je v minulosti — pro dnešní noc vyber zítřejší datum`, true);
      const start = go === 'start' || go === 'check';
      if (go === 'start' && !confirm(o.start_at ? `Naplánovat upgrade ${devs.length} zařízení na ${new Date(o.start_at).toLocaleString('cs-CZ')}?` : `Spustit upgrade ${devs.length} zařízení hned?\n\nNejdřív proběhne kontrola. Pak se každé zařízení zálohuje, nahraje, ověří a restartuje (chvíli bude nedostupné).`)) return;
      try { const r = await api('/jobs', { method: 'POST', body: { name: fd.get('name'), deviceIds: devs.map(d => d.id), options: o, start } }); if (r.queued) toast(`zařazeno do fronty, spustí se po dokončení jobu #${r.behind}`); closeModal(); state.selected.clear(); await loadState(); await openJob(r.id); } catch (e2) { toast(e2.message, true); } };
  }
  const c = $('#mclose'); if (c) c.onclick = closeModal;
}
function localDt(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function defaultJobName(devs) {
  const date = new Date().toLocaleDateString('cs-CZ');
  if (devs.length === 1) return `Upgrade ${devName(devs[0])} (${devs[0].host}) ${date}`;
  const names = devs.slice(0, 3).map(devName);
  const groups = [...new Set(devs.map(d => d.group_name).filter(Boolean))];
  const where = groups.length === 1 ? `skupina ${groups[0]}` : names.join(', ') + (devs.length > 3 ? ` +${devs.length - 3}` : '');
  return `Upgrade ${devs.length}× ${where} ${date}`;
}
function canRepartition(d) { const f = d.flags || {}; return d.managed && d.enabled && d.scan_status === 'ok' && f.routerboard && d.total_hdd >= 128 * MB && (f.partitions || 0) < 2 && !state.runner.running; }
function depthOf(d) { let n = 0, cur = d; const seen = new Set(); while (cur && cur.parent_id && !seen.has(cur.id) && n < 50) { seen.add(cur.id); cur = state.devices.find(x => x.id === cur.parent_id); n++; } return n; }
function parentOptions(sel, selfId = 0) {
  const list = state.devices.filter(d => d.id !== selfId).sort((a, b) => devName(a).localeCompare(devName(b)));
  const cur = sel ? state.devices.find(d => d.id === sel) : null; const self = selfId ? state.devices.find(d => d.id === selfId) : null;
  const foreign = sel && !cur && self && self.parent_foreign ? `<option value="${sel}" selected>${esc(self.parent_foreign.name)} — zařízení jiného uživatele${self.parent_foreign.user ? ` (${esc(self.parent_foreign.user)})` : ''}</option>` : '';
  return `<option value="0" ${!sel ? 'selected' : ''}>— žádný —</option>` + foreign + list.map(d => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(devName(d))} (${esc(d.host)})${d.managed ? '' : ' [neřízený]'}</option>`).join('');
}
function scanProgHtml() {
  const p = state.scanProg; if (!p) return '';
  if (p.done < p.total) return `<div style="margin:8px 0"><b>⏳ Kontrola zařízení a topologie:</b> ${p.done}/${p.total} <span class="muted">(verze, model, sousedé, rodič — po dokončení se seznam seřadí jako strom)</span><div class="progress" style="margin:6px 0"><div style="width:${p.total ? p.done / p.total * 100 : 0}%"></div></div></div>`;
  const devs = (p.ids || []).map(id => state.devices.find(d => d.id === id)).filter(Boolean);
  const withParent = devs.filter(d => d.parent_id).length, unreachable = devs.filter(d => d.scan_status && d.scan_status !== 'ok').length;
  return `<div style="margin:8px 0"><b>✔ Kontrola zařízení a topologie hotová:</b> ${p.total} zařízení, rodič určen u ${withParent}${unreachable ? `, ${unreachable} nedostupných nebo s chybou` : ''} <span class="muted">— kde rodič chybí, nastav ho tužkou ✎ nebo použij „Přebrat detekované rodiče“</span></div>`;
}
function discoveryHtml(st) {
  if (!st || st.total === undefined) return '<span class="muted">Zatím žádný sken. Zadej adresy nebo rozsah a aspoň jeden login.</span>';
  st = { found: [], authFailed: [], errors: [], foreign: [], notRouterOS: [], ...st };
  if (st.queued) return `<div>⏳ <b>Ve frontě</b>${st.position > 1 ? ` (pořadí ${st.position})` : ''}: právě běží sken jiného uživatele, tenhle se spustí hned po něm (${st.total} adres${st.label ? `, ${esc(st.label)}` : ''}).</div>`;
  const running = !st.finishedAt;
  return `<div>${running ? '⏳ běží' : '✔ hotovo'}${st.label ? ` (${esc(st.label)})` : ''}: ${st.done}/${st.total} adres, ${st.open} s otevřeným SSH, <b>${st.added} nových založeno</b>, ${st.existing} už v seznamu, ${st.foreign.length ? `<b style="color:var(--err)">${st.foreign.length} u jiného uživatele</b>, ` : ''}${st.authFailed.length} bez platného loginu, ${st.notRouterOS.length ? `${st.notRouterOS.length} není RouterOS, ` : ''}${st.errors.length} chyb</div>
    <div class="progress" style="margin:6px 0"><div style="width:${st.total ? st.done / st.total * 100 : 0}%"></div></div>
    ${st.finishedAt && st.added ? scanProgHtml() : ''}
    ${st.found.length ? `<details open><summary>nalezené (${st.found.length})</summary><div class="mono" >${st.found.map(f => `<div>${esc(f.host)} ${esc(f.identity || '')} ${esc(f.board || '')} ${esc(f.version || '')}${f.existing ? ' <span class="muted">(už v seznamu)</span>' : ''}</div>`).join('')}</div></details>` : ''}
    ${st.foreign.length ? `<details open><summary>už má u sebe jiný uživatel (${st.foreign.length})</summary><div class="mono" >${st.foreign.map(esc).join('<br>')}</div></details>` : ''}
    ${st.notRouterOS.length ? `<details open><summary>SSH otevřené, ale není to RouterOS (${st.notRouterOS.length})</summary><div class="mono" >${st.notRouterOS.map(esc).join('<br>')}</div></details>` : ''}
    ${st.authFailed.length ? `<details open><summary>SSH otevřené, login neprošel (${st.authFailed.length})</summary><div class="mono" >${st.authFailed.map(esc).join('<br>')}</div></details>` : ''}
    ${st.errors.length ? `<details open><summary>chyby / nedostupné (${st.errors.length}) — „port 22 neodpovídá“ bývá zařízení bez SSH nebo jiná značka než MikroTik</summary><div class="mono" >${st.errors.map(esc).join('<br>')}</div></details>` : ''}`;
}
function planHtml(p) {
  return `<div>${p.blockers.length ? `<b style="color:var(--err)">Blokováno:</b><ul class="plain blocklist">${p.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : p.nothingToDo ? '<span class="badge b-ok">nic k dělání — aktuální</span>' : ''}
    ${p.hops.map(h => `<div>hop <b class="mono">${esc(h.from)} → ${esc(h.to)}</b>${h.majorJump ? ' <span class="badge b-v6">v6→v7</span>' : ''}${h.via ? ' <span class="badge b-muted">mezikrok</span>' : ''}${p.mode === 'router' && h.channel ? ` <span class="badge b-muted">kanál ${esc(h.channel)}</span>` : ''}: ${(h.packages || []).map(x => `<span class="chip">${esc(x.file)} ${(x.size / MB).toFixed(1)} MB</span>`).join(' ')} <span class="muted">potřeba ${mb(h.needBytes)} MB, k dispozici ${mb(h.freeBytes)} MB ${h.stagingArea === 'ram' ? 'RAM' : 'flash'}</span></div>`).join('')}
    ${p.firmware ? `<div>firmware <b class="mono">${esc(p.firmware.current)} → ${esc(p.firmware.upgrade)}</b></div>` : ''}
    ${p.warnings.length ? `<ul class="plain warnlist">${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${p.target ? `<details><summary>changelog ${esc(p.target)}</summary><div class="chg" data-ver="${esc(p.target)}">načítám…</div></details>` : ''}</div>`;
}
async function openDetail(id, mode = 'upload') {
  const data = await api(`/devices/${id}`);
  openModal({ type: 'detail', data });
  const pm = $('#planmode'); if (pm) { pm.value = mode; pm.onchange = () => loadPlan(id, pm.value); }
  await loadPlan(id, mode);
}
async function loadPlan(id, mode) {
  try { const plan = await api(`/devices/${id}/plan?mode=${mode}`); if (state.modal && state.modal.type === 'detail' && state.modal.data.device.id === id) { state.modal.data.plan = plan; const pb = $('#planbox'); if (pb) { pb.innerHTML = planHtml(plan); const det = pb.querySelector('details'); if (det) det.ontoggle = async () => { const c = det.querySelector('.chg'); if (det.open && c.textContent === 'načítám…') c.textContent = await api('/changelog/' + c.dataset.ver); }; } } } catch (e) { const pb = $('#planbox'); if (pb) pb.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`; }
}

// ---------- data / SSE ----------
// SSE událostí chodí hodně (každý krok každého jobu) → celý stav se stahuje nejvýš jednou za 2,5 s
let reloadT = null, renderT = null;
/** překreslení seznamu nejvýš jednou za sekundu (při hromadné kontrole chodí událost za každé zařízení) */
function renderSoon() { if (renderT) return; renderT = setTimeout(() => { renderT = null; if (!state.modal) render(); }, 1000); }
function scheduleReload() { if (reloadT) return; reloadT = setTimeout(async () => { reloadT = null; try { await loadState(); } catch {} render(); }, 2500); }
async function loadState() {
  try { const w = await api('/whoami'); if (w && w.serverStartedAt) { state.auth.serverStartedAt = w.serverStartedAt; state.auth.draining = !!w.draining; if (w.sourceIp) state.auth.sourceIp = w.sourceIp; } } catch {}
  const s = await api('/state');
  Object.assign(state, { devices: s.devices, jobs: s.jobs, latest: s.latest, settings: s.settings, settingsOwn: s.settingsOwn || {}, settingsGlobal: s.settingsGlobal, runner: s.runner, tracks: s.tracks, scanning: s.scanning, discovery: s.discovery, admin: s.admin, auth: { ...state.auth, user: s.user } });
  if (s.admin) { try { state.users = await api('/users'); } catch { state.users = null; } }
  // správce: výchozí pohled = vlastní zařízení; ruční přepnutí na jiného vlastníka si pamatuje prohlížeč
  if (s.admin && s.user && state.ownerInit !== s.user.id) { state.ownerInit = s.user.id; let saved = null; try { saved = localStorage.getItem('mtu_owner'); } catch {} state.owner = saved !== null && saved !== '' ? +saved : s.user.id; }
  try { state.stats = await api('/stats'); } catch { state.stats = null; }
}
let es;
function connectSSE() {
  if (es) es.close();
  es = new EventSource(BASE + '/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'device') { const i = state.devices.findIndex(d => d.id === ev.device.id); if (i >= 0) state.devices[i] = { ...ev.device, suggested_parent: state.devices[i].suggested_parent }; else state.devices.push(ev.device); state.scanning = state.scanning.filter(x => x !== ev.device.id); if (state.view === 'devices') renderSoon(); }
    else if (ev.type === 'device-deleted') { state.devices = state.devices.filter(d => d.id !== ev.id); state.selected.delete(ev.id); if (!state.modal) render(); }
    else if (ev.type === 'job' && ev.job) { const i = state.jobs.findIndex(j => j.id === ev.job.id); if (i >= 0) state.jobs[i] = ev.job; else state.jobs.unshift(ev.job); if (state.job && state.job.job.id === ev.job.id) { state.job.job = { ...state.job.job, ...ev.job }; } if (state.view === 'jobs') render(); }
    else if (ev.type === 'item' && state.job && ev.item.job_id === state.job.job.id) { const i = state.job.items.findIndex(x => x.id === ev.item.id); if (i >= 0) state.job.items[i] = { ...state.job.items[i], ...ev.item }; if (state.view === 'jobs') renderJobDetail(); }
    else if (ev.type === 'log' && state.job && ev.log.job_id === state.job.job.id) { state.jobLog.push(ev.log); const l = $('#joblog'); if (l) { const p = $('#joblogprog'); if (p) p.remove(); const atBottom = LOGFOLLOW; l.insertAdjacentHTML('beforeend', logLine(ev.log, logNames(state.job.items))); const d = +l.dataset.dev || 0; if (d && ev.log.device_id && ev.log.device_id !== d) l.lastElementChild.classList.add('od'); if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight); } }
    else if (ev.type === 'progress' && state.job && ev.job_id === state.job.job.id) { const l = $('#joblog'); if (l) { let p = $('#joblogprog'); if (!p) { p = document.createElement('div'); p.id = 'joblogprog'; p.className = 'info'; l.appendChild(p); } p.textContent = `${new Date().toLocaleTimeString('cs-CZ')} ${ev.text}`; const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200; if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight); } }
    else if (ev.type === 'runner') { scheduleReload(); }
    else if (ev.type === 'discovery' || ev.type === 'discovery-done') { state.discovery = ev.state; const r = $('#discres'); if (r) r.innerHTML = discoveryHtml(ev.state); if (ev.type === 'discovery-done') { toast(`sken rozsahu hotov: ${ev.state.added} nových zařízení`); loadState().then(() => { if (state.modal && state.modal.type === 'discover') renderModal(); else render(); }); } }
    else if (ev.type === 'discovery-error') toast('sken rozsahu: ' + ev.error, true);
    else if (ev.type === 'scan-progress' && ev.tag === 'discovery') { state.scanProg = { done: ev.done, total: ev.total, ids: ev.ids }; const r = $('#discres'); if (r && state.discovery) r.innerHTML = discoveryHtml(state.discovery); }
    else if (ev.type === 'scan-done' && ev.tag === 'discovery' && state.scanProg) { state.scanProg = { ...state.scanProg, done: state.scanProg.total, ids: ev.ids || state.scanProg.ids }; loadState().then(() => { render(); const r = $('#discres'); if (r && state.discovery) r.innerHTML = discoveryHtml(state.discovery); }); }
    else if (ev.type === 'devices-changed') scheduleReload();
    else if (ev.type === 'latest') { state.latest = ev.latest; render(); }
    else if (ev.type === 'scan-done') { toast(`sken hotov (${ev.count} zařízení)`); scheduleReload(); }
  };
  es.onerror = () => { setTimeout(() => { if (state.authed) connectSSE(); }, 5000); };
}
(async () => {
  try { const w = await api('/whoami'); state.authed = w.authed; state.netHint = w.netHint || '192.0.2'; state.auth = { sso: w.sso, passwordLogin: w.passwordLogin, registration: w.registration, user: w.user, userdb: w.userdb || { enabled: false }, serverStartedAt: w.serverStartedAt || 0, sourceIp: w.sourceIp || (window.MTU_LOCAL || {}).sourceIp || '', draining: !!w.draining }; } catch { state.authed = false; }
  if (state.authed) { await loadState(); connectSSE(); }
  render();
  setInterval(() => { if (state.authed && state.view === 'devices' && !state.modal) render(); }, 60000);
  setInterval(async () => { if (!state.authed) return; try { state.stats = await api('/stats'); const el = document.querySelector('.stats'); if (el) el.outerHTML = statsStrip(); } catch {} }, 30000);
})();
