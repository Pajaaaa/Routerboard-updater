'use strict';
// Zjištění stavu routeru — POUZE čtení. Používá scanner i runner.
const { parseVersion } = require('./versions');

function parseUptime(s) {
  if (!s) return 0;
  let sec = 0;
  const m = String(s).match(/(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+):(\d+):(\d+))?/);
  if (!m) return 0;
  sec += (+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0);
  if (m[6] !== undefined) sec += (+m[6]) * 3600 + (+m[7]) * 60 + (+m[8]);
  return sec;
}
const num = (v) => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const bool = (v) => v === 'true' || v === 'yes';

/**
 * @param {RosClient} c
 * @param {{full?: boolean}} o full = včetně rozhraní, adres a rizikových příznaků pro migraci
 */
async function inspect(c, { full = false } = {}) {
  const r = await c.kv('/system resource', ['version', 'board-name', 'architecture-name', 'platform', 'cpu-load',
    'free-memory', 'total-memory', 'free-hdd-space', 'total-hdd-space', 'uptime', 'build-time', 'cpu', 'bad-blocks']);
  const ident = await c.kv('/system identity', ['name']);
  const rb = await c.kv('/system routerboard', ['routerboard', 'model', 'serial-number', 'current-firmware', 'upgrade-firmware', 'firmware-type', 'board-name']);
  const pkgs = (await c.list('/system package', ['name', 'version', 'disabled'])) || [];
  const upd = await c.kv('/system package update', ['channel', 'installed-version', 'latest-version', 'status']);
  const files = (await c.list('/file', ['name', 'type', 'size'])) || [];

  const versionStr = (r.version || '').trim();
  const v = parseVersion(versionStr);
  const chanM = versionStr.match(/\((.*?)\)/);
  const info = {
    identity: ident.name || '',
    version: v ? v.str : versionStr,
    versionParsed: v,
    channel: chanM ? chanM[1] : (upd.channel || ''),
    arch: (r['architecture-name'] || '').trim(),
    board_name: r['board-name'] || rb['board-name'] || '',
    platform: r.platform || '',
    cpu: r.cpu || '',
    cpu_load: num(r['cpu-load']),
    free_mem: num(r['free-memory']),
    total_mem: num(r['total-memory']),
    free_hdd: num(r['free-hdd-space']),
    total_hdd: num(r['total-hdd-space']),
    uptime_sec: parseUptime(r.uptime),
    uptime: r.uptime || '',
    build_time: r['build-time'] || '',
    routerboard: bool(rb.routerboard),
    model: rb.model || '',
    serial: rb['serial-number'] || '',
    fw_current: rb['current-firmware'] || '',
    fw_upgrade: rb['upgrade-firmware'] || '',
    fw_type: rb['firmware-type'] || '',
    packages: pkgs.map(p => ({ name: p.name, version: p.version, disabled: bool(p.disabled) })),
    pkgupdate: { channel: upd.channel || '', installed: upd['installed-version'] || '', latest: upd['latest-version'] || '', status: upd.status || '' },
    bad_blocks: parseFloat(String(r['bad-blocks'] || '').replace('%', '')) || 0, // % vadných bloků NAND (>5 % = flash umírá, viz rešerše)
    files: files.map(f => ({ name: f.name, type: f.type, size: num(f.size) })),
    flags: {},
  };
  info.npk_files = info.files.filter(f => f.type === 'package' || /\.npk$/i.test(f.name));
  info.flash_dir = info.files.some(f => f.name === 'flash' && /dir/i.test(f.type));
  info.fwf_files = info.files.filter(f => /\.fwf$/i.test(f.name)).map(f => f.name); // cizí RouterBOOT soubor blokuje /system routerboard upgrade

  const major = v ? v.major : 0;
  const flags = info.flags;
  // rizikové/migrační příznaky (bez chyb — neexistující menu vrací null)
  flags.wireless = await c.count('/interface wireless');
  flags.wifi = major >= 7 ? await c.count('/interface wifi') : null;
  if (flags.wifi === null && major >= 7) flags.wifiwave2 = await c.count('/interface wifiwave2');
  if (full) {
    if (major >= 7) {
      flags.bgp = await c.count('/routing bgp connection');
      flags.ospf = await c.count('/routing ospf interface-template');
      flags.routing_filter = await c.count('/routing filter rule');
      flags.mpls = await c.count('/mpls ldp instance');
    } else {
      flags.bgp = await c.count('/routing bgp peer');
      flags.ospf = await c.count('/routing ospf network');
      flags.routing_filter = await c.count('/routing filter');
      const ldp = await c.kv('/mpls ldp', ['enabled']);
      flags.mpls = bool(ldp.enabled) ? 1 : 0;
    }
    flags.vpls = await c.count('/interface vpls');
    const cm = await c.kv('/caps-man manager', ['enabled']);
    flags.capsman = bool(cm.enabled) ? 1 : 0;
    if (major >= 7) {
      const wcm = await c.kv('/interface wifi capsman', ['enabled']);
      if (bool(wcm.enabled)) flags.capsman = 1;
    }
    flags.caps_client = 0;
    const cap = await c.kv('/interface wireless cap', ['enabled']);
    if (bool(cap.enabled)) flags.caps_client = 1;
    flags.scheduler = await c.count('/system scheduler');
    flags.w60g = await c.count('/interface w60g');
    flags.vlan_filtering = await c.count('/interface bridge', 'vlan-filtering=yes');
    const rbs = await c.kv('/system routerboard settings', ['auto-upgrade', 'protected-routerboot', 'boot-device']);
    flags.fw_auto_upgrade = bool(rbs['auto-upgrade']);
    flags.protected_routerboot = rbs['protected-routerboot'] === 'enabled' || rbs['protected-routerboot'] === 'true';
    flags.boot_device = rbs['boot-device'] || '';
    // oddíly (partitions) — fallback při nenabootování
    const parts = (await c.list('/partitions', ['name', 'size', 'active', 'running', 'fallback-to', 'version'])) || [];
    info.partitions = parts.map(x => ({ name: x.name, size: x.size, active: bool(x.active), running: bool(x.running), fallback_to: x['fallback-to'], version: x.version }));
    flags.partitions = info.partitions.length;
    if (major >= 7) {
      const h = (await c.list('/system health', ['name', 'value'])) || [];
      flags.voltage = (h.find(x => x.name === 'voltage') || {}).value || '';
      flags.temperature = (h.find(x => x.name === 'temperature') || {}).value || '';
    } else {
      const health = await c.kv('/system health', ['voltage', 'temperature']);
      flags.voltage = health.voltage || '';
      flags.temperature = health.temperature || '';
    }
    // topologie: uplink (soused na rozhraní default route) a PoE napájené porty
    try {
      const rf = major >= 7 ? ['gateway', 'immediate-gw'] : ['gateway', 'gateway-status'];
      let routes = (await c.list('/ip route', rf, { where: 'dst-address=0.0.0.0/0 active=yes' })) || [];
      if (!routes.length) routes = (await c.list('/ip route', ['gateway'], { where: 'dst-address=0.0.0.0/0 active=yes' })) || [];
      const r0 = routes[0];
      if (r0) {
        const gwTxt = `${r0['immediate-gw'] || ''} ${r0['gateway-status'] || ''} ${r0.gateway || ''}`;
        const ipM = gwTxt.match(/(\d+\.\d+\.\d+\.\d+)/);
        const ifM = gwTxt.match(/%([^\s,]+)/) || gwTxt.match(/via\s+([^\s,]+)/);
        let iface = ifM ? ifM[1] : '';
        const gw = ipM ? ipM[1] : '';
        if (!iface && gw) { const arp = (await c.list('/ip arp', ['address', 'interface'], { where: `address=${gw}` })) || []; if (arp[0]) iface = arp[0].interface; }
        info.uplink = { gateway: gw, iface };
      }
    } catch { /* bez uplinku */ }
    const nb = (await c.list('/ip neighbor', ['interface', 'address', 'identity', 'board', 'mac-address', 'version'])) || [];
    info.neighbors = nb.map(n => ({ iface: n.interface, address: n.address, identity: n.identity, board: n.board, mac: n['mac-address'], version: n.version }));
    if (info.uplink) {
      // soused je uplink jen když jeho adresa = brána (jinak by se hádalo)
      info.uplink.neighbor = info.neighbors.find(n => n.address && n.address === info.uplink.gateway) || null;
      const ifs = (n) => (n.iface || '').split(/[;,\/]/);
      info.uplink.neighbors_on_iface = info.neighbors.filter(n => info.uplink.iface && ifs(n).includes(info.uplink.iface)).map(n => ({ address: n.address, identity: n.identity }));
    }
    // PoE-out porty: poe-out je vlastnost /interface ethernet, stav napájení jen přes poe monitor
    const eth = (await c.list('/interface ethernet', ['name', 'poe-out'])) || [];
    const poeOn = eth.filter(x => /auto-on|forced-on/i.test(x['poe-out'] || ''));
    const powered = [];
    info.poe_ports_all = poeOn.map(x => ({ name: x.name, mode: x['poe-out'] }));
    if (poeOn.length) {
      const cmd = poeOn.map(x => `:do {:put ("${x.name}=" . ([/interface ethernet poe monitor "${x.name}" once as-value]->"poe-out-status"))} on-error={:put "${x.name}=?"}`).join('; ');
      const txt = await c.exec(cmd, { timeoutMs: 30000, allowError: true });
      for (const line of txt.split('\n')) { const i = line.indexOf('='); if (i > 0 && /powered/i.test(line.slice(i + 1))) powered.push(line.slice(0, i)); }
    }
    info.poe_ports = powered;
    info.poe_children = info.neighbors.filter(n => powered.some(pn => (n.iface || '').split(/[;,\/]/).includes(pn)));
    flags.uplink = info.uplink || null;
    flags.poe_children = info.poe_children.map(n => ({ iface: n.iface, address: n.address, identity: n.identity }));
    flags.poe_ports = info.poe_ports_all;
    // device-mode (7.x): mode + příznaky důležité pro upgrade
    const dm = await c.kv('/system device-mode', ['mode', 'partitions', 'fetch', 'scheduler', 'attempt-count', 'flagged', 'routerboard']);
    const tri = (v) => v === null || v === undefined || v === '' ? null : bool(v);
    info.device_mode = dm.mode ? { mode: dm.mode, partitions: tri(dm.partitions), fetch: tri(dm.fetch), scheduler: tri(dm.scheduler), routerboard: tri(dm.routerboard), attempts: num(dm['attempt-count']), flagged: bool(dm.flagged) } : null;
    flags.device_mode = info.device_mode;
    info.interfaces = (await c.list('/interface', ['name', 'type', 'running', 'disabled'])) || [];
    info.addresses = (await c.list('/ip address', ['address', 'interface', 'disabled'])) || [];
    info.links = await inspectLinks(c, major);
    flags.links = info.links;
    // symptomy umírajícího HW / selhání minulého bootu v logu (paměťový log se rebootem maže → po restartu jsou to čerstvé záznamy)
    info.log_symptoms = await logSymptoms(c);
    flags.log_symptoms = info.log_symptoms.length;
    // brute-force ochrana SSH počítá NOVÁ spojení (ne špatná hesla) → víc spojení za sebou = blacklist
    const bf = await c.count('/ip firewall filter', 'dst-port=22 action=add-src-to-address-list disabled=no');
    flags.ssh_bruteforce_rules = bf || 0;
  }
  return info;
}

const LOG_SYMPTOM_RE = 'kernel failure|rebooted without proper shutdown|out of memory|bad block|NAND|not enough (disk )?space|broken package|Damaged|bad image|missing .*package|upgrade failed|login failure for user -2';
/** záznamy logu, které signalizují vadnou flash, pád jádra, neúspěšnou instalaci nebo kompromitaci (CVE 9/2026: „login failure for user -2") */
async function logSymptoms(c) {
  const rows = (await c.list('/log', ['time', 'topics', 'message'], { where: `message~"${LOG_SYMPTOM_RE}"`, timeoutMs: 30000 })) || [];
  return rows.slice(-12).map(r => `${r.time} ${r.topics}: ${String(r.message).slice(0, 160)}`);
}

/**
 * Stav bezdrátových spojů — POUZE čtení. Slouží k tomu, aby se po upgradu ověřilo, že se anténa zase připojila k sektoru
 * (a sektoru se vrátili klienti). Každý dotaz je v :do/on-error, chybějící menu (bez rádia, v6) vrací prázdno.
 */
async function inspectLinks(c, major) {
  const links = { stations: [], aps: [], w60g: [], wifi: [], cap: null, capsman: null, driver: 'none' };
  const isStation = (m) => /^station/.test(m || '');
  // --- legacy "wireless" (a/b/g/n/ac + MIPS, nv2/nstreme) ---
  const wl = (await c.list('/interface wireless', ['name', 'mode', 'wireless-protocol', 'band', 'ssid', 'running', 'disabled', 'mac-address'])) || [];
  if (wl.length) links.driver = 'wireless';
  const regs = (await c.list('/interface wireless registration-table', ['interface', 'mac-address', 'signal-strength', 'uptime'])) || [];
  const regVer = (await c.list('/interface wireless registration-table', ['mac-address', 'routeros-version', 'tx-ccq'])) || [];
  const verOf = (mac) => (regVer.find(x => x['mac-address'] === mac) || {});
  for (const w of wl) {
    if (w.disabled === 'true') continue;
    const mine = regs.filter(r => r.interface === w.name).map(r => ({ mac: r['mac-address'], signal: parseInt(r['signal-strength'], 10) || null, uptime: r.uptime, version: verOf(r['mac-address'])['routeros-version'] || '', ccq: parseInt(verOf(r['mac-address'])['tx-ccq'], 10) || null }));
    const base = { iface: w.name, mode: w.mode, protocol: w['wireless-protocol'] || '', band: w.band || '', ssid: w.ssid || '', running: w.running === 'true', mac: w['mac-address'] || '' };
    if (isStation(w.mode)) links.stations.push({ ...base, ap: mine[0] || null });
    else links.aps.push({ ...base, clients: mine });
  }
  // --- 60 GHz (w60g, v balíčku wireless) ---
  const w60 = (await c.list('/interface w60g', ['name', 'mode', 'ssid', 'frequency', 'running', 'disabled', 'mac-address'])) || [];
  if (w60.length && links.driver === 'none') links.driver = 'wireless';
  for (const w of w60) {
    if (w.disabled === 'true') continue;
    const l = { iface: w.name, mode: w.mode, ssid: w.ssid || '', frequency: w.frequency || '', running: w.running === 'true', mac: w['mac-address'] || '', connected: null, remote: '', mcs: null, rssi: null, per: null, stations: [] };
    // monitor: u PtMP AP jsou hodnoty seznamy oddělené ";" (jedna položka na stanici, stejné pořadí ve všech polích)
    const F = ['connected', 'remote-address', 'tx-mcs', 'rssi', 'signal', 'tx-packet-error-rate', 'tx-sector', 'tx-phy-rate'];
    const cmd = `:do {:local m [/interface w60g monitor "${w.name}" once as-value]; :put (${F.map(f => `"${f}=" . [:tostr ($m->"${f}")]`).join(' . "|" . ')})} on-error={:put "monitor=ERR"}`;
    const txt = (await c.exec(cmd, { timeoutMs: 20000, allowError: true })).trim().split('\n').pop() || '';
    const kv = Object.fromEntries(txt.split('|').map(x => { const i = x.indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }));
    const lst = (k) => String(kv[k] ?? '').split(';').map(x => x.trim()).filter(x => x !== '');
    const numOr = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    if (kv.connected !== undefined) {
      const remotes = lst('remote-address'), mcs = lst('tx-mcs'), rssi = lst('rssi'), sig = lst('signal'), per = lst('tx-packet-error-rate');
      l.connected = kv.connected === 'true';
      l.stations = remotes.map((mac, i) => ({ mac, mcs: numOr(mcs[i]), rssi: numOr(rssi[i]), signal: numOr(sig[i]), per: numOr(per[i]) }));
      l.remote = remotes[0] || '';
      l.mcs = l.stations.length ? Math.min(...l.stations.map(x => x.mcs).filter(x => x !== null).concat([Infinity])) : null;
      if (l.mcs === Infinity) l.mcs = null;
      l.rssi = numOr(rssi[0]);
      l.per = numOr(per[0]);
      l.sector = kv['tx-sector'] || '';
    }
    links.w60g.push(l);
  }
  // --- nový "wifi" driver (wifi-qcom / wifi-qcom-ac), jen v7 ---
  if (major >= 7) {
    const wf = (await c.list('/interface wifi', ['name', 'configuration.mode', 'configuration.ssid', 'running', 'disabled', 'mac-address'])) || [];
    if (wf.length) links.driver = links.driver === 'wireless' ? 'mixed' : 'wifi';
    const wregs = (await c.list('/interface wifi registration-table', ['interface', 'mac-address', 'signal', 'uptime'])) || [];
    for (const w of wf) {
      if (w.disabled === 'true') continue;
      const mine = wregs.filter(r => r.interface === w.name).map(r => ({ mac: r['mac-address'], signal: parseInt(r.signal, 10) || null, uptime: r.uptime }));
      links.wifi.push({ iface: w.name, mode: w['configuration.mode'] || '', ssid: w['configuration.ssid'] || '', running: w.running === 'true', mac: w['mac-address'] || '', clients: mine });
    }
  }
  // --- CAP / CAPsMAN (legacy = balíček wireless; wifi CAPsMAN = bundle; navzájem nekompatibilní) ---
  const cap = await c.kv('/interface wireless cap', ['enabled', 'caps-man-addresses', 'current-caps-man-address']);
  if (cap.enabled === 'true') links.cap = { kind: 'legacy', manager: cap['current-caps-man-address'] || '', configured: cap['caps-man-addresses'] || '' };
  if (major >= 7) {
    const wcap = await c.kv('/interface wifi cap', ['enabled', 'caps-man-addresses', 'current-caps-man-address']);
    if (wcap.enabled === 'true') links.cap = { kind: 'wifi', manager: wcap['current-caps-man-address'] || '', configured: wcap['caps-man-addresses'] || '' };
  }
  const cm = await c.kv('/caps-man manager', ['enabled', 'upgrade-policy']);
  if (cm.enabled === 'true') links.capsman = { kind: 'legacy', upgrade_policy: cm['upgrade-policy'] || '', caps: (await c.count('/caps-man remote-cap')) || 0 };
  if (major >= 7) {
    const wcm = await c.kv('/interface wifi capsman', ['enabled', 'upgrade-policy']);
    if (wcm.enabled === 'true') links.capsman = { kind: 'wifi', upgrade_policy: wcm['upgrade-policy'] || '', caps: (await c.count('/interface wifi capsman remote-cap')) || 0 };
  }
  return links;
}

/** převod zjištěného stavu na sloupce zařízení v DB */
function toDeviceFields(info) {
  return {
    identity: info.identity, board_name: info.board_name, model: info.model, serial: info.serial, arch: info.arch,
    version: info.version, channel: info.channel, fw_current: info.fw_current, fw_upgrade: info.fw_upgrade,
    total_hdd: info.total_hdd, free_hdd: info.free_hdd, total_mem: info.total_mem, free_mem: info.free_mem,
    uptime_sec: info.uptime_sec, cpu_load: info.cpu_load, packages: info.packages,
    flags: { ...info.flags, platform: info.platform, routerboard: info.routerboard, flash_dir: info.flash_dir, partitions_list: info.partitions || [], npk_files: info.npk_files.map(f => f.name), pkgupdate: info.pkgupdate },
  };
}

module.exports = { inspect, inspectLinks, logSymptoms, toDeviceFields, parseUptime };
