#!/usr/bin/env node
'use strict';
// Detekce switche, který po upgradu ztratí management (adresa na vlan-filtering bridgi, jehož CPU není netagovaným členem své VLAN).
// Data odpovídají skutečné konfiguraci obou kusů, které to potkalo: Kenny3-Switch (9.9.2026) a Wifi switch Libuse (10.9.2026).
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
const { vlanMgmtRisk } = require('../lib/inspect');
let bad = 0;
const chk = (name, ok, detail) => { if (!ok) { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); bad++; } };

// Libuše před pádem: adresa na bridge1 (pvid 1124), VLAN 1124 má untagged jen ether23, k tomu vlan1124 na tomtéž bridgi
const libuseBr = [{ name: 'bridge1', 'vlan-filtering': 'true', pvid: '1124' }];
const libuseAddr = [{ address: '10.107.1.62/29', interface: 'bridge1', disabled: 'false' }, { address: '10.107.242.21', interface: 'vlan1120', disabled: 'true' }];
const libuseBv = [{ bridge: 'bridge1', 'vlan-ids': '1124', 'current-untagged': 'ether23' }, { bridge: 'bridge1', 'vlan-ids': '123', 'current-untagged': 'ether1;ether2' }];
const libuseVif = [{ name: 'vlan1124', interface: 'bridge1', 'vlan-id': '1124', disabled: 'false' }, { name: 'vlan120', interface: 'bridge1', 'vlan-id': '120', disabled: 'false' }];
{
  const r = vlanMgmtRisk(libuseBr, libuseAddr, libuseBv, libuseVif);
  chk('Libuše před pádem se pozná', r.length === 1, JSON.stringify(r));
  if (r[0]) { chk('pozná bridge a pvid', r[0].bridge === 'bridge1' && r[0].pvid === '1124', JSON.stringify(r[0])); chk('pojmenuje kolidující VLAN rozhraní', r[0].vlan_iface === 'vlan1124', r[0].vlan_iface); }
}
// po opravě: bridge1 doplněn do untagged (RouterOS vrací seznam se středníkem) a vlan1124 vypnuté
{
  const bv = [{ bridge: 'bridge1', 'vlan-ids': '1124', 'current-untagged': 'bridge1;ether23' }];
  const vif = [{ name: 'vlan1124', interface: 'bridge1', 'vlan-id': '1124', disabled: 'true' }];
  chk('po opravě už riziko nehlásí', vlanMgmtRisk(libuseBr, libuseAddr, bv, vif).length === 0);
}
// Kenny3 před pádem: bez kolidujícího VLAN rozhraní, jen chybějící netagované členství
{
  const r = vlanMgmtRisk([{ name: 'bridge1', 'vlan-filtering': 'true', pvid: '350' }], [{ address: '10.107.1.61/29', interface: 'bridge1' }],
    [{ bridge: 'bridge1', 'vlan-ids': '350', 'current-untagged': 'ether23;ether24' }], []);
  chk('Kenny3 před pádem se pozná', r.length === 1, JSON.stringify(r));
  if (r[0]) chk('bez VLAN rozhraní zůstane pole prázdné', r[0].vlan_iface === '', r[0].vlan_iface);
}
// běžné případy, které se blokovat NESMÍ
{
  const noFilter = vlanMgmtRisk([{ name: 'bridge1', 'vlan-filtering': 'false', pvid: '1' }], [{ address: '10.107.1.1/24', interface: 'bridge1' }], [], []);
  chk('bridge bez vlan-filtering neblokuje', noFilter.length === 0);
  const onVlanIface = vlanMgmtRisk([{ name: 'bridge1', 'vlan-filtering': 'true', pvid: '99' }], [{ address: '10.107.1.1/24', interface: 'vlan99' }],
    [{ bridge: 'bridge1', 'vlan-ids': '99', 'current-untagged': 'ether1' }], [{ name: 'vlan99', interface: 'bridge1', 'vlan-id': '99' }]);
  chk('adresa na VLAN rozhraní neblokuje', onVlanIface.length === 0);
  const noEntry = vlanMgmtRisk([{ name: 'bridge1', 'vlan-filtering': 'true', pvid: '7' }], [{ address: '10.107.1.1/24', interface: 'bridge1' }],
    [{ bridge: 'bridge1', 'vlan-ids': '10', 'current-untagged': 'ether1' }], []);
  chk('bez záznamu pro pvid neblokuje', noEntry.length === 0);
  const range = vlanMgmtRisk([{ name: 'bridge1', 'vlan-filtering': 'yes', pvid: '1122' }], [{ address: '10.107.1.1/24', interface: 'bridge1' }],
    [{ bridge: 'bridge1', 'vlan-ids': '1120-1124', 'current-untagged': 'bridge1;ether5' }], []);
  chk('rozsah VLAN se započítá', range.length === 0, JSON.stringify(range));
  const disabledAddr = vlanMgmtRisk(libuseBr, [{ address: '10.107.1.62/29', interface: 'bridge1', disabled: 'true' }], libuseBv, libuseVif);
  chk('vypnutá adresa se nepočítá', disabledAddr.length === 0);
}
if (bad) { console.error(`kontrola VLAN managementu: ${bad} chyb`); process.exit(1); }
console.log('VLAN management OK');
