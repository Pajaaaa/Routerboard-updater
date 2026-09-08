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
  const match = (k, x) => (k.address && k.address === x.host) || (k.identity && x.identity && k.identity === x.identity);
  for (const d of all) {
    if (d.id === dev.id || !d.flags) continue;
    const kids = d.flags.poe_children || [];
    const k = kids.find(x => match(x, dev));
    if (!k) continue;
    const onPort = kids.filter(x => x.iface === k.iface);
    let cands = all.filter(x => x.id !== d.id && onPort.some(kk => match(kk, x)));
    if (!cands.some(x => x.id === dev.id)) cands.push(dev);
    const ids = new Set(cands.map(x => x.id));
    cands = cands.filter(x => { const rp = radioParent(x, all); return !(rp && ids.has(rp.id)); });
    if (cands.length === 1 && cands[0].id === dev.id) return { id: d.id, name: d.name || d.identity || d.host, via: `PoE ${k.iface || ''}`.trim(), address: d.host, identity: d.identity || '', src: 'poe' };
  }
  // 2) CAP: rodič = CAPsMAN kontrolér podle adresy
  const cap = dev.flags && dev.flags.links && dev.flags.links.cap;
  if (cap && cap.manager) {
    const host = String(cap.manager).split(':')[0];
    const c = all.find(d => d.id !== dev.id && d.host === host);
    if (c) return { id: c.id, name: c.name || c.identity || c.host, via: 'CAPsMAN', address: host, identity: c.identity || '', src: 'capsman' };
  }
  // 3) brána výchozí trasy
  const up = dev.flags && dev.flags.uplink;
  if (!up || !up.gateway) return null;
  const n = up.neighbor || { address: up.gateway, identity: '' };
  const hasIp = (d, ip) => d.host === ip || (d.flags && Array.isArray(d.flags.ip_addresses) && d.flags.ip_addresses.includes(ip));
  const cand = all.find(d => d.id !== dev.id && hasIp(d, up.gateway)) || (n.identity ? all.find(d => d.id !== dev.id && d.identity === n.identity) : null);
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
  const idx = { radio, client, ssid };
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
