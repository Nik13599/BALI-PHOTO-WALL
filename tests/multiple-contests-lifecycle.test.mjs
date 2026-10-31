import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import Database from 'better-sqlite3';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('same-night contests are isolated and cancellation deletes the old Windows run before another starts',
 {timeout:55000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'bali-multiple-contests-'));
 const date=new Date(Date.now()+10800000).toISOString().slice(0,10);
 const ids=['01234567-89ab-4cde-8f01-23456789abcd','12345678-89ab-4cde-8f01-23456789abce'];
 const stateFile=path.join(dir,'policy.json'),port=13821,base='http://127.0.0.1:'+port;
 const state={tally:[],policy:{ok:true,test:{enabled:false},winnerCount:1,
  current:{session:{date,eventId:date,partyName:'BALI',contestName:'КОРОЛЬ ВЕЧЕРА'}},
  session:{date,eventId:date,partyName:'BALI',contestName:'КОРОЛЬ ВЕЧЕРА'},
  buttons:{wall:{open:true},registration:{open:true},vote:{open:false,visible:true}},
  resultAtMs:Date.now()+3600000,contestPhase:'registration',registrationEndsAtMs:Date.now()+3600000,
  broadcast:{runId:ids[0],phase:'running',startsAtMs:Date.now()-30000,active:true,cancelRunId:''}}};
 const save=()=>writeFile(stateFile,JSON.stringify(state));
 await save();
 const app=spawn(process.execPath,['--import','./tests/rehearsal-cloud.mjs','server.mjs'],{
  env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:base,
   NODE_ENV:'development',MIN_FREE_DISK_MB:'100',REHEARSAL_POLICY_FILE:stateFile,
   ADMIN_PASSWORD:'multi-contest-admin-password',
   SCREEN_PASSWORD:'multi-contest-screen-password',
   SESSION_SECRET:'multi-contest-session-secret-0123456789abcdef'},
  stdio:['ignore','pipe','pipe']});
 let logs='';app.stdout.on('data',v=>logs+=v);app.stderr.on('data',v=>logs+=v);
 let database=null;
 const req=(p,opts)=>fetch(base+p,{...opts,signal:AbortSignal.timeout(12000)});
 const img=await sharp({create:{width:96,height:96,channels:3,background:'#24588b'}}).png().toBuffer();
 const upload=async(uid,runId)=>{
  const proof={uid,eventId:date,name:'Verified BALI User',telegramName:'Verified Telegram',
   username:'@verified_test',telegramId:'123456789',cardNumber:'000123',broadcastRunId:runId};
  const form=new FormData();form.append('ticket',Buffer.from(JSON.stringify(proof)).toString('base64url'));
  form.append('photo',new Blob([img],{type:'image/png'}),'contest.png');
  return req('/api/contest/entry',{method:'POST',headers:{Origin:'https://app.baliminsk.by'},body:form});
 };
 try{
  let online=false;
  for(let i=0;i<100;i++){if(app.exitCode!==null)throw Error(logs);try{if((await req('/healthz')).ok){online=true;break}}catch{}await pause(100)}
  assert.ok(online,logs);
  let health=await (await req('/api/operator/ready')).json();
  assert.equal(health.runId,ids[0]);
  const visitor=await req('/api/public');
  const visitorCookie=visitor.headers.get('set-cookie')?.split(';')[0];
  assert.ok(visitorCookie);
  const generalForm=new FormData();
  generalForm.append('photo',new Blob([img],{type:'image/png'}),'general-photo.png');
  generalForm.append('consent','yes');
  const generalUpload=await req('/api/upload',{method:'POST',headers:{Cookie:visitorCookie},body:generalForm});
  assert.equal(generalUpload.status,201,await generalUpload.text());
  const first=await upload('user-1234',ids[0]);const firstData=await first.json();
  assert.equal(first.status,201,JSON.stringify(firstData));
  const header={Authorization:'Bearer test-moderator-proof-0123456789abcdef0123456789',
   'Content-Type':'application/json'};
  const list=await req('/api/operator/contest-moderation',{
   method:'POST',headers:header,body:JSON.stringify({runId:ids[0],action:'list',photoId:0,page:1,status:'pending'})});
  const inbox=await list.json();assert.equal(list.status,200,JSON.stringify(inbox));
  assert.equal(inbox.counts.pending,1);
  assert.equal(inbox.items[0].cardNumber,'000123');
  assert.equal(inbox.items[0].username,'@verified_test');
  assert.match(inbox.items[0].thumbnailData,/^data:image\/webp;base64,/);
  const approved=await req('/api/operator/contest-moderation',{
   method:'POST',headers:header,body:JSON.stringify({runId:ids[0],action:'approve',
    photoId:firstData.id,page:1,status:'pending'})});
  assert.equal(approved.status,200,await approved.text());
  database=new Database(path.join(dir,'bali-photo-wall.sqlite'),{readonly:true});
  const firstRun=database.prepare('SELECT * FROM managed_broadcast_runs WHERE run_id=?').get(ids[0]);
  assert.ok(firstRun);
  const preservedPhoto=database.prepare("SELECT id,filename FROM photos WHERE event_id=? AND photo_area='general'")
   .get(firstRun.general_event_id);
  assert.ok(preservedPhoto);
  const firstNomination=database.prepare('SELECT * FROM contest_telegram_entries WHERE event_id=?').get(firstRun.contest_event_id);
  assert.equal(firstNomination.bali_card_number,'000123');
  assert.equal(firstNomination.telegram_username,'@verified_test');
  assert.equal(firstNomination.telegram_provider_id,'123456789');
  state.policy.broadcast={runId:'',phase:'stopped',startsAtMs:null,active:false,cancelRunId:ids[0]};
  await save();await pause(5300);
  for(let attempt=0;attempt<12;attempt++){
   const response=await req('/api/operator/ready');
   health=await response.json();
   if(health.cancelledRunId===ids[0])break;
   await pause(500);
  }
  assert.equal(health.cancelledRunId,ids[0],logs);
  assert.equal(health.runId,null);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM managed_broadcast_runs WHERE run_id=?').get(ids[0]).n,0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM contest_telegram_entries WHERE event_id=?').get(firstRun.contest_event_id).n,0);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM photos WHERE event_id=? AND photo_area='general'")
   .get(firstRun.general_event_id).n,1,'ordinary BALI photo wall survives contest cancel');
  assert.equal(existsSync(path.join(dir,'photos',preservedPhoto.filename)),true);
  const late=await upload('user-1234',ids[0]);assert.equal(late.status,409,'cancelled run cannot be revived');
  state.policy.broadcast={runId:ids[1],phase:'running',startsAtMs:Date.now()-2000,active:true,cancelRunId:''};
  state.policy.resultAtMs=Date.now()+3600000;
  await save();await pause(5300);
  health=await (await req('/api/operator/ready')).json();
  assert.equal(health.runId,ids[1],logs);
  const second=await upload('user-1234',ids[1]);assert.equal(second.status,201,await second.text());
  const next=database.prepare('SELECT * FROM managed_broadcast_runs WHERE run_id=?').get(ids[1]);
  assert.ok(next&&next.event_date===firstRun.event_date);
  assert.notEqual(next.contest_event_id,firstRun.contest_event_id);
  assert.equal(next.general_event_id,firstRun.general_event_id,
   'the normal wall keeps its gallery while the contest rotates');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM contest_telegram_entries WHERE event_id=?').get(next.contest_event_id).n,1);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM contest_telegram_entries WHERE event_id=?').get(firstRun.contest_event_id).n,0);
  database.close();database=null;
 }finally{
  if(database)database.close();
  if(app.exitCode===null){const ended=new Promise(r=>app.once('exit',r));app.kill('SIGTERM');await ended}
  await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:300});
 }
});
