// Regresní test připnutých cílových verzí: nové vydání MikroTiku neposune cíl kanálu, dokud ho správce nepřijme;
// statistika i plán (targetFor) počítají s připnutou verzí, paměť vydání (releases.json) drží datum vydání i po přechodu na novější.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-pins-');
const fs = require('fs'), path = require('path');
const V = require('../lib/versions');
const { targetFor } = require('../lib/planner');
let bad = 0;
const check = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); };

// bez připnutí: cíl = co nabízí MikroTik (nic staženo → prázdné)
let pins = {};
V.configure({ pins: () => pins });
let l = V.getLatest();
check(!l.versions['v7-stable'], 'bez odpovědi MikroTiku a bez připnutí není cíl');
check(targetFor('v7-stable', l) === undefined, 'targetFor bez cíle → undefined');

// připnutí bez známého vydání: cíl je připnutá verze, datum vydání neznámé
pins = { 'v7-stable': '7.24.2', 'v6-long-term': '' };
V.configure({ pins: () => pins });
l = V.getLatest();
check(l.versions['v7-stable'] && l.versions['v7-stable'].version === '7.24.2' && l.versions['v7-stable'].pinned === true, 'připnutá 7.24.2 je cílem v7-stable');
check(l.versions['v7-stable'].releasedAt === 0 && l.versions['v7-stable'].newer === null, 'neznámé datum vydání, MikroTik nic novějšího nenabízí');
check(!l.versions['v6-long-term'], 'prázdné připnutí v6 = sledovat MikroTik (bez odpovědi nic)');
check(targetFor('v7-stable', l) === '7.24.2', 'targetFor vrací připnutou verzi');
check(targetFor('hold', l) === null, 'hold nemá cíl');

// simulace odpovědi MikroTiku: paměť vydání se plní přes releases.json (rememberRelease je vnitřní, tak přes soubor + nový require)
const file = path.join(process.env.DATA_DIR, 'releases.json');
fs.writeFileSync(file, JSON.stringify({ 'v7-stable': [{ version: '7.24.3', releasedAt: 1789371648, seenAt: 1789400000 }, { version: '7.24.2', releasedAt: 1788739200, seenAt: 1788800000 }] }));
delete require.cache[require.resolve('../lib/versions')];
const V2 = require('../lib/versions');
V2.configure({ pins: () => ({ 'v7-stable': '7.24.2' }) });
l = V2.getLatest();
check(l.versions['v7-stable'].releasedAt === 1788739200, 'datum vydání připnuté verze z paměti vydání');
check(V2.releaseInfo('7.24.3') && V2.releaseInfo('7.24.3').releasedAt === 1789371648, 'releaseInfo najde i verzi, kterou MikroTik nabízí nově');
check(V2.cmpVersion('7.24.3', '7.24.2') > 0 && V2.cmpVersion('7.24.2', '7.24.2') === 0, 'porovnání verzí');

// neplatné připnutí se ignoruje (server ho ani nepustí, ale kdyby v DB bylo)
V2.configure({ pins: () => ({ 'v7-stable': 'nesmysl' }) });
l = V2.getLatest();
check(!l.versions['v7-stable'], 'nečitelná připnutá verze se ignoruje');

console.log(bad ? `SELHALO: ${bad}` : 'připnuté verze OK');
process.exit(bad ? 1 : 0);
