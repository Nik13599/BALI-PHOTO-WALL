import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

test('moderator can upload several photos at once, approve and assign upper/lower tracks', {timeout:55000}, async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'bali-carousel-bulk-'));
  const port=13451;
  const origin='http://127.0.0.1:'+port;
  const app=spawn(process.execPath,['server.mjs'],{
    stdio:['ignore','pipe','pipe'],env:{
      ...process.env,DATA_DIR:folder,NODE_ENV:'development',HOST:'127.0.0.1',
      PORT:String(port),PUBLIC_URL:origin,MIN_FREE_DISK_MB:'100',
      MAX_PHOTOS_PER_GUEST:'0',MAX_PHOTOS_PER_EVENT:'0',
      ADMIN_PASSWORD:'bulk-test-admin-password-123',
      SCREEN_PASSWORD:'bulk-test-screen-password-123',
      SESSION_SECRET:'bulk-test-local-session-secret-12345678901234567890123456'
    }
  });
  let logs='';
  app.stderr.on('data',chunk=>logs+=String(chunk));
  const fetchApp=(route,options)=>fetch(origin+route,options);
  try{
    let ready=false;
    for(let i=0;i<80;i++){
      if(app.exitCode!==null)throw Error('Server failed: '+logs);
      try{if((await fetchApp('/healthz')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,120));
    }
    assert.ok(ready,'Server not ready: '+logs);
    const login=await fetchApp('/api/admin/login',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({password:'bulk-test-admin-password-123'})
    });
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const screenLogin=await fetchApp('/api/screen/login',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({password:'bulk-test-screen-password-123'})
    });
    assert.equal(screenLogin.status,200);
    const scookie=screenLogin.headers.get('set-cookie').split(';')[0];
    const dashboard=await (await fetchApp('/api/admin/dashboard',{headers:{cookie}})).json();
    const id=dashboard.selected.id;
    const landscape=await sharp({create:{width:640,height:360,channels:3,background:'#efab78'}}).png().toBuffer();
    const portrait=await sharp({create:{width:360,height:640,channels:3,background:'#8eab78'}}).png().toBuffer();
    const square=await sharp({create:{width:400,height:400,channels:3,background:'#ebffad'}}).png().toBuffer();
    function batch(pictures,status='approved',lane='top'){
      const body=new FormData();
      body.append('eventId',String(id));body.append('status',status);body.append('lane',lane);
      for(let i=0;i<pictures.length;i++)
        body.append('photos',new Blob([pictures[i]],{type:'image/png'}),'photo'+i+'.png');
      return body;
    }
    const unauth=await fetchApp('/api/admin/photos/bulk',{method:'POST',body:batch([square]),headers:{'X-BALI-Action':'1'}});
    assert.equal(unauth.status,401);
    const unactioned=await fetchApp('/api/admin/photos/bulk',{method:'POST',body:batch([square]),headers:{cookie}});
    assert.equal(unactioned.status,403);
    const saved=await fetchApp('/api/admin/photos/bulk',{
      method:'POST',body:batch([landscape,portrait,square]),headers:{cookie,'X-BALI-Action':'1'}
    });
    assert.equal(saved.status,200);
    const report=await saved.json();
    assert.equal(report.imported,3,JSON.stringify(report));
    assert.equal(report.failed,0);
    const wall=await (await fetchApp('/api/screen',{headers:{cookie:scookie}})).json();
    assert.equal(wall.photos.length,3);
    assert.ok(wall.photos.every(p=>p.screen_lane==='top'));
    assert.ok(wall.photos.some(p=>p.width>p.height));
    assert.ok(wall.photos.some(p=>p.width<p.height));
    assert.ok(wall.photos.some(p=>p.width===p.height));
    const first=wall.photos[0].id;
    const wrongLane=await fetchApp('/api/admin/photos/'+first+'/screen-lane',{
      method:'POST',headers:{cookie,'X-BALI-Action':'1','content-type':'application/json'},
      body:JSON.stringify({lane:'diagonal'})
    });
    assert.equal(wrongLane.status,400);
    const routed=await fetchApp('/api/admin/photos/'+first+'/screen-lane',{
      method:'POST',headers:{cookie,'X-BALI-Action':'1','content-type':'application/json'},
      body:JSON.stringify({lane:'bottom'})
    });
    assert.equal(routed.status,200);
    const updated=await (await fetchApp('/api/screen',{headers:{cookie:scookie}})).json();
    assert.equal(updated.photos.find(p=>p.id===first).screen_lane,'bottom');
    const pending=await fetchApp('/api/admin/photos/bulk',{
      method:'POST',body:batch([square,square],'pending','bottom'),headers:{cookie,'X-BALI-Action':'1'}
    });
    assert.equal(pending.status,200);
    assert.equal((await pending.json()).imported,2);
    const hidden=await (await fetchApp('/api/screen',{headers:{cookie:scookie}})).json();
    assert.equal(hidden.photos.length,3,'pending moderator imports must remain hidden');
    const all=await (await fetchApp('/api/admin/dashboard',{headers:{cookie}})).json();
    assert.equal(all.total,2,'default moderator list contains only pending photos');
    const approved=await (await fetchApp('/api/admin/dashboard?status=approved',{headers:{cookie}})).json();
    assert.equal(approved.total,3,'approved and pending status filters are independent');
  }finally{
    if(app.exitCode===null){
      const stopped=new Promise(resolve=>app.once('exit',resolve));
      app.kill('SIGTERM');
      await stopped;
    }
    await rm(folder,{force:true,recursive:true});
  }
});
