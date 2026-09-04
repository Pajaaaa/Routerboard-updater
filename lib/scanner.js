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
  startPeriodic() {
    if (cfg.scanIntervalHours > 0) {
      this.timer = setInterval(() => this.scanAll().catch(() => {}), cfg.scanIntervalHours * 3600e3);
      setTimeout(() => this.scanAll().catch(() => {}), 15000);
    }
    setInterval(() => V.refreshLatest().catch(() => {}), 60 * 60e3);
  }
  async scanOne(id) {
    if (this.inProgress.has(id)) return { skipped: 'už se skenuje' };
    if (this.runner.isDeviceBusy(id)) return { skipped: 'zařízení je právě v jobu' };
    const raw = db.getDeviceRaw(id);
    if (!raw) throw new Error('zařízení neexistuje');
    if (raw.managed === 0) return { skipped: 'neřízený prvek topologie' };
    this.inProgress.add(id);
    const settings = db.getSettings();
    const c = new RosClient({ host: raw.host, port: raw.port, username: raw.username, password: decrypt(raw.password_enc),
      timeoutMs: (settings.ssh_timeout_sec || 20) * 1000, expectedHostKey: raw.host_key || '' });
    try {
      await c.connect();
      if (!raw.host_key && c.hostKey) db.updateDevice(id, { host_key: c.hostKey });
      const info = await inspect(c, { full: true });
      db.updateDevice(id, { ...toDeviceFields(info), scan_status: 'ok', scan_error: '', last_scan_at: db.now(), last_seen_at: db.now() });
      db.addVersionHistory(id, info.version, info.fw_current, 'scan');
      autoParent(id); // jednoznačný uplink → rodič se nastaví sám
      return { ok: true, info };
    } catch (e) {
      let status = 'unreachable', msg = e.message;
      if (c.hostKeyMismatch) { status = 'hostkey'; msg = `SSH host key se změnil (uložený ${raw.host_key}, nyní ${c.hostKeyMismatch}) — ověř zařízení a případně resetuj klíč`; }
      else if (/authentication/i.test(msg)) status = 'auth';
      db.updateDevice(id, { scan_status: status, scan_error: msg, last_scan_at: db.now() });
      return { ok: false, error: msg };
    } finally {
      c.close();
      this.inProgress.delete(id);
      const d = db.getDevice(id);
      this.bus.emit('event', { type: 'device', device: d });
    }
  }
  async scanAll(ids) {
    await V.refreshLatest().catch(() => {});
    const list = (ids ? ids.map(i => db.getDevice(i)).filter(Boolean) : db.listDevices()).filter(d => d.enabled && d.managed);
    const queue = list.map(d => d.id);
    const workers = Array.from({ length: Math.max(1, cfg.scanParallel) }, async () => {
      while (queue.length) { const id = queue.shift(); try { await this.scanOne(id); } catch {} }
    });
    await Promise.all(workers);
    this.bus.emit('event', { type: 'scan-done', count: list.length });
    return list.length;
  }
}
module.exports = { Scanner };
