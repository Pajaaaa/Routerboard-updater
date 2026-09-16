// Regresní test názvů balíčků podle architektury (PowerPC: v6 bundle „powerpc", zip a v7 „ppc"; CHR hlásí x86_64)
process.env.MTU_SECRET = process.env.MTU_SECRET || "test-secret-1234567890"; process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || "test"; process.env.DATA_DIR = process.env.DATA_DIR || require("fs").mkdtempSync(require("os").tmpdir() + "/mtu-arch-");
const V = require('../lib/versions');
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
const fn = (pkg, ver, arch, want) => check(V.packageFileName(pkg, ver, arch) === want, `${pkg} ${ver} ${arch} → ${want} (je ${V.packageFileName(pkg, ver, arch)})`);
fn('routeros', '6.49.21', 'powerpc', 'routeros-powerpc-6.49.21.npk');
fn('routeros', '6.49.21', 'ppc', 'routeros-powerpc-6.49.21.npk');
fn('wireless', '6.49.21', 'powerpc', 'wireless-6.49.21-ppc.npk');
fn('routeros', '7.24.2', 'powerpc', 'routeros-7.24.2-ppc.npk');
fn('wireless', '7.24.2', 'powerpc', 'wireless-7.24.2-ppc.npk');
fn('routeros', '7.24.2', 'x86_64', 'routeros-7.24.2.npk');
fn('routeros', '6.49.21', 'x86_64', 'routeros-x86-6.49.21.npk');
fn('routeros', '6.49.21', 'mipsbe', 'routeros-mipsbe-6.49.21.npk');
fn('routeros', '7.24.2', 'arm', 'routeros-7.24.2-arm.npk');
fn('wireless', '6.49.21', 'mipsbe', 'wireless-6.49.21-mipsbe.npk');
check(V.ARCH_V6.includes(V.normArch('powerpc')) && V.ARCH_V7.includes(V.normArch('powerpc')) && V.ARCH_V6.includes(V.normArch('x86_64')), 'normArch: powerpc/x86_64 jsou v seznamu architektur');
console.log(bad ? `SELHALO: ${bad}` : 'architektury OK');
process.exit(bad ? 1 : 0);
