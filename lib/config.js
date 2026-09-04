'use strict';
const path = require('path');

const root = path.join(__dirname, '..');
const cfg = {
  port: parseInt(process.env.PORT || '2820', 10),
  host: process.env.HOST || '127.0.0.1',
  basePath: (process.env.BASE_PATH || '/mikrotik').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  // heslo pro přihlášení do webu
  password: process.env.MTU_PASSWORD || '',
  // tajný klíč: šifrování hesel routerů v DB + podpis session cookie
  secret: process.env.MTU_SECRET || '',
  // veřejná URL aplikace (pro fallback /tool fetch z routeru)
  publicUrl: (process.env.MTU_PUBLIC_URL || 'http://127.0.0.1:2820/mikrotik').replace(/\/+$/, ''),
  // jak často automaticky skenovat verze (hodiny), 0 = vypnuto
  scanIntervalHours: parseFloat(process.env.MTU_SCAN_HOURS || '6'),
  // kolik zařízení skenovat současně
  scanParallel: parseInt(process.env.MTU_SCAN_PARALLEL || '4', 10),
  sessionDays: 30,
};
cfg.backupDir = path.join(cfg.dataDir, 'backups');
cfg.pkgDir = path.join(cfg.dataDir, 'pkg');
cfg.dbFile = path.join(cfg.dataDir, 'mtu.sqlite');

if (!cfg.secret || cfg.secret.length < 16) {
  console.error('MTU_SECRET musí být nastaven (min. 16 znaků) — šifruje hesla routerů v databázi.');
  process.exit(1);
}
if (!cfg.password) {
  console.error('MTU_PASSWORD musí být nastaven (heslo pro přihlášení do webu).');
  process.exit(1);
}
module.exports = cfg;
