import assert from 'node:assert/strict';
import sharp from 'sharp';
import {SCREEN_DEFAULTS} from '../screen-profile.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const origin='http://127.0.0.1:39991';
const tempData=mkdtempSync(path.join(os.tmpdir(),'bali-photo-wall-verify-'));
const server=spawn(process.execPath,['server.mjs'],{
  cwd:process.cwd(),env:{...process.env,ALLOW_LEGACY_EVENT_CONTROL:'1',PHOTO_WALL_OFFLINE_LEGACY_FIXTURE:'1', NODE_ENV:'development',HOST:'127.0.0.1',PORT:'39991',DATA_DIR:tempData,
    ADMIN_PASSWORD:'test-password-only-123456',SCREEN_PASSWORD:'test-screen-only-123456',SESSION_SECRET:'test-only-32-character-secret-do-not-use-prod'},
  stdio:['ignore','pipe','pipe']
});
let output='';
server.stderr.on('data',b=>{output+=String(b);});
server.stdout.on('data',b=>{output+=String(b);});
async function call(url,options={}){return fetch(origin+url,options);}
async function data(response){return response.json();}
try {
  let ready=false;
  for(let i=0;i<80;i++){
    if(server.exitCode!==null)throw new Error('Server exited: '+output);
    try{const r=await call('/healthz');if(r.ok){ready=true;break;}}catch{}
    await delay(200);
  }
  assert(ready,'Server did not start: '+output);
  let r=await call('/',{redirect:'manual'});
  assert.equal(r.status,302,'Root path should redirect to stable guest upload URL');
  assert.equal(r.headers.get('location'),'/upload');
  r=await call('/upload');
  assert.equal(r.status,200,'Guests must have a dedicated permanent upload link');
  assert.match(r.headers.get('content-type')||'',/text\/html/,'Upload must serve guest HTML');
  assert.match(r.headers.get('cache-control')||'',/no-store/,'Guest page should not be cached after updates');
  const home=await r.clone().text();
  assert.match(home,/id="uploadForm"/,'Guest upload form must exist');
  assert.match(home,/id="photo"/,'Guest image input must exist');
  assert.match(home,/PHOTO WALL: lightweight, independent guest upload client/,'Guest page must contain the functional upload script');
  assert.match(home,/<style nonce="[^"]+">/,'Guest page must contain embedded working styles');
  assert.match(home,/<script nonce="[^"]+">/,'Guest page must contain embedded working JS');
  assert.match(home,/src="data:image\/svg\+xml;base64,/,'BALI logo must be embedded, not externally fetched');
  assert.doesNotMatch(home,/<link rel="stylesheet"/,'Guest CSS must not rely on a separate static request');
  assert.doesNotMatch(home,/<script defer src=/,'Guest JS must not rely on a separate static request');
  const guestNonce=home.match(/<style nonce="([^"]+)">/)?.[1];
  const guestCsp=r.headers.get('content-security-policy')||'';
  assert(guestCsp.includes("'nonce-"+guestNonce+"'"),'CSP must allow the inline styles and scripts');
  assert.match(await r.text(),/id="uploadForm"/,'Dedicated upload path must expose the same guest form');
  const guest=r.headers.get('set-cookie')?.split(';')[0];
  assert(guest?.startsWith('bali_guest='));
  r=await call('/api/public',{headers:{Cookie:guest}});
  assert.equal(r.status,200);
  const ev=(await data(r)).event;
  assert(ev?.id,'Active event missing');
  const png=await sharp({create:{width:3,height:3,channels:3,background:'#d7ff4d'}}).png().toBuffer();
  const body=new FormData();
  body.append('photo',new Blob([png],{type:'image/png'}),'test.png');
  body.append('consent','yes');
  r=await call('/api/upload',{method:'POST',headers:{Cookie:guest},body});
  assert.equal(r.status,201,'Upload failed: '+JSON.stringify(await data(r.clone())));
  const photo=await data(r);
  assert(photo.id);
  r=await call('/api/photos/'+photo.id);
  assert.equal(r.status,401,'Unauthenticated photo access must be blocked');
  r=await call('/api/screen');
  assert.equal(r.status,401,'Unauthenticated screen API must be blocked');
  r=await call('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});
  assert.equal(r.status,401);
  r=await call('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-password-only-123456'})});
  assert.equal(r.status,200);
  const auth=r.headers.get('set-cookie')?.split(';')[0];
  assert(auth?.startsWith('bali_admin='));
  const authHeaders={Cookie:auth,'X-BALI-Action':'1','Content-Type':'application/json'};
  r=await call('/api/screen/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-screen-only-123456'})});
  assert.equal(r.status,200);
  const screenCookie=r.headers.get('set-cookie')?.split(';')[0];
  assert(screenCookie?.startsWith('bali_screen='));
  for(const url of ['/admin/general','/admin/contest','/live/general','/live/contest']){
    r=await call(url);
    assert.equal(r.status,200,'Moderation/broadcast page should serve successfully: '+url);
    const html=await r.text();
    assert.match(html,/<style nonce="[^"]+">/,'Every control and live page must embed CSS: '+url);
    assert.match(html,/<script nonce="[^"]+">/,'Every control and live page must embed JS: '+url);
    assert.match(html,/src="data:image\/svg\+xml;base64,/,'Logo must appear without extra static requests: '+url);
    assert.doesNotMatch(html,/<link rel="stylesheet"/,'Static CSS must not be required: '+url);
    assert.doesNotMatch(html,/<script defer src=/,'Static JS must not be required: '+url);
    assert(html.indexOf('</body>')>html.lastIndexOf('<script nonce="'),
      'Page JS must load after the body exists: '+url);
    const nonce=html.match(/<style nonce="([^"]+)">/)?.[1];
    assert((r.headers.get('content-security-policy')||'').includes("'nonce-"+nonce+"'"),
      'CSP must allow inlined display assets: '+url);
    if(url.startsWith('/live/'))assert.match(html,/id="wallGrid"/,'Live mosaic must exist: '+url);
    if(url.startsWith('/admin/'))assert.match(html,/id="loginForm"/,'Moderator login must exist: '+url);
  }
  r=await call('/control/general',{redirect:'manual'});
  assert.equal(r.status,302,'Visual controller must require a staff session');
  r=await call('/control/general',{headers:{Cookie:auth}});
  assert.equal(r.status,200,'Signed-in administrator should access general visual controller');
  r=await call('/control/contest',{headers:{Cookie:auth}});
  assert.equal(r.status,200,'Signed-in administrator should access contest visual controller');
  r=await call('/api/screen/profile?feed=general',{headers:{Cookie:screenCookie}});
  assert.equal(r.status,200);
  assert.equal((await data(r)).settings.layout,'puzzle');
  const generalSettings={...SCREEN_DEFAULTS,layout:'carousel-double',logoPos:'tr',maxPhotos:33};
  r=await call('/api/admin/screen/profile?feed=general',{
    method:'POST',headers:authHeaders,body:JSON.stringify({settings:generalSettings})});
  assert.equal(r.status,200);
  r=await call('/api/admin/screen/profile?feed=contest',{
    method:'POST',headers:authHeaders,body:JSON.stringify({settings:SCREEN_DEFAULTS})});
  assert.equal(r.status,410,'Contest screen editing must be disabled');
  r=await call('/api/screen/profile?feed=general',{headers:{Cookie:screenCookie}});
  assert.equal(r.status,200);
  assert.equal((await data(r)).settings.layout,'carousel-double');
  r=await call('/api/admin/screen/profile?feed=general',{
    method:'POST',headers:{Cookie:screenCookie,'X-BALI-Action':'1','Content-Type':'application/json'},
    body:JSON.stringify({settings:SCREEN_DEFAULTS})});
  assert.equal(r.status,401,'An LED password must not grant visual controller write access');

  r=await call('/api/photos/'+photo.id,{headers:{Cookie:screenCookie}});
  assert.equal(r.status,404,'Pending photo must remain hidden from screen');
  r=await call('/api/admin/dashboard',{headers:{Cookie:auth}});
  assert.equal(r.status,200);
  assert((await data(r)).photos.some(p=>p.id===photo.id));
  r=await call('/api/admin/photos/'+photo.id,{headers:{Cookie:auth}});
  assert.equal(r.status,200);
  r=await call('/api/admin/photos/'+photo.id+'/status',{method:'POST',headers:authHeaders,body:JSON.stringify({status:'approved'})});
  assert.equal(r.status,200);
  r=await call('/api/photos/'+photo.id,{headers:{Cookie:screenCookie}});
  assert.equal(r.status,200,'Approved photo should be visible to authenticated screen');
  r=await call('/api/admin/dashboard?status=pending',{headers:{Cookie:auth}});
  assert.equal(r.status,200);
  let queue=await data(r);
  assert.equal(queue.counts.pending,0,'Approved photo must leave pending queue');
  assert.equal(queue.counts.approved,1,'Approved photo must appear in screen gallery counter');
  assert.equal(queue.photos.length,0,'Pending tab must no longer show approved photo');
  r=await call('/api/admin/dashboard?status=approved',{headers:{Cookie:auth}});
  assert.equal(r.status,200);
  queue=await data(r);
  assert(queue.photos.some(p=>p.id===photo.id),'Approved photo must be shown only in published photos tab');
  r=await call('/api/admin/dashboard?status=unknown',{headers:{Cookie:auth}});
  assert.equal(r.status,400,'Unrecognized moderation queues must be rejected');
  // Contest management has been removed from the administrator interface.
  r=await call('/api/admin/contest/settings',{method:'POST',headers:authHeaders,body:'{}'});
  assert.equal(r.status,410);
  r=await call('/api/admin/contest?eventId='+ev.id,{headers:{Cookie:auth}});
  assert.equal(r.status,410);
  r=await call('/api/admin/dashboard?area=contest',{headers:{Cookie:auth}});
  assert.equal(r.status,410);
  const contestForm=new FormData();
  contestForm.append('eventId',String(ev.id));
  contestForm.append('area','contest');
  contestForm.append('status','pending');
  contestForm.append('lane','auto');
  contestForm.append('photos',new Blob([png],{type:'image/png'}),'contest-test.png');
  r=await call('/api/admin/photos/bulk',{method:'POST',headers:{Cookie:auth,'X-BALI-Action':'1'},body:contestForm});
  assert.equal(r.status,410,'Contest imports must be rejected');

  r=await call('/api/screen',{headers:{Cookie:screenCookie}});
  assert((await data(r)).photos.some(p=>p.id===photo.id));
  r=await call('/api/admin/events',{method:'POST',headers:authHeaders,body:JSON.stringify({name:'Тестовая вечеринка'})});
  assert.equal(r.status,201);
  r=await call('/api/screen',{headers:{Cookie:screenCookie}});
  const active=await data(r);
  assert.equal(active.event.name,'Тестовая вечеринка');
  assert.equal(active.photos.length,0,'New event must have its own slideshow');
  console.log('PASS: general photo-wall moderation, guest upload, contestant admin access denied, server-saved profiles, permissions, events');
}finally{
  if (server.exitCode===null) {
    const exited=new Promise(resolve=>server.once('exit',resolve));
    server.kill('SIGTERM');
    await exited;
  }
  rmSync(tempData,{recursive:true,force:true});
}
