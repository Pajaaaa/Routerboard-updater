#!/usr/bin/env node
'use strict';
// Ochrana služeb na RouterOS 6 (5.11.2026): `/ip service find dynamic=no` vrací na v6 PRÁZDNÉ pole (v6 nemá u služeb příznak dynamic),
// dřív fallback bez filtru sepnul jen při null → ochrana tiše nic nenastavila a allow-list IP se na v6 nenasadil. Test: při prázdném
// filtrovaném čtení se přečte bez filtru a adresy (+ vypnutí nehlídaných služeb) se opravdu nastaví; ssh se mění jako poslední.
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-harden-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin';
const { Runner } = require('../lib/runner');
let fail = 0; const chk = (n, ok, e='') => { console.log(`  ${ok?'✓':'✗'} ${n}${e?' — '+e:''}`); if (!ok) fail++; };

const SERVICES = ['telnet','ftp','www','ssh','www-ssl','api','winbox','api-ssl'];
function mockV6() {
  const execCmds = [];
  let filteredReads = 0, unfilteredReads = 0;
  const svc = () => SERVICES.map(n => ({ name: n, disabled: 'false', address: '' })); // žádné omezení adres (jako ARCADE)
  const c = {
    localAddress: () => '10.107.1.5', // v povoleném seznamu → adresy se nastaví (pojistka nesepne)
    async list(menu, fields, opts = {}) {
      if (menu === '/ip service' && opts.where === 'dynamic=no') { filteredReads++; return []; } // v6: prázdno
      if (menu === '/ip service') { unfilteredReads++; return svc(); }
      return [];
    },
    async exec(cmd) { execCmds.push(cmd); if (/:put "ok"/.test(cmd)) return 'ok'; return ''; },
    _execCmds: execCmds, get filteredReads(){return filteredReads;}, get unfilteredReads(){return unfilteredReads;},
  };
  return c;
}

(async () => {
  const r = new Runner();
  const logs = []; const L = (lvl,m)=>logs.push(`${lvl}:${m}`); const W = (m)=>logs.push(`warn:${m}`);
  const settings = { harden_services: true, services_address: '10.107.0.0/16', services_keep: '' };
  const c = mockV6();
  const res = await r.hardenServices(c, L, W, settings, false);

  const sets = c._execCmds.filter(x => /^\/ip service set/.test(x));
  chk('filtrované čtení (dynamic=no) proběhlo', c.filteredReads >= 1);
  chk('fallback bez filtru sepnul (oprava v6)', c.unfilteredReads >= 1, 'unfiltered=' + c.unfilteredReads);
  chk('nastavily se adresy na službách (allow-list)', sets.some(x => /address="10\.107\.0\.0\/16/.test(x)), sets.join(' | ').slice(0,200));
  chk('privátní rozsahy přidány k adrese', sets.some(x => /192\.168\.0\.0\/16/.test(x) && /172\.16\.0\.0\/12/.test(x)));
  chk('nehlídané služby se vypínají (disabled=yes)', sets.some(x => /telnet/.test(x) && /disabled=yes/.test(x)));
  chk('ssh zůstává zapnuté (v keep)', !sets.some(x => / \[?find name="ssh"|^\/ip service set ssh /.test(x) && /disabled=yes/.test(x)));
  // ssh se mění jako poslední (po v7.22 zamrzá session)
  const sshIdx = sets.findIndex(x => /name="ssh"|set ssh /.test(x));
  const lastNonSsh = sets.map((x,i)=>/name="ssh"|set ssh /.test(x)?-1:i).reduce((a,b)=>Math.max(a,b),-1);
  chk('ssh příkaz je poslední', sshIdx === -1 || sshIdx > lastNonSsh, `sshIdx=${sshIdx} lastNonSsh=${lastNonSsh}`);
  chk('neloguje falešné „už odpovídá"', !logs.some(x => /už odpovídá/.test(x)), logs.filter(x=>/už odpovídá/.test(x)).join(''));

  // kontrola: když je harden_services vypnuté, nedělá nic
  const c2 = mockV6(); await r.hardenServices(c2, L, W, { harden_services: false }, false);
  chk('vypnutá ochrana služeb nic nenastaví', c2._execCmds.filter(x=>/set/.test(x)).length === 0);

  console.log(fail ? `\n${fail} chyb` : '\nvše v pořádku');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
