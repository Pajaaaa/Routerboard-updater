#!/usr/bin/env node
'use strict';
// Kanály jen pro vnitřní použití × venkovní kus: stanice s opravdovou zemí (czech republic) na sektoru v 5150–5350 MHz po upgradu
// ze starého RouterOS (<6.45) dostane installation=outdoor a sektor přestane vidět — i se superchannel.
// Data podle skutečných kusů z 15.9.2026: LAN Střelecká 801 (DISC Lite5, 6.42.3→6.49.21, sektor S5-Oli 5200 MHz) a Travolta (LHG 5, 5180 MHz)
// se nepřipojily; Sedlackova (911-5HnD, 5180 MHz) a Groove 5Hn (5200 MHz) prošly.
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
const { indoorOnlyRisk, linkNotes } = require('../lib/planner');
let bad = 0;
const chk = (name, ok, detail) => { if (!ok) { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); bad++; } };
const st = (o) => ({ iface: 'wlan1', mode: 'station-bridge', protocol: 'any', band: '5ghz-a/n', country: 'czech republic', freqMode: 'superchannel', installation: '', ...o });

// Střelecká 801: DISC Lite5 6.42.3, CZ + superchannel, sektor 5200 → blokovat
{
  const r = indoorOnlyRisk(st(), 5200, { version: '6.42.3', board_name: 'DISC Lite5', model: 'RBDisc-5nD' });
  chk('DISC Lite5 6.42.3 na 5200 MHz blokuje', r && r.block, JSON.stringify(r));
  chk('zpráva radí country=debug', r && /country=debug/.test(r.msg), r && r.msg);
}
// Travolta: LHG 5 6.42.3, sektor 5180 → blokovat
chk('LHG 5 6.42.3 na 5180 MHz blokuje', (indoorOnlyRisk(st(), 5180, { version: '6.42.3', board_name: 'LHG 5', model: 'RBLHG-5nD' }) || {}).block === true);
// Sedlackova: 911-5HnD (holá deska) 6.42.3 na 5180 → jen varování (installation zůstane any)
{
  const r = indoorOnlyRisk(st(), 5180, { version: '6.42.3', board_name: '911 Lite5 dual', model: 'RB911-5HnD' });
  chk('911-5HnD 6.42.3 jen varuje', r && r.block === false, JSON.stringify(r));
}
// Groove 5Hn 6.42.7 na 5200 prošel → jen varování
chk('Groove 5Hn jen varuje', (indoorOnlyRisk(st(), 5200, { version: '6.42.7', board_name: 'RB Groove 5Hn', model: 'RBGroove-5Hn' }) || {}).block === false);
// už na 6.46 s installation=any → nic (hodnota se upgradem nemění)
chk('installation=any na 6.46 nic', indoorOnlyRisk(st({ installation: 'any' }), 5180, { version: '6.46.4', board_name: 'DISC Lite5 ac' }) === null);
// installation=outdoor (ať je verze jakákoli) → blokovat
chk('installation=outdoor blokuje', (indoorOnlyRisk(st({ installation: 'outdoor' }), 5200, { version: '6.49.21', board_name: 'DISC Lite5' }) || {}).block === true);
// country debug / no_country_set / superchannel → nic
for (const c of ['debug', 'no_country_set', 'superchannel']) chk(`country ${c} nic`, indoorOnlyRisk(st({ country: c }), 5200, { version: '6.42.3', board_name: 'DISC Lite5' }) === null);
// sektor nad 5470 (venkovní pásmo) → nic; united states nemá vnitřní kanály → nic; neznámá frekvence → nic
chk('5640 MHz nic', indoorOnlyRisk(st(), 5640, { version: '6.42.3', board_name: 'RB711-5Hn' }) === null);
chk('united states nic', indoorOnlyRisk(st({ country: 'united states' }), 5200, { version: '6.42.3', board_name: 'DISC Lite5' }) === null);
chk('bez frekvence nic', indoorOnlyRisk(st(), NaN, { version: '6.42.3', board_name: 'DISC Lite5' }) === null);
// kus už na 6.49 bez známé installation: připojený na 5200 MHz znamená installation any/indoor, upgradem se nemění → nic
chk('6.49 bez installation nic', indoorOnlyRisk(st(), 5200, { version: '6.49.11', board_name: 'DISC Lite5' }) === null);

// přes linkNotes: blokátor v plánu, s allow_country_mismatch jen varování; country shodné se sektorem nesmí riziko schovat
{
  const info = { version: '6.42.3', board_name: 'DISC Lite5', model: 'RBDisc-5nD', links: { stations: [st({ ap: { mac: '08:55:31:03:6A:13' }, apDev: { identity: 'S5-Oli', host: '10.107.82.249', country: 'czech republic', freqMode: 'superchannel', frequency: '5200' } })], aps: [], w60g: [], wifi: [] } };
  const n = [], w = [], b = [];
  linkNotes(info, {}, n, w, b, {});
  chk('linkNotes: blokátor při shodné country', b.some(x => /vnitřní použití/.test(x)), JSON.stringify(b));
  const n2 = [], w2 = [], b2 = [];
  linkNotes(info, {}, n2, w2, b2, { allow_country_mismatch: true });
  chk('linkNotes: s povolením jen varování', !b2.some(x => /vnitřní použití/.test(x)) && w2.some(x => /POVOLENO/.test(x)), JSON.stringify({ b2, w2 }));
  const n3 = [], w3 = [], b3 = [];
  linkNotes({ ...info, links: { ...info.links, stations: [st({ country: 'debug', ap: { mac: 'x' }, apDev: info.links.stations[0].apDev })] } }, {}, n3, w3, b3, {});
  chk('linkNotes: country debug bez blokátoru', !b3.length, JSON.stringify(b3));
}
if (bad) { console.error(`test-country-indoor: ${bad} chyb`); process.exit(1); }
console.log('test-country-indoor OK');
