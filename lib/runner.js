'use strict';
// Job engine: sériově zpracovává zařízení v jobu. Každý krok loguje do DB a vysílá události (SSE).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const cfg = require('./config');
const db = require('./db');
const { decrypt, token } = require('./crypto');
const { RosClient, probeTcp, sleep } = require('./ros');
const { inspect, toDeviceFields } = require('./inspect');
const { plan } = require('./planner');
const V = require('./versions');

const MB = 1048576;
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
    this.recoverAfterRestart();
  }

  recoverAfterRestart() {
    for (const j of db.listJobs(200)) {
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
    return { running: this.busy, jobId: this.currentJobId, itemId: this.currentItemId, deviceId: this.currentDeviceId, pauseRequested: this.pauseRequested, cancelRequested: this.cancelRequested };
  }

  emitJob(jobId) { this.emit('event', { type: 'job', job: db.listJobs(200).find(j => j.id === jobId) || null }); }
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
  cancel() { if (this.busy) { this.cancelRequested = true; } this.emit('event', { type: 'runner', status: this.status() }); }
  skipCurrent() { if (this.busy) this.skipRequested = true; }

  // ---- hlavní smyčka jobu ----
  async runJob(jobId) {
    const job = db.getJob(jobId);
    const opt = job.options || {};
    db.updateJob(jobId, { status: 'running', status_note: '', started_at: job.started_at || db.now() });
    db.addLog(jobId, 0, 0, 'info', `Job "${job.name}" spuštěn (${opt.dry_run ? 'DRY RUN — nic se nemění' : 'ostrý běh'}, režim ${opt.mode || 'upload'})`);
    this.emitJob(jobId);
    await V.refreshLatest(true).catch(() => {});
    let waitingLogged = false;
    while (true) {
      if (this.cancelRequested) { db.updateJob(jobId, { status: 'cancelled', status_note: 'zrušeno uživatelem', finished_at: db.now() }); db.addLog(jobId, 0, 0, 'warn', 'Job zrušen.'); break; }
      if (this.pauseRequested) { db.updateJob(jobId, { status: 'paused', status_note: 'pozastaveno uživatelem' }); db.addLog(jobId, 0, 0, 'info', 'Job pozastaven.'); break; }
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
        db.updateJob(jobId, { status: 'done', status_note: failed ? `hotovo, ${failed} chyb` : 'hotovo', finished_at: db.now() });
        db.addLog(jobId, 0, 0, 'info', `Job dokončen (${items.filter(i => i.status === 'done').length}/${items.length} OK).`);
        break;
      }
      if (opt.window && !inWindow(opt.window)) {
        if (!waitingLogged) { db.addLog(jobId, 0, 0, 'info', `Mimo servisní okno ${opt.window} — čekám.`); waitingLogged = true; db.updateJob(jobId, { status: 'waiting-window', status_note: `čekám na okno ${opt.window}` }); this.emitJob(jobId); }
        await sleep(30000);
        continue;
      }
      if (waitingLogged) { waitingLogged = false; db.updateJob(jobId, { status: 'running', status_note: '' }); this.emitJob(jobId); }
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
        const p = Number.isFinite(+opt.pause_sec) ? +opt.pause_sec : (db.getSettings().pause_between_devices_sec || 0);
        if (p > 0) { db.addLog(jobId, 0, 0, 'info', `Pauza ${p} s před dalším zařízením.`); await this.interruptibleSleep(p * 1000); }
      }
    }
    this.emitJob(jobId);
  }

  checkPrecedingFailure() { return ''; }

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
      if (bad.length) { it.blockReason = `potomek ${bad.map(d => d.dev_name || d.identity || d.host).join(', ')} skončil chybou/neznámým stavem — nadřazený prvek se nerestartuje`; blockedItems.push(it); continue; }
      return { item: it };
    }
    return { item: null, blockedBy: blockedItems.length > 0, blockedItems };
  }

  /** po restartu nadřazeného prvku počkat, až se ozvou jeho potomci (PoE, sektory…) */
  async waitForChildren(devId, L, setStep, W, settings) {
    const kids = db.children(devId).filter(k => k.host);
    if (!kids.length) return;
    setStep(`čekám na potomky (${kids.length})`, 'verify');
    L('info', `zařízení má ${kids.length} podřízených prvků (${kids.map(k => k.name || k.identity || k.host).join(', ')}) — čekám, až se ozvou`);
    const end = Date.now() + (settings.reboot_timeout_min || 15) * 60000;
    const pending = new Map(kids.map(k => [k.id, k]));
    while (pending.size && Date.now() < end) {
      for (const k of [...pending.values()]) {
        const ports = k.managed ? [k.port || 22] : [22, 80, 443, 8291];
        let up = false;
        for (const p of ports) { if (await probeTcp(k.host, p, 2000)) { up = true; break; } }
        if (up) { pending.delete(k.id); L('info', `✔ potomek ${k.name || k.identity || k.host} odpovídá`); }
      }
      if (pending.size) await sleep(5000);
    }
    for (const k of pending.values()) W(`POZOR: podřízený prvek ${k.name || k.identity || k.host} (${k.host}) se po restartu nadřazeného neozval do ${settings.reboot_timeout_min} min`);
  }

  async interruptibleSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (this.cancelRequested || this.pauseRequested) return; await sleep(Math.min(1000, end - Date.now())); }
  }

  // ---- jedno zařízení ----
  async runItem(job, item, opt) {
    const jobId = job.id, itemId = item.id, devId = item.device_id;
    const raw = db.getDeviceRaw(devId);
    const settings = db.getSettings();
    const L = (level, msg) => { const id = db.addLog(jobId, itemId, devId, level, msg); this.emit('event', { type: 'log', log: { id, job_id: jobId, item_id: itemId, device_id: devId, ts: Date.now(), level, msg } }); };
    const setStep = (step, status) => { db.updateJobItem(itemId, { step, ...(status ? { status } : {}) }); this.emitItem(itemId); };
    const warnings = [];
    const W = (m) => { warnings.push(m); db.updateJobItem(itemId, { warnings }); L('warn', m); };
    const finish = (status, extra = {}) => { db.updateJobItem(itemId, { status, finished_at: db.now(), warnings, ...extra }); this.emitItem(itemId); return status; };
    const label = raw.name || raw.identity || raw.host;
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
      return cl;
    };
    let uploaded = []; // soubory nahrané na router v aktuálním hopu (pro úklid při chybě)
    const cleanupUploads = async () => {
      if (!c || !uploaded.length) return;
      for (const f of uploaded) { try { await c.exec(`/file remove "${f}"`, { timeoutMs: 15000, allowError: true }); L('info', `uklizeno: ${f} smazán z routeru`); } catch (e) { L('warn', `nepodařilo se smazat ${f}: ${e.message}`); } }
      uploaded = [];
    };

    try {
      c = await connect();
      L('info', 'SSH připojeno');
      let hopsDone = 0;
      let firstInfo = null;
      let fwBeforeDone = false;
      let dmDone = false;
      let rebootedByUs = false; // po vlastním restartu se nekontroluje min. uptime
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

        const p = await plan(info, { track: raw.track, settings, latest: V.getLatest(), options: { ...opt, ignore_uptime: rebootedByUs } });
        db.updateJobItem(itemId, { plan: { ...p, canary: item.plan?.canary || false }, to_version: p.target || '' });
        for (const w of p.warnings) if (!warnings.includes(w)) W(w);
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
        if (p.blockers.length) {
          for (const b of p.blockers) L('error', 'BLOKÁTOR: ' + b);
          return finish(hopsDone ? 'failed' : 'blocked', { error: p.blockers.join(' | ') });
        }
        if (p.nothingToDo) { L('info', `už je na cílové verzi ${p.target}, firmware aktuální — nic k dělání`); return finish('done', { result: { nothingToDo: true, hops: hopsDone } }); }
        if (opt.dry_run) {
          const desc = p.hops.map(h => `${h.from} → ${h.to} [${h.packages.map(x => x.file + ' ' + (x.size / MB).toFixed(1) + 'MB').join(', ')}; potřeba ${(h.needBytes / MB).toFixed(1)} MB, k dispozici ${(h.freeBytes / MB).toFixed(1)} MB ${h.stagingArea === 'ram' ? 'RAM' : 'flash'}]`).join('; ');
          L('info', `DRY RUN plán: ${desc || 'žádný hop'}${p.firmware ? `; firmware ${p.firmware.current} → ${p.firmware.upgrade}` : ''}`);
          return finish('done', { result: { dryRun: true, plan: p } });
        }

        if (p.upToDate) {
          // jen firmware
          if (opt.firmware === false) { L('info', 'RouterOS aktuální, firmware upgrade vypnut v jobu'); return finish('done', { result: { hops: hopsDone } }); }
          c = await this.doFirmware(c, connect, info, L, setStep, W, creds, settings, devId);
          const after = await inspect(c);
          db.updateDevice(devId, { ...toDeviceFields(after), last_scan_at: db.now(), last_seen_at: db.now(), last_upgrade_at: db.now() });
          db.updateJobItem(itemId, { to_fw: after.fw_current });
          L('info', `hotovo: RouterOS ${after.version}, firmware ${after.fw_current}`);
          return finish('done', { result: { hops: hopsDone, firmware: after.fw_current } });
        }

        const hop = p.hops[0];
        L('info', `HOP ${hop.from} → ${hop.to}: balíčky ${hop.packages.map(x => x.file).join(', ')} (${(hop.needBytes / MB).toFixed(1)} MB, k dispozici ${(hop.freeBytes / MB).toFixed(1)} MB ${hop.stagingArea === 'ram' ? 'RAM' : 'flash'})`);

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
        // 1) záloha
        setStep(`záloha (${hop.from})`, 'backup');
        await this.doBackup(c, raw, info, itemId, L, W, opt);
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

        // 2) staging balíčků (upload přes SFTP, nebo vlastní updater routeru)
        if (opt.mode === 'router') {
          const r = await this.stageViaRouter(c, hop, info, L, setStep, W);
          uploaded = r.files;
          if (!r.ok) { await cleanupUploads(); return finish('failed', { error: r.error }); }
        } else {
          const r = await this.stageViaUpload(c, hop, info, L, setStep, W, uploaded);
          if (!r.ok) { await cleanupUploads(); return finish('failed', { error: r.error }); }
        }
        if (this.cancelRequested || this.skipRequested) { await cleanupUploads(); return finish('skipped', { error: 'zrušeno před restartem' }); }

        // 4) restart a čekání
        setStep(`restart → ${hop.to}`, 'reboot');
        const r = await this.rebootAndWait(c, creds, connect, L, setStep, settings);
        if (!r.rebooted) { c = r.client; await cleanupUploads(); return finish('failed', { error: 'router se po příkazu nerestartoval — balíčky smazány, nic se nezměnilo' }); }
        uploaded = [];
        rebootedByUs = true;
        if (!r.client) return finish('failed', { error: `router se po restartu nevrátil do ${settings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ (${raw.host})` });
        c = r.client;

        // 5) ověření
        setStep(`ověření ${hop.to}`, 'verify');
        const after = await inspect(c, { full: true });
        db.updateDevice(devId, { ...toDeviceFields(after), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now(), last_upgrade_at: db.now() });
        db.addVersionHistory(devId, after.version, after.fw_current, 'upgrade');
        this.emitDevice(devId);
        if (after.identity !== info.identity) { L('error', `po restartu se ozvalo jiné zařízení: identita "${after.identity}" (bylo "${info.identity}")`); return finish('failed', { error: 'po restartu odpovídá jiná identita' }); }
        if (after.version !== hop.to) {
          L('error', `po restartu je verze ${after.version}, očekáváno ${hop.to} — upgrade se neprovedl (zkontroluj /log na routeru)`);
          return finish('failed', { error: `verze po restartu ${after.version} ≠ ${hop.to}` });
        }
        L('info', `✔ RouterOS ${after.version} běží, uptime ${after.uptime}`);
        this.comparePost(info, after, W);
        if (after.flags.fw_auto_upgrade && after.routerboard && after.fw_upgrade && after.fw_current !== after.fw_upgrade) {
          L('info', 'router má auto-upgrade firmware zapnutý — čekám na jeho vlastní druhý restart (firmware)');
          setStep('čekám na auto-restart (firmware)', 'reboot');
          try { c.close(); } catch {}
          const r2 = await this.waitCycle(creds, connect, L, setStep, settings, 180000);
          if (!r2.client) return finish('failed', { error: `router se po automatickém firmware restartu nevrátil do ${settings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ` });
          c = r2.client;
        }
        await this.waitForChildren(devId, L, setStep, W, settings);
        hopsDone++;
        db.updateJobItem(itemId, { to_version: after.version });

        // 6) firmware po hopu
        if (opt.firmware !== false) {
          c = await this.doFirmware(c, connect, after, L, setStep, W, creds, settings, devId);
        }
        const fin = await inspect(c);
        db.updateDevice(devId, { ...toDeviceFields(fin), last_scan_at: db.now(), last_seen_at: db.now() });
        db.updateJobItem(itemId, { to_fw: fin.fw_current });
      }
      L('warn', 'příliš mnoho hopů — končím');
      return finish('failed', { error: 'překročen počet hopů' });
    } catch (e) {
      L('error', 'CHYBA: ' + e.message);
      try { await cleanupUploads(); } catch {}
      return finish('failed', { error: e.message });
    } finally {
      try { c && c.close(); } catch {}
    }
  }

  /** upload: server stáhne balíčky z download.mikrotik.com, nahraje přes SFTP (fallback /tool fetch) a ověří na routeru */
  async stageViaUpload(c, hop, info, L, setStep, W, uploaded) {
    setStep(`nahrávání ${hop.to}`, 'upload');
    for (const pk of hop.packages) {
      const { local } = await V.ensurePackage(pk.name, hop.to, info.arch, (m) => L('info', m));
      if (fs.statSync(local).size !== pk.size) throw new Error(`lokální balíček ${pk.file} má špatnou velikost`);
      L('info', `nahrávám ${pk.file} (${(pk.size / MB).toFixed(1)} MB) přes SFTP`);
      let lastPct = -1;
      try {
        await c.upload(local, pk.file, (t, tot) => { const pct = Math.floor(t * 10 / tot) * 10; if (pct !== lastPct && pct % 20 === 0) { lastPct = pct; setStep(`nahrávání ${pk.file} ${pct} %`); } });
        uploaded.push(pk.file);
      } catch (e) {
        uploaded.push(pk.file); // i částečně nahraný soubor se musí uklidit
        L('warn', `SFTP selhalo (${e.message}), zkouším /tool fetch z ${cfg.publicUrl}`);
        const tk = token();
        this.pkgTokens.set(tk, { local, file: pk.file, expires: Date.now() + 3600e3 });
        try {
          const url = `${cfg.publicUrl}/pkg/${tk}/${pk.file}`;
          await c.exec(`/tool fetch url="${url}" dst-path="${pk.file}" keep-result=yes`, { timeoutMs: 20 * 60e3 });
        } catch (e2) {
          return { ok: false, error: `nahrání ${pk.file} selhalo: SFTP: ${e.message}; fetch: ${e2.message}` };
        } finally { this.pkgTokens.delete(tk); }
      }
    }
    setStep('ověření balíčků', 'upload');
    const files = (await c.list('/file', ['name', 'type', 'size'])) || [];
    const npks = files.filter(f => f.type === 'package' || /\.npk$/i.test(f.name));
    let ok = true;
    for (const pk of hop.packages) {
      const f = npks.find(x => x.name === pk.file);
      if (!f) { L('error', `soubor ${pk.file} na routeru chybí`); ok = false; continue; }
      if (parseInt(f.size, 10) !== pk.size) { L('error', `soubor ${pk.file} má velikost ${f.size}, očekáváno ${pk.size}`); ok = false; }
      if (f.type !== 'package') W(`soubor ${pk.file} router nerozpoznal jako balíček (typ "${f.type}")`);
    }
    for (const f of npks) if (!hop.packages.some(pk => pk.file === f.name)) { L('error', `na routeru je cizí balíček ${f.name}`); ok = false; }
    if (!ok) return { ok: false, error: 'ověření nahraných balíčků selhalo — nic se nerestartovalo' };
    L('info', `všech ${hop.packages.length} balíčků ověřeno (název i velikost), restartuji`);
    return { ok: true };
  }

  /** router: /system package update (kanál → check → download), ověření nabízené verze proti očekávané */
  async stageViaRouter(c, hop, info, L, setStep, W) {
    const files = [];
    const status = async () => c.kv('/system package update', ['channel', 'installed-version', 'latest-version', 'status']);
    const orig = (await status()).channel || '';
    const restore = async () => { if (orig && orig !== hop.channel) { try { await c.exec(`/system package update set channel=${orig}`, { timeoutMs: 15000 }); } catch {} } };
    setStep(`updater: kanál ${hop.channel}`, 'upload');
    try { await c.exec(`/system package update set channel=${hop.channel}`, { timeoutMs: 15000 }); }
    catch (e) { return { ok: false, error: `router nezná kanál "${hop.channel}": ${e.message}`, files }; }
    try { await c.exec('/system package update check-for-updates once', { timeoutMs: 90000, allowError: true }); }
    catch { try { await c.exec('/system package update check-for-updates', { timeoutMs: 90000, allowError: true }); } catch {} }
    let st = await status();
    for (let i = 0; i < 30 && (/finding|checking/i.test(st.status || '') || (!st['latest-version'] && !/error/i.test(st.status || ''))); i++) { await sleep(3000); st = await status(); }
    L('info', `updater: kanál ${st.channel}, nabízí "${st['latest-version']}", stav: ${st.status}`);
    if (/error/i.test(st.status || '') || !st['latest-version']) { await restore(); return { ok: false, error: `updater routeru nefunguje (${st.status || 'bez odpovědi'}) — router asi nemá přístup na upgrade.mikrotik.com, použij režim upload`, files }; }
    if (st['latest-version'] !== hop.to) { await restore(); return { ok: false, error: `updater nabízí ${st['latest-version']}, očekáváno ${hop.to} — nepokračuji`, files }; }
    setStep(`updater: download ${hop.to}`, 'upload');
    try { await c.exec('/system package update download', { timeoutMs: 25 * 60e3, allowError: true }); } catch (e) { L('warn', 'download: ' + e.message); }
    const end = Date.now() + 25 * 60e3;
    st = await status();
    while (Date.now() < end && !/downloaded|error/i.test(st.status || '')) { setStep(`updater: ${st.status || 'stahuje'}`); await sleep(5000); st = await status(); }
    L('info', `updater stav: ${st.status}`);
    const listed = (await c.list('/file', ['name', 'type', 'size'])) || [];
    const npks = listed.filter(f => f.type === 'package' || /\.npk$/i.test(f.name));
    files.push(...npks.map(f => f.name));
    await restore();
    if (!/downloaded/i.test(st.status || '')) return { ok: false, error: `updater nestáhl balíčky: ${st.status}`, files };
    let ok = true;
    for (const f of npks) {
      if (!f.name.includes(hop.to)) { L('error', `na routeru je balíček jiné verze: ${f.name}`); ok = false; continue; }
      const known = hop.packages.find(pk => pk.file === f.name);
      if (known && parseInt(f.size, 10) !== known.size) { L('error', `${f.name} má velikost ${f.size}, download.mikrotik.com uvádí ${known.size}`); ok = false; }
    }
    if (!ok) return { ok: false, error: 'stažené balíčky neodpovídají — nic se nerestartovalo', files };
    if (!npks.length) W('updater hlásí staženo, ale v /file nejsou vidět žádné .npk (staging v RAM?) — spoléhám na stav updateru');
    else L('info', `stažené balíčky ověřeny: ${npks.map(f => f.name).join(', ')}`);
    return { ok: true, files };
  }

  /** samostatná operace: rozdělení flash na N oddílů (/partitions repartition) — běží jako vlastní job kvůli logu */
  repartition(devId, count = 2) {
    if (this.busy) throw new Error(`běží už job #${this.currentJobId}`);
    const raw = db.getDeviceRaw(devId);
    if (!raw) throw new Error('zařízení neexistuje');
    if (raw.managed === 0 || !raw.enabled) throw new Error('zařízení je vypnuté nebo neřízené');
    if (!(count >= 2 && count <= 8)) throw new Error('počet oddílů 2–8');
    const label = raw.name || raw.identity || raw.host;
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
    const settings = db.getSettings();
    const L = (level, msg) => { const id = db.addLog(jobId, itemId, devId, level, msg); this.emit('event', { type: 'log', log: { id, job_id: jobId, item_id: itemId, device_id: devId, ts: Date.now(), level, msg } }); };
    const setStep = (step, status) => { db.updateJobItem(itemId, { step, ...(status ? { status } : {}) }); this.emitItem(itemId); };
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
    const pc = new RosClient({ host: par.host, port: par.port, username: par.username, password: decrypt(par.password_enc), timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: par.host_key || '' });
    await pc.connect();
    try {
      const cur = await pc.kv('/interface ethernet', ['name']); // jen test spojení
      const st = await pc.exec(`:put ([/interface ethernet poe monitor "${path.port}" once as-value]->"poe-out-status")`, { timeoutMs: 20000, allowError: true });
      L('info', `PoE restart přes ${par.name || par.identity || par.host} port ${path.port} (stav: ${st.trim() || '?'}, režim ${path.mode})`);
      if (!/powered/i.test(st)) throw new Error(`port ${path.port} na rodiči nehlásí napájení (${st.trim()})`);
      await pc.exec(`/interface ethernet set [find name="${path.port}"] poe-out=off`, { timeoutMs: 15000 });
      await sleep(8000);
      await pc.exec(`/interface ethernet set [find name="${path.port}"] poe-out=${path.mode || 'auto-on'}`, { timeoutMs: 15000 });
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
    await c.exec(`/system device-mode update ${need.join(' ')} activation-timeout=10m`, { timeoutMs: 20000, allowError: true });
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

  /** upgrade RouterBOOT (přes dočasný skript, aby nebyl interaktivní dotaz) + restart + ověření */
  async doFirmware(c, connect, info, L, setStep, W, creds, settings, devId) {
    if (!info.routerboard) { L('info', 'není RouterBOARD — firmware se neřeší'); return c; }
    const rb = await c.kv('/system routerboard', ['current-firmware', 'upgrade-firmware']);
    if (!rb['upgrade-firmware'] || rb['current-firmware'] === rb['upgrade-firmware']) { L('info', `firmware ${rb['current-firmware']} je aktuální`); return c; }
    setStep(`firmware ${rb['current-firmware']} → ${rb['upgrade-firmware']}`, 'firmware');
    L('info', `upgrade firmware RouterBOOT ${rb['current-firmware']} → ${rb['upgrade-firmware']}`);
    await c.exec('/system script remove [find name="mtu-fwup"]', { timeoutMs: 15000, allowError: true });
    await c.exec('/system script add name="mtu-fwup" policy=ftp,reboot,read,write,policy,test,password,sniff,sensitive source="/system routerboard upgrade"', { timeoutMs: 15000 });
    let out = '';
    try { out = await c.exec('/system script run mtu-fwup', { timeoutMs: 90000, allowError: true }); }
    finally { await c.exec('/system script remove [find name="mtu-fwup"]', { timeoutMs: 15000, allowError: true }).catch(() => {}); }
    L('info', 'routerboard upgrade: ' + (out.trim().split('\n')[0] || '(bez výstupu)'));
    setStep('restart po firmware', 'reboot');
    const r = await this.rebootAndWait(c, creds, connect, L, setStep, settings);
    if (!r.rebooted) { W('router se po upgrade firmware nerestartoval — firmware se aktivuje při příštím restartu'); return r.client; }
    if (!r.client) throw new Error(`router se po restartu (firmware) nevrátil do ${settings.reboot_timeout_min} min — ZKONTROLUJ ZAŘÍZENÍ`);
    const rb2 = await r.client.kv('/system routerboard', ['current-firmware', 'upgrade-firmware']);
    if (rb2['current-firmware'] !== rb['upgrade-firmware']) W(`firmware po restartu ${rb2['current-firmware']}, očekáváno ${rb['upgrade-firmware']}`);
    else L('info', `✔ firmware ${rb2['current-firmware']}`);
    await this.waitForChildren(devId, L, setStep, W, settings);
    return r.client;
  }

  /** pošle /system reboot, počká na výpadek a návrat; vrací {rebooted, client} */
  async rebootAndWait(c, creds, connect, L, setStep, settings) {
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
    return { rebooted: true, client: null };
  }

  getPkg(tk) {
    const p = this.pkgTokens.get(tk);
    if (!p || p.expires < Date.now()) return null;
    return p;
  }
}

module.exports = { Runner, inWindow };
