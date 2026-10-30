import test from 'node:test';
import assert from 'node:assert/strict';
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
 for(const variant of ['puzzle','grid','live-mosaic','carousel-quad','carousel-double','carousel-triple','carousel-festival'])
  assert.equal(screenProfile({...sample,layout:variant}).layout,variant);
});
test('reject invalid or incomplete settings before they reach any screen',()=>{
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,maxPhotos:100000}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,layout:'evil'}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,showLogo:'yes'}));
 assert.throws(()=>screenProfile({...SCREEN_DEFAULTS,extra:'overwrite'}));
 assert.throws(()=>screenProfile({layout:'grid'}));
});
