'use strict';
// SSH klient pro RouterOS (v6 i v7) — všechna data se čtou přes :put / get (bez parsování tabulek),
// soubory přes SFTP. Nic v tomto modulu nemění konfiguraci routeru, pokud volající nezavolá exec() s měnícím příkazem.
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');

const ALGORITHMS = {
  kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512', 'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    'aes256-cbc', 'aes192-cbc', 'aes128-cbc', '3des-cbc'],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1', 'hmac-sha1-96', 'hmac-md5'],
};

const ROS_ERROR_RE = /^(bad command name|syntax error|expected end of command|no such item|failure:|input does not match any value|invalid value|ambiguous value|missing value|expected command name|unknown parameter|action timed out|not enough permissions|invalid internal item number)/im;

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

class RosClient {
  /**
   * @param {object} o {host, port, username, password, timeoutMs, expectedHostKey, onHostKey(fp)}
   */
  constructor(o) {
    this.o = o;
    this.conn = null;
    this.hostKey = '';
    this.closed = false;
    this.pending = new Set(); // reject() rozpracovaných operací — při pádu spojení se všechny odmítnou
  }

  /** Zaregistruje reject rozpracované operace; vrátí funkci pro odregistrování. */
  _track(reject) { this.pending.add(reject); return () => this.pending.delete(reject); }
  _failPending(msg) {
    const list = [...this.pending]; this.pending.clear();
    for (const r of list) { try { r(new Error(msg)); } catch {} }
  }
  /** Násilně ukončí spojení; všechny rozpracované příkazy/přenosy skončí chybou `reason`. */
  abort(reason = 'spojení přerušeno') {
    this.closed = true;
    this._failPending('SSH: ' + reason);
    const conn = this.conn; this.conn = null;
    if (conn) { try { conn.end(); } catch {} try { conn.destroy(); } catch {} }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let done = false;
      const fail = (e) => { if (done) return; done = true; try { conn.end(); } catch {} reject(e); };
      conn.on('ready', () => { if (done) return; done = true; this.conn = conn; resolve(this); });
      conn.on('error', (e) => { const msg = 'SSH: ' + (e && e.message || e); if (!done) fail(new Error(msg)); else this._failPending(msg); });
      conn.on('close', () => { this.closed = true; if (!done) fail(new Error('SSH: spojení uzavřeno')); else { this.conn = null; this._failPending('SSH: spojení uzavřeno routerem (nebo sítí) uprostřed operace'); } });
      conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => this.o.password || ''));
      });
      conn.connect({
        host: this.o.host,
        port: this.o.port || 22,
        username: this.o.username,
        password: this.o.password || '',
        tryKeyboard: true,
        readyTimeout: this.o.timeoutMs || 20000,
        // keepalive: router při zápisu balíčku do flash odpovídá pomalu — tolerovat až 90 s ticha
        keepaliveInterval: 15000,
        keepaliveCountMax: 6,
        algorithms: ALGORITHMS,
        hostVerifier: (key) => {
          const fp = fingerprint(key);
          this.hostKey = fp;
          if (this.o.expectedHostKey && this.o.expectedHostKey !== fp) {
            this.hostKeyMismatch = fp;
            return false;
          }
          return true;
        },
      });
    });
  }

  /** Spustí příkaz, vrátí stdout (bez \r). Chyby RouterOS detekuje podle textu. */
  exec(cmd, { timeoutMs = 30000, allowError = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.conn || this.closed) return reject(new Error('SSH: není připojeno'));
      let out = '', err = '', finished = false, stream;
      const untrack = this._track((e) => { if (finished) return; finished = true; clearTimeout(timer); try { stream && stream.close(); } catch {} reject(e); });
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true; untrack();
        try { stream && stream.close(); } catch {}
        reject(new Error(`SSH: timeout příkazu (${Math.round(timeoutMs / 1000)} s): ${cmd.slice(0, 80)}`));
      }, timeoutMs);
      this.conn.exec(cmd, (e, s) => {
        if (e) { clearTimeout(timer); finished = true; untrack(); return reject(new Error('SSH exec: ' + e.message)); }
        stream = s;
        s.on('data', (d) => { out += d.toString('utf8'); });
        s.stderr.on('data', (d) => { err += d.toString('utf8'); });
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer); untrack();
          const text = (out + (err ? '\n' + err : '')).replace(/\r/g, '');
          if (!allowError && ROS_ERROR_RE.test(text)) return reject(new Error('RouterOS: ' + text.trim().split('\n')[0].slice(0, 200)));
          resolve(text);
        };
        s.on('close', finish);
        s.on('end', () => setTimeout(finish, 50));
        s.on('error', (e2) => { if (!finished) { finished = true; clearTimeout(timer); untrack(); reject(e2); } });
      });
    });
  }

  /** Přečte hodnoty z menu se single-entry (např. /system resource): {key: value|null} */
  async kv(menu, keys, opts) {
    const cmd = keys.map(k => `:do {:put ("${k}=" . [${menu} get ${k}])} on-error={:put "${k}=%%ERR%%"}`).join('; ');
    const text = await this.exec(cmd, opts);
    const res = {};
    for (const k of keys) res[k] = null;
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i), v = line.slice(i + 1);
      if (!(k in res)) continue;
      res[k] = v === '%%ERR%%' ? null : v;
    }
    return res;
  }

  /** Vypíše položky menu: [{field: value}] přes :foreach. Chyba menu (neexistuje) => null. */
  async list(menu, fields, { where = '', ...opts } = {}) {
    const sep = '|~|';
    const expr = fields.map(f => `[:tostr [${menu} get $i ${f}]]`).join(` . "${sep}" . `);
    const cmd = `:do {:foreach i in=[${menu} find ${where}] do={:do {:put (${expr})} on-error={}}} on-error={:put "%%LISTERR%%"}`;
    const text = await this.exec(cmd, opts);
    if (text.includes('%%LISTERR%%')) return null;
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(sep);
      if (parts.length !== fields.length) continue;
      const r = {};
      fields.forEach((f, i) => { r[f] = parts[i]; });
      rows.push(r);
    }
    return rows;
  }

  /** Počet položek [menu find ...]; null když menu neexistuje. */
  async count(menu, where = '') {
    const text = await this.exec(`:do {:put [:len [${menu} find ${where}]]} on-error={:put "%%ERR%%"}`);
    const t = text.trim().split('\n').pop();
    if (t.includes('%%ERR%%')) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }

  sftp() {
    return new Promise((resolve, reject) => {
      if (!this.conn || this.closed) return reject(new Error('SSH: není připojeno'));
      let done = false;
      const untrack = this._track((e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
      const t = setTimeout(() => { if (!done) { done = true; untrack(); reject(new Error('SFTP: timeout otevření')); } }, 20000);
      this.conn.sftp((e, s) => { if (done) { try { s && s.end(); } catch {} return; } done = true; clearTimeout(t); untrack(); if (e) reject(new Error('SFTP: ' + e.message)); else resolve(s); });
    });
  }

  /**
   * SFTP přenos s hlídáním: bez postupu déle než stallMs, nebo celkově déle než maxMs → přenos se přeruší
   * a spojení násilně ukončí (fastPut/fastGet po pádu spojení jinak nikdy nezavolá callback → job by visel navždy).
   */
  _transfer(kind, sftp, local, remote, onProgress, { stallMs = 120000, maxMs = 30 * 60000 } = {}) {
    return new Promise((resolve, reject) => {
      let done = false, lastProgress = Date.now(), transferred = 0, total = 0;
      const start = Date.now();
      const fail = (msg) => { if (done) return; done = true; cleanup(); reject(new Error(msg)); };
      const untrack = this._track((e) => { if (!done) { done = true; cleanup(); reject(e); } });
      const watchdog = setInterval(() => {
        if (done) return;
        const pct = total ? Math.round(transferred * 100 / total) : 0;
        if (Date.now() - lastProgress > stallMs) { fail(`SFTP ${kind}: přenos se zasekl (${Math.round(stallMs / 1000)} s bez postupu, ${pct} %)`); this.abort('přenos zaseknutý'); }
        else if (Date.now() - start > maxMs) { fail(`SFTP ${kind}: přenos trvá déle než ${Math.round(maxMs / 60000)} min (${pct} %)`); this.abort('přenos příliš dlouhý'); }
      }, 5000);
      const cleanup = () => { clearInterval(watchdog); untrack(); };
      const opts = {
        concurrency: 1, chunkSize: 32768, // RouterOS SFTP: sériově, souběžné zápisy do flash router občas neustojí
        step: (t, chunk, tot) => { transferred = t; total = tot; lastProgress = Date.now(); if (onProgress) onProgress(t, tot); },
      };
      const cb = (e) => { if (done) return; done = true; cleanup(); e ? reject(new Error(`SFTP ${kind}: ` + e.message)) : resolve(); };
      if (kind === 'put') sftp.fastPut(local, remote, opts, cb); else sftp.fastGet(remote, local, opts, cb);
    });
  }

  async download(remote, local, onProgress) {
    const sftp = await this.sftp();
    try { await this._transfer('get', sftp, local, remote, onProgress); }
    finally { try { sftp.end(); } catch {} }
    return fs.statSync(local).size;
  }

  async upload(local, remote, onProgress) {
    const sftp = await this.sftp();
    try { await this._transfer('put', sftp, local, remote, onProgress); }
    finally { try { sftp.end(); } catch {} }
  }

  /** Lokální IP, ze které je spojení navázané (kvůli kontrole, že si omezením služeb nezavřeme přístup). */
  localAddress() { try { return (this.conn && this.conn._sock && this.conn._sock.localAddress) || ''; } catch { return ''; } }

  close() { this.closed = true; this._failPending('SSH: spojení zavřeno'); const conn = this.conn; this.conn = null; try { conn && conn.end(); } catch {} }
}

/** TCP probe: true když port přijímá spojení */
function probeTcp(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { RosClient, probeTcp, sleep, fingerprint };
