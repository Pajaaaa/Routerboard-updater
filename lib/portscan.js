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
 * Správa skenů: jeden běh naráz, výsledky po IP přežijí restart (data/ssh-ports.json) — RB-DB je kreslí u kusů a natažení z nich bere port.
 * Stav běhu: { running, mode, by, total, done, current: [ip…], found, startedAt, finishedAt }.
 */
class SshPortScan {
  constructor(bus) { this.bus = bus; this.state = null; this.results = new Map(); this._load(); }
  get _file() { return path.join(cfg.dataDir, 'ssh-ports.json'); }
  _load() {
    try { for (const [ip, r] of Object.entries(JSON.parse(fs.readFileSync(this._file, 'utf8')))) if (r && r.at) this.results.set(ip, r); }
    catch (e) { if (e.code !== 'ENOENT') console.error('portscan: výsledky z disku nejdou načíst:', e.message); }
  }
  _persist() {
    try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(this._file + '.tmp', JSON.stringify(Object.fromEntries(this.results))); fs.renameSync(this._file + '.tmp', this._file); }
    catch (e) { console.error('portscan: výsledky nejdou uložit:', e.message); }
  }
  get running() { return !!(this.state && !this.state.finishedAt); }
  status() { return this.state; }
  /** výsledek pro IP (nebo null, když se neskenovala) */
  get(ip) { return this.results.get(ip) || null; }
  /** port pro natažení: nalezený SSH port RouterOS, jinak 0 (= výchozí). Cizí SSH (server za přesměrováním) se nepoužije — login z userdb
   *  by se jen marně zkoušel na cizím stroji. */
  portFor(ip) { const r = this.results.get(ip); return r && r.port && r.ros ? r.port : 0; }
  _emit(done) { this.bus.emit('event', { type: done ? 'sshscan-done' : 'sshscan', state: this.state }); }
  /** spustí sken na pozadí; vrací stav. scan = náhrada scanHost (testy). */
  start({ ips, mode, by, scan }) {
    if (this.running) throw new Error('hledání SSH portu už běží, počkej na dokončení');
    const full = mode === 'full';
    const st = this.state = { running: true, mode: full ? 'full' : 'quick', by: by || '', total: ips.length, done: 0, current: [], found: 0, startedAt: Date.now(), finishedAt: 0 };
    const queue = [...ips], run = scan || scanHost;
    let lastEmit = 0;
    const worker = async () => {
      while (queue.length) {
        const ip = queue.shift();
        st.current.push(ip); this._emit(false);
        try {
          const r = await run(ip, { mode: st.mode, onProgress: (d, t) => { st.portsDone = d; st.portsTotal = t; if (Date.now() - lastEmit > 1500) { lastEmit = Date.now(); this._emit(false); } } });
          this.results.set(ip, r); if (r.port) st.found++;
        } catch (e) { this.results.set(ip, { host: ip, mode: st.mode, at: Date.now(), ms: 0, port: 0, banner: '', ros: false, ssh: [], open: [], scanned: 0, filtered: 0, error: e.message }); }
        st.current = st.current.filter(x => x !== ip); st.done++;
        this._persist(); this._emit(false);
      }
    };
    // quick: víc kusů naráz (každý dostává jen pár spojení za sekundu); full: 2 kusy × 200 spojení
    this.done = Promise.all(Array.from({ length: Math.max(1, Math.min(full ? 2 : 12, ips.length)) }, worker))
      .catch(e => console.error('portscan:', e.message))
      .then(() => { st.running = false; st.finishedAt = Date.now(); this._persist(); this._emit(true); return st; });
    return st;
  }
}

module.exports = { SshPortScan, scanHost, probePort, COMMON_PORTS, isSsh, isRos };
