import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SCREEN_DEFAULTS,screenArea,screenProfile} from '../screen-profile.mjs';

test('only the two independent broadcast profiles exist',()=>{
 assert.equal(screenArea('general'),'general');
 assert.equal(screenArea('contest'),'contest');
 assert.equal(screenArea('unknown'),null);
});
test('a saved profile round-trips every layout control',()=>{
 const sample={...SCREEN_DEFAULTS,layout:'live-mosaic',liveInterval:4,maxPhotos:150,
   logoPos:'tr',qrPos:'bl',logoX:20,showQr:false,carouselSpeed:140};
 assert.deepEqual(screenProfile(sample),sample);
 for(const variant of ['puzzle','grid','live-mosaic','carousel-quad','carousel-double','carousel-triple','carousel-festival','showcase-spotlight','showcase-film','showcase-cascade'])
  assert.equal(screenProfile({...sample,layout:variant}).layout,variant);
});
test('reject invalid or incomplete settings before they reach any screen',()=>{
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,maxPhotos:100000}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,layout:'evil'}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,showLogo:'yes'}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,extra:'overwrite'}));
 assert.throws(()=>screenProfile({layout:'grid'}));
});

test('three cinematic mass-photo modes default to a three-second feature turn',()=>{
 assert.equal(SCREEN_DEFAULTS.showcaseInterval,3);
 for(const mode of ['showcase-spotlight','showcase-film','showcase-cascade']){
  const saved=screenProfile({...SCREEN_DEFAULTS,layout:mode,showcaseInterval:3});
  assert.equal(saved.layout,mode);
  assert.equal(saved.showcaseInterval,3);
 }
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,showcaseInterval:0}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,showcaseInterval:60}));
 const legacy={...SCREEN_DEFAULTS};delete legacy.showcaseInterval;
 assert.equal(screenProfile(legacy).showcaseInterval,3,'existing club profiles stay compatible');
});

test('ordinary LED overlays save QR size/position and all independent visibility flags',()=>{
 const active={...SCREEN_DEFAULTS,layout:'showcase-wall',qrSize:480,qrPos:'br',
  qrX:-40,qrY:25,showQr:true,showLive:false,showLogo:false,
  showEvent:true,showHint:false};
 assert.deepEqual(screenProfile(active),active);
 assert.equal(screenProfile({...active,showQr:false}).showQr,false);
 assert.equal(screenProfile({...active,showLogo:true}).showLogo,true);
 assert.throws(()=>screenProfile({...active,qrSize:481}),/Invalid screen setting: qrSize/);
 assert.throws(()=>screenProfile({...active,qrSize:39}),/Invalid screen setting: qrSize/);
});

test('ordinary QR and overlay visibility are shared by operator preview and LED broadcast',()=>{
 const get=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
 const css=get('public/style.css');
 const broadcast=get('public/screen-broadcast.css');
 const app=get('public/app.js');
 const html=get('public/screen.html');
 const server=get('server.mjs');
 assert.ok(css.includes('.screen{position:relative;'));
 assert.ok(broadcast.includes('body[data-page="screen"] .wall-qr{max-width:min(46%,'));
 assert.ok(app.includes("setShown($('#wallQR'),broadcastArea==='general'&&settings.showQr)"));
 for(const [id,setting] of [
  ['wallLogo','showLogo'],['wallLive','showLive'],
  ['screenEvent','showEvent'],['eventHint','showHint']
 ])assert.ok(app.includes("setShown($('#"+id+"'),settings."+setting+")"),id+' must follow control');
 assert.ok(app.includes('qrSize:[40,480]'));
 assert.match(html,/id="setQrSize"[^>]*max="480"/);
 assert.match(html,/id="setShowQr"[^>]*checked/);
 assert.ok(server.includes("QRCode.toString(PUBLIC_URL.replace(/\\/$/,'')+'/upload'"));
 assert.ok(html.includes('id="wallQRImage"'));
});

test('LED broadcast uses the exact operator profile for all five overlays',()=>{
 const get=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
 const css=get('public/screen-broadcast.css');
 const style=get('public/style.css');
 const app=get('public/app.js');
 const html=get('public/screen.html');
 // Regression: older CSS forced display:none!important for QR, live, event,
 // hint and forced the club logo to a fixed bottom-left 32px irrespective of
 // the operator panel. It must not override [hidden]/positionFloating().
 for(const id of ['wallQR','wallLogo','wallLive','screenEvent','eventHint']){
  assert.doesNotMatch(css,new RegExp('body\\[data-screen-mode="broadcast"\\] #'+id+'[^{}]*\\{[^{}]*display\\s*:\\s*none\\s*!important','s'),id+' must not be force-hidden');
  assert.doesNotMatch(css,new RegExp('body\\[data-screen-mode="broadcast"\\] #'+id+'\\s*\\{[^}]*!important','s'),id+' must not be force-positioned');
 }
 assert.match(style,/\\.screen \\[hidden\\]\\{display:none!important\\}/,'Operator show/hide must be respected');
 assert.match(html,/id="wallQR"/);
 assert.match(html,/id="wallQRImage"/);
 assert.match(html,/id="setShowQr"[^>]*checked/);
 for(const [id,flag] of [
  ['wallQR','broadcastArea===\'general\'&&settings.showQr'],
  ['wallLogo','settings.showLogo'],
  ['wallLive','settings.showLive'],
  ['screenEvent','settings.showEvent'],
  ['eventHint','settings.showHint']
 ])assert.ok(app.includes("setShown($('#"+id+"'),"+flag+")"),id+' must obey saved profile');
 assert.ok(app.includes('positionFloating();syncShiftControls();'));
});
