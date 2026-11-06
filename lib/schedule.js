'use strict';
/**
 * Pořadí a souběh uvnitř jobu (6.11.2026). Dřív se velký výběr dělil na dávky po N, které běžely vedle sebe jako samostatné joby:
 * páteř startovala ve stejnou chvíli jako koncové kusy, fyzický zámek pak všechno zase serializoval s hodinovými čekáními
 * (noc 5./6.11.: 82 čekání na zámek, 30× hodinový timeout, Na Kotli kruh ROUTER→SWITCH→sektor→ROUTER) a switche/spoje, které
 * topologie v DB nezná, shazovaly rozpracované kusy (MalhotaA-CRS, vnl1-vnl2: 7× EHOSTUNREACH).
 *
 * Teď: jeden job, K pracovníků nad společnou frontou, další položka se vybírá podle závislostí. Kusy mají tři třídy podle skenu:
 *   leaf   — koncový kus člena (userdb_member) bez potomků v DB: jedou souběžně, nejdřív
 *   sector — AP s klienty (sektor): jede, až jsou jeho potomci v jobu hotoví; souběžně s jinými sektory
 *   infra  — všechno ostatní (switche, routery, 60 GHz a PtP spoje, stanice bez člena, kusy s potomky bez AP): VÝHRADNĚ —
 *            jeden po druhém, teprve když v jobu nic jiného neběží a žádný leaf/sector už nečeká. Restart switche nebo spoje tak
 *            nikdy netrefí rozpracovaný kus, i když ho topologie nezná. Pořadí infra: hloubka v DB, pak „kdo mě vidí na uplinku,
 *            jde přede mnou“ (uplink.neighbor ze skenu), pak pořadí v jobu.
 * Navíc se žádná položka nespustí, dokud se zpracovává (kdekoli, i v cizím jobu) její předek/potomek nebo fyzický soused —
 * zámek se tak uplatní už při startu položky, ne až před restartem.
 */
const db = require('./db');

const ACTIVE = new Set(['checking', 'backup', 'upload', 'reboot', 'verify', 'firmware', 'running']);
const CLASS_LABEL = { leaf: 'koncový kus', sector: 'sektor', infra: 'infrastruktura' };

function flagsOf(raw) { try { return JSON.parse(raw.flags || '{}'); } catch { return {}; } }

/** třída kusu pro plánování: leaf | sector | infra (viz hlavička) */
function classify(raw, kidsCount) {
  if (!raw) return 'infra';
  const f = flagsOf(raw); const lk = f.links || {};
  const kids = kidsCount === undefined ? db.children(raw.id).length : kidsCount;
  const member = Number(raw.userdb_member) > 0;
  const aps = (lk.aps || []).length + (lk.wifi || []).length;
  const w60 = (lk.w60g || []).length > 0 || Number(f.w60g) > 0;
  if (member && !kids) return 'leaf';
  if (aps && !w60) return 'sector';
  return 'infra';
}

/** mapa device_id → třída pro položky jobu (počítá se jednou při startu jobu) */
function classMap(items) {
  const m = new Map();
  for (const it of items) { if (!m.has(it.device_id)) m.set(it.device_id, classify(db.getDeviceRaw(it.device_id))); }
  return m;
}

function describe(classes) {
  const n = { leaf: 0, sector: 0, infra: 0 };
  for (const c of classes.values()) n[c] = (n[c] || 0) + 1;
  return `${n.leaf} koncových kusů souběžně, pak ${n.sector} sektorů (každý až po svých klientech), nakonec ${n.infra} kusů infrastruktury jeden po druhém (switche, routery, spoje — nic jiného v tu chvíli neběží)`;
}

const ipsOf = (raw) => { const f = flagsOf(raw); return [raw.host, ...(Array.isArray(f.ip_addresses) ? f.ip_addresses : [])].filter(Boolean); };
/** a vidí b jako souseda na svém uplinku → a je pod b (b jde až po a) */
function seesOnUplink(a, b) {
  const n = flagsOf(a).uplink && flagsOf(a).uplink.neighbor;
  return !!(n && n.address && ipsOf(b).includes(n.address));
}

/**
 * Další položka pro pracovníka.
 *  items  — db.getJobItems(jobId) (všechny položky jobu)
 *  ctx.classOf(deviceId) → třída; ctx.onlyCanary — fáze kanárků; ctx.conflict(item) → popis rozpracovaného předka/potomka/souseda (kdekoli) nebo null
 * Vrací { item } nebo { item: null, waiting: [důvody], blockedItems: [položky, jejichž potomek selhal] }.
 */
function pickNext(items, ctx = {}) {
  const classOf = ctx.classOf || (() => 'infra');
  const byDev = new Map(items.map(i => [i.device_id, i]));
  const active = items.filter(i => ACTIVE.has(i.status));
  const activeInfra = active.some(i => classOf(i.device_id) === 'infra');
  const isCanary = (i) => !!(i.plan && i.plan.canary);
  // fáze kanárků: nekanárčí položky nikoho nezdržují (nejsou rozpracované, restart jim neublíží) — jinak by kanárek nad nimi nikdy nepřišel na řadu
  const pendingNonInfra = items.filter(i => i.status === 'pending' && classOf(i.device_id) !== 'infra' && (!ctx.onlyCanary || isCanary(i)));
  const waiting = [], blockedItems = [], ready = [];
  const label = (it) => it.dev_name || it.identity || it.host || ('#' + it.device_id);
  for (const it of items) {
    if (it.status !== 'pending') continue;
    if (ctx.onlyCanary && !isCanary(it)) continue;
    const cls = classOf(it.device_id);
    const desc = db.descendantIds(it.device_id).map(id => byDev.get(id)).filter(Boolean);
    if (desc.some(d => ACTIVE.has(d.status) || (d.status === 'pending' && (!ctx.onlyCanary || isCanary(d))))) continue; // potomci napřed
    // selhaný/neznámý potomek blokuje rodiče — kromě kusu, kterého se upgrade ani nedotkl (nedostupný už při připojení: nic na něm není rozpracované)
    const bad = desc.filter(d => ['failed', 'unknown'].includes(d.status) && !(d.result && d.result.untouched));
    if (bad.length) { it.blockReason = `potomek ${bad.map(label).join(', ')} skončil chybou/neznámým stavem — nadřazený prvek se nerestartuje`; blockedItems.push(it); continue; }
    if (cls === 'infra') {
      if (active.length) { waiting.push(`${label(it)} (infrastruktura) čeká, až v jobu nic jiného neběží`); continue; }
      // zbylé koncové kusy a sektory jdou napřed — kromě vlastních předků (stanice bez člena pod sektorem: sektor čeká na ni, ne naopak)
      const anc = new Set(db.ancestorIds(it.device_id));
      const rest = pendingNonInfra.filter(x => x.id !== it.id && !anc.has(x.device_id));
      if (rest.length) { waiting.push(`${label(it)} (infrastruktura) čeká na zbylé koncové kusy a sektory (${rest.length})`); continue; }
    } else if (activeInfra) { waiting.push(`${label(it)} čeká, až doběhne restart infrastruktury`); continue; }
    ready.push({ it, cls, depth: db.ancestorIds(it.device_id).length });
  }
  if (!ready.length) return { item: null, waiting, blockedItems };
  ready.sort((a, b) => {
    if (a.cls === 'infra' && b.cls === 'infra') {
      const ra = db.getDeviceRaw(a.it.device_id), rb = db.getDeviceRaw(b.it.device_id);
      if (ra && rb) { if (seesOnUplink(ra, rb) && !seesOnUplink(rb, ra)) return -1; if (seesOnUplink(rb, ra) && !seesOnUplink(ra, rb)) return 1; }
    }
    return (b.depth - a.depth) || ((a.it.ord || 0) - (b.it.ord || 0)) || (a.it.id - b.it.id);
  });
  // konflikt s rozpracovaným předkem/potomkem/sousedem (kdekoli na serveru) se zkouší až od nejlepšího kandidáta — bere se první bez konfliktu
  for (const r of ready) {
    const c = ctx.conflict ? ctx.conflict(r.it) : null;
    if (c) { waiting.push(`${label(r.it)} čeká na ${c}`); continue; }
    return { item: r.it, waiting, blockedItems };
  }
  return { item: null, waiting, blockedItems };
}

module.exports = { ACTIVE, CLASS_LABEL, classify, classMap, describe, pickNext, seesOnUplink };
