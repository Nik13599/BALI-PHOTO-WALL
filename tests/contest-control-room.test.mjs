import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const admin=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('Contest and photographs stay in independent PHOTO WALL SQLite and disk',()=>{
 assert.match(server,/CREATE TABLE IF NOT EXISTS contest_settings/);
 assert.match(server,/CREATE TABLE IF NOT EXISTS contest_candidates/);
 assert.match(server,/REFERENCES photos\(id\) ON DELETE CASCADE/);
 assert.match(server,/\/api\/contest\/status/);
 assert.match(server,/\/api\/contest\/photo\/\:id/);
 assert.doesNotMatch(server,/firebase|bali_coin_live_wallets|google_sub/);
});
test('Only authorized moderator can change competition state and nominations',()=>{
 assert.match(server,/app\.post\('\/api\/admin\/contest\/settings',adminAuth,requireAction/);
 assert.match(server,/app\.post\('\/api\/admin\/contest\/candidates',adminAuth,requireAction/);
 assert.match(server,/app\.get\('\/api\/admin\/contest\/export',adminAuth/);
 assert.match(server,/p\.status='approved'/);
 assert.match(server,/!input\.enabled\|\|!candidate\.n/);
});
test('Vote feed exposes only nominated and approved photos from active contest',()=>{
 assert.match(server,/photoUrl:base\+'\/api\/contest\/photo\/p_'/);
 assert.match(server,/contest_available:enabled/);
 assert.match(server,/voting_open:voting/);
 assert.match(server,/s\.enabled=1 AND s\.voting_open=1/);
 assert.doesNotMatch(server,/res\.json\(\{contest_available:enabled[^;]+guest_id/);
});
test('Moderator can bulk import, nominate, moderate and export photo roster',()=>{
 assert.match(admin,/bulkPhotoForm/);
 assert.match(admin,/contestSettings/);
 assert.match(admin,/contestCandidateForm/);
 assert.match(admin,/data-contest-photo/);
 assert.match(admin,/\/api\/admin\/contest\/export/);
});

test('Telegram royal contest uses the latest operator-enabled event, not general wall',()=>{
 assert.match(server,/const currentContestEvent=/);
 assert.match(server,/JOIN contest_settings s ON s.event_id=e.id WHERE s.enabled=1/);
 assert.match(server,/const event=currentContestEvent.get\(\),settings=event\?contestSettings/);
 assert.match(server,/liveContestEventId:liveEvent/);
 assert.match(admin,/ЭТОТ КОНКУРС ТРАНСЛИРУЕТСЯ В TELEGRAM/);
});
