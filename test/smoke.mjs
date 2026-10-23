import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const origin='http://127.0.0.1:39991';
const server=spawn(process.execPath,['server.mjs'],{
  cwd:process.cwd(),env:{...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:'39991',
    ADMIN_PASSWORD:'test-password-only-123456',SESSION_SECRET:'test-only-32-character-secret-do-not-use-prod'},
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
  let r=await call('/');
  assert.equal(r.status,200);
  const guest=r.headers.get('set-cookie')?.split(';')[0];
  assert(guest?.startsWith('bali_guest='));
  r=await call('/api/public',{headers:{Cookie:guest}});
  assert.equal(r.status,200);
  const ev=(await data(r)).event;
  assert(ev?.id,'Active event missing');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
  const body=new FormData();
  body.append('photo',new Blob([png],{type:'image/png'}),'test.png');
  body.append('consent','yes');
  r=await call('/api/upload',{method:'POST',headers:{Cookie:guest},body});
  assert.equal(r.status,201,'Upload failed: '+JSON.stringify(await data(r.clone())));
  const photo=await data(r);
  assert(photo.id);
  r=await call('/api/photos/'+photo.id);
  assert.equal(r.status,404,'Pending photo must be private');
  r=await call('/api/screen');
  assert.equal((await data(r)).photos.length,0);
  r=await call('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});
  assert.equal(r.status,401);
  r=await call('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-password-only-123456'})});
  assert.equal(r.status,200);
  const auth=r.headers.get('set-cookie')?.split(';')[0];
  assert(auth?.startsWith('bali_admin='));
  const authHeaders={Cookie:auth,'X-BALI-Action':'1','Content-Type':'application/json'};
  r=await call('/api/admin/dashboard',{headers:{Cookie:auth}});
  assert.equal(r.status,200);
  assert((await data(r)).photos.some(p=>p.id===photo.id));
  r=await call('/api/admin/photos/'+photo.id,{headers:{Cookie:auth}});
  assert.equal(r.status,200);
  r=await call('/api/admin/photos/'+photo.id+'/status',{method:'POST',headers:authHeaders,body:JSON.stringify({status:'approved'})});
  assert.equal(r.status,200);
  r=await call('/api/photos/'+photo.id);
  assert.equal(r.status,200,'Approved photo should be public');
  r=await call('/api/screen');
  assert((await data(r)).photos.some(p=>p.id===photo.id));
  r=await call('/api/admin/events',{method:'POST',headers:authHeaders,body:JSON.stringify({name:'Тестовая вечеринка'})});
  assert.equal(r.status,201);
  r=await call('/api/screen');
  const active=await data(r);
  assert.equal(active.event.name,'Тестовая вечеринка');
  assert.equal(active.photos.length,0,'New event must have its own slideshow');
  console.log('PASS: pages, guest upload, private pending media, admin login, moderation, public screen, event isolation');
}finally{
  server.kill('SIGTERM');
}
