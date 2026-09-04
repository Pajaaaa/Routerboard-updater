'use strict';
// Sken rozsahů: TCP probe portu SSH, pokus o přihlášení zadanými loginy, identifikace RouterOS, založení zařízení.
const db = require('./db');
const { encrypt } = require('./crypto');
const { RosClient, probeTcp } = require('./ros');

function expandCidr(spec) {
  const t = spec.trim();
  let m = t.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/);
  if (m) {
    const ip = ((+m[1]) << 24 | (+m[2]) << 16 | (+m[3]) << 8 | (+m[4])) >>> 0;
    const bits = m[5] === undefined ? 32 : +m[5];
    if (bits < 20 || bits > 32) throw new Error(`${t}: povolený rozsah je /20 až /32`);
    const size = 2 ** (32 - bits), base = bits === 32 ? ip : (ip & (~(size - 1) >>> 0)) >>> 0;
    const out = [];
    for (let i = 0; i < size; i++) {
      if (bits < 31 && (i === 0 || i === size - 1)) continue; // network / broadcast
      const a = (base + i) >>> 0;
      out.push([a >>> 24, a >>> 16 & 255, a >>> 8 & 255, a & 255].join('.'));
    }
    return out;
  }
  m = t.match(/^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/); // 192.0.2.10-50
  if (m) { const out = []; for (let i = +m[2]; i <= +m[3] && i < 256; i++) out.push(m[1] + i); return out; }
  throw new Error(`${t}: nerozumím rozsahu (použij 192.0.2.0/24 nebo 192.0.2.10-50)`);
}

class Discovery {
  constructor(bus) { this.bus = bus; this.running = false; this.state = null; }
  status() { return this.state; }
  /**
   * @param {object} o {ranges:[], creds:[{username,password}], port, group_name, track, parallel}
   */
  /** synchronní validace — vyhodí chybu ještě před spuštěním */
  prepare(o) {
    if (this.running) throw new Error('sken rozsahu už běží');
    if (!o.ranges || !o.ranges.length) throw new Error('zadej aspoň jeden rozsah');
    const hosts = [...new Set(o.ranges.flatMap(expandCidr))];
    if (!hosts.length) throw new Error('prázdný rozsah');
    if (hosts.length > 4096) throw new Error('max. 4096 adres najednou');
    if (!o.creds || !o.creds.length) throw new Error('zadej aspoň jeden login (uživatel heslo)');
    return hosts;
  }
  async run(o) {
    const hosts = this.prepare(o);
    const port = o.port || 22;
    const st = this.state = { startedAt: Date.now(), finishedAt: 0, total: hosts.length, done: 0, open: 0, found: [], added: 0, existing: 0, authFailed: [], notRouterOS: [], errors: [] };
    this.running = true;
    const settings = db.getSettings();
    const emit = () => this.bus.emit('event', { type: 'discovery', state: st });
    const queue = [...hosts];
    const worker = async () => {
      while (queue.length) {
        const host = queue.shift();
        try {
          if (!(await probeTcp(host, port, 1500))) continue;
          st.open++;
          const ex = db.findDeviceByHost(host, port);
          if (ex) { st.existing++; st.found.push({ host, identity: ex.identity || ex.name, existing: true }); continue; }
          let ok = false, lastErr = '', attempts = 0;
          for (const cr of o.creds) {
            // víc než 2 pokusy během minuty by mohly spustit brute-force blacklist na routeru → rozestup
            if (attempts >= 2 && attempts % 2 === 0) await new Promise(r => setTimeout(r, 65000));
            attempts++;
            const c = new RosClient({ host, port, username: cr.username, password: cr.password, timeoutMs: Math.min(15, settings.ssh_timeout_sec || 15) * 1000 });
            try {
              await c.connect();
              const r = await c.kv('/system resource', ['version', 'board-name', 'architecture-name']);
              const id = await c.kv('/system identity', ['name']);
              if (!r.version) { st.notRouterOS.push(host); ok = true; break; }
              const devId = db.insertDevice({ host, port, username: cr.username, password_enc: encrypt(cr.password), name: '', group_name: o.group_name || '', track: o.track || 'v7-stable' });
              db.updateDevice(devId, { host_key: c.hostKey, identity: id.name || '', board_name: r['board-name'] || '', arch: r['architecture-name'] || '', version: (r.version || '').split(' ')[0], scan_status: 'ok', last_seen_at: db.now() });
              st.added++;
              st.found.push({ host, identity: id.name, board: r['board-name'], version: r.version, id: devId });
              this.bus.emit('event', { type: 'device', device: db.getDevice(devId) });
              ok = true; break;
            } catch (e) {
              lastErr = e.message;
              if (!/authentication/i.test(lastErr)) break; // jiná chyba než špatný login → další loginy nezkoušet
            } finally { c.close(); }
          }
          if (!ok) { if (/authentication/i.test(lastErr)) st.authFailed.push(host); else st.errors.push(`${host}: ${lastErr}`); }
        } catch (e) { st.errors.push(`${host}: ${e.message}`); }
        finally { st.done++; if (st.done % 8 === 0) emit(); }
      }
    };
    try { await Promise.all(Array.from({ length: Math.max(1, Math.min(64, o.parallel || 24)) }, worker)); }
    finally { this.running = false; st.finishedAt = Date.now(); emit(); this.bus.emit('event', { type: 'discovery-done', state: st }); }
    return st;
  }
}
module.exports = { Discovery, expandCidr };
