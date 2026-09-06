'use strict';
// Plán upgradu pro jedno zařízení: hopy (6.x -> 6.49.x -> 7.x), balíčky, místo, blokátory a varování.
const V = require('./versions');

const MB = 1048576;

// Verze se známou regresí pro daný HW (rešerše 9/2026: changelogy download.mikrotik.com + forum.mikrotik.com). Cíl v seznamu = blokátor.
const KNOWN_BAD = [
  { key: 'w60g', versions: ['7.19.4', '7.19.5', '7.5', '6.47', '6.47.1', '6.47.2', '6.47.3', '6.47.4', '6.47.5'], why: '60 GHz: spoj se nenaváže (MCS 0) / flapping — 7.19.4 opraveno v 7.19.6, 7.5 v 7.6, 6.47.x v 6.47.6' },
  { board: /RB2011/i, versions: ['7.21', '7.21.1', '7.21.2', '7.21.3', '7.21.4', '7.22', '7.22.1', '7.22.2', '7.22.3'], why: 'RB2011: rozbitá MAC tabulka switche (opraveno 7.21.5 / 7.23)' },
  { board: /RB3011/i, versions: ['7.20', '7.22', '7.22.1', '7.22.2', '7.22.3', '7.23', '7.23.1', '7.23.2', '7.23.3', '7.23.4', '7.23.5', '7.24'], why: 'RB3011: nestabilita switche 7.22–7.24.0 (opraveno 7.24.1), HW crypto 7.20.0' },
  { board: /hAP ac\^?[23]|cAP ac|cAP XL ac|wAP ac|hAP ax|cAP ax|wAP ax/i, versions: ['7.22', '7.22.1', '7.22.2'], why: 'IPQ-40xx/60xx: nestabilita ethernetu po resetu switche (opraveno 7.22.3)' },
  { board: /hAP ac\^?2/i, versions: ['7.20'], why: 'hAP ac2: HW crypto nestabilita (opraveno 7.20.1)' },
  { board: /CRS354/i, versions: ['7.15', '7.15.1'], why: 'CRS354: omezený Tx (opraveno 7.15.2)' },
  { board: /CRS3(26|28)/i, versions: ['7.14.1'], why: 'CRS3xx s 16 MB: bootloop (opraveno 7.14.2)' },
  { board: /RB5009/i, versions: [], firmwareWarn: 'RB5009: hlášen hard-brick po upgradu RouterBOOT (7.19, 5/2025) — firmware upgraduj jen s fyzickým přístupem' },
  { board: /E60iUGS|hEX S 2025/i, versions: [], warn: 'hEX S 2025 (E60iUGS): hlášen brick po standardním upgradu RouterOS + RouterBOOT (7/2026), nový HW — upgraduj jen s fyzickým přístupem' },
  { arch: 'ppc', versions: ['7.12'], why: 'PPC: 7.12.0 nenabootuje (opraveno 7.12.1)' },
  { arch: 'x86', versions: ['7.14', '7.22', '7.22.1'], why: 'CHR/x86: chybějící ethernet 7.14.0, VRRP 7.22.0–7.22.1' },
  { board: /Chateau 5G R17/i, versions: ['7.21.1'], why: 'Chateau 5G R17: LTE (opraveno 7.21.2)' },
];
// Verze rizikové pro všechny (regrese s rychlou opravnou verzí)
const GLOBAL_BAD = {
  '7.12': 'nenabootuje na PPC, jen jako mezikrok použij 7.12.1', '7.12.2': 'jen factory-only vydání',
  '7.13': 'rozdělení wireless + regrese FastPath/LTE (opraveno 7.13.5)', '7.13.1': 'wifi country profile (opraveno 7.13.5)', '7.13.2': 'regrese 7.13.x (opraveno 7.13.5)', '7.13.3': 'regrese 7.13.x (opraveno 7.13.5)', '7.13.4': 'bridge HW offload (opraveno 7.13.5)',
  '7.14': 'CHR bez ethernetů, VRF do main, CRS328 bootloop (opraveno 7.14.2)', '7.14.1': 'CRS328 16 MB bootloop, VRF (opraveno 7.14.2)',
  '7.15': 'chybějící routing konfigurace po reset+upgrade, CRS354 Tx (opraveno 7.15.2)', '7.15.1': 'SSH key import, RD/RT (opraveno 7.15.2)',
  '7.16': 'neaktivní routy po rebootu, capsman-cap certifikáty (opraveno 7.16.2)', '7.16.1': 'DNS lookup order, neaktivní routy (opraveno 7.16.2)',
  '7.17': 'ztráta bridge/IP/IPv6 nastavení po upgradu, „kernel disk space" na ARM (opraveno 7.17.1)',
  '7.18': 'CAKE queue crash, netinstall, OVPN MMIPS (opraveno 7.18.2)', '7.18.1': 'CAKE queue crash (opraveno 7.18.2)',
  '7.19': 'built-in CA store rozbil importované certifikáty (opraveno 7.19.1)', '7.19.1': 'RB5009 ether1 advertise (opraveno 7.19.2)', '7.19.2': 'switch ACL redirect-to-cpu / RoMON (opraveno 7.19.3)',
  '7.20': 'STP blokuje porty, chybějící connected routy, rozbité neinteraktivní SSH, CVE-2025-10948 (opraveno 7.20.1–7.20.3)', '7.20.1': 'STP blokuje porty (opraveno 7.20.2)', '7.20.2': 'rozbité neinteraktivní SSH — nástroj by selhal (opraveno 7.20.3)',
  '7.20.3': 'PPPoE disconnecty, switch-cpu VLAN (opraveno 7.20.6–7.20.8)', '7.20.4': 'PPPoE, webfig po Quick Set (opraveno 7.20.6)', '7.20.5': 'PPPoE disconnecty (opraveno 7.20.6)', '7.20.6': 'switch-cpu VLAN, OVPN po rebootu (opraveno 7.20.7/7.20.8)', '7.20.7': 'dynamická switch-cpu VLAN (opraveno 7.20.8)',
  '7.21': 'switch-cpu VLAN, IPv6 RA, MIPSBE jen MAC-telnet (opraveno 7.21.1–7.21.4)', '7.21.1': 'IPv6 RA, Chateau 5G R17, FastPath RPS (opraveno 7.21.3)', '7.21.2': 'IPv6 RA regrese (opraveno 7.21.3)', '7.21.3': 'l3hw nestabilita (opraveno 7.21.4)',
  '7.22': 'USB ethernet crash, CHR VRRP, IPQ-40xx switch reset (opraveno 7.22.3)', '7.22.1': 'CHR VRRP, IPv6 RA on-link (opraveno 7.22.2/7.22.3)', '7.22.2': 'IPQ-40xx/60xx switch reset, CRS354 reboot loop (opraveno 7.22.3)',
  '7.23': 'rozbité IPv6 po upgradu, bogus /apps v exportu, CRL chyba (opraveno 7.23.2)', '7.23.1': 'kernel panic hlášení, CRS305 degradace (opraveno 7.23.2)', '7.23.4': 'nefunkční DHCPv6 (opraveno 7.23.5)',
  '7.24': 'WireGuard tunel po disable/enable peeru, 16 MB „disk is full" (opraveno 7.24.1)',
};
// ARM desky, kde z verzí < 7.16.2 nejde přímo na 7.20+ (layout NAND: „free XXX kB disk space for a (null)upgrade") — cesta 7.16.2 → 7.18.2 → cíl
const NAND_LAYOUT_BOARDS = /CCR2004|RB450Gx4/i;
const V6_BUNDLE = new Set(['system', 'ipv6', 'wireless', 'hotspot', 'ppp', 'dhcp', 'security', 'advanced-tools', 'multicast', 'mpls', 'routing']);

function releaseTs(version, latest) {
  for (const v of Object.values(latest.versions || {})) if (v.version === version && v.releasedAt) return v.releasedAt;
  return 0;
}
function targetFor(track, latest) {
  const l = latest.versions || {};
  if (track === 'hold') return null;
  if (!l[track]) return undefined;
  return l[track].version;
}

/**
 * @param {object} info výsledek inspect() (nebo záznam zařízení s totožnými poli)
 * @param {object} o {track, settings, latest, options}
 */
async function plan(info, o) {
  const { settings, latest } = o;
  const options = o.options || {};
  const track = o.track || 'v7-stable';
  const blockers = [], warnings = [], notes = [];
  const out = { track, blockers, warnings, notes, hops: [], firmware: null, current: info.version, target: null, mode: options.mode || 'upload' };

  const platform = info.platform || (info.flags && info.flags.platform) || '';
  const routerboard = info.routerboard !== undefined ? info.routerboard : !!(info.flags && info.flags.routerboard);
  if (info.managed === false) { blockers.push('neřízený prvek topologie (bez loginu) — neupgraduje se'); return out; }
  const cur = V.parseVersion(info.version);
  if (!cur) { blockers.push(`nečitelná verze RouterOS: "${info.version}"`); return out; }
  const target = targetFor(track, latest);
  if (target === null) { blockers.push('zařízení má nastaveno „hold" — neupgradovat'); return out; }
  if (target === undefined) { blockers.push(`neznámá nejnovější verze pro ${track} (upgrade.mikrotik.com nedostupný?)`); return out; }
  out.target = target;
  const tgt = V.parseVersion(target);
  const arch = info.arch;

  // firmware
  if (routerboard && info.fw_current && info.fw_upgrade && info.fw_current !== info.fw_upgrade) {
    out.firmware = { current: info.fw_current, upgrade: info.fw_upgrade };
  }

  const cmp = V.cmpVersion(cur, tgt);
  if (cmp > 0) { blockers.push(`zařízení má novější verzi (${cur.str}) než cíl ${target} — downgrade se nedělá`); return out; }
  if (cmp === 0) {
    out.upToDate = true;
    if (!out.firmware) out.nothingToDo = true;
  }

  // obecné kontroly stavu (platí i pro firmware)
  if (platform && /CHR/i.test(platform) && out.mode === 'upload') blockers.push('CHR (virtuální) — režim upload nepodporován, použij režim „router"');
  if (!options.ignore_uptime && info.uptime_sec < (settings.min_uptime_min || 0) * 60) {
    blockers.push(`uptime jen ${Math.round(info.uptime_sec / 60)} min (min. ${settings.min_uptime_min}) — zařízení se nedávno restartovalo`);
    out.waitUptimeSec = Math.ceil((settings.min_uptime_min || 0) * 60 - info.uptime_sec);
  }
  if (info.free_mem && info.free_mem < (settings.min_free_mem_mb || 0) * MB) blockers.push(`málo volné RAM: ${(info.free_mem / MB).toFixed(1)} MB (min. ${settings.min_free_mem_mb})`);
  const stray = (info.npk_files || info.flags?.npk_files || []).map(f => typeof f === 'string' ? f : f.name);
  if (stray.length) blockers.push(`v kořeni routeru jsou cizí balíčky .npk (${stray.join(', ')}) — při restartu by se nainstalovaly; smaž je ručně (/file remove)`);
  const pu = info.pkgupdate || info.flags?.pkgupdate;
  if (pu && /downloaded/i.test(pu.status || '')) blockers.push(`router má rozpracovaný vlastní download (${pu.status}) — vyřeš ručně`);
  if (info.cpu_load >= 90) warnings.push(`vysoká zátěž CPU ${info.cpu_load} %`);
  // zdraví flash a minulé pády (rešerše: bad-blocks >5 % = NAND umírá → Netinstall/RMA; "kernel failure"/"rebooted without proper shutdown" = HW/napájení)
  const bb = Number(info.bad_blocks ?? (info.flags && info.flags.bad_blocks) ?? 0);
  if (bb > 5) blockers.push(`vadné bloky flash ${bb} % — NAND umírá, zápis nové verze může zařízení umrtvit; nejdřív Netinstall/výměna`);
  else if (bb > 0.5) warnings.push(`vadné bloky flash ${bb} % (zdravé desky mají 0–0,1 %) — sleduj nárůst`);
  const symptoms = info.log_symptoms || [];
  const compromised = symptoms.filter(x => /login failure for user -2/i.test(x));
  if (compromised.length) warnings.push(`!!! v logu je „login failure for user -2" = otisk aktivně zneužívané SSH zranitelnosti (CVE 9/2026) — zařízení mohlo být kompromitováno, po upgradu zkontroluj device-mode „flagged" a cizí účty`);
  const hw = symptoms.filter(x => /kernel failure|bad block|NAND|out of memory/i.test(x));
  if (hw.length) warnings.push(`log hlásí podezření na HW/paměť (${hw[0].slice(0, 90)}${hw.length > 1 ? ` +${hw.length - 1}` : ''}) — upgrade může skončit Netinstallem`);
  const dm = info.device_mode || (info.flags && info.flags.device_mode);
  if (dm && dm.flagged) blockers.push('device-mode je FLAGGED — RouterOS detekoval možnou kompromitaci; nejdřív prověř zařízení (cizí účty, skripty, scheduler), pak `/system/device-mode/update flagged=no`');
  if ((info.fwf_files || []).length) warnings.push(`v kořeni routeru je cizí soubor RouterBOOT (${info.fwf_files.join(', ')}) — blokuje /system routerboard upgrade, smaž ho ručně`);
  if (info.uptime_sec > 300 * 86400) notes.push(`uptime ${Math.round(info.uptime_sec / 86400)} dní — komunita hlásí vyšší úspěšnost upgradu po preventivním restartu (fragmentace RAM)`);
  if (info.flags && info.flags.ssh_bruteforce_rules) notes.push(`firewall má ${info.flags.ssh_bruteforce_rules} pravidel brute-force ochrany SSH (address-list) — počítají NOVÁ spojení, ne špatná hesla; nástroj drží jedno spojení na položku a rozestup 65 s po restartu`);
  linkNotes(info, settings, notes, warnings);

  if (out.upToDate) return out;

  // hopy
  const hops = [];
  const routerMode = out.mode === 'router';
  if (tgt.major >= 7 && info.total_mem && info.total_mem < 60 * MB) {
    const msg = `jen ${(info.total_mem / MB).toFixed(0)} MB RAM — MikroTik: „should not run v7 on hardware that does not have at least 64 MB" (RB750/hAP lite: OOM bootloop); doporučeno zůstat na 6.49.x`;
    if (settings.allow_v7_low_ram || options.allow_v7_low_ram) warnings.push(msg + ' (POVOLENO nastavením)'); else blockers.push(msg + ' (blokováno, povol v nastavení)');
  }
  if (arch === 'smips' && tgt.major >= 7) warnings.push('smips (hAP lite/mini, cAP lite): v7 běží na 32 MB RAM bez rezervy, hotspot je od 7.20 samostatný balíček, CPU 100 % při skenu — komunita doporučuje 6.49.x');
  const fwV = V.parseVersion(info.fw_current);
  if (fwV && V.cmpVersion(fwV, '6.41.4') < 0 && out.firmware) warnings.push(`RouterBOOT ${info.fw_current} je starší než 6.41.4 — po upgradu bootloaderu ze starých verzí hlášeny bootloopy (RB750GL, RB2011, CCR1009); firmware se dělá až po ověřeném RouterOS, při potížích backup booter (reset ~3 s před napájením)`);
  const v7chan = track === 'v7-long-term' ? 'long-term' : 'stable';
  if (cur.major === 6 && tgt.major >= 7) {
    const v6lt = targetFor('v6-long-term', latest);
    let from = cur.str;
    if (v6lt && V.cmpVersion(cur, v6lt) < 0) { hops.push({ from, to: v6lt, majorJump: false, channel: 'long-term' }); from = v6lt; }
    if (routerMode) {
      // vlastní updater v6 nabízí v7 jen přes kanál "upgrade" (zastaralá 7.12.x) → pak další hop na cíl přes stable
      const v6up = targetFor('v6-upgrade', latest);
      if (!v6up) { blockers.push('neznámá verze kanálu "upgrade" pro v6 (upgrade.mikrotik.com)'); return out; }
      hops.push({ from, to: v6up, majorJump: true, channel: 'upgrade' });
      if (V.cmpVersion(v6up, target) < 0) hops.push({ from: v6up, to: target, majorJump: false, channel: v7chan });
    } else {
      const small = info.total_hdd && info.total_hdd <= 16.5 * MB;
      const v6up = targetFor('v6-upgrade', latest);
      if (small && settings.v7_via_712_small_flash && v6up && V.cmpVersion(v6up, target) < 0) {
        // 16MB zařízení: přechod přes 7.12.x (menší footprint; 6.4x→7.12+ přímo hlásí „not enough space for upgrade")
        hops.push({ from, to: v6up, majorJump: true, via: true });
        hops.push({ from: v6up, to: target, majorJump: false });
      } else {
        hops.push({ from, to: target, majorJump: true });
      }
    }
  } else if (cur.major === tgt.major) {
    if (tgt.major === 7 && NAND_LAYOUT_BOARDS.test(`${info.board_name || ''} ${info.model || ''}`) && V.cmpVersion(cur, '7.16.2') < 0 && V.cmpVersion(tgt, '7.20') >= 0 && !routerMode) {
      hops.push({ from: cur.str, to: '7.16.2', majorJump: false, via: true }, { from: '7.16.2', to: '7.18.2', majorJump: false, via: true }, { from: '7.18.2', to: target, majorJump: false, channel: v7chan });
      warnings.push(`${info.board_name}: z verzí pod 7.16.2 nejde přímo na 7.20+ (layout NAND, „free XXX kB disk space for a (null)upgrade") — plán jde přes 7.16.2 a 7.18.2`);
    } else hops.push({ from: cur.str, to: target, majorJump: false, channel: tgt.major >= 7 ? v7chan : 'long-term' });
  } else {
    blockers.push(`nepodporovaný přechod ${cur.str} → ${target}`);
    return out;
  }

  const hasFlashDir = !!(info.flags && info.flags.flash_dir) || (info.files || []).some(x => x.name === 'flash' && /dir/i.test(x.type));
  // migrační rizika 6 -> 7
  const f = info.flags || {};
  if (hops.some(h => h.majorJump)) {
    const risky = [];
    if (f.bgp) risky.push(`BGP (${f.bgp})`);
    if (f.ospf) risky.push(`OSPF (${f.ospf})`);
    if (f.routing_filter) risky.push(`routing filtry (${f.routing_filter})`);
    if (f.mpls) risky.push('MPLS/LDP');
    if (f.vpls) risky.push(`VPLS (${f.vpls})`);
    if (risky.length) {
      const msg = `přechod v6→v7 s dynamickým routingem: ${risky.join(', ')} — konfigurace se konvertuje, filtry/BGP vyžadují ruční kontrolu`;
      if (settings.allow_v7_routing_migration || options.allow_routing_migration) warnings.push(msg + ' (POVOLENO nastavením)');
      else blockers.push(msg + ' (blokováno, povol v nastavení nebo v jobu)');
    }
    if (f.capsman) warnings.push('CAPsMAN manager aktivní — po přechodu na v7 zkontroluj CAP zařízení');
    if (f.caps_client) warnings.push('zařízení je CAP klient (řízeno CAPsMANem)');
    if (info.total_hdd && info.total_hdd <= 16.5 * MB && !hasFlashDir) {
      const msg = `flash jen ${(info.total_hdd / MB).toFixed(0)} MB — v7 na 16MB zařízeních má minimum místa`;
      if (settings.allow_v7_small_flash || options.allow_small_flash) warnings.push(msg + ' (POVOLENO)');
      else blockers.push(msg + ' (blokováno, povol v nastavení nebo v jobu)');
    }
    if (f.scheduler) warnings.push(`na routeru je ${f.scheduler} plánovaných skriptů — v7 může změnit syntaxi`);
    if (f.vlan_filtering) warnings.push('bridge s vlan-filtering — v7 je u VLAN/bridge přísnější, po upgradu zkontroluj (typický důvod ztráty spojení po 6→7)');
    if (f.wifiwave2) blockers.push('wifiwave2 na v6? neočekávaný stav');
  }
  if (f.protected_routerboot) { warnings.push('protected-routerboot je zapnutý — při havárii NEPŮJDE Netinstall ani reset tlačítkem; upgrade RouterBOOT se u takového zařízení nedělá automaticky'); out.firmware = null; }
  const poeOut = (f.poe_ports || []).length;
  if (poeOut && hops.some(h => V.cmpVersion(h.from, '7.18') < 0 && V.cmpVersion(h.to, '7.18') >= 0)) warnings.push(`PoE-out (${poeOut} portů): od 7.18 je přísnější detekce zkratu (3–26,5 kΩ) — nestandardní napájená zařízení (ESP, DC-DC) mohou skončit jako short_circuit; workaround poe-out=forced-on. 7.19 navíc přehraje firmware PoE řadiče = krátký výpadek napájení dětí`);
  const sfpUp = (info.interfaces || []).filter(i => /^sfp/i.test(i.name) && i.running === 'true').map(i => i.name);
  if (sfpUp.length && hops.some(h => V.cmpVersion(h.from, '7.12') < 0 && V.cmpVersion(h.to, '7.12') >= 0)) warnings.push(`aktivní SFP (${sfpUp.join(', ')}): od 7.12 je vyžadována striktní MSA kompatibilita modulu — cizí moduly (GPON stick, fs.com) nemusí být po upgradu detekované; měj druhou cestu k zařízení`);
  if (f.fw_auto_upgrade) warnings.push('router má /system routerboard settings auto-upgrade=yes — po upgradu se sám restartuje podruhé kvůli firmware (nástroj s tím počítá)');
  const volt = parseFloat(f.voltage);
  if (Number.isFinite(volt) && volt > 0 && volt < 11) warnings.push(`nízké napájecí napětí ${volt} V — riziko výpadku napájení během zápisu`);
  const partsList = info.partitions || f.partitions_list || [];
  if (partsList.some(x => x.active && !x.running)) blockers.push('aktivní oddíl (/partitions) není ten běžící — po restartu by nabootoval jiný systém; sjednoť ručně (activate běžící oddíl)');
  if (partsList.length >= 2) {
    const backup = partsList.find(x => !x.running);
    if (settings.use_partition_fallback && backup) warnings.push(`zařízení má ${partsList.length} oddíly — před upgradem se běžící systém zkopíruje do oddílu „${backup.name}" jako fallback při nenabootování`);
  } else if (info.total_hdd >= 128 * MB) {
    warnings.push('flash ≥128 MB, ale jen 1 oddíl — zvaž ruční „/partitions repartition 2" (maže data, restart), pak upgrade získá automatický fallback při nenabootování');
  }
  // stáří verze a zakázané verze
  const badList = String(settings.bad_versions || '').split(/[\s,;]+/).filter(Boolean);
  const board = `${info.board_name || ''} ${info.model || ''}`;
  const hasW60g = (f.w60g || 0) > 0 || ((info.links && info.links.w60g) || (f.links && f.links.w60g) || []).length > 0;
  for (const hop of hops) {
    if (badList.includes(hop.to)) blockers.push(`verze ${hop.to} je v seznamu zakázaných verzí`);
    if (GLOBAL_BAD[hop.to] && !hop.via) blockers.push(`verze ${hop.to} má známou regresi: ${GLOBAL_BAD[hop.to]}`);
    for (const kb of KNOWN_BAD) {
      const applies = (kb.key === 'w60g' && hasW60g) || (kb.board && kb.board.test(board)) || (kb.arch && kb.arch === arch);
      if (!applies) continue;
      if (kb.versions.includes(hop.to)) blockers.push(`verze ${hop.to} je pro tento HW riziková: ${kb.why}`);
      if (kb.firmwareWarn && out.firmware && !warnings.includes(kb.firmwareWarn)) warnings.push(kb.firmwareWarn);
      if (kb.warn && !warnings.includes(kb.warn)) warnings.push(kb.warn);
    }
    const hv0 = V.parseVersion(hop.to);
    const ts = releaseTs(hop.to, latest);
    const ageDays = ts ? (Date.now() / 1000 - ts) / 86400 : null;
    if (ageDays !== null && settings.min_release_age_days > 0 && ageDays < settings.min_release_age_days) blockers.push(`verze ${hop.to} vyšla teprve před ${ageDays.toFixed(1)} dny (limit ${settings.min_release_age_days} dní v nastavení) — čerstvé verze mívají bootloopy/kernel chyby, počkej nebo sniž limit`);
    // x.y.0 = první vydání větve: od 7.13 dostala každá do 1–14 dní opravnou x.y.1 (regrese „introduced in vX.Y")
    if (hv0 && hv0.patch === 0 && !hv0.pre && !hop.via && (settings.zero_release_min_days || 0) > 0) {
      if (ageDays === null) warnings.push(`verze ${hop.to} je první vydání větve (x.y.0) a datum vydání není známé — takové verze mívají regrese opravené během dní`);
      else if (ageDays < settings.zero_release_min_days) blockers.push(`verze ${hop.to} je první vydání větve (x.y.0) stará ${ageDays.toFixed(1)} dne (limit ${settings.zero_release_min_days} dní) — od 7.13 dostala každá x.y.0 do 14 dní opravnou x.y.1; počkej na ni`);
    }
  }

  // balíčky pro každý hop — seznam se odvíjí od stavu po předchozím hopu
  let curPkgs = (info.packages || []).filter(p => !p.disabled).map(p => p.name);
  const disabledPk = (info.packages || []).filter(p => p.disabled).map(p => p.name);
  const links = info.links || (f.links) || null;
  const legacyCapsman = !!(links && links.capsman && links.capsman.kind === 'legacy') || (!links && !!f.capsman && cur.major === 6);
  // balíček wireless je od 7.13 nutný i pro legacy CAPsMAN kontrolér bez vlastního rádia (CCR, RB4011, CHR) — jinak zmizí /caps-man a všechny CAPy
  const hasWlan = (f.wireless || 0) > 0 || (f.w60g || 0) > 0 || legacyCapsman;
  if (legacyCapsman && !(f.wireless || 0) && !(f.w60g || 0)) notes.push('legacy CAPsMAN kontrolér bez vlastního rádia — na 7.13+ se přikládá balíček wireless (jinak zmizí /caps-man)');
  for (const hop of hops) {
    const hv = V.parseVersion(hop.to);
    const fromV = V.parseVersion(hop.from);
    const archs = hv.major >= 7 ? V.ARCH_V7 : V.ARCH_V6;
    if (!archs.includes(arch)) { blockers.push(`architektura "${arch}" nemá balíčky pro RouterOS ${hop.to}`); continue; }
    const names = ['routeros'];
    if (fromV.major === 6 && hv.major >= 7) {
      for (const p of curPkgs) {
        if (p === 'routeros' || p.startsWith('routeros-') || V.V6_IN_V7_BUNDLE.has(p)) continue;
        if (p === 'wireless' && V.cmpVersion(hop.to, '7.13') < 0) continue; // do 7.12 je wireless součást bundle
        if (V.V7_EXTRA.has(p)) names.push(p);
        else if (V.V6_DROPPED_IN_V7.has(p)) warnings.push(`balíček "${p}" ve v7 neexistuje — bude zahozen`);
        else warnings.push(`neznámý v6 balíček "${p}" — nebude přenesen do v7`);
      }
      if ((curPkgs.includes('wireless') || hasWlan) && !names.includes('wireless') && V.cmpVersion(hop.to, '7.13') >= 0) names.push('wireless');
      if (disabledPk.includes('wireless') && hasWlan) warnings.push('wireless balíček je vypnutý, ale existují wlan rozhraní');
      curPkgs = [...names];
    } else if (hv.major >= 7) {
      for (const p of curPkgs) {
        if (p === 'routeros' || p.startsWith('routeros-')) continue;
        if (p === 'wifiwave2' && V.cmpVersion(hop.to, '7.13') >= 0) { blockers.push('balíček wifiwave2 byl v 7.13 nahrazen wifi-qcom/wifi-qcom-ac podle HW — upgrade proveď ručně nebo režimem „router"'); continue; }
        names.push(p);
      }
      // 7.13+ má wireless (i 60GHz) mimo bundle: při skoku z <7.13 přidat podle rozhraní
      if (V.cmpVersion(fromV, '7.13') < 0 && V.cmpVersion(hop.to, '7.13') >= 0 && !names.includes('wireless') && hasWlan) {
        names.push('wireless');
        warnings.push(`přechod přes 7.13: přidán balíček wireless (zařízení má ${(f.wireless || 0)} wlan + ${(f.w60g || 0)} 60GHz rozhraní)`);
      }
      curPkgs = [...names];
    } else {
      for (const p of curPkgs) {
        if (p === 'routeros' || p.startsWith('routeros-') || V6_BUNDLE.has(p)) continue;
        names.push(p);
      }
    }
    if (names.includes('wireless') && names.some(n => /^wifi-qcom/.test(n))) blockers.push('balíčky wireless a wifi-qcom(-ac) nesmí být nainstalované současně (7.18+ to odmítne) — sjednoť ovladač ručně');
    hop.packages = [];
    let need = 0;
    for (const n of names) {
      try {
        const pi = await V.packageInfo(n, hop.to, arch);
        if (!pi.exists) {
          if (routerMode) { if (n === 'routeros') warnings.push(`balíček ${pi.file} na download.mikrotik.com nenalezen (kontrola velikosti nebude)`); continue; }
          blockers.push(`balíček ${pi.file} pro ${hop.to} na download.mikrotik.com neexistuje`); continue;
        }
        hop.packages.push({ name: n, file: pi.file, url: pi.url, size: pi.size });
        need += pi.size;
      } catch (e) { blockers.push(e.message); }
    }
    hop.needBytes = need + Math.round((settings.space_margin_mb || 0) * MB);
    const smallFlash = info.total_hdd && info.total_hdd <= 16.5 * MB;
    // zařízení s adresářem "flash" mají kořen v RAM — balíček se nahrává do RAM, instaluje se do flash na místě
    if (hasFlashDir) {
      hop.stagingArea = 'ram';
      hop.freeBytes = info.free_mem;
      if (info.free_mem && hop.needBytes + 8 * MB > info.free_mem) {
        blockers.push(`nedostatek volné RAM pro nahrání ${hop.to}: volné ${(info.free_mem / MB).toFixed(1)} MB, potřeba ${((hop.needBytes + 8 * MB) / MB).toFixed(1)} MB (kořen FS je v RAM)`);
      }
    } else {
      hop.stagingArea = 'flash';
      hop.freeBytes = info.free_hdd;
      if (info.free_hdd && hop.needBytes > info.free_hdd) {
        const msg = `ve flash není místo pro ${hop.to}: volné ${(info.free_hdd / MB).toFixed(1)} MB, potřeba ${(hop.needBytes / MB).toFixed(1)} MB (balíčky ${(need / MB).toFixed(1)} MB + rezerva)`;
        if (routerMode) warnings.push(msg + ' — o stažení rozhodne updater routeru (při nedostatku místa skončí chybou bez restartu)');
        else if (smallFlash) {
          if (hop === hops[0]) warnings.push(msg + ' — 16MB zařízení: balíček se zkusí nahrát (RouterOS ho má odložit do RAM); pokud nahrání selže, job se bezpečně zastaví bez restartu');
          if (info.free_mem && hop.needBytes + 8 * MB > info.free_mem) blockers.push(`málo volné RAM pro odložení balíčku: ${(info.free_mem / MB).toFixed(1)} MB`);
        } else blockers.push(msg + ' — uvolni místo (staré zálohy, soubory) nebo Netinstall');
      }
    }
  }
  out.hops = hops;
  return out;
}

/** poznámky a varování k bezdrátovým spojům (aby se po upgradu neuřízla anténa od sektoru) */
function linkNotes(info, settings, notes, warnings) {
  const links = info.links || (info.flags && info.flags.links);
  if (!links) return;
  const pct = settings.link_return_pct || 80, wait = settings.link_wait_min || 12;
  for (const s of links.stations || []) {
    if (!s.ap) { warnings.push(`stanice ${s.iface} (${s.protocol || '?'}, ${s.mode}) není teď připojená k žádnému AP — po restartu nepůjde ověřit obnovení spoje`); continue; }
    notes.push(`stanice ${s.iface} (${s.mode}, ${s.protocol || '?'}, ${s.band || ''}) je na AP ${s.ap.mac}${s.ap.version ? ` (ROS ${s.ap.version})` : ''}, signál ${s.ap.signal ?? '?'} dBm — po restartu se čeká až ${wait} min na opětovnou registraci ke stejnému AP`);
    if (s.protocol === 'nv2') notes.push(`stanice ${s.iface} má wireless-protocol=nv2 striktně — pokud AP po svém upgradu nv2 nenabízí, spoj se rozpadne (odolnější je nv2-nstreme-802.11)`);
    if (/station-bridge|station-wds/.test(s.mode)) notes.push(`stanice ${s.iface} v režimu ${s.mode}: funguje jen wireless↔wireless (nebo wifi↔wifi) — ovladač se nikdy nemění`);
  }
  for (const a of links.aps || []) {
    if (!a.clients.length) continue;
    const vers = [...new Set(a.clients.map(c => c.version).filter(Boolean))];
    notes.push(`sektor ${a.iface} (${a.protocol || '?'}, ${a.band || ''}): ${a.clients.length} klientů${vers.length ? ` (ROS ${vers.join(', ')})` : ''} — po restartu se čeká až ${wait} min na návrat ≥ ${pct} % klientů, jinak položka selže a job se zastaví`);
    if (/dfs|5ghz/i.test(a.band || '')) notes.push(`sektor ${a.iface} na 5 GHz: na DFS kanálu trvá po restartu kontrola radaru 1–10 min, než se klienti mohou vrátit (počítá se s tím)`);
  }
  for (const w of links.w60g || []) {
    if (w.connected === false) { warnings.push(`60 GHz ${w.iface} (${w.mode}) není teď spojené — po restartu nepůjde ověřit obnovení spoje`); continue; }
    if (w.connected === null) continue;
    const peers = (w.stations || []).map(x => `${x.mac}${x.mcs !== null ? ` MCS ${x.mcs}` : ''}${x.rssi !== null ? ` ${x.rssi} dBm` : ''}`);
    notes.push(`60 GHz ${w.iface} (${w.mode}, ${w.frequency || 'auto'}): ${peers.length} protějšek(ů) [${peers.join('; ')}] — po restartu se ověří spojení, MCS ≥ 1 a návrat protějšků; oba konce spoje mají být na stejné verzi v jednom okně`);
    if (w.mcs !== null && w.mcs < 1) warnings.push(`60 GHz ${w.iface} má už teď MCS 0 (spoj bez datové rychlosti) — vyřeš před upgradem`);
  }
  if (links.cap) notes.push(`zařízení je CAP (${links.cap.kind}) řízený CAPsMAN ${links.cap.manager || '?'} — CAPy se upgradují před kontrolérem; po restartu se ověří registrace u CAPsMAN`);
  if (links.capsman) {
    const pol = links.capsman.upgrade_policy || '';
    if (/require-same-version|suggest-same-version/.test(pol)) warnings.push(`CAPsMAN (${links.capsman.kind}) má upgrade-policy=${pol}: po upgradu kontroléru by sám upgradoval/odmítl ${links.capsman.caps} CAPů mimo tento nástroj — na dobu jobu nastav upgrade-policy=none`);
    else notes.push(`CAPsMAN kontrolér (${links.capsman.kind}, ${links.capsman.caps} CAPů) — restart kontroléru = výpadek všech CAP sektorů; CAPy upgraduj dřív`);
  }
  if (links.driver === 'mixed') warnings.push('zařízení má současně rozhraní wireless i wifi — neobvyklý stav, zkontroluj balíčky');
}

module.exports = { plan, targetFor, linkNotes, KNOWN_BAD, GLOBAL_BAD };
