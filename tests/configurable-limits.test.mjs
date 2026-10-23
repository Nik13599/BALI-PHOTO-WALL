import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

test('legacy guest limit is ignored and guests can upload unlimited photos', { timeout: 45000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bali-unlimited-'));
  const port = 13333;
  const url = 'http://127.0.0.1:' + port;
  const server = spawn(process.execPath,['server.mjs'],{
    stdio:['ignore','pipe','pipe'],
    env:{
      ...process.env,
      NODE_ENV:'development', HOST:'127.0.0.1', PORT:String(port),
      DATA_DIR:dataDir, PUBLIC_URL:url,
      MAX_PHOTOS_PER_GUEST:'1', MAX_PHOTOS_PER_EVENT:'0', UPLOAD_REQUESTS_PER_HOUR:'0',
      MIN_FREE_DISK_MB:'100', MAX_ACTIVE_UPLOADS:'12',
      ADMIN_PASSWORD:'test-admin-pass-12345', SCREEN_PASSWORD:'test-screen-pass-12345',
      SESSION_SECRET:'abcdefghijklmnopqrstuvwxyz1234567890abcdef'
    }
  });
  let errorLog='';server.stderr.on('data',data=>errorLog+=String(data));
  const request=(urlPath,options={})=>fetch(url+urlPath,options);
  try{
    let ready=false;
    for(let i=0;i<80;i++){
      if(server.exitCode!==null)throw Error('Server exited: '+errorLog);
      try{if((await request('/healthz')).status===200){ready=true;break}}catch{}
      await new Promise(resolve=>setTimeout(resolve,120));
    }
    assert.equal(ready,true,'Server failed: '+errorLog);
    const guest=await request('/');
    const cookie=guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('bali_guest='));
    const publicConfig=await (await request('/api/public',{headers:{cookie}})).json();
    assert.equal(publicConfig.limit,null);
    const image=await sharp({create:{width:55,height:65,channels:3,background:'#45aa55'}}).png().toBuffer();
    for(let i=0;i<5;i++){
      const form=new FormData();
      form.append('photo',new Blob([image],{type:'image/png'}),'test.png');
      form.append('consent','yes');
      const response=await request('/api/upload',{method:'POST',headers:{cookie},body:form});
      assert.equal(response.status,201,'Unlimited upload #' +(i+1)+' failed: '+await response.text());
    }
    const login=await request('/api/admin/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:'test-admin-pass-12345'})
    });
    assert.equal(login.status,200);
    const adminCookie=login.headers.get('set-cookie').split(';')[0];
    const dashboard=await (await request('/api/admin/dashboard',{headers:{cookie:adminCookie}})).json();
    assert.equal(dashboard.total,5);
    assert.equal(dashboard.photos.length,5);
    assert.ok(dashboard.photos.every(photo=>photo.status==='pending'));
  }finally{
    if(server.exitCode===null){
      const exited=new Promise(resolve=>server.once('exit',resolve));
      server.kill('SIGTERM');await exited;
    }
    await rm(dataDir,{recursive:true,force:true});
  }
});
