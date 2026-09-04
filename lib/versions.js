'use strict';
// Verze RouterOS z upgrade.mikrotik.com + katalog a cache balíčků z download.mikrotik.com
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const UPGRADE_BASE = 'https://upgrade.mikrotik.com/routeros/';
const DOWNLOAD_BASE = 'https://download.mikrotik.com/routeros/';

// architektury, pro které existuje RouterOS v7 / v6
const ARCH_V7 = ['arm', 'arm64', 'mipsbe', 'mmips', 'smips', 'tile', 'ppc', 'x86'];
const ARCH_V6 = ['arm', 'arm64', 'mipsbe', 'mmips', 'smips', 'tile', 'ppc', 'x86'];

// v6 sub-balíčky, které jsou ve v7 součástí bundle "routeros" (při hopu 6->7 se neinstalují zvlášť)
const V6_IN_V7_BUNDLE = new Set(['system', 'routeros', 'ipv6', 'hotspot', 'ppp', 'dhcp', 'security', 'advanced-tools', 'multicast', 'mpls', 'routing', 'ntp', 'wireless-fp', 'wireless-cm2', 'wireless-rep']);
// v6 balíčky, které ve v7 už neexistují (upgrade je zahodí — jen varování)
const V6_DROPPED_IN_V7 = new Set(['openflow', 'kvm']);
// balíčky, které lze ve v7 instalovat zvlášť (název stejný v6 -> v7)
const V7_EXTRA = new Set(['wireless', 'wifi-qcom', 'wifi-qcom-ac', 'container', 'dude', 'user-manager', 'calea', 'gps', 'lora', 'iot', 'ups', 'tr069-client', 'zerotier', 'rose-storage', 'extra-cli-ncurses']);

function parseVersion(s) {
  if (!s) return null;
  const str = String(s).trim().split(/\s+/)[0];
  const m = str.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:(beta|rc|alpha)(\d*))?$/i);
  if (!m) return null;
  return {
    str,
    major: +m[1], minor: +m[2], patch: m[3] ? +m[3] : 0,
    pre: m[4] ? m[4].toLowerCase() : null, preN: m[5] ? +m[5] : 0,
  };
}
const PRE_RANK = { alpha: 0, beta: 1, rc: 2 };
function cmpVersion(a, b) {
  const A = typeof a === 'string' ? parseVersion(a) : a;
  const B = typeof b === 'string' ? parseVersion(b) : b;
  if (!A || !B) return NaN;
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] - B[k];
  const pa = A.pre ? PRE_RANK[A.pre] : 9, pb = B.pre ? PRE_RANK[B.pre] : 9;
  if (pa !== pb) return pa - pb;
  return (A.preN || 0) - (B.preN || 0);
}

// ---------- nejnovější verze ----------
const CHANNELS = {
  'v7-stable': 'NEWESTa7.stable',
  'v7-long-term': 'NEWESTa7.long-term',
  'v7-testing': 'NEWESTa7.testing',
  'v6-long-term': 'NEWEST6.long-term',
  'v6-stable': 'NEWEST6.stable',
  'v6-upgrade': 'NEWEST6.upgrade',   // co nabízí v6 zařízením kanál "upgrade" (zastaralá 7.12.x)
};
let latestCache = { fetchedAt: 0, versions: {}, error: '' };

async function fetchText(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'mikrotik-upgrader/0.1' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function refreshLatest(force = false) {
  if (!force && Date.now() - latestCache.fetchedAt < 30 * 60e3 && Object.keys(latestCache.versions).length) return latestCache;
  const versions = {};
  let error = '';
  for (const [track, file] of Object.entries(CHANNELS)) {
    try {
      const txt = (await fetchText(UPGRADE_BASE + file)).trim();
      const [ver, ts] = txt.split(/\s+/);
      if (!parseVersion(ver)) throw new Error('nečitelná odpověď: ' + txt.slice(0, 40));
      versions[track] = { version: ver, releasedAt: ts ? +ts : 0 };
    } catch (e) {
      error += `${track}: ${e.message}; `;
      if (latestCache.versions[track]) versions[track] = latestCache.versions[track];
    }
  }
  latestCache = { fetchedAt: Date.now(), versions, error: error.trim() };
  return latestCache;
}
function getLatest() { return latestCache; }

const changelogCache = new Map();
async function getChangelog(version) {
  if (changelogCache.has(version)) return changelogCache.get(version);
  try {
    const t = await fetchText(DOWNLOAD_BASE + version + '/CHANGELOG');
    changelogCache.set(version, t);
    return t;
  } catch (e) { return 'Changelog nedostupný: ' + e.message; }
}

// ---------- balíčky ----------
function packageFileName(pkg, version, arch) {
  const v = parseVersion(version);
  if (!v) throw new Error('neplatná verze ' + version);
  if (v.major >= 7) {
    return arch === 'x86' ? `${pkg}-${version}.npk` : `${pkg}-${version}-${arch}.npk`;
  }
  // v6: bundle má formát routeros-<arch>-<ver>, ostatní <pkg>-<ver>-<arch>
  if (pkg === 'routeros') return `routeros-${arch}-${version}.npk`;
  return `${pkg}-${version}-${arch}.npk`;
}
function packageUrl(pkg, version, arch) {
  return DOWNLOAD_BASE + version + '/' + packageFileName(pkg, version, arch);
}

const headCache = new Map();
/** HEAD na balíček: {exists, size} */
async function packageInfo(pkg, version, arch) {
  const url = packageUrl(pkg, version, arch);
  if (headCache.has(url)) return headCache.get(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  let info;
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ac.signal });
    info = { url, file: packageFileName(pkg, version, arch), exists: r.ok, size: r.ok ? parseInt(r.headers.get('content-length') || '0', 10) : 0 };
  } catch (e) {
    throw new Error(`nelze ověřit balíček ${url}: ${e.message}`);
  } finally { clearTimeout(t); }
  if (info.exists && info.size > 0) headCache.set(url, info);
  return info;
}

const downloads = new Map();
/** Stáhne balíček do cache (data/pkg/<ver>/<file>), ověří velikost. Vrací lokální cestu. */
async function ensurePackage(pkg, version, arch, log) {
  const info = await packageInfo(pkg, version, arch);
  if (!info.exists) throw new Error(`balíček ${info.file} na download.mikrotik.com neexistuje`);
  const dir = path.join(cfg.pkgDir, version);
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, info.file);
  if (fs.existsSync(local) && fs.statSync(local).size === info.size) return { local, size: info.size, file: info.file };
  if (downloads.has(local)) { await downloads.get(local); return { local, size: info.size, file: info.file }; }
  const p = (async () => {
    log && log(`stahuji ${info.file} (${(info.size / 1048576).toFixed(1)} MB) z download.mikrotik.com`);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10 * 60e3);
    try {
      const r = await fetch(info.url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== info.size) throw new Error(`velikost nesedí: staženo ${buf.length}, očekáváno ${info.size}`);
      const tmp = local + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, local);
    } finally { clearTimeout(t); }
  })();
  downloads.set(local, p);
  try { await p; } finally { downloads.delete(local); }
  return { local, size: info.size, file: info.file };
}

module.exports = {
  ARCH_V6, ARCH_V7, V6_IN_V7_BUNDLE, V6_DROPPED_IN_V7, V7_EXTRA, CHANNELS,
  parseVersion, cmpVersion, refreshLatest, getLatest, getChangelog,
  packageFileName, packageUrl, packageInfo, ensurePackage,
};
