'use strict';
// MikroTik upgrader — nouzové kanály k RouterOS, když SSH nejde: binární API (8728 / api-ssl 8729) a REST (v7, www/www-ssl).
// Autor: Pavel Vlček, hkfree.org, 2026
// Používá se jen pro opravu SSH (poškozený host key → /ip ssh regenerate-host-key + restart). Nic jiného přes tyhle kanály nejde.
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ---- kódování slov API protokolu (délka + bajty; věta končí prázdným slovem) ----
function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) { n |= 0x8000; return Buffer.from([n >> 8, n & 0xff]); }
  if (n < 0x200000) { n |= 0xC00000; return Buffer.from([n >> 16, (n >> 8) & 0xff, n & 0xff]); }
  if (n < 0x10000000) { n |= 0xE0000000; return Buffer.from([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]); }
  return Buffer.from([0xF0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function encodeSentence(words) {
  return Buffer.concat([...words.map(w => { const b = Buffer.from(String(w), 'utf8'); return Buffer.concat([encodeLength(b.length), b]); }), Buffer.from([0])]);
}
/** Vrátí {length, consumed} z bufferu od offsetu, nebo null, když ještě nedošly všechny bajty délky. */
function decodeLength(buf, off) {
  if (off >= buf.length) return null;
  const b0 = buf[off];
  if ((b0 & 0x80) === 0) return { length: b0, consumed: 1 };
  if ((b0 & 0xC0) === 0x80) { if (off + 1 >= buf.length) return null; return { length: ((b0 & 0x3f) << 8) | buf[off + 1], consumed: 2 }; }
  if ((b0 & 0xE0) === 0xC0) { if (off + 2 >= buf.length) return null; return { length: ((b0 & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], consumed: 3 }; }
  if ((b0 & 0xF0) === 0xE0) { if (off + 3 >= buf.length) return null; return { length: ((b0 & 0x0f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3], consumed: 4 }; }
  if (off + 4 >= buf.length) return null;
  return { length: (buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4], consumed: 5 };
}
/** Z bufferu vytáhne hotové věty (pole slov); vrátí {sentences, rest}. */
function decodeSentences(buf) {
  // rozpracovaná věta (nedošlo prázdné slovo) zůstává celá v rest — jinak by se její slova ztratila při dalším čtení ze socketu
  const sentences = []; let off = 0, sentStart = 0, words = [];
  while (true) {
    const l = decodeLength(buf, off);
    if (!l || off + l.consumed + l.length > buf.length) break;
    off += l.consumed;
    if (l.length === 0) { sentences.push(words); words = []; sentStart = off; continue; }
    words.push(buf.subarray(off, off + l.length).toString('utf8')); off += l.length;
  }
  return { sentences, rest: buf.subarray(sentStart) };
}

/**
 * Jedno sezení API: přihlásí se (nový způsob 6.43+ i starý s challenge), pošle příkazy po jednom a čeká na !done / !trap.
 * Příkaz, po kterém router spadne (/system/reboot), se bere jako hotový i když spojení skončí bez !done.
 * @param {object} o {host, port, ssl, username, password, timeoutMs}
 * @param {string[][]} commands  např. [['/ip/ssh/regenerate-host-key'], ['/system/reboot']]
 * @returns {Promise<string>} přepis (pro log)
 */
function apiRun({ host, port, ssl = false, username, password, timeoutMs = 20000 }, commands) {
  return new Promise((resolve, reject) => {
    let transcript = '', buf = Buffer.alloc(0), done = false, stage = 'connect', idx = -1, loginRetried = false;
    const sock = ssl
      // api-ssl bez certifikátu používá anonymní DH (ADH): OpenSSL 3 ho pustí jen přes „ALL“ se SECLEVEL=0 („DEFAULT“ má ADH trvale vyškrtnuté);
      // ověřeno 5.10.2026 na hAP lite 6.49 (ADH-AES256-GCM). Certifikát routeru se neověřuje (self-signed).
      ? tls.connect({ host, port: port || 8729, rejectUnauthorized: false, ciphers: 'ALL:@SECLEVEL=0', minVersion: 'TLSv1' })
      : net.createConnection({ host, port: port || 8728 });
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} err ? reject(err) : resolve(transcript); };
    const timer = setTimeout(() => finish(new Error(`API${ssl ? '-SSL' : ''}: timeout (${Math.round(timeoutMs / 1000)} s) ve fázi ${stage}`)), timeoutMs);
    const send = (words) => { transcript += '> ' + words.join(' ') + '\n'; sock.write(encodeSentence(words)); };
    const next = () => {
      idx++;
      if (idx >= commands.length) { stage = 'done'; return finish(); }
      const cmd = commands[idx];
      stage = /\/system\/reboot$/.test(cmd[0]) ? 'sent-reboot' : 'cmd';
      send(cmd);
      if (stage === 'sent-reboot') setTimeout(() => finish(), 4000); // odpověď na reboot někdy nedojde — spojení spadne
    };
    sock.on(ssl ? 'secureConnect' : 'connect', () => { stage = 'login'; send(['/login', `=name=${username}`, `=password=${password}`]); });
    sock.on('error', (e) => { if (stage === 'sent-reboot') return finish(); finish(new Error(`API${ssl ? '-SSL' : ''}: ${e.message}`)); });
    sock.on('close', () => { if (stage === 'sent-reboot' || stage === 'done') return finish(); finish(new Error(`API${ssl ? '-SSL' : ''}: spojení uzavřeno ve fázi ${stage}`)); });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { sentences, rest } = decodeSentences(buf); buf = rest;
      for (const s of sentences) {
        transcript += '< ' + s.join(' ') + '\n';
        const tag = s[0];
        if (tag === '!fatal') return finish(new Error(`API: ${s.slice(1).join(' ') || 'fatal'}`));
        if (stage === 'login') {
          if (tag === '!trap') return finish(new Error(`API: přihlášení odmítnuto (${(s.find(w => w.startsWith('=message=')) || '').slice(9) || 'špatné jméno nebo heslo'})`));
          if (tag !== '!done') continue;
          const ret = (s.find(w => w.startsWith('=ret=')) || '').slice(5);
          if (ret && !loginRetried) {
            // RouterOS < 6.43: heslo ignoroval a poslal challenge → odpověď md5(0x00 + heslo + challenge)
            loginRetried = true;
            const md5 = crypto.createHash('md5').update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), Buffer.from(ret, 'hex')])).digest('hex');
            send(['/login', `=name=${username}`, `=response=00${md5}`]);
            continue;
          }
          next(); continue;
        }
        if (stage === 'cmd') {
          if (tag === '!trap') return finish(new Error(`API: příkaz ${commands[idx][0]} odmítnut (${(s.find(w => w.startsWith('=message=')) || '').slice(9) || 'trap'})`));
          if (tag === '!done') next();
          continue;
        }
        if (stage === 'sent-reboot' && tag === '!done') return finish();
      }
    });
  });
}

/**
 * REST API (RouterOS 7.1+, služba www nebo www-ssl): POST /rest/<cesta>/<příkaz> s basic auth. Na v6 (Webfig) vrací 404 → chyba „REST není“.
 * @param {object} o {host, port, ssl, username, password, timeoutMs}
 * @param {string} path  např. 'ip/ssh/regenerate-host-key'
 * @returns {Promise<{status:number, body:string}>}
 */
function restPost({ host, port, ssl = false, username, password, timeoutMs = 15000 }, path, body = {}) {
  return new Promise((resolve, reject) => {
    const mod = ssl ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request({
      host, port: port || (ssl ? 443 : 80), method: 'POST', path: `/rest/${path.replace(/^\/+/, '')}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64') },
      rejectUnauthorized: false, timeout: timeoutMs,
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; if (out.length > 65536) out = out.slice(0, 65536); });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('timeout', () => { req.destroy(new Error(`REST${ssl ? ' (https)' : ''}: timeout (${Math.round(timeoutMs / 1000)} s)`)); });
    req.on('error', (e) => reject(new Error(`REST${ssl ? ' (https)' : ''}: ${e.message}`)));
    req.end(data);
  });
}

module.exports = { apiRun, restPost, encodeSentence, decodeSentences, encodeLength };
