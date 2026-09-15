#!/usr/bin/env node
// Připnutí cílových verzí kanálů přímo v databázi (bez UI) + doplnění paměti vydání — pro první nasazení
// nebo když je potřeba cíl nastavit z příkazové řádky. Spouštět v adresáři aplikace na serveru (čte DATA_DIR / data/).
//   node tools/pin-targets.js 7.24.2 7.23.5 6.49.21          # v7 stable, v7 long-term, v6 long-term ('' nebo - = sledovat MikroTik)
//   node tools/pin-targets.js 7.24.2 7.23.5 6.49.21 --dates 2026-09-03 2026-09-04 2026-09-03   # + data vydání do releases.json
// Běžící služba změnu vezme hned (nastavení čte při každém dotazu), releases.json až po restartu.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'pin-targets-nepotrebuje-klic-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'pin-targets-nepotrebuje-heslo'; // config.js jinak odmítne start; nástroj se nepřihlašuje
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');
const { parseVersion, cmpVersion } = require('../lib/versions');
const args = process.argv.slice(2);
const di = args.indexOf('--dates');
const vers = (di >= 0 ? args.slice(0, di) : args).slice(0, 3);
const dates = di >= 0 ? args.slice(di + 1, di + 4) : [];
if (!vers.length) { console.error('použití: node tools/pin-targets.js <v7-stable> <v7-long-term> <v6-long-term> [--dates YYYY-MM-DD ...]'); process.exit(2); }
const TRACKS = [['pin_v7_stable', 'v7-stable', 7], ['pin_v7_long_term', 'v7-long-term', 7], ['pin_v6_long_term', 'v6-long-term', 6]];
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(cfg.dbFile);
const st = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const file = path.join(cfg.dataDir, 'releases.json');
let known = {}; try { known = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
TRACKS.forEach(([key, track, major], i) => {
  const v = String(vers[i] || '').trim();
  if (!v || v === '-') { st.run(key, JSON.stringify('')); console.log(`${track}: sledovat MikroTik`); return; }
  const pv = parseVersion(v);
  if (!pv || pv.major !== major) { console.error(`${track}: ${v} není verze řady ${major}.x`); process.exit(1); }
  st.run(key, JSON.stringify(v));
  const list = known[track] || (known[track] = []);
  let rec = list.find(r => r.version === v);
  if (!rec) { rec = { version: v, releasedAt: 0, seenAt: Math.floor(Date.now() / 1000) }; list.push(rec); }
  if (dates[i]) { const t = Date.parse(dates[i] + 'T12:00:00Z'); if (Number.isFinite(t)) rec.releasedAt = Math.floor(t / 1000); }
  list.sort((a, b) => cmpVersion(b.version, a.version));
  console.log(`${track}: připnuto ${v}${rec.releasedAt ? ` (vydáno ${new Date(rec.releasedAt * 1000).toISOString().slice(0, 10)})` : ''}`);
});
fs.writeFileSync(file, JSON.stringify(known, null, 1));
console.log(`zapsáno: nastavení v ${cfg.dbFile}, paměť vydání ${file}`);
