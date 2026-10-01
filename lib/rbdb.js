'use strict';
/**
 * Klient RB-DB / RBDB² („RouterOS scanner“): nezávislý sken sítě přes SNMP, SSH a sousedy (MNDP), který drží seznam všech
 * nalezených RouterOS (IP, verze, jméno, S/N a licence, naposledy viděno, kde viděno, stav verze). Nástroj z něj bere kusy
 * označené jako napadnutelné (version_status=danger) a porovnává je s vlastní evidencí: co v upgraderu chybí, jde přes userdb
 * natáhnout i s loginy a poslat k upgradu.
 *
 * Nastavení (env): MTU_RBDB_URL = adresa JSON API RBDB² (…/api/devices — bere se celý seznam, stav se pozná z version_status),
 * případně HTML stránka s tabulkou (starý RB-DB nebo RBDB² s filtrem) — rozhodne content-type odpovědi. Bez adresy je modul
 * vypnutý (enabled() = false). MTU_RBDB_CACHE_MIN = keš výpisu v minutách (výchozí 10).
 * JSON položka: { ip, duplicate_ips:["ip"] (dřív [{ip}]), ros_version, router_name, serial_number, license_id, last_seen (unix s,
 *   dřív text), last_seen_snmp/ssh/neighbors, seen_via:[snmp|ssh|neighbors], credentials_wrong, version_status: vulnerable|up_to_date|unknown
 *   (dřív danger|success|null) }. API se ještě vyvíjí → obě podoby se berou, stav se normalizuje na danger/success/''.
 * HTML: v navigaci souhrn „N RB nalezeno, M napadnutelných/kriticky neaktuálních …“, v těle tabulka se sloupci podle hlavičky.
 * SwOS (switche) scanner od RouterOS neodlišuje: verze 1.x/2.x viděná jen přes sousedy → swos=true (bez SSH, upgrader je neřeší).
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

/** Rozebere HTML výpisu: { rows: [{ ip, dups, version, name, serial, license, stp, seen, how }], stats: { found, critical, latest, queue, versions } }.
 * Sloupce se poznávají podle hlavičky (ip, verze, jméno, sériové číslo / licence, bridge a STP, naposledy viděno, kde/způsob viděno),
 * takže parser zvládne starý RB-DB i RBDB² — tam má buňka IP pod sebou další adresy téhož routeru (duplicity) a „kde viděno“ jsou štítky. */
function parse(html) {
  const t = String(html).match(/<table[\s\S]*?<\/table>/i);
  if (!t) throw new Error('RB-DB: ve stránce není tabulka (změnil se formát?)');
  const trs = t[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const cellsOf = tr => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1]);
  // mapa sloupců z hlavičky; bez hlavičky staré pořadí (IP, verze, STP, jméno, viděno, způsob)
  let col = { ip: 0, version: 1, stp: 2, name: 3, seen: 4, how: 5 };
  const head = trs.find(tr => /<th/i.test(tr));
  if (head) {
    col = {};
    cellsOf(head).map(text).forEach((h, i) => {
      const k = h.toLowerCase();
      if (/^ip/.test(k)) col.ip = i; else if (/verze/.test(k)) col.version = i; else if (/stp|bridge/.test(k)) col.stp = i;
      else if (/jm[ée]no|n[áa]zev/.test(k)) col.name = i; else if (/s[ée]riov|licence/.test(k)) col.serial = i;
      else if (/kde|zp[ůu]sob|scan/.test(k)) col.how = i; else if (/vid[ěe]no|naposledy/.test(k)) col.seen = i; // „kde viděno“ dřív než „naposledy viděno“
    });
    if (col.ip == null) col.ip = 0;
  }
  const pick = (cells, k) => (col[k] == null ? '' : text(cells[col[k]] || ''));
  const rows = [];
  for (const tr of trs) {
    if (/<th/i.test(tr)) continue;
    const cells = cellsOf(tr);
    if (cells.length < 2) continue;
    const ipCell = cells[col.ip] || '';
    const ips = text(ipCell).match(/\d+\.\d+\.\d+\.\d+/g) || [];
    if (!ips.length) continue;
    const sl = pick(cells, 'serial').split('/').map(x => x.trim()).filter(Boolean);
    const how = col.how == null ? '' : ([...(cells[col.how] || '').matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map(m => text(m[1])).filter(Boolean).join(', ') || pick(cells, 'how'));
    rows.push({ ip: ips[0], dups: ips.slice(1), version: pick(cells, 'version'), name: pick(cells, 'name'),
      serial: sl.length > 1 ? sl[0] : (sl[0] && /^[0-9A-F]{12}$/i.test(sl[0]) ? sl[0] : ''), license: sl.length > 1 ? sl[1] : (sl[0] && !/^[0-9A-F]{12}$/i.test(sl[0]) ? sl[0] : ''),
      stp: pick(cells, 'stp'), seen: pick(cells, 'seen'), how });
  }
  const stats = { found: 0, critical: 0, latest: 0, queue: 0, versions: '' };
  const plain = text(html);
  const m = plain.match(/(\d+)\s*RB nalezeno,\s*(\d+)\s*(?:kriticky|napadnuteln)[^(\d]*(?:\()?(\d+)\s*na posledn/i);
  if (m) { stats.found = +m[1]; stats.critical = +m[2]; stats.latest = +m[3]; }
  const q = plain.match(/Ve front[ěe]:\s*(\d+)/i); if (q) stats.queue = +q[1];
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

/** Rozpozná SwOS: verze 1.x/2.x (RouterOS má 6/7) — switche bez SSH, scanner je vidí jen přes sousedy nebo SNMP */
const isSwos = (version) => /^[12]\.\d/.test(String(version || '').trim());

/** stav verze z API → danger (napadnutelný) / success (aktuální) / '' (neznámý) */
function normStatus(v) { const k = String(v == null ? '' : v).toLowerCase(); return /danger|vulnerab/.test(k) ? 'danger' : /success|up_to_date|ok|latest/.test(k) ? 'success' : ''; }
/** „naposledy viděno“: unix sekundy (nebo ms) → datum česky; text zůstane */
function seenText(v) { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v).trim(); const d = new Date(n > 1e12 ? n : n * 1000); return isNaN(d) ? String(v) : d.toLocaleDateString('cs-CZ'); }
/** Položky JSON API RBDB² → jednotné řádky (stejná pole jako z HTML + status a swos) */
function fromApi(items) {
  const rows = [];
  for (const d of Array.isArray(items) ? items : []) {
    const ip = String(d.ip || '').trim(); if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const version = String(d.ros_version || '').trim();
    const how = [...(Array.isArray(d.seen_via) ? d.seen_via : [])].map(String); if (d.credentials_wrong) how.push('bez loginu');
    rows.push({ ip, dups: (Array.isArray(d.duplicate_ips) ? d.duplicate_ips : []).map(x => String(x && x.ip || x || '')).filter(x => /^\d+\.\d+\.\d+\.\d+$/.test(x)),
      version, name: String(d.router_name || '').trim(), serial: String(d.serial_number || '').trim(), license: String(d.license_id || '').trim(),
      stp: '', seen: seenText(d.last_seen), how: how.join(', '), status: normStatus(d.version_status), swos: isSwos(version) });
  }
  const stats = { found: rows.length, critical: rows.filter(x => x.status === 'danger').length, latest: rows.filter(x => x.status === 'success').length, queue: 0, versions: '' };
  return { rows, stats };
}

async function fetchList(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'mikrotik-upgrader/0.1', accept: 'application/json, text/html' } });
    if (!r.ok) throw new Error(`RB-DB: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = String(r.headers.get('content-type') || '');
    if (/json/i.test(ct) || /^\s*[[{]/.test(buf.subarray(0, 64).toString('utf8'))) {
      let j; try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error('RB-DB: odpověď API není platný JSON'); }
      return { ...fromApi(Array.isArray(j) ? j : (j && (j.devices || j.items || j.data)) || []), api: true };
    }
    const r2 = parse(decodeMixed(buf));
    r2.rows.forEach(x => { x.status = 'danger'; x.swos = isSwos(x.version); }); // HTML výpis = jen filtrované (napadnutelné) kusy
    return { ...r2, api: false };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('RB-DB: timeout');
    throw e;
  } finally { clearTimeout(timer); }
}

let cache = null; // { at, rows, stats, api }
/** Výpis z RB-DB (keš cacheMs; force = stáhnout znovu): { at, rows, stats, api }. rows = jen napadnutelné kusy (status danger),
 * all = celý seznam (z JSON API; z HTML stejné jako rows) */
async function list(force) {
  if (!enabled()) throw new Error('napojení na RB-DB není nakonfigurováno (MTU_RBDB_URL)');
  if (!force && cache && Date.now() - cache.at < cfg.cacheMs) return cache;
  const r = await fetchList(cfg.url);
  cache = { at: Date.now(), stats: r.stats, api: r.api, all: r.rows, rows: r.rows.filter(x => x.status === 'danger') };
  return cache;
}
/** adresa stránky pro lidi (z adresy API …/api/devices → stránka s filtrem napadnutelných) */
function pageUrl() { return cfg.url.replace(/\/?api\/devices\/?(\?.*)?$/, '/?filter=vulnerable'); }

module.exports = { enabled, list, parse, fromApi, decodeMixed, isSwos, pageUrl, cfg };
