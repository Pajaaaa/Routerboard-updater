'use strict';
// MikroTik upgrader — automatická oprava SSH na zařízení, když se k němu nejde připojit kvůli klíčům nebo algoritmům.
// Autor: Pavel Vlček, hkfree.org, 2026
//
// Dva druhy potíží, které tenhle modul řeší:
//  1) poškozený SSH host key routeru (RouterOS log „Corrupt host's key, regenerating it! Reboot required!“): server ukončí handshake
//     s KEY_EXCHANGE_FAILED (nebo podpis klíče neprojde). Oprava = „/ip ssh regenerate-host-key“ + restart. Zkouší se postupně:
//       a) SSH s jiným typem host key (RouterOS 6 má RSA i DSA, v7 RSA i ed25519 — poškozený bývá jen jeden z nich),
//       b) RouterOS API (8728) a api-ssl (8729),
//       c) REST API (v7: www 80 / www-ssl 443),
//       d) telnet (23).
//     Kanál, který se povedl, a celý postup se vypíšou do logu položky. Po restartu se zařízení ověří normálním SSH a uložený otisk
//     klíče se nahradí novým (změna klíče je náš zásah, ne podvrh).
//  2) žádný společný algoritmus (kex / host key / šifra / MAC): zkusí se připojení se vším, co knihovna ssh2 umí, včetně zastaralých
//     algoritmů; když to jde, položka pokračuje s nimi (bez restartu) a do logu se napíše, čím zařízení jede.
//
// Pozor na brute-force pravidla na routerech (klasický address-list „ssh_stage1..3“ → blacklist po 4. novém spojení za minutu):
// náhradní SSH pokusy jsou nejvýš dva, pak už jen jiné kanály (API/REST/telnet se do SSH pravidel nepočítají).
const { probeTcpWhy, sleep } = require('./ros');
const { telnetRun } = require('./telnet');
const { apiRun, restPost } = require('./rosapi');

// všechny algoritmy, které ssh2 podporuje — pro kusy, se kterými se bezpečná sada nedomluví (RouterOS 6.x s vypnutým strong-crypto nabízí i 3des/md5)
const LEGACY_ALGORITHMS = {
  kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256', 'diffie-hellman-group15-sha512', 'diffie-hellman-group16-sha512',
    'diffie-hellman-group17-sha512', 'diffie-hellman-group18-sha512', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'chacha20-poly1305@openssh.com',
    'aes256-cbc', 'aes192-cbc', 'aes128-cbc', '3des-cbc', 'aes128-gcm', 'aes256-gcm'],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha1-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512',
    'hmac-sha1', 'hmac-md5', 'hmac-sha2-256-96', 'hmac-sha2-512-96', 'hmac-ripemd160', 'hmac-sha1-96', 'hmac-md5-96'],
};

/**
 * Zařadí chybu připojení SSH (text z ssh2 / RosClient). Vrací null, když to není potíž s klíči nebo algoritmy
 * (timeout, odmítnuté spojení, špatné heslo, změněný otisk …).
 * @returns {null | {kind: 'corrupt-key'|'algo', text: string, detail: string}}
 */
function classifySshError(msg) {
  const m = String(msg || '').replace(/^SSH:\s*/, '');
  if (!m) return null;
  if (/Host denied|authentication|Timed out while waiting for handshake|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(m)) return null;
  const nm = /Handshake failed: no matching (key exchange algorithm|host key format|C->S cipher|S->C cipher|C->S MAC|S->C MAC|C->S compression|S->C compression)/i.exec(m);
  if (nm) {
    const what = { 'key exchange algorithm': 'výměnu klíčů (kex)', 'host key format': 'typ host key', 'C->S cipher': 'šifru', 'S->C cipher': 'šifru', 'C->S MAC': 'MAC', 'S->C MAC': 'MAC', 'C->S compression': 'kompresi', 'S->C compression': 'kompresi' }[nm[1]] || nm[1];
    return { kind: 'algo', detail: m, text: `zařízení nenabízí žádný společný algoritmus pro ${what} (${m})` };
  }
  // server sám ukončil handshake kódem KEY_EXCHANGE_FAILED (RouterOS s poškozeným klíčem posílá jen kód bez popisu), nebo podpis host key neprošel
  if (/KEY_EXCHANGE_FAILED|signature verification failed|Handshake failed|unable to parse|unsupported.*key|Malformed/i.test(m)) {
    return { kind: 'corrupt-key', detail: m, text: `poškozený SSH host key zařízení (${m}; v logu routeru „Corrupt host's key, regenerating it! Reboot required!“)` };
  }
  return null;
}

/** Pořadí náhradních typů host key podle verze RouterOS: nejdřív ten, který se při běžném připojení nedomlouvá. */
function altHostKeySets(version) {
  const v = String(version || '');
  const RSA = ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];
  if (/^7\./.test(v)) return [RSA, ['ssh-ed25519']];     // v7 (7.9+) nabízí ed25519 i RSA; klient běžně bere ed25519 → zkusit RSA, pak samotný ed25519
  if (/^6\./.test(v)) return [['ssh-dss'], RSA];         // v6 nabízí RSA i DSA; klient běžně bere RSA → zkusit DSA
  return [['ssh-dss'], RSA];
}

/**
 * Spustí příkaz přes exec kanál a rovnou pošle „y“ na stdin — kdyby se RouterOS přece ptal „[y/N]“ (neinteraktivně se neptá,
 * ale ať to nikdy nezůstane viset). Vrací výstup; chyby RouterOS nehází, jen vrací text.
 */
function execConfirm(cl, cmd, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!cl.conn || cl.closed) return reject(new Error('SSH: není připojeno'));
    let out = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`SSH: timeout příkazu (${Math.round(timeoutMs / 1000)} s): ${cmd}`)); } }, timeoutMs);
    cl.conn.exec(cmd, (e, s) => {
      if (e) { clearTimeout(timer); done = true; return reject(new Error('SSH exec: ' + e.message)); }
      const fin = () => { if (done) return; done = true; clearTimeout(timer); resolve(out.replace(/\r/g, '')); };
      s.on('data', (d) => { out += d.toString('latin1'); });
      s.stderr.on('data', (d) => { out += d.toString('latin1'); });
      s.on('close', fin); s.on('end', () => setTimeout(fin, 50)); s.on('error', (e2) => { if (!done) { done = true; clearTimeout(timer); reject(e2); } });
      try { s.write('y\r\n'); } catch {}
    });
  });
}

/**
 * Zkusí se připojit se všemi algoritmy, které ssh2 umí (kind 'algo'). Vrací připojeného klienta (volající si ho nechá a pokračuje
 * s ním) a sadu algoritmů pro další spojení, nebo hodí původní chybu.
 * @param {(extra: object) => Promise<object>} tryConnect  vytvoří a připojí RosClient s dodatečnými volbami (algorithms, expectedHostKey)
 */
async function connectLegacy(tryConnect, log) {
  const L = log || (() => {});
  L('info', 'zkouším SSH se všemi algoritmy, které knihovna umí (včetně zastaralých: DH group1, 3DES, HMAC-MD5)');
  const cl = await tryConnect({ algorithms: LEGACY_ALGORITHMS });
  L('warn', 'SSH jede jen se zastaralými algoritmy — zařízení zřejmě běží velmi starý RouterOS nebo má /ip ssh strong-crypto nesmyslně nastavené; po upgradu se to typicky srovná');
  return { client: cl, algorithms: LEGACY_ALGORITHMS };
}

/**
 * Oprava poškozeného SSH host key: „/ip ssh regenerate-host-key“ + „/system reboot“ přes první kanál, který se povede.
 * Všechny pokusy jdou do logu. Když nejde žádný kanál, hodí chybu se souhrnem a návodem na ruční opravu.
 * @param {object} o
 * @param {object} o.creds     {host, port, username, password, timeoutMs}
 * @param {string} [o.version] známá verze RouterOS (pořadí náhradních typů klíče)
 * @param {(extra: object) => Promise<object>} o.tryConnect  připojí RosClient s dodatečnými volbami (algorithms, expectedHostKey)
 * @param {(level: string, msg: string) => void} [o.log]
 * @param {object} [o.deps]  pro testy: {probe, api, rest, telnet}
 * @returns {Promise<{channel: string, transcript: string}>}
 */
async function regenerateHostKey({ creds, version, tryConnect, log, deps = {} }) {
  const L = log || (() => {});
  const probe = deps.probe || probeTcpWhy, api = deps.api || apiRun, rest = deps.rest || restPost, telnet = deps.telnet || telnetRun;
  const failures = [];
  const base = { host: creds.host, username: creds.username, password: creds.password, timeoutMs: 20000 };

  // a) SSH s jiným typem host key (nejvýš 2 pokusy — brute-force pravidla počítají nová spojení na port 22)
  if (typeof tryConnect === 'function') {
    for (const set of altHostKeySets(version)) {
      const name = set.length === 1 ? set[0] : set[set.length - 1].replace('ssh-', '').toUpperCase();
      L('info', `zkouším SSH s jiným typem host key: ${name}`);
      let cl = null;
      try { cl = await tryConnect({ algorithms: { serverHostKey: set }, expectedHostKey: '' }); }
      catch (e) { failures.push(`SSH ${name}: ${e.message.replace(/^SSH:\s*/, '')}`); L('info', `SSH ${name} nejde: ${e.message}`); continue; }
      try {
        L('info', `✔ SSH s host key ${name} funguje — spouštím /ip ssh regenerate-host-key`);
        const out = await execConfirm(cl, '/ip ssh regenerate-host-key', 30000);
        if (/bad command|syntax error|not enough permissions|failure/i.test(out)) throw new Error(`RouterOS odmítl regenerate-host-key: ${out.trim().split('\n')[0].slice(0, 160)}`);
        L('info', `regenerate-host-key proběhl${out.trim() ? ` (${out.trim().split('\n')[0].slice(0, 120)})` : ''}, posílám /system reboot`);
        try { await execConfirm(cl, '/system reboot', 8000); } catch { /* spojení při restartu spadne */ }
        return { channel: `SSH (host key ${name})`, transcript: out };
      } catch (e) { failures.push(`SSH ${name}: ${e.message}`); L('warn', `přes SSH ${name} se oprava nepovedla: ${e.message}`); }
      finally { try { cl.close(); } catch {} }
    }
  }

  // b)–d) ostatní kanály — nejdřív zjistit, co je na zařízení otevřené
  const ports = { api: 8728, 'api-ssl': 8729, www: 80, 'www-ssl': 443, telnet: 23 };
  const state = {};
  await Promise.all(Object.entries(ports).map(async ([k, p]) => { state[k] = await probe(creds.host, p, 4000).catch(() => 'error'); }));
  const open = Object.keys(ports).filter(k => state[k] === 'open');
  L('info', `otevřené služby na zařízení: ${open.length ? open.map(k => `${k} (${ports[k]})`).join(', ') : 'žádná z api/api-ssl/www/www-ssl/telnet'}`);

  const apiCmds = [['/ip/ssh/regenerate-host-key'], ['/system/reboot']];
  for (const k of ['api', 'api-ssl']) {
    if (state[k] !== 'open') { failures.push(`${k}: port ${ports[k]} ${state[k] === 'refused' ? 'odmítá (služba vypnutá)' : 'neodpovídá'}`); continue; }
    L('info', `zkouším RouterOS ${k} (port ${ports[k]})`);
    try {
      const tr = await api({ ...base, port: ports[k], ssl: k === 'api-ssl' }, apiCmds);
      L('info', `✔ přes ${k} proběhl regenerate-host-key i restart`);
      return { channel: `RouterOS ${k} (${ports[k]})`, transcript: tr };
    } catch (e) { failures.push(`${k}: ${e.message}`); L('warn', `${k} nejde: ${e.message}`); }
  }
  for (const k of ['www', 'www-ssl']) {
    if (state[k] !== 'open') { failures.push(`REST ${k}: port ${ports[k]} ${state[k] === 'refused' ? 'odmítá' : 'neodpovídá'}`); continue; }
    L('info', `zkouším REST API přes ${k} (port ${ports[k]}, jen RouterOS 7)`);
    try {
      const o = { ...base, port: ports[k], ssl: k === 'www-ssl', timeoutMs: 15000 };
      const r1 = await rest(o, 'ip/ssh/regenerate-host-key', {});
      if (r1.status === 404) throw new Error('REST není k dispozici (RouterOS 6 — Webfig bez REST)');
      if (r1.status === 401) throw new Error('REST odmítl přihlášení');
      if (r1.status < 200 || r1.status >= 300) throw new Error(`REST HTTP ${r1.status} ${r1.body.slice(0, 160)}`);
      L('info', `regenerate-host-key přes REST proběhl (HTTP ${r1.status}), posílám restart`);
      const r2 = await rest(o, 'system/reboot', {}).catch(() => ({ status: 0, body: '' })); // odpověď na reboot často nedojde
      L('info', `✔ přes REST (${k}) proběhl regenerate-host-key i restart${r2.status ? ` (HTTP ${r2.status})` : ''}`);
      return { channel: `REST ${k} (${ports[k]})`, transcript: `${r1.status} ${r1.body}\n${r2.status} ${r2.body}` };
    } catch (e) { failures.push(`REST ${k}: ${e.message}`); L('warn', `REST ${k} nejde: ${e.message}`); }
  }
  if (state.telnet === 'open') {
    L('info', 'zkouším telnet (port 23)');
    try {
      const tr = await telnet({ ...base, timeoutMs: 30000 }, ['/ip ssh regenerate-host-key', '/system reboot']);
      L('info', '✔ přes telnet proběhl regenerate-host-key i restart');
      return { channel: 'telnet (23)', transcript: tr };
    } catch (e) { failures.push(`telnet: ${e.message}`); L('warn', `telnet nejde: ${e.message}`); }
  } else failures.push(`telnet: port 23 ${state.telnet === 'refused' ? 'odmítá (služba vypnutá)' : 'neodpovídá'}`);

  throw new Error(`SSH klíč se nepodařilo přegenerovat žádnou cestou (${failures.join('; ')}). Ručně: přes Winbox/MAC-telnet spusť „/ip ssh regenerate-host-key“ a „/system reboot“, nebo na zařízení zapni /ip service api (8728) či telnet a spusť položku znovu`);
}

module.exports = { classifySshError, altHostKeySets, connectLegacy, regenerateHostKey, execConfirm, LEGACY_ALGORITHMS, sleep };
