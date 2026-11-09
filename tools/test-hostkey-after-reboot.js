#!/usr/bin/env node
'use strict';
// Změněný SSH host key po restartu, který vyvolal sám upgrader (9.11.2026 powerbox2 hive S3,S4): není to chyba — varování,
// nový otisk se uloží (DB i rozpracovaný záznam) a položka pokračuje. Při vypnutém hostkey_auto_accept zůstává staré chování (chyba).
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-hostkey-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin';
const db = require('../lib/db');
const ros = require('../lib/ros');
// falešný klient: připojí se bez kontroly otisku a ohlásí nový klíč; s kontrolou otisku hlásí nesoulad jako skutečný RosClient
const NEW = 'SHA256:dfCNRo+6QiQbv/4JbL5afWXvwcudmrGDIvMzeXZ5AMY', OLD = 'SHA256:dphxwRmEVH0kDRNj1DsNTMz4TrFJTrpHw23MJYfWzpk';
let connects = 0;
class FakeClient {
  constructor(o) { this.o = o; this.hostKey = ''; this.hostKeyMismatch = ''; }
  async connect() { connects++; this.hostKey = NEW; if (this.o.expectedHostKey && this.o.expectedHostKey !== NEW) { this.hostKeyMismatch = NEW; throw new Error('Host key mismatch'); } }
  close() {}
}
ros.RosClient = FakeClient;
const { Runner } = require('../lib/runner');
const SF = require('../lib/sshfix');
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } };
(async () => {
  const devId = db.insertDevice({ host: '10.107.1.1', port: 22, username: 'admin', password_enc: '', enabled: 1 }); db.updateDevice(devId, { host_key: OLD });
  const raw = devId ? db.getDeviceRaw(devId) : { id: 0, host: '10.107.1.1', host_key: OLD };
  const self = { currentRaw: raw, currentDeviceId: devId, currentClient: null, lastActivity: 0 };
  const logs = [];
  const L = (lvl, msg) => logs.push(lvl + ':' + msg);
  const errMsg = `SSH host key zařízení se ZMĚNIL (uložený ${OLD}, nyní ${NEW}) — možný podvrh/jiné zařízení. Pokud je to v pořádku (netinstall), resetuj klíč u zařízení.`;
  chk(SF.isHostKeyChanged(errMsg), 'hláška o změněném klíči musí být rozpoznaná');
  const cl = await Runner.prototype.acceptNewHostKeyAfterReboot.call(self, { host: '10.107.1.1', port: 22, username: 'admin', password: 'x' }, errMsg, L);
  chk(cl && cl.hostKey === NEW, 'musí vrátit připojeného klienta s novým otiskem');
  chk(raw.host_key === NEW, `rozpracovaný záznam musí mít nový otisk (má ${raw.host_key})`);
  if (devId) chk(db.getDeviceRaw(devId).host_key === NEW, 'nový otisk musí být uložen v DB');
  chk(self.currentClient === cl, 'klient se musí stát aktuálním spojením položky');
  chk(logs.some((l) => l.startsWith('warn:') && /ZMĚNIL/.test(l) && new RegExp(OLD.replace(/[+/]/g, '\\$&')).test(l) && new RegExp(NEW.replace(/[+/]/g, '\\$&')).test(l)), 'musí vzniknout VAROVÁNÍ se starým i novým otiskem');
  chk(!logs.some((l) => l.startsWith('error:')), 'nesmí to být chyba');
  // zdrojová kontrola: waitCycle novou cestu používá a respektuje vypnuté hostkey_auto_accept
  const src = fs.readFileSync(path.join(__dirname, '../lib/runner.js'), 'utf8');
  chk(/isHostKeyChanged\(e\.message\) && settings\.hostkey_auto_accept !== false/.test(src), 'waitCycle musí přijímat nový klíč jen při zapnutém hostkey_auto_accept');
  chk(/acceptNewHostKeyAfterReboot\(creds, e\.message, L\)/.test(src), 'waitCycle musí volat acceptNewHostKeyAfterReboot');
  if (bad) { console.error(`host key po restartu: ${bad} chyb`); process.exit(1); }
  console.log('host key po restartu OK');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });
