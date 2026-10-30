import test from 'node:test';
import assert from 'node:assert/strict';
import {contestClock,isContestDate,eligiblePartyDay,validContestTimeline} from '../contest-clock.mjs';

const settings={enabled:1,contest_date:'2026-10-31',voting_start:'01:00',voting_end:'03:00'};
const when=iso=>Date.parse(iso+'+03:00');

test('registration ends at exactly 01:00 Minsk, not UTC/browser time',()=>{
 assert.equal(contestClock(settings,when('2026-10-31T00:59:59')).phase,'registration');
 assert.equal(contestClock(settings,when('2026-10-31T01:00:00')).phase,'voting');
});

test('vote deadline 03:00 is exclusive',()=>{
 assert.equal(contestClock(settings,when('2026-10-31T02:59:59')).phase,'voting');
 assert.equal(contestClock(settings,when('2026-10-31T03:00:00')).phase,'closed');
});

test('no contest on invalid date or when administrator disables it',()=>{
 assert.equal(contestClock({...settings,enabled:0},when('2026-10-31T01:30:00')).phase,'disabled');
 assert.equal(isContestDate('2026-02-30'),false);
 assert.equal(isContestDate('2026-10-31'),true);
});

test('party from night before stays eligible after midnight',()=>{
 assert.equal(eligiblePartyDay('2026-10-30','2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-30__2','2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-29','2026-10-31'),false);
});

const dateTime = (day,time)=>Date.parse(day+'T'+time+':00+03:00');
const schedule={...settings,registration_opens_at:'2026-10-30T22:00',registration_ends_at:'2026-10-31T00:50',voting_starts_at:'2026-10-31T01:00',voting_ends_at:'2026-10-31T03:00',results_at:'2026-10-31T03:15'};
test('moderator can set each contest stage independently, including a waiting gap',()=>{
 assert.equal(validContestTimeline(schedule),true);
 assert.equal(contestClock(schedule,dateTime('2026-10-30','21:59')).phase,'waiting');
 assert.equal(contestClock(schedule,dateTime('2026-10-30','22:00')).phase,'registration');
 assert.equal(contestClock(schedule,dateTime('2026-10-31','00:49')).phase,'registration');
 assert.equal(contestClock(schedule,dateTime('2026-10-31','00:50')).phase,'waiting');
 assert.equal(contestClock(schedule,dateTime('2026-10-31','01:00')).phase,'voting');
 assert.equal(contestClock(schedule,dateTime('2026-10-31','03:00')).phase,'awaiting_results');
 assert.equal(contestClock(schedule,dateTime('2026-10-31','03:15')).phase,'closed');
});
test('rejects overlapping/out-of-order times and wrong vote date',()=>{
 assert.equal(validContestTimeline({...schedule,results_at:'2026-10-31T02:30'}),false);
 assert.equal(validContestTimeline({...schedule,voting_starts_at:'2026-10-30T23:59'}),false);
 assert.equal(validContestTimeline({...schedule,registration_ends_at:'2026-10-31T01:30'}),false);
});
test('supports moderator-scheduled voting across local midnight',()=>{
 const overnight={...schedule,registration_opens_at:'2026-10-30T12:00',registration_ends_at:'2026-10-31T21:00',
 voting_starts_at:'2026-10-31T22:00',voting_ends_at:'2026-11-01T01:00',results_at:'2026-11-01T01:10'};
 assert.equal(validContestTimeline(overnight),true);
 assert.equal(contestClock(overnight,dateTime('2026-11-01','00:59')).phase,'voting');
 assert.equal(contestClock(overnight,dateTime('2026-11-01','01:00')).phase,'awaiting_results');
 assert.equal(contestClock(overnight,dateTime('2026-11-01','01:10')).phase,'closed');
});
