'use strict';
const BASE = location.pathname.replace(/\/[^/]*$/, '');
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MB = 1048576;
let ADV = false; try { ADV = localStorage.getItem('mtu_adv') === '1'; } catch {}
const state = { authed: false, view: 'devices', advanced: ADV, devices: [], jobs: [], latest: { versions: {} }, settings: {}, runner: {}, tracks: [], selected: new Set(), filter: '', group: '', sort: 'priority', modal: null, job: null, jobLog: [], detail: null, scanning: [] };

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
function targetOf(d) { return d.track === 'hold' ? null : (state.latest.versions[d.track] || {}).version || null; }
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
const JOB_LABEL = { queued: ['b-muted', 'připraven'], running: ['b-info', 'probíhá'], paused: ['b-err', 'zastaven'], waiting: ['b-warn', 'čeká na potvrzení'], 'waiting-window': ['b-warn', 'čeká na okno'], done: ['b-ok', 'hotovo'], cancelled: ['b-muted', 'zrušen'] };
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
  if (!state.authed) { app.innerHTML = `<div class="login panel"><h2>MikroTik upgrader</h2><p>Bezpečný hromadný upgrade RouterOS.</p><form id="loginf"><input type="password" id="pw" placeholder="heslo" autofocus><button class="primary" style="width:100%">Přihlásit</button></form></div>`;
    $('#loginf').onsubmit = async (e) => { e.preventDefault(); try { await api('/login', { method: 'POST', body: { password: $('#pw').value } }); state.authed = true; await loadState(); connectSSE(); render(); } catch (e2) { toast(e2.message, true); } };
    return; }
  const running = state.runner.running;
  const rj = running ? state.jobs.find(j => j.id === state.runner.jobId) : null;
  const rd = running && state.runner.deviceId ? state.devices.find(d => d.id === state.runner.deviceId) : null;
  const navBtn = (v, ico, label) => `<button class="${state.view === v ? 'active' : ''}" data-view="${v}"><span class="ico">${ico}</span>${label}</button>`;
  app.innerHTML = `<div class="shell"><aside class="side">
    <div class="brand"><div class="mark">ROS</div><div><b>MikroTik upgrader</b><small>správa RouterOS</small></div></div>
    <nav>${navBtn('devices', '▤', 'Zařízení')}${navBtn('jobs', '▶', 'Upgrady')}${navBtn('settings', '⚙', 'Nastavení')}</nav>
    <div class="versions">${latestBar()}</div>
    <div class="spacer"></div>
    <div class="runner-pill ${running ? 'live' : ''}" id="runnerpill">${running ? `<span class="pulse"></span><b>běží job #${state.runner.jobId}</b>${rj ? ` ${esc(rj.name)}` : ''}${rd ? `<br>${esc(devName(rd))}` : ''}` : 'žádný job neběží'}</div>
    <label class="check advtoggle"><input type="checkbox" id="advtoggle" ${state.advanced ? 'checked' : ''}> Pokročilé zobrazení</label>
    <div class="foot"><button class="small" id="refreshver" title="obnovit verze z upgrade.mikrotik.com">↻ verze</button><button class="small" id="logout">Odhlásit</button></div>
  </aside><main id="main"></main></div>`;
  app.querySelectorAll('nav button').forEach(b => b.onclick = () => { state.view = b.dataset.view; render(); });
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); state.authed = false; render(); };
  $('#refreshver').onclick = async () => { state.latest = await api('/versions/refresh', { method: 'POST' }); toast('verze obnoveny'); render(); };
  $('#runnerpill').onclick = () => { if (running) openJob(state.runner.jobId); };
  $('#advtoggle').onchange = (e) => { state.advanced = e.target.checked; try { localStorage.setItem('mtu_adv', state.advanced ? '1' : '0'); } catch {} render(); };
  const m = $('#main');
  if (state.view === 'devices') renderDevices(m);
  else if (state.view === 'jobs') renderJobs(m);
  else renderSettings(m);
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
function filteredDevices() {
  const f = state.filter.toLowerCase();
  let list = state.devices.filter(d => (!state.group || d.group_name === state.group) && (!f || [d.host, d.name, d.identity, d.board_name, d.model, d.version, d.group_name, d.notes].join(' ').toLowerCase().includes(f)));
  const s = state.sort;
  list.sort((a, b) => {
    if (s === 'version') return cmpVer(a.version || '0.0', b.version || '0.0') || a.host.localeCompare(b.host);
    if (s === 'name') return (a.name || a.identity || a.host).localeCompare(b.name || b.identity || b.host);
    if (s === 'model') return (a.board_name || '').localeCompare(b.board_name || '') || a.host.localeCompare(b.host);
    if (s === 'seen') return (b.last_seen_at || 0) - (a.last_seen_at || 0);
    return a.priority - b.priority || (a.group_name || '').localeCompare(b.group_name || '') || a.host.localeCompare(b.host, undefined, { numeric: true });
  });
  return list;
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
  m.innerHTML = `<h1>Zařízení</h1><div class="fleet"><div class="head"><div class="count">${devs.length}<small>zařízení ve správě</small></div>
      <div class="row">${toUpgrade.length ? `<button class="primary" id="upall" ${running ? 'disabled title="právě běží job"' : ''}>▶ Upgradovat vše potřebné (${toUpgrade.length})</button>` : `<span class="hint">${devs.length ? 'Všechna dostupná zařízení jsou aktuální.' : 'Začni přidáním zařízení.'}</span>`}</div></div>
    <div class="bar">${segs.map(([k, , c]) => `<span style="width:${cnt[k] / total * 100}%;background:${c}" title="${cnt[k]}"></span>`).join('')}</div>
    <div class="legend">${segs.filter(([k]) => cnt[k]).map(([k, l, c]) => `<span><i class="sw" style="background:${c}"></i>${l} <b>${cnt[k]}</b></span>`).join('')}</div></div>
  <div class="panel"><div class="toolbar">
    <button id="addbtn">+ Přidat zařízení</button>
    <button id="discover">🔍 Najít v rozsahu</button>
    <button id="scanall">⟳ Zkontrolovat stav</button>
    ${adv ? `<button id="scansel" ${state.selected.size ? '' : 'disabled'}>⟳ Zkontrolovat vybrané (${state.selected.size})</button>
    <button id="acceptparents" title="u zařízení bez nadřazeného prvku nastaví toho, koho vidí jako souseda na uplinku">⇡ Přebrat detekované rodiče</button>` : ''}
    <button class="ok" id="jobsel" ${state.selected.size ? '' : 'disabled'}>▶ Upgradovat vybrané (${state.selected.size})</button>
    <button class="danger" id="delsel" ${state.selected.size ? '' : 'disabled'}>✕ Smazat vybrané (${state.selected.size})</button>
    <span class="spacer"></span>
    ${groups.length ? `<select id="group"><option value="">všechny skupiny</option>${groups.map(g => `<option ${g === state.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}
    <select id="sort"><option value="priority" ${state.sort === 'priority' ? 'selected' : ''}>řadit: priorita</option><option value="name" ${state.sort === 'name' ? 'selected' : ''}>název</option><option value="version" ${state.sort === 'version' ? 'selected' : ''}>verze</option><option value="model" ${state.sort === 'model' ? 'selected' : ''}>model</option><option value="seen" ${state.sort === 'seen' ? 'selected' : ''}>naposledy viděno</option></select>
    <input id="filter" placeholder="hledat…" value="${esc(state.filter)}" style="width:170px"></div>
  <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="selall" ${allSel ? 'checked' : ''}></th><th>Zařízení</th><th>Model</th><th>RouterOS</th><th>Stav</th>${adv ? '<th>Firmware</th><th>Flash · RAM volné</th><th>Nadřazený</th><th>Track</th><th>Sken</th>' : ''}<th></th></tr></thead><tbody>
  ${list.map(d => { const ps = plainStatus(d); const sc = STATUS_LABEL[d.scan_status] || ['b-muted', d.scan_status]; const scanning = state.scanning.includes(d.id); const busy = state.runner.deviceId === d.id;
    return `<tr class="${state.selected.has(d.id) ? 'selected' : ''} ${d.enabled ? '' : 'muted'}" data-id="${d.id}">
    <td><input type="checkbox" class="sel" data-id="${d.id}" ${state.selected.has(d.id) ? 'checked' : ''}></td>
    <td class="clickable detail name" data-id="${d.id}"><b>${esc(d.name || d.identity || d.host)}</b>${busy ? ' <span class="badge b-info">právě se upgraduje</span>' : ''}${d.enabled ? '' : ' <span class="badge b-muted">vypnuto</span>'}<span class="sub"><span class="mono">${esc(d.host)}${d.port !== 22 ? ':' + d.port : ''}</span>${d.group_name ? ` · ${esc(d.group_name)}` : ''}${d.name && d.identity && d.name !== d.identity ? ` · ${esc(d.identity)}` : ''}</span></td>
    <td>${esc(d.board_name || d.model)}${adv && d.arch ? `<span class="sub">${esc(d.arch)}</span>` : ''}</td>
    <td class="mono"><b>${esc(d.version || '—')}</b>${adv && d.channel ? ` <span class="muted">${esc(d.channel)}</span>` : ''}${adv && d.uptime_sec ? `<span class="sub" title="uptime">${upt(d.uptime_sec)}</span>` : ''}</td>
    <td>${scanning ? '<span class="badge b-info">kontroluji…</span>' : `<span class="badge ${ps.cls}" title="${esc(d.scan_error || '')}">${esc(ps.txt)}</span>`}</td>
    ${adv ? `<td class="mono">${esc(d.fw_current || '—')}${d.fw_upgrade && d.fw_current !== d.fw_upgrade ? ` <span class="badge b-warn" title="k dispozici ${esc(d.fw_upgrade)}">→${esc(d.fw_upgrade)}</span>` : ''}</td>
    <td>${d.total_hdd ? `<span title="flash volné / celkem">${mb(d.free_hdd)}/${mb(d.total_hdd)}</span>${d.flags && d.flags.flash_dir ? '<span class="muted" title="kořen FS v RAM, adresář flash">ᶠ</span>' : ''} <span class="muted">·</span> <span title="RAM volná / celkem">${mb(d.free_mem)}/${mb(d.total_mem)}</span> <span class="muted">MB</span>` : '—'}</td>
    <td class="parent">${parentCell(d)}</td>
    <td>${d.managed ? `<select class="track small" data-id="${d.id}">${state.tracks.map(t => `<option value="${t}" ${t === d.track ? 'selected' : ''}>${t.replace('long-term', 'LT')}</option>`).join('')}</select>` : '<span class="badge b-muted">neřízený</span>'}</td>
    <td>${!d.managed ? '<span class="muted">—</span>' : `<span class="badge ${sc[0]}" title="${esc(d.scan_error)}">${esc(sc[1])}</span> <span class="muted" title="naposledy viděno ${fmtTs(d.last_seen_at)}">${ago(d.last_seen_at)}</span>`}</td>` : ''}
    <td class="acts">${ps.act === 'upgrade' && !running ? `<button class="small ok up1" data-id="${d.id}">▶ Upgradovat</button>` : ''} ${ps.act === 'scan' ? `<button class="small scan1" data-id="${d.id}">⟳ Zkontrolovat</button>` : adv ? `<button class="small scan1" data-id="${d.id}" title="zkontrolovat">⟳</button>` : ''} <button class="small edit1" data-id="${d.id}" title="upravit">✎</button></td></tr>`; }).join('')}
  ${list.length ? '' : `<tr><td colspan="${adv ? 11 : 6}" class="empty">Zatím žádná zařízení. Přidej je jednotlivě, hromadně vložením řádků „host uživatel heslo", nebo je najdi v rozsahu sítě.</td></tr>`}
  </tbody></table></div></div>`;
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#addbtn', () => openModal({ type: 'add' }));
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
  $('#sort').onchange = (e) => { state.sort = e.target.value; render(); };
  $('#filter').oninput = (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; render(); const f = $('#filter'); f.focus(); f.setSelectionRange(pos, pos); };
  $('#selall').onchange = (e) => { for (const d of list) e.target.checked ? state.selected.add(d.id) : state.selected.delete(d.id); render(); };
  m.querySelectorAll('.sel').forEach(c => c.onchange = (e) => { const id = +c.dataset.id; e.target.checked ? state.selected.add(id) : state.selected.delete(id); render(); });
  m.querySelectorAll('.detail').forEach(c => c.onclick = () => openDetail(+c.dataset.id));
  m.querySelectorAll('.up1').forEach(b => b.onclick = () => openModal({ type: 'newjob', ids: [+b.dataset.id] }));
  m.querySelectorAll('.scan1').forEach(b => b.onclick = async () => { b.disabled = true; state.scanning.push(+b.dataset.id); render(); try { const r = await api(`/devices/${b.dataset.id}/scan`, { method: 'POST' }); if (r.skipped) toast(r.skipped, true); else if (!r.ok) toast('kontrola selhala: ' + r.error, true); } catch (e) { toast(e.message, true); } state.scanning = state.scanning.filter(x => x !== +b.dataset.id); });
  m.querySelectorAll('.edit1').forEach(b => b.onclick = () => openModal({ type: 'edit', id: +b.dataset.id }));
  m.querySelectorAll('.track').forEach(s => s.onchange = async () => { try { await api(`/devices/${s.dataset.id}`, { method: 'PUT', body: { track: s.value } }); toast('track uložen'); } catch (e) { toast(e.message, true); } });
}

const JOB_PLAIN = { queued: 'připraven ke spuštění', running: 'probíhá', paused: 'zastaven', waiting: 'čeká na potvrzení', 'waiting-window': 'čeká na servisní okno', done: 'hotovo', cancelled: 'zrušen' };
function renderJobs(m) {
  const cur = state.job;
  const adv = state.advanced;
  m.innerHTML = `<h1>Upgrady</h1><div class="stack"><div class="panel"><h2>Přehled</h2><div class="tablewrap"><table><thead><tr>${adv ? '<th>#</th>' : ''}<th>Název</th><th>Stav</th><th>Průběh</th><th>Vytvořen</th><th></th></tr></thead><tbody>
    ${state.jobs.map(j => { const c = j.counts || {}; const done = (c.done || 0) + (c.failed || 0) + (c.blocked || 0) + (c.skipped || 0) + (c.unknown || 0);
      return `<tr class="clickable ${cur && cur.job.id === j.id ? 'selected' : ''}" data-id="${j.id}">${adv ? `<td>${j.id}</td>` : ''}<td>${esc(j.name)}${j.options.dry_run ? ' <span class="badge b-info">jen kontrola</span>' : ''}${j.options.op ? ' <span class="badge b-muted">operace</span>' : ''}</td><td>${badge(JOB_LABEL, j.status)}${adv ? `<div class="muted" style="font-size:11px;white-space:normal">${esc(j.status_note)}</div>` : ''}</td>
      <td>${done}/${j.total} <span class="muted">(${c.done || 0} ok${c.failed ? `, <span style="color:var(--err)">${c.failed} chyb</span>` : ''}${c.blocked ? `, ${c.blocked} přeskočeno` : ''})</span><div class="progress"><div style="width:${j.total ? done / j.total * 100 : 0}%"></div></div></td><td>${fmtTs(j.created_at)}</td>
      <td>${['queued', 'paused'].includes(j.status) && !state.runner.running ? `<button class="small ok jstart" data-id="${j.id}">▶ Spustit</button>` : ''} ${j.status === 'waiting' && !state.runner.running ? `<button class="small ok jcont" data-id="${j.id}">Pokračovat</button>` : ''} ${!['running'].includes(j.status) ? `<button class="small danger jdel" data-id="${j.id}" title="smazat">✕</button>` : ''}</td></tr>`; }).join('')}
    ${state.jobs.length ? '' : '<tr><td colspan="6" class="empty">Zatím žádný upgrade. V seznamu zařízení klikni na „Upgradovat vše potřebné" nebo na „Upgradovat" u zařízení.</td></tr>'}</tbody></table></div></div>
  <div id="jobdetail">${cur ? '' : '<div class="panel empty">Klikni na upgrade v přehledu, zobrazí se průběh.</div>'}</div></div>`;
  m.querySelectorAll('tr[data-id]').forEach(r => r.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; openJob(+r.dataset.id); });
  m.querySelectorAll('.jstart').forEach(b => b.onclick = () => jobAction(+b.dataset.id, 'start'));
  m.querySelectorAll('.jcont').forEach(b => b.onclick = () => jobAction(+b.dataset.id, 'continue'));
  m.querySelectorAll('.jdel').forEach(b => b.onclick = async () => { if (!confirm(`Smazat záznam „${(state.jobs.find(j => j.id === +b.dataset.id) || {}).name}" včetně logu?`)) return; try { await api(`/jobs/${b.dataset.id}`, { method: 'DELETE' }); if (cur && cur.job.id === +b.dataset.id) state.job = null; await loadState(); render(); } catch (e) { toast(e.message, true); } });
  if (cur) renderJobDetail();
}
async function jobAction(id, a) { try { await api(`/jobs/${id}/${a}`, { method: 'POST' }); await loadState(); render(); } catch (e) { toast(e.message, true); } }
function jobBanner(job, items) {
  const o = job.options || {};
  const cur = items.find(i => i.id === state.runner.itemId);
  const c = { done: 0, failed: 0, blocked: 0, skipped: 0, unknown: 0, pending: 0 };
  for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
  const sum = `${c.done} v pořádku${c.blocked ? `, ${c.blocked} přeskočeno (nesplněná podmínka)` : ''}${c.skipped ? `, ${c.skipped} vynecháno` : ''}${c.failed || c.unknown ? `, <b style="color:var(--err)">${(c.failed || 0) + (c.unknown || 0)} s chybou</b>` : ''}`;
  if (job.status === 'running') return { cls: 'info', html: `<b>Probíhá${o.dry_run ? ' kontrola' : ' upgrade'}.</b> ${cur ? `Teď: <b>${esc(cur.dev_name || cur.identity || cur.host)}</b> — ${esc(cur.step || 'připojení')}.` : ''} Zbývá ${c.pending || 0}. Nezavírej nic, běží to na serveru.` };
  if (job.status === 'waiting') return { cls: 'warn', html: `<b>Čeká na tebe.</b> První kus od každého modelu je hotový. Ověř, že fungují, a klikni <b>Pokračovat</b>.` };
  if (job.status === 'waiting-window') return { cls: 'info', html: `<b>Čeká na servisní okno</b> ${esc(o.window)}. Spustí se samo.` };
  if (job.status === 'paused') return { cls: 'err', html: `<b>Zastaveno.</b> ${esc(job.status_note)}<br><span class="hint">Podívej se na řádek s chybou níže. Když je zařízení v pořádku, klikni <b>Pokračovat</b> (chybná položka se přeskočí), nebo ji dej <b>znovu</b>.</span>` };
  if (job.status === 'done') return { cls: c.failed || c.unknown ? 'warn' : 'ok', html: `<b>Hotovo.</b> ${sum}.${o.dry_run ? ' Byla to jen kontrola, nic se nezměnilo. Pokud je vše zelené, spusť to samé ostře.' : ''}` };
  if (job.status === 'cancelled') return { cls: 'muted', html: `<b>Zrušeno.</b> ${sum}.` };
  return { cls: 'muted', html: `<b>Připraveno.</b> ${items.length} zařízení, klikni <b>Spustit</b>.` };
}
function renderJobDetail() {
  const el = $('#jobdetail'); if (!el || !state.job) return;
  const { job, items } = state.job;
  const o = job.options || {};
  const adv = state.advanced;
  const isCur = state.runner.jobId === job.id;
  const atBottom = (() => { const l = $('#joblog'); return !l || l.scrollTop + l.clientHeight >= l.scrollHeight - 30; })();
  const prevLog = document.querySelector('details.logbox');
  if (prevLog) state.logOpen = prevLog.open; // pamatovat rozbalení logu přes překreslení
  const logOpen = state.logOpen === undefined ? adv : state.logOpen;
  const bn = jobBanner(job, items);
  const doneN = items.filter(i => !['pending'].includes(i.status) && !ACTIVE.has(i.status)).length;
  el.innerHTML = `<div class="panel"><h2>${esc(job.name)} ${badge(JOB_LABEL, job.status)}</h2>
    <div class="banner ${bn.cls}">${bn.html}</div>
    <div class="progress big"><div style="width:${items.length ? doneN / items.length * 100 : 0}%"></div></div>
    ${adv ? `<div class="row" style="margin:8px 0"><span class="badge ${o.dry_run ? 'b-info' : 'b-warn'}">${o.dry_run ? 'JEN KONTROLA' : 'OSTRÝ BĚH'}</span> <span class="badge b-muted">režim ${esc(o.mode || 'upload')}</span> ${o.firmware ? '<span class="badge b-muted">+ firmware</span>' : ''} ${o.canary ? '<span class="badge b-muted">kanárci</span>' : ''} ${o.device_mode ? '<span class="badge b-muted">device-mode</span>' : ''} ${o.window ? `<span class="badge b-muted">okno ${esc(o.window)}</span>` : ''} ${o.stop_on_failure ? '<span class="badge b-muted">stop při chybě</span>' : '<span class="badge b-warn">NEzastavit při chybě</span>'}</div>` : ''}
    <div class="row" style="margin:10px 0">
      ${['queued', 'paused'].includes(job.status) && !state.runner.running ? `<button class="ok" id="jb-start">▶ ${job.status === 'paused' ? 'Pokračovat' : 'Spustit'}</button>` : ''}
      ${job.status === 'waiting' && !state.runner.running ? `<button class="ok" id="jb-cont">▶ Pokračovat</button>` : ''}
      ${isCur ? `<button id="jb-pause" ${state.runner.pauseRequested ? 'disabled' : ''}>⏸ Zastavit po aktuálním zařízení</button><button id="jb-skip">⏭ Přeskočit aktuální</button><button class="danger" id="jb-cancel">■ Zrušit</button>` : ''}
      ${!['done', 'cancelled'].includes(job.status) && !isCur ? `<button class="danger" id="jb-cancel2">■ Zrušit</button>` : ''}</div>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Zařízení</th><th>Stav</th>${adv ? '<th>Krok</th>' : ''}<th>Verze</th>${adv ? '<th>Firmware</th>' : ''}<th>Poznámka</th><th></th></tr></thead><tbody>
    ${items.map((it, i) => `<tr><td>${i + 1}${it.plan && it.plan.canary ? ' 🐤' : ''}</td><td class="clickable detail" data-id="${it.device_id}"><b>${esc(it.dev_name || it.identity || it.host)}</b><div class="muted mono" style="font-size:11px">${esc(it.host)} · ${esc(it.board_name)}</div></td><td>${badge(ITEM_LABEL, it.status)}${!adv && ACTIVE.has(it.status) && it.step ? `<div class="muted" style="font-size:11px">${esc(it.step)}</div>` : ''}</td>${adv ? `<td style="white-space:normal">${esc(it.step)}</td>` : ''}
      <td class="mono">${esc(it.from_version || it.dev_version || '')}${it.to_version && it.to_version !== it.from_version ? ` → <b>${esc(it.to_version)}</b>` : ''}</td>${adv ? `<td class="mono">${esc(it.from_fw || '')}${it.to_fw && it.to_fw !== it.from_fw ? ` → ${esc(it.to_fw)}` : ''}</td>` : ''}
      <td style="white-space:normal;max-width:${adv ? 420 : 520}px">${it.error ? `<span style="color:var(--err)" title="${esc(it.error)}">${esc(adv ? it.error : shortReason(it.error))}</span>` : ''}${(it.warnings || []).length ? (adv ? it.warnings.map(w => `<div style="color:var(--warn);font-size:12px">⚠ ${esc(w)}</div>`).join('') : `<details class="warns"><summary>⚠ ${it.warnings.length} upozornění</summary>${it.warnings.map(w => `<div style="color:var(--warn);font-size:12px">${esc(w)}</div>`).join('')}</details>`) : ''}</td>
      <td>${['pending'].includes(it.status) && state.runner.itemId !== it.id ? `<button class="small iskip" data-id="${it.id}">přeskočit</button>` : ''} ${['failed', 'blocked', 'skipped', 'unknown', 'done'].includes(it.status) && !isCur ? `<button class="small iretry" data-id="${it.id}">znovu</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <details class="logbox" ${logOpen ? 'open' : ''}><summary>Podrobný log</summary><div class="log" id="joblog">${state.jobLog.map(logLine).join('')}</div></details></div>`;
  document.querySelector('details.logbox').ontoggle = (e) => { state.logOpen = e.target.open; };
  const l = $('#joblog'); if (atBottom) l.scrollTop = l.scrollHeight;
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#jb-start', () => jobAction(job.id, 'start')); on('#jb-cont', () => jobAction(job.id, 'continue'));
  on('#jb-pause', () => jobAction(job.id, 'pause')); on('#jb-skip', () => jobAction(job.id, 'skip-current'));
  on('#jb-cancel', () => { if (confirm('Zrušit běžící upgrade? Aktuální zařízení se bezpečně dokončí nebo uklidí.')) jobAction(job.id, 'cancel'); });
  on('#jb-cancel2', () => { if (confirm('Zrušit tento upgrade?')) jobAction(job.id, 'cancel'); });
  el.querySelectorAll('.iskip').forEach(b => b.onclick = () => itemAction(+b.dataset.id, 'skip'));
  el.querySelectorAll('.iretry').forEach(b => b.onclick = () => itemAction(+b.dataset.id, 'retry'));
  el.querySelectorAll('.detail').forEach(c => c.onclick = () => openDetail(+c.dataset.id));
}
const ACTIVE = new Set(['checking', 'backup', 'upload', 'reboot', 'verify', 'firmware']);
async function itemAction(id, a) { try { await api(`/items/${id}/${a}`, { method: 'POST' }); await openJob(state.job.job.id); } catch (e) { toast(e.message, true); } }
const logLine = (l) => `<div class="${l.level}"><span class="t">${fmtMs(l.ts)}</span> ${esc(l.msg)}</div>`;
async function openJob(id) { if (!state.job || state.job.job.id !== id) state.logOpen = undefined; state.job = await api(`/jobs/${id}`); state.jobLog = state.job.log; state.view = 'jobs'; render(); }

function renderSettings(m) {
  const s = state.settings;
  const f = (k, label, type = 'number', step = '1') => `<label>${label}<input name="${k}" type="${type}" step="${step}" value="${esc(s[k])}"></label>`;
  const c = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;
  m.innerHTML = `<h1>Nastavení</h1><div class="hint" style="margin-bottom:10px">Výchozí hodnoty jsou bezpečné, běžně tu není potřeba nic měnit.</div><div class="panel"><h2>Bezpečnostní limity</h2><form id="setf" class="form">
    ${f('min_uptime_min', 'min. uptime před upgradem (min)')}${f('min_free_mem_mb', 'min. volná RAM (MB)')}${f('space_margin_mb', 'rezerva místa navíc k balíčkům (MB)', 'number', '0.5')}
    ${f('reboot_timeout_min', 'timeout návratu po restartu (min)')}${f('pause_between_devices_sec', 'pauza mezi zařízeními (s)')}${f('ssh_timeout_sec', 'SSH timeout připojení (s)')}
    ${f('min_release_age_days', 'min. stáří verze (dní) — čerstvé verze mívají bootloopy', 'number', '0.5')}<label>zakázané verze (čárkou)<input name="bad_versions" type="text" value="${esc(s.bad_versions)}"></label>
    <div class="wide">${c('v7_via_712_small_flash', 'u 16 MB zařízení jít z v6 na v7 přes mezikrok 7.12.x (přímý skok hlásí „not enough space for upgrade")')}</div>
    <div class="wide">${c('firmware_before_v7', 'před přechodem 6 → 7 nejdřív upgradovat RouterBOOT ještě na v6 (doporučení MikroTik)')}</div>
    <div class="wide">${c('use_partition_fallback', 'u zařízení s více oddíly (/partitions) před upgradem zkopírovat běžící systém do záložního oddílu = automatický fallback při nenabootování')}</div>
    <div class="wide">${c('allow_v7_routing_migration', 'povolit přechod v6 → v7 na zařízeních s BGP / OSPF / routing filtry / MPLS (jinak blokováno)')}</div>
    <div class="wide">${c('allow_v7_small_flash', 'povolit v6 → v7 na zařízeních s 16 MB flash bez adresáře flash (jinak blokováno)')}</div>
    <div class="wide"><button class="primary">Uložit</button></div></form></div>
  <div class="panel"><details ${state.advanced ? 'open' : ''}><summary><b>Jak to funguje</b> (podrobně)</summary><ul class="plain">
    <li><b>Sken</b> jen čte: verze, model, architektura, firmware, místo, RAM, balíčky, rizikové příznaky. Nikdy nic nemění.</li>
    <li><b>Job</b> zpracovává zařízení <b>sériově</b>, jedno po druhém. Před každým krokem znovu zjistí živý stav a přepočítá plán.</li>
    <li>Pořadí hopů: v6.x → nejnovější v6 long-term → v7 (cíl podle tracku). Nikdy se nedowngraduje.</li>
    <li>Před hopem: export konfigurace (.rsc, vždy) + binární .backup (přes SFTP) se stáhnou sem na server.</li>
    <li>Balíčky (.npk) stahuje server z download.mikrotik.com, ověří velikost, nahraje přes SFTP a znovu ověří na routeru (název + velikost, žádný cizí .npk). Až potom restart.</li>
    <li>Po restartu: čekání na návrat (timeout výše), kontrola identity, verze, rozhraní, IP adres, bezdrátu. Pak volitelně firmware RouterBOOT + další restart.</li>
    <li>Při chybě se job <b>zastaví</b> (stop při chybě), nahrané balíčky se z routeru smažou, žádný restart. Blokátory (málo místa, cizí .npk, nízký uptime, změněný SSH klíč, dynamický routing při 6→7…) upgrade vůbec nespustí.</li>
    <li><b>Topologie:</b> u zařízení nastav nadřazený prvek (co ho napájí/připojuje — sektor, PoE switch, router). Job jde vždy od listů: nejdřív antény, pak sektory, pak nadřazené. Nadřazený prvek se nerestartuje, dokud jeho potomci v jobu neskončí v pořádku; po jeho restartu se čeká, až se potomci zase ozvou. Uplink se detekuje ze sousedů (neighbor discovery) — tlačítko „Přebrat detekované rodiče".</li>
    <li><b>Device-mode:</b> při ostrém běhu se nastaví „plné ovládání" (mode=advanced, partitions=yes). RouterOS to vyžaduje potvrdit tlačítkem nebo odpojením napájení, softwarový restart změnu zruší. Nástroj to proto udělá jen tam, kde má zařízení v seznamu nadřazený MikroTik, který ho napájí přes PoE: vydá update, vypne a zapne PoE na portu rodiče, počká na návrat a ověří. Jinak jen varuje (a nespotřebuje žádný ze 3 pokusů).</li>
    <li><b>Dry run</b> = jen kontrola a plán, nic se nemění. <b>Kanárci</b> = nejdřív jedno zařízení od každého modelu, pak čekání na potvrzení.</li>
    <li><b>Nejčastější příčiny umrtvení dle fór/dokumentace MikroTik a opatření:</b> výpadek napájení během zápisu (→ kontrola napětí, nikdy nerestartovat nadřazený PoE prvek během upgradu potomka, servisní okno); neúplný/poškozený balíček a přesto restart (→ kontrola velikosti proti download.mikrotik.com, žádný cizí .npk, bez ověření se nerestartuje); chybějící wireless/wifi balíček po 7.13 (→ doplní se podle rozhraní, i 60GHz); „not enough space" na 16 MB flash (→ mezikrok 7.12.x, upload se při selhání uklidí); kernel bugy čerstvých verzí a bootloopy (→ min. stáří verze, zakázané verze, kanárci po modelech); starý RouterBOOT před v7 (→ firmware ještě na v6); konverze konfigurace 6→7 (BGP/OSPF/filtry/MPLS blokováno, VLAN filtering varování); protected-routerboot (varování, Netinstall nejde); auto-upgrade firmware routeru (→ čeká se na druhý restart); víc oddílů (→ kopie do záložního oddílu + fallback-to).</li>
    <li><b>Firewall na routerech:</b> nástroj se připojuje z IP serveru, na kterém běží. Pokud mají routery brute-force ochranu SSH (address-list ssh_blacklist apod.), doporučuji tuto IP přidat do výjimky — nástroj sice rozestupuje opakovaná spojení na 65 s, ale sken + job dělají několik přihlášení za sebou.</li>
    <li>Čeho se nástroj netýká: fyzicky mrtvá zařízení (výpadek napájení během zápisu) řeší jen Netinstall — proto se nikdy nerestartuje bez ověřených balíčků a zálohy.</li></ul></details></div>`;
  $('#setf').onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); const body = {}; for (const k of Object.keys(s)) { const el = e.target.elements[k]; if (!el) continue; body[k] = el.type === 'checkbox' ? el.checked : el.type === 'text' ? el.value : parseFloat(el.value); } try { state.settings = await api('/settings', { method: 'PUT', body }); toast('uloženo'); render(); } catch (e2) { toast(e2.message, true); } };
}

// ---------- modaly ----------
function openModal(mod) { state.modal = mod; renderModal(); }
function closeModal() { state.modal = null; renderModal(); }
function renderModal() {
  let bg = $('#modalbg');
  if (!state.modal) { if (bg) bg.remove(); return; }
  if (!bg) { bg = document.createElement('div'); bg.id = 'modalbg'; bg.className = 'modal-bg'; document.body.appendChild(bg); bg.onclick = (e) => { if (e.target === bg) closeModal(); }; }
  const md = state.modal;
  if (md.type === 'add') {
    bg.innerHTML = `<div class="modal"><h2>Přidat zařízení</h2><div class="grid2">
      <form id="addf" class="form"><h3 style="grid-column:1/-1;margin:0;font-size:14px">Jednotlivě</h3>
        <label>host (IP)<input name="host" required></label><label>port<input name="port" type="number" value="22"></label><label>uživatel<input name="username" value="admin" required></label><label>heslo<input name="password" type="password"></label>
        <label>název<input name="name"></label><label>skupina<input name="group_name"></label><label>priorita (menší = dřív)<input name="priority" type="number" value="100"></label>
        <label>track<select name="track">${state.tracks.map(t => `<option>${t}</option>`).join('')}</select></label><label>nadřazený prvek<select name="parent_id">${parentOptions(0)}</select></label><label class="wide">poznámka<input name="notes"></label>
        <label class="check wide"><input type="checkbox" name="unmanaged"> jen prvek topologie (PoE switch apod.) — bez loginu, neskenuje se, neupgraduje se</label>
        <div class="wide"><button class="primary">Přidat</button></div></form>
      <form id="bulkf" class="form"><h3 style="grid-column:1/-1;margin:0;font-size:14px">Hromadně</h3>
        <label class="wide">řádky: <code>host[:port] uživatel heslo [skupina] [název…]</code> (oddělovač mezera/tab/; · prázdné heslo zapiš jako <code>""</code>)<textarea name="text" rows="10" placeholder="192.0.2.1 admin heslo123 pater Router skola&#10;192.0.2.2:22 admin heslo AP-sektor"></textarea></label>
        <label>track<select name="track">${state.tracks.map(t => `<option>${t}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="update"> existující (host:port) přepsat loginem</label>
        <div class="wide"><button class="primary">Vložit</button></div></form></div>
      <div class="row" style="margin-top:10px"><button id="mclose">Zavřít</button></div></div>`;
    $('#addf').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.managed = !b.unmanaged; delete b.unmanaged; b.parent_id = +b.parent_id; try { await api('/devices', { method: 'POST', body: b }); toast('přidáno, skenuji'); closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
    $('#bulkf').onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); try { const r = await api('/devices/bulk', { method: 'POST', body: { text: fd.get('text'), track: fd.get('track'), update: !!fd.get('update') } }); toast(`přidáno ${r.added}${r.skipped.length ? `, přeskočeno ${r.skipped.length}` : ''}${r.errors.length ? `, chyby: ${r.errors.join('; ')}` : ''}`, r.errors.length > 0); if (!r.errors.length) closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
  } else if (md.type === 'discover') {
    bg.innerHTML = `<div class="modal"><h2>Skenovat rozsah</h2><form id="discf" class="form">
      <label class="wide">rozsahy (CIDR nebo a.b.c.x-y, více oddělených mezerou/čárkou)<input name="ranges" placeholder="192.0.2.0/24 198.51.100.0/24" required></label>
      <label class="wide">loginy k vyzkoušení, jeden na řádek: <code>uživatel heslo</code> (prázdné heslo jako <code>""</code>)<textarea name="creds" rows="4" placeholder="admin tajneheslo&#10;admin &quot;&quot;"></textarea></label>
      <label>SSH port<input name="port" type="number" value="22"></label><label>skupina pro nové<input name="group_name"></label>
      <label>track pro nové<select name="track">${state.tracks.map(t => `<option>${t}</option>`).join('')}</select></label><label>souběžně<input name="parallel" type="number" value="24" min="1" max="64"></label>
      <div class="wide row"><button class="primary" ${state.discovery && !state.discovery.finishedAt ? 'disabled' : ''}>Spustit sken</button><span class="muted">TCP probe portu → pokus o SSH login → RouterOS se založí do seznamu. Nic se na zařízeních nemění.</span></div></form>
      <div class="panel" style="margin-top:10px"><h2>Výsledek</h2><div id="discres">${discoveryHtml(state.discovery)}</div></div>
      <div class="row"><button id="mclose">Zavřít</button></div></div>`;
    $('#discf').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); try { state.discovery = await api('/discover', { method: 'POST', body: b }); renderModal(); } catch (e2) { toast(e2.message, true); } };
  } else if (md.type === 'edit') {
    const d = state.devices.find(x => x.id === md.id); if (!d) return closeModal();
    bg.innerHTML = `<div class="modal"><h2>Upravit ${esc(d.name || d.identity || d.host)}</h2><form id="editf" class="form">
      <label>host<input name="host" value="${esc(d.host)}" required></label><label>port<input name="port" type="number" value="${d.port}"></label><label>uživatel<input name="username" value="${esc(d.username)}" required></label><label>nové heslo (prázdné = ponechat)<input name="password" type="password"></label>
      <label>název<input name="name" value="${esc(d.name)}"></label><label>skupina<input name="group_name" value="${esc(d.group_name)}"></label><label>priorita<input name="priority" type="number" value="${d.priority}"></label>
      <label>track<select name="track">${state.tracks.map(t => `<option ${t === d.track ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>nadřazený prvek (napájí / připojuje toto zařízení)<select name="parent_id">${parentOptions(d.parent_id, d.id)}</select></label>
      <label class="wide">poznámka<input name="notes" value="${esc(d.notes)}"></label>
      <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}> zapnuto (vypnuté se neskenuje ani neupgraduje)</label>
      <label class="check"><input type="checkbox" name="unmanaged" ${d.managed ? '' : 'checked'}> jen prvek topologie (bez loginu, neupgraduje se)</label>
      ${d.suggested_parent && d.suggested_parent.via ? `<div class="wide muted">detekovaný uplink: ${esc(d.suggested_parent.via)} → ${esc(d.suggested_parent.identity || '')} ${esc(d.suggested_parent.address || '')}${d.suggested_parent.id ? ` = <b>${esc(d.suggested_parent.name)}</b>` : ' (není v seznamu)'}</div>` : ''}
      <div class="wide row"><button class="primary">Uložit</button><button type="button" id="showpw">ukázat heslo</button><button type="button" id="resethk" title="po netinstallu/výměně zařízení">reset SSH host key</button><span style="flex:1"></span><button type="button" class="danger" id="del">Smazat zařízení</button><button type="button" id="mclose">Zavřít</button></div></form></div>`;
    $('#editf').onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.enabled = !!b.enabled; b.managed = !b.unmanaged; delete b.unmanaged; b.parent_id = +b.parent_id; b.port = +b.port; b.priority = +b.priority; if (!b.password) delete b.password; try { await api(`/devices/${d.id}`, { method: 'PUT', body: b }); toast('uloženo'); closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
    $('#showpw').onclick = async () => { const r = await api(`/devices/${d.id}/password`); alert(`Heslo: ${r.password}`); };
    $('#resethk').onclick = async () => { await api(`/devices/${d.id}/reset-hostkey`, { method: 'POST' }); toast('host key smazán, skenuji'); };
    $('#del').onclick = async () => { if (!confirm(`Smazat ${d.host} včetně historie a záloh z evidence?`)) return; try { await api(`/devices/${d.id}`, { method: 'DELETE' }); state.selected.delete(d.id); closeModal(); await loadState(); render(); } catch (e2) { toast(e2.message, true); } };
  } else if (md.type === 'detail') {
    const { device: d, history, backups, log, plan } = md.data;
    const vs = verStatus(d);
    const fl = d.flags || {};
    const flagTxt = [fl.wireless ? `wireless ${fl.wireless}` : '', fl.wifi ? `wifi ${fl.wifi}` : '', fl.bgp ? `BGP ${fl.bgp}` : '', fl.ospf ? `OSPF ${fl.ospf}` : '', fl.routing_filter ? `filtry ${fl.routing_filter}` : '', fl.mpls ? 'MPLS' : '', fl.capsman ? 'CAPsMAN' : '', fl.caps_client ? 'CAP' : '', fl.flash_dir ? 'flash/ dir' : '', fl.platform ? fl.platform : ''].filter(Boolean).join(' · ');
    bg.innerHTML = `<div class="modal"><h2>${esc(d.name || d.identity || d.host)} <span class="badge ${vs.cls}">${esc(vs.txt)}</span></h2>
      <div class="grid2"><div>
        <table><tr><th>Host</th><td class="mono">${esc(d.host)}:${d.port} (${esc(d.username)})</td></tr><tr><th>Identita</th><td>${esc(d.identity)}</td></tr><tr><th>Model</th><td>${esc(d.board_name)} ${d.model && d.model !== d.board_name ? `(${esc(d.model)})` : ''} · ${esc(d.arch)} · SN ${esc(d.serial)}</td></tr>
        <tr><th>RouterOS</th><td class="mono">${esc(d.version)} ${esc(d.channel)} → cíl ${esc(targetOf(d) || 'hold')} (${esc(d.track)})</td></tr><tr><th>Firmware</th><td class="mono">${esc(d.fw_current)} ${d.fw_upgrade && d.fw_upgrade !== d.fw_current ? `→ ${esc(d.fw_upgrade)}` : '✓'}</td></tr>
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
      <div class="row" style="margin-top:10px"><button id="mscan">⟳ Skenovat</button><button id="medit">✎ Upravit</button><button id="mjob" class="ok">▶ Job jen pro toto zařízení</button>${canRepartition(d) ? `<button id="mrepart" title="rozdělí flash na 2 oddíly = automatický fallback při nenabootování po upgradu">⛁ Rozdělit flash na 2 oddíly</button>` : ''}<span style="flex:1"></span><button id="mclose">Zavřít</button></div></div>`;
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
      <div class="hint" style="margin-bottom:8px">Zařízení se upgradují jedno po druhém, nejdřív koncová, nakonec ta, která ostatní napájí. Před každým se uloží záloha konfigurace, po restartu se vše ověří. Při chybě se to zastaví a čeká na tebe.</div>
      <div style="max-height:180px;overflow:auto;margin-bottom:10px" class="mono">${devs.map(d => ({ d, depth: depthOf(d) })).sort((a, b) => b.depth - a.depth).map(({ d }) => { const ps = plainStatus(d); const par = state.devices.find(x => x.id === d.parent_id); return `<div>${esc(devName(d))} <span class="muted">${esc(d.host)} · ${esc(d.board_name)}</span> · ${esc(d.version || '?')} <span class="badge ${ps.cls}">${esc(ps.txt)}</span>${par ? ` <span class="muted">← ${esc(devName(par))}</span>` : ''}</div>`; }).join('')}</div>
      ${skipped.length ? `<div class="hint" style="margin-bottom:8px">${skipped.length} z vybraných nic nepotřebuje nebo není dostupné — přeskočí se.</div>` : ''}
      <form id="jobf" class="form"><label class="wide">název<input name="name" value="${esc(defaultJobName(devs))}"></label>
        ${adv ? `
        <label class="check"><input type="checkbox" name="firmware" checked> po upgradu i firmware RouterBOOT (+1 restart)</label>
        <label class="check"><input type="checkbox" name="stop_on_failure" checked> zastavit při první chybě</label>
        <label class="check"><input type="checkbox" name="canary"> kanárci: nejdřív 1 zařízení od každého modelu, pak čekat na potvrzení</label>
        <label class="check"><input type="checkbox" name="require_binary_backup"> vyžadovat i binární .backup (jinak stačí .rsc export)</label>
        <label class="check"><input type="checkbox" name="device_mode" checked> device-mode plné ovládání (potvrzení PoE restartem přes nadřazený MikroTik)</label>
        <label>režim<select name="mode"><option value="upload">upload — server nahraje balíčky přes SFTP (doporučeno)</option><option value="router">router — vlastní updater routeru (potřebuje internet)</option></select></label>
        <label>servisní okno (HH:MM-HH:MM, prázdné = hned)<input name="window" placeholder="01:00-05:00"></label>
        <label>pauza mezi zařízeními (s)<input name="pause_sec" type="number" value="${esc(state.settings.pause_between_devices_sec)}"></label>
        <label class="check"><input type="checkbox" name="allow_routing_migration"> povolit v6→v7 i s BGP/OSPF/filtry (jen pro tento job)</label>
        <label class="check"><input type="checkbox" name="allow_small_flash"> povolit v6→v7 na 16 MB flash (jen pro tento job)</label>` : `
        <label class="check wide"><input type="checkbox" name="canary" ${devs.length > 3 ? 'checked' : ''}> nejdřív jeden kus od každého modelu, pak se zastavit a počkat na moje potvrzení</label>
        <label>servisní okno (prázdné = hned)<input name="window" placeholder="01:00-05:00"></label>`}
        <div class="wide row"><button class="primary" name="go" value="start">▶ Spustit upgrade</button><button name="go" value="check">Jen zkontrolovat (nic se nezmění)</button>${adv ? '<button name="go" value="create">Jen vytvořit</button>' : ''}<button type="button" id="mclose">Zavřít</button></div></form></div>`;
    $('#jobf').onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); const go = e.submitter && e.submitter.value;
      const o = { dry_run: go === 'check', firmware: adv ? !!fd.get('firmware') : true, stop_on_failure: adv ? !!fd.get('stop_on_failure') : true, canary: !!fd.get('canary'), require_binary_backup: adv ? !!fd.get('require_binary_backup') : false, device_mode: adv ? !!fd.get('device_mode') : true, allow_routing_migration: adv ? !!fd.get('allow_routing_migration') : false, allow_small_flash: adv ? !!fd.get('allow_small_flash') : false, mode: adv ? fd.get('mode') : 'upload', window: fd.get('window') || '', pause_sec: adv ? +fd.get('pause_sec') : undefined };
      const start = go === 'start' || go === 'check';
      if (go === 'start' && !confirm(`Spustit upgrade ${devs.length} zařízení?\n\nKaždé se zálohuje, nahraje, ověří a restartuje. Během upgradu bude zařízení chvíli nedostupné.`)) return;
      try { const r = await api('/jobs', { method: 'POST', body: { name: fd.get('name'), deviceIds: devs.map(d => d.id), options: o, start } }); closeModal(); state.selected.clear(); await loadState(); await openJob(r.id); } catch (e2) { toast(e2.message, true); } };
  }
  const c = $('#mclose'); if (c) c.onclick = closeModal;
}
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
  return `<option value="0" ${!sel ? 'selected' : ''}>— žádný —</option>` + list.map(d => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(devName(d))} (${esc(d.host)})${d.managed ? '' : ' [neřízený]'}</option>`).join('');
}
function discoveryHtml(st) {
  if (!st || st.total === undefined) return '<span class="muted">Zatím žádný sken. Zadej rozsah a aspoň jeden login.</span>';
  st = { found: [], authFailed: [], errors: [], ...st };
  const running = !st.finishedAt;
  return `<div>${running ? '⏳ běží' : '✔ hotovo'}: ${st.done}/${st.total} adres, ${st.open} s otevřeným SSH, <b>${st.added} nových založeno</b>, ${st.existing} už v seznamu, ${st.authFailed.length} bez platného loginu, ${st.errors.length} chyb</div>
    <div class="progress" style="margin:6px 0"><div style="width:${st.total ? st.done / st.total * 100 : 0}%"></div></div>
    ${st.found.length ? `<details open><summary>nalezené (${st.found.length})</summary><div class="mono" style="max-height:200px;overflow:auto">${st.found.map(f => `<div>${esc(f.host)} ${esc(f.identity || '')} ${esc(f.board || '')} ${esc(f.version || '')}${f.existing ? ' <span class="muted">(už v seznamu)</span>' : ''}</div>`).join('')}</div></details>` : ''}
    ${st.authFailed.length ? `<details><summary>SSH otevřené, login neprošel (${st.authFailed.length})</summary><div class="mono" style="max-height:150px;overflow:auto">${st.authFailed.map(esc).join('<br>')}</div></details>` : ''}
    ${st.errors.length ? `<details><summary>chyby (${st.errors.length})</summary><div class="mono" style="max-height:150px;overflow:auto">${st.errors.map(esc).join('<br>')}</div></details>` : ''}`;
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
async function loadState() {
  const s = await api('/state');
  Object.assign(state, { devices: s.devices, jobs: s.jobs, latest: s.latest, settings: s.settings, runner: s.runner, tracks: s.tracks, scanning: s.scanning, discovery: s.discovery });
}
let es;
function connectSSE() {
  if (es) es.close();
  es = new EventSource(BASE + '/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'device') { const i = state.devices.findIndex(d => d.id === ev.device.id); if (i >= 0) state.devices[i] = { ...ev.device, suggested_parent: state.devices[i].suggested_parent }; else state.devices.push(ev.device); state.scanning = state.scanning.filter(x => x !== ev.device.id); if (state.view === 'devices' && !state.modal) render(); }
    else if (ev.type === 'device-deleted') { state.devices = state.devices.filter(d => d.id !== ev.id); state.selected.delete(ev.id); if (!state.modal) render(); }
    else if (ev.type === 'job' && ev.job) { const i = state.jobs.findIndex(j => j.id === ev.job.id); if (i >= 0) state.jobs[i] = ev.job; else state.jobs.unshift(ev.job); if (state.job && state.job.job.id === ev.job.id) { state.job.job = { ...state.job.job, ...ev.job }; } if (state.view === 'jobs') render(); }
    else if (ev.type === 'item' && state.job && ev.item.job_id === state.job.job.id) { const i = state.job.items.findIndex(x => x.id === ev.item.id); if (i >= 0) state.job.items[i] = { ...state.job.items[i], ...ev.item }; if (state.view === 'jobs') renderJobDetail(); }
    else if (ev.type === 'log' && state.job && ev.log.job_id === state.job.job.id) { state.jobLog.push(ev.log); const l = $('#joblog'); if (l) { const atBottom = l.scrollTop + l.clientHeight >= l.scrollHeight - 30; l.insertAdjacentHTML('beforeend', logLine(ev.log)); if (atBottom) l.scrollTop = l.scrollHeight; } }
    else if (ev.type === 'runner') { state.runner = ev.status; render(); }
    else if (ev.type === 'discovery' || ev.type === 'discovery-done') { state.discovery = ev.state; const r = $('#discres'); if (r) r.innerHTML = discoveryHtml(ev.state); if (ev.type === 'discovery-done') { toast(`sken rozsahu hotov: ${ev.state.added} nových zařízení`); loadState().then(() => { if (state.modal && state.modal.type === 'discover') renderModal(); else render(); }); } }
    else if (ev.type === 'discovery-error') toast('sken rozsahu: ' + ev.error, true);
    else if (ev.type === 'devices-changed') loadState().then(render);
    else if (ev.type === 'latest') { state.latest = ev.latest; render(); }
    else if (ev.type === 'scan-done') { toast(`sken hotov (${ev.count} zařízení)`); loadState().then(render); }
  };
  es.onerror = () => { setTimeout(() => { if (state.authed) connectSSE(); }, 5000); };
}
(async () => {
  try { const w = await api('/whoami'); state.authed = w.authed; } catch { state.authed = false; }
  if (state.authed) { await loadState(); connectSSE(); }
  render();
  setInterval(() => { if (state.authed && state.view === 'devices' && !state.modal) render(); }, 60000);
})();
