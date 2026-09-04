'use strict';
// Plán upgradu pro jedno zařízení: hopy (6.x -> 6.49.x -> 7.x), balíčky, místo, blokátory a varování.
const V = require('./versions');

const MB = 1048576;
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
  const blockers = [], warnings = [];
  const out = { track, blockers, warnings, hops: [], firmware: null, current: info.version, target: null, mode: options.mode || 'upload' };

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

  if (out.upToDate) return out;

  // hopy
  const hops = [];
  const routerMode = out.mode === 'router';
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
    hops.push({ from: cur.str, to: target, majorJump: false, channel: tgt.major >= 7 ? v7chan : 'long-term' });
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
  if (f.protected_routerboot) warnings.push('protected-routerboot je zapnutý — při havárii NEPŮJDE Netinstall ani reset tlačítkem');
  if (f.fw_auto_upgrade) warnings.push('router má /system routerboard settings auto-upgrade=yes — po upgradu se sám restartuje podruhé kvůli firmware (nástroj s tím počítá)');
  const volt = parseFloat(f.voltage);
  if (Number.isFinite(volt) && volt > 0 && volt < 11) warnings.push(`nízké napájecí napětí ${volt} V — riziko výpadku napájení během zápisu`);
  const partsList = info.partitions || f.partitions_list || [];
  if (partsList.length >= 2) {
    const backup = partsList.find(x => !x.running);
    if (settings.use_partition_fallback && backup) warnings.push(`zařízení má ${partsList.length} oddíly — před upgradem se běžící systém zkopíruje do oddílu „${backup.name}" jako fallback při nenabootování`);
  } else if (info.total_hdd >= 128 * MB) {
    warnings.push('flash ≥128 MB, ale jen 1 oddíl — zvaž ruční „/partitions repartition 2" (maže data, restart), pak upgrade získá automatický fallback při nenabootování');
  }
  // stáří verze a zakázané verze
  const badList = String(settings.bad_versions || '').split(/[\s,;]+/).filter(Boolean);
  for (const hop of hops) {
    if (badList.includes(hop.to)) blockers.push(`verze ${hop.to} je v seznamu zakázaných verzí`);
    const ts = releaseTs(hop.to, latest);
    if (ts && settings.min_release_age_days > 0) {
      const ageDays = (Date.now() / 1000 - ts) / 86400;
      if (ageDays < settings.min_release_age_days) blockers.push(`verze ${hop.to} vyšla teprve před ${ageDays.toFixed(1)} dny (limit ${settings.min_release_age_days} dní v nastavení) — čerstvé verze mívají bootloopy/kernel chyby, počkej nebo sniž limit`);
    }
  }

  // balíčky pro každý hop — seznam se odvíjí od stavu po předchozím hopu
  let curPkgs = (info.packages || []).filter(p => !p.disabled).map(p => p.name);
  const disabledPk = (info.packages || []).filter(p => p.disabled).map(p => p.name);
  const hasWlan = (f.wireless || 0) > 0 || (f.w60g || 0) > 0;
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

module.exports = { plan, targetFor };
