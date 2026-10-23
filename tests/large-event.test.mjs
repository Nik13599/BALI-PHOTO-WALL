import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import sharp from 'sharp';

test('300 approved photos are visible on screen and paginated for moderator', {timeout:55000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bali-large-event-'));
  const port=13235,origin='http://127.0.0.1:'+port;
  const server=spawn(process.execPath,['server.mjs'],{
    stdio:['ignore','pipe','pipe'],
    env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',
      NODE_ENV:'production',PUBLIC_URL:'https://baliminsk.online',MAX_PHOTOS_PER_EVENT:'300',
      ADMIN_PASSWORD:'test-admin-password-12345',
      SCREEN_PASSWORD:'test-screen-password-12345',
      SESSION_SECRET:'1234567890123456789012345678901234567890'}
  });
  let log='';server.stderr.on('data',x=>log+=x);server.stdout.on('data',x=>log+=x);
  const req=(route,options={})=>fetch(origin+route,options);
  let db=null;
  try {
    let ready=false;
    for(let i=0;i<75;i++){
      if(server.exitCode!==null) throw new Error('Server exited: '+log);
      try{const r=await req('/healthz');if(r.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.ok(ready,'Server not ready: '+log);
    const adminLogin=await req('/api/admin/login',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({password:'test-admin-password-12345'})
    });
    assert.equal(adminLogin.status,200);
    assert.doesNotMatch(adminLogin.headers.get('set-cookie'),/;\s*Secure/i,
      'localhost-only HTTP operator access should not set Secure cookie');
    const admin=adminLogin.headers.get('set-cookie').split(';')[0];
    const publicLogin=await req('/api/admin/login',{
      method:'POST',
      headers:{'content-type':'application/json','Host':'baliminsk.online','X-Forwarded-Host':'localhost'},
      body:JSON.stringify({password:'test-admin-password-12345'})
    });
    assert.equal(publicLogin.status,200);
    assert.match(publicLogin.headers.get('set-cookie'),/;\s*Secure/i,
      'public domain must always use Secure cookie despite forwarded-host spoofing');
    const screenLogin=await req('/api/screen/login',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({password:'test-screen-password-12345'})
    });
    assert.equal(screenLogin.status,200);
    const screen=screenLogin.headers.get('set-cookie').split(';')[0];
    // Copying a signed LED token into the admin cookie must not grant access.
    const forgedAdmin=screen.replace(/^bali_screen=/,'bali_admin=');
    assert.equal((await req('/api/admin/me',{headers:{cookie:forgedAdmin}})).status,401,
      'LED credentials must not grant admin privileges');
    assert.equal((await req('/api/admin/dashboard',{headers:{cookie:forgedAdmin}})).status,401);
    const forgedScreen=admin.replace(/^bali_admin=/,'bali_screen=');
    assert.equal((await req('/api/screen',{headers:{cookie:forgedScreen}})).status,401,
      'Admin token may authenticate as admin, but not when relabelled as a screen token');
    assert.equal((await req('/api/screen',{headers:{cookie:admin}})).status,200,
      'Valid admin credentials must retain authorised screen access');
    db=new Database(path.join(dir,'bali-photo-wall.sqlite'));
    const event=db.prepare('SELECT id FROM events WHERE active=1').get().id;
    const add=db.prepare("INSERT INTO photos(event_id,filename,guest_id,status,created_at) VALUES (?,?,?,'approved',?)");
    const baseline=Date.now();
    const photoIds=[];
    const insert=db.transaction(()=>{
      for(let i=0;i<300;i++){
        photoIds.push(add.run(event,'bulk-'+i+'.webp','guest-'+i,baseline+i).lastInsertRowid);
      }
    });
    insert();
    const guestPage=await req('/');
    const guestCookie=guestPage.headers.get('set-cookie')?.split(';')[0];
    assert.ok(guestCookie?.startsWith('bali_guest='));
    const fullEventPhoto=await sharp({create:{width:60,height:70,channels:3,background:'#89efcc'}}).png().toBuffer();
    const blockedUpload=new FormData();
    blockedUpload.append('photo',new Blob([fullEventPhoto],{type:'image/png'}),'full-event.png');
    blockedUpload.append('consent','yes');
    const refused=await req('/api/upload',{method:'POST',headers:{cookie:guestCookie},body:blockedUpload});
    assert.equal(refused.status,409,'Event limit must reject uploads beyond configured maximum');
    const picture=await sharp({create:{width:80,height:120,channels:3,background:'#abcdef'}}).webp().toBuffer();
    await writeFile(path.join(dir,'photos','bulk-0.webp'),picture);
    await writeFile(path.join(dir,'thumbnails','bulk-0.webp'),picture);
    let r=await req('/api/screen',{headers:{cookie:screen}});
    assert.equal(r.status,200);
    let result=await r.json();
    assert.equal(result.photos.length,300,'LED screen must not truncate older photos');
    assert.equal(new Set(result.photos.map(x=>x.id)).size,300);
    r=await req('/api/admin/dashboard',{headers:{cookie:admin}});
    assert.equal(r.status,200);
    result=await r.json();
    assert.equal(result.total,300);
    assert.equal(result.page,1);
    assert.equal(result.pages,7);
    assert.equal(result.photos.length,48);
    r=await req('/api/admin/dashboard?page=7',{headers:{cookie:admin}});
    result=await r.json();
    assert.equal(result.photos.length,12);
    assert.equal(result.page,7);
    assert.equal(result.total,300);
    r=await req('/api/admin/dashboard?page=999',{headers:{cookie:admin}});
    result=await r.json();assert.equal(result.page,7);
    assert.equal((await req('/api/admin/dashboard?page=0',{headers:{cookie:admin}})).status,400);
    assert.equal((await req('/api/admin/dashboard')).status,401);
    assert.equal((await req('/api/photos/'+photoIds[0])).status,401);
    const thumb=await req('/api/admin/photos/'+photoIds[0],{headers:{cookie:admin}});
    const full=await req('/api/admin/photos/'+photoIds[0]+'?full=1',{headers:{cookie:admin}});
    assert.equal(thumb.status,200);assert.equal(full.status,200);
    assert.match(full.headers.get('cache-control'),/no-store/);
    // Photos rejected by the moderator must never appear in the new screen listing.
    const removed=await req('/api/admin/photos/'+photoIds[0]+'/status',{
      method:'POST',
      headers:{cookie:admin,'X-BALI-Action':'1','content-type':'application/json'},
      body:JSON.stringify({status:'rejected'})
    });
    assert.equal(removed.status,200);
    result=await (await req('/api/screen',{headers:{cookie:screen}})).json();
    assert.equal(result.photos.length,299);
    assert.ok(!result.photos.some(x=>x.id===photoIds[0]));
  }finally{
    db?.close();
    if(server.exitCode===null){
      const done=new Promise(resolve=>server.once('exit',resolve));
      server.kill('SIGTERM');await done;
    }
    await rm(dir,{recursive:true,force:true});
  }
});
