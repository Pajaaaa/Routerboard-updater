// Pojistka pořadí z revize 21.11.2026: každý zásah do konfigurace (ochrana služeb, vypnutí/odinstalace balíčků) má na stejném nebo
// předchozím řádku zálohu; čekání na návrat nejvýš 30 min; nesmazaný balíček zůstává vedený jako rozpracovaný.
const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/runner.js'), 'utf8').split('\n');
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK ' : 'FAIL'} ${msg}`); if (!ok) bad++; };
const guarded = (re, what) => {
  const hits = src.map((l, i) => [l, i]).filter(([l]) => re.test(l) && !/^\s*(async |\/\/|\*)/.test(l) && !/, true\);/.test(l));
  check(hits.length > 0, `${what}: nalezeno ${hits.length} volání`);
  for (const [l, i] of hits) check(/ensureBackup\(info\)/.test(l) || /ensureBackup\(info\)/.test(src[i - 1]), `${what} na řádku ${i + 1} má před sebou zálohu`);
};
guarded(/this\.hardenServices\(c, L, W/, 'ochrana služeb');
guarded(/this\.uninstallUnusedPackages\(c, info/, 'odinstalace balíčků');
guarded(/this\.disableUnusedPackages\(c, info, L, W, settings, false\)/, 'vypnutí balíčků');
const all = src.join('\n');
check(/longWait \? 30 : 15/.test(all), 'čekání na návrat: nejvýš 30 min (pozdní návrat řeší dohled na pozadí)');
check(/uploaded = left;/.test(all), 'nesmazaný balíček zůstává vedený jako rozpracovaný');
check(/lateRequeued: true/.test(all) && /jb\.status === 'running'/.test(all), 'pozdní návrat za běhu jobu vrací položku do fronty (jen jednou)');
check(/rebootDebt\.set\(devId, \[\]\)/.test(all), 'dluh vypnutých restartovacích skriptů se po zapnutí maže');
check(/\.\.\.\(bl\.wifi \|\| \[\]\)/.test(all) && /\.\.\.\(now\.wifi \|\| \[\]\)/.test(all), 'sektory na ovladači wifi (ax) se po restartu ověřují');
check(/print count-only where interface=/.test(all), 'port bridge se zjišťuje přes count-only');
console.log(bad ? `\n${bad} kontrol selhalo` : '\nvše OK'); process.exit(bad ? 1 : 0);
