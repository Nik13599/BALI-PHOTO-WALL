import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

test('BALI unified control room: secure screen settings, real LED status and separated storage',
 {timeout:30000},async()=>{
  const port=13961,base='http://127.0.0.1:'+port;
  const dir=await mkdtemp(path.join(tmpdir(),'bali-control-'));
  const server=spawn(process.execPath,['server.mjs'],{
   env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,
    ADMIN_PASSWORD:'control-room-test-password',
    SCREEN_PASSWORD:'screen-control-test-password',
    SESSION_SECRET:'long-secret-for-photo-wall-control-test-123456',
    NODE_ENV:'development',CONTEST_BRIDGE_KEY:'',BALI_REWARDS_WEBHOOK_URL:'',
    BALI_REWARDS_SECRET:''},stdio:['ignore','pipe','pipe']});
  let log='';server.stdout.on('data',x=>log+=String(x));
  server.stderr.on('data',x=>log+=String(x));
  const send=(url,opts)=>fetch(base+url,opts);
  try{
   let ready=false;
   for(let i=0;i<70;i++){
    if(server.exitCode!==null)throw Error('Server exited: '+log);
    try{const x=await send('/healthz');if(x.ok){ready=true;break}}catch{}
    await new Promise(resolve=>setTimeout(resolve,160));
   }
   assert(ready,'Could not start PHOTO WALL: '+log);
   assert.equal((await send('/admin/control')).status,200);
   assert.equal((await send('/api/admin/control/status')).status,401);
   assert.equal((await send('/api/admin/control/screen')).status,401);
   assert.equal((await send('/api/screen/control-settings')).status,401);
   const logged=await send('/api/admin/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:'control-room-test-password'})});
   assert.equal(logged.status,200);
   const adminCookie=logged.headers.get('set-cookie').split(';')[0];
   const header={Cookie:adminCookie};
   let response=await send('/api/admin/control/status',{headers:header});
   assert.equal(response.status,200);
   let data=await response.json();
   assert.equal(data.photoWall.online,true);
   assert.equal(data.photoWall.screenConnected,false);
   assert.equal(data.photoWall.ordinary.total,0);
   assert.equal(data.baliMenu.online,false);
   response=await send('/api/admin/control/screen',{headers:header});
   let current=await response.json();
   assert.equal(current.settings.maxPhotos,500);
   const mutate=(payload,extra={})=>send('/api/admin/control/screen',{
    method:'POST',headers:{'Content-Type':'application/json',Cookie:adminCookie,
     'X-BALI-Action':'1',...extra},body:JSON.stringify(payload)});
   assert.equal((await mutate({...current.settings,layout:'not-a-layout'})).status,400);
   assert.equal((await mutate({...current.settings,layout:'grid'},
    {'X-BALI-Action':'0'})).status,403);
   const custom={...current.settings,layout:'live-mosaic',maxPhotos:184,
    liveInterval:11,showQr:false};
   response=await mutate(custom);
   assert.equal(response.status,200);
   current=await response.json();
   assert.equal(current.settings.showQr,false);
   assert.equal(current.settings.maxPhotos,184);
   const screenLogin=await send('/api/screen/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:'screen-control-test-password'})});
   assert.equal(screenLogin.status,200);
   const screenCookie=screenLogin.headers.get('set-cookie').split(';')[0];
   response=await send('/api/screen/control-settings',{headers:{Cookie:screenCookie}});
   data=await response.json();
   assert.deepEqual(data.settings,custom);
   assert(data.updatedAt>0);
   response=await send('/api/screen/control-heartbeat',{method:'POST',
    headers:{Cookie:screenCookie,'Content-Type':'application/json'},
    body:JSON.stringify({layout:'live-mosaic'})});
   assert.equal(response.status,200);
   response=await send('/api/admin/control/status',{headers:header});
   data=await response.json();
   assert.equal(data.photoWall.screenConnected,true);
   assert.equal(data.photoWall.screenLayout,'live-mosaic');
   // Club remains independent of BALI-MENU network and quotas.
   assert.equal(data.photoWall.ordinary.total,0);
  }finally{
   if(server.exitCode===null){
    const gone=new Promise(resolve=>server.once('exit',resolve));
    server.kill('SIGTERM');await gone;
   }
   await rm(dir,{recursive:true,force:true});
  }
});
