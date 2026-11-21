// Průběžná kontrola na pozadí (revize 21.11.2026): bere zařízení s nejstarším skenem, respektuje vypnutí a drain.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-bgscan-');
const db = require('../lib/db');
const { Scanner } = require('../lib/scanner');
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
(async () => {
  const uid = db.insertUser({ name: 'u', pass_hash: '', role: 'user' });
  const day = 86400, now = db.now();
  const ids = [];
  for (let i = 0; i < 6; i++) { const id = db.insertDevice({ host: '192.0.2.' + (10 + i), port: 22, owner_id: uid, username: 'a', password: 'b' }); db.updateDevice(id, { scan_status: 'ok', last_scan_at: now - (i < 4 ? (30 - i) * day : day) }); ids.push(id); }
  const runner = { draining: false, isDeviceBusy: () => false };
  const sc = new Scanner(runner, { emit() {} });
  const seen = [];
  sc.scanOne = async (id) => { seen.push(id); db.updateDevice(id, { last_scan_at: db.now() }); return { ok: true }; };
  let n = await sc.backgroundScan();
  check(n === 2 && seen.slice().sort().join() === [ids[0], ids[1]].sort().join(), `první dávka: 2 kusy s nejstarším skenem (${seen.join()})`);
  n = await sc.backgroundScan();
  check(n === 2 && seen.length === 4 && seen.includes(ids[2]) && seen.includes(ids[3]), 'druhá dávka: další dva zastaralé');
  n = await sc.backgroundScan();
  check(n === 0 && seen.length === 4, 'čerstvě skenované kusy (1 den) se neberou');
  db.updateDevice(ids[4], { last_scan_at: now - 20 * day });
  runner.draining = true; n = await sc.backgroundScan(); check(n === 0, 'při aktualizaci serveru (drain) se nic nezačíná'); runner.draining = false;
  db.setSettings({ bg_scan_days: 0 }); n = await sc.backgroundScan(); check(n === 0, 'bg_scan_days = 0 kontrolu vypíná');
  db.setSettings({ bg_scan_days: 7 }); n = await sc.backgroundScan(); check(n === 1 && seen.includes(ids[4]), 'po zapnutí se zastaralý kus zkontroluje');
  console.log(bad ? `\n${bad} kontrol selhalo` : '\nvše OK'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
