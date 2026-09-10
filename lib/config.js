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
  // prefix vlastní sítě jen pro příklady v dialogu skenu (např. "10.20"); výchozí dokumentační rozsah
  netHint: (process.env.MTU_NET_HINT || '192.0.2').trim().replace(/\.$/, ''),
  // zdrojová IP, ze které server chodí na routery přes SSH — ukazuje se všem v UI, aby ji povolili ve firewallu / ip service
  sourceIp: (process.env.MTU_SOURCE_IP || '').trim(),
  // které adresy smí nástroj skenovat a přidávat (CIDR čárkou); mimo ně se nic nepřidá ani neskenuje, aby server nebyl skener/brute-forcer
  // pro cizí sítě. Výchozí jsou privátní rozsahy (RFC 1918); pro veřejné adresy vlastní sítě doplň (např. 10.107.0.0/16,89.248.240.0/20). '*' = bez omezení.
  scanAllow: (process.env.MTU_SCAN_ALLOW || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16').trim(),
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
  // přihlášení jménem a heslem (účty v DB): yes = pro všechny, local = jen z localhostu (údržba/skripty, v UI se neukazuje), no = vypnuto; SSO volitelně navíc
  passwordLogin: (process.env.MTU_PASSWORD_LOGIN || 'yes').trim().toLowerCase(),
};
if (!cfg.sso.redirectUri) cfg.sso.redirectUri = cfg.publicUrl + '/auth/callback';
cfg.backupDir = path.join(cfg.dataDir, 'backups');
cfg.pkgDir = path.join(cfg.dataDir, 'pkg');
cfg.dbFile = path.join(cfg.dataDir, 'mtu.sqlite');

if (!cfg.secret || cfg.secret.length < 16) {
  console.error('MTU_SECRET musí být nastaven (min. 16 znaků) — šifruje hesla zařízení v databázi.');
  process.exit(1);
}
if (!cfg.password && !(cfg.sso.clientId && cfg.sso.clientSecret)) {
  console.error('Nastav MTU_PASSWORD (heslo webu) nebo SSO_CLIENT_ID + SSO_CLIENT_SECRET (přihlášení přes SSO).');
  process.exit(1);
}
module.exports = cfg;
