import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('PHOTO WALL moderator has only general photos, not a parallel contest dashboard',()=>{
 const ui=file('public/app.js');
 const admin=ui.slice(ui.indexOf("if(page==='admin')"),ui.indexOf("if(page==='screen')"));
 assert.match(admin,/const adminArea='general'/);
 assert.doesNotMatch(admin,/contestPanel|contest-moderation-banner|contestModeratorCounter|loadContest/);
 const server=file('server.mjs');
 const start=server.indexOf("app.get('/api/admin/dashboard'");
 const end=server.indexOf("const makeEvent",start);
 assert.ok(start>=0&&end>start);
 const dashboard=server.slice(start,end);
 assert.match(dashboard,/area!=='general'/);
 assert.match(dashboard,/WHERE id NOT IN \(SELECT event_id FROM contest_settings\)/);
 assert.match(dashboard,/p\.photo_area=\?/);
});
test('operator readiness contains aggregate metrics only',()=>{
 const source=file('server.mjs');
 const start=source.indexOf("app.get('/api/operator/ready'");
 const end=source.indexOf("app.get('/api/admin/broadcast-state'",start);
 assert.ok(start>=0&&end>start);
 const block=source.slice(start,end);
 assert.match(block,/await synchronizeBroadcast\(\)/);
 assert.match(block,/activeBroadcast\?\.contestEventId/);
 for(const term of ['pending','approved','rejected','registered'])assert.match(block,new RegExp(term));
 assert.doesNotMatch(block,/telegram_username|bali_uid|guest_id|filename/);
});
test('a transient Telegram timeout cannot reset an active Windows broadcast',()=>{
 const source=file('server.mjs');
 assert.match(source,/lastGoodAt:0/);
 assert.match(source,/now-telegramSchedule\.lastGoodAt>120000/);
 assert.match(source,/telegramSchedule\.expires=now\+5000/);
 assert.match(source,/telegramSchedule\.lastWarningAt/);
});
