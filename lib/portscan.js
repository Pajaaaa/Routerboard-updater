'use strict';
// MikroTik upgrader — hledání portu, na kterém kus opravdu odpovídá jako SSH.
// Autor: Pavel Vlček, hkfree.org, 2026
// Proč: 9.11.2026 se při natahování z RB-DB ukázalo, že část kusů se „zavřeným nebo nedostupným SSH“ má službu ssh jen na jiném portu
// (2222, 2224, 3256…) — natažení zkouší jen port 22 a hlásí „SSH blokuje firewall / nedostupné“. Sken najde port podle úvodního
// řádku „SSH-2.0-…“ (server ho posílá sám hned po spojení), ne podle čísla portu, a natažení ho pak použije místo 22.
//
// Dva režimy:
//  quick — jen obvyklé náhradní porty, po jednom s rozestupem: nespustí ochranu proti skenování portů (RouterOS psd má výchozí
//          práh 21 bodů za 3 s; port do 1024 = 3 body, vyšší = 1 bod), takže server neskončí v blacklistu kusu
//  full  — všech 65535 portů souběžně: najde i neobvyklý port, ale na kusu s psd pravidlem může adresu serveru na čas zablokovat
const net = require('net');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

/** obvyklé náhradní porty SSH, seřazené podle toho, jak často se v síti vyskytují (22 první: ověří, jestli nezačal odpovídat) */
const COMMON_PORTS = [22, 2222, 22222, 2022, 2200, 222, 8022, 10022, 2224, 2223, 2221, 2220, 2225, 2202, 2201, 22022, 22000, 1022, 3022, 4022,
  5022, 6022, 7022, 9022, 20022, 30022, 40022, 50022, 60022, 2122, 2322, 8222, 9222, 12222, 22122, 22223, 22224, 2226, 2227, 2228, 2229, 2022, 3222, 4222,
  5222, 6222, 7222, 11022, 12022, 2210, 2211, 2212, 22220, 22221, 222, 322, 422, 522, 622, 722, 822, 922, 1122, 1222];

/**
 * jeden port: spojení + (když se otevře) čekání na první data. Vrací { state: 'open'|'closed'|'filtered', banner }.
 * SSH server posílá úvodní řádek sám; Winbox, API ani web bez dotazu nic nepošlou → banner '' po uplynutí bannerMs.
 */
function probePort(host, port, timeoutMs = 1200, bannerMs = 2500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false, opened = false, buf = '', tm = null;
    const fin = (state) => { if (done) return; done = true; clearTimeout(tm); try { s.destroy(); } catch {} resolve({ state, banner: buf.split(/\r?\n/)[0].replace(/[^\x20-\x7e]/g, '').slice(0, 80) }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => { opened = true; s.setTimeout(0); tm = setTimeout(() => fin('open'), bannerMs); });
    s.on('data', (d) => { buf += d.toString('latin1'); if (buf.length >= 4 || /\n/.test(buf)) fin('open'); });
    s.once('timeout', () => fin(opened ? 'open' : 'filtered'));
    s.once('close', () => fin(opened ? 'open' : 'closed'));
    s.once('error', (e) => fin(opened ? 'open' : e && e.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));
    s.connect(port, host);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isSsh = (banner) => /^SSH-\d/.test(banner || '');
const isRos = (banner) => /ROSSSH/i.test(banner || '');

/**
 * sken jednoho kusu. o: { mode: 'quick'|'full', ports?: number[] (jen pro testy), gapMs?, concurrency?, timeoutMs?, bannerMs?, onProgress?(done,total), stop?() }
 * Vrací { host, mode, at, ms, port (nejlepší SSH port nebo 0), banner, ros, ssh: [{port, banner}], open: [porty bez SSH], scanned, filtered }.
 * Nejlepší port = RouterOS („ROSSSH“) před cizím SSH (přesměrování na server za routerem), jinak první nalezený.
 */
async function scanHost(host, o = {}) {
  const mode = o.mode === 'full' ? 'full' : 'quick';
  const t0 = Date.now();
  let ports = o.ports ? [...o.ports] : mode === 'full' ? null : COMMON_PORTS;
  if (!ports) { const first = new Set(COMMON_PORTS); ports = [...COMMON_PORTS]; for (let p = 1; p <= 65535; p++) if (!first.has(p)) ports.push(p); }
  ports = [...new Set(ports)].filter(p => p >= 1 && p <= 65535);
  const res = { host, mode, at: Date.now(), ms: 0, port: 0, banner: '', ros: false, ssh: [], open: [], scanned: 0, filtered: 0 };
  const timeoutMs = o.timeoutMs || (mode === 'full' ? 1200 : 1500), bannerMs = o.bannerMs || 2500;
  const one = async (port) => {
    const r = await probePort(host, port, timeoutMs, bannerMs);
    res.scanned++;
    if (r.state === 'filtered') res.filtered++;
    else if (r.state === 'open') { if (isSsh(r.banner)) res.ssh.push({ port, banner: r.banner }); else if (res.open.length < 40) res.open.push(port); }
    if (o.onProgress && (res.scanned % 64 === 0 || r.state === 'open')) o.onProgress(res.scanned, ports.length);
  };
  if (mode === 'quick') {
    // po jednom s rozestupem (pod prahem psd); první RouterOS SSH stačí — dál se neklepe
    const gap = o.gapMs == null ? 350 : o.gapMs;
    for (const p of ports) {
      if (o.stop && o.stop()) break;
      const t = Date.now();
      await one(p);
      if (res.ssh.some(x => isRos(x.banner))) break;
      const left = (p < 1024 ? 3 : 1) * gap - (Date.now() - t); if (left > 0) await sleep(left); // port do 1024 váží u psd 3× → 3× delší rozestup
    }
  } else {
    let i = 0;
    const worker = async () => { while (i < ports.length && !(o.stop && o.stop())) await one(ports[i++]); };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency || 200, ports.length)) }, worker));
  }
  res.ssh.sort((a, b) => (isRos(b.banner) - isRos(a.banner)) || a.port - b.port);
  res.open.sort((a, b) => a - b);
  if (res.ssh.length) { res.port = res.ssh[0].port; res.banner = res.ssh[0].banner; res.ros = isRos(res.banner); }
  res.ms = Date.now() - t0;
  if (o.onProgress) o.onProgress(res.scanned, ports.length);
  return res;
}

/**
 * Správa skenů s frontou: další adresy jde přidat i během běhu (zařadí se na konec), výsledky po IP i čekající fronta přežijí restart
 * (data/ssh-ports.json, data/ssh-queue.json) — RB-DB kreslí výsledky u kusů a natažení z nich bere port.
 * Souběh: nejvýš FULL_PAR kusů v režimu „všechny porty“ (každý 200 spojení) a QUICK_PAR v šetrném režimu.
 * Stav běhu: { running, mode (poslední přidaná dávka), by, total, done, queued, current: [ip…], found, startedAt, finishedAt, portsDone, portsTotal }.
 */
const FULL_PAR = 4, QUICK_PAR = 12;
class SshPortScan {
  constructor(bus, o = {}) {
    this.bus = bus; this.state = null; this.results = new Map(); this.queue = []; this.active = new Map(); // active: ip -> mode
    this.scan = o.scan || scanHost; this.done = Promise.resolve();
    this._load();
    if (this.queue.length && o.resume !== false) setImmediate(() => this._resume());
  }
  get _file() { return path.join(cfg.dataDir, 'ssh-ports.json'); }
  get _qfile() { return path.join(cfg.dataDir, 'ssh-queue.json'); }
  _load() {
    try { for (const [ip, r] of Object.entries(JSON.parse(fs.readFileSync(this._file, 'utf8')))) if (r && r.at) this.results.set(ip, r); }
    catch (e) { if (e.code !== 'ENOENT') console.error('portscan: výsledky z disku nejdou načíst:', e.message); }
    try { const q = JSON.parse(fs.readFileSync(this._qfile, 'utf8')); for (const x of q.items || []) if (x && x.ip) this.queue.push({ ip: x.ip, mode: x.mode === 'full' ? 'full' : 'quick' }); this._qby = q.by || ''; }
    catch (e) { if (e.code !== 'ENOENT') console.error('portscan: fronta z disku nejde načíst:', e.message); }
  }
  _write(file, data) {
    try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); }
    catch (e) { console.error('portscan: nejde uložit', path.basename(file) + ':', e.message); }
  }
  _persist() { this._write(this._file, Object.fromEntries(this.results)); }
  /** fronta na disk včetně právě běžících kusů — po restartu se rozdělané zkusí znovu */
  _persistQueue() { this._write(this._qfile, { by: this.state ? this.state.by : '', items: [...[...this.active].map(([ip, mode]) => ({ ip, mode })), ...this.queue] }); }
  get running() { return !!(this.state && !this.state.finishedAt); }
  status() { return this.state; }
  /** výsledek pro IP (nebo null, když se neskenovala) */
  get(ip) { return this.results.get(ip) || null; }
  /** čeká IP ve frontě nebo se právě skenuje? */
  pending(ip) { return this.active.has(ip) || this.queue.some(x => x.ip === ip); }
  /** port pro natažení: nalezený SSH port RouterOS, jinak 0 (= výchozí). Cizí SSH (server za přesměrováním) se nepoužije — login z userdb
   *  by se jen marně zkoušel na cizím stroji. */
  portFor(ip) { const r = this.results.get(ip); return r && r.port && r.ros ? r.port : 0; }
  _emit(done) { this.bus.emit('event', { type: done ? 'sshscan-done' : 'sshscan', state: this.state }); }
  _resume() { const items = this.queue; this.queue = []; console.log(`portscan: pokračuji ve frontě po restartu (${items.length} adres)`); for (const m of ['quick', 'full']) { const ips = items.filter(x => x.mode === m).map(x => x.ip); if (ips.length) this.enqueue({ ips, mode: m, by: this._qby }); } }
  /**
   * přidá adresy do fronty (běh se rozjede, nebo se připojí k běžícímu); adresy, které už čekají nebo běží, se přeskočí.
   * Vrací { state, added, skipped }.
   */
  enqueue({ ips, mode, by }) {
    const m = mode === 'full' ? 'full' : 'quick';
    const add = [...new Set(ips)].filter(ip => !this.pending(ip));
    if (!this.running) this.state = { running: true, mode: m, by: by || '', total: 0, done: 0, queued: 0, current: [], found: 0, startedAt: Date.now(), finishedAt: 0 };
    const st = this.state;
    if (add.length) { st.mode = m; st.by = by || st.by; }
    for (const ip of add) this.queue.push({ ip, mode: m });
    st.total += add.length; st.queued = this.queue.length;
    this._persistQueue();
    if (!this._finish) this.done = new Promise(r => { this._finish = r; });
    this._pump();
    this._emit(false);
    if (!this.active.size && !this.queue.length) this._end(); // nic nového a nic neběží
    return { state: st, added: add.length, skipped: ips.length - add.length };
  }
  _end() {
    const st = this.state; if (!st || st.finishedAt) return;
    st.running = false; st.finishedAt = Date.now(); st.queued = 0; st.current = [];
    this._persist(); this._persistQueue(); this._emit(true);
    const f = this._finish; this._finish = null; if (f) f(st);
  }
  /** rozjede další kusy z fronty do volných míst (full a quick mají vlastní strop) */
  _pump() {
    const st = this.state; if (!st || st.finishedAt) return;
    const cnt = (m) => [...this.active.values()].filter(x => x === m).length;
    for (let i = 0; i < this.queue.length;) {
      const it = this.queue[i];
      if (cnt(it.mode) >= (it.mode === 'full' ? FULL_PAR : QUICK_PAR)) { i++; continue; }
      this.queue.splice(i, 1);
      this.active.set(it.ip, it.mode);
      this._one(it);
    }
    st.queued = this.queue.length; st.current = [...this.active.keys()];
  }
  async _one({ ip, mode }) {
    const st = this.state;
    try {
      const r = await this.scan(ip, { mode, onProgress: (d, t) => { st.portsDone = d; st.portsTotal = t; if (Date.now() - (this._lastEmit || 0) > 1500) { this._lastEmit = Date.now(); this._emit(false); } } });
      this.results.set(ip, r); if (r.port) st.found++;
    } catch (e) { this.results.set(ip, { host: ip, mode, at: Date.now(), ms: 0, port: 0, banner: '', ros: false, ssh: [], open: [], scanned: 0, filtered: 0, error: e.message }); }
    this.active.delete(ip); st.done++;
    this._persist(); this._persistQueue();
    this._pump();
    if (!this.active.size && !this.queue.length) this._end(); else this._emit(false);
  }
}

module.exports = { SshPortScan, scanHost, probePort, COMMON_PORTS, isSsh, isRos };
