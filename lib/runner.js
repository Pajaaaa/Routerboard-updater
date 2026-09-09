'use strict';
const { devLabel } = require('./label');
// Job engine: sériově zpracovává zařízení v jobu. Každý krok loguje do DB a vysílá události (SSE).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const cfg = require('./config');
const db = require('./db');
const { decrypt, token } = require('./crypto');
const { ipInList, hostAllowed } = require('./netaddr');
const userdb = require('./userdb');
const { RosClient, probeTcp, sleep } = require('./ros');
const I = require('./inspect');
const { inspect, toDeviceFields } = I;
const { plan } = require('./planner');
const V = require('./versions');

const MB = 1048576;
const MANAGED_SERVICES = new Set(['api', 'api-ssl', 'ftp', 'ssh', 'telnet', 'www', 'www-ssl', 'winbox']); // /ip service položky, které ochrana služeb řídí
const WATCHDOG_MIN = 30;
// desky MikroTik s PoE-out (mohou napájet zařízení pod sebou a mít PoE watchdog)
// desky s PoE výstupem (jen odhad podle jména souseda, když zařízení nad námi není naskenované; u naskenovaného rozhoduje skutečný stav poe-out portů).
// Pozor na varianty: RB5009 má PoE-out jen UPr+S+, hAP ac² a hAP ax² ne (ac³/ax³ ano), wAP ac/ax ne
const POE_BOARD_RE = /PoE|netPower|PowerBox|OmniTIK|CRS[13]\d\d-\d+P|PGS|RB750UP|hAP ac\^?3|hAP ax\^?3|cAP ac|cAP ax|RB4011|RB3011|RB5009UPr|RB2011UiAS|RB1100AHx4|RB960/i; // min bez aktivity položky, po kterých watchdog přeruší visící SSH spojení
const ACTIVE_ITEM = new Set(['checking', 'backup', 'upload', 'reboot', 'verify', 'firmware', 'running']);

function ts() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'router'; }
function inWindow(win, now = new Date()) {
  const m = String(win || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  if (a === b) return true;
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

/** poznámka jobu pozastaveného kvůli aktualizaci serveru — po restartu se sám rozjede */
const DRAIN_NOTE = 'aktualizace serveru — job pokračuje automaticky po restartu';

class Runner extends EventEmitter {
  constructor() {
    super();
    this.currentJobId = 0;
    this.currentItemId = 0;
    this.currentDeviceId = 0;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.skipRequested = false;
    this.pkgTokens = new Map(); // token -> {local, file, expires}
    this.currentClient = null;  // živé SSH spojení aktuální položky (kvůli zrušení/watchdogu)
    this.lastActivity = Date.now();
    this.ownerId = 0;           // runner patří jednomu uživateli (každý má svůj; naráz běží nejvýš jeden job na uživatele)
    // Watchdog poslední záchrany: když se během položky nic neděje déle než WATCHDOG_MIN a spojení visí, násilně ho ukončí.
    // Všechny SSH příkazy i SFTP přenosy mají vlastní timeouty; tohle chytá, co by jim uteklo.
    this._watchdog = setInterval(() => {
      const cl = this.currentClient;
      if (!this.busy || !cl || !cl.conn || cl.closed) return;
      const idleMin = (Date.now() - this.lastActivity) / 60000;
      if (idleMin < WATCHDOG_MIN) return;
      db.addLog(this.currentJobId, this.currentItemId, this.currentDeviceId, 'error', `WATCHDOG: ${Math.round(idleMin)} min bez aktivity — přerušuji SSH spojení`);
      cl.abort(`watchdog: ${Math.round(idleMin)} min bez aktivity`);
    }, 60000);
    this._watchdog.unref();
  }

  static recoverAfterRestart() {
    for (const j of db.listJobs(200)) {
      if (j.status === 'paused' && j.status_note === DRAIN_NOTE) { db.updateJob(j.id, { status: 'queued', status_note: 'pokračování po aktualizaci serveru' }); db.addLog(j.id, 0, 0, 'info', 'Server aktualizován, job pokračuje.'); continue; }
      if (['running', 'waiting-window'].includes(j.status)) {
        db.updateJob(j.id, { status: 'paused', status_note: 'server byl restartován během běhu jobu — zkontroluj stav zařízení a pokračuj ručně' });
        for (const it of db.getJobItems(j.id)) {
          if (ACTIVE_ITEM.has(it.status)) db.updateJobItem(it.id, { status: 'unknown', error: `server restartován během kroku "${it.step}" — ověř stav zařízení ručně (sken)`, finished_at: db.now() });
        }
        db.addLog(j.id, 0, 0, 'warn', 'Server restartován během běhu jobu — job pozastaven.');
      }
    }
  }

  get busy() { return this.currentJobId !== 0; }
  isDeviceBusy(id) { return this.currentDeviceId === id; }

  status() {
    return { running: this.busy, ownerId: this.ownerId, jobId: this.currentJobId, itemId: this.currentItemId, deviceId: this.currentDeviceId, pauseRequested: this.pauseRequested, cancelRequested: this.cancelRequested };
  }

  emitJob(jobId) { this.emit('event', { type: 'job', job: db.getJobSummary(jobId) }); }
  emitItem(itemId) { const it = db.getJobItem(itemId); if (it) this.emit('event', { type: 'item', item: it }); }
  emitDevice(deviceId) { const d = db.getDevice(deviceId); if (d) this.emit('event', { type: 'device', device: d }); }

  // ---- ovládání ----
  start(jobId) {
    if (this.busy) throw new Error(`běží už job #${this.currentJobId}`);
    const job = db.getJob(jobId);
    if (!job) throw new Error('job neexistuje');
    if (['done', 'cancelled'].includes(job.status)) throw new Error('job je už ukončený');
    this.pauseRequested = false; this.cancelRequested = false; this.skipRequested = false;
    this.currentJobId = jobId;
    setImmediate(() => this.runJob(jobId).catch(e => {
      db.addLog(jobId, 0, 0, 'error', 'Interní chyba runneru: ' + (e.stack || e.message));
      db.updateJob(jobId, { status: 'paused', status_note: 'interní chyba: ' + e.message });
    }).finally(() => { this.currentJobId = 0; this.currentItemId = 0; this.currentDeviceId = 0; this.emitJob(jobId); this.emit('event', { type: 'runner', status: this.status() }); }));
    this.emit('event', { type: 'runner', status: this.status() });
  }
  pause() { if (this.busy) this.pauseRequested = true; this.emit('event', { type: 'runner', status: this.status() }); }
  cancel() { if (this.busy) { this.cancelRequested = true; this.abortCurrent('job zrušen uživatelem'); } this.emit('event', { type: 'runner', status: this.status() }); }
  skipCurrent() { if (this.busy) { this.skipRequested = true; this.abortCurrent('položka přeskočena uživatelem'); } }
  /** Přeruší rozpracovaný SSH příkaz/přenos aktuální položky (běžící upload apod.), aby zrušení zabralo hned a ne až po kroku. */
  abortCurrent(reason) { const cl = this.currentClient; if (cl && cl.conn && !cl.closed) { try { cl.abort(reason); } catch {} } }

  // ---- hlavní smyčka jobu ----
  async runJob(jobId) {
    const job = db.getJob(jobId);
    const opt = job.options || {};
    db.updateJob(jobId, { status: 'running', status_note: '', started_at: job.started_at || db.now() });
    db.addLog(jobId, 0, 0, 'info', `Job "${job.name}" spuštěn (${opt.dry_run ? 'DRY RUN — nic se nemění' : 'ostrý běh'}, režim ${opt.mode || 'upload'})`);
    this.emitJob(jobId);
    await V.refreshLatest(true).catch(() => {});
    if (opt.precheck && !opt.precheckDone && !opt.dry_run && !opt.op) {
      const res = await this.precheckAll(jobId, opt);
      const j2 = db.getJob(jobId);
      db.updateJob(jobId, { options: { ...j2.options, precheckDone: true } });
      if (this.cancelRequested) { db.updateJob(jobId, { status: 'cancelled', status_note: 'zrušeno uživatelem', finished_at: db.now() }); return; }
      const summary = `${res.ready} připraveno, ${res.blocked} se zatím přeskočí (před startem každého zařízení se kontrola opakuje)${res.warned ? `, ${res.warned} s upozorněním` : ''}`;
      if ((res.blocked || res.warned) && db.getSettings(this.ownerId).confirm_after_precheck) {
        // volitelně: při problémech počkat na „Pokračovat" (výchozí je jet rovnou, zastavit až skutečná chyba)
        const note = `kontrola hotová: ${summary} — „Pokračovat" spustí upgrade`;
        db.updateJob(jobId, { status: 'waiting', status_note: note });
        db.addLog(jobId, 0, 0, 'info', 'Kontrola hotová, čekám na potvrzení: ' + note);
        this.emitJob(jobId);
        return;
      }
      db.addLog(jobId, 0, 0, 'info', `Kontrola hotová: ${summary} — pokračuji upgradem${res.blocked ? ', zablokovaná zařízení se přeskočí' : ''}${res.warned ? ', upozornění jsou v logu' : ''}.`);
      opt.precheckDone = true;
    }
    while (true) {
      if (this.cancelRequested) { db.updateJob(jobId, { status: 'cancelled', status_note: 'zrušeno uživatelem', finished_at: db.now() }); db.addLog(jobId, 0, 0, 'warn', 'Job zrušen.'); break; }
      if (this.pauseRequested) { db.updateJob(jobId, { status: 'paused', status_note: 'pozastaveno uživatelem' }); db.addLog(jobId, 0, 0, 'info', 'Job pozastaven.'); break; }
      if (this.pool && this.pool.draining) { db.updateJob(jobId, { status: 'paused', status_note: DRAIN_NOTE }); db.addLog(jobId, 0, 0, 'info', 'Server se aktualizuje: aktuální zařízení je dokončené, job se po restartu sám rozjede dál.'); break; }
      const items = db.getJobItems(jobId);
      const canaryPhase = !!(opt.canary && !opt.canaryDone);
      const pick = this.pickNext(items, canaryPhase);
      let next = pick.item;
      if (!next && canaryPhase && items.some(i => i.status === 'pending')) {
        // kanárci hotovi (nebo zbylí kanárci čekají na své potomky) → čekat na potvrzení
        db.updateJob(jobId, { status: 'waiting', status_note: 'kanárci hotovi — zkontroluj upgradovaná zařízení a dej „Pokračovat"' });
        db.addLog(jobId, 0, 0, 'info', 'Kanárci (první zařízení každého modelu) hotovi. Čekám na potvrzení pokračování.');
        break;
      }
      if (!next && pick.blockedBy) {
        // zbývají jen položky, jejichž potomci selhali / jsou v neznámém stavu → nesmí se restartovat nadřazený prvek
        for (const it of pick.blockedItems) db.updateJobItem(it.id, { status: 'blocked', error: it.blockReason, finished_at: db.now() });
        db.addLog(jobId, 0, 0, 'error', `Nadřazené prvky zablokovány: ${pick.blockedItems.map(i => (i.dev_name || i.host) + ' (' + i.blockReason + ')').join('; ')}`);
        continue;
      }
      if (!next) {
        const failed = items.filter(i => ['failed', 'unknown'].includes(i.status)).length;
        const blocked = items.filter(i => ['blocked', 'skipped'].includes(i.status)).length;
        const ok = items.filter(i => i.status === 'done').length;
        const note = failed ? `skončilo s chybou: ${failed} chyb${blocked ? `, ${blocked} přeskočeno` : ''}, ${ok} OK` : blocked ? (ok ? `hotovo s výhradami: ${ok} OK, ${blocked} přeskočeno` : `nic neprovedeno: ${blocked} přeskočeno`) : 'hotovo';
        db.updateJob(jobId, { status: 'done', status_note: note, finished_at: db.now() });
        db.addLog(jobId, 0, 0, 'info', `Job dokončen (${items.filter(i => i.status === 'done').length}/${items.length} OK).`);
        break;
      }
      const skipReason = this.checkPrecedingFailure(items, next, opt);
      if (skipReason) { db.updateJob(jobId, { status: 'paused', status_note: skipReason }); db.addLog(jobId, 0, 0, 'warn', skipReason); break; }

      this.currentItemId = next.id; this.currentDeviceId = next.device_id; this.skipRequested = false;
      this.emit('event', { type: 'runner', status: this.status() });
      const result = await this.runItem(job, next, opt);
      this.currentItemId = 0; this.currentDeviceId = 0;
      this.emitItem(next.id); this.emitDevice(next.device_id); this.emitJob(jobId);
      if (result === 'failed' && opt.stop_on_failure !== false && !opt.dry_run) {
        const note = `zastaveno po chybě na zařízení ${next.dev_name || next.host} — zkontroluj a pokračuj ručně`;
        db.updateJob(jobId, { status: 'paused', status_note: note }); db.addLog(jobId, 0, 0, 'error', 'STOP: ' + note);
        break;
      }
      const remaining = db.getJobItems(jobId).some(i => i.status === 'pending');
      if (remaining && result === 'done' && !opt.dry_run) {
        const p = Number.isFinite(+opt.pause_sec) ? +opt.pause_sec : (db.getSettings(this.ownerId).pause_between_devices_sec || 0);
        if (p > 0) { db.addLog(jobId, 0, 0, 'info', `Pauza ${p} s před dalším zařízením.`); await this.interruptibleSleep(p * 1000); }
      }
    }
    this.emitJob(jobId);
  }

  checkPrecedingFailure() { return ''; }

  /** předběžná kontrola všech čekajících položek (jen čtení + plán); výsledek do item.step / item.plan */
  async precheckAll(jobId, opt, { early = false } = {}) {
    const settings = db.getSettings(this.ownerId);
    let ready = 0, blocked = 0, warned = 0;
    if (early) db.updateJob(jobId, { status_note: 'předběžná kontrola zařízení (job zůstává naplánovaný)' });
    else db.updateJob(jobId, { status: 'running', status_note: 'předběžná kontrola zařízení' });
    this.emitJob(jobId);
    // MAC adresy rádií ostatních zařízení v jobu (z posledního skenu): klient sektoru, který je sám v jobu, se upgraduje dřív (potomci napřed)
    // a sektor se před svým startem kontroluje znovu → v předběžné kontrole ho nehlásit jako překážku
    const jobMacs = [];
    for (const it of db.getJobItems(jobId)) {
      const r = db.getDeviceRaw(it.device_id); if (!r) continue;
      let f = {}; try { f = JSON.parse(r.flags || '{}'); } catch {}
      const lk = f.links || {};
      for (const st of [...(lk.stations || []), ...(lk.aps || [])]) if (st.mac) jobMacs.push({ mac: String(st.mac).toUpperCase(), label: devLabel(r), device_id: r.id });
    }
    for (const it of db.getJobItems(jobId)) {
      if (it.status !== 'pending' || this.cancelRequested) continue;
      const raw = db.getDeviceRaw(it.device_id);
      const L = (level, msg) => { const id = db.addLog(jobId, it.id, it.device_id, level, msg); this.emit('event', { type: 'log', log: { id, job_id: jobId, item_id: it.id, device_id: it.device_id, ts: Date.now(), level, msg } }); };
      this.currentItemId = it.id; this.currentDeviceId = it.device_id;
      db.updateJobItem(it.id, { step: 'kontrola…' }); this.emitItem(it.id);
      let c = null;
      try {
        if (!raw.enabled || raw.managed === 0) { db.updateJobItem(it.id, { step: 'přeskočí se: vypnuté / neřízené' }); blocked++; continue; }
        c = new RosClient({ host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: raw.host_key || '' });
        await c.connect();
        const info = await inspect(c, { full: true });
        db.updateDevice(it.device_id, { ...toDeviceFields(info), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
        let pf = {}; try { pf = JSON.parse(raw.flags || '{}'); } catch {}
        await this.enrichStationAps(info, L, raw);
        const p = await plan(info, { track: raw.track, settings, latest: V.getLatest(), options: { ...opt, allow_v7: !!raw.allow_v7, ignore_flagged: !!raw.ignore_flagged, prev_bad_blocks: pf.bad_blocks, job_client_macs: jobMacs.filter(m => m.device_id !== it.device_id) } });
        const pc = this.peerChecks(jobId, it.device_id, info, settings);
        const pp = this.poeParentChecks(it.device_id, info, settings);
        p.blockers.push(...pc.blockers, ...pp.blockers); p.warnings.push(...pc.warnings, ...pp.warnings); p.notes.push(...pp.notes);
        for (const n of p.notes || []) L('info', 'pozn.: ' + n);
        const blk = p.blockers.filter(b => !(p.waitUptimeSec && b.startsWith('uptime')) && !(p.lowFreeMem && b.startsWith('málo volné RAM'))); // čerstvý restart se počká, málo RAM se řeší restartem
        db.updateJobItem(it.id, { plan: { ...p, canary: it.plan?.canary || false }, from_version: info.version, to_version: p.target || '', warnings: p.warnings });
        if (blk.length) { blocked++; db.updateJobItem(it.id, { step: 'přeskočí se: ' + blk[0] + (blk.length > 1 ? ` (+${blk.length - 1})` : '') }); L('warn', `kontrola: přeskočí se — ${blk.join(' | ')}`); }
        else if (p.nothingToDo) { db.updateJobItem(it.id, { step: 'už aktuální' }); ready++; L('info', 'kontrola: už aktuální'); }
        else { ready++; if (p.warnings.length) warned++; const desc = p.hops.map(h => `${h.from} → ${h.to}`).join(', ') || (p.firmware ? `firmware ${p.firmware.current} → ${p.firmware.upgrade}` : ''); db.updateJobItem(it.id, { step: 'připraveno: ' + desc }); L('info', `kontrola: připraveno (${desc})${p.warnings.length ? ' — ' + p.warnings.length + ' upozornění' : ''}`); }
      } catch (e) {
        blocked++;
        db.updateJobItem(it.id, { step: 'přeskočí se: ' + e.message });
        db.updateDevice(it.device_id, { scan_status: 'unreachable', scan_error: e.message, last_scan_at: db.now() });
        L('warn', 'kontrola: nedostupné — ' + e.message);
      } finally { try { c && c.close(); } catch {} this.emitItem(it.id); this.emitDevice(it.device_id); }
    }
    this.currentItemId = 0; this.currentDeviceId = 0;
    return { ready, blocked, warned };
  }

  /** další položka: první čekající, jejíž všichni potomci (v DB) v tomto jobu už skončili v pořádku */
  pickNext(items, onlyCanary = false) {
    const byDev = new Map(items.map(i => [i.device_id, i]));
    const blockedItems = [];
    for (const it of items) {
      if (it.status !== 'pending') continue;
      if (onlyCanary && !(it.plan && it.plan.canary)) continue;
      const desc = db.descendantIds(it.device_id).map(id => byDev.get(id)).filter(Boolean);
      const unfinished = desc.filter(d => d.status === 'pending' || ACTIVE_ITEM.has(d.status));
      if (unfinished.length) continue; // potomci ještě čekají → nejdřív oni
      const bad = desc.filter(d => ['failed', 'unknown'].includes(d.status));
      if (bad.length) { it.blockReason = `potomek ${bad.map(d => devLabel(d)).join(', ')} skončil chybou/neznámým stavem — nadřazený prvek se nerestartuje`; blockedItems.push(it); continue; }
      return { item: it };
    }
    return { item: null, blockedBy: blockedItems.length > 0, blockedItems };
  }

  /** po restartu nadřazeného prvku počkat, až se ozvou jeho potomci (PoE, sektory…) */
  async waitForChildren(devId, L, setStep, W, settings) {
    const kids = db.children(devId).filter(k => k.host);
    if (!kids.length) return;
    setStep(`čekám na potomky (${kids.length})`, 'verify');
    L('info', `zařízení má ${kids.length} podřízených prvků (${kids.map(k => devLabel(k)).join(', ')}) — čekám, až se ozvou`);
    const end = Date.now() + (settings.reboot_timeout_min || 15) * 60000;
    const pending = new Map(kids.map(k => [k.id, k]));
    while (pending.size && Date.now() < end) {
      for (const k of [...pending.values()]) {
        const ports = k.managed ? [k.port || 22] : [22, 80, 443, 8291];
        let up = false;
        for (const p of ports) { if (await probeTcp(k.host, p, 2000)) { up = true; break; } }
        if (up) { pending.delete(k.id); L('info', `✔ potomek ${devLabel(k)} odpovídá`); }
      }
      if (pending.size) await sleep(5000);
    }
    for (const k of pending.values()) W(`POZOR: podřízený prvek ${devLabel(k)} (${k.host}) se po restartu nadřazeného neozval do ${settings.reboot_timeout_min} min`);
  }

  async interruptibleSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (this.cancelRequested || this.pauseRequested) return; await sleep(Math.min(1000, end - Date.now())); }
  }

  // ---- jedno zařízení ----
  async runItem(job, item, opt) {
    const jobId = job.id, itemId = item.id, devId = item.device_id;
    const raw = db.getDeviceRaw(devId);
    const settings = db.getSettings(this.ownerId);
    const L = (level, msg) => { this.lastActivity = Date.now(); const id = db.addLog(jobId, itemId, devId, level, msg); this.emit('event', { type: 'log', log: { id, job_id: jobId, item_id: itemId, device_id: devId, ts: Date.now(), level, msg } }); };
    const setStep = (step, status) => { this.lastActivity = Date.now(); db.updateJobItem(itemId, { step, ...(status ? { status } : {}) }); this.emitItem(itemId); };
    const warnings = [];
    const W = (m) => { warnings.push(m); db.updateJobItem(itemId, { warnings }); L('warn', m); };
    const finish = (status, extra = {}) => { db.updateJobItem(itemId, { status, finished_at: db.now(), warnings, ...extra }); this.emitItem(itemId); return status; };
    const label = devLabel(raw);
    db.updateJobItem(itemId, { status: 'checking', step: 'připojení', started_at: db.now(), error: '', warnings: [] });
    this.emitItem(itemId);
    L('info', `=== ${label} (${raw.host}) — začínám ===`);
    if (!raw.enabled) { L('warn', 'zařízení je vypnuté v seznamu — přeskakuji'); return finish('skipped', { error: 'zařízení vypnuto' }); }
    if (raw.managed === 0) { L('warn', 'jen prvek topologie (bez správy) — přeskakuji'); return finish('skipped', { error: 'neřízený prvek' }); }

    let c = null;
    const creds = { host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000 };
    const connect = async () => {
      const cl = new RosClient({ ...creds, expectedHostKey: raw.host_key || '' });
      try { await cl.connect(); }
      catch (e) {
        if (cl.hostKeyMismatch) throw new Error(`SSH host key routeru se ZMĚNIL (uložený ${raw.host_key}, nyní ${cl.hostKeyMismatch}) — možný podvrh/jiné zařízení. Pokud je to v pořádku (netinstall), resetuj klíč u zařízení.`);
        throw e;
      }
      if (!raw.host_key && cl.hostKey) { db.updateDevice(devId, { host_key: cl.hostKey }); raw.host_key = cl.hostKey; L('info', `uložen SSH host key ${cl.hostKey}`); }
      this.currentClient = cl; this.lastActivity = Date.now();
      return cl;
    };
    // RouterOS občas při otevírání SFTP kanálu (záloha) utne celé SSH spojení (SERVICE_NOT_AVAILABLE) — před dalším krokem se připojit znovu
    const reconnectIfDead = async (why) => { if (c && c.conn && !c.closed) return; L('warn', `SSH spojení spadlo (${why}) — připojuji se znovu`); await sleep(3000); c = await connect(); };
    let restoreWatchdogs = null; // rodičův PoE watchdog dočasně vypnutý po dobu položky
    let restoreOwnReboots = null; // vlastní restartovací scheduler/netwatch zařízení vypnutý po dobu položky
    let prevFlags = {}; try { prevFlags = JSON.parse(raw.flags || '{}'); } catch {}
    this.currentRaw = raw;
    let uploaded = []; // soubory nahrané na router v aktuálním hopu (pro úklid při chybě)
    const cleanupUploads = async () => {
      if (!c || !uploaded.length) return;
      if (!c.conn || c.closed) {
        // spojení spadlo (např. uprostřed uploadu) — pro úklid se musí navázat znovu
        L('info', `spojení je pryč, připojuji se znovu kvůli úklidu balíčků (${uploaded.join(', ')})`);
        try { c = await connect(); }
        catch (e) { L('error', `nejde se připojit pro úklid (${e.message}) — na routeru zůstává ${uploaded.join(', ')}; při příštím restartu by se NAINSTALOVAL, smaž ho ručně nebo spusť položku znovu`); return; }
      }
      for (const f of uploaded) { try { await c.exec(`/file remove "${f}"`, { timeoutMs: 15000, allowError: true }); L('info', `uklizeno: ${f} smazán z routeru`); } catch (e) { L('warn', `nepodařilo se smazat ${f}: ${e.message}`); } }
      uploaded = [];
    };

    try {
      if (!opt.dry_run) restoreWatchdogs = await this.pauseParentPoeWatchdogs(raw, L, W, settings);
      c = await connect();
      L('info', 'SSH připojeno');
      if (!opt.dry_run) restoreOwnReboots = await this.pauseOwnRebootScripts(c, connect, prevFlags.reboot_scripts, L, W);
      let hopsDone = 0;
      let firstInfo = null;
      let fwBeforeDone = false;
      let dmDone = false;
      let rebootedByUs = false; // po vlastním restartu se nekontroluje min. uptime
      let backedUpVersion = '';
      let hardened = false;
      let prebooted = false;
      let lowRamRebooted = false;
      const noted = new Set();
      for (let iter = 0; iter < 6; iter++) {
        if (this.cancelRequested) { await cleanupUploads(); return finish('skipped', { error: 'job zrušen' }); }
        if (this.skipRequested) { await cleanupUploads(); return finish('skipped', { error: 'přeskočeno uživatelem' }); }
        setStep('zjišťování stavu', 'checking');
        const info = await inspect(c, { full: true });
        if (!firstInfo) { firstInfo = info; db.updateJobItem(itemId, { from_version: info.version, from_fw: info.fw_current }); }
        db.updateDevice(devId, { ...toDeviceFields(info), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
        db.addVersionHistory(devId, info.version, info.fw_current, hopsDone ? 'upgrade' : 'scan');
        this.emitDevice(devId);
        L('info', `${info.identity} · ${info.board_name || info.model} · ${info.arch} · RouterOS ${info.version} · fw ${info.fw_current}/${info.fw_upgrade} · flash ${(info.free_hdd / MB).toFixed(1)}/${(info.total_hdd / MB).toFixed(0)} MB · RAM ${(info.free_mem / MB).toFixed(0)} MB volné · uptime ${info.uptime}`);
        if (info.identity && raw.identity && info.identity !== raw.identity) { L('error', `identita routeru nesouhlasí: očekáváno "${raw.identity}", nalezeno "${info.identity}"`); return finish('failed', { error: 'identita routeru nesouhlasí' }); }
        if (info.serial && raw.serial && info.serial !== raw.serial) { L('error', `sériové číslo nesouhlasí: očekáváno ${raw.serial}, nalezeno ${info.serial}`); return finish('failed', { error: 'sériové číslo nesouhlasí' }); }

        await this.enrichStationAps(info, L, raw);
        const p = await plan(info, { track: raw.track, settings, latest: V.getLatest(), options: { ...opt, ignore_uptime: rebootedByUs, allow_v7: !!raw.allow_v7, ignore_flagged: !!raw.ignore_flagged, prev_bad_blocks: prevFlags.bad_blocks } });
        const pc = this.peerChecks(jobId, devId, info, settings);
        const pp = this.poeParentChecks(devId, info, settings);
        p.blockers.push(...pc.blockers, ...pp.blockers); p.warnings.push(...pc.warnings, ...pp.warnings); p.notes.push(...pp.notes);
        db.updateJobItem(itemId, { plan: { ...p, canary: item.plan?.canary || false }, to_version: p.target || '' });
        for (const w of p.warnings) if (!warnings.includes(w)) W(w);
        for (const n of p.notes || []) if (!noted.has(n)) { noted.add(n); L('info', 'pozn.: ' + n); }
        if (p.blockers.length === 1 && p.waitUptimeSec && !opt.dry_run && p.waitUptimeSec <= 30 * 60) {
          // jediná překážka je čerstvý restart → počkat, ne blokovat
          L('info', `zařízení se nedávno restartovalo, čekám ${Math.ceil(p.waitUptimeSec / 60)} min, než bude uptime v pořádku`);
          setStep(`čekám na uptime (${Math.ceil(p.waitUptimeSec / 60)} min)`, 'checking');
          try { c.close(); } catch {}
          await this.interruptibleSleep(p.waitUptimeSec * 1000 + 5000);
          if (this.cancelRequested || this.skipRequested) return finish('skipped', { error: 'zrušeno' });
          c = await connect();
          continue;
        }
        // málo volné RAM → restart uvolní paměť; zkusit jednou, pak teprve blokovat
        if (p.lowFreeMem && !lowRamRebooted && !rebootedByUs && !opt.dry_run && p.blockers.every(x => x.startsWith('málo volné RAM'))) {
          lowRamRebooted = true;
          L('info', `málo volné RAM (${(info.free_mem / MB).toFixed(1)} MB) — restartuji zařízení, aby se paměť uvolnila, a zkusím znovu`);
          setStep('restart kvůli volné RAM', 'reboot');
          const r = await this.rebootAndWait(c, creds, connect, L, setStep, settings);
          if (!r.rebooted) { W('zařízení se nerestartovalo — pokračuji s původním stavem'); c = r.client || await connect(); }
          else {
            if (!r.client) return finish('failed', { error: `zařízení se po restartu kvůli RAM nevrátilo do ${settings.reboot_timeout_min} min — ZKONTROLUJ (${raw.host})` });
            c = r.client; rebootedByUs = true;
            const lv = await this.verifyLinks(c, info, null, L, setStep, W, settings);
            if (!lv.ok) return finish('failed', { error: lv.error });
            await this.waitForChildren(devId, L, setStep, W, settings);
            continue;
          }
        }
        if (p.blockers.length) {
          if (hopsDone) {
            // zařízení už běží na nové verzi; další krok nejde → hotovo s upozorněním (nezastavovat job, neblokovat rodiče)
            for (const b of p.blockers) W('další krok neproveden: ' + b);
            return finish('done', { result: { hops: hopsDone, partial: true } });
          }
          for (const b of p.blockers) L('error', 'BLOKÁTOR: ' + b);
          return finish('blocked', { error: p.blockers.join(' | ') });
        }
        if (!hardened) { hardened = true; const hs = await this.hardenServices(c, L, W, settings, !!opt.dry_run); if (hs && hs.sshTouched) { try { c.close(); } catch {} await sleep(3000); c = await connect(); L('info', `ochrana služeb hotova — zapnuté služby: ${hs.kept} (SSH spojení navázáno znovu)`); } await this.setupRemoteLogging(c, L, W, settings, !!opt.dry_run); await this.setupTimeSync(c, info, L, W, settings, !!opt.dry_run); }
        if (p.nothingToDo) {
          if (hopsDone) L('info', `♥ Hotovo a díky za trpělivost: ${info.identity || raw.host} běží na RouterOS ${p.target} s aktuálním firmwarem, spoje i konfigurace ověřené. Ať dlouho slouží!`);
          else L('info', `♥ ${info.identity || raw.host} už je na RouterOS ${p.target} s aktuálním firmwarem — není co dělat, jen radost.`);
          return finish('done', { result: { nothingToDo: true, hops: hopsDone } });
        }
        if (opt.dry_run) {
          const desc = p.hops.map(h => `${h.from} → ${h.to} [${h.packages.map(x => x.file + ' ' + (x.size / MB).toFixed(1) + 'MB').join(', ')}; potřeba ${(h.needBytes / MB).toFixed(1)} MB, k dispozici ${(h.freeBytes / MB).toFixed(1)} MB ${h.stagingArea === 'ram' ? 'RAM' : 'flash'}]`).join('; ');
          L('info', `DRY RUN plán: ${desc || 'žádný hop'}${p.firmware ? `; firmware ${p.firmware.current} → ${p.firmware.upgrade}` : ''}`);
          return finish('done', { result: { dryRun: true, plan: p } });
        }

        if (p.upToDate) {
          // jen firmware
          if (opt.firmware === false) { L('info', 'RouterOS aktuální, firmware upgrade vypnut v jobu'); return finish('done', { result: { hops: hopsDone } }); }
          c = await this.doFirmware(c, connect, info, L, setStep, W, creds, settings, devId);
          await reconnectIfDead('po firmware a čekání na potomky'); // dlouhé čekání na potomky (až 15 min) router typicky odpojí (idle timeout SSH)
          const after = await inspect(c);
          db.updateDevice(devId, { ...toDeviceFields(after), last_scan_at: db.now(), last_seen_at: db.now(), last_upgrade_at: db.now() });
          db.updateJobItem(itemId, { to_fw: after.fw_current });
          L('info', `hotovo: RouterOS ${after.version}, firmware ${after.fw_current}`);
          return finish('done', { result: { hops: hopsDone, firmware: after.fw_current } });
        }

        const hop = p.hops[0];
        L('info', `HOP ${hop.from} → ${hop.to}: balíčky ${hop.packages.map(x => x.file).join(', ')} (${(hop.needBytes / MB).toFixed(1)} MB, k dispozici ${(hop.freeBytes / MB).toFixed(1)} MB ${hop.stagingArea === 'ram' ? 'RAM' : 'flash'})`);

        // 0b) preventivní restart při dlouhém uptime (fórum: po měsících provozu častěji nenabootuje po upgradu — fragmentace RAM; po čistém restartu 100 % úspěch)
        const prebootDays = Number(settings.preventive_reboot_days || 0);
        if (prebootDays > 0 && !prebooted && !rebootedByUs && info.uptime_sec > prebootDays * 86400) {
          prebooted = true;
          L('info', `uptime ${Math.round(info.uptime_sec / 86400)} dní (limit ${prebootDays}) — preventivní restart před upgradem, ať zápis nové verze neběží na měsíce fragmentované RAM`);
          setStep('preventivní restart (dlouhý uptime)', 'reboot');
          const r = await this.rebootAndWait(c, creds, connect, L, setStep, settings);
          if (!r.rebooted) { W('router se preventivně nerestartoval — pokračuji bez restartu'); c = r.client || await connect(); }
          else {
            if (!r.client) return finish('failed', { error: `router se po preventivním restartu nevrátil do ${settings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ (${raw.host}); upgrade neproběhl` });
            c = r.client; rebootedByUs = true;
            const lv = await this.verifyLinks(c, info, null, L, setStep, W, settings);
            if (!lv.ok) return finish('failed', { error: lv.error });
            await this.waitForChildren(devId, L, setStep, W, settings);
            L('info', '✔ preventivní restart hotov, pokračuji upgradem');
            continue; // znovu zjistit stav a plán
          }
        }
        // 1) záloha — před jakýmkoli zásahem (device-mode, firmware, upload); jednou na verzi
        if (backedUpVersion !== info.version) {
          setStep(`záloha (${info.version})`, 'backup');
          await this.doBackup(c, raw, info, itemId, L, W, opt);
          backedUpVersion = info.version;
          await reconnectIfDead('během zálohy');
        }
        // 0) device-mode plné ovládání (advanced + partitions), jen jednou na položku
        if (opt.device_mode !== false && !dmDone) {
          dmDone = true;
          const r = await this.ensureDeviceMode(c, raw, info, L, W, setStep, creds, connect, settings);
          c = r.client;
          if (r.changed) { rebootedByUs = true; continue; } // po studeném restartu znovu inspect + plán
        }
        // 0a) před skokem 6→7 nejdřív RouterBOOT z v6 (doporučení MikroTik), pak znovu zjistit stav
        if (hop.majorJump && settings.firmware_before_v7 && opt.firmware !== false && info.routerboard && info.fw_upgrade && info.fw_current !== info.fw_upgrade && !fwBeforeDone) {
          fwBeforeDone = true;
          L('info', `před přechodem na v7 nejdřív firmware RouterBOOT ${info.fw_current} → ${info.fw_upgrade} (ještě na v6)`);
          c = await this.doFirmware(c, connect, info, L, setStep, W, creds, settings, devId);
          rebootedByUs = true;
          continue; // znovu inspect + plán
        }
        // 1b) záložní oddíl: kopie běžícího systému + konfigurace → automatický fallback při nenabootování
        if (settings.use_partition_fallback && (info.partitions || []).length >= 2) {
          const backup = info.partitions.find(x => !x.running);
          const running = info.partitions.find(x => x.running);
          if (backup && running) {
            setStep(`kopie do oddílu ${backup.name}`, 'backup');
            try {
              await c.exec(`/partitions copy-to "${backup.name}"`, { timeoutMs: 10 * 60e3 });
              try { await c.exec(`/partitions set [find name="${running.name}"] fallback-to="${backup.name}"`, { timeoutMs: 15000 }); } catch (e) { W('nepodařilo se nastavit fallback-to: ' + e.message); }
              const pl = (await c.list('/partitions', ['name', 'version', 'running'])) || [];
              const bk = pl.find(x => x.name === backup.name);
              L('info', `běžící systém ${info.version} zkopírován do oddílu „${backup.name}" (verze v oddílu: ${bk ? bk.version : '?'}); fallback-to=${backup.name}`);
            } catch (e) { W(`kopie do záložního oddílu selhala (${e.message}) — pokračuji bez fallback oddílu`); }
          }
        }

        await reconnectIfDead('před nahráváním balíčků');
        // 2) staging balíčků (upload přes SFTP, nebo vlastní updater routeru)
        if (opt.mode === 'router') {
          const r = await this.stageViaRouter(c, hop, info, L, setStep, W, connect);
          if (r.client) c = r.client;
          uploaded = r.files;
          if (!r.ok) { await cleanupUploads(); return finish('failed', { error: r.error }); }
        } else {
          const r = await this.stageViaUpload(c, hop, info, L, setStep, W, uploaded, connect);
          if (r.client) c = r.client;
          if (!r.ok) { await cleanupUploads(); return finish('failed', { error: r.error }); }
        }
        if (this.cancelRequested || this.skipRequested) { await cleanupUploads(); return finish('skipped', { error: 'zrušeno před restartem' }); }

        // 4) restart a čekání. První start po velkém skoku (v6 → v7, přidaný balíček wireless) nebo na 16 MB / pomalém mipsbe kusu
        // trvá i přes 15 min (8.9.2026: PDvoracek LHG 5 a ANENSKE Cube se vrátily až po limitu, položka mezitím selhala) → aspoň 25 min
        setStep(`restart → ${hop.to}`, 'reboot');
        const slowBoot = hop.majorJump || (info.total_hdd && info.total_hdd <= 16.5 * MB) || /^mips/.test(info.arch || '');
        // RB4xx/RB7xx (MIPS 24Kc, starý NAND): první start po upgradu přepisuje balíčky a trvá i 45+ min (9.9.2026 RB411AH Dolany–Osice 48 min, položka mezitím selhala)
        const ancient = /^RB(4\d\d|7\d\d)\b/i.test(info.board || info.board_name || '');
        const waitSettings = slowBoot ? { ...settings, reboot_timeout_min: Math.max(Number(settings.reboot_timeout_min) || 15, ancient ? 60 : 25) } : settings;
        if (slowBoot && waitSettings.reboot_timeout_min !== (Number(settings.reboot_timeout_min) || 15)) L('info', `na návrat čekám až ${waitSettings.reboot_timeout_min} min (${ancient ? 'RB4xx/RB7xx se starým NAND: první start po upgradu trvá i přes 45 min' : 'velký skok / 16 MB flash / mipsbe: první start bývá pomalý'})`);
        const r = await this.rebootAndWait(c, creds, connect, L, setStep, waitSettings);
        if (!r.rebooted) {
          c = r.client;
          const had = uploaded.slice();
          if (c) await cleanupUploads();
          return finish('failed', { error: c ? 'router se po příkazu nerestartoval — balíčky smazány, nic se nezměnilo' : `router se nerestartoval a nejde se znovu připojit — na routeru zůstaly balíčky ${had.join(', ')}; při příštím restartu by se NAINSTALOVALY, smaž je ručně` });
        }
        uploaded = [];
        rebootedByUs = true;
        if (!r.client) return finish('failed', { error: `router se po restartu nevrátil do ${waitSettings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ (${raw.host})` });
        c = r.client;

        // 5) ověření
        setStep(`ověření ${hop.to}`, 'verify');
        const after = await inspect(c, { full: true });
        db.updateDevice(devId, { ...toDeviceFields(after), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now(), last_upgrade_at: db.now() });
        db.addVersionHistory(devId, after.version, after.fw_current, 'upgrade');
        this.emitDevice(devId);
        // stejný kus poznáme podle sériového čísla; identita se může změnit sama (v7 přepíše výchozí „MikroTik“ na název modelu)
        if (info.serial && after.serial && after.serial !== info.serial) { L('error', `po restartu se ozvalo jiné zařízení: sériové číslo ${after.serial} (bylo ${info.serial}), identita "${after.identity}"`); return finish('failed', { error: 'po restartu odpovídá jiné zařízení (jiné sériové číslo)' }); }
        if (after.identity !== info.identity) {
          if (!info.serial || !after.serial) { L('error', `po restartu se ozvalo jiné zařízení: identita "${after.identity}" (bylo "${info.identity}") a sériové číslo nejde ověřit`); return finish('failed', { error: 'po restartu odpovídá jiná identita' }); }
          W(`identita se po restartu změnila: "${info.identity}" → "${after.identity}" (sériové číslo sedí; RouterOS 7 přepisuje výchozí identitu „MikroTik“ na název modelu)`);
        }
        if (after.version !== hop.to) {
          L('error', `po restartu je verze ${after.version}, očekáváno ${hop.to} — upgrade se neprovedl (zkontroluj /log na routeru)`);
          const left = (after.npk_files || []).filter(f => hop.packages.some(pk => pk.file === f.name)).map(f => f.name);
          if (left.length) { uploaded = left; await cleanupUploads(); L('info', 'naše balíčky z routeru odstraněny, aby se nenainstalovaly při dalším restartu'); }
          return finish('failed', { error: `verze po restartu ${after.version} ≠ ${hop.to}` });
        }
        L('info', `✔ RouterOS ${after.version} běží, uptime ${after.uptime}`);
        this.comparePost(info, after, W);
        await this.postBootCheck(c, info, after, L, W);
        // /system routerboard settings auto-upgrade=yes: RouterOS nový RouterBOOT při startu sám ZAPÍŠE, ale sám se nerestartuje —
        // firmware se aktivuje až dalším restartem, který udělá nástroj v kroku 6 (doFirmware to pozná a zápis neopakuje)
        // bezdrátové spoje: anténa se musí znovu registrovat k sektoru, sektoru se musí vrátit klienti, 60 GHz musí mít MCS ≥ 1
        const lv = await this.verifyLinks(c, info, after, L, setStep, W, settings);
        if (!lv.ok) return finish('failed', { error: lv.error });
        await this.waitForChildren(devId, L, setStep, W, settings);
        hopsDone++;
        db.updateJobItem(itemId, { to_version: after.version });

        // 6) firmware po hopu
        if (opt.firmware !== false) {
          c = await this.doFirmware(c, connect, after, L, setStep, W, creds, settings, devId);
        }
        await reconnectIfDead('po firmware a čekání na potomky');
        const fin = await inspect(c);
        db.updateDevice(devId, { ...toDeviceFields(fin), last_scan_at: db.now(), last_seen_at: db.now() });
        db.updateJobItem(itemId, { to_fw: fin.fw_current });
      }
      L('warn', 'příliš mnoho hopů — končím');
      return finish('failed', { error: 'překročen počet hopů' });
    } catch (e) {
      const interrupted = this.cancelRequested || this.skipRequested;
      L(interrupted ? 'warn' : 'error', (interrupted ? 'přerušeno: ' : 'CHYBA: ') + e.message);
      try { await cleanupUploads(); } catch {}
      if (interrupted) return finish('skipped', { error: this.cancelRequested ? 'job zrušen' : 'přeskočeno uživatelem' });
      return finish('failed', { error: e.message });
    } finally {
      try { c && c.close(); } catch {}
      if (restoreOwnReboots) { try { await restoreOwnReboots(); } catch (e) { L('error', `vlastní restartovací scheduler/netwatch zařízení se nepodařilo zapnout zpět: ${e.message} — ZAPNI HO RUČNĚ`); } }
      if (restoreWatchdogs) { try { await restoreWatchdogs(); } catch (e) { L('error', `PoE watchdog na rodiči se nepodařilo zapnout zpět: ${e.message} — ZAPNI HO RUČNĚ`); } }
      this.currentClient = null; this.currentRaw = null; this.waitingLockFor = 0;
    }
  }

  /**
   * Rodič s PoE watchdogem (netwatch/scheduler → poe-out off/on) by potomkovi během upgradu utnul napájení, jakmile přestane
   * odpovídat na ping (restart trvá minuty). Po dobu položky se watchdogy na rodiči vypnou; vrací funkci, která je zapne zpět.
   */
  async pauseParentPoeWatchdogs(raw, L, W, settings) {
    // napájecí rodič = přímý soused na uplinku (z posledního skenu), když je v seznamu; jinak nastavený nadřazený prvek
    let fr = {}; try { fr = JSON.parse(raw.flags || '{}'); } catch {}
    const up = fr.uplink;
    let viaNeighbor = up ? this.deviceOfNeighbor(up.neighbor || (up.neighbors_on_iface || [])[0], raw.id) : null;
    if (viaNeighbor && viaNeighbor.dup_of) viaNeighbor = db.getDevice(viaNeighbor.dup_of) || viaNeighbor;
    const parId = (viaNeighbor && viaNeighbor.managed && viaNeighbor.enabled) ? viaNeighbor.id : raw.parent_id;
    if (!parId) return null;
    const par = db.getDeviceRaw(parId);
    if (!par || par.managed === 0 || !par.enabled || !par.username) return null;
    let f = {}; try { f = JSON.parse(par.flags || '{}'); } catch {}
    const wds = (f.poe_watchdogs || []).filter(w => !w.disabled);
    const label = devLabel(par);
    if (!wds.length) { L('info', `PoE watchdog na napájecím rodiči ${label}: žádný (netwatch ani scheduler s poe-out) — není co vypínat`); return null; }
    const cl = new RosClient({ host: par.host, port: par.port, username: par.username, password: decrypt(par.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: par.host_key || '' });
    const sel = (w) => w.kind === 'netwatch' ? `/tool netwatch set [find host="${w.name}"]` : `/system scheduler set [find name="${w.name}"]`;
    try {
      await cl.connect();
      for (const w of wds) await cl.exec(`${sel(w)} disabled=yes`, { timeoutMs: 15000 });
      L('info', `PoE watchdog na rodiči ${label} dočasně vypnut: ${wds.map(w => `${w.kind} ${w.name}`).join(', ')} (zapne se po dokončení položky)`);
    } catch (e) { W(`PoE watchdog na rodiči ${label} se nepodařilo vypnout (${e.message}) — hrozí, že rodič potomkovi během restartu odpojí napájení`); try { cl.close(); } catch {} return null; }
    finally { try { cl.close(); } catch {} }
    return async () => {
      const cl2 = new RosClient({ host: par.host, port: par.port, username: par.username, password: decrypt(par.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: par.host_key || '' });
      await sleep(2000);
      try { await cl2.connect(); for (const w of wds) await cl2.exec(`${sel(w)} disabled=no`, { timeoutMs: 15000 }); L('info', `PoE watchdog na rodiči ${label} zapnut zpět`); }
      finally { try { cl2.close(); } catch {} }
    };
  }

  /**
   * Ochrana služeb routeru (/ip service): služby mimo `services_keep` vypnout, všem nastavit povolené adresy `services_address`.
   * ssh se nikdy nevypne; adresy se nastaví jen tehdy, když je v seznamu i adresa tohoto serveru (jinak by si nástroj zavřel dveře).
   * Řeší se jen klasické služby (api, api-ssl, ftp, ssh, telnet, www, www-ssl, winbox); ostatní položky, které novější
   * RouterOS v /ip service vypisuje (snmp, btest, route_BFD, log…), se nemění. Položka se stejným názvem může být vícekrát
   * (dynamické řádky = aktivní spojení, v7.17+) → čte se a mění jen dynamic=no; v6 tenhle příznak nemá → bez něj.
   * Mění jen to, co neodpovídá; v dry runu jen vypíše, co by změnil.
   */
  async hardenServices(c, L, W, settings, dryRun) {
    if (!settings.harden_services) return;
    const keep = new Set(String(settings.services_keep || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean));
    keep.add('ssh');
    let addr = String(settings.services_address || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean).join(',');
    const my = c.localAddress();
    if (addr && !my) { W('ochrana služeb: nejde zjistit vlastní IP spojení — omezení adres se nenastaví, jen se vypnou služby'); addr = ''; }
    else if (addr && !ipInList(my, addr)) { W(`ochrana služeb: adresa serveru ${my} není v povoleném seznamu (${addr}) — omezení adres se nenastaví, jinak by se nástroj zamkl; jen se vypnou služby`); addr = ''; }
    const F = ['name', 'disabled', 'address'];
    let dyn = true;
    let cur = await c.list('/ip service', F, { where: 'dynamic=no' });
    if (!cur) { dyn = false; cur = await c.list('/ip service', F); }
    if (!cur) { W('ochrana služeb: /ip service nejde přečíst — přeskakuji'); return; }
    const sel = (name) => dyn ? `[find name="${name}" dynamic=no]` : name;
    const changes = [];
    const seen = new Set();
    for (const s of cur) {
      const name = String(s.name || '').toLowerCase();
      if (!name || !MANAGED_SERVICES.has(name) || seen.has(name)) continue;
      const rows = cur.filter(x => String(x.name || '').toLowerCase() === name);
      seen.add(name);
      const wantDisabled = !keep.has(name);
      const parts = [];
      if (rows.some(x => (String(x.disabled) === 'true') !== wantDisabled)) parts.push(`disabled=${wantDisabled ? 'yes' : 'no'}`);
      if (addr) {
        const want = addr.split(',').sort().join(',');
        // RouterOS 7.2x vrací seznam adres přes :tostr oddělený středníkem (starší čárkou) — jinak by se adresa „lišila“ pokaždé a nastavovala pořád dokola
        if (rows.some(x => String(x.address || '').split(/[,;]/).map(y => y.trim()).filter(Boolean).sort().join(',') !== want)) parts.push(`address="${addr}"`);
      }
      if (parts.length) changes.push({ name, cmd: `/ip service set ${sel(name)} ${parts.join(' ')}`, desc: `${name}: ${parts.join(' ')}` });
    }
    const kept = [...seen].filter(n => keep.has(n)).join(', ');
    if (!changes.length) { L('info', `ochrana služeb: /ip service už odpovídá (zapnuté: ${kept}${addr ? `, adresy ${addr}` : ''})`); return; }
    if (dryRun) { L('info', `DRY RUN ochrana služeb — změnilo by se: ${changes.map(x => x.desc).join('; ')}`); return; }
    // změnu služby ssh nechat nakonec: na RouterOS 7.22 po ní stávající SSH session zamrzne (9.9.2026 HolecekP, PetrJ — další příkaz vypršel)
    changes.sort((a, b) => (a.name === 'ssh') - (b.name === 'ssh'));
    let sshTouched = false;
    for (const ch of changes) {
      const out = await c.exec(ch.cmd, { timeoutMs: 15000, allowError: true });
      if (/failure|error|invalid|no such|syntax/i.test(out)) { W(`ochrana služeb: ${ch.desc} → ${out.trim().split('\n')[0].slice(0, 120)}`); continue; }
      L('info', `ochrana služeb: ${ch.desc}`);
      if (ch.name === 'ssh') sshTouched = true;
    }
    if (sshTouched) { L('info', 'ochrana služeb: změněna služba ssh — SSH spojení se naváže znovu'); return { sshTouched: true, kept }; }
    try { await c.exec(':put "ok"', { timeoutMs: 10000 }); } catch (e) { W(`ochrana služeb: spojení po změně služeb neodpovídá (${e.message})`); return { sshTouched: true, kept }; }
    const after = dyn ? await c.list('/ip service', ['name', 'disabled'], { where: 'dynamic=no' }) : await c.list('/ip service', ['name', 'disabled']);
    if (after) L('info', `ochrana služeb hotova — zapnuté služby: ${[...new Set(after.filter(s => MANAGED_SERVICES.has(String(s.name).toLowerCase()) && String(s.disabled) !== 'true').map(s => s.name))].join(', ') || 'žádné?!'}`);
    return { sshTouched: false, kept };
  }

  /**
   * Vzdálené logování: /system logging action <name> target=remote remote=<host> + pravidlo pro každé téma z `remote_log_topics`.
   * Idempotentní — přidá jen, co chybí (akce s jiným cílem se přenastaví, vypnuté pravidlo se zapne). Když už na stejný server
   * míří jiná (ne-výchozí) akce, použije se ta, aby se logy neposílaly dvakrát. Dry run jen vypíše.
   */
  async setupRemoteLogging(c, L, W, settings, dryRun) {
    if (!settings.remote_log_enable) return;
    const host = String(settings.remote_log_host || '').trim();
    const wantName = String(settings.remote_log_name || '').trim();
    if (!host || !wantName || !/^[\w.-]+$/.test(wantName)) { W('vzdálené logování: v nastavení chybí (nebo je neplatná) adresa serveru / název akce — přeskakuji'); return; }
    const topics = [...new Set(String(settings.remote_log_topics || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[\w!-]+$/.test(x)))];
    // /system logging přes print (get v :foreach na 7.22 zamrzne — HolecekP 9.9.2026)
    const actions = await c.printList('/system logging action', ['name', 'target']);
    if (!actions) { W('vzdálené logování: /system logging action nejde přečíst — přeskakuji'); return; }
    const remotes = (await c.printList('/system logging action', ['name', 'remote'], { where: 'target=remote' })) || [];
    const changes = [];
    let name = wantName;
    const a = actions.find(x => x.name === wantName);
    if (!a) {
      const same = remotes.find(x => x.name !== 'remote' && String(x.remote).trim() === host); // „remote" je výchozí akce RouterOS, tu nepřebírat
      if (same) { name = same.name; L('info', `vzdálené logování: na ${host} už míří akce „${same.name}" — používám ji, aby se logy neposílaly dvakrát`); }
      else changes.push({ cmd: `/system logging action add name="${wantName}" target=remote remote=${host}`, desc: `akce ${wantName} → ${host} (nová)` });
    } else {
      const remote = String((remotes.find(x => x.name === wantName) || {}).remote || '').trim();
      if (a.target !== 'remote' || remote !== host) changes.push({ cmd: `/system logging action set [find name="${wantName}"] target=remote remote=${host}`, desc: `akce ${wantName}: target=remote remote=${host} (bylo target=${a.target} remote=${remote || '?'})` });
    }
    const rules = (await c.printList('/system logging', ['action', 'topics', 'disabled'])) || [];
    const norm = (t) => String(t || '').split(',').map(y => y.trim().toLowerCase()).filter(Boolean).sort().join(',');
    for (const t of topics) {
      const r = rules.find(x => x.action === name && norm(x.topics) === t);
      if (!r) changes.push({ cmd: `/system logging add action="${name}" topics=${t}`, desc: `pravidlo topics=${t} → ${name} (nové)` });
      else if (String(r.disabled) === 'true') changes.push({ cmd: `/system logging set [find action="${name}" topics=${t}] disabled=no`, desc: `pravidlo topics=${t} → ${name} zapnuto` });
    }
    if (!changes.length) { L('info', `vzdálené logování: akce ${name} → ${host} a pravidla (${topics.join(', ')}) už jsou`); return; }
    if (dryRun) { L('info', `DRY RUN vzdálené logování — změnilo by se: ${changes.map(x => x.desc).join('; ')}`); return; }
    for (const ch of changes) {
      const out = await c.exec(ch.cmd, { timeoutMs: 15000, allowError: true });
      if (/failure|error|invalid|no such|syntax|already/i.test(out)) { W(`vzdálené logování: ${ch.desc} → ${out.trim().split('\n')[0].slice(0, 120)}`); continue; }
      L('info', `vzdálené logování: ${ch.desc}`);
    }
  }

  /** NTP klient a časová zóna podle nastavení (mění se jen odchylky). v6: primary/secondary-ntp (IP) + server-dns-names (jména); v7: servers= */
  async setupTimeSync(c, info, L, W, settings, dryRun) {
    if (!settings.ntp_enable) return;
    const servers = String(settings.ntp_servers || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    const tz = String(settings.timezone_name || '').trim();
    if (servers.some(x => !/^[A-Za-z0-9.:-]+$/.test(x)) || (tz && !/^[A-Za-z0-9_+\-/]+$/.test(tz))) { W('NTP/časová zóna: neplatná hodnota v nastavení (servery jen IP/jména, zóna např. Europe/Prague) — přeskakuji'); return; }
    if (!servers.length && !tz) return;
    const major = (V.parseVersion(info.version) || {}).major || 6;
    const isIp = (x) => /^\d+\.\d+\.\d+\.\d+$/.test(x) || x.includes(':');
    const changes = [];
    try {
      if (servers.length) {
        if (major >= 7) {
          const cur = await c.kv('/system ntp client', ['enabled', 'servers']);
          const have = String(cur.servers || '').split(/[,;\s]+/).filter(Boolean).sort().join(',');
          if (String(cur.enabled) !== 'true' || have !== [...servers].sort().join(',')) changes.push({ cmd: `/system ntp client set enabled=yes servers=${servers.join(',')}`, desc: `NTP klient: servery ${servers.join(', ')}` });
        } else {
          const cur = await c.kv('/system ntp client', ['enabled', 'primary-ntp', 'secondary-ntp', 'server-dns-names']);
          const ips = servers.filter(isIp), names = servers.filter(x => !isIp(x));
          const want = { enabled: 'yes', 'primary-ntp': ips[0] || '0.0.0.0', 'secondary-ntp': ips[1] || '0.0.0.0' };
          const diff = String(cur.enabled) !== 'true' || String(cur['primary-ntp'] || '0.0.0.0') !== want['primary-ntp'] || String(cur['secondary-ntp'] || '0.0.0.0') !== want['secondary-ntp'] || (names.length && String(cur['server-dns-names'] || '').split(/[,;\s]+/).filter(Boolean).sort().join(',') !== [...names].sort().join(','));
          if (diff) changes.push({ cmd: `/system ntp client set enabled=yes primary-ntp=${want['primary-ntp']} secondary-ntp=${want['secondary-ntp']}${names.length ? ` server-dns-names=${names.join(',')}` : ''}`, desc: `NTP klient: ${servers.join(', ')}` });
        }
      }
      if (tz) {
        const clk = await c.kv('/system clock', ['time-zone-name', 'time-zone-autodetect']);
        if (String(clk['time-zone-name']) !== tz || String(clk['time-zone-autodetect']) === 'true') changes.push({ cmd: `/system clock set time-zone-autodetect=no time-zone-name=${tz}`, desc: `časová zóna ${tz} (bylo ${clk['time-zone-name'] || '?'}${String(clk['time-zone-autodetect']) === 'true' ? ', autodetekce' : ''})` });
      }
    } catch (e) { W(`NTP/časová zóna: nejde přečíst stav (${e.message}) — přeskakuji`); return; }
    if (!changes.length) { L('info', `NTP a časová zóna už odpovídají (${[servers.join(', '), tz].filter(Boolean).join('; ')})`); return; }
    if (dryRun) { L('info', `DRY RUN NTP/čas — změnilo by se: ${changes.map(x => x.desc).join('; ')}`); return; }
    for (const ch of changes) {
      const out = await c.exec(ch.cmd, { timeoutMs: 15000, allowError: true });
      if (/failure|error|invalid|no such|syntax|expected/i.test(out)) { W(`NTP/čas: ${ch.desc} → ${out.trim().split('\n')[0].slice(0, 120)}`); continue; }
      L('info', `NTP/čas: ${ch.desc}`);
    }
  }

  /** čeká, až soubor na routeru dosáhne očekávané velikosti (write-back cache flash); vrací poslední zjištěnou velikost */
  async waitFileSize(c, name, expected, maxMs, setStep) {
    const t0 = Date.now();
    let last = -1;
    while (true) {
      const rows = (await c.list('/file', ['name', 'size'], { where: `name="${name}"` })) || [];
      last = rows[0] ? parseInt(rows[0].size, 10) : -1;
      if (last === expected) return last;
      if (Date.now() - t0 >= maxMs) return last;
      if (setStep) setStep(`čekám na dopsání ${name} do flash (${Math.max(0, last)} / ${expected} B)`);
      await sleep(3000);
    }
  }

  /** upload: server stáhne balíčky z download.mikrotik.com, nahraje přes SFTP (fallback /tool fetch) a ověří na routeru.
   * Na slabém rádiovém spoji se přenos občas zastaví a keepalive shodí celé SSH („Keepalive timeout", pak „Not connected") —
   * takový pád není chyba zařízení, jen sítě: spojení se naváže znovu, nedopsaný soubor se smaže a nahrávání se zopakuje. */
  async stageViaUpload(c, hop, info, L, setStep, W, uploaded, connect) {
    setStep(`nahrávání ${hop.to}`, 'upload');
    // 16 MB flash: supout (.rif) diagnostické dumpy zabírají stovky kB a nikdo je nepotřebuje — před zápisem nové verze pryč
    if (info.total_hdd && info.total_hdd <= 16.5 * MB) {
      try { const fl = (await c.list('/file', ['name', 'type', 'size'])) || []; const rifs = fl.filter(f => /\.rif$/i.test(f.name) || f.type === 'rif'); if (rifs.length) { await c.exec(`/file remove [find name~"\\.rif$"]`, { timeoutMs: 20000, allowError: true }); L('info', `uvolněno místo ve flash: smazány supout soubory ${rifs.map(f => f.name).join(', ')}`); } } catch (e) { W('úklid .rif souborů selhal: ' + e.message.slice(0, 80)); }
    }
    const TRIES = 3; // kolikrát zkusit nahrát jeden balíček, než se sáhne po /tool fetch
    const NET_ERR = /keepalive|not connected|není připojeno|spojení|ECONNRESET|EPIPE|ETIMEDOUT|timed out|timeout|closed|uzavřen|reset by peer|nedopsal|SFTP/i;
    const HARD_ERR = /no space|not enough|space left|permission|denied|no such file|failure|invalid/i; // došlo místo, práva… — opakování nepomůže
    const alive = () => !!(c && c.conn && !c.closed);
    const reconnect = async (why) => {
      if (!connect) return false;
      L('warn', `SSH spojení spadlo (${why}) — připojuji se znovu`);
      try { c.close(); } catch {}
      await sleep(5000);
      c = await connect(); this.currentClient = c;
      return true;
    };
    for (const pk of hop.packages) {
      const { local } = await V.ensurePackage(pk.name, hop.to, info.arch, (m) => L('info', m));
      if (fs.statSync(local).size !== pk.size) throw new Error(`lokální balíček ${pk.file} má špatnou velikost`);
      for (let attempt = 1; ; attempt++) {
      L('info', `nahrávám ${pk.file} (${(pk.size / MB).toFixed(1)} MB) přes SFTP${attempt > 1 ? ` — pokus ${attempt}/${TRIES}` : ''}`);
      let lastPct = -1, lastEmit = 0;
      const t0 = Date.now();
      const bar = (pct) => '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      try {
        await c.upload(local, pk.file, (t, tot) => {
          const pct = Math.floor(t * 100 / tot);
          const p20 = Math.floor(pct / 20) * 20;
          if (p20 !== lastPct) { lastPct = p20; setStep(`nahrávání ${pk.file} ${p20} %`); }
          // živý posuvník do logu (přes SSE, neukládá se): nejvýš každé 2 s
          if (Date.now() - lastEmit >= 2000 || pct >= 100) { lastEmit = Date.now(); this.emit('event', { type: 'progress', job_id: this.currentJobId, item_id: this.currentItemId, device_id: this.currentDeviceId, text: `nahrávání ${pk.file} [${bar(pct)}] ${pct} % (${(t / MB).toFixed(1)}/${(tot / MB).toFixed(1)} MB, ${Math.round(t / 1024 / Math.max(1, (Date.now() - t0) / 1000))} kB/s)` }); }
        });
        if (!uploaded.includes(pk.file)) uploaded.push(pk.file);
        L('info', `nahráno ${pk.file} [${bar(100)}] 100 % za ${Math.round((Date.now() - t0) / 1000)} s (${Math.round(pk.size / 1024 / Math.max(1, (Date.now() - t0) / 1000))} kB/s)`);
        // RouterOS má na flash write-back cache: SFTP ohlásí konec, ale /file ukazuje velikost zatím zapsané části (rostoucí po 32 kB blocích) — počkat, až dopíše
        const sz = await this.waitFileSize(c, pk.file, pk.size, 90000, setStep);
        if (sz !== pk.size) throw new Error(`po nahrání má ${pk.file} na routeru ${sz} B, očekáváno ${pk.size} B (ani po 90 s se nedopsal)`);
        break; // nahráno a dopsáno
      } catch (e) {
        if (!uploaded.includes(pk.file)) uploaded.push(pk.file); // i částečně nahraný soubor se musí uklidit
        const retryable = connect && attempt < TRIES && !this.cancelRequested && !this.skipRequested && !HARD_ERR.test(e.message) && (!alive() || NET_ERR.test(e.message));
        if (retryable) {
          L('warn', `nahrávání ${pk.file} se přerušilo (${e.message}) — zkusím to znovu (pokus ${attempt + 1}/${TRIES})`);
          setStep(`nahrávání ${pk.file} — nový pokus ${attempt + 1}/${TRIES}`, 'upload');
          if (!alive()) { try { await reconnect('při nahrávání balíčku'); } catch (e2) { L('warn', `připojení se nepovedlo (${e2.message}), zkusím to za chvíli`); await sleep(15000); try { await reconnect('opakovaně'); } catch (e3) { return { ok: false, error: `nahrání ${pk.file} selhalo a router se neozývá: ${e3.message}`, client: c }; } } }
          // nedopsaný soubor pryč, ať se nepovažuje za hotový a neblokuje místo ve flash
          try { await c.exec(`/file remove [find name="${pk.file}"]`, { timeoutMs: 20000, allowError: true }); } catch {}
          await sleep(5000);
          continue;
        }
        L('warn', `SFTP selhalo (${e.message}), zkouším /tool fetch z ${cfg.publicUrl}`);
        if (!alive() && connect) { try { await reconnect('před fetch'); } catch (e2) { return { ok: false, error: `nahrání ${pk.file} selhalo: ${e.message}; router se neozývá: ${e2.message}`, client: c }; } }
        const tk = token();
        this.pkgTokens.set(tk, { local, file: pk.file, expires: Date.now() + 3600e3 });
        try {
          const url = `${cfg.publicUrl}/pkg/${tk}/${pk.file}`;
          await c.exec(`/tool fetch url="${url}" dst-path="${pk.file}" keep-result=yes`, { timeoutMs: 20 * 60e3 });
        } catch (e2) {
          return { ok: false, error: `nahrání ${pk.file} selhalo: SFTP: ${e.message}; fetch: ${e2.message}`, client: c };
        } finally { this.pkgTokens.delete(tk); }
        break; // fetch dopadl, další balíček
      }
      }
    }
    setStep('ověření balíčků', 'upload');
    if (!alive() && connect) { try { await reconnect('před ověřením balíčků'); } catch (e) { return { ok: false, error: `router se po nahrání neozývá: ${e.message}`, client: c }; } }
    const files = (await c.listPatient('/file', ['name', 'type', 'size'])) || [];
    const npks = files.filter(f => f.type === 'package' || /\.npk$/i.test(f.name));
    let ok = true;
    for (const pk of hop.packages) {
      const f = npks.find(x => x.name === pk.file);
      if (!f) { L('error', `soubor ${pk.file} na routeru chybí`); ok = false; continue; }
      if (parseInt(f.size, 10) !== pk.size) { L('error', `soubor ${pk.file} má velikost ${f.size}, očekáváno ${pk.size}`); ok = false; }
      // RouterOS označí soubor typem „package“ jen když přečetl platnou hlavičku .npk — jiný typ = poškozený nebo neúplný soubor, nerestartovat
      if (f.type !== 'package') { L('error', `soubor ${pk.file} router nerozpoznal jako balíček (typ "${f.type}") — poškozený nebo neúplný přenos`); ok = false; }
    }
    for (const f of npks) if (!hop.packages.some(pk => pk.file === f.name)) { L('error', `na routeru je cizí balíček ${f.name}`); ok = false; }
    if (!ok) return { ok: false, error: 'ověření nahraných balíčků selhalo — nic se nerestartovalo', client: c };
    const sch = await this.checkScheduled(c, hop, L, W);
    if (!sch.ok) return { ...sch, client: c };
    L('info', `všech ${hop.packages.length} balíčků ověřeno (název i velikost${sch.checked ? ', router je má zařazené k instalaci' : ''}), restartuji`);
    return { ok: true, client: c };
  }

  /** router: /system package update (kanál → check → download), ověření nabízené verze proti očekávané */
  async stageViaRouter(c, hop, info, L, setStep, W, connect) {
    const files = [];
    // router při stahování/zápisu balíčků na SSH neodpovídá i přes minutu → keepalive spojení shodí („Keepalive timeout", „Not connected").
    // Proto: download běží na routeru na pozadí (:execute) a stav se čte v cyklu; když spojení spadne, naváže se nové.
    const alive = () => !!(c && c.conn && !c.closed);
    const reconnect = async (why) => { L('warn', `SSH spojení spadlo (${why}) — připojuji se znovu`); try { c.close(); } catch {} await sleep(5000); c = await connect(); this.currentClient = c; };
    const status = async () => {
      for (let i = 0; ; i++) {
        try { if (!alive()) await reconnect('updater'); return await c.kv('/system package update', ['channel', 'installed-version', 'latest-version', 'status']); }
        catch (e) { if (i >= 5) throw e; await sleep(10000); }
      }
    };
    const orig = (await status()).channel || '';
    const restore = async () => { if (orig && orig !== hop.channel) { try { await c.exec(`/system package update set channel=${orig}`, { timeoutMs: 15000 }); } catch {} } };
    let st = await status();
    if (/downloaded/i.test(st.status || '') && st['latest-version'] === hop.to) {
      L('info', `updater už má stažené balíčky ${hop.to} (stav „${st.status}") — navazuji, jen je ověřím`);
    } else {
      setStep(`updater: kanál ${hop.channel}`, 'upload');
      // starší v6 (před 6.44) mají kanály pojmenované bugfix / current / release-candidate; long-term / stable / testing přišly až v 6.44
      const CHANNEL_ALIASES = { 'long-term': ['long-term', 'bugfix'], stable: ['stable', 'current'], testing: ['testing', 'release-candidate'], upgrade: ['upgrade'] };
      let chanOk = false, chanErr = '';
      for (const ch of CHANNEL_ALIASES[hop.channel] || [hop.channel]) {
        try {
          await c.exec(`/system package update set channel=${ch}`, { timeoutMs: 15000 }); // chyba RouterOS (neznámá hodnota) → výjimka → další alias
          const now = (await status()).channel || '';
          if (now !== ch) { chanErr = `router po nastavení hlásí kanál "${now}"`; continue; }
          chanOk = true; if (ch !== hop.channel) L('info', `updater: kanál „${hop.channel}“ tahle verze nezná, používám starší název „${ch}“`); break;
        } catch (e) { chanErr = e.message; }
      }
      if (!chanOk) return { ok: false, error: `router nezná kanál "${hop.channel}" (ani starší název): ${chanErr}`, files, client: c };
      try { await c.exec('/system package update check-for-updates once', { timeoutMs: 90000, allowError: true }); }
      catch { try { await c.exec('/system package update check-for-updates', { timeoutMs: 90000, allowError: true }); } catch {} }
      st = await status();
      for (let i = 0; i < 30 && (/finding|checking/i.test(st.status || '') || (!st['latest-version'] && !/error/i.test(st.status || ''))); i++) { await sleep(3000); st = await status(); }
      L('info', `updater: kanál ${st.channel}, nabízí "${st['latest-version']}", stav: ${st.status}`);
      if (/error/i.test(st.status || '') || !st['latest-version']) { await restore(); return { ok: false, error: `updater routeru nefunguje (${st.status || 'bez odpovědi'}) — router asi nemá přístup na upgrade.mikrotik.com, použij režim upload`, files, client: c }; }
      if (st['latest-version'] !== hop.to) { await restore(); return { ok: false, error: `updater nabízí ${st['latest-version']}, očekáváno ${hop.to} — nepokračuji`, files, client: c }; }
      setStep(`updater: download ${hop.to}`, 'upload');
      // na pozadí; kdyby :execute router neznal (velmi staré v6), spustí se napřímo a případný pád spojení se přežije v cyklu níže
      let bg = false;
      try { await c.exec(':execute script="/system package update download"', { timeoutMs: 20000 }); bg = true; } catch (e) { L('info', `:execute nejde (${e.message}) — download napřímo`); }
      if (!bg) { try { await c.exec('/system package update download', { timeoutMs: 25 * 60e3, allowError: true }); } catch (e) { L('warn', 'download: ' + e.message); } }
      const end = Date.now() + 25 * 60e3;
      let lastLog = 0;
      st = await status();
      while (Date.now() < end && !/downloaded|error/i.test(st.status || '')) {
        setStep(`updater: ${st.status || 'stahuje'}`);
        if (Date.now() - lastLog > 60000) { lastLog = Date.now(); L('info', `updater: ${st.status || 'stahuje'}`); }
        if (this.cancelRequested || this.skipRequested) break;
        await sleep(5000); st = await status();
      }
      L('info', `updater stav: ${st.status}`);
    }
    const listed = (await c.listPatient('/file', ['name', 'type', 'size'])) || [];
    const npks = listed.filter(f => f.type === 'package' || /\.npk$/i.test(f.name));
    files.push(...npks.map(f => f.name));
    await restore();
    if (!/downloaded/i.test(st.status || '')) return { ok: false, error: `updater nestáhl balíčky: ${st.status}`, files, client: c };
    let ok = true;
    for (const f of npks) {
      if (!f.name.includes(hop.to)) { L('error', `na routeru je balíček jiné verze: ${f.name}`); ok = false; continue; }
      const known = hop.packages.find(pk => pk.file === f.name);
      if (known && parseInt(f.size, 10) !== known.size) { L('error', `${f.name} má velikost ${f.size}, download.mikrotik.com uvádí ${known.size}`); ok = false; }
    }
    if (!ok) return { ok: false, error: 'stažené balíčky neodpovídají — nic se nerestartovalo', files, client: c };
    if (!npks.length) W('updater hlásí staženo, ale v /file nejsou vidět žádné .npk (staging v RAM?) — spoléhám na stav updateru');
    else L('info', `stažené balíčky ověřeny: ${npks.map(f => f.name).join(', ')}`);
    const sch = await this.checkScheduled(c, hop, L, W);
    if (!sch.ok) return { ...sch, files, client: c };
    return { ok: true, files, client: c };
  }

  /** samostatná operace: rozdělení flash na N oddílů (/partitions repartition) — běží jako vlastní job kvůli logu */
  repartition(devId, count = 2) {
    if (this.busy) throw new Error(`běží už job #${this.currentJobId}`);
    const raw = db.getDeviceRaw(devId);
    if (!raw) throw new Error('zařízení neexistuje');
    if (raw.managed === 0 || !raw.enabled) throw new Error('zařízení je vypnuté nebo neřízené');
    if (!(count >= 2 && count <= 8)) throw new Error('počet oddílů 2–8');
    const label = devLabel(raw);
    const jobId = db.createJob(`Rozdělení flash na ${count} oddíly — ${label}`, { op: 'repartition', count, dry_run: false, mode: 'op' }, [devId]);
    const item = db.getJobItems(jobId)[0];
    this.currentJobId = jobId; this.currentItemId = item.id; this.currentDeviceId = devId;
    db.updateJob(jobId, { status: 'running', started_at: db.now() });
    db.addLog(jobId, 0, 0, 'info', `Operace: rozdělení flash na ${count} oddíly (${label})`);
    this.emit('event', { type: 'runner', status: this.status() }); this.emitJob(jobId);
    setImmediate(() => this.runRepartition(jobId, item, raw, count).then((st) => {
      db.updateJob(jobId, { status: 'done', status_note: st === 'done' ? 'hotovo' : 'skončilo chybou', finished_at: db.now() });
    }).catch(e => {
      db.addLog(jobId, item.id, devId, 'error', 'Interní chyba: ' + e.message);
      db.updateJob(jobId, { status: 'done', status_note: 'interní chyba: ' + e.message, finished_at: db.now() });
    }).finally(() => { this.currentJobId = 0; this.currentItemId = 0; this.currentDeviceId = 0; this.emitJob(jobId); this.emitItem(item.id); this.emitDevice(devId); this.emit('event', { type: 'runner', status: this.status() }); }));
    return jobId;
  }

  async runRepartition(jobId, item, raw, count) {
    const itemId = item.id, devId = raw.id;
    const settings = db.getSettings(this.ownerId);
    const L = (level, msg) => { this.lastActivity = Date.now(); const id = db.addLog(jobId, itemId, devId, level, msg); this.emit('event', { type: 'log', log: { id, job_id: jobId, item_id: itemId, device_id: devId, ts: Date.now(), level, msg } }); };
    const setStep = (step, status) => { this.lastActivity = Date.now(); db.updateJobItem(itemId, { step, ...(status ? { status } : {}) }); this.emitItem(itemId); };
    const warnings = [];
    const W = (m) => { warnings.push(m); db.updateJobItem(itemId, { warnings }); L('warn', m); };
    const finish = (status, extra = {}) => { db.updateJobItem(itemId, { status, finished_at: db.now(), warnings, ...extra }); this.emitItem(itemId); return status; };
    db.updateJobItem(itemId, { status: 'checking', step: 'připojení', started_at: db.now() });
    const creds = { host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000 };
    const connect = async () => {
      const cl = new RosClient({ ...creds, expectedHostKey: raw.host_key || '' });
      try { await cl.connect(); } catch (e) { if (cl.hostKeyMismatch) throw new Error(`SSH host key routeru se změnil (${cl.hostKeyMismatch}) — resetuj klíč u zařízení`); throw e; }
      return cl;
    };
    let c = null;
    try {
      c = await connect();
      setStep('kontrola', 'checking');
      const info = await inspect(c, { full: true });
      db.updateDevice(devId, { ...toDeviceFields(info), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
      db.updateJobItem(itemId, { from_version: info.version, to_version: info.version, from_fw: info.fw_current });
      L('info', `${info.identity} · ${info.board_name} · RouterOS ${info.version} · flash ${(info.total_hdd / MB).toFixed(0)} MB · oddílů: ${info.partitions.length}`);
      if (!info.routerboard) { L('error', 'není RouterBOARD (CHR/x86) — oddíly nejsou k dispozici'); return finish('blocked', { error: 'není RouterBOARD' }); }
      if (info.total_hdd < 128 * MB) { L('error', `flash jen ${(info.total_hdd / MB).toFixed(0)} MB — repartition vyžaduje alespoň 128 MB`); return finish('blocked', { error: 'malá flash' }); }
      if (info.partitions.length >= count) { L('info', `zařízení už má ${info.partitions.length} oddílů: ${info.partitions.map(p => `${p.name} (${p.version || 'prázdný'})`).join(', ')} — nic k dělání`); return finish('done', { result: { partitions: info.partitions } }); }
      if (info.uptime_sec < (settings.min_uptime_min || 0) * 60) { L('error', `uptime jen ${Math.round(info.uptime_sec / 60)} min — nedávno restartováno`); return finish('blocked', { error: 'nízký uptime' }); }
      if (info.device_mode && info.device_mode.partitions === false) {
        const r = await this.ensureDeviceMode(c, raw, info, L, W, setStep, creds, connect, settings, { partitions: true });
        c = r.client;
        if (!r.changed) {
          L('error', 'device-mode má partitions=no — povolit jde jen s fyzickým potvrzením: „/system device-mode update partitions=yes" a do 5 minut stisknout reset tlačítko nebo odpojit napájení (nebo nastav PoE rodiče v seznamu, pak to nástroj udělá sám)');
          return finish('blocked', { error: 'device-mode zakazuje partitions (fyzické potvrzení)' });
        }
      } else if (info.device_mode) L('info', `device-mode: ${info.device_mode.mode}, partitions=yes`);
      const kids = db.children(devId);
      if (kids.length) W(`zařízení má ${kids.length} podřízených prvků — při restartu krátce vypadnou`);
      // záloha konfigurace + binární backup
      setStep('záloha', 'backup');
      await this.doBackup(c, raw, info, itemId, L, W, { require_binary_backup: false });
      // repartition přes dočasný skript (bez interaktivního dotazu); router se hned restartuje a formátuje
      setStep(`repartition ${count}`, 'reboot');
      L('info', `spouštím /partitions repartition ${count} — router zformátuje flash mimo aktivní systém a restartuje se (data mimo konfiguraci budou smazána)`);
      await c.exec('/system script remove [find name="mtu-repart"]', { timeoutMs: 15000, allowError: true });
      await c.exec(`/system script add name="mtu-repart" policy=ftp,reboot,read,write,policy,test,password,sniff,sensitive source="/partitions repartition ${count}"`, { timeoutMs: 15000 });
      let out = '';
      try { out = await c.exec('/system script run mtu-repart', { timeoutMs: 60000, allowError: true }); } catch (e) { out = e.message; }
      if (out.trim()) L('info', 'router: ' + out.trim().split('\n')[0].slice(0, 200));
      try { c.close(); } catch {}
      const r = await this.waitCycle(creds, connect, L, setStep, settings, 180000);
      if (!r.rebooted) {
        c = r.client;
        if (c) { await c.exec('/system script remove [find name="mtu-repart"]', { timeoutMs: 15000, allowError: true }).catch(() => {}); const pl = await c.list('/partitions', ['name', 'size', 'active', 'running', 'version']); L('warn', `oddíly nyní: ${(pl || []).map(p => p.name).join(', ') || '?'}`); }
        return finish('failed', { error: 'router se po repartition nerestartoval — zkontroluj /partitions a /log ručně' });
      }
      if (!r.client) return finish('failed', { error: `router se po repartition nevrátil do ${settings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ (${raw.host})` });
      c = r.client;
      setStep('ověření', 'verify');
      await c.exec('/system script remove [find name="mtu-repart"]', { timeoutMs: 15000, allowError: true }).catch(() => {});
      const after = await inspect(c, { full: true });
      db.updateDevice(devId, { ...toDeviceFields(after), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
      if (after.identity !== info.identity) { L('error', `po restartu odpovídá jiná identita "${after.identity}"`); return finish('failed', { error: 'jiná identita po restartu' }); }
      if (after.version !== info.version) W(`verze po restartu ${after.version} (před ${info.version})`);
      this.comparePost(info, after, W);
      L('info', `oddíly: ${after.partitions.map(p => `${p.name} ${(p.size || '?')} MB ${p.running ? '[běží]' : ''} ${p.version ? '(' + p.version + ')' : '(prázdný)'}`).join(', ')}`);
      if (after.partitions.length < count) { L('error', `po restartu je jen ${after.partitions.length} oddílů`); return finish('failed', { error: 'repartition neproběhl' }); }
      L('info', `✔ flash rozdělena na ${after.partitions.length} oddíly. Při příštím upgradu se běžící systém zkopíruje do záložního oddílu jako fallback.`);
      await this.waitForChildren(devId, L, setStep, W, settings);
      return finish('done', { result: { partitions: after.partitions } });
    } catch (e) {
      L('error', 'CHYBA: ' + e.message);
      return finish('failed', { error: e.message });
    } finally { try { c && c.close(); } catch {} }
  }

  /** najde port nadřazeného MikroTiku, který napájí toto zařízení (podle sousedů na PoE portech) */
  findPoePath(raw) {
    if (!raw.parent_id) return null;
    const par = db.getDeviceRaw(raw.parent_id);
    if (!par || par.managed === 0 || !par.enabled || !par.username) return null;
    let f = {}; try { f = JSON.parse(par.flags || '{}'); } catch {}
    const kids = f.poe_children || [];
    const isMe = (k) => (k.address && k.address === raw.host) || (k.identity && raw.identity && k.identity === raw.identity);
    const portOf = (k) => (k.iface || '').split(/[;,\/]/).find(x => (f.poe_ports || []).some(pp => pp.name === x)) || '';
    const ports = [...new Set(kids.filter(isMe).map(portOf))].filter(Boolean);
    if (ports.length !== 1) return null;
    // na portu nesmí viset nic jiného — jinak by PoE restart shodil další zařízení (switch, celou lokalitu)
    const others = kids.filter(k => portOf(k) === ports[0] && !isMe(k));
    if (others.length) return { blocked: `na portu ${ports[0]} rodiče jsou i další zařízení (${[...new Set(others.map(o => o.identity || o.address))].join(', ')})` };
    const pp = (f.poe_ports || []).find(x => x.name === ports[0]);
    return { parent: par, port: ports[0], mode: pp ? pp.mode : 'auto-on' };
  }

  /** studený restart zařízení: vypnout/zapnout PoE na portu rodiče; vrací true když se to povedlo */
  async poeCycle(path, L, settings) {
    const par = path.parent;
    const mk = () => new RosClient({ host: par.host, port: par.port, username: par.username, password: decrypt(par.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: par.host_key || '' });
    let pc = mk();
    await pc.connect();
    try {
      const cur = await pc.kv('/interface ethernet', ['name']); // jen test spojení
      const st = await pc.exec(`:put ([/interface ethernet poe monitor "${path.port}" once as-value]->"poe-out-status")`, { timeoutMs: 20000, allowError: true });
      L('info', `PoE restart přes ${devLabel(par)} port ${path.port} (stav: ${st.trim() || '?'}, režim ${path.mode})`);
      if (!/powered/i.test(st)) throw new Error(`port ${path.port} na rodiči nehlásí napájení (${st.trim()})`);
      await pc.exec(`/interface ethernet set [find name="${path.port}"] poe-out=off`, { timeoutMs: 15000 });
      await sleep(8000);
      // zapnutí zpět je kritické — opakovat i s novým spojením, dokud se nepovede
      let on = false, lastErr = '';
      for (let i = 0; i < 6 && !on; i++) {
        try {
          if (!pc.conn || pc.closed) { try { pc.close(); } catch {} pc = mk(); await pc.connect(); }
          await pc.exec(`/interface ethernet set [find name="${path.port}"] poe-out=${path.mode || 'auto-on'}`, { timeoutMs: 15000 });
          const chk = (await pc.list('/interface ethernet', ['name', 'poe-out'], { where: `name="${path.port}"` })) || [];
          if (chk[0] && !/auto-on|forced-on/i.test(chk[0]['poe-out'] || '')) throw new Error(`poe-out je stále ${chk[0]['poe-out']}`);
          on = true;
        } catch (e) { lastErr = e.message; L('warn', `zapnutí PoE na ${path.port} selhalo (${e.message}), zkouším znovu`); await sleep(10000); }
      }
      if (!on) throw new Error(`NEPODAŘILO SE ZAPNOUT PoE na ${par.host} port ${path.port} (${lastErr}) — zařízení je BEZ NAPÁJENÍ, zapni ručně: /interface ethernet set ${path.port} poe-out=${path.mode || 'auto-on'}`);
      L('info', `PoE na ${path.port} znovu zapnuto (${path.mode || 'auto-on'})`);
      return true;
    } finally { pc.close(); }
  }

  /**
   * device-mode „plné ovládání": mode=advanced + partitions=yes. Změna vyžaduje studený restart → jde jen přes PoE rodiče.
   * Vrací {client, changed}. Nikdy nespotřebuje pokus, když není jak potvrdit.
   */
  async ensureDeviceMode(c, raw, info, L, W, setStep, creds, connect, settings, want = { mode: 'advanced', partitions: true }) {
    const dm = info.device_mode;
    if (!dm) return { client: c, changed: false };
    const need = [];
    const fullModes = ['advanced', 'enterprise', 'rose'];
    if (want.mode && !fullModes.includes(dm.mode)) need.push(`mode=${want.mode}`);
    if (want.partitions && dm.partitions === false && info.total_hdd >= 128 * MB) need.push('partitions=yes');
    if (!need.length) { L('info', `device-mode ${dm.mode}${dm.partitions ? ', partitions=yes' : ''} — v pořádku`); return { client: c, changed: false }; }
    const path = this.findPoePath(raw);
    if (!path || path.blocked) { W(`device-mode ${dm.mode}${dm.partitions === false ? ', partitions=no' : ''} — změna na ${need.join(' ')} vyžaduje tlačítko nebo odpojení napájení; ${path && path.blocked ? path.blocked : 'zařízení nemá v seznamu PoE rodiče, který ho napájí'} → nechávám`); return { client: c, changed: false }; }
    if (dm.attempts >= 3) { W(`device-mode: vyčerpány 3 pokusy o změnu (attempt-count=${dm.attempts}) — nutný fyzický reset počítadla`); return { client: c, changed: false }; }
    setStep('device-mode', 'checking');
    L('info', `device-mode: nastavuji ${need.join(' ')} (potvrzení studeným restartem přes PoE rodiče)`);
    let out = await c.exec(`/system device-mode update ${need.join(' ')} activation-timeout=10m`, { timeoutMs: 20000, allowError: true });
    if (/syntax error|unknown parameter|bad command|failure|expected/i.test(out)) out = await c.exec(`/system device-mode update ${need.join(' ')}`, { timeoutMs: 20000, allowError: true });
    if (/syntax error|unknown parameter|bad command|failure|expected/i.test(out)) { W(`device-mode update router odmítl: ${out.trim().split('\n')[0]} — bez změny`); return { client: c, changed: false }; }
    L('info', 'device-mode update přijat: ' + (out.trim().split('\n')[0] || '(bez výstupu)'));
    try { c.close(); } catch {}
    try { await this.poeCycle(path, L, settings); }
    catch (e) { W(`PoE restart selhal (${e.message}) — změna device-mode se do 10 min sama zruší`); const cl = await connect(); return { client: cl, changed: false }; }
    const r = await this.waitCycle(creds, connect, L, setStep, settings, 60000);
    if (!r.client) throw new Error(`zařízení se po PoE restartu nevrátilo do ${settings.reboot_timeout_min} min — ZKONTROLUJ (${raw.host})`);
    const after = await r.client.kv('/system device-mode', ['mode', 'partitions', 'attempt-count']);
    const ok = (!want.mode || after.mode === want.mode || after.mode === 'rose') && (!want.partitions || info.total_hdd < 128 * MB || after.partitions === 'true' || after.partitions === 'yes');
    if (ok) L('info', `✔ device-mode ${after.mode}, partitions=${after.partitions}`);
    else W(`device-mode po restartu: ${after.mode}, partitions=${after.partitions} — změna se neprojevila (attempt-count=${after['attempt-count']})`);
    return { client: r.client, changed: ok };
  }

  /**
   * Po restartu ověří, že se bezdrátové spoje obnovily: stanice je zpět na stejném AP, sektoru se vrátilo ≥ link_return_pct % klientů,
   * 60 GHz je spojené s MCS ≥ 1 a protějšky zpět, CAP je registrovaný u CAPsMAN. Čeká až link_wait_min (DFS CAC na 5 GHz trvá až 10 min).
   * Neúspěch = položka selže → job se (při stop při chybě) zastaví dřív, než by přišel na řadu nadřazený prvek.
   */
  async verifyLinks(c, before, after, L, setStep, W, settings) {
    const bl = before && before.links;
    if (!bl) return { ok: true };
    const pct = settings.link_return_pct || 80;
    const waitMs = (settings.link_wait_min || 12) * 60000;
    const stations = (bl.stations || []).filter(s => s.ap);
    const aps = (bl.aps || []).filter(a => a.clients && a.clients.length);
    const w60 = (bl.w60g || []).filter(w => w.connected);
    if (!stations.length && !aps.length && !w60.length && !bl.cap) return { ok: true };
    const major = (after && after.versionParsed && after.versionParsed.major) || 7;
    const t0 = Date.now();
    const macEq = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
    let problems = [], summary = [], radarSeenAt = 0, radarLogged = false, lastRoamCheck = 0, roamed = new Map();
    // 60 GHz: po navázání spoje se kvalita (signál %, PER, MCS) teprve ustaluje (beamforming) → hodnotí se až po W60_SETTLE_MS
    // od prvního spojení, a to z nejlepšího z posledních vzorků (PER je klouzavá hodnota, hned po startu je zkreslená)
    const W60_SETTLE_MS = 90000;
    const w60Seen = new Map(), w60Samples = new Map(), w60Judged = new Set();
    const fdbSeen = new Map(), fdbOk = new Set(), fdbPort = new Map(); // sektory: od kdy jsou klienti zpět / FDB ověřena / je port bridge
    const raw = this.currentRaw;
    setStep('ověření bezdrátových spojů', 'verify');
    while (true) {
      const now = await I.inspectLinks(c, major);
      problems = []; summary = [];
      for (const s of stations) {
        const cur = (now.stations || []).find(x => x.iface === s.iface);
        if (!cur || !cur.ap) problems.push(`stanice ${s.iface} není připojená k AP`);
        else if (!macEq(cur.ap.mac, s.ap.mac)) problems.push(`stanice ${s.iface} se připojila k jinému AP (${cur.ap.mac} místo ${s.ap.mac})`);
        else {
          summary.push(`${s.iface}→AP ${cur.ap.mac} ${cur.ap.signal ?? '?'} dBm (před ${s.ap.signal ?? '?'})`);
          if (cur.ap.signal !== null && s.ap.signal !== null && cur.ap.signal < s.ap.signal - 6) W(`signál stanice ${s.iface} po restartu klesl: ${s.ap.signal} → ${cur.ap.signal} dBm`);
          if (cur.ap.signal !== null && cur.ap.signal < Number(settings.radio_min_signal ?? -75)) W(`slabý signál stanice ${s.iface} po restartu: ${cur.ap.signal} dBm`);
        }
      }
      for (const a of aps) {
        const cur = (now.aps || []).find(x => x.iface === a.iface);
        const back = a.clients.filter(cl => cur && cur.clients.some(x => macEq(x.mac, cl.mac)));
        let missing = a.clients.filter(cl => !back.includes(cl));
        // klienti, kteří se během výpadku přepojili na sousední sektor se stejným SSID (typicky při DFS), jsou online → počítají se jako vrácení
        if (missing.length && a.ssid && Date.now() - lastRoamCheck > 60000) { lastRoamCheck = Date.now(); roamed = await this.clientsOnSiblingSectors(a.ssid, missing.map(cl => cl.mac), raw && raw.id); }
        const elsewhere = missing.filter(cl => roamed.has(String(cl.mac).toUpperCase()));
        missing = missing.filter(cl => !elsewhere.includes(cl));
        const ratio = (back.length + elsewhere.length) * 100 / a.clients.length;
        const roamNote = elsewhere.length ? `, ${elsewhere.length} na sousedním sektoru (${[...new Set(elsewhere.map(cl => roamed.get(String(cl.mac).toUpperCase())))].join(', ')})` : '';
        if (ratio < pct) problems.push(`sektor ${a.iface}: vrátilo se ${back.length}/${a.clients.length} klientů${roamNote} (chybí ${missing.map(cl => cl.mac).join(', ')})`);
        else {
          summary.push(`${a.iface}: ${back.length}/${a.clients.length} klientů zpět${roamNote}`);
          // klienti registrovaní ≠ klienti funkční: když je sektor port bridge, musí se bridge do ~90 s naučit jejich MAC (FDB).
          // Jinak jsou klienti bez IP konektivity, i když registrace vypadá v pořádku (8.9.2026 sektor S1 MM po 6.49 → 7.24.2)
          if (back.length) {
            if (!fdbSeen.has(a.iface)) fdbSeen.set(a.iface, Date.now());
            if (Date.now() - fdbSeen.get(a.iface) >= 90000 && !fdbOk.has(a.iface)) {
              let isPort = fdbPort.get(a.iface);
              if (isPort === undefined) { try { isPort = /\S/.test(String(await c.exec(`/interface bridge port print without-paging where interface="${a.iface}"`, { timeoutMs: 15000, allowError: true })).replace(/^(Flags|Columns|#).*$/gm, '').trim()); } catch { isPort = false; } fdbPort.set(a.iface, isPort); }
              if (isPort) {
                let fdb = '';
                try { fdb = String(await c.exec(`/interface bridge host print without-paging where on-interface="${a.iface}"`, { timeoutMs: 15000, allowError: true })).toUpperCase(); } catch {}
                const learned = back.filter(cl => fdb.includes(String(cl.mac).toUpperCase()));
                if (learned.length) fdbOk.add(a.iface);
                else problems.push(`sektor ${a.iface}: ${back.length} klientů je registrovaných, ale bridge se od nich nenaučil žádnou MAC (FDB) — klienti jsou bez IP konektivity, i když registrace vypadá dobře`);
              } else fdbOk.add(a.iface);
            }
          }
        }
      }
      for (const w of w60) {
        const cur = (now.w60g || []).find(x => x.iface === w.iface);
        if (!cur || !cur.connected) { problems.push(`60 GHz ${w.iface} není spojené`); continue; }
        const back = (w.stations || []).filter(st => (cur.stations || []).some(x => macEq(x.mac, st.mac)));
        const missing = (w.stations || []).filter(st => !back.includes(st));
        if (/^station/.test(w.mode || '') ? missing.length : (back.length * 100 / Math.max(1, w.stations.length)) < pct) problems.push(`60 GHz ${w.iface}: chybí protějšek ${missing.map(x => x.mac).join(', ')} (zpět ${back.length}/${w.stations.length})`);
        else if (cur.mcs !== null && cur.mcs < 1) problems.push(`60 GHz ${w.iface}: MCS 0 — spoj bez datové rychlosti (příznak regrese typu 7.19.4)`);
        else {
          if (!w60Seen.has(w.iface)) w60Seen.set(w.iface, Date.now());
          const samples = w60Samples.get(w.iface) || []; samples.push({ mcs: cur.mcs, stations: (cur.stations || []).map(x => ({ mac: x.mac, signal: x.signal, per: x.per })) }); w60Samples.set(w.iface, samples.slice(-4));
          const settled = Date.now() - w60Seen.get(w.iface);
          if (settled < W60_SETTLE_MS) { problems.push(`60 GHz ${w.iface}: spojeno, čekám na ustálení spoje (beamforming) ${Math.round((W60_SETTLE_MS - settled) / 1000)} s`); continue; }
          summary.push(`${w.iface}: ${back.length}/${w.stations.length} protějšků, MCS ${cur.mcs ?? '?'} (před ${w.mcs ?? '?'}), ${cur.rssi ?? '?'} dBm`);
          if (!w60Judged.has(w.iface)) {
            w60Judged.add(w.iface);
            const recent = w60Samples.get(w.iface) || [];
            const bestMcs = Math.max(...recent.map(x => x.mcs).filter(x => x !== null && x !== undefined), -1);
            if (bestMcs >= 0 && w.mcs !== null && bestMcs < w.mcs - 2) W(`60 GHz ${w.iface}: MCS po restartu klesl ${w.mcs} → ${bestMcs} (nejlepší z ${recent.length} vzorků po ustálení)`);
            for (const x of cur.stations || []) {
              const mine = recent.flatMap(r => r.stations.filter(y => macEq(y.mac, x.mac)));
              const bestSig = Math.max(...mine.map(y => y.signal).filter(y => y !== null && y !== undefined), -1);
              const pers = mine.map(y => y.per).filter(y => y !== null && y !== undefined);
              const bestPer = pers.length ? Math.min(...pers) : null;
              if (bestSig >= 0 && bestSig < Number(settings.radio_min_signal60 ?? 50)) W(`60 GHz ${w.iface} → ${x.mac}: slabá kvalita po restartu ${bestSig} % (nejlepší z ${mine.length} vzorků po ustálení)`);
              if (bestPer !== null && bestPer > Number(settings.radio_max_per ?? 5)) W(`60 GHz ${w.iface} → ${x.mac}: chybovost po restartu ${bestPer} % (nejnižší z ${mine.length} vzorků po ustálení)`);
              else if (bestPer !== null && pers.some(y => y > Number(settings.radio_max_per ?? 5))) L('info', `60 GHz ${w.iface} → ${x.mac}: chybovost se po startu ustálila na ${bestPer} % (špičky ${Math.max(...pers)} %)`);
            }
          }
        }
      }
      if (bl.cap) {
        if (!now.cap || !now.cap.manager) problems.push(`CAP není registrovaný u CAPsMAN (před: ${bl.cap.manager || '?'})`);
        else summary.push(`CAP u ${now.cap.manager}`);
      }
      if (!problems.length) { L('info', `✔ bezdrátové spoje obnoveny za ${Math.round((Date.now() - t0) / 1000)} s: ${summary.join('; ')}`); return { ok: true }; }
      if (this.cancelRequested || this.skipRequested) return { ok: false, error: 'zrušeno během ověřování spojů' };
      // DFS: sektor na kanálu s kontrolou radaru (u meteoradarového pásma 5600–5650 MHz trvá 10 min) klienty pustí až po ní →
      // dokud monitor hlásí radar-detecting, čekání se prodlužuje (nejvýš o 12 min, po skončení kontroly ještě 3 min na návrat klientů)
      let radar = false;
      for (const a of aps) if (problems.some(p => p.startsWith(`sektor ${a.iface}`))) { try { const m = await c.exec(`/interface wireless monitor ${a.iface} once`, { timeoutMs: 15000 }); if (/status:\s*radar-detecting/.test(m)) radar = true; } catch {} }
      if (radar) { radarSeenAt = Date.now(); if (!radarLogged) { radarLogged = true; L('info', 'DFS: sektor dělá kontrolu radaru (radar-detecting), klienti se vrátí až po ní — čekání se prodlužuje'); } }
      const deadline = t0 + waitMs + Math.min(12 * 60000, radarSeenAt ? Math.max(0, radarSeenAt + 3 * 60000 - (t0 + waitMs)) : 0);
      if (Date.now() >= deadline) {
        for (const p of problems) L('error', 'SPOJ: ' + p);
        return { ok: false, error: `bezdrátové spoje se neobnovily do ${Math.round((deadline - t0) / 60000)} min: ${problems.join('; ')} — ZKONTROLUJ, než se bude pokračovat na nadřazený prvek` };
      }
      setStep(`čekám na spoje (${Math.round((Date.now() - t0) / 1000)} s): ${problems[0].slice(0, 70)}`, 'verify');
      await sleep(10000);
    }
  }

  /**
   * Kteří z hledaných klientů (MAC) jsou registrovaní na jiných sektorech se stejným SSID (kterýkoli uživatel — síť je jedna).
   * Vrací Map MAC → název sektoru. Sousední sektory se čtou přes SSH s krátkým timeoutem, nejvýš 6 kusů.
   */
  async clientsOnSiblingSectors(ssid, macs, exceptId) {
    const out = new Map();
    const want = new Set(macs.map(m => String(m).toUpperCase()));
    if (!want.size) return out;
    const sib = db.listDevices().filter(d => d.id !== exceptId && d.enabled && d.managed && !d.dup_of && d.flags && d.flags.links && (d.flags.links.aps || []).some(a => a.ssid === ssid && /^ap/.test(a.mode || ''))).slice(0, 6);
    for (const d of sib) {
      const r = db.getDeviceRaw(d.id); if (!r || !r.username) continue;
      const c = new RosClient({ host: r.host, port: r.port, username: r.username, password: decrypt(r.password_enc), timeoutMs: 10000, expectedHostKey: r.host_key || '' });
      try {
        await c.connect();
        const txt = await c.exec(':foreach i in=[/interface wireless registration-table find] do={:put [/interface wireless registration-table get $i mac-address]}', { timeoutMs: 10000 });
        for (const line of String(txt).split(/\r?\n/)) { const m = line.trim().toUpperCase(); if (want.has(m)) out.set(m, devLabel(d)); }
      } catch {} finally { try { c.close(); } catch {} }
      if (out.size >= want.size) break;
    }
    return out;
  }

  /** po restartu: paměťový log je čerstvý → hledat selhání instalace, pád jádra, vadnou flash a otisky kompromitace; device-mode flagged */
  async postBootCheck(c, before, after, L, W) {
    // cesta ke správě: brána z routeru odpovídá, sousedi nezmizeli (rozpadlý bridge/VLAN se pozná dřív, než přijde na řadu rodič)
    try {
      const gw = before && before.uplink && before.uplink.gateway;
      if (gw) {
        const out = (await c.exec(`:put [/ping ${gw} count=3 interval=1s]`, { timeoutMs: 20000, allowError: true })).trim().split('\n').pop();
        const n = parseInt(out, 10);
        if (Number.isFinite(n) && n === 0) W(`brána ${gw} z routeru po upgradu neodpovídá na ping — zkontroluj bridge/VLAN/routy, cesta ke správě může být rozbitá`);
        else if (Number.isFinite(n)) L('info', `ping na bránu ${gw} z routeru: ${n}/3`);
      }
      const nb = (before && before.neighbors || []).length, na = (after && after.neighbors || []).length;
      if (nb >= 2 && na < Math.ceil(nb / 2)) W(`po upgradu vidí router jen ${na} sousedů (před ${nb}) — možná rozpadlý bridge nebo VLAN`);
    } catch (e) { L('warn', 'kontrola cesty ke správě selhala: ' + e.message); }
    try {
      const sym = await I.logSymptoms(c);
      for (const s of sym.slice(0, 6)) {
        if (/login failure for user -2/i.test(s)) W('!!! po restartu v logu „login failure for user -2" — pokus o zneužití SSH zranitelnosti (CVE 9/2026)');
        else if (/not enough|broken package|Damaged|bad image|missing|upgrade failed/i.test(s)) W('log po restartu hlásí problém instalace: ' + s);
        else if (/kernel failure|rebooted without proper shutdown|out of memory|bad block|NAND/i.test(s)) W('log po restartu: ' + s);
      }
    } catch (e) { L('warn', 'kontrola logu po restartu selhala: ' + e.message); }
    const dm = after && after.device_mode;
    if (dm && dm.flagged) W('!!! device-mode je po restartu FLAGGED — RouterOS detekoval možnou kompromitaci (cizí účet „ops", skripty, scheduler); prověř zařízení a pak `/system/device-mode/update flagged=no`');
    const pk = (after && after.packages) || [];
    const bad = pk.filter(p => p.disabled);
    if (bad.length) W(`po restartu jsou vypnuté balíčky: ${bad.map(p => p.name).join(', ')}`);
    if (after && after.total_hdd && after.total_hdd <= 16.5 * MB && after.free_hdd && after.free_hdd < 300 * 1024) W(`po upgradu zbývá jen ${Math.round(after.free_hdd / 1024)} kB flash — pod ~200 kB přestává jít ukládat konfigurace; zvaž úklid souborů`);
  }

  /** najde zařízení v DB podle MAC některého jeho rádiového rozhraní (z posledního skenu) */
  findDeviceByLinkMac(mac, exceptId) {
    const m = String(mac || '').toUpperCase();
    if (!m) return null;
    for (const d of db.listDevices()) {
      if (d.id === exceptId) continue;
      const l = d.flags && d.flags.links;
      if (!l) continue;
      const macs = [...(l.w60g || []), ...(l.stations || []), ...(l.aps || []), ...(l.wifi || [])].map(x => String(x.mac || '').toUpperCase());
      if (macs.includes(m)) return d;
    }
    return null;
  }

  /** zařízení v DB odpovídající sousedovi (podle adresy nebo identity) */
  deviceOfNeighbor(n, exceptId) {
    if (!n) return null;
    // hledá se napříč všemi uživateli (fyzická síť je jedna): podle adresy, podle kterékoli IP zařízení (router má víc rozhraní), nebo podle identity;
    // přednost mají aktivní hlavní záznamy před vypnutými duplicitami
    const all = db.listDevices().filter(d => d.id !== exceptId).sort((a, b) => (b.enabled && !b.dup_of) - (a.enabled && !a.dup_of));
    const hasIp = (d, ip) => !!ip && !/^192\.168\.88\./.test(ip) && (d.host === ip || (d.flags && Array.isArray(d.flags.ip_addresses) && d.flags.ip_addresses.includes(ip)));
    return all.find(d => hasIp(d, n.address)) || (n.identity ? all.find(d => d.identity && d.identity === n.identity) : null) || null;
  }
  /** PoE prvek nad zařízením (přímý soused na uplinku), do kterého nástroj nemá přístup → není jistota, že potomkovi během restartu neutne napájení */
  poeParentChecks(devId, info, settings) {
    const out = { blockers: [], warnings: [], notes: [] };
    const up = info && info.uplink;
    if (!up) return out;
    const me = db.getDeviceRaw(devId);
    if (me && me.ignore_poe) { out.notes.push('kontrola PoE prvku nad zařízením je u tohoto zařízení vypnutá (ignorovat PoE ovladatelnost)'); return out; }
    const cands = up.neighbor ? [up.neighbor] : (up.neighbors_on_iface || []);
    const seen = new Set();
    for (const n of cands) {
      const key = n.address || n.identity || n.mac; if (!key || seen.has(key)) continue; seen.add(key);
      let dev = this.deviceOfNeighbor(n, devId);
      if (dev && dev.dup_of) dev = db.getDevice(dev.dup_of) || dev;
      // naskenované zařízení: PoE prvek je jen tehdy, když má nějaký port s poe-out zapnutým (auto-on/forced-on); jinak odhad podle desky
      const scannedPoe = dev && dev.flags && Array.isArray(dev.flags.poe_ports) ? dev.flags.poe_ports.length > 0 : null;
      const isPoe = scannedPoe !== null ? scannedPoe : (POE_BOARD_RE.test(n.board || '') || /poe/i.test(n.identity || ''));
      if (!isPoe) continue;
      if (dev && dev.managed && dev.enabled) {
        const wds = ((dev.flags && dev.flags.poe_watchdogs) || []).filter(w => !w.disabled);
        out.notes.push(`nad zařízením je PoE prvek ${devLabel(dev)} (${n.board || '?'}), je v seznamu — PoE watchdog: ${wds.length ? `${wds.map(w => `${w.kind} ${w.name}${w.iface ? ` (${w.iface})` : ''}`).join(', ')} → před restartem se vypne` : 'žádný (ověřeno ze skenu)'}`);
        continue;
      }
      const msg = `nad zařízením je podle sousedů PoE prvek „${n.identity || '?'}" (${n.board || '?'}, ${n.address || n.mac || '?'})${dev ? ' bez loginu' : ', který není v seznamu'} — neovladatelný PoE switch: nejde ověřit ani vypnout jeho PoE watchdog, není jistota, že potomkovi během restartu neodpojí napájení. Přidej ho skenem (s loginem), nebo upgraduj ručně.`;
      (settings.block_unmanaged_poe ? out.blockers : out.warnings).push(msg);
    }
    return out;
  }

  /** druhý konec spoje: je v seznamu? je v jobu? je v topologii, aby šla anténa před sektorem? (60 GHz = kritické, 5 GHz stanice→AP = varování) */
  peerChecks(jobId, devId, info, settings) {
    const out = { blockers: [], warnings: [] };
    const links = info && info.links;
    if (!links) return out;
    const inJob = new Set(db.getJobItems(jobId).map(i => i.device_id));
    const me = db.getDeviceRaw(devId) || {};
    const peers = [];
    for (const w of links.w60g || []) for (const s of w.stations || []) peers.push({ mac: s.mac, iface: w.iface, kind: '60 GHz', critical: true });
    for (const s of links.stations || []) if (s.ap) peers.push({ mac: s.ap.mac, iface: s.iface, kind: 'AP', critical: false });
    const seen = new Set();
    for (const p of peers) {
      if (seen.has(p.mac)) continue; seen.add(p.mac);
      const dev = this.findDeviceByLinkMac(p.mac, devId);
      if (!dev) { if (p.critical) out.warnings.push(`druhý konec 60 GHz spoje ${p.iface} (${p.mac}) není v seznamu zařízení — nelze zajistit stejnou verzi na obou koncích; přidej ho skenem`); continue; }
      const name = devLabel(dev);
      if (!inJob.has(dev.id)) {
        const msg = `druhý konec spoje ${p.iface} = ${name} (${dev.host}, ROS ${dev.version || '?'}) není v tomto jobu — u 60 GHz/PtP má být stejná verze na obou koncích v jednom okně (nejdřív konec vzdálenější od jádra)`;
        (p.critical && settings.require_peer_in_job ? out.blockers : out.warnings).push(msg);
        continue;
      }
      const related = dev.parent_id === devId || me.parent_id === dev.id;
      if (!related) out.warnings.push(`druhý konec spoje ${p.iface} = ${name} je v jobu, ale není nastaven jako nadřazený/podřízený prvek — nastav topologii, aby anténa šla před sektorem`);
    }
    return out;
  }

  comparePost(before, after, W) {
    const names = a => new Set((a || []).map(i => i.name));
    const bi = names(before.interfaces), ai = names(after.interfaces);
    const missing = [...bi].filter(n => !ai.has(n));
    if (missing.length) W(`po upgradu chybí rozhraní: ${missing.join(', ')}`);
    const ba = new Set((before.addresses || []).map(a => a.address + '@' + a.interface)), aa = new Set((after.addresses || []).map(a => a.address + '@' + a.interface));
    const missA = [...ba].filter(n => !aa.has(n));
    if (missA.length) W(`po upgradu chybí IP adresy: ${missA.join(', ')}`);
    const wBefore = (before.flags.wireless || 0) + (before.flags.wifi || 0) + (before.flags.wifiwave2 || 0);
    const wAfter = (after.flags.wireless || 0) + (after.flags.wifi || 0) + (after.flags.wifiwave2 || 0);
    if (wBefore > 0 && wAfter === 0) W(`POZOR: před upgradem bylo ${wBefore} bezdrátových rozhraní, po upgradu žádné — chybí wireless/wifi balíček?`);
    const runBefore = (before.interfaces || []).filter(i => i.running === 'true' && i.disabled !== 'true').map(i => i.name);
    const runAfter = new Set((after.interfaces || []).filter(i => i.running === 'true').map(i => i.name));
    const down = runBefore.filter(n => ai.has(n) && !runAfter.has(n));
    if (down.length) W(`rozhraní běžela před upgradem a teď ne: ${down.join(', ')}`);
    // tichá ztráta konfigurace: pokles počtu položek v hlavních menu
    const cb = before.counts || {}, ca = after.counts || {};
    const lost = Object.keys(cb).filter(k => k in ca && ca[k] < cb[k]).map(k => `${k} ${cb[k]} → ${ca[k]}`);
    if (lost.length) W(`po upgradu ubylo položek konfigurace: ${lost.join(', ')} — porovnej s exportem před upgradem (detail zařízení → Zálohy)`);
  }

  /** vlastní restartovací scheduler/netwatch zařízení vypnout na dobu položky; vrací funkci pro zapnutí zpět (připojí se znovu) */
  async pauseOwnRebootScripts(c, connect, list, L, W) {
    const rs = (list || []).filter(r => !r.disabled);
    if (!rs.length) return null;
    const sel = (r) => r.kind === 'netwatch' ? `/tool netwatch set [find host="${r.name}"]` : `/system scheduler set [find name="${r.name}"]`;
    try {
      for (const r of rs) await c.exec(`${sel(r)} disabled=yes`, { timeoutMs: 15000 });
      L('info', `vlastní restart zařízení dočasně vypnut: ${rs.map(r => `${r.kind} ${r.name}`).join(', ')} (zapne se po dokončení položky)`);
    } catch (e) { W(`nepodařilo se vypnout vlastní restartovací skript (${e.message}) — zařízení by se mohlo restartovat samo během upgradu`); return null; }
    return async () => {
      let cl = null;
      try { cl = await connect(); for (const r of rs) await cl.exec(`${sel(r)} disabled=no`, { timeoutMs: 15000 }); L('info', 'vlastní restartovací scheduler/netwatch zapnut zpět'); }
      finally { try { cl && cl.close(); } catch {} }
    };
  }

  /**
   * Zámek napříč uživateli: před restartem počkat, dokud jiný uživatel právě neupgraduje zařízení fyzicky nad/pod tímto
   * (rodič/potomek v DB, soused na uplinku, PoE dítě, rádiový protějšek). Fronty jsou po uživatelích, síť ne.
   */
  async waitForPhysicalLock(raw, L, setStep) {
    if (!this.pool || !raw) return;
    const t0 = Date.now();
    let logged = false;
    while (true) {
      const other = this.pool.conflictFor(raw, this);
      if (!other) { this.waitingLockFor = 0; return; }
      this.waitingLockFor = other ? (db.listDevices().find(d => d.host === other.host) || {}).id || 0 : 0;
      if (!logged) { logged = true; L('warn', `čekám: jiný uživatel (${other.user}) právě upgraduje ${other.name} (${other.host}), které je fyzicky nad/pod tímto zařízením — restart až po něm`); }
      if (Date.now() - t0 > 60 * 60000) { L('warn', 'čekání na cizí upgrade sousedního zařízení trvá přes hodinu — pokračuji'); return; }
      setStep(`čekám na cizí upgrade ${other.name}`, 'checking');
      await sleep(15000);
      if (this.cancelRequested || this.skipRequested) return;
    }
  }

  async doBackup(c, raw, info, itemId, L, W, opt) {
    const stamp = ts();
    const dir = path.join(cfg.backupDir, String(raw.id));
    fs.mkdirSync(dir, { recursive: true });
    const base = `${stamp}_${safeName(info.identity)}_${info.version}`;
    // textový export (vždy, přes stdout)
    let text = '';
    try { text = await c.exec('/export show-sensitive', { timeoutMs: 180000 }); }
    catch { text = await c.exec('/export', { timeoutMs: 180000 }); }
    if (!text || text.length < 40 || !/^#|^\//m.test(text)) throw new Error('export konfigurace je prázdný/nečitelný — bez zálohy nepokračuji');
    const rscPath = path.join(dir, base + '.rsc');
    fs.writeFileSync(rscPath, text);
    db.addBackup({ device_id: raw.id, job_item_id: itemId, kind: 'export', filename: path.relative(cfg.backupDir, rscPath), size: text.length, version: info.version });
    L('info', `export konfigurace uložen (${(text.length / 1024).toFixed(1)} kB)`);
    // binární záloha
    const rname = `mtu-${stamp}`;
    try {
      try { await c.exec(`/system backup save name="${rname}" dont-encrypt=yes`, { timeoutMs: 60000 }); }
      catch { await c.exec(`/system backup save name="${rname}"`, { timeoutMs: 60000 }); }
      const local = path.join(dir, base + '.backup');
      const size = await c.download(`${rname}.backup`, local);
      if (size < 1000) throw new Error('stažená záloha je podezřele malá');
      db.addBackup({ device_id: raw.id, job_item_id: itemId, kind: 'backup', filename: path.relative(cfg.backupDir, local), size, version: info.version });
      L('info', `binární záloha stažena (${(size / 1024).toFixed(1)} kB)`);
    } catch (e) {
      if (opt.require_binary_backup) throw new Error('binární záloha selhala: ' + e.message);
      W('binární .backup se nepodařilo stáhnout (' + e.message + ') — pokračuji jen s .rsc exportem');
    } finally {
      try { await c.exec(`/file remove "${rname}.backup"`, { timeoutMs: 15000, allowError: true }); } catch {}
    }
  }

  /**
   * Router při restartu instaluje každý .npk zvlášť: co odmítne (poškozený, špatný podpis), jen zaloguje a nabootuje bez něj —
   * u přechodu přes 7.13 pak zařízení běží bez balíčku wireless, tedy bez rádií, a je nedosažitelné. Nahrané balíčky, které router
   * přijal, ukazuje /system package jako „scheduled for installation/upgrade“. Když jiný balíček zařazený je a tenhle ne, nerestartovat.
   * Když router žádné zařazení nehlásí (jiné znění, stará verze), jen upozornit.
   */
  async checkScheduled(c, hop, L, W) {
    let rows = null;
    try { rows = await c.list('/system package', ['name', 'version', 'scheduled']); } catch {}
    if (!rows) { W('nejde přečíst /system package — zařazení balíčků k instalaci neověřeno'); return { ok: true, checked: false }; }
    const sched = rows.filter(r => /schedul/i.test(r.scheduled || ''));
    // pole „scheduled“ RouterOS u ručně nahraných balíčků nenastavuje (ověřeno 8.9.2026 na v6.49 i v7.24 při skutečných hopech) — bez zařazených
    // balíčků se nic nehlásí; přijetí balíčku routerem se ověřuje typem „package“ v /file (viz stageViaUpload)
    if (!sched.length) return { ok: true, checked: false };
    L('info', `router hlásí k instalaci: ${sched.map(r => `${r.name} ${r.version} (${r.scheduled})`).join(', ')}`);
    const missing = hop.packages.filter(pk => !sched.some(r => r.name === pk.name || r.name === `${pk.name}-${hop.arch || ''}`.replace(/-$/, '') || (r.version === hop.to && new RegExp(`^${pk.name}\\b`, 'i').test(r.name))));
    if (missing.length) {
      for (const pk of missing) L('error', `balíček ${pk.file} router NEZAŘADIL k instalaci (jiné ano) — po restartu by běžel bez něj`);
      return { ok: false, error: `router nepřijal balíček ${missing.map(pk => pk.file).join(', ')} (není v /system package jako scheduled) — nerestartuji; nahraj ho znovu nebo zkontroluj /log na routeru` };
    }
    return { ok: true, checked: true };
  }

  /** ke každé stanici doplní sektor ze seznamu zařízení (podle MAC rádia) s jeho country/frequency-mode/frekvencí — pro kontrolu v planneru */
  /** živě přečíst country/frequency-mode rozhraní sektoru s danou MAC (legacy wireless i wifi/ax); null = rozhraní nenalezeno.
   *  Čte se výpis všech rádií a vybírá podle MAC (get [find mac-address=…] přes kv je pro parser RouterOS syntax error). */
  async readApRadio(c, mac, driver) {
    const up = (m) => String(m || '').toUpperCase();
    if (driver !== 'wifi') {
      const w = (await c.list('/interface wireless', ['name', 'mac-address', 'country', 'frequency-mode', 'frequency', 'band'])) || [];
      const x = w.find(i => up(i['mac-address']) === up(mac));
      if (x) return { driver: 'wireless', country: x.country || '', freqMode: x['frequency-mode'] || '', frequency: x.frequency || '', band: x.band || '', live: true };
      if (driver === 'wireless') return null;
    }
    const wf = (await c.list('/interface wifi', ['name', 'mac-address', 'configuration.country', 'configuration.installation', 'channel.frequency', 'channel.band'])) || [];
    const x = wf.find(i => up(i['mac-address']) === up(mac));
    if (x) return { driver: 'wifi', country: x['configuration.country'] || '', installation: x['configuration.installation'] || '', frequency: x['channel.frequency'] || '', band: x['channel.band'] || '', live: true };
    return null;
  }


  /**
   * Ke každé stanici doplnit sektor (s.apDev) pro kontrolu country/frequency-mode:
   * 1) sektor v seznamu zařízení (podle MAC rádia z posledního skenu) → hodnoty živě přes jeho login,
   * 2) jinak podle sousedů stanice (MNDP na wlan: MAC souseda = MAC rádia sektoru) → IP; login ze seznamu (stejná IP) nebo z userdb.
   * Čte se jen identity a nastavení rádia, nic se nezapisuje.
   */
  async enrichStationAps(info, L, raw) {
    const st = (info.links && info.links.stations) || [];
    if (!st.some(s => s.ap && s.ap.mac)) return;
    const up = (m) => String(m || '').toUpperCase();
    const all = db.listDevices();
    const neighbors = [...(info.neighbors || []), ...((info.uplink && info.uplink.neighbors_on_iface) || [])];
    for (const s of st) {
      if (!s.ap || !s.ap.mac) continue;
      const mac = up(s.ap.mac);
      let d = null, a = null;
      for (const x of all) { const lk = (x.flags && x.flags.links) || {}; a = [...(lk.aps || []), ...(lk.wifi || [])].find(y => up(y.mac) === mac); if (a) { d = x; break; } }
      const nb = neighbors.find(n => up(n.mac) === mac && n.address);
      if (!d && nb) { d = all.find(x => x.host === nb.address) || null; if (d) s.apHint = 'db-host'; }
      if (nb) s.apNeighbor = { host: nb.address, identity: nb.identity || '', board: nb.board || '' };
      if (d) {
        s.apDev = { host: d.host, identity: d.identity || d.name || (nb && nb.identity) || '', driver: a ? (a.driver || 'wireless') : '', country: a ? a.country || '' : '', freqMode: a ? a.freqMode || '' : '', installation: a ? a.installation || '' : '', frequency: a ? a.frequency || '' : '', band: a ? a.band || '' : '', version: d.version || '' };
        // živě ze sektoru (DB může být ze starého skenu bez country/frequency-mode); při chybě zůstanou hodnoty z DB
        try {
          const raw = db.getDeviceRaw(d.id);
          if (raw && raw.managed !== 0) {
            const c = new RosClient({ host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc), timeoutMs: 15000, expectedHostKey: raw.host_key || '' });
            try { await c.connect(); const live = await this.readApRadio(c, s.ap.mac, s.apDev.driver); if (live) Object.assign(s.apDev, live); else L && L('info', `sektor ${s.apDev.identity}: country nejde přečíst živě (rozhraní s MAC ${s.ap.mac} nenalezeno)`); }
            finally { try { c.close(); } catch {} }
          }
        } catch (e) { L && L('info', `sektor ${s.apDev.identity || d.host}: country/frequency-mode nejde přečíst živě (${String(e.message).slice(0, 60)}) — beru hodnoty z posledního skenu`); }
        continue;
      }
      // sektor není v seznamu: dohledat jeho IP a přihlásit se loginem z userdb (jen adresy povolených rozsahů; čte se identity a rádio, nic víc).
      // Kandidáti: 1) soused se stejnou MAC (MNDP na wlan hlásí MAC rádia), 2) infrastruktura APčka stanice z userdb (ne členové),
      // 3) sousedé na wlan se „sousední“ MAC (MikroTik čísluje ether/wlan téhož kusu po sobě: ether …6E:A8, wlan …6E:AA)
      if (!userdb.enabled()) continue;
      const cands = [];
      const addC = (host, identity, why) => { if (host && hostAllowed(host, cfg.scanAllow) && !cands.some(x => x.host === host)) cands.push({ host, identity: identity || '', why }); };
      if (nb) addC(nb.address, nb.identity, 'stejná MAC v sousedech');
      if (raw && raw.userdb_ap_id) { try { for (const x of await userdb.devicesForAp(raw.userdb_ap_id)) if (!x.member) addC(x.ip, x.name, `infrastruktura APčka ${raw.userdb_ap || raw.userdb_ap_id} v userdb`); } catch (e) { L && L('info', `userdb: zařízení APčka ${raw.userdb_ap_id} nejdou načíst (${String(e.message).slice(0, 60)})`); } }
      const macNum = (m) => parseInt(up(m).replace(/[^0-9A-F]/g, ''), 16);
      const apn = macNum(mac);
      for (const n of neighbors) { if (!n.mac || !n.address || up(n.mac) === mac) continue; const d = Math.abs(macNum(n.mac) - apn); if (Number.isFinite(d) && d <= 32 && up(n.mac).slice(0, 8) === mac.slice(0, 8)) addC(n.address, n.identity, 'sousední MAC v sousedech'); }
      if (!cands.length) { L && L('info', `sektor ${s.ap.mac} není v seznamu zařízení a nepodařilo se dohledat jeho IP (sousedé ani userdb) — country/frequency-mode se neověří`); continue; }
      // pořadí: stejná MAC → infrastruktura z userdb, která je zároveň sousedem na wlan → jméno jako sektor → ostatní (zkouší se nejvýš 6)
      const nbHosts = new Set(neighbors.map(n => n.address));
      const rank = (x) => x.why.startsWith('stejná') ? 0 : x.why.startsWith('sousední') ? 1 : nbHosts.has(x.host) ? 2 : /sektor|sector|\bap\b|[.-]s\d|\bs\d/i.test(x.identity) ? 3 : 4;
      cands.sort((a, b) => rank(a) - rank(b));
      let found = false; const fails = [];
      for (const cand of cands.slice(0, 6)) {
        const label = `${cand.identity || cand.host}${cand.identity ? ` ${cand.host}` : ''}`;
        try {
          const cr = await userdb.getCredentials(cand.host);
          if (!cr) { fails.push(`${label}: userdb nemá login`); continue; }
          const c = new RosClient({ host: cand.host, port: 22, username: cr.login, password: cr.password, timeoutMs: 15000 });
          try {
            await c.connect();
            const live = await this.readApRadio(c, s.ap.mac, '');
            if (!live) { fails.push(`${label}: rádio s MAC ${s.ap.mac} tam není`); continue; }
            const id = await c.kv('/system identity', ['name']);
            s.apDev = { host: cand.host, identity: (id && id.name) || cand.identity || '', external: 'userdb', version: '', ...live };
            L && L('info', `sektor ${s.apDev.identity} (${cand.host}, ${cand.why}) není v seznamu zařízení — country/frequency-mode přečteny živě přes login z userdb`);
            found = true; break;
          } finally { try { c.close(); } catch {} }
        } catch (e) {
          let why = String(e.message).slice(0, 60);
          if (/ECONNREFUSED/.test(why)) { const wb = await probeTcp(cand.host, 8291, 3000).catch(() => false); why = wb ? 'SSH zavřené, Winbox otevřený — zapni na něm /ip service ssh' : 'SSH zavřené'; if (wb && s.apNeighbor && s.apNeighbor.host === cand.host) s.apNeighbor.sshClosed = true; }
          fails.push(`${label}: ${why}`);
        }
      }
      if (!found) L && L('info', `sektor ${s.ap.mac} není v seznamu zařízení a nenašel se ani přes userdb (${cands.length} kandidátů; ${fails.join('; ')}) — country/frequency-mode se neověří`);
    }
  }




  /** kolik hlášek o zápisu firmware (úspěch/neúspěch) je v logu — porovnává se před a po příkazu, log se nemaže */
  async firmwareLogCount(c) {
    try {
      const out = await c.exec('/log print without-paging where message~"irmware"', { timeoutMs: 15000, allowError: true });
      const lines = String(out).split('\n').map(l => l.trim()).filter(Boolean);
      const oks = lines.filter(l => /firmware upgraded successfully/i.test(l)), bads = lines.filter(l => /firmware.*(fail|error)|(fail|error).*firmware/i.test(l) && !/successfully/i.test(l));
      // počet i text poslední hlášky (s časem) — kdyby log mezitím rotoval, pozná se nová hláška podle změny posledního řádku
      return { ok: oks.length, bad: bads.length, lastOk: oks[oks.length - 1] || '', lastBad: bads[bads.length - 1] || '' };
    } catch { return { ok: 0, bad: 0, lastOk: '', lastBad: '' }; }
  }
  /** čeká (max 2 min) na novou hlášku v logu o zápisu RouterBOOT: 'ok' | 'failed' | 'timeout' */
  async waitFirmwareLog(c, before, L) {
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await sleep(3000);
      if (this.cancelRequested) return 'timeout';
      const now = await this.firmwareLogCount(c);
      if (now.ok > before.ok || (now.lastOk && now.lastOk !== before.lastOk)) { L('info', `log potvrdil zápis firmware po ${Math.round((Date.now() - t0) / 1000)} s: ${now.lastOk.slice(0, 100)}`); return 'ok'; }
      if (now.bad > before.bad || (now.lastBad && now.lastBad !== before.lastBad)) { L('warn', 'log: ' + now.lastBad.slice(0, 120)); return 'failed'; }
    }
    return 'timeout';
  }
  /** upgrade RouterBOOT (přes dočasný skript, aby nebyl interaktivní dotaz) + restart + ověření */
  async doFirmware(c, connect, info, L, setStep, W, creds, settings, devId) {
    if (!info.routerboard) { L('info', 'není RouterBOARD — firmware se neřeší'); return c; }
    const rb = await c.kv('/system routerboard', ['current-firmware', 'upgrade-firmware']);
    if (!rb['upgrade-firmware'] || rb['current-firmware'] === rb['upgrade-firmware']) { L('info', `firmware ${rb['current-firmware']} je aktuální`); return c; }
    if ((info.fwf_files || []).length) { W(`v kořeni je cizí RouterBOOT soubor (${info.fwf_files.join(', ')}) — upgrade firmware by ho použil/selhal; přeskakuji firmware, smaž soubor ručně`); return c; }
    setStep(`firmware ${rb['current-firmware']} → ${rb['upgrade-firmware']}`, 'firmware');
    const fwLogBefore = await this.firmwareLogCount(c);
    // auto-upgrade=yes: RouterOS už nový RouterBOOT zapsal sám při startu (v logu je od startu „Firmware upgraded successfully") —
    // zápis neopakovat, stačí restart. Log je v RAM a po restartu prázdný, takže hláška v něm je vždy z tohoto běhu.
    const autoDone = !!(info.flags && info.flags.fw_auto_upgrade) && fwLogBefore.ok > 0;
    if (autoDone) L('info', `router má auto-upgrade firmware: nový RouterBOOT ${rb['upgrade-firmware']} už zapsal sám při startu (${fwLogBefore.lastOk.slice(0, 80)}) — jen restart`);
    else {
      L('info', `upgrade firmware RouterBOOT ${rb['current-firmware']} → ${rb['upgrade-firmware']}`);
      await c.exec('/system script remove [find name="mtu-fwup"]', { timeoutMs: 15000, allowError: true });
      await c.exec('/system script add name="mtu-fwup" policy=ftp,reboot,read,write,policy,test,password,sniff,sensitive source="/system routerboard upgrade"', { timeoutMs: 15000 });
      let out = '';
      try { out = await c.exec('/system script run mtu-fwup', { timeoutMs: 90000, allowError: true }); }
      finally { await c.exec('/system script remove [find name="mtu-fwup"]', { timeoutMs: 15000, allowError: true }).catch(() => {}); }
      if (out.trim()) L('info', 'upgrade RouterBOOT: ' + out.trim().split('\n')[0]);
      if (/not allowed by device-mode/i.test(out)) { W('upgrade firmware zamítnut device-mode (routerboard=no) — povol `/system/device-mode/update routerboard=yes` (vyžaduje fyzické potvrzení tlačítkem/odpojením napájení); RouterOS je upgradovaný, jen RouterBOOT zůstal'); return c; }
      if (/failure|error/i.test(out) && !/success/i.test(out)) { W('upgrade firmware selhal: ' + out.trim().split('\n')[0].slice(0, 120) + ' — nerestartuji'); return c; }
      // příkaz se vrátí hned, RouterBOOT se zapisuje na pozadí; restart smí přijít až po hlášce v logu
      // „Firmware upgraded successfully, please reboot for changes to take effect!" (MikroTik: RouterBOOT upgrade). Bez potvrzení nerestartovat.
      setStep('čekám na potvrzení zápisu firmware v logu', 'firmware');
      const fw = await this.waitFirmwareLog(c, fwLogBefore, L);
      if (fw === 'failed') { W('router hlásí v logu neúspěšný zápis firmware — nerestartuji, RouterBOOT zůstal ' + rb['current-firmware']); return c; }
      if (fw !== 'ok') { W('router do 2 min nepotvrdil v logu zápis firmware — pro jistotu nerestartuji; firmware se aktivuje při příštím restartu, zkontroluj /log'); return c; }
    }
    setStep('restart po firmware', 'reboot');
    const r = await this.rebootAndWait(c, creds, connect, L, setStep, settings);
    if (!r.rebooted) { W('router se po upgrade firmware nerestartoval — firmware se aktivuje při příštím restartu'); return r.client; }
    if (!r.client) throw new Error(`router se po restartu (firmware) nevrátil do ${settings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ`);
    const rb2 = await r.client.kv('/system routerboard', ['current-firmware', 'upgrade-firmware']);
    if (rb2['current-firmware'] !== rb['upgrade-firmware']) W(`firmware po restartu ${rb2['current-firmware']}, očekáváno ${rb['upgrade-firmware']}`);
    else L('info', `✔ firmware ${rb2['current-firmware']}`);
    const lv = await this.verifyLinks(r.client, info, null, L, setStep, W, settings);
    if (!lv.ok) throw new Error(lv.error);
    await this.waitForChildren(devId, L, setStep, W, settings);
    return r.client;
  }

  /** pošle /system reboot, počká na výpadek a návrat; vrací {rebooted, client} */
  async rebootAndWait(c, creds, connect, L, setStep, settings) {
    const tLock = Date.now();
    await this.waitForPhysicalLock(this.currentRaw, L, setStep);
    // zrušení/přeskočení během čekání na zámek: nerestartovat (nahrané balíčky uklidí volající)
    if (this.cancelRequested || this.skipRequested) throw new Error('zrušeno během čekání na cizí upgrade — restart neproveden');
    // po delším čekání mohl router (7.16+: timeout nečinné SSH session) spojení zavřít → příkaz reboot by se ztratil; ověřit a případně znovu připojit
    if (Date.now() - tLock > 30000) {
      let alive = false;
      try { alive = /^1/.test(String(await c.exec(':put 1', { timeoutMs: 8000 })).trim()); } catch {}
      if (!alive) { L('info', 'spojení po čekání na zámek už neodpovídá — připojuji znovu před restartem'); try { c.close(); } catch {} c = await connect(); this.currentClient = c; }
    }
    try { await c.exec('/system reboot', { timeoutMs: 8000, allowError: true }); } catch (e) { /* spojení typicky spadne */ }
    try { c.close(); } catch {}
    return this.waitCycle(creds, connect, L, setStep, settings, 120000);
  }

  /** čeká na výpadek (do downTimeoutMs) a návrat routeru; vrací {rebooted, client} */
  async waitCycle(creds, connect, L, setStep, settings, downTimeoutMs) {
    const port = creds.port || 22;
    // 1) čekej na výpadek
    let down = false;
    const downEnd = Date.now() + downTimeoutMs;
    while (Date.now() < downEnd) {
      if (!(await probeTcp(creds.host, port, 2000))) { down = true; break; }
      await sleep(3000);
    }
    if (!down) {
      L('warn', `router se nerestartoval (SSH stále odpovídá po ${Math.round(downTimeoutMs / 1000)} s)`);
      let cl = null;
      try { cl = await connect(); } catch {}
      return { rebooted: false, client: cl };
    }
    L('info', 'router je nedostupný (restartuje se), čekám na návrat');
    // 2) čekej na návrat
    const upEnd = Date.now() + (settings.reboot_timeout_min || 15) * 60000;
    const t0 = Date.now();
    while (Date.now() < upEnd) {
      if (await probeTcp(creds.host, port, 3000)) {
        L('info', `port ${port} znovu otevřen po ${Math.round((Date.now() - t0) / 1000)} s, čekám 20 s na naběhnutí služeb`);
        await sleep(20000);
        // opakované pokusy s rozestupem > 60 s: klasická MikroTik „SSH brute-force" pravidla blacklistují 4 nová spojení během minuty
        for (let i = 0; i < 6; i++) {
          try { const cl = await connect(); return { rebooted: true, client: cl }; }
          catch (e) { L('info', `SSH ještě nejde (${e.message}), další pokus za 65 s`); setStep('čekám na SSH po restartu'); await sleep(65000); }
        }
        break;
      }
      const el = Math.round((Date.now() - t0) / 1000);
      if (el % 60 < 5) setStep(`čekám na návrat routeru (${Math.round(el / 60)} min)`);
      await sleep(5000);
    }
    L('error', `router se nevrátil do ${settings.reboot_timeout_min} min!`);
    // zařízení hned označit jako nedostupné (statistika „umřelo po upgradu“, filtr nedostupných) — jinak by v seznamu svítilo „OK“ až do dalšího skenu
    if (this.currentDeviceId) { try { db.updateDevice(this.currentDeviceId, { scan_status: 'unreachable', scan_error: `po restartu se nevrátil do ${settings.reboot_timeout_min} min (upgrade)` }); } catch {} }
    return { rebooted: true, client: null };
  }

  getPkg(tk) {
    const p = this.pkgTokens.get(tk);
    if (!p || p.expires < Date.now()) return null;
    return p;
  }
}

/** fyzická sousednost dvou zařízení: rodič/potomek, soused na uplinku, PoE dítě, rádiový protějšek — podle posledního skenu */
function physicallyAdjacent(a, b) {
  // „Fyzicky nad/pod“ = restart jednoho utne spoj nebo napájení druhého. Bere se jen přímá vazba:
  // rodič/potomek v topologii, přímý soused na uplinku (brána), zařízení napájené z PoE portu, rádiový protějšek (stanice↔AP, 60 GHz).
  // Záměrně NE celý seznam sousedů na bridgi (na velkém L2 segmentu jsou to desítky cizích zařízení) ani shoda identity
  // (identity jako „MikroTik“ má v síti víc kusů) — to dřív dělalo falešné zámky mezi nesouvisejícími zařízeními.
  if (!a || !b || a.id === b.id) return false;
  if (a.parent_id === b.id || b.parent_id === a.id) return true;
  const fl = (d) => { try { return JSON.parse(d.flags || '{}'); } catch { return {}; } };
  const fa = fl(a), fb = fl(b);
  const up = (m) => String(m || '').toUpperCase();
  // adresy výchozí konfigurace (192.168.88.x) má spousta kusů → podle nich se sousedství nepozná
  const usable = (ip) => !!ip && !/^192\.168\.88\./.test(ip) && ip !== '0.0.0.0';
  const ips = (d, f) => [d.host, ...(Array.isArray(f.ip_addresses) ? f.ip_addresses : [])].filter(usable);
  const byAddr = (n, d, f) => !!(n && usable(n.address)) && ips(d, f).includes(n.address);
  // přímý soused na uplinku (jen když je jednoznačný) a PoE děti
  if (byAddr(fa.uplink && fa.uplink.neighbor, b, fb) || byAddr(fb.uplink && fb.uplink.neighbor, a, fa)) return true;
  if ((fa.poe_children || []).some(n => byAddr(n, b, fb)) || (fb.poe_children || []).some(n => byAddr(n, a, fa))) return true;
  // rádio: MAC mého AP / protějšku / klienta je MAC rádia toho druhého
  const radioMacs = (f) => { const l = f.links || {}; return [...(l.aps || []), ...(l.w60g || []), ...(l.wifi || []), ...(l.stations || [])].map(x => up(x.mac)).filter(Boolean); };
  const peers = (f) => { const l = f.links || {}; return [...(l.stations || []).map(s => s.ap && s.ap.mac), ...(l.w60g || []).map(w => w.remote), ...(l.w60g || []).flatMap(w => (w.stations || []).map(x => x.mac)), ...(l.aps || []).flatMap(x => (x.clients || []).map(cl => cl.mac)), ...(l.wifi || []).flatMap(x => (x.clients || []).map(cl => cl.mac))].map(up).filter(Boolean); };
  return peers(fa).some(m => radioMacs(fb).includes(m)) || peers(fb).some(m => radioMacs(fa).includes(m));
}

/**
 * Jeden runner na uživatele: každý si spouští své upgrady nezávisle na ostatních, naráz běží nejvýš jeden job na uživatele.
 * Naplánované joby (status "scheduled", options.start_at) spouští časovač, jakmile má uživatel volno.
 */
/**
 * Jeden runner na job: jobů může běžet libovolně mnoho naráz (i jednoho uživatele), každý zpracovává svá zařízení po jednom.
 * Ochrany napříč joby: zařízení nesmí být ve dvou jobech současně, před restartem se čeká, když jiný job právě upgraduje
 * fyzicky sousedící zařízení (rodič/potomek, soused na uplinku, PoE dítě, rádiový protějšek). Naplánované joby spouští časovač.
 */
class RunnerPool extends EventEmitter {
  constructor() {
    super();
    this._draining = false; this._drainAt = 0; // před aktualizací serveru (deploy): joby dokončí aktuální zařízení a pozastaví se
    this.runners = new Map(); this._tickWarned = new Map(); // jobId -> Runner (jen běžící)
    Runner.recoverAfterRestart();
    this._tick = setInterval(() => this.tickScheduled(), 20000);
    this._tick.unref();
  }
  /** zařízení jiného runneru, které je fyzicky nad/pod `raw` (nebo null) */
  conflictFor(raw, self) {
    for (const r of this.runners.values()) {
      if (r === self || !r.busy || !r.currentDeviceId) continue;
      const other = db.getDeviceRaw(r.currentDeviceId);
      if (other && physicallyAdjacent(raw, other)) {
        // vzájemné čekání (druhý runner čeká na zámek kvůli nám): pokračuje job s nižším číslem, druhý počká — jinak by oba stály až do timeoutu
        if (r.waitingLockFor === raw.id && self && self.currentJobId < r.currentJobId) continue;
        const u = db.getUser(r.ownerId); return { name: devLabel(other), host: other.host, user: u ? (u.userdb_nick || u.name) : '?', jobId: r.currentJobId };
      }
    }
    return null;
  }
  runnerOfJob(jobId) { const r = this.runners.get(Number(jobId)); return r && r.busy ? r : null; }
  isDeviceBusy(id) { for (const r of this.runners.values()) if (r.isDeviceBusy(id)) return true; return false; }
  isItemBusy(itemId) { for (const r of this.runners.values()) if (r.currentItemId === itemId) return true; return false; }
  /** všechny právě běžící joby (stav runnerů) */
  running() { return [...this.runners.values()].filter(r => r.busy).map(r => r.status()); }
  /** stav pro uživatele: seznam jeho běžících jobů (+ první z nich v polích jobId/itemId/deviceId kvůli kompatibilitě) */
  status(ownerId) {
    const jobs = this.running().filter(x => x.ownerId === (Number(ownerId) || 0));
    const first = jobs[0] || { jobId: 0, itemId: 0, deviceId: 0, pauseRequested: false, cancelRequested: false };
    return { running: jobs.length > 0, ownerId: Number(ownerId) || 0, jobs, jobId: first.jobId, itemId: first.itemId, deviceId: first.deviceId, pauseRequested: first.pauseRequested, cancelRequested: first.cancelRequested };
  }
  /** nový runner pro job; po skončení se z mapy odstraní */
  _spawn(jobId, ownerId) {
    const r = new Runner(); r.ownerId = Number(ownerId) || 0; r.pool = this;
    r.on('event', (ev) => { this.emit('event', ev); if (ev.type === 'runner' && ev.status && !ev.status.running) setTimeout(() => { if (this.runners.get(jobId) === r && !r.busy) this.runners.delete(jobId); }, 500); });
    this.runners.set(Number(jobId), r);
    return r;
  }
  start(jobId) {
    const job = db.getJob(jobId);
    if (!job) throw new Error('job neexistuje');
    if (['done', 'cancelled'].includes(job.status)) throw new Error('job je už ukončený');
    if (this.runnerOfJob(jobId)) throw new Error(`job #${jobId} už běží`);
    // zařízení nesmí být v jiném běžícím jobu (ani mezi jeho dosud nezpracovanými položkami)
    const reserved = new Set();
    for (const r of this.runners.values()) if (r.busy && r.currentJobId !== Number(jobId)) for (const it of db.getJobItems(r.currentJobId)) if (it.status === 'pending' || ACTIVE_ITEM.has(it.status)) reserved.add(it.device_id);
    const busyDev = db.getJobItems(jobId).find(it => it.status === 'pending' && reserved.has(it.device_id));
    if (busyDev) throw new Error(`zařízení ${busyDev.dev_name || busyDev.host} je v jiném běžícím jobu — počkej, až skončí`);
    return this._spawn(jobId, job.owner_id).start(jobId);
  }
  /**
   * Naplánovaný job: kontrola hned při vytvoření (a na vyžádání), aby se problémy daly opravit ještě za dne.
   * Job zůstává ve stavu scheduled; výsledek jde do options.early_precheck a do logu. Před skutečným startem se kontrola dělá znovu.
   */
  async earlyPrecheck(jobId) {
    const job = db.getJob(jobId);
    if (!job) throw new Error('job neexistuje');
    if (job.status !== 'scheduled') throw new Error('předběžná kontrola je jen pro naplánované joby');
    if (this.runnerOfJob(jobId)) throw new Error('u tohoto jobu právě běží kontrola');
    const r = this._spawn(jobId, job.owner_id); r.currentJobId = jobId;
    r.emit('event', { type: 'runner', status: r.status() });
    const when = job.options && job.options.start_at ? new Date(job.options.start_at * 1000).toLocaleString('cs-CZ') : '?';
    try {
      db.addLog(jobId, 0, 0, 'info', `Předběžná kontrola naplánovaného jobu (start ${when}): co by v tu chvíli bránilo upgradu, jde opravit už teď.`);
      const res = await r.precheckAll(jobId, job.options || {}, { early: true });
      const reasons = db.getJobItems(jobId).filter(it => /^přeskočí se/.test(it.step || '')).map(it => `${devLabel(it)}: ${it.step.replace(/^přeskočí se: /, '')}`);
      const warns = db.getJobItems(jobId).filter(it => it.status === 'pending' && it.warnings && it.warnings.length).map(it => `${devLabel(it)}: ${it.warnings.join(' | ')}`);
      const summary = `${res.ready} připraveno, ${res.blocked} se přeskočí${res.warned ? `, ${res.warned} s upozorněním` : ''}`;
      const j2 = db.getJob(jobId);
      if (j2 && j2.status === 'scheduled') db.updateJob(jobId, { status_note: `spustí se ${when}; předběžná kontrola: ${summary}`, options: { ...j2.options, early_precheck: { at: Date.now(), ...res, reasons, warns } } });
      db.addLog(jobId, 0, 0, res.blocked ? 'warn' : 'info', `Předběžná kontrola hotová: ${summary}.${res.blocked ? ' Zablokovaná zařízení se při startu přeskočí, pokud se to do té doby nespraví (kontrola se před startem opakuje).' : ' Před startem se kontrola zopakuje.'}`);
      return res;
    } finally { r.currentJobId = 0; r.currentItemId = 0; r.currentDeviceId = 0; r.emitJob(jobId); r.emit('event', { type: 'runner', status: r.status() }); }
  }
  /** kompatibilita: dřív fronta na uživatele, teď se spouští rovnou (výjimka: při aktualizaci serveru se job jen zařadí a spustí po restartu) */
  startOrQueue(jobId) {
    if (this.draining) { db.updateJob(jobId, { status: 'queued', status_note: 'server se za chvíli aktualizuje — job se spustí hned po restartu' }); db.addLog(jobId, 0, 0, 'info', 'Server se aktualizuje, job se spustí hned po restartu.'); return { queued: true, behind: 0 }; } this.start(jobId); return { queued: false }; }
  repartition(devId, count) {
    const d = db.getDevice(devId); if (!d) throw new Error('zařízení neexistuje');
    if (this.isDeviceBusy(devId)) throw new Error('zařízení je právě v jobu');
    const r = new Runner(); r.ownerId = d.owner_id || 0; r.pool = this;
    const jobId = r.repartition(devId, count);
    this.runners.set(Number(jobId), r);
    r.on('event', (ev) => { this.emit('event', ev); if (ev.type === 'runner' && ev.status && !ev.status.running) setTimeout(() => { if (!r.busy) this.runners.delete(Number(jobId)); }, 500); });
    return jobId;
  }
  getPkg(tk) { for (const r of this.runners.values()) { const p = r.getPkg(tk); if (p) return p; } return null; }
  emitJob(jobId) { this.emit('event', { type: 'job', job: db.getJobSummary(jobId) }); }
  emitItem(itemId) { const it = db.getJobItem(itemId); if (it) this.emit('event', { type: 'item', item: it }); }
  /** před aktualizací serveru: běžící joby dokončí aktuální zařízení a pozastaví se, nové se jen zařadí; po restartu vše pokračuje samo */
  setDraining(on) { this._draining = !!on; this._drainAt = Date.now(); if (!on) this.tickScheduled(); return this.draining; }
  /** drain platí jen 5 min od posledního potvrzení deploy skriptem (ten ho obnovuje každých 15 s) — přerušený deploy nesmí nechat joby stát */
  get draining() { if (this._draining && Date.now() - this._drainAt > 5 * 60000) { this._draining = false; console.log('drain vypršel (deploy se neozývá) — joby pokračují'); setImmediate(() => this.tickScheduled()); } return this._draining; }
  tickScheduled() {
    if (this.draining) return;
    const now = Date.now() / 1000;
    for (const j of db.listJobs(200)) {
      const due = (j.status === 'scheduled' && j.options && j.options.start_at && j.options.start_at <= now) || j.status === 'queued';
      if (!due || this.runnerOfJob(j.id)) continue;
      try { db.addLog(j.id, 0, 0, 'info', j.status === 'scheduled' ? `Naplánované spuštění (${new Date(j.options.start_at * 1000).toLocaleString('cs-CZ')}).` : 'Spuštění z fronty.'); this.start(j.id); }
      catch (e) {
        const last = this._tickWarned.get(j.id) || 0;
        if (Date.now() - last > 10 * 60 * 1000) { this._tickWarned.set(j.id, Date.now()); db.addLog(j.id, 0, 0, 'warn', 'spuštění zatím nejde: ' + e.message + ' — zkouším to dál každých 20 s'); }
      }
    }
  }
}

module.exports = { Runner, RunnerPool, inWindow, physicallyAdjacent };
