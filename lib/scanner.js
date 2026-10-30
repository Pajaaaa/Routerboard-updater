'use strict';
// MikroTik upgrader — hromadné kontroly zařízení.
// Autor: Pavel Vlček, hkfree.org, 2026
// Periodický/ruční sken verzí — jen čtení.
const cfg = require('./config');
const db = require('./db');
const { decrypt } = require('./crypto');
const { RosClient, probeTcpWhy } = require('./ros');
const SF = require('./sshfix'); // rozpoznání poškozeného host key / chybějících algoritmů, druhý pokus se zastaralými algoritmy
const { inspect, toDeviceFields } = require('./inspect');
const V = require('./versions');
const { autoParent } = require('./topology');

class Scanner {
  constructor(runner, bus) {
    this.runner = runner;
    this.bus = bus;
    this.inProgress = new Set();
    this.checks = new Map(); // ownerId -> { done, total, startedAt, finishedAt, cancelled } — průběh hromadné kontroly (tag 'check') pro progress bar v UI
    this.checkRuns = new Map(); // ownerId -> { cancel } — běžící hromadná kontrola, ať jde zrušit (rozdělaná zařízení se dokončí, další se nezačnou)
    this.timer = null;
  }
  /** žádný plošný sken všech zařízení (při stovkách kusů by se potkával s upgrady) — kontroluje se při načtení, ručně a před jobem; pravidelně jen verze */
  startPeriodic() {
    setInterval(() => V.refreshLatest().catch(() => {}), 60 * 60e3);
    // po startu dokončit kontroly přerušené restartem (zařízení, která ještě nikdy nebyla zkontrolována)
    setTimeout(() => { const ids = db.listDevices().filter(d => d.enabled && d.managed && (d.scan_status === 'never' || !d.last_scan_at)).map(d => d.id); if (ids.length) { console.log(`dokončuji kontrolu ${ids.length} zařízení přerušenou restartem`); this.scanAll(ids).catch(() => {}); } }, 10000);
  }
  async scanOne(id) {
    if (this.inProgress.has(id)) return { skipped: 'už se skenuje' };
    if (this.runner.isDeviceBusy(id)) return { skipped: 'zařízení je právě v jobu' };
    const raw = db.getDeviceRaw(id);
    if (!raw) throw new Error('zařízení neexistuje');
    if (raw.managed === 0) return { skipped: 'neřízený prvek topologie' };
    this.inProgress.add(id);
    const settings = db.getSettings(raw.owner_id); // nastavení vlastníka zařízení
    const copts = { host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc),
      timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: raw.host_key || '' };
    let c = new RosClient(copts);
    let recovered = null; // výsledek automatického ověření změněného klíče / loginu z userdb
    try {
      try { await c.connect(); }
      catch (e) {
        const cls = SF.classifySshError(e.message);
        if (cls && cls.kind === 'algo') {
          // žádný společný algoritmus → druhý pokus se všemi algoritmy ssh2 (zastaralé kusy); upgrade pak jede stejnou sadou (lib/sshfix.js)
          c.close(); c = new RosClient({ ...copts, algorithms: SF.LEGACY_ALGORITHMS });
          await c.connect();
        } else if (c.hostKeyMismatch || SF.isAuthFailed(e.message)) {
          // změněný host key / odmítnutý login → připojit s novým klíčem a loginem z userdb, porovnat S/N, převzít (lib/sshfix.js recoverAccess)
          const err = c.hostKeyMismatch ? `SSH host key zařízení se ZMĚNIL (uložený ${raw.host_key}, nyní ${c.hostKeyMismatch})` : e.message;
          const notes = [];
          const r = await SF.recoverAccess({ raw, creds: copts, tryConnect: async (extra) => { const cl = new RosClient({ ...copts, ...extra }); await cl.connect(); return cl; }, log: (lv, m) => notes.push(m), settings, error: err });
          if (!r) { if (notes.length) e.recoverNotes = notes; throw e; }
          c.close(); c = r.client; recovered = r;
        } else throw e;
      }
      if (!raw.host_key && c.hostKey) db.updateDevice(id, { host_key: c.hostKey });
      const info = await inspect(c, { full: true });
      db.updateDevice(id, { ...toDeviceFields(info), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
      db.addVersionHistory(id, info.version, info.fw_current, 'scan');
      if (info.serial) db.dedupeBySerial(info.serial, raw.owner_id); // stejný kus pod víc IP → jen jeden hlavní
      autoParent(id); // jednoznačný uplink → rodič se nastaví sám
      return { ok: true, info, recovered: recovered ? (recovered.same ? 'hostkey' : 'takeover') : undefined };
    } catch (e) {
      let status = 'unreachable', msg = e.message;
      const rn = e.recoverNotes ? ` (automatické ověření: ${e.recoverNotes.join('; ').slice(0, 300)})` : '';
      if (c.hostKeyMismatch) { status = 'hostkey'; msg = `SSH host key se změnil (uložený ${raw.host_key}, nyní ${c.hostKeyMismatch}) — ověř zařízení a případně resetuj klíč${rn}`; }
      else if (/authentication/i.test(msg)) { status = 'auth'; msg += rn; }
      // poškozený SSH host key na zařízení (RouterOS log: „Corrupt host's key, regenerating it! Reboot required!“) → ssh2 hlásí KEY_EXCHANGE_FAILED
      // SSH se nepřipojilo: rozlišit „služba ssh vypnutá“ (port odmítá, Winbox jede) / „ssh za firewallem“ (nic na 22, Winbox jede) / „kus nedostupný“ —
      // ať je v seznamu zařízení rovnou vidět, co na kusu opravit (2.10.2026, hromadné zapínání ssh po RB-DB)
      else if (status === 'unreachable' && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out|Timed out|connect/i.test(msg)) {
        const why = await probeTcpWhy(raw.host, raw.port || 22, 3000).catch(() => 'error');
        if (why !== 'open') {
          const wb = await probeTcpWhy(raw.host, 8291, 3000).catch(() => 'error');
          if (wb === 'open' && why === 'refused') msg = `ssh vypnuté (port ${raw.port || 22} odmítá spojení, Winbox jede) — zapni /ip service ssh`;
          else if (wb === 'open') msg = `ssh blokuje firewall nebo „available from“ u služby (port ${raw.port || 22} neodpovídá, Winbox jede)`;
          else if (why === 'refused') msg = `port ${raw.port || 22} odmítá spojení, Winbox taky neodpovídá`;
          else msg = `kus neodpovídá (port ${raw.port || 22} ani Winbox): ${msg}`;
          // co na adrese opravdu je: SwOS web (CSS switch bez SSH) a výpis sousedů z okolního MikroTiku (30.10.2026 Nerudova 934: v seznamu hEX S, na IP CSS610 SwOS)
          const swos = await Scanner.probeSwos(raw.host).catch(() => false);
          if (swos) msg = `na adrese je SwOS switch (web hlásí SwOS), ne RouterOS — upgrader ho nespravuje: zařízení smaž nebo přepni na „jen topologie“; původně v seznamu ${raw.board_name || '?'} ${raw.version || ''}`.trim();
          const nb = await this.neighborLookup(raw).catch(() => null);
          if (nb) msg += ` · podle sousedů (${nb.via}): ${nb.text}`;
        }
      }
      else if (SF.classifySshError(msg)) {
        const cls = SF.classifySshError(msg);
        msg = cls.kind === 'corrupt-key'
          ? `SSH: ${cls.text} — upgrade to opraví sám před začátkem (/ip ssh regenerate-host-key + restart přes SSH s jiným klíčem, API, REST nebo telnet); hned to jde tlačítkem „Opravit SSH klíč“ v detailu zařízení`
          : `SSH: ${cls.text} — ani se zastaralými algoritmy to nejde`;
      }
      db.updateDevice(id, { scan_status: status, scan_error: msg, last_scan_at: db.now() });
      return { ok: false, error: msg };
    } finally {
      c.close();
      this.inProgress.delete(id);
      const d = db.getDevice(id);
      this.bus.emit('event', { type: 'device', device: d });
    }
  }
  /** @param {object} [meta] { ownerId, tag } — např. po skenu rozsahu: průběh se posílá vlastníkovi jako 'scan-progress' */
  /** průběh hromadné kontroly daného uživatele (null = žádná neběžela / hotová déle než 10 min) */
  checkProgress(ownerId) { const c = this.checks.get(ownerId); if (!c) return null; if (c.finishedAt && Date.now() - c.finishedAt > 600000) { this.checks.delete(ownerId); return null; } return c; }
  /** zrušení běžící hromadné kontroly uživatele: rozdělaná zařízení (max. paralelních) se dokončí, zbytek fronty se zahodí */
  cancelCheck(ownerId) { const r = this.checkRuns.get(ownerId); if (!r) return false; r.cancel = true; return true; }
  /** @param {object} [meta] { ownerId, tag, parallel, label } — parallel přebije MTU_SCAN_PARALLEL (1–16, hromadná kontrola správce), label se ukáže v UI */
  async scanAll(ids, meta = {}) {
    await V.refreshLatest().catch(() => {});
    const list = (ids ? ids.map(i => db.getDevice(i)).filter(Boolean) : db.listDevices()).filter(d => d.enabled && d.managed);
    const queue = list.map(d => d.id);
    const all = list.map(d => d.id);
    // stav před kontrolou → po skončení souhrn, co se změnilo (verze, dostupnost); u kontroly správce přes tisíce kusů je to jediný přehled
    const before = new Map(list.map(d => [d.id, { status: d.scan_status, version: d.version || '' }]));
    let done = 0; const skipped = new Set(); // přeskočená (v jobu / už se skenuje) — do souhrnu stavů nepatří, jejich stav se nečetl
    const startedAt = Date.now();
    const run = { cancel: false };
    const parallel = Math.max(1, Math.min(16, parseInt(meta.parallel, 10) || cfg.scanParallel));
    const isCheck = meta.tag === 'check' && meta.ownerId;
    if (isCheck) this.checkRuns.set(meta.ownerId, run);
    const track = (finished, summary) => { if (isCheck) this.checks.set(meta.ownerId, { done, total: all.length, startedAt, finishedAt: finished ? Date.now() : 0, cancelled: run.cancel, label: meta.label || '', parallel, summary }); };
    const prog = () => { track(false); this.bus.emit('event', { type: 'scan-progress', ...meta, done, total: all.length, ids: all, startedAt }); };
    if (meta.tag) prog();
    const workers = Array.from({ length: parallel }, async () => {
      while (queue.length) {
        // aktualizace serveru (drain): nezačínat další kontroly, ať může služba rychle restartovat; nezkontrolovaná zařízení se dokončí po startu
        if (this.runner && this.runner.draining) { queue.length = 0; break; }
        if (run.cancel) { queue.length = 0; break; } // zrušeno uživatelem (tlačítko u progress baru)
        const id = queue.shift(); try { const r = await this.scanOne(id); if (r && r.skipped) skipped.add(id); } catch {} finally { done++; if (meta.tag) prog(); }
      }
    });
    await Promise.all(workers);
    // druhý průchod: stanice naskenovaná dřív než její sektor dostala rodiče jen podle brány → teď už sektor známe
    for (const id of all) { try { if (autoParent(id)) this.bus.emit('event', { type: 'device', device: db.getDevice(id) }); } catch {} }
    const summary = isCheck ? this.summarize(before, skipped) : undefined;
    track(true, summary);
    if (isCheck && this.checkRuns.get(meta.ownerId) === run) this.checkRuns.delete(meta.ownerId);
    this.bus.emit('event', { type: 'scan-done', count: done, cancelled: run.cancel, ...meta, ids: meta.tag ? all : undefined, summary });
    return list.length;
  }
  /** SwOS (CSS/CRS ve SwitchOS) odpoví na HTTP GET / „HTTP/1.0 303 Use Instead“ + Location: /index.html (RouterOS www vrací 200 Webfig). Jen když port 80 odpovídá. */
  static probeSwos(host, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const net = require('net'); let buf = '', done = false;
      const sock = net.createConnection({ host, port: 80 });
      const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch {} resolve(v); };
      const t = setTimeout(() => fin(false), timeoutMs);
      sock.on('connect', () => sock.write('GET / HTTP/1.0\r\nHost: ' + host + '\r\n\r\n'));
      sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.length > 600 || /\r\n\r\n/.test(buf)) fin(/^HTTP\/1\.[01] 303 Use Instead/i.test(buf) || /SwOS/i.test(buf)); });
      sock.on('error', () => fin(false)); sock.on('close', () => fin(/^HTTP\/1\.[01] 303 Use Instead/i.test(buf) || /SwOS/i.test(buf)));
    });
  }
  /** Co je na adrese podle MNDP/LLDP sousedů: zeptá se rodiče, jinak až dvou dostupných kusů ze stejné /24 (identity, platforma, deska, verze, uptime). Jen čtení. */
  async neighborLookup(raw) {
    const all = db.listDevices().filter(d => d.id !== raw.id && d.managed && d.enabled && d.scan_status === 'ok' && !d.dup_of);
    const net24 = String(raw.host).replace(/\.\d+$/, '.');
    const cands = [];
    if (raw.parent_id) { const p = all.find(d => d.id === raw.parent_id); if (p) cands.push(p); }
    for (const d of all.filter(d => d.host.startsWith(net24) && !cands.includes(d)).sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0))) { if (cands.length >= 3) break; cands.push(d); }
    for (const via of cands) {
      const vr = db.getDeviceRaw(via.id); if (!vr) continue;
      const cl = new RosClient({ host: vr.host, port: vr.port, username: vr.username, password: decrypt(vr.password_enc), timeoutMs: 15000, expectedHostKey: vr.host_key || '' });
      try {
        await cl.connect();
        const rows = await cl.list('/ip neighbor', ['address', 'identity', 'platform', 'board', 'version', 'uptime', 'mac-address', 'interface'], { where: `address=${raw.host}`, timeoutMs: 15000 });
        const n = (rows || []).find(r => r.address === raw.host);
        if (!n) continue;
        const text = `${n.identity ? `„${n.identity}“ ` : ''}${n.platform || ''} ${n.board || ''}${n.version ? ` ${/^[0-9]\.[0-9]+$/.test(n.version) ? 'SwOS ' : 'RouterOS '}${n.version}` : ''}${n.uptime ? `, uptime ${n.uptime}` : ''}${n['mac-address'] ? `, MAC ${n['mac-address']}` : ''}`.replace(/\s+/g, ' ').trim();
        return { via: `${via.identity || via.name || via.host}, port ${n.interface || '?'}`, text };
      } catch { /* další kandidát */ }
      finally { try { cl.close(); } catch {} }
    }
    return null;
  }
  /** souhrn hromadné kontroly: stavy po kontrole + co se proti stavu před ní změnilo (jen zařízení, která se opravdu zkontrolovala) */
  summarize(before, skipped) {
    const s = { checked: 0, skipped: skipped.size, ok: 0, unreachable: 0, auth: 0, hostkey: 0, other: 0, becameOk: 0, becameUnreachable: 0, versionChanged: 0, changed: [] };
    for (const [id, b] of before) {
      if (skipped.has(id)) continue;
      const d = db.getDevice(id); if (!d) continue;
      s.checked++;
      s[['ok', 'unreachable', 'auth', 'hostkey'].includes(d.scan_status) ? d.scan_status : 'other']++;
      const label = d.identity || d.name || d.host;
      if (b.status !== 'ok' && d.scan_status === 'ok') { s.becameOk++; if (s.changed.length < 60) s.changed.push({ id, host: d.host, label, what: `znovu dostupné${b.status === 'never' ? ' (první kontrola)' : ''}` }); }
      else if (b.status === 'ok' && d.scan_status !== 'ok') { s.becameUnreachable++; if (s.changed.length < 60) s.changed.push({ id, host: d.host, label, what: `nově ${d.scan_status === 'auth' ? 'špatný login' : d.scan_status === 'hostkey' ? 'změněný SSH klíč' : 'nedostupné'}` }); }
      if (d.scan_status === 'ok' && b.version && d.version && b.version !== d.version) { s.versionChanged++; if (s.changed.length < 60) s.changed.push({ id, host: d.host, label, what: `verze ${b.version} → ${d.version}` }); }
    }
    s.changedMore = Math.max(0, s.becameOk + s.becameUnreachable + s.versionChanged - s.changed.length);
    return s;
  }
}
module.exports = { Scanner };
