#!/usr/bin/env node
'use strict';
// Ověření, které oblasti a APčka patří správci: node tools/userdb-who.js <uid | e-mail | nick> [--devices] [--ip 10.107.x.y]
// --devices vypíše i zařízení všech jeho APček a členů pod nimi včetně loginu (heslo maskované); co je RouterOS, rozhodne až sken
// Potřebuje MTU_USERDB_USER a MTU_USERDB_PASS v prostředí (nebo v .env vedle).
const path = require('path');
try { require('fs').readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch {}
const udb = require('../lib/userdb');
(async () => {
  if (!udb.enabled()) { console.error('chybí MTU_USERDB_USER / MTU_USERDB_PASS'); process.exit(2); }
  const args = process.argv.slice(2);
  const ipIdx = args.indexOf('--ip');
  if (ipIdx >= 0) { const c = await udb.getCredentials(args[ipIdx + 1]); console.log(c ? `${c.ip}: login ${c.login}, heslo ${'*'.repeat(c.password.length)} (${c.password.length} znaků)` : 'IP v userdb není'); return; }
  const q = args[0];
  if (!q) { const all = await udb.areas(); console.log(`oblastí: ${all.length}, APček: ${all.reduce((n, a) => n + a.aps.length, 0)}, správců: ${new Set(all.flatMap(a => a.admins.map(u => u.id))).size}`); return; }
  const who = /^\d+$/.test(q) ? { uid: q } : q.includes('@') ? { email: q } : { nick: q };
  const w = await udb.whoIs(who);
  if (!w) { console.log(`správce „${q}“ v userdb není (nebo nemá žádnou oblast)`); process.exit(1); }
  console.log(`${w.nick} (uid ${w.id}, ${w.email}) — ${w.areas.length} oblastí, ${w.apCount} APček`);
  for (const a of w.areas) console.log(`  ${a.role === 'SO' ? 'správce ' : 'zástupce'} ${a.name} (oblast ${a.id}): ${a.aps.map(p => `${p.name} [${p.id}${p.active ? '' : ', neaktivní'}]`).join(', ')}`);
  if (args.includes('--devices')) {
    const r = await udb.devicesFor(w);
    const mem = r.devices.filter(d => d.member).length;
    console.log(`zařízení: ${r.devices.length} s loginem (APček ${r.devices.length - mem}, členů ${mem}), ${r.missing.length} bez loginu v userdb`);
    let last = '';
    for (const d of r.devices) { const g = `${d.area} / ${d.ap}`; if (g !== last) { console.log(`  [${g}]`); last = g; } console.log(`    ${d.ip.padEnd(15)} ${(d.name || d.note || '').slice(0, 36).padEnd(36)} ${(d.member ? `člen ${d.userId}` : 'AP').padEnd(11)} ${d.login} / ${'*'.repeat(Math.min(d.password.length, 12))}`); }
    for (const d of r.missing) console.log(`    ${d.ip.padEnd(15)} ${(d.name || '').slice(0, 36).padEnd(36)} ${(d.member ? 'člen' : 'AP').padEnd(11)} (${d.area} / ${d.ap}) — bez loginu`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
