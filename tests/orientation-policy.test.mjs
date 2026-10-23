import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import sharp from 'sharp';

test('moderator square policy is enforced and orientation metadata reaches LED', {timeout:45000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bali-shapes-'));
  const origin='http://127.0.0.1:13439';
  const server=spawn(process.execPath,['server.mjs'],{
    stdio:['ignore','pipe','pipe'],
    env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:'13439',
      PUBLIC_URL:origin,NODE_ENV:'development',MAX_PHOTOS_PER_GUEST:'0',
      MAX_PHOTOS_PER_EVENT:'0',UPLOAD_REQUESTS_PER_HOUR:'0',MIN_FREE_DISK_MB:'100',
      ADMIN_PASSWORD:'test-admin-shapes-12345',SCREEN_PASSWORD:'test-screen-shapes-12345',
      SESSION_SECRET:'abcdefghijklmnopqrstuvwxyz1234567890abcdef'}
  });
  let logs='';
  server.stderr.on('data',buffer=>logs+=buffer);
  const req=(url,options={})=>fetch(origin+url,options);
  try{
    let ready=false;
    for(let i=0;i<100;i++){
      if(server.exitCode!==null)throw new Error('Server exited: '+logs);
      try{if((await req('/healthz')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,120));
    }
    assert.ok(ready,'Server did not start: '+logs);
    const login=await req('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-admin-shapes-12345'})});
    assert.equal(login.status,200);
    const admin=login.headers.get('set-cookie').split(';')[0];
    const screenLogin=await req('/api/screen/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-screen-shapes-12345'})});
    assert.equal(screenLogin.status,200);
    const screen=screenLogin.headers.get('set-cookie').split(';')[0];
    const guestReq=await req('/');
    const guest=guestReq.headers.get('set-cookie').split(';')[0];
    const event=(await (await req('/api/public')).json()).event;
    assert.equal(event.upload_shape,'any');
    const url='/api/admin/events/'+event.id+'/upload-shape';
    const payload={method:'POST',headers:{'content-type':'application/json','X-BALI-Action':'1'},body:JSON.stringify({uploadShape:'square'})};
    assert.equal((await req(url,payload)).status,401);
    assert.equal((await req(url,{...payload,headers:{...payload.headers,cookie:admin}})).status,200);
    assert.equal((await (await req('/api/public')).json()).uploadShape,'square');
    async function upload(image){
      const form=new FormData();
      form.append('photo',new Blob([image],{type:'image/png'}),'photo.png');
      form.append('consent','yes');
      return req('/api/upload',{method:'POST',headers:{cookie:guest},body:form});
    }
    const tall=await sharp({create:{width:120,height:220,channels:3,background:'#c0ce3c'}}).png().toBuffer();
    const square=await sharp({create:{width:120,height:120,channels:3,background:'#f0ce9a'}}).png().toBuffer();
    const blocked=await upload(tall);
    assert.equal(blocked.status,422,'Non-square bypass must fail server-side');
    assert.equal((await upload(square)).status,201,'Square photo should be accepted');
    const d=await (await req('/api/admin/dashboard',{headers:{cookie:admin}})).json();
    assert.equal(d.total,1);
    const id=d.photos[0].id;
    const approve=await req('/api/admin/photos/'+id+'/status',{
      method:'POST',headers:{cookie:admin,'X-BALI-Action':'1','content-type':'application/json'},
      body:JSON.stringify({status:'approved'})
    });
    assert.equal(approve.status,200);
    let wall=await (await req('/api/screen',{headers:{cookie:screen}})).json();
    assert.equal(wall.photos.length,1);
    assert.equal(wall.photos[0].width,wall.photos[0].height);
    assert.equal((await req(url,{...payload,headers:{...payload.headers,cookie:admin},body:JSON.stringify({uploadShape:'any'})})).status,200);
    assert.equal((await upload(tall)).status,201);
    const d2=await (await req('/api/admin/dashboard',{headers:{cookie:admin}})).json();
    const portraitId=d2.photos.find(p=>p.id!==id).id;
    assert.equal((await req('/api/admin/photos/'+portraitId+'/status',{
      method:'POST',headers:{cookie:admin,'X-BALI-Action':'1','content-type':'application/json'},
      body:JSON.stringify({status:'approved'})
    })).status,200);
    wall=await (await req('/api/screen',{headers:{cookie:screen}})).json();
    assert.equal(wall.photos.length,2);
    const portrait=wall.photos.find(p=>p.id===portraitId);
    assert.ok(portrait.height>portrait.width,'portrait ratio must be preserved');
  }finally{
    if(server.exitCode===null){
      const stopped=new Promise(resolve=>server.once('exit',resolve));
      server.kill('SIGTERM');await stopped;
    }
    await rm(dir,{recursive:true,force:true});
  }
});
