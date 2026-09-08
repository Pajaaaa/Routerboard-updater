'use strict';
const db = require('./db');
/** návrh nadřazeného prvku z detekovaného uplinku (brána = host zařízení v seznamu, nebo shoda identity souseda) */
function suggestParent(dev, all) {
  // 1) bezdrátová stanice: rodič = zařízení, jehož rádio má MAC našeho AP (5 GHz registrace nebo 60 GHz protějšek)
  const radio = radioParent(dev, all);
  if (radio) return { ...radio, src: 'radio' };
  // 1b) napájení: zařízení, které nás vidí jako souseda na svém PoE portu (PoE switch / router s PoE-out) — fyzicky nadřazené
  // Na PoE portu bývá vidět víc sousedů (sektor + jeho stanice, spoj + jeho druhý konec + co je za ním). Napájený je jen ten první:
  // z kandidátů na portu se vyřadí ti, kdo jsou rádiovým potomkem jiného kandidáta, a když zbyde jediný a jsme to my → rodič.
  const idx = makeIndex(all);
  const devByKid = (kk) => (kk.address && idx.ip.get(kk.address)) || (kk.identity && (idx.identity.get(kk.identity) || [])[0]) || null;
  const hits = [...(idx.poeAddr.get(dev.host) || []), ...(dev.identity ? (idx.poeIdent.get(dev.identity) || []) : [])];
  const seenPoe = new Set();
  for (const { d, k } of hits) {
    if (d.id === dev.id || seenPoe.has(d.id)) continue; seenPoe.add(d.id);
    const kids = d.flags.poe_children || [];
    const onPort = kids.filter(x => x.iface === k.iface);
    let cands = []; const cset = new Set();
    for (const kk of onPort) { const x = devByKid(kk); if (x && x.id !== d.id && !cset.has(x.id)) { cset.add(x.id); cands.push(x); } }
    if (!cset.has(dev.id)) cands.push(dev);
    const ids = new Set(cands.map(x => x.id));
    cands = cands.filter(x => { const rp = radioParent(x, all); return !(rp && ids.has(rp.id)); });
    if (cands.length === 1 && cands[0].id === dev.id) return { id: d.id, name: d.name || d.identity || d.host, via: `PoE ${k.iface || ''}`.trim(), address: d.host, identity: d.identity || '', src: 'poe' };
  }
  // 2) CAP: rodič = CAPsMAN kontrolér podle adresy
  const cap = dev.flags && dev.flags.links && dev.flags.links.cap;
  if (cap && cap.manager) {
    const host = String(cap.manager).split(':')[0];
    const c0 = idx.ip.get(host); const c = c0 && c0.id !== dev.id ? c0 : null;
    if (c) return { id: c.id, name: c.name || c.identity || c.host, via: 'CAPsMAN', address: host, identity: c.identity || '', src: 'capsman' };
  }
  // 3) brána výchozí trasy
  const up = dev.flags && dev.flags.uplink;
  if (!up || !up.gateway) return null;
  const n = up.neighbor || { address: up.gateway, identity: '' };
  const g0 = idx.ip.get(up.gateway); const gwDev = g0 && g0.id !== dev.id ? g0 : null;
  const cand = gwDev || (n.identity ? (idx.identity.get(n.identity) || []).find(d => d.id !== dev.id) : null) || null;
  return cand ? { id: cand.id, name: cand.name || cand.identity || cand.host, via: up.iface, address: n.address, identity: n.identity, src: 'gateway' } : { id: 0, name: '', via: up.iface, address: n.address, identity: n.identity, src: 'gateway' };
}
const macOf = (x) => String(x || '').toUpperCase();
/**
 * Index nad seznamem zařízení pro rychlé dohledání (radio MAC → zařízení, MAC klienta → AP, SSID → AP). Staví se jednou
 * na dotaz (např. /api/state se stovkami zařízení) místo lineárního hledání pro každé zařízení zvlášť.
 */
function makeIndex(all) {
  if (all && all.__idx) return all.__idx;
  const radio = new Map(), client = new Map(), ssid = new Map();
  for (const d of all) {
    const l = d.flags && d.flags.links; if (!l) continue;
    for (const x of [...(l.aps || []), ...(l.w60g || []), ...(l.wifi || [])]) { const m = macOf(x.mac); if (m && !radio.has(m)) radio.set(m, d); }
    for (const a of [...(l.aps || []), ...(l.wifi || [])]) {
      for (const c of a.clients || []) { const m = macOf(c.mac); if (m && !client.has(m)) client.set(m, d); }
      if (/^ap/.test(a.mode || '') && a.ssid) { const arr = ssid.get(a.ssid) || []; arr.push(d); ssid.set(a.ssid, arr); }
    }
  }
  // adresy (host + všechny IP), identity a PoE děti (adresa/identita souseda na PoE portu → napájecí zařízení)
  const ip = new Map(), identity = new Map(), poeAddr = new Map(), poeIdent = new Map();
  for (const d of all) {
    for (const a of [d.host, ...((d.flags && Array.isArray(d.flags.ip_addresses)) ? d.flags.ip_addresses : [])]) if (a && !ip.has(a)) ip.set(a, d);
    if (d.identity) { const arr = identity.get(d.identity) || []; arr.push(d); identity.set(d.identity, arr); }
    for (const k of (d.flags && d.flags.poe_children) || []) {
      if (k.address) { const arr = poeAddr.get(k.address) || []; arr.push({ d, k }); poeAddr.set(k.address, arr); }
      if (k.identity) { const arr = poeIdent.get(k.identity) || []; arr.push({ d, k }); poeIdent.set(k.identity, arr); }
    }
  }
  const idx = { radio, client, ssid, ip, identity, poeAddr, poeIdent };
  try { Object.defineProperty(all, '__idx', { value: idx, enumerable: false }); } catch {}
  return idx;
}
function deviceByRadioMac(mac, all, exceptId) {
  const m = macOf(mac);
  if (!m) return null;
  const d = makeIndex(all).radio.get(m);
  return d && d.id !== exceptId ? d : null;
}
function deviceByClientMac(mac, all, exceptId) {
  const m = macOf(mac);
  if (!m) return null;
  const d = makeIndex(all).client.get(m);
  return d && d.id !== exceptId ? d : null;
}
/** stanice → AP podle MAC z registrace (wireless) nebo z 60 GHz monitoru (station-bridge) */
function radioParent(dev, all) {
  const l = dev.flags && dev.flags.links;
  if (!l) return null;
  for (const s of l.stations || []) {
    let ap = s.ap && s.ap.mac ? deviceByRadioMac(s.ap.mac, all, dev.id) : null;
    if (!ap && s.mac) ap = deviceByClientMac(s.mac, all, dev.id);
    if (ap) return { id: ap.id, name: ap.name || ap.identity || ap.host, via: `${s.iface} → AP`, address: (s.ap && s.ap.mac) || s.mac, identity: ap.identity || '' };
  }
  // wifi-qcom stanice: v registrační tabulce je jako jediný „klient“ samotné AP (peer); když AP MAC neznáme, zkusit, kdo nás má mezi klienty, nebo shodu SSID
  for (const w of l.wifi || []) {
    if (!/^station/.test(w.mode || '')) continue;
    const peer = (w.clients || [])[0];
    let ap = peer && peer.mac ? deviceByRadioMac(peer.mac, all, dev.id) : null;
    if (!ap && w.mac) ap = deviceByClientMac(w.mac, all, dev.id);
    if (!ap && w.ssid) { const c = (makeIndex(all).ssid.get(w.ssid) || []).filter(d => d.id !== dev.id); if (c.length === 1) ap = c[0]; }
    if (ap) return { id: ap.id, name: ap.name || ap.identity || ap.host, via: `${w.iface} → AP`, address: (peer && peer.mac) || w.ssid || '', identity: ap.identity || '' };
  }
  for (const w of l.w60g || []) {
    if (!/^station/.test(w.mode || '') || !w.remote) continue;
    const ap = deviceByRadioMac(w.remote, all, dev.id);
    if (ap) return { id: ap.id, name: ap.name || ap.identity || ap.host, via: `${w.iface} 60 GHz → AP`, address: w.remote, identity: ap.identity || '' };
  }
  return null;
}
/**
 * Automaticky nastaví rodiče, když chybí; vrací id rodiče nebo 0.
 * Rodič podle brány je jen slabý odhad (stanice bývá za sektorem, ne přímo za routerem) — když se později objeví rádiový
 * nebo CAPsMAN rodič (sektor naskenovaný až po stanici), nahradí ho. Ručně nastavený rodič (parent_src 'manual') se nemění.
 */
function autoParent(devId) {
  const dev = db.getDevice(devId);
  if (!dev) return 0;
  const all = db.listDevices().filter(d => !d.dup_of); // kandidáti napříč účty (síť je jedna: anténa jednoho správce na sektoru jiného); duplicity ne
  const sp = suggestParent(dev, all);
  if (!sp || !sp.id || sp.id === dev.parent_id || db.descendantIds(devId).includes(sp.id)) return 0;
  if (dev.parent_id) {
    if (dev.parent_src === 'manual' || sp.src === 'gateway') return 0;
    // stávající rodič je jen brána (explicitně, nebo u starších záznamů: rodič = zařízení s adresou brány) → povýšit na rádio/CAPsMAN
    const up = dev.flags && dev.flags.uplink;
    const n = up && (up.neighbor || {});
    const gwCand = up && up.gateway ? (all.find(d => d.id !== dev.id && (d.host === up.gateway || (d.flags && Array.isArray(d.flags.ip_addresses) && d.flags.ip_addresses.includes(up.gateway)))) || (n.identity ? all.find(d => d.id !== dev.id && d.identity === n.identity) : null)) : null;
    const weak = dev.parent_src === 'gateway' || (!dev.parent_src && gwCand && gwCand.id === dev.parent_id);
    if (!weak) return 0;
  }
  db.updateDevice(devId, { parent_id: sp.id, parent_src: sp.src || '' });
  return sp.id;
}
module.exports = { suggestParent, autoParent, radioParent, makeIndex };
