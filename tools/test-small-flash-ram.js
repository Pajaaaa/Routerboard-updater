// Regresní test (20.11.2026): hAP lite (smips, 32 MB RAM, 16 MB flash bez adresáře flash/) — nahraný balíček jde přímo do flash, volnou RAM
// nezabírá. Dřívější pojistka „balíček + 8 MB volné RAM“ takový kus blokovala vždy (10.107.35.166: 8,0 MB volné, potřeba 16,1 MB).
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-sfr-');
const V = require('../lib/versions');
const { plan } = require('../lib/planner');
const MB = 1024 * 1024;
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
(async () => {
  const SIZES = { system: 5585069, wireless: 737425, security: 323729, ppp: 258193, dhcp: 155793, hotspot: 143505, routing: 69777, 'advanced-tools': 69777, mpls: 57489, ipv6: 200000, 'routeros-smips': 7600000 };
  V.packageInfo = async (n, ver, arch) => { const file = `${n}-${ver}-${arch}.npk`; return { exists: true, file, url: 'x/' + file, size: SIZES[n] || 100000 }; };
  const latest = { versions: { 'v6-long-term': { version: '6.49.23' }, 'v7-long-term': { version: '7.24.6' } } };
  const off = new Set(['ipv6', 'hotspot', 'mpls', 'routing', 'ppp']);
  const dev = (o = {}) => ({ version: '6.49.21', arch: 'smips', board_name: 'hAP lite', model: 'RB941-2nD', routerboard: true, fw_current: '6.49.21', fw_upgrade: '6.49.21',
    total_hdd: 16 * MB, free_hdd: 7.6 * MB, total_mem: 32 * MB, free_mem: 8 * MB, uptime_sec: 999999, cpu_load: 5,
    packages: ['routeros-smips', 'system', 'ipv6', 'wireless', 'hotspot', 'mpls', 'routing', 'ppp', 'dhcp', 'security', 'advanced-tools'].map(name => ({ name, version: o.version || '6.49.21', disabled: off.has(name) })),
    interfaces: [], flags: {}, links: [], files: [], npk_files: [], fwf_files: [], pkgupdate: { channel: 'long-term', installed: o.version || '6.49.21', latest: '', status: '' }, ...o });
  const settings = { space_margin_mb: 1.5, min_free_mem_mb: 8, allow_v7_small_flash: true, old_small_flash_split: true };
  const run = (d, s = settings, options = { ignore_uptime: true }) => plan(d, { track: 'v6-long-term', settings: s, latest, options });
  const ram = (p) => p.blockers.filter(b => /RAM pro odložení|RAM pro nahrání/.test(b));

  let p = await run(dev());
  check(p.hops.length === 1 && p.hops[0].stagingArea === 'flash' && !ram(p).length, 'bez flash/: balíček jde do flash, pojistka RAM pro balíček neplatí: ' + JSON.stringify(p.blockers));
  p = await run(dev({ version: '6.44.6' }));
  check(!ram(p).length && !p.blockers.length, '6.44.6 (samostatné balíčky 6,6 MB do 7,6 MB flash): bez blokátoru RAM i místa: ' + JSON.stringify(p.blockers));
  check(p.warnings.some(w => /ve flash není místo.*POVOLENO/.test(w)), 'těsná flash zůstává jako upozornění (povoleno v nastavení)');
  p = await run(dev(), { ...settings, allow_v7_small_flash: false });
  check(p.blockers.some(b => /ve flash není místo.*blokováno/.test(b)) && !ram(p).length, 'bez povolení v nastavení dál blokuje těsná flash (ne RAM)');
  p = await run(dev({ free_mem: 4 * MB }));
  check(p.blockers.some(b => /^málo volné RAM: /.test(b)), 'obecné minimum volné RAM platí dál');
  p = await run(dev({ flags: { flash_dir: 1 } }));
  check(p.hops[0].stagingArea === 'ram' && ram(p).length === 1, 's adresářem flash/ (kořen v RAM) pojistka RAM pro nahrání zůstává');
  console.log(bad ? `\n${bad} kontrol selhalo` : '\nvše OK'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
