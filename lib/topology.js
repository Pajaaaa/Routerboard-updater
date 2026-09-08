'use strict';
const db = require('./db');
/** návrh nadřazeného prvku z detekovaného uplinku (brána = host zařízení v seznamu, nebo shoda identity souseda) */
function suggestParent(dev, all) {
  // 1) bezdrátová stanice: rodič = zařízení, jehož rádio má MAC našeho AP (5 GHz registrace nebo 60 GHz protějšek)
  const radio = radioParent(dev, all);
  if (radio) return { ...radio, src: 'radio' };
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
  const cand = all.find(d => d.id !== dev.id && d.host === up.gateway) || (n.identity ? all.find(d => d.id !== dev.id && d.identity === n.identity) : null);
  return cand ? { id: cand.id, name: cand.name || cand.identity || cand.host, via: up.iface, address: n.address, identity: n.identity, src: 'gateway' } : { id: 0, name: '', via: up.iface, address: n.address, identity: n.identity, src: 'gateway' };
}
const macOf = (x) => String(x || '').toUpperCase();
function deviceByRadioMac(mac, all, exceptId) {
  const m = macOf(mac);
  if (!m) return null;
  return all.find(d => d.id !== exceptId && d.flags && d.flags.links && [...(d.flags.links.aps || []), ...(d.flags.links.w60g || []), ...(d.flags.links.wifi || [])].some(x => macOf(x.mac) === m)) || null;
}
/** stanice → AP podle MAC z registrace (wireless) nebo z 60 GHz monitoru (station-bridge) */
function radioParent(dev, all) {
  const l = dev.flags && dev.flags.links;
  if (!l) return null;
  for (const s of l.stations || []) {
    if (!s.ap || !s.ap.mac) continue;
    const ap = deviceByRadioMac(s.ap.mac, all, dev.id);
    if (ap) return { id: ap.id, name: ap.name || ap.identity || ap.host, via: `${s.iface} → AP`, address: s.ap.mac, identity: ap.identity || '' };
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
  const all = db.listDevices(dev.owner_id || undefined);
  const sp = suggestParent(dev, all);
  if (!sp || !sp.id || sp.id === dev.parent_id || db.descendantIds(devId).includes(sp.id)) return 0;
  if (dev.parent_id) {
    if (dev.parent_src === 'manual' || sp.src === 'gateway') return 0;
    // stávající rodič je jen brána (explicitně, nebo u starších záznamů: rodič = zařízení s adresou brány) → povýšit na rádio/CAPsMAN
    const up = dev.flags && dev.flags.uplink;
    const n = up && (up.neighbor || {});
    const gwCand = up && up.gateway ? (all.find(d => d.id !== dev.id && d.host === up.gateway) || (n.identity ? all.find(d => d.id !== dev.id && d.identity === n.identity) : null)) : null;
    const weak = dev.parent_src === 'gateway' || (!dev.parent_src && gwCand && gwCand.id === dev.parent_id);
    if (!weak) return 0;
  }
  db.updateDevice(devId, { parent_id: sp.id, parent_src: sp.src || '' });
  return sp.id;
}
module.exports = { suggestParent, autoParent, radioParent };
