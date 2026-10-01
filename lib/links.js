'use strict';
/**
 * Kvalita rádiových spojů mezi zařízeními — z posledního snímku rádií každého kusu (flags.links z kontroly: stanice, sektory, 60 GHz).
 * Není to historie, jen stav z poslední kontroly (last_scan_at). Anténa se se sektorem páruje přes MAC rádia (stejně jako kontrola
 * návratu po restartu v runneru); protistrana mimo upgrader zůstane jen jako MAC (+ verze RouterOS, kterou sektor o klientovi hlásí).
 */
const { devLabel } = require('./label');

const up = (m) => String(m || '').toUpperCase();
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

function thresholds(settings) {
  return {
    minSig: Number(settings.radio_min_signal ?? -75), minCcq: Number(settings.radio_min_ccq ?? 60),
    minSig60: Number(settings.radio_min_signal60 ?? 50), maxPer: Number(settings.radio_max_per ?? 5),
  };
}

/** stav 5 GHz spoje podle horší ze stran: bad = pod limitem, warn = do 5 dB / 10 % nad limitem, ok, down = stanice bez AP, unknown = bez čísel */
function judge5(t, sig, ccq) {
  const s = sig.filter(x => x !== null), c = ccq.filter(x => x !== null);
  if (!s.length && !c.length) return 'unknown';
  if (s.some(x => x < t.minSig) || c.some(x => x < t.minCcq)) return 'bad';
  if (s.some(x => x < t.minSig + 5) || c.some(x => x < t.minCcq + 10)) return 'warn';
  return 'ok';
}
function judge60(t, sig, per) {
  const s = sig.filter(x => x !== null), p = per.filter(x => x !== null);
  if (!s.length && !p.length) return 'unknown';
  if (s.some(x => x < t.minSig60) || p.some(x => x > t.maxPer)) return 'bad';
  if (s.some(x => x < t.minSig60 + 10) || p.some(x => x > t.maxPer / 2)) return 'warn';
  return 'ok';
}
const RANK = { bad: 0, down: 1, warn: 2, unknown: 3, ok: 4 };

const brief = (d) => d ? { id: d.id, host: d.host, label: devLabel(d), owner_id: d.owner_id, ap: d.userdb_ap || '', apId: Number(d.userdb_ap_id || 0), at: d.last_scan_at || 0, scan_status: d.scan_status } : null;

/**
 * @param {Array} devices všechna zařízení (hlavní záznamy; dup_of se přeskakují)
 * @returns {{rows: Array, at: number}}
 */
function buildLinks(devices, settings) {
  const t = thresholds(settings);
  const devs = devices.filter(d => d.managed && !d.dup_of && d.flags && d.flags.links);
  // indexy podle MAC rádia: sektory (aps + wifi), stanice, 60 GHz
  const apByMac = new Map(), staByMac = new Map(), w60ByMac = new Map();
  for (const d of devs) {
    const lk = d.flags.links;
    for (const a of [...(lk.aps || []), ...(lk.wifi || [])]) if (a.mac) apByMac.set(up(a.mac), { d, a });
    for (const s of lk.stations || []) if (s.mac) staByMac.set(up(s.mac), { d, s });
    for (const w of lk.w60g || []) if (w.mac) w60ByMac.set(up(w.mac), { d, w });
  }
  const rows = [];
  const seenClient = new Set(); // "apMac|clientMac" — klient sektoru už pokrytý řádkem stanice
  // 1) stanice → sektor
  for (const d of devs) {
    for (const s of d.flags.links.stations || []) {
      if (!s.running && !s.ap) continue; // vypnuté/neběžící rádio bez registrace se nevypisuje
      const apMac = s.ap ? up(s.ap.mac) : '';
      const hit = apMac ? apByMac.get(apMac) : null;
      const apSide = hit ? (hit.a.clients || []).find(c => up(c.mac) === up(s.mac)) : null;
      if (hit) seenClient.add(`${apMac}|${up(s.mac)}`);
      const sig = [s.ap ? num(s.ap.signal) : null, apSide ? num(apSide.signal) : null], ccq = [s.ap ? num(s.ap.ccq) : null, apSide ? num(apSide.ccq) : null];
      rows.push({
        kind: 'sta', status: s.ap ? judge5(t, sig, ccq) : 'down',
        sta: brief(d), iface: s.iface, ssid: s.ssid || '', band: s.band || '', protocol: s.protocol || s.driver || '', frequency: s.frequency || '',
        ap: hit ? brief(hit.d) : null, apIface: hit ? hit.a.iface : '', apMac: apMac || '',
        signal: sig[0], ccq: ccq[0], apSignal: sig[1], apCcq: ccq[1], uptime: s.ap ? (s.ap.uptime || '') : '', peerVersion: s.ap ? (s.ap.version || '') : '',
        at: d.last_scan_at || 0, apAt: hit ? (hit.d.last_scan_at || 0) : 0,
      });
    }
  }
  // 2) klienti sektorů, které nemáme jako stanici v upgraderu (cizí CPE, kus bez kontroly) — jen pohled ze sektoru
  for (const d of devs) {
    const lk = d.flags.links;
    for (const a of [...(lk.aps || []), ...(lk.wifi || [])]) {
      for (const c of a.clients || []) {
        const key = `${up(a.mac)}|${up(c.mac)}`; if (seenClient.has(key)) continue; seenClient.add(key);
        const known = staByMac.get(up(c.mac)); // stanice známá, ale její snímek je starší / hlásí jiný sektor
        const sig = [num(c.signal)], ccq = [num(c.ccq)];
        rows.push({
          kind: 'client', status: judge5(t, sig, ccq),
          sta: known ? brief(known.d) : null, staMac: up(c.mac), iface: known ? known.s.iface : '', ssid: a.ssid || '', band: a.band || '', protocol: a.protocol || a.driver || '', frequency: a.frequency || '',
          ap: brief(d), apIface: a.iface, apMac: up(a.mac),
          signal: null, ccq: null, apSignal: sig[0], apCcq: ccq[0], uptime: c.uptime || '', peerVersion: c.version || '',
          at: known ? (known.d.last_scan_at || 0) : 0, apAt: d.last_scan_at || 0,
        });
      }
    }
  }
  // 3) 60 GHz: každý spoj jednou (dvojice MAC bez ohledu na směr), obě strany, pokud je máme
  const seen60 = new Set();
  for (const d of devs) {
    for (const w of d.flags.links.w60g || []) {
      if (!w.running && !w.connected) continue;
      const peers = (w.stations && w.stations.length) ? w.stations : (w.remote ? [{ mac: w.remote, mcs: w.mcs, rssi: w.rssi, signal: null, per: w.per }] : []);
      if (!peers.length) { rows.push({ kind: 'w60', status: 'down', sta: brief(d), iface: w.iface, ssid: w.ssid || '', mode: w.mode || '', frequency: w.frequency || '', ap: null, apIface: '', apMac: '', mcs: null, rssi: null, signal: null, per: null, peerMcs: null, peerRssi: null, peerSignal: null, peerPer: null, at: d.last_scan_at || 0, apAt: 0 }); continue; }
      for (const p of peers) {
        const key = [up(w.mac), up(p.mac)].sort().join('|'); if (seen60.has(key)) continue; seen60.add(key);
        const hit = w60ByMac.get(up(p.mac));
        const back = hit ? ((hit.w.stations || []).find(x => up(x.mac) === up(w.mac)) || (up(hit.w.remote) === up(w.mac) ? { mcs: hit.w.mcs, rssi: hit.w.rssi, signal: null, per: hit.w.per } : null)) : null;
        const sig = [num(p.signal), back ? num(back.signal) : null], per = [num(p.per), back ? num(back.per) : null];
        rows.push({
          kind: 'w60', status: judge60(t, sig, per),
          sta: brief(d), iface: w.iface, ssid: w.ssid || '', mode: w.mode || '', frequency: w.frequency || '',
          ap: hit ? brief(hit.d) : null, apIface: hit ? hit.w.iface : '', apMac: up(p.mac),
          mcs: num(p.mcs), rssi: num(p.rssi), signal: sig[0], per: per[0],
          peerMcs: back ? num(back.mcs) : null, peerRssi: back ? num(back.rssi) : null, peerSignal: sig[1], peerPer: per[1],
          at: d.last_scan_at || 0, apAt: hit ? (hit.d.last_scan_at || 0) : 0,
        });
      }
    }
  }
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.signal ?? a.apSignal ?? 0) - (b.signal ?? b.apSignal ?? 0));
  return { rows, thresholds: t };
}

module.exports = { buildLinks, thresholds, judge5, judge60 };
