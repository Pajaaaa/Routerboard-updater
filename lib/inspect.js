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
    'free-memory', 'total-memory', 'free-hdd-space', 'total-hdd-space', 'uptime', 'build-time', 'cpu']);
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
    files: files.map(f => ({ name: f.name, type: f.type, size: num(f.size) })),
    flags: {},
  };
  info.npk_files = info.files.filter(f => f.type === 'package' || /\.npk$/i.test(f.name));
  info.flash_dir = info.files.some(f => f.name === 'flash' && /dir/i.test(f.type));

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
    const dm = await c.kv('/system device-mode', ['mode', 'partitions', 'fetch', 'scheduler', 'attempt-count', 'flagged']);
    const tri = (v) => v === null || v === undefined || v === '' ? null : bool(v);
    info.device_mode = dm.mode ? { mode: dm.mode, partitions: tri(dm.partitions), fetch: tri(dm.fetch), scheduler: tri(dm.scheduler), attempts: num(dm['attempt-count']), flagged: bool(dm.flagged) } : null;
    flags.device_mode = info.device_mode;
    info.interfaces = (await c.list('/interface', ['name', 'type', 'running', 'disabled'])) || [];
    info.addresses = (await c.list('/ip address', ['address', 'interface', 'disabled'])) || [];
  }
  return info;
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

module.exports = { inspect, toDeviceFields, parseUptime };
