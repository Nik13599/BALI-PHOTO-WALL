import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const screen=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');

test('Telegram nomination reaches the LED podium and does not require a new admin',()=>{
 assert.match(server,/contestTitle:String\(contestTitle\)\.slice\(0,90\)/);
 assert.match(screen,/contestData\?\.contestTitle/);
 assert.match(screen,/\.royal-podium-heading/);
});
test('winner images carry visible gold, silver and bronze vector crowns',()=>{
 assert.match(screen,/className='royal-place-crown'/);
 assert.match(screen,/viewBox="0 0 120 92"/);
 assert.doesNotMatch(screen,/crown\.textContent='♛'/);
 assert.match(css,/\.royal-place\[data-place="1"\]\{color:#ffd454\}/);
 assert.match(css,/\.royal-place\[data-place="2"\]\{color:#d4e4ee\}/);
 assert.match(css,/\.royal-place\[data-place="3"\]\{color:#d29a64\}/);
 assert.match(css,/margin-bottom:clamp\(-46px,-3vw,-15px\)/);
});
test('only Telegram registration phase permits contest photo edits, and archives remain protected',()=>{
 assert.match(server,/async function contestPhotoMutationLocked\(photo\)/);
 assert.match(server,/control\?\.contestPhase==='registration'/);
 assert.match(server,/if\(await contestPhotoMutationLocked\(photo\)\)return res\.status\(409\)/);
 assert.match(server,/if\(await contestPhotoMutationLocked\(item\)\)return res\.status\(409\)/);
});
