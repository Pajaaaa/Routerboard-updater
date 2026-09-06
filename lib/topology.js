'use strict';
const db = require('./db');
/** návrh nadřazeného prvku z detekovaného uplinku (brána = host zařízení v seznamu, nebo shoda identity souseda) */
function suggestParent(dev, all) {
  // 1) bezdrátová stanice: rodič = zařízení, jehož rádio má MAC našeho AP (5 GHz registrace nebo 60 GHz protějšek)
  const radio = radioParent(dev, all);
  if (radio) return radio;
  // 2) CAP: rodič = CAPsMAN kontrolér podle adresy
  const cap = dev.flags && dev.flags.links && dev.flags.links.cap;
  if (cap && cap.manager) {
    const host = String(cap.manager).split(':')[0];
    const c = all.find(d => d.id !== dev.id && d.host === host);
    if (c) return { id: c.id, name: c.name || c.identity || c.host, via: 'CAPsMAN', address: host, identity: c.identity || '' };
  }
  // 3) brána výchozí trasy
  const up = dev.flags && dev.flags.uplink;
  if (!up || !up.gateway) return null;
  const n = up.neighbor || { address: up.gateway, identity: '' };
  const cand = all.find(d => d.id !== dev.id && d.host === up.gateway) || (n.identity ? all.find(d => d.id !== dev.id && d.identity === n.identity) : null);
  return cand ? { id: cand.id, name: cand.name || cand.identity || cand.host, via: up.iface, address: n.address, identity: n.identity } : { id: 0, name: '', via: up.iface, address: n.address, identity: n.identity };
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
/** automaticky nastaví rodiče, když chybí a návrh je jednoznačný; vrací id rodiče nebo 0 */
function autoParent(devId) {
  const dev = db.getDevice(devId);
  if (!dev || dev.parent_id) return 0;
  const all = db.listDevices(dev.owner_id || undefined);
  const sp = suggestParent(dev, all);
  if (!sp || !sp.id || db.descendantIds(devId).includes(sp.id)) return 0;
  db.updateDevice(devId, { parent_id: sp.id });
  return sp.id;
}
module.exports = { suggestParent, autoParent, radioParent };
