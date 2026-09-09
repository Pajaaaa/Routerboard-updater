#!/usr/bin/env node
'use strict';
// Rozpoznávání pádu SSH a čtecích příkazů: podle toho se spojení obnovuje a příkaz opakuje (lib/ros.js).
// Zápisové příkazy se nesmí opakovat nikdy (restart, instalace balíčku, mazání souboru).
const { RosClient } = require('../lib/ros');
const READ = ['/system resource print without-paging', ':put [:len [/system script find ]]', '/interface wireless print detail',
  ':do {:foreach i in=[/ip neighbor find ] do={:put ([:tostr [/ip neighbor get $i address])}}', '/ping 10.0.0.1 count=3', '/file print',
  '/system logging action print detail without-paging', '/interface ethernet poe monitor ether1 once'];
const WRITE = ['/system reboot', '/ip service set ssh disabled=no', '/file remove [find name="x.npk"]', '/system package update install',
  '/tool fetch url="http://x/y" dst-path="y"', '/system backup save name=x', '/export file=x', '/system ntp client set servers=1.2.3.4',
  '/interface ethernet poe power-cycle ether1', '/system scheduler add name=x on-event=y',
  '/system device-mode update partitions=yes activation-timeout=10m', ':put [:execute script={/system device-mode update partitions=yes}]'];
const LOST = ['SSH: Keepalive timeout', 'Not connected', 'SSH: spojení uzavřeno routerem (nebo sítí) uprostřed operace', 'read ECONNRESET', 'SFTP: SSH: Keepalive timeout'];
const KEEP = ['RouterOS: no such item', 'SSH: timeout příkazu (30 s): /system resource print', 'RouterOS: not enough space'];
let bad = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; } };
for (const c of READ) chk(RosClient.isReadOnly(c), `čtecí příkaz brán jako zápis: ${c}`);
for (const c of WRITE) chk(!RosClient.isReadOnly(c), `zápisový příkaz brán jako čtení (opakoval by se!): ${c}`);
for (const m of LOST) chk(RosClient.isConnLost(m), `nerozpoznaný pád spojení: ${m}`);
for (const m of KEEP) chk(!RosClient.isConnLost(m), `mylně brané jako pád spojení: ${m}`);
if (bad) { console.error(`SSH retry: ${bad} chyb`); process.exit(1); }
console.log('SSH retry OK');
