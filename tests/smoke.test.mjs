import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

test('BALI PHOTO WALL: upload, moderation, screen and events', { timeout: 55000 }, async () => {
  const port = 13123;
  const url = 'http://127.0.0.1:' + port;
  const tempData = await mkdtemp(path.join(tmpdir(),'bali-photo-wall-smoke-'));
  const app = spawn(process.execPath, ['server.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DATA_DIR: tempData,
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
      PUBLIC_URL: url, ADMIN_PASSWORD: 'smoketest-only-secret-pass',
      SCREEN_PASSWORD: 'smoketest-screen-access',
      SESSION_SECRET: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH'
    }
  });
  let logs = '';
  app.stdout.on('data', x => logs += String(x));
  app.stderr.on('data', x => logs += String(x));
  const request = (path, opts) => fetch(url + path, opts);
  try {
    let ready = false;
    for (let i=0; i<75; i++) {
      if (app.exitCode !== null) throw Error('Server exited: ' + logs);
      try {
        const r = await request('/healthz');
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready,'Server did not start: ' + logs);
    const home = await request('/');
    assert.equal(home.status,200);
    const guest = home.headers.get('set-cookie').split(';')[0];
    const publicResult = await (await request('/api/public', {headers:{cookie:guest}})).json();
    assert.ok(publicResult.event?.id);

    const noLogin = await request('/api/admin/dashboard');
    assert.equal(noLogin.status,401);
    const login = await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'smoketest-only-secret-pass'})});
    assert.equal(login.status,200);
    const admin = login.headers.get('set-cookie').split(';')[0];
    const screenLogin = await request('/api/screen/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'smoketest-screen-access'})});
    assert.equal(screenLogin.status,200);
    const screenCookie = screenLogin.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie:admin, 'X-BALI-Action':'1', 'Content-Type':'application/json' };
    const img = await sharp({create:{width:96,height:96,channels:3,background:'#88ff33'}}).png().toBuffer();
    const form = new FormData();
    form.append('photo',new Blob([img],{type:'image/png'}),'smoke.png');
    form.append('consent','yes');
    const created = await request('/api/upload',{method:'POST',headers:{Cookie:guest},body:form});
    assert.equal(created.status,201,await created.text().catch(()=>'')); 
    // The response body is consumed above only when status mismatches.
    const { photos } = await (await request('/api/admin/dashboard',{headers:{Cookie:admin}})).json();
    const uploaded = photos.find(p=>p.status==='pending');
    assert.ok(uploaded);
    assert.equal((await request('/api/photos/'+uploaded.id,{headers:{Cookie:screenCookie}})).status,404);
    const approved = await request('/api/admin/photos/'+uploaded.id+'/status',{
      method:'POST',headers,body:JSON.stringify({status:'approved'})
    });
    assert.equal(approved.status,200);
    const served = await request('/api/photos/'+uploaded.id,{headers:{Cookie:screenCookie}});
    assert.equal(served.status,200);
    assert.match(served.headers.get('content-type'),/image\/webp/);
    assert.match(served.headers.get('cache-control'),/no-store/);
    const screen = await (await request('/api/screen',{headers:{Cookie:screenCookie}})).json();
    assert.ok(screen.photos.some(p=>p.id===uploaded.id));
    const newEvent = await request('/api/admin/events',{method:'POST',headers,body:JSON.stringify({name:'SMOKE TEST EVENT'})});
    assert.equal(newEvent.status,201);
    const next = await (await request('/api/public',{headers:{Cookie:guest}})).json();
    assert.equal(next.event.name,'SMOKE TEST EVENT');
    const empty = await (await request('/api/screen',{headers:{Cookie:screenCookie}})).json();
    assert.equal(empty.photos.length,0);
    const archive = await (await request('/api/admin/dashboard?eventId='+publicResult.event.id,
      {headers:{Cookie:admin}})).json();
    assert.equal(archive.selected.id,publicResult.event.id);
    assert.equal(archive.active.id,next.event.id);
    const absent = await request('/api/admin/dashboard?eventId=not-a-number',
      {headers:{Cookie:admin}});
    assert.equal(absent.status,404);
    const deleted = await request('/api/admin/photos/'+uploaded.id,{method:'DELETE',headers,body:'{}'});
    assert.equal(deleted.status,200);

    // A concurrent burst used to bypass the three-photo limit.
    const attempts = await Promise.all(Array.from({length:4},async () => {
      const batch = new FormData();
      batch.append('photo',new Blob([img],{type:'image/png'}),'parallel.png');
      batch.append('consent','yes');
      return request('/api/upload',{method:'POST',headers:{Cookie:guest},body:batch});
    }));
    assert.deepEqual(attempts.map(x=>x.status).sort((a,b)=>a-b),[201,201,201,429]);
    const afterBurst = await (await request('/api/admin/dashboard',{headers:{Cookie:admin}})).json();
    assert.equal(afterBurst.photos.length,3);
    const rejected = await request('/api/admin/photos/'+afterBurst.photos[0].id+'/status',{
      method:'POST',headers,body:JSON.stringify({status:'rejected'})
    });
    assert.equal(rejected.status,200);
    const hidden = await request('/api/photos/'+afterBurst.photos[0].id,{headers:{Cookie:screenCookie}});
    assert.equal(hidden.status,404);
    const screensAfterReject = await (await request('/api/screen',{headers:{Cookie:screenCookie}})).json();
    assert.ok(screensAfterReject.photos.every(x=>x.id!==afterBurst.photos[0].id));
  } finally {
    if (app.exitCode===null) {
      const exit = new Promise(resolve=>app.once('exit',resolve));
      app.kill('SIGTERM');
      await exit;
    }
    await rm(tempData,{recursive:true,force:true});
  }
});
