// Regresní test oprav plánovače z revize 21.11.2026: v7 kus s kanálem v6, práh NAND 7.18.2, flagged v6 přes 7.12.x,
// RB600/RB800 bez v7, AH verze RB4xx smí v7, balíček wireless jen s rádiem.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-rvp-');
const V = require('../lib/versions');
V.packageInfo = async (n, ver, arch) => { const file = `${n}-${ver}-${arch}.npk`; return { exists: true, file, url: 'x/' + file, size: /^routeros/.test(n) ? 7000000 : 300000 }; };
const { plan } = require('../lib/planner');
const MB = 1048576;
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); if (!ok) bad++; };
(async () => {
  const latest = { versions: { 'v6-long-term': { version: '6.49.23' }, 'v7-long-term': { version: '7.24.6' }, 'v7-stable': { version: '7.24.6' }, 'v6-upgrade': { version: '7.12.1' } } };
  const dev = (o = {}) => ({ version: '7.24.2', arch: 'arm', board_name: 'RB4011iGS+', model: 'RB4011iGS+', routerboard: true, fw_current: 'x', fw_upgrade: 'x',
    total_hdd: 512 * MB, free_hdd: 400 * MB, total_mem: 1024 * MB, free_mem: 800 * MB, uptime_sec: 999999, cpu_load: 5,
    packages: [{ name: 'routeros', version: o.version || '7.24.2', disabled: false }], interfaces: [], flags: {}, links: [], files: [], npk_files: [], fwf_files: [], ...o });
  const v6pk = (v, extra = []) => ['routeros-mipsbe', 'system', 'dhcp', 'security', 'advanced-tools', ...extra].map(name => ({ name, version: v, disabled: false }));
  const settings = { space_margin_mb: 1.5, min_free_mem_mb: 8, v7_via_712_small_flash: true, allow_v7_small_flash: true };
  const run = (d, track = 'v7-long-term', s = settings, options = { ignore_uptime: true }) => plan(d, { track, settings: s, latest, options });

  let p = await run(dev(), 'v6-long-term');
  check(!p.blockers.length && p.target === '7.24.6' && p.track === 'v7-long-term', 'v7 kus s kanálem v6 jede po v7 long-term (ne „downgrade se nedělá“): ' + JSON.stringify(p.blockers));

  p = await run(dev({ version: '7.16.2', board_name: 'RB450Gx4', model: 'RB450Gx4' }));
  check(p.hops.map(h => h.to).join('>') === '7.18.2>7.24.6', 'RB450Gx4 ze 7.16.2 jde přes 7.18.2: ' + p.hops.map(h => h.to).join('>'));
  p = await run(dev({ version: '7.15.3', board_name: 'RB450Gx4', model: 'RB450Gx4' }));
  check(p.hops.map(h => h.to).join('>') === '7.16.2>7.18.2>7.24.6', 'RB450Gx4 ze 7.15.3 jde přes 7.16.2 a 7.18.2: ' + p.hops.map(h => h.to).join('>'));
  p = await run(dev({ version: '7.18.2', board_name: 'RB450Gx4', model: 'RB450Gx4' }));
  check(p.hops.length === 1, 'RB450Gx4 ze 7.18.2 jde přímo');

  const small = { version: '6.49.21', arch: 'mipsbe', board_name: 'LHG 5nD', model: 'RBLHG-5nD', total_hdd: 16 * MB, free_hdd: 7.5 * MB, total_mem: 64 * MB, free_mem: 40 * MB, packages: v6pk('6.49.21', ['wireless']), flags: { wireless: 1 } };
  p = await run(dev({ ...small, device_mode: { flagged: true } }), 'v7-long-term', settings, { ignore_uptime: true, ignore_flagged: true });
  check(p.blockers.some(b => /FLAGGED a cesta vede přes mezikrok 7\.12/.test(b)), 'flagged v6 kus s cestou přes 7.12.1 je blokován předem');
  p = await run(dev({ ...small, total_hdd: 128 * MB, free_hdd: 100 * MB, device_mode: { flagged: true } }), 'v7-long-term', settings, { ignore_uptime: true, ignore_flagged: true });
  check(!p.blockers.some(b => /mezikrok 7\.12/.test(b)), 'flagged v6 kus s přímou cestou tenhle blokátor nedostane');

  for (const b of ['RB800', 'RB600A']) {
    p = await run(dev({ version: '6.49.23', arch: 'powerpc', board_name: b, model: b, total_mem: 256 * MB, packages: v6pk('6.49.23') }));
    check(p.track === 'v6-long-term' && !p.hops.some(h => /^7\./.test(h.to)), `${b} zůstává na v6`);
  }
  p = await run(dev({ version: '6.49.21', arch: 'mipsbe', board_name: 'RB433AH', model: 'RB433AH', total_mem: 128 * MB, free_mem: 90 * MB, total_hdd: 64 * MB, free_hdd: 40 * MB, packages: v6pk('6.49.21') }));
  check(p.target === '7.24.6' && !p.no_v7.length, 'RB433AH (128 MB RAM) smí na v7');
  p = await run(dev({ version: '7.24.2', arch: 'mipsbe', board_name: 'RB493AH', model: 'RB493AH', total_mem: 128 * MB, free_mem: 90 * MB }));
  check(!p.blockers.length, 'RB493AH už na v7 není blokovaný: ' + JSON.stringify(p.blockers));
  p = await run(dev({ version: '7.24.2', arch: 'mipsbe', board_name: 'RB711-5Hn', model: 'RB711-5Hn', total_mem: 32 * MB, free_mem: 8 * MB, total_hdd: 64 * MB, free_hdd: 30 * MB }));
  check(p.blockers.some(b => /vrať ho ručně na 6\.49\.23 /.test(b)), '32MB kus na v7: rada k návratu uvádí aktuální v6 long-term, ne 6.49.21');

  p = await run(dev({ version: '6.49.21', arch: 'arm', board_name: 'CRS326-24G-2S+', model: 'CRS326-24G-2S+', packages: ['routeros-arm', 'system', 'dhcp', 'security', 'wireless'].map(name => ({ name, version: '6.49.21', disabled: false })), flags: { wireless: 0, w60g: 0 } }));
  check(p.hops.length && !(p.hops[p.hops.length - 1].packages || []).some(x => /^wireless/.test(x.name || x)), 'switch bez rádia nedostane balíček wireless: ' + JSON.stringify((p.hops[p.hops.length - 1].packages || []).map(x => x.name || x)));
  console.log(bad ? `\n${bad} kontrol selhalo` : '\nvše OK'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
