#!/usr/bin/env node
'use strict';
// Hledání SSH portu (lib/portscan.js): port se pozná podle úvodního řádku „SSH-2.0-…“, ne podle čísla; RouterOS („ROSSSH“) má přednost
// před cizím SSH za přesměrováním; tichý port (Winbox/API) není SSH; výsledek přežije restart a natažení z něj bere port.
// 9.11.2026: kusy z RB-DB se „zavřeným SSH“ měly ssh na 2222/2224/3256 a natažení zkoušelo jen 22.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-ps-'));
process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x';
const { scanHost, probePort, SshPortScan, COMMON_PORTS } = require('../lib/portscan');
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } };
const listen = (onConn) => new Promise(r => { const s = net.createServer(onConn); s.listen(0, '127.0.0.1', () => r(s)); });

(async () => {
  const ros = await listen(c => { c.on('error', () => {}); c.write('SSH-2.0-ROSSSH\r\n'); });
  const linux = await listen(c => { c.on('error', () => {}); c.write('SSH-2.0-OpenSSH_9.2p1 Debian\r\n'); });
  const silent = await listen(c => { c.on('error', () => {}); }); // Winbox/API: bez dotazu nic nepošle
  const closedSrv = await listen(() => {}); const closed = closedSrv.address().port; await new Promise(r => closedSrv.close(r));
  const P = { ros: ros.address().port, linux: linux.address().port, silent: silent.address().port };

  // 1) jednotlivé porty
  let r = await probePort('127.0.0.1', P.ros, 500, 400);
  chk(r.state === 'open' && r.banner === 'SSH-2.0-ROSSSH', `RouterOS SSH: ${JSON.stringify(r)}`);
  r = await probePort('127.0.0.1', P.silent, 500, 300);
  chk(r.state === 'open' && r.banner === '', `tichý port je otevřený bez banneru: ${JSON.stringify(r)}`);
  r = await probePort('127.0.0.1', closed, 500, 300);
  chk(r.state === 'closed', `zavřený port: ${JSON.stringify(r)}`);

  // 2) úplný sken (souběžně): najde obě SSH, RouterOS je nejlepší, tichý port je v „open“, zavřený nikde
  let res = await scanHost('127.0.0.1', { mode: 'full', ports: [closed, P.silent, P.linux, P.ros], bannerMs: 300, timeoutMs: 500 });
  chk(res.port === P.ros && res.ros === true, `nejlepší port je RouterOS (${res.port}, čekáno ${P.ros})`);
  chk(res.ssh.length === 2 && res.ssh[1].port === P.linux, `obě SSH nalezena: ${JSON.stringify(res.ssh)}`);
  chk(res.open.length === 1 && res.open[0] === P.silent, `tichý port mezi otevřenými bez SSH: ${JSON.stringify(res.open)}`);
  chk(res.scanned === 4, `prošly 4 porty (${res.scanned})`);

  // 3) šetrný sken: po jednom, u prvního RouterOS SSH skončí (dál se neklepe)
  res = await scanHost('127.0.0.1', { mode: 'quick', ports: [closed, P.ros, P.linux, P.silent], gapMs: 5, bannerMs: 300, timeoutMs: 500 });
  chk(res.port === P.ros && res.scanned === 2, `quick skončí u RouterOS SSH (port ${res.port}, zkoušeno ${res.scanned})`);
  // jen cizí SSH: nalezeno, ale ne RouterOS
  res = await scanHost('127.0.0.1', { mode: 'quick', ports: [P.linux, closed], gapMs: 5, bannerMs: 300, timeoutMs: 500 });
  chk(res.port === P.linux && res.ros === false && res.scanned === 2, `cizí SSH: port ${res.port}, ros ${res.ros}, zkoušeno ${res.scanned}`);
  // nic: port 0
  res = await scanHost('127.0.0.1', { mode: 'quick', ports: [closed, P.silent], gapMs: 5, bannerMs: 200, timeoutMs: 500 });
  chk(res.port === 0 && res.ssh.length === 0 && res.open[0] === P.silent, `bez SSH: ${JSON.stringify(res)}`);

  // 4) seznam obvyklých portů: 22 první, bez nesmyslů, rozumně krátký (šetrný sken na kus pod ~2 min)
  chk(COMMON_PORTS[0] === 22 && COMMON_PORTS.includes(2222) && COMMON_PORTS.every(p => p > 0 && p < 65536), 'seznam obvyklých portů');
  chk(new Set(COMMON_PORTS).size <= 80, `seznam obvyklých portů je krátký (${new Set(COMMON_PORTS).size})`);

  // 5) správa běhu: jeden běh naráz, události, výsledek po IP, port pro natažení, přežije restart
  const bus = new (require('events'))(); const evs = []; bus.on('event', e => evs.push(e.type));
  const m = new SshPortScan(bus);
  const fake = async (ip, o) => { await new Promise(r2 => setTimeout(r2, 20)); o.onProgress(1, 1); return { host: ip, mode: o.mode, at: Date.now(), ms: 20, port: ip === '10.0.0.1' ? 2222 : 0, banner: ip === '10.0.0.1' ? 'SSH-2.0-ROSSSH' : '', ros: ip === '10.0.0.1', ssh: [], open: [], scanned: 1, filtered: 0 }; };
  const st = m.start({ ips: ['10.0.0.1', '10.0.0.2'], mode: 'quick', by: 'test', scan: fake });
  chk(m.running && st.total === 2, 'běh nastartován');
  let threw = false; try { m.start({ ips: ['10.0.0.3'], mode: 'quick', scan: fake }); } catch { threw = true; }
  chk(threw, 'druhý běh naráz se odmítne');
  await m.done;
  chk(!m.running && st.done === 2 && st.found === 1 && st.finishedAt > 0, `běh doběhl (${JSON.stringify(st)})`);
  chk(evs.includes('sshscan') && evs[evs.length - 1] === 'sshscan-done', `události: ${evs.join(',')}`);
  chk(m.portFor('10.0.0.1') === 2222 && m.portFor('10.0.0.2') === 0 && m.portFor('10.0.0.9') === 0, 'port pro natažení');
  m.results.set('10.0.0.4', { host: '10.0.0.4', at: Date.now(), port: 2022, banner: 'SSH-2.0-OpenSSH_9.2', ros: false });
  chk(m.portFor('10.0.0.4') === 0, 'cizí SSH (ne RouterOS) se pro natažení nepoužije');
  const m2 = new SshPortScan(bus);
  chk(m2.portFor('10.0.0.1') === 2222 && m2.get('10.0.0.2') && m2.get('10.0.0.2').port === 0, 'výsledky přežijí restart');

  for (const s of [ros, linux, silent]) s.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  if (bad) { console.error(`test-portscan: ${bad} chyb`); process.exit(1); }
  console.log('test-portscan: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
