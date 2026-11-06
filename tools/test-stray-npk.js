// Regresní test: cizí .npk v kořeni zařízení — planner je vrátí ve strayFiles (ostrý běh blokátor, dry run upozornění, balíčky cílové
// verze se nechají), runner je smaže, ověří výpisem /file a při „Downloaded“ obnoví stav updateru (6.11.2026).
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-stray-');
const { Runner } = require('../lib/runner');
const V = require('../lib/versions');
const { plan } = require('../lib/planner');
const MB = 1024 * 1024;
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
(async () => {
  const origPI = V.packageInfo;
  V.packageInfo = async (n, ver, arch) => { const file = `${n}-${ver}-${arch}.npk`; return { exists: true, file, url: 'x/' + file, size: 12 * MB }; };
  const latest = { versions: { 'v7-long-term': { version: '7.24.5' }, 'v6-long-term': { version: '6.49.23' } } };
  const dev = (npk, pkgupdate) => ({ version: '7.20.1', arch: 'arm', board_name: 'hAP ac2', model: 'RBD52G-5HacD2HnD', routerboard: true, fw_current: '7.20.1', fw_upgrade: '7.20.1',
    total_hdd: 16 * MB, free_hdd: 4 * MB, total_mem: 128 * MB, free_mem: 80 * MB, uptime_sec: 999999, cpu_load: 5,
    packages: [{ name: 'routeros', version: '7.20.1', disabled: false }], interfaces: [], flags: {}, links: [], files: [], npk_files: npk.map(name => ({ name, type: 'package', size: 1 })), fwf_files: [],
    pkgupdate: pkgupdate || { channel: 'long-term', installed: '7.20.1', latest: '', status: '' } });
  const settings = { space_margin_mb: 0 };
  let p = await plan(dev(['routeros-7.19.4-arm.npk', 'wifi-qcom-ac-7.19.4-arm.npk']), { track: 'v7-long-term', settings, latest, options: {} });
  check(p.strayFiles && p.strayFiles.join(',') === 'routeros-7.19.4-arm.npk,wifi-qcom-ac-7.19.4-arm.npk' && p.blockers.some(b => /cizí balíčky \.npk .*nástroj je smaže a pokračuje/.test(b)), 'ostrý běh: cizí balíčky = strayFiles + blokátor: ' + JSON.stringify(p.blockers));
  p = await plan(dev(['routeros-7.19.4-arm.npk']), { track: 'v7-long-term', settings, latest, options: { dry_run: true } });
  check(p.strayFiles.length === 1 && !p.blockers.some(b => /cizí balíčky/.test(b)) && p.warnings.some(w => /cizí balíčky \.npk .*při ostrém běhu je nástroj před upgradem smaže/.test(w)), 'dry run: jen upozornění, ne blokátor');
  p = await plan(dev(['routeros-7.24.5-arm.npk']), { track: 'v7-long-term', settings, latest, options: {} });
  check(!p.strayFiles && !p.blockers.some(b => /cizí balíčky/.test(b)) && p.notes.some(n => /už jsou balíčky 7\.24\.5/.test(n)), 'balíček cílové verze není cizí — použije se');
  p = await plan(dev(['routeros-7.24.5-arm.npk', 'flash/lora-7.19.4-arm.npk']), { track: 'v7-long-term', settings, latest, options: {} });
  check(p.strayFiles && p.strayFiles.join(',') === 'flash/lora-7.19.4-arm.npk', 'smíšený kořen: do strayFiles jde jen balíček jiné verze');
  p = await plan(dev([]), { track: 'v7-long-term', settings, latest, options: {} });
  check(!p.strayFiles && !p.blockers.some(b => /cizí/.test(b)), 'prázdný kořen: nic');
  V.packageInfo = origPI;

  // mazání s falešným klientem
  const r = Object.create(Runner.prototype);
  const mk = (leftover) => { const cmds = [], log = []; const fake = { exec: async (cmd) => { cmds.push(cmd); return ''; }, listPatient: async () => leftover.map(name => ({ name, type: 'package' })) }; return { cmds, log, fake, L: (lv, m) => log.push(lv + ': ' + m), W: (m) => log.push('warn: ' + m) }; };
  let t = mk([]);
  let res = await r.removeStrayPackages(t.fake, ['routeros-7.19.4-arm.npk', 'flash/lora-7.19.4-arm.npk'], { status: '' }, t.L, t.W);
  check(t.cmds.join('|') === '/file remove "routeros-7.19.4-arm.npk"|/file remove "flash/lora-7.19.4-arm.npk"' && res.removed.length === 2 && res.left.length === 0 && t.log.some(l => /info: cizí balíčky smazány z kořene zařízení: routeros-7\.19\.4-arm\.npk, flash\/lora/.test(l)), 'oba soubory smazány, bez check-for-updates: ' + t.cmds.join(' | '));
  t = mk(['flash/lora-7.19.4-arm.npk']);
  res = await r.removeStrayPackages(t.fake, ['routeros-7.19.4-arm.npk', 'flash/lora-7.19.4-arm.npk'], null, t.L, t.W);
  check(res.removed.join(',') === 'routeros-7.19.4-arm.npk' && res.left.join(',') === 'flash/lora-7.19.4-arm.npk' && t.log.some(l => /warn: cizí balíčky na zařízení zůstaly: flash\/lora/.test(l)), 'co ve výpisu zůstalo, hlásí se jako left');
  t = mk([]);
  res = await r.removeStrayPackages(t.fake, ['routeros-7.19.4-arm.npk'], { status: 'Downloaded', latest: '7.19.4' }, t.L, t.W);
  check(t.cmds.length === 2 && t.cmds[1] === '/system package update check-for-updates' && t.log.some(l => /stav vlastního updateru zařízení obnoven/.test(l)), 'po „Downloaded“ se obnoví stav updateru');
  t = mk([]); t.fake.exec = async (cmd) => { t.cmds.push(cmd); if (/remove/.test(cmd)) throw new Error('Not connected'); return ''; };
  res = await r.removeStrayPackages(t.fake, ['a.npk'], null, t.L, t.W);
  check(res.removed.length === 1 && t.log.some(l => /warn: cizí balíček a\.npk: mazání selhalo/.test(l)), 'chyba příkazu se zaloguje, rozhoduje výpis /file');
  t = mk([]); t.fake.listPatient = async () => { throw new Error('timeout'); };
  res = await r.removeStrayPackages(t.fake, ['a.npk'], null, t.L, t.W);
  check(res.removed.length === 0 && res.left.join(',') === 'a.npk', 'bez výpisu /file se nic nepovažuje za smazané');
  console.log(bad ? `SELHALO: ${bad}` : 'vše OK');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
