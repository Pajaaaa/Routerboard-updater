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
  /**
   * Skeny se řadí do fronty (jeden běží, ostatní čekají) a každý uživatel má svůj poslední stav — víc správců může
   * načítat naráz, nikdo nedostane „už běží“. Stav: { ownerId, queued, position, startedAt, finishedAt, total, done, open,
   * found, added, existing, foreign, authFailed, notRouterOS, errors }.
   */
  constructor(bus) { this.bus = bus; this.running = false; this.current = null; this.states = new Map(); this.queue = []; }
  /** poslední stav uživatele (bez parametru: právě běžící sken) */
  status(ownerId) { return ownerId == null ? this.current : (this.states.get(Number(ownerId) || 0) || null); }
  get busy() { return this.running || this.queue.length > 0; }
  /** synchronní validace — vyhodí chybu ještě před zařazením */
  prepare(o) {
    const entries = o.entries || []; // seznam zařízení s vlastním loginem: {host, port?, username, password, name?, group_name?, extra?}
    const ranges = o.ranges || [];
    if (!ranges.length && !entries.length) throw new Error('zadej seznam zařízení (ip uživatel heslo) nebo aspoň jeden rozsah');
    const hosts = [...new Set([...entries.map(e => e.host), ...ranges.flatMap(expandCidr)])];
    if (!hosts.length) throw new Error('prázdný rozsah');
    if (hosts.length > 4096) throw new Error('max. 4096 adres najednou');
    if (ranges.length && !(o.creds || []).length) throw new Error('k rozsahu zadej aspoň jeden login (uživatel heslo)');
    return hosts;
  }
  _blank(o, hosts) {
    return { ownerId: o.ownerId || 0, label: o.label || '', queued: false, position: 0, startedAt: 0, finishedAt: 0, total: hosts.length, done: 0, open: 0, found: [], added: 0, existing: 0, foreign: [...(o.foreign || [])], authFailed: [], notRouterOS: [], errors: [...(o.errors || [])] };
  }
  _emit(st, done) { this.bus.emit('event', { type: done ? 'discovery-done' : 'discovery', state: st }); }
  /** zařadí sken do fronty; vrací promise výsledku (běh sám je asynchronní, volající obvykle nečeká) */
  run(o) {
    const hosts = this.prepare(o);
    return new Promise((resolve, reject) => {
      const st = this._blank(o, hosts);
      st.queued = true; st.position = this.queue.length + (this.running ? 1 : 0);
      this.states.set(st.ownerId, st);
      this.queue.push({ o, hosts, st, resolve, reject });
      this._emit(st, false);
      this._next();
    });
  }
  _next() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = true;
    this._exec(job).then(job.resolve, job.reject).finally(() => {
      this.running = false; this.current = null;
      this.queue.forEach((q, i) => { q.st.position = i + 1; this._emit(q.st, false); });
      this._next();
    });
  }
  /** hotový výsledek bez skenování (např. import z userdb, kde není co skenovat) */
  setResult(o) {
    const st = this._blank(o, []); st.startedAt = st.finishedAt = Date.now();
    this.states.set(st.ownerId, st);
    this._emit(st, true);
    return st;
  }
  async _exec({ o, hosts, st }) {
    const port = o.port || 22;
    Object.assign(st, { queued: false, position: 0, startedAt: Date.now() });
    this.current = st;
    const own = new Map((o.entries || []).map(e => [e.host, e])); // login ze seznamu má u dané adresy přednost, pak společné loginy
    const settings = db.getSettings();
    const emit = () => this._emit(st, false);
    emit();
    const queue = [...hosts];
    const worker = async () => {
      while (queue.length) {
        const host = queue.shift();
        try {
          const ent = own.get(host);
          const hostPort = (ent && ent.port) || port;
          if (!(await probeTcp(host, hostPort, 1500))) { if (ent) st.errors.push(`${host}: port ${hostPort} neodpovídá`); continue; }
          st.open++;
          const ex = db.findDeviceByHost(host, hostPort);
          if (ex) {
            // adresa už je v seznamu: vlastní → „už v seznamu“; cizí → jen informace, že ji má někdo jiný (bez názvu a detailů zařízení)
            const ownerId = (ent && ent.ownerId) || o.ownerId || 0;
            if (ex.owner_id && ex.owner_id !== ownerId) { const ow = db.getUser(ex.owner_id); st.foreign.push(`${host}: má u sebe ${ow ? ow.name : 'jiný uživatel'} — každé zařízení může mít jen jednoho vlastníka, o předání požádej jeho nebo správce`); }
            else { st.existing++; st.found.push({ host, identity: ex.identity || ex.name, existing: true }); }
            continue;
          }
          let ok = false, lastErr = '', attempts = 0;
          const credList = ent ? [{ username: ent.username, password: ent.password }, ...(o.creds || []).filter(c => c.username !== ent.username || c.password !== ent.password)] : (o.creds || []);
          for (const cr of credList) {
            // víc než 2 pokusy během minuty by mohly spustit brute-force blacklist na routeru → rozestup
            if (attempts >= 2 && attempts % 2 === 0) await new Promise(r => setTimeout(r, 65000));
            attempts++;
            const c = new RosClient({ host, port: hostPort, username: cr.username, password: cr.password, timeoutMs: Math.min(15, settings.ssh_timeout_sec || 15) * 1000 });
            try {
              await c.connect();
              const r = await c.kv('/system resource', ['version', 'board-name', 'architecture-name']);
              const id = await c.kv('/system identity', ['name']);
              if (!r.version) { st.notRouterOS.push(host); ok = true; break; }
              const devId = db.insertDevice({ host, port: hostPort, username: cr.username, password_enc: encrypt(cr.password), name: (ent && ent.name) || '', group_name: (ent && ent.group_name) || o.group_name || '', track: o.track || 'v7-stable', owner_id: (ent && ent.ownerId) || o.ownerId || 0 });
              if (ent && ent.extra) db.updateDevice(devId, ent.extra); // např. vazba na APčko v userdb
              db.updateDevice(devId, { host_key: c.hostKey || '', identity: id.name || '', board_name: r['board-name'] || '', arch: r['architecture-name'] || '', version: (r.version || '').split(' ')[0], scan_status: 'ok', last_seen_at: db.now() });
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
    finally { st.finishedAt = Date.now(); emit(); this._emit(st, true); }
    return st;
  }
}
module.exports = { Discovery, expandCidr };
