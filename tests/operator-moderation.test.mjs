import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('contest moderator sees only current Telegram run and does not edit second visible scheduler',()=>{
 const js=file('public/app.js');
 assert.match(js,/id="contestPanel"><summary>⚙ Технические настройки/);
 assert.match(js,/contest-moderation-banner/);
 assert.match(js,/id="contestModeratorCounter"/);
 assert.doesNotMatch(js,/adminArea==='contest'\?'open':''/);
 const source=file('server.mjs');
 const start=source.indexOf("app.get('/api/admin/dashboard'");
 const end=source.indexOf("const makeEvent",start);
 assert.ok(start>=0&&end>start);
 const dashboard=source.slice(start,end);
 assert.match(dashboard,/await synchronizeBroadcast\(\)/);
 assert.match(dashboard,/activeBroadcast\.contestEventId/);
 assert.match(dashboard,/p\.photo_area=\?/);
});
test('operator readiness responds only with aggregate numbers for the active contest',()=>{
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
