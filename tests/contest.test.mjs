import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import Database from 'better-sqlite3';

test('BALI contest: external signup, moderation, votes, winners and durable rewards', {timeout:50000},async()=>{
 const port=13947,url='http://127.0.0.1:'+port,dir=await mkdtemp(path.join(tmpdir(),'bali-contest-'));
 const server=spawn(process.execPath,['server.mjs'],{
  env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,
   NODE_ENV:'development',ADMIN_PASSWORD:'contest-admin-test-secret',
   SCREEN_PASSWORD:'contest-screen-test-secret',
   SESSION_SECRET:'test-only-session-secret-is-long-enough-123456',
   CONTEST_BRIDGE_KEY:'test-only-bridge-key-is-long-enough-123456',
   CONTEST_ALLOW_LOCAL_RESULTS:'1',
   BALI_REWARDS_WEBHOOK_URL:'',BALI_REWARDS_SECRET:''},
  stdio:['ignore','pipe','pipe']
 });
 let output='';server.stdout.on('data',x=>output+=String(x));server.stderr.on('data',x=>output+=String(x));
 const request=(p,opts={})=>fetch(url+p,opts);
 const asJson=async p=>p.json();
 try{
  let ready=false;
  for(let i=0;i<80;i++){
   if(server.exitCode!==null)throw new Error('Server exited: '+output);
   try{const r=await request('/healthz');if(r.ok){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,150));
  }
  assert.ok(ready,'Server not ready: '+output);
  assert.equal((await request('/admin/contest')).status,200);
  const online=await (await request('/api/public/photo-wall-status')).json();
  assert.equal(online.online,true,'Ordinary photo uploads can work independently of the contest');
  assert.equal((await request('/api/integrations/contest-state')).status,401,
   'Unauthenticated website bridge must be denied');
  const adminLogin=await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({password:'contest-admin-test-secret'})});
  const adminCookie=adminLogin.headers.get('set-cookie').split(';')[0];
  const admin={Cookie:adminCookie,'Content-Type':'application/json','X-BALI-Action':'1'};
  const mutation=(p,body)=>request(p,{method:'POST',headers:admin,body:JSON.stringify(body)});
  const screenLogin=await request('/api/screen/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({password:'contest-screen-test-secret'})});
  const screen={Cookie:screenLogin.headers.get('set-cookie').split(';')[0]};
  assert.equal((await request('/api/screen/contest',{headers:screen})).status,200);
  assert.equal((await request('/api/admin/contest')).status,401);
  let r=await mutation('/api/admin/contest/settings',{title:'КОРОЛЬ И КОРОЛЕВА НОЧИ',
   prizePlaces:3,shape:'square',tileHeight:220,tileSpeed:80,durationSeconds:60});
  assert.equal(r.status,200,await r.text());
  r=await mutation('/api/admin/contest/prizes',{prizes:[
   {baliCoins:100,bonuses:[{code:'shot',quantity:2}]},
   {baliCoins:50,bonuses:[{code:'cocktail',quantity:1}]},
   {baliCoins:25,bonuses:[{code:'free_entry',quantity:1}]}]});
  assert.equal(r.status,200);
  const img=await sharp({create:{width:140,height:200,channels:3,background:'#afbb70'}}).png().toBuffer();
  const bridgeHeaders={'X-BALI-Bridge-Key':'test-only-bridge-key-is-long-enough-123456'};
  let idList=[];
  for(let i=1;i<=3;i++){
   const form=new FormData();
   form.append('photo',new Blob([img],{type:'image/png'}),'participant.png');
   form.append('externalId','person_'+i);
   form.append('name','Гость '+i);
   form.append('baliCardId',String(100000+i));
   form.append('consent','yes');
   r=await request('/api/integrations/contest-entry',{method:'POST',headers:bridgeHeaders,body:form});
   assert.equal(r.status,201,await r.text());
   const received=await (await request('/api/admin/contest',{headers:{Cookie:adminCookie}})).json();
   idList.push(received.entries.find(e=>e.external_id==='person_'+i).id);
  }
  assert.equal((await request('/api/screen/contest/photo/'+idList[0],{headers:screen})).status,404);
  for(const id of idList){
   r=await mutation('/api/admin/contest/entries/'+id+'/crop',{x:50,y:50});
   assert.equal(r.status,200);
   r=await mutation('/api/admin/contest/entries/'+id+'/status',{status:'approved'});
   assert.equal(r.status,200);
  }
  r=await mutation('/api/admin/contest/start',{});
  assert.equal(r.status,200);
  const active=await (await request('/api/screen/contest',{headers:screen})).json();
  assert.equal(active.contest.state,'live');
  assert.equal(active.entries.length,3);
  const websiteMirror=await (await request('/api/integrations/contest-state',{headers:bridgeHeaders})).json();
  assert.equal(websiteMirror.contest.phase,'voting');
  assert.deepEqual(websiteMirror.entries.map(p=>p.number),idList);
  assert.equal(websiteMirror.entries.every(p=>typeof p.externalId==='string'),true);
  assert.equal((await request('/api/public/contest-photo/'+idList[0])).status,200,
   'Voting gallery images are public only after moderation and contest launch');
  assert.equal((await request('/api/screen/contest/photo/'+idList[0],{headers:screen})).status,200);
  const vote=(person,voter)=>request('/api/integrations/contest-vote',{method:'POST',
   headers:{...bridgeHeaders,'Content-Type':'application/json'},
   body:JSON.stringify({externalId:person,voterId:voter})});
  for(let i=0;i<5;i++)assert.equal((await vote('person_1','voter1_'+i)).status,201);
  for(let i=0;i<3;i++)assert.equal((await vote('person_2','voter2_'+i)).status,201);
  assert.equal((await vote('person_3','voter3')).status,201);
  assert.equal((await vote('person_1','voter3')).status,409,'Same voter cannot vote twice');
  const sqlite=new Database(path.join(dir,'bali-photo-wall.sqlite'));
  sqlite.prepare("UPDATE contests SET ends_at=? WHERE state='live'").run(Date.now()-1000);
  sqlite.close();
  const complete=await (await request('/api/screen/contest',{headers:screen})).json();
  assert.equal(complete.contest.state,'complete');
  assert.deepEqual(complete.winners.map(x=>x.place),[1,2,3]);
  assert.deepEqual(complete.winners.map(x=>x.votes),[5,3,1]);
  const websiteWinners=await (await request('/api/integrations/contest-state',{headers:bridgeHeaders})).json();
  assert.deepEqual(websiteWinners.entries.map(e=>e.number),idList);
  assert.equal(websiteWinners.contest.phase,'complete');
  assert.equal((await request('/api/screen/contest/photo/'+idList[0],{headers:screen})).status,200);
  assert.equal((await request('/api/integrations/contest-vote',{method:'POST',
   headers:{...bridgeHeaders,'Content-Type':'application/json'},body:JSON.stringify({externalId:'person_1',voterId:'late'})})).status,409);
  // Reward jobs are created by the periodic worker, not by the admin browser.
  const expected=3;let jobs=[];
  for(let i=0;i<60;i++){
   jobs=(await (await request('/api/admin/contest/rewards',{headers:{Cookie:adminCookie}})).json()).deliveries;
   if(jobs.length===expected)break;
   await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(jobs.length,3);
  assert(jobs.every(job=>job.status==='pending'));
  assert.deepEqual(jobs.map(x=>x.card_id),['100001','100002','100003']);
  const ledger=new Database(path.join(dir,'bali-photo-wall.sqlite'));
  const records=ledger.prepare('SELECT * FROM contest_reward_outbox ORDER BY place').all();
  assert.equal(records.length,3);
  assert.deepEqual(records.map(x=>JSON.parse(x.prize_json).prizes.baliCoins),[100,50,25]);
  ledger.close();
 }finally{
  if(server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}
  await rm(dir,{recursive:true,force:true});
 }
});
