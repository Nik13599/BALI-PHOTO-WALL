import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const server=read('server.mjs');
const admin=read('public/app.js');
const styles=read('public/areas.css');

test('historical contest records remain intact; the regular photo wall keeps working',()=>{
 assert.match(server,/CREATE TABLE IF NOT EXISTS contest_settings/);
 assert.match(server,/CREATE TABLE IF NOT EXISTS contest_candidates/);
 assert.match(server,/\/api\/contest\/status/);
 assert.match(server,/\/api\/screen/);
 assert.match(server,/app\.post\('\/api\/admin\/photos\/bulk'/);
});

test('PHOTO WALL admin has no contest panel, schedule, candidates or export',()=>{
 const adminArea=admin.slice(admin.indexOf("if(page==='admin')"),admin.indexOf("if(page==='screen')"));
 for(const marker of ['contestSettings','contestCandidateForm','contestPanel','contestCloudQueue','contestReplaceFile','data-contest-photo','contestModeratorCounter']){
  assert.equal(adminArea.includes(marker),false,'Unexpected contest UI: '+marker);
 }
 assert.doesNotMatch(styles,/data-admin-area="contest"|contest-settings|contestPanel/);
 assert.match(adminArea,/ОБЩАЯ ФОТОСТЕНА/);
});

test('no contest management API or contestant files are exposed through PHOTO WALL admin',()=>{
 assert.doesNotMatch(server,/app\.(get|post|delete)\('\/api\/admin\/contest/);
 assert.doesNotMatch(server,/app\.post\('\/api\/operator\/contest-moderation/);
 assert.doesNotMatch(server,/app\.post\('\/api\/admin\/photos\/:id\/replace/);
 assert.match(server,/app\.use\('\/api\/admin\/contest'/);
 assert.match(server,/if\(area!=='general'\)return res\.status\(410\)/);
 assert.match(server,/photo\.photo_area!=='general'/);
 assert.match(server,/WHERE id NOT IN \(SELECT event_id FROM contest_settings\)/);
});
