'use strict';
const path = require('path');

const root = path.join(__dirname, '..');
const cfg = {
  port: parseInt(process.env.PORT || '2820', 10),
  host: process.env.HOST || '127.0.0.1',
  basePath: (process.env.BASE_PATH || '/mikrotik').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  // heslo pro přihlášení do webu (při prvním spuštění se z něj založí účet správce MTU_ADMIN_USER)
  password: process.env.MTU_PASSWORD || '',
  adminUser: (process.env.MTU_ADMIN_USER || 'admin').trim(),
  // tajný klíč: šifrování hesel routerů v DB + podpis session cookie
  secret: process.env.MTU_SECRET || '',
  // veřejná URL aplikace (pro fallback /tool fetch z routeru)
  publicUrl: (process.env.MTU_PUBLIC_URL || 'http://127.0.0.1:2820/mikrotik').replace(/\/+$/, ''),
  // jak často automaticky skenovat verze (hodiny), 0 = vypnuto
  scanIntervalHours: parseFloat(process.env.MTU_SCAN_HOURS || '6'),
  // kolik zařízení skenovat současně
  scanParallel: parseInt(process.env.MTU_SCAN_PARALLEL || '4', 10),
  sessionDays: 30,
  // přihlášení přes SSO (OpenID Connect / Keycloak). Aktivní, když je vyplněn SSO_CLIENT_ID + SSO_CLIENT_SECRET.
  sso: {
    discoveryUrl: process.env.SSO_DISCOVERY_URL || '',
    clientId: process.env.SSO_CLIENT_ID || '',
    clientSecret: process.env.SSO_CLIENT_SECRET || '',
    redirectUri: process.env.SSO_REDIRECT_URI || '',
    scope: process.env.SSO_SCOPE || 'openid email profile',
    allowedEmails: String(process.env.SSO_ALLOWED_EMAILS || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean),
    // správci: smějí měnit nastavení, mazat zařízení, zobrazit hesla routerů, dělit oddíly. Prázdné = každý přihlášený je správce.
    adminEmails: String(process.env.SSO_ADMIN_EMAILS || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean),
  },
  // přihlášení jménem a heslem (účty v DB) je vždy k dispozici; SSO volitelně navíc
  passwordLogin: true,
};
if (!cfg.sso.redirectUri) cfg.sso.redirectUri = cfg.publicUrl + '/auth/callback';
cfg.backupDir = path.join(cfg.dataDir, 'backups');
cfg.pkgDir = path.join(cfg.dataDir, 'pkg');
cfg.dbFile = path.join(cfg.dataDir, 'mtu.sqlite');

if (!cfg.secret || cfg.secret.length < 16) {
  console.error('MTU_SECRET musí být nastaven (min. 16 znaků) — šifruje hesla routerů v databázi.');
  process.exit(1);
}
if (!cfg.password && !(cfg.sso.clientId && cfg.sso.clientSecret)) {
  console.error('Nastav MTU_PASSWORD (heslo webu) nebo SSO_CLIENT_ID + SSO_CLIENT_SECRET (přihlášení přes SSO).');
  process.exit(1);
}
module.exports = cfg;
