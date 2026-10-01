'use strict';
/**
 * Klient RB-DB („RouterOS scanner“): nezávislý sken sítě přes web a SNMP, který drží tabulku všech nalezených RouterOS
 * (IP, verze, bridge/STP, jméno, naposledy viděno, způsob scanu). Nástroj z něj bere výpis kriticky neaktuálních kusů
 * a porovnává ho s vlastní evidencí: co v upgraderu chybí, jde přes userdb natáhnout i s loginy a poslat k upgradu.
 *
 * Nastavení (env): MTU_RBDB_URL = adresa výpisu (HTML stránka s jednou tabulkou; typicky filtr „kriticky neaktuální“).
 * Bez adresy je modul vypnutý (enabled() = false). MTU_RBDB_CACHE_MIN = keš výpisu v minutách (výchozí 10).
 * Stránka je obyčejné HTML (Bootstrap): v navigaci souhrn „N RB nalezeno, M kriticky neaktuální! (K na poslední verzi.)“
 * a tooltip „Aktuální verze: …“, v těle tabulka IP | verze ROS | bridge a STP | jméno routeru | naposledy viděno | způsob scanu.
 * Kódování stránky je smíšené (část záznamů není platné UTF-8) → dekóduje se tolerantně, vadné znaky se nahradí.
 */
const cfg = {
  url: (process.env.MTU_RBDB_URL || '').trim(),
  cacheMs: parseInt(process.env.MTU_RBDB_CACHE_MIN || '10', 10) * 60 * 1000,
  timeoutMs: 30000,
};

function enabled() { return !!cfg.url; }

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}
const text = s => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Rozebere HTML výpisu: { rows: [{ ip, version, stp, name, seen, how }], stats: { found, critical, latest, versions } } */
function parse(html) {
  const t = String(html).match(/<table[\s\S]*?<\/table>/i);
  if (!t) throw new Error('RB-DB: ve stránce není tabulka (změnil se formát?)');
  const rows = [];
  for (const tr of t[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => text(m[1]));
    if (cells.length < 2 || !/^\d+\.\d+\.\d+\.\d+$/.test(cells[0])) continue; // hlavička, prázdné řádky
    rows.push({ ip: cells[0], version: cells[1] || '', stp: cells[2] || '', name: cells[3] || '', seen: cells[4] || '', how: cells[5] || '' });
  }
  const stats = { found: 0, critical: 0, latest: 0, versions: '' };
  const m = text(html).match(/(\d+)\s*RB nalezeno,\s*(\d+)\s*kriticky[^(]*\((\d+)\s*na posledn/i);
  if (m) { stats.found = +m[1]; stats.critical = +m[2]; stats.latest = +m[3]; }
  const lv = String(html).match(/Aktu[^\s:]*\s*verze:\s*([^"<]+)/i);
  if (lv) stats.versions = text(lv[1]);
  return { rows, stats };
}

/** Stránka míchá UTF-8 a jednobajtové kódování (jména routerů zadaná ve Winboxu v cp1250): platné UTF-8 sekvence se vezmou
 * jak jsou, osamocené bajty nad 0x7F se přečtou jako windows-1250 — „Hor\xe1\x8dek“ dá Horáček místo náhradních znaků. */
function decodeMixed(buf) {
  const u8 = new TextDecoder('utf-8', { fatal: true }), cp = new TextDecoder('windows-1250');
  try { return u8.decode(buf); } catch {}
  let out = '', i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) { let j = i; while (j < buf.length && buf[j] < 0x80) j++; out += buf.toString('latin1', i, j); i = j; continue; }
    const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    if (len && i + len <= buf.length) { try { out += u8.decode(buf.subarray(i, i + len)); i += len; continue; } catch {} }
    out += cp.decode(buf.subarray(i, i + 1)); i++;
  }
  return out;
}

async function fetchHtml(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'mikrotik-upgrader/0.1', accept: 'text/html' } });
    if (!r.ok) throw new Error(`RB-DB: HTTP ${r.status}`);
    return decodeMixed(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('RB-DB: timeout');
    throw e;
  } finally { clearTimeout(timer); }
}

let cache = null; // { at, rows, stats }
/** Výpis z RB-DB (keš cacheMs; force = stáhnout znovu): { at, rows, stats } */
async function list(force) {
  if (!enabled()) throw new Error('napojení na RB-DB není nakonfigurováno (MTU_RBDB_URL)');
  if (!force && cache && Date.now() - cache.at < cfg.cacheMs) return cache;
  const html = await fetchHtml(cfg.url);
  const r = parse(html);
  cache = { at: Date.now(), ...r };
  return cache;
}

module.exports = { enabled, list, parse, decodeMixed, cfg };
