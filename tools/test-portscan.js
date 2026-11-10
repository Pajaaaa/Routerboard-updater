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

  // 5) fronta: přidávání během běhu, strop souběhu, duplicity se přeskočí, události, port pro natažení
  const bus = new (require('events'))(); const evs = []; bus.on('event', e => evs.push(e.type));
  let live = 0, maxFull = 0, gate = null; const order = [];
  const fake = async (ip, o) => {
    live++; if (o.mode === 'full') maxFull = Math.max(maxFull, live); order.push(ip);
    if (gate) await gate; else await new Promise(r2 => setTimeout(r2, 15));
    o.onProgress(1, 1); live--;
    return { host: ip, mode: o.mode, at: Date.now(), ms: 15, port: ip === '10.0.0.1' ? 2222 : 0, banner: ip === '10.0.0.1' ? 'SSH-2.0-ROSSSH' : '', ros: ip === '10.0.0.1', ssh: [], open: [], scanned: 1, filtered: 0 };
  };
  const m = new SshPortScan(bus, { scan: fake });
  const ips90 = Array.from({ length: 90 }, (_, i) => `10.0.1.${i + 1}`);
  let r1 = m.enqueue({ ips: ['10.0.0.1', '10.0.0.2'], mode: 'full', by: 'test' });
  chk(m.running && r1.added === 2 && r1.state.total === 2, 'běh nastartován');
  const r2 = m.enqueue({ ips: ['10.0.0.2', ...ips90], mode: 'full', by: 'test' }); // přidání během běhu: 90 nových, 1 už čeká
  chk(r2.added === 90 && r2.skipped === 1 && r2.state === r1.state && r2.state.total === 92, `přidání do běžící fronty (${JSON.stringify({ a: r2.added, s: r2.skipped, t: r2.state.total })})`);
  chk(r2.state.queued === 88 && m.pending('10.0.1.90') && m.pending('10.0.0.1'), `ve frontě čeká 88, 4 běží (${r2.state.queued})`);
  const st = await m.done;
  chk(!m.running && st.done === 92 && st.found === 1 && st.finishedAt > 0 && st.queued === 0, `fronta doběhla (${JSON.stringify(st)})`);
  chk(maxFull === 4, `režim „všechny porty“ jede nejvýš po 4 kusech (${maxFull})`);
  chk(order[0] === '10.0.0.1' && order[order.length - 1] === '10.0.1.90', 'pořadí fronty se drží');
  chk(evs.includes('sshscan') && evs[evs.length - 1] === 'sshscan-done' && evs.filter(e => e === 'sshscan-done').length === 1, 'události: průběh a jedno dokončení');
  chk(m.portFor('10.0.0.1') === 2222 && m.portFor('10.0.0.2') === 0 && m.portFor('10.0.0.9') === 0 && !m.pending('10.0.0.1'), 'port pro natažení');
  m.results.set('10.0.0.4', { host: '10.0.0.4', at: Date.now(), port: 2022, banner: 'SSH-2.0-OpenSSH_9.2', ros: false });
  chk(m.portFor('10.0.0.4') === 0, 'cizí SSH (ne RouterOS) se pro natažení nepoužije');
  // nový běh po dokončení má čistý stav
  r1 = m.enqueue({ ips: ['10.0.0.5'], mode: 'quick', by: 'test' }); await m.done;
  chk(r1.state !== st && r1.state.total === 1 && r1.state.done === 1, 'další běh začíná od nuly');

  // 6) restart uprostřed: fronta (i rozdělané kusy) je na disku a nová instance v ní pokračuje, výsledky zůstávají
  let release; gate = new Promise(r => { release = r; });
  m.enqueue({ ips: ['10.0.2.1', '10.0.2.2', '10.0.2.3', '10.0.2.4', '10.0.2.5', '10.0.2.6'], mode: 'full', by: 'test' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'ssh-queue.json'), 'utf8'));
  chk(onDisk.items.length === 6 && onDisk.items[0].ip === '10.0.2.1' && onDisk.items[0].mode === 'full', `fronta na disku včetně běžících (${onDisk.items.length})`);
  gate = null; const seen = [];
  const m2 = new SshPortScan(bus, { scan: async (ip, o) => { seen.push(ip); return fake(ip, o); } }); // „restart“: stará instance se zahodí
  chk(m2.portFor('10.0.0.1') === 2222 && m2.get('10.0.0.2') && m2.get('10.0.0.2').port === 0, 'výsledky přežijí restart');
  await new Promise(r => setImmediate(r)); await m2.done;
  chk(seen.length === 6 && m2.get('10.0.2.6') && !m2.running, `po restartu se fronta dojede (${seen.length}/6)`);
  chk(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'ssh-queue.json'), 'utf8')).items.length === 0, 'prázdná fronta po dokončení');
  release();

  for (const s of [ros, linux, silent]) s.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  if (bad) { console.error(`test-portscan: ${bad} chyb`); process.exit(1); }
  console.log('test-portscan: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
