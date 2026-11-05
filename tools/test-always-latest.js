#!/usr/bin/env node
'use strict';
// „Vždy nejnovější vydání" (5.11.2026): přepínač always_latest v nastavení → připnuté cílové verze (pin_*) se ignorují a cíl = poslední
// z MikroTiku. Test přes HTTP: s pinem a vypnutým přepínačem je cíl připnutý; po zapnutí přepínače je pin ignorovaný (floor prázdný).
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-al-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin'; process.env.PORT = '28991'; process.env.MTU_USERDB_USER=''; process.env.MTU_USERDB_PASS='';
let fail = 0; const chk = (n, ok, e='') => { console.log(`  ${ok?'✓':'✗'} ${n}${e?' — '+e:''}`); if (!ok) fail++; };
const BASE='http://127.0.0.1:28991'; let cookie='';
const req=(m,p,b)=>new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=http.request(BASE+p,{method:m,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{const sc=x.headers['set-cookie'];if(sc)cookie=sc[0].split(';')[0];let j=null;try{j=JSON.parse(s);}catch{}res({status:x.statusCode,body:j});});});r.on('error',rej);if(d)r.write(d);r.end();});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  require('../server.js');
  await sleep(1500);
  await req('POST','/api/login',{username:'admin',password:'heslotest1234'});

  // pin nastavený, přepínač vypnutý → cíl je připnutá verze
  let r = await req('PUT','/api/settings',{ pin_v7_stable:'7.24.2', pin_v7_long_term:'', pin_v6_long_term:'', always_latest:false });
  chk('nastavení uloženo (pin + přepínač vyp)', r.status===200, JSON.stringify(r.body).slice(0,80));
  let v = (await req('GET','/api/versions')).body;
  chk('s vypnutým přepínačem je cíl připnutý (7.24.2, pinned)', v && v.versions && v.versions['v7-stable'] && v.versions['v7-stable'].version==='7.24.2' && v.versions['v7-stable'].pinned===true, JSON.stringify(v && v.versions && v.versions['v7-stable']));
  chk('floor (spodní mez) obsahuje připnutou verzi', v && v.floor && v.floor['v7-stable']==='7.24.2', JSON.stringify(v && v.floor));

  // zapnu přepínač → pin se ignoruje
  r = await req('PUT','/api/settings',{ always_latest:true });
  chk('přepínač zapnut', r.status===200);
  v = (await req('GET','/api/versions')).body;
  const vs = v && v.versions && v.versions['v7-stable'];
  chk('pin se už nebere jako cíl (není pinned 7.24.2)', !(vs && vs.pinned===true && vs.version==='7.24.2'), JSON.stringify(vs));
  chk('floor je prázdný (žádná připnutá mez)', v && v.floor && !v.floor['v7-stable'], JSON.stringify(v && v.floor));

  // vypnu zpět → pin se zase bere (hodnota zůstala uložená)
  r = await req('PUT','/api/settings',{ always_latest:false });
  v = (await req('GET','/api/versions')).body;
  chk('po vypnutí přepínače je pin zpět (7.24.2, pinned)', v && v.versions && v.versions['v7-stable'] && v.versions['v7-stable'].version==='7.24.2' && v.versions['v7-stable'].pinned===true, JSON.stringify(v && v.versions && v.versions['v7-stable']));

  console.log(fail?`\n${fail} chyb`:'\nvše v pořádku');
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
