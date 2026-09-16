// Regresní test: pomalé zařízení — po timeoutu se limity prodlouží a zůstanou prodloužené; CPU ≥ 90 % je prodlouží dopředu.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-slow-');
const { RosClient } = require('../lib/ros');
const { Runner } = require('../lib/runner');
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
(async () => {
  const notices = [];
  const c = new RosClient({ host: 'x', onNotice: (m) => notices.push(m) });
  c.conn = {}; // „připojeno“
  const seen = [];
  let calls = 0;
  c._execOnce = async (cmd, o) => { seen.push(o.timeoutMs); if (cmd === ':put 1') return '1'; if (++calls === 1) throw new Error(`SSH: timeout příkazu (${Math.round(o.timeoutMs / 1000)} s): ${cmd}`); return 'ok'; };
  const r = await c.exec('/system resource print');
  check(r === 'ok' && seen[0] === 30000 && seen[seen.length - 1] === 60000, `po timeoutu druhý pokus s 60 s (${seen.join(',')})`);
  check(c.slowFactor === 2 && notices.length === 1 && /pomalu/.test(notices[0]), 'slowFactor 2 + jedno hlášení');
  seen.length = 0; calls = 5;
  await c.exec('/system package print');
  check(seen[0] === 60000, 'další příkaz dostane rovnou 60 s');
  check(seen.length === 1 && c._ping !== undefined, 'bez timeoutu žádný ping');
  // reconnect cesta: ping selže, reconnect projde → limit se taky zdvojnásobí
  const c2 = new RosClient({ host: 'x', onNotice: (m) => notices.push(m) });
  c2.conn = {}; let n2 = 0; const seen2 = [];
  c2._execOnce = async (cmd, o) => { if (cmd === ':put 1') throw new Error('SSH: timeout příkazu (20 s): :put 1'); seen2.push(o.timeoutMs); if (++n2 === 1) throw new Error('SSH: timeout příkazu (30 s): x'); return 'ok'; };
  c2.reconnect = async () => { c2.conn = {}; };
  check(await c2.exec('/x print') === 'ok' && seen2[1] === 60000 && c2.slowFactor === 2, `po obnově spojení taky 60 s (${seen2.join(',')})`);
  // změnový příkaz se neopakuje
  const c3 = new RosClient({ host: 'x' }); c3.conn = {}; let n3 = 0;
  c3._execOnce = async () => { n3++; throw new Error('SSH: timeout příkazu (30 s): x'); };
  let err = null; try { await c3.exec('/system reboot'); } catch (e) { err = e; }
  check(err && n3 === 1, 'měnící příkaz jen jednou');
  // přetížení podle CPU
  const c4 = new RosClient({ host: 'x', onNotice: (m) => notices.push(m) });
  const note = Runner.overloadNote(c4, { cpu_load: 100 });
  check(c4.slowFactor === 3 && /×3/.test(note), 'CPU 100 % → ×3 dopředu: ' + note);
  check(Runner.overloadNote(c4, { cpu_load: 40 }) === '' && c4.slowFactor === 3, 'CPU 40 % nic nemění');
  const c5 = new RosClient({ host: 'x' }); c5.markSlow('a'); c5.markSlow('b'); c5.markSlow('c');
  check(c5.slowFactor === 4, 'strop ×4');
  console.log(bad ? `SELHALO: ${bad}` : 'pomalá zařízení OK');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CHYBA', e); process.exit(1); });
