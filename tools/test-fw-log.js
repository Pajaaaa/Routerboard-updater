// Regresní test: pozná se, že pravidla /system logging hlášku o zápisu RouterBOOT (topics system,info,critical) do paměti nepustí?
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-fwlog-');
const { Runner } = require('../lib/runner');
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };
const R = (topics, action, disabled = 'false') => ({ topics, action, disabled });
check(Runner.loggingReachesMemory([R('info', 'memory'), R('error', 'memory'), R('warning', 'memory'), R('critical', 'echo')]), 'výchozí pravidla: info→memory stačí');
check(!Runner.loggingReachesMemory([R('info', 'sojka'), R('error', 'memory'), R('warning', 'memory'), R('critical', 'echo')]), 'info jen na remote: hláška do paměti nejde');
check(Runner.loggingReachesMemory([R('critical', 'memory')]), 'critical→memory sedí');
check(Runner.loggingReachesMemory([R('system,!debug', 'memory')]), 'system bez debug sedí');
check(!Runner.loggingReachesMemory([R('system,!critical', 'memory')]), 'system bez critical nesedí');
check(!Runner.loggingReachesMemory([R('info', 'memory', 'true')]), 'vypnuté pravidlo se nepočítá');
check(Runner.loggingReachesMemory([R('', 'memory')]), 'pravidlo bez topics = vše');
check(!Runner.loggingReachesMemory([R('wireless,info', 'memory')]), 'wireless,info nesedí (wireless ve zprávě není)');
console.log(bad ? `SELHALO: ${bad}` : 'log firmware OK');
process.exit(bad ? 1 : 0);
