import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../public/showcase-wall.js';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('general PHOTO WALL remains independent from contest broadcast authority',()=>{
 const server=read('server.mjs');
 assert.match(server,/const PHOTO_CONTEST_PAUSED=/);
 assert.match(server,/function ensureStandaloneGeneralEvent\(\)/);
 assert.match(server,/if\(PHOTO_CONTEST_PAUSED\)\{\s*activeBroadcast=null;\s*ensureStandaloneGeneralEvent\(\);/);
 assert.match(server,/app\.post\('\/api\/upload'[\s\S]{0,180}const event = ensureStandaloneGeneralEvent\(\)/);
 assert.match(server,/app\.get\('\/api\/screen'[\s\S]{0,160}const event = ensureStandaloneGeneralEvent\(\)/);
 assert.match(server,/app\.post\('\/api\/contest\/entry'[\s\S]{0,240}if\(PHOTO_CONTEST_PAUSED\)/);
 assert.match(server,/app\.get\('\/api\/contest\/status'[\s\S]{0,150}if\(PHOTO_CONTEST_PAUSED\)/);
 assert.match(server,/res\.redirect\(302,'\/admin\/general'\)/);
});
test('LED has six motion layouts with a 3s spotlight, normal collage and safe pause',()=>{
 const screen=read('public/screen.html'),app=read('public/app.js');
 const showcase=read('public/showcase-wall.js'),css=read('public/showcase-wall.css');
 assert.deepEqual(globalThis.BaliShowcaseWall.modes,['showcase-spotlight','showcase-film','showcase-cascade','showcase-orbit','showcase-wall','showcase-ribbon']);
 assert.match(screen,/id="showcaseSettings"/);
 assert.match(screen,/id="setShowcaseInterval"/);
 assert.match(app,/BaliShowcaseWall\.render/);
 assert.match(app,/settings=\{\.\.\.defaults,\.\.\.saved\.settings\}/);
 assert.match(showcase,/const next=clamp\(Number\(settings\.showcaseInterval\)\|\|3,2,12\)\*1000/);
 assert.match(showcase,/settings\.carouselPause/);
 assert.match(css,/@media \(prefers-reduced-motion:reduce\)/);
});
