#!/usr/bin/env node
'use strict';
// Automat: zpoždění se počítá od zveřejnění verze v kanálu (seenAt — kdy ji server poprvé viděl), ne od data sestavení (releasedAt),
// které MikroTik uvádí a které bývá o 1–4 dny starší (23.11.2026: 7.24.7 sestaveno 19.11., v long-term až 23.11.).
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-autopub-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslo-spravce-1'; process.env.USERDB_URL = ''; process.env.MTU_SMTP_HOST = '';
const day = 86400, now = Math.floor(Date.now() / 1000);
fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({
  'v7-long-term': [{ version: '7.24.7', releasedAt: now - 4 * day, seenAt: now - 3600 }],   // sestaveno před 4 dny, v kanálu hodinu
  'v7-stable': [{ version: '7.25.2', releasedAt: now - 10 * day, seenAt: now - 9 * day }],   // zveřejněno před 9 dny
  'v6-long-term': [{ version: '6.49.23', releasedAt: now - 40 * day }],                      // starý záznam bez seenAt
}));
const auto = require('../lib/autoupgrade');
let bad = 0; const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } else console.log('  ✓ ' + msg); };
const T = (d, at = now) => auto.targets({ auto_delay_days: d }, at);
chk(T(3)['v7-long-term'].mature === false, 'zpoždění 3 dny: verze sestavená před 4 dny, ale zveřejněná před hodinou, ještě není zralá');
chk(Math.abs(T(3)['v7-long-term'].matureAt - (now - 3600 + 3 * day)) <= 1, 'dozraje 3 dny po zveřejnění v kanálu');
chk(T(3, now + 3 * day)['v7-long-term'].mature === true, 'za 3 dny od zveřejnění už zralá je');
chk(T(0)['v7-long-term'].mature === true, 'zpoždění 0 = hned');
chk(T(5)['v7-stable'].mature === true && T(9.5)['v7-stable'].mature === false, 'verze zveřejněná před 9 dny: 5 dní zralá, 9,5 dne ne (datum sestavení před 10 dny nerozhoduje)');
chk(T(30)['v6-long-term'].mature === true && T(30)['v6-long-term'].publishedAt === now - 40 * day, 'záznam bez seenAt: počítá se od data vydání jako dřív');
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} selhání` : '\nvše v pořádku'); process.exit(bad ? 1 : 0);
