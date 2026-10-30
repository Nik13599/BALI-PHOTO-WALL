import test from 'node:test';
import assert from 'node:assert/strict';
import {contestClock,isContestDate,eligiblePartyDay,validContestTimeline,contestMandatoryTimes} from '../contest-clock.mjs';
const when=v=>Date.parse(v+'+03:00');
const settings={enabled:1,contest_date:'2026-10-31',voting_start:'03:00',voting_end:'06:00'};
test('registration starts Friday at 22:00 and voting Saturday at 03:00 Minsk',()=>{
 assert.equal(contestClock(settings,when('2026-10-30T21:59:59')).phase,'waiting');
 assert.equal(contestClock(settings,when('2026-10-30T22:00:00')).phase,'registration');
 assert.equal(contestClock(settings,when('2026-10-31T02:59:59')).phase,'registration');
 assert.equal(contestClock(settings,when('2026-10-31T03:00:00')).phase,'voting');
 assert.equal(contestClock(settings,when('2026-10-31T06:00:00')).phase,'closed');
});
test('outdated 01:00-03:00 settings cannot override opening time',()=>{
 const old={...settings,voting_start:'01:00',voting_end:'03:00'};
 assert.equal(contestClock(old,when('2026-10-31T01:00:00')).phase,'registration');
 assert.equal(contestClock(old,when('2026-10-31T03:00:00')).phase,'voting');
});
test('fixed start and admin-configurable vote end and result',()=>{
 const times=contestMandatoryTimes('2026-10-31');
 const advanced={...settings,registration_opens_at:times.opens,registration_ends_at:times.voteStart,
  voting_starts_at:times.voteStart,voting_ends_at:'2026-10-31T04:30',results_at:'2026-10-31T05:00'};
 assert.equal(validContestTimeline(advanced),true);
 assert.equal(contestClock(advanced,when('2026-10-31T04:29:59')).phase,'voting');
 assert.equal(contestClock(advanced,when('2026-10-31T04:30:00')).phase,'awaiting_results');
 assert.equal(contestClock(advanced,when('2026-10-31T05:00:00')).phase,'closed');
 assert.equal(validContestTimeline({...advanced,voting_starts_at:'2026-10-31T01:00'}),false);
 assert.equal(validContestTimeline({...advanced,registration_opens_at:'2026-10-30T21:00'}),false);
});
test('date and previous party validation',()=>{
 assert.equal(isContestDate('2026-02-30'),false);
 assert.equal(isContestDate('2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-30','2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-30__2','2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-29','2026-10-31'),false);
 assert.equal(contestClock({...settings,enabled:0},when('2026-10-31T04:00:00')).phase,'disabled');
});
