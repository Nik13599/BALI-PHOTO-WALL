import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('Real server isolates rehearsal photos, accepts uploads outside hours, counts down, finalizes podium and restores production',{timeout:45000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'bali-rehearsal-'));
 const stateFile=path.join(dir,'policy.json'),date='2026-11-03';
 const sid='test_01234567-89ab-cdef-0123-456789abcdef';
 const state={tally:[],policy:{ok:true,test:{enabled:true,phase:'registration',sessionId:sid},
  current:{session:{date,eventId:date+'__3',testSessionId:sid,partyName:'ТЕСТ',contestName:'Тест конкурса'}},
  buttons:{wall:{open:false},registration:{open:true},vote:{open:false,visible:true,mode:'manual-off'}},
  resultAtMs:null,winnerCount:3}};
 const save=()=>writeFile(stateFile,JSON.stringify(state));await save();
 const port=13687,base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['--import','./tests/rehearsal-cloud.mjs','server.mjs'],{stdio:['ignore','pipe','pipe'],env:{...process.env,
  DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:base,NODE_ENV:'development',MIN_FREE_DISK_MB:'100',
  REHEARSAL_POLICY_FILE:stateFile,ADMIN_PASSWORD:'rehearsal-admin-password',SCREEN_PASSWORD:'rehearsal-screen-password',SESSION_SECRET:'rehearsal-session-secret-0123456789abcdef'}});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 const request=(p,o)=>fetch(base+p,o);
 try{
  let ready=false;
  for(let n=0;n<80;n++){if(child.exitCode!==null)throw Error(logs);try{if((await request('/healthz')).ok){ready=true;break}}catch{}await pause(100)}
  assert.ok(ready,logs);
  const status=await (await request('/api/contest/status')).json();
  assert.equal(status.test_supported,true);assert.equal(status.test_session_id,sid);
  assert.equal(status.registration_open,true);
  const image=await sharp({create:{width:64,height:64,channels:3,background:'#cda450'}}).png().toBuffer();
  const proof=n=>({uid:'user-'+n,eventId:date+'__3',name:'Test Person '+n,username:'',telegramName:'Test Person '+n,testSessionId:sid});
  async function upload(p){const form=new FormData();form.append('ticket',Buffer.from(JSON.stringify(p)).toString('base64url'));form.append('photo',new Blob([image],{type:'image/png'}),'test.png');return request('/api/contest/entry',{method:'POST',headers:{Origin:'https://app.baliminsk.by'},body:form})}
  const entered=[];
  for(let n=1;n<=3;n++){const r=await upload(proof(n)),body=await r.json();assert.equal(r.status,201,JSON.stringify(body));entered.push(body.id)}
  assert.equal((await upload(proof(1))).status,409,'one contestant photo per BALI ID');
  assert.equal((await upload({...proof(4),testSessionId:'test_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})).status,409,'a stale proof cannot enter this test');
  const login=await request('/api/screen/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'rehearsal-screen-password'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const general=await (await request('/api/screen',{headers:{cookie}})).json();assert.equal(general.photos.length,0,'test photos never enter general gallery');
  const adminLogin=await request('/api/admin/login',{method:'POST',
   headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'rehearsal-admin-password'})});
  assert.equal(adminLogin.status,200);
  const adminCookie=adminLogin.headers.get('set-cookie').split(';')[0];
  const mutationHeaders={Cookie:adminCookie,'X-BALI-Action':'1','Content-Type':'application/json'};
  const firstPhotoId=Number(entered[0]);
  assert.ok(Number.isSafeInteger(firstPhotoId)&&firstPhotoId>0);
  const beforePhoto=(await request('/api/admin/photos/'+firstPhotoId,{headers:{Cookie:adminCookie}})).status;
  assert.equal(beforePhoto,200);
  const newImage=await sharp({create:{width:92,height:68,channels:3,background:'#287bd8'}}).png().toBuffer();
  const newForm=new FormData();newForm.append('photo',new Blob([newImage],{type:'image/png'}),'photoshop-export.png');
  const replaced=await request('/api/admin/photos/'+firstPhotoId+'/replace',{
   method:'POST',headers:{Cookie:adminCookie,'X-BALI-Action':'1'},body:newForm});
  assert.equal(replaced.status,200,await replaced.text());
  const replacementCount=await (await request('/api/admin/contest/history',{headers:{Cookie:adminCookie}})).json();
  assert.ok(replacementCount.ok,'replace leaves the contest history handler intact');
  // The same BALI contestant remains registered after a local file replacement.
  const afterChange=await (await request('/api/contest/status')).json();
  assert.equal(afterChange.approved_count,3);
  state.policy.test.phase='voting';state.policy.buttons.registration.open=false;state.policy.buttons.vote={open:true,visible:true,mode:'manual-on'};await save();await pause(5200);
  const ballot=await (await request('/api/contest/status')).json();
  assert.equal(ballot.voting_open,true);assert.equal(ballot.candidates.length,3,'test photos need no production moderation');
  assert.equal(Number(String(ballot.candidates[0].id).replace(/^p_/,'')),firstPhotoId);
  const changedDuringBallot=await request('/api/admin/photos/'+firstPhotoId+'/status',{
   method:'POST',headers:mutationHeaders,body:JSON.stringify({status:'rejected'})});
  assert.equal(changedDuringBallot.status,409,'moderators must not change vote-eligible photographs');
  const lateForm=new FormData();lateForm.append('photo',new Blob([newImage],{type:'image/png'}),'late.png');
  const lateReplace=await request('/api/admin/photos/'+firstPhotoId+'/replace',{
   method:'POST',headers:{Cookie:adminCookie,'X-BALI-Action':'1'},body:lateForm});
  assert.equal(lateReplace.status,409,'cannot replace a photo when voting is open');
  const removedDuringBallot=await request('/api/admin/photos/'+firstPhotoId,{
   method:'DELETE',headers:mutationHeaders,body:'{}'});
  assert.equal(removedDuringBallot.status,409,'contestants cannot vanish during voting');
  state.tally=ballot.candidates.map((c,i)=>({id:c.id,votes:3-i}));
  const deadline=Date.now()+7300;state.policy.test.phase='countdown';state.policy.test.deadlineMs=deadline;
  state.policy.resultAtMs=deadline;state.policy.buttons.vote.open=false;await save();await pause(5200);
  const counting=await (await request('/api/screen/contest',{headers:{cookie}})).json();
  assert.equal(counting.finalized,false);assert.equal(counting.countdownEndsAtMs,deadline);
  await pause(2400);
  const winners=await (await request('/api/screen/contest',{headers:{cookie}})).json();
  assert.equal(winners.finalized,true,logs);assert.equal(winners.phase,'closed');assert.equal(winners.winners.length,3);
  assert.deepEqual(winners.winners.map(w=>[w.place,w.votes]),[[1,3],[2,2],[3,1]]);
  assert.equal(winners.photos.length,3);
  const removedAfterResult=await request('/api/admin/photos/'+firstPhotoId,{
   method:'DELETE',headers:mutationHeaders,body:'{}'});
  assert.equal(removedAfterResult.status,409,'the permanent winner archive must not be deleted by moderation');
  const history=await (await request('/api/contest/history')).json();assert.equal(history.contests.length,0,'rehearsal awards never enter real history');
  state.policy.test={enabled:false};state.policy.current.session=null;state.policy.resultAtMs=null;await save();await pause(5200);
  const stopped=await (await request('/api/contest/status')).json();assert.equal(stopped.test_session_id,null);assert.equal(stopped.contest_available,false);
 }finally{
  if(child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit}
  await rm(dir,{recursive:true,force:true});
 }
});
