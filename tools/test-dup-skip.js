#!/usr/bin/env node
'use strict';
// Duplicitní IP / víc rozhraní jednoho routeru (5.11.2026): záznam s dup_of se při upgradu NEpřipojuje a nevyhazuje „zařízení vypnuto",
// jen hezky upozorní a přeskočí s odkazem na hlavní záznam; souhrn jobu to nepočítá jako chybu. Test přes HTTP + čekání na dokončení.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-dup-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin'; process.env.PORT = '28988'; process.env.MTU_USERDB_USER=''; process.env.MTU_USERDB_PASS='';
const db = require('../lib/db');
let fail = 0; const chk = (n, ok, e='') => { console.log(`  ${ok?'✓':'✗'} ${n}${e?' — '+e:''}`); if (!ok) fail++; };
const BASE='http://127.0.0.1:28988'; let cookie='';
const req=(m,p,b)=>new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=http.request(BASE+p,{method:m,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{const sc=x.headers['set-cookie'];if(sc)cookie=sc[0].split(';')[0];let j=null;try{j=JSON.parse(s);}catch{}res({status:x.statusCode,body:j});});});r.on('error',rej);if(d)r.write(d);r.end();});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  require('../server.js');
  await sleep(1500);
  await req('POST','/api/login',{username:'admin',password:'heslotest1234'});
  const M = db.insertDevice({ host:'10.9.0.1', port:22, owner_id:1 }); db.updateDevice(M,{ managed:1, enabled:1, name:'router HLAVNÍ', board_name:'RB5009', version:'7.10', serial:'XX1', scan_status:'ok' });
  const D = db.insertDevice({ host:'10.9.0.2', port:22, owner_id:1 }); db.updateDevice(D,{ managed:1, enabled:0, name:'router rozhraní 2', board_name:'RB5009', version:'7.10', serial:'XX1', dup_of:M });

  const r = await req('POST','/api/jobs',{ name:'dup test', deviceIds:[D], start:true, options:{ dry_run:false, precheck:false } });
  chk('job vytvořen', r.status===200 && r.body && r.body.id, JSON.stringify(r.body));
  const jobId = r.body.id;
  let job=null;
  for (let i=0;i<40;i++){ job=db.getJob(jobId); if(job && job.status==='done') break; await sleep(250); }
  chk('job dokončen', job && job.status==='done', job && job.status);
  const items = db.getJobItems(jobId);
  const it = items.find(x=>x.device_id===D);
  chk('duplicitní záznam přeskočen (skipped)', it && it.status==='skipped', it && it.status);
  chk('označen jako dup (result.dup)', it && it.result && it.result.dup===true);
  chk('NEhlásí chybu „vypnuto"', it && it.error !== 'zařízení vypnuto', it && JSON.stringify(it.error));
  chk('krok odkazuje na hlavní záznam', it && /jiné rozhraní téhož kusu/.test(it.step||''), it && it.step);
  chk('souhrn není „nic neprovedeno"', job && !/nic neprovedeno/.test(job.status_note), job && job.status_note);
  chk('souhrn zmiňuje jiné rozhraní téhož kusu', job && /jiné rozhraní téhož kusu/.test(job.status_note), job && job.status_note);

  // naplánovaný job: předběžná kontrola musí dup kus vypsat i s důvodem (ne jen započítat do „přeskočí se")
  const future = new Date(Date.now()+3600e3).toISOString();
  const rs = await req('POST','/api/jobs',{ name:'dup sched', deviceIds:[D], start:true, options:{ dry_run:false, precheck:true, start_at:future } });
  chk('naplánovaný job vytvořen', rs.status===200 && rs.body && rs.body.id, JSON.stringify(rs.body));
  const sid = rs.body.id;
  let sj=null;
  for (let i=0;i<60;i++){ sj=db.getJob(sid); if(sj && sj.options && sj.options.early_precheck) break; await sleep(250); }
  chk('předběžná kontrola naplánovaného jobu proběhla', sj && sj.options && sj.options.early_precheck, sj && sj.status);
  const reasons = (sj && sj.options && sj.options.early_precheck && sj.options.early_precheck.reasons) || [];
  chk('dup kus je ve výpisu důvodů předběžné kontroly', reasons.some(x=>/jiné rozhraní/.test(x)), JSON.stringify(reasons));
  chk('naplánovaný job zůstal scheduled', sj && sj.status==='scheduled', sj && sj.status);

  console.log(fail?`\n${fail} chyb`:'\nvše v pořádku');
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
