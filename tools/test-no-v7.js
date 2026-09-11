// Regresní test seznamu hardware bez v7: OmniTIK 5 ac (i PoE varianta) na v7 smí, staré 32/64MB kusy ne.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-nov7-');
const { effectiveTrack } = require('../lib/planner');
const MB = 1024 * 1024;
const cases = [
  ['OmniTIK 5 ac', 'RBOmniTikG-5HacD', 128, 'v7-stable'],
  ['OmniTIK 5 PoE ac', 'RBOmniTikPG-5HacD', 128, 'v7-stable'],
  ['OmniTIK 5 PoE ac', 'RouterBOARD OmniTIK PG-5HacD', 128, 'v7-stable'],
  ['OmniTIK 5 PoE', 'OmniTIK UPA-5HnD r2', 128, 'v6-long-term'],
  ['OmniTIK 5', 'OmniTIK U-5HnD r2', 64, 'v6-long-term'],
  ['RB750UP', 'RB750UP', 32, 'v6-long-term'],
  ['RB750Gr3', 'RB750Gr3', 256, 'v7-stable'],
  ['Groove 52 ac', 'RBGrooveG-52HPacn', 64, 'v7-stable'],
  ['GrooveA 52 ac', 'RouterBOARD Groove GA-52HPacn', 64, 'v7-stable'],
  ['GrooveA 52', 'Groove A-52HPn r2', 64, 'v7-stable'],
  ['RB Groove 52HPn', 'Groove 52HPn', 64, 'v7-stable'],
  ['RB Groove 5Hn', 'Groove 5Hn', 32, 'v6-long-term'],
  ['RB Groove A-5Hn', 'Groove A-5Hn', 32, 'v6-long-term'],
  ['Groove A-5Hn', 'Groove A-5Hn', 64, 'v6-long-term'],
  ['hAP ac2', 'RBD52G-5HacD2HnD', 128, 'v7-stable'],
];
let bad = 0;
for (const [board_name, model, mem, want] of cases) {
  const got = effectiveTrack({ board_name, model, arch: 'mipsbe', total_mem: mem * MB, version: '6.49.21', track: 'v7-stable' }, {});
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'FAIL'} ${board_name.padEnd(18)} ${model.padEnd(30)} ${mem} MB → ${got}${ok ? '' : ' (čekáno ' + want + ')'}`);
}
if (bad) { console.error(`${bad} případů selhalo`); process.exit(1); }
console.log('seznam hardware bez v7: OK');
