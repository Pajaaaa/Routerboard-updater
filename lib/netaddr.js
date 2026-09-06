'use strict';
// Kontrola, zda IP adresa spadá do seznamu CIDR/adres (IPv4 i IPv6) — používá se, aby si nástroj
// omezením /ip service address sám nezavřel SSH přístup.
const net = require('net');

function v4ToBig(ip) { return ip.split('.').reduce((a, o) => (a << 8n) + BigInt(parseInt(o, 10)), 0n); }
function v6ToBig(ip) {
  let s = ip;
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  const m4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4
  if (m4) { const n = v4ToBig(m4[2]); s = m4[1] + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16); }
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}
function toBig(ip) {
  if (net.isIPv4(ip)) return { n: v4ToBig(ip), bits: 32 };
  if (net.isIPv6(ip)) {
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return { n: v4ToBig(ip.slice(7)), bits: 32 }; // IPv4-mapped: posuzovat jako IPv4
    return { n: v6ToBig(ip), bits: 128 };
  }
  return null;
}

/** true, když `ip` spadá do některé položky seznamu (čárkou; "10.0.0.0/8", "1.2.3.4", "2a01::/29"). Neplatné položky se přeskočí. */
function ipInList(ip, list) {
  const a = toBig(String(ip || '').trim());
  if (!a) return false;
  for (const raw of String(list || '').split(/[\s,;]+/)) {
    if (!raw) continue;
    const [addr, plen] = raw.split('/');
    const b = toBig(addr);
    if (!b || b.bits !== a.bits) continue;
    const p = plen === undefined ? b.bits : parseInt(plen, 10);
    if (!Number.isFinite(p) || p < 0 || p > b.bits) continue;
    const shift = BigInt(b.bits - p);
    if ((a.n >> shift) === (b.n >> shift)) return true;
  }
  return false;
}

module.exports = { ipInList };
