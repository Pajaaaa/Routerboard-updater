'use strict';
// Periodický/ruční sken verzí — jen čtení.
const cfg = require('./config');
const db = require('./db');
const { decrypt } = require('./crypto');
const { RosClient } = require('./ros');
const { inspect, toDeviceFields } = require('./inspect');
const V = require('./versions');
const { autoParent } = require('./topology');

class Scanner {
  constructor(runner, bus) {
    this.runner = runner;
    this.bus = bus;
    this.inProgress = new Set();
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
    const c = new RosClient({ host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc),
      timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: raw.host_key || '' });
    try {
      await c.connect();
      if (!raw.host_key && c.hostKey) db.updateDevice(id, { host_key: c.hostKey });
      const info = await inspect(c, { full: true });
      db.updateDevice(id, { ...toDeviceFields(info), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
      db.addVersionHistory(id, info.version, info.fw_current, 'scan');
      if (info.serial) db.dedupeBySerial(info.serial, raw.owner_id); // stejný kus pod víc IP → jen jeden hlavní
      autoParent(id); // jednoznačný uplink → rodič se nastaví sám
      return { ok: true, info };
    } catch (e) {
      let status = 'unreachable', msg = e.message;
      if (c.hostKeyMismatch) { status = 'hostkey'; msg = `SSH host key se změnil (uložený ${raw.host_key}, nyní ${c.hostKeyMismatch}) — ověř zařízení a případně resetuj klíč`; }
      else if (/authentication/i.test(msg)) status = 'auth';
      // poškozený SSH host key na routeru (RouterOS log: „Corrupt host's key, regenerating it! Reboot required!“) → ssh2 hlásí KEY_EXCHANGE_FAILED
      else if (/KEY_EXCHANGE_FAILED|Handshake failed|no matching key exchange/i.test(msg)) msg = `SSH: poškozený host key routeru (${msg.replace(/^SSH:\s*/, '')}) — oprava: /ip ssh regenerate-host-key + restart; když jede telnet, jde to udělat tlačítkem „Opravit SSH klíč“ v detailu zařízení`;
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
  async scanAll(ids, meta = {}) {
    await V.refreshLatest().catch(() => {});
    const list = (ids ? ids.map(i => db.getDevice(i)).filter(Boolean) : db.listDevices()).filter(d => d.enabled && d.managed);
    const queue = list.map(d => d.id);
    const all = list.map(d => d.id);
    let done = 0;
    const prog = () => this.bus.emit('event', { type: 'scan-progress', ...meta, done, total: all.length, ids: all });
    if (meta.tag) prog();
    const workers = Array.from({ length: Math.max(1, cfg.scanParallel) }, async () => {
      while (queue.length) {
        // aktualizace serveru (drain): nezačínat další kontroly, ať může služba rychle restartovat; nezkontrolovaná zařízení se dokončí po startu
        if (this.runner && this.runner.draining) { queue.length = 0; break; }
        const id = queue.shift(); try { await this.scanOne(id); } catch {} finally { done++; if (meta.tag) prog(); }
      }
    });
    await Promise.all(workers);
    // druhý průchod: stanice naskenovaná dřív než její sektor dostala rodiče jen podle brány → teď už sektor známe
    for (const id of all) { try { if (autoParent(id)) this.bus.emit('event', { type: 'device', device: db.getDevice(id) }); } catch {} }
    this.bus.emit('event', { type: 'scan-done', count: list.length, ...meta, ids: meta.tag ? all : undefined });
    return list.length;
  }
}
module.exports = { Scanner };
