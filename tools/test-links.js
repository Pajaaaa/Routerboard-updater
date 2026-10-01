'use strict';
// lib/links.js: párování antény a sektoru přes MAC, obě strany, klient mimo upgrader, 60 GHz jednou za dvojici, nespojená stanice, prahy
const assert = require('assert');
const { buildLinks } = require('../lib/links');
const dev = (id, links, extra = {}) => ({ id, host: `10.0.0.${id}`, identity: `d${id}`, name: '', managed: true, dup_of: 0, owner_id: 1, last_scan_at: 1000 + id, flags: { links }, ...extra });
const devices = [
  dev(1, { stations: [], aps: [{ iface: 'wlan2', mac: 'AA:00:00:00:00:01', ssid: 'hk', band: '5ghz-a/n', clients: [{ mac: 'BB:00:00:00:00:02', signal: -79, ccq: 55, uptime: '1d' }, { mac: 'CC:00:00:00:00:99', signal: -70, ccq: 90, uptime: '2h', version: '6.49.10' }] }], wifi: [], w60g: [{ iface: 'wlan60-1', mac: 'DD:00:00:00:00:01', mode: 'ap-bridge', running: true, connected: true, remote: 'DD:00:00:00:00:03', mcs: 8, rssi: 60, per: 0.1, stations: [{ mac: 'DD:00:00:00:00:03', mcs: 8, rssi: 60, signal: 80, per: 0.1 }] }] }),
  dev(2, { stations: [{ iface: 'wlan1', mac: 'BB:00:00:00:00:02', mode: 'station-bridge', ssid: 'hk', running: true, ap: { mac: 'aa:00:00:00:00:01', signal: -81, ccq: 40, uptime: '1d', version: '7.24.2' } }], aps: [], wifi: [], w60g: [] }),
  dev(3, { stations: [{ iface: 'wlan1', mac: 'BB:00:00:00:00:03', mode: 'station', ssid: 'x', running: true, ap: null }], aps: [], wifi: [], w60g: [{ iface: 'wlan60-1', mac: 'DD:00:00:00:00:03', mode: 'station-bridge', running: true, connected: true, remote: 'DD:00:00:00:00:01', mcs: 8, rssi: 58, per: 0, stations: [{ mac: 'DD:00:00:00:00:01', mcs: 8, rssi: 58, signal: 78, per: 0 }] }] }),
  dev(4, { stations: [{ iface: 'wlan1', mac: 'BB:00:00:00:00:04', running: true, ap: { mac: 'EE:00:00:00:00:00', signal: -73, ccq: 65 } }], aps: [], wifi: [], w60g: [] }, { dup_of: 9 }), // duplicita se přeskakuje
];
const { rows } = buildLinks(devices, { radio_min_signal: -75, radio_min_ccq: 60 });
const sta = rows.find(r => r.kind === 'sta' && r.sta.id === 2);
assert(sta && sta.ap && sta.ap.id === 1 && sta.apIface === 'wlan2', 'anténa #2 se má spárovat se sektorem #1 (MAC bez ohledu na velikost písmen)');
assert.strictEqual(sta.signal, -81); assert.strictEqual(sta.apSignal, -79); assert.strictEqual(sta.ccq, 40); assert.strictEqual(sta.apCcq, 55);
assert.strictEqual(sta.status, 'bad');
const down = rows.find(r => r.kind === 'sta' && r.sta.id === 3); assert(down && down.status === 'down' && !down.ap, 'stanice bez AP = nespojeno');
const cl = rows.filter(r => r.kind === 'client'); assert.strictEqual(cl.length, 1, 'klient pokrytý stanicí se nevypisuje dvakrát'); assert.strictEqual(cl[0].staMac, 'CC:00:00:00:00:99'); assert.strictEqual(cl[0].peerVersion, '6.49.10'); assert.strictEqual(cl[0].status, 'ok');
const w60 = rows.filter(r => r.kind === 'w60'); assert.strictEqual(w60.length, 1, '60 GHz spoj jen jednou za dvojici'); assert.strictEqual(w60[0].signal, 80); assert.strictEqual(w60[0].peerSignal, 78); assert.strictEqual(w60[0].peerMcs, 8); assert.strictEqual(w60[0].status, 'ok');
assert(!rows.some(r => r.sta && r.sta.id === 4), 'dup_of se přeskakuje');
assert.strictEqual(rows[0].status, 'bad', 'řazení od nejhoršího');
const warn = buildLinks([dev(1, { stations: [{ iface: 'w', mac: 'A', running: true, ap: { mac: 'Z', signal: -72, ccq: 65 } }], aps: [], wifi: [], w60g: [] })], {}).rows[0];
assert.strictEqual(warn.status, 'warn', 'do 5 dB nad limitem = slabší');
console.log('links OK');
