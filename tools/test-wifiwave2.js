// Regresní test: wifiwave2 (do 7.12) → od 7.13 wifi-qcom (ax) / wifi-qcom-ac (ac) podle desky; plán balíček přidá místo blokátoru, neznámá deska blokuje.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-ww2-');
const V = require('../lib/versions');
const { plan, wifiQcomFor } = require('../lib/planner');
const MB = 1024 * 1024;
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
const cases = [
  ['hAP ax lite', 'L41G-2axD', 'wifi-qcom'], ['hAP ax lite LTE6', 'L41G-2axD&FG621-EA', 'wifi-qcom'], ['hAP ax^2', 'C52iG-5HaxD2HaxD', 'wifi-qcom'], ['hAP ax^3', 'C53UiG+5HPaxD2HPaxD', 'wifi-qcom'],
  ['hAP ax³', '', 'wifi-qcom'], ['cAP ax', 'cAPGi-5HaxD2HaxD', 'wifi-qcom'], ['Chateau 5G ax', 'S53UG+5HaxD2HaxD-TC&RG502Q-EA', 'wifi-qcom'], ['wAP ax', 'wAPG-5HaxD2HaxD', 'wifi-qcom'],
  ['hAP ac^2', 'RBD52G-5HacD2HnD', 'wifi-qcom-ac'], ['hAP ac³', 'RBD53iG-5HacD2HnD', 'wifi-qcom-ac'], ['Audience', 'RBD25G-5HPacQD2HPnD', 'wifi-qcom-ac'], ['cAP ac', 'RBcAPGi-5acD2nD', 'wifi-qcom-ac'],
  ['wAP ac', 'RBwAPG-5HacD2HnD', 'wifi-qcom-ac'], ['Chateau LTE12', 'D53G-5HacD2HnD', 'wifi-qcom-ac'],
  ['hEX S', 'RB760iGS', null], ['mAP lite', 'RBmAPL-2nD', null], ['', '', null],
];
for (const [board_name, model, want] of cases) check(wifiQcomFor({ board_name, model }) === want, `${board_name || '(prázdné)'} ${model} → ${want}`);
(async () => {
  const origPI = V.packageInfo;
  V.packageInfo = async (n, ver, arch) => ({ exists: n !== 'wifiwave2', file: `${n}-${ver}-${arch}.npk`, url: 'x', size: (n === 'routeros' ? 12.5 : 9.8) * MB });
  const latest = { versions: { 'v7-long-term': { version: '7.23.8' }, 'v6-long-term': { version: '6.49.23' } } };
  const dev = (board_name, model) => ({ version: '7.7', arch: 'arm', board_name, model, routerboard: true, fw_current: '7.7', fw_upgrade: '7.7', total_hdd: 129 * MB, free_hdd: 93.9 * MB, total_mem: 256 * MB, free_mem: 85 * MB, uptime_sec: 999999, cpu_load: 3,
    packages: [{ name: 'wifiwave2', version: '7.7', disabled: false }, { name: 'routeros', version: '7.7', disabled: false }], interfaces: [], flags: { wifiwave2: 2 }, links: [], files: [], npk_files: [], fwf_files: [] });
  const settings = { space_margin_mb: 0 };
  let p = await plan(dev('hAP ax lite', 'L41G-2axD'), { track: 'v7-long-term', settings, latest, options: {} });
  const last = p.hops[p.hops.length - 1] || {};
  check(p.blockers.length === 0 && (last.packages || []).map(x => x.name).sort().join(',') === 'routeros,wifi-qcom' && p.notes.some(w => /wifiwave2 byl v 7\.13 rozdělen .* nahraje wifi-qcom,/.test(w)), 'hAP ax lite 7.7 → 7.23.8: routeros + wifi-qcom, bez blokátoru: ' + JSON.stringify({ b: p.blockers, pk: (last.packages || []).map(x => x.name), hops: p.hops.map(h => h.from + '→' + h.to) }));
  p = await plan(dev('hAP ac^2', 'RBD52G-5HacD2HnD'), { track: 'v7-long-term', settings, latest, options: {} });
  check(p.blockers.length === 0 && (p.hops[p.hops.length - 1].packages || []).some(x => x.name === 'wifi-qcom-ac'), 'hAP ac² s wifiwave2: wifi-qcom-ac');
  p = await plan(dev('Neznámá deska', 'XYZ-1'), { track: 'v7-long-term', settings, latest, options: {} });
  check(p.blockers.some(b => /wifiwave2 .*nejde poznat/.test(b)), 'neznámá deska: blokátor zůstává');
  p = await plan({ ...dev('hAP ax lite', 'L41G-2axD'), version: '7.14.2', packages: [{ name: 'wifi-qcom', version: '7.14.2' }, { name: 'routeros', version: '7.14.2' }], fw_current: '7.14.2', fw_upgrade: '7.14.2' }, { track: 'v7-long-term', settings, latest, options: {} });
  check(p.blockers.length === 0 && (p.hops[0].packages || []).map(x => x.name).sort().join(',') === 'routeros,wifi-qcom', 'už s wifi-qcom: beze změny');
  V.packageInfo = origPI;
  console.log(bad ? `SELHALO: ${bad}` : 'wifiwave2 OK');
  process.exit(bad ? 1 : 0);
})();
