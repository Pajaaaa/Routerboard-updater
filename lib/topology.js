'use strict';
const db = require('./db');
/** návrh nadřazeného prvku z detekovaného uplinku (brána = host zařízení v seznamu, nebo shoda identity souseda) */
function suggestParent(dev, all) {
  const up = dev.flags && dev.flags.uplink;
  if (!up || !up.gateway) return null;
  const n = up.neighbor || { address: up.gateway, identity: '' };
  const cand = all.find(d => d.id !== dev.id && d.host === up.gateway) || (n.identity ? all.find(d => d.id !== dev.id && d.identity === n.identity) : null);
  return cand ? { id: cand.id, name: cand.name || cand.identity || cand.host, via: up.iface, address: n.address, identity: n.identity } : { id: 0, name: '', via: up.iface, address: n.address, identity: n.identity };
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
module.exports = { suggestParent, autoParent };
