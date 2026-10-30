import test from 'node:test';
import assert from 'node:assert/strict';
import {contestClock,isContestDate,eligiblePartyDay,validContestTimeline,contestMandatoryTimes,minskLocalMillis} from '../contest-clock.mjs';
const when=v=>Date.parse(v+'+03:00');
const settings={enabled:1,contest_date:'2026-10-31',voting_start:'03:00',voting_end:'06:00'};

test('legacy settings keep old 22:00 and 03:00 until changed manually',()=>{
 assert.equal(contestClock(settings,when('2026-10-30T21:59:59')).phase,'waiting');
 assert.equal(contestClock(settings,when('2026-10-30T22:00:00')).phase,'registration');
 assert.equal(contestClock(settings,when('2026-10-31T02:59:59')).phase,'registration');
 assert.equal(contestClock(settings,when('2026-10-31T03:00:00')).phase,'voting');
 assert.equal(contestClock(settings,when('2026-10-31T06:00:00')).phase,'closed');
 assert.equal(contestClock({...settings,voting_start:'01:00',voting_end:'03:00'},
   when('2026-10-31T02:00:00')).phase,'registration');
});

test('all FIVE manually configured timestamps govern contest stages',()=>{
 const adjusted={...settings,
  registration_opens_at:'2026-10-30T19:15',
  registration_ends_at:'2026-10-31T00:45',
  voting_starts_at:'2026-10-31T01:30',
  voting_ends_at:'2026-10-31T03:10',
  results_at:'2026-10-31T03:55'};
 assert.equal(validContestTimeline(adjusted),true);
 assert.equal(contestClock(adjusted,when('2026-10-30T19:14:59')).phase,'waiting');
 assert.equal(contestClock(adjusted,when('2026-10-30T19:15:00')).phase,'registration');
 assert.equal(contestClock(adjusted,when('2026-10-31T00:44:59')).phase,'registration');
 assert.equal(contestClock(adjusted,when('2026-10-31T00:45:00')).phase,'awaiting_voting');
 assert.equal(contestClock(adjusted,when('2026-10-31T01:30:00')).phase,'voting');
 assert.equal(contestClock(adjusted,when('2026-10-31T03:10:00')).phase,'awaiting_results');
 assert.equal(contestClock(adjusted,when('2026-10-31T03:55:00')).phase,'closed');
 assert.equal(contestClock(adjusted).registrationStartsAt,minskLocalMillis(adjusted.registration_opens_at));
 assert.equal(contestClock(adjusted).registrationEndsAt,minskLocalMillis(adjusted.registration_ends_at));
 assert.equal(contestClock(adjusted).votingStartsAt,minskLocalMillis(adjusted.voting_starts_at));
 assert.equal(contestClock(adjusted).votingEndsAt,minskLocalMillis(adjusted.voting_ends_at));
 assert.equal(contestClock(adjusted).resultsAt,minskLocalMillis(adjusted.results_at));
});

test('custom times on same calendar date and exact-minute boundaries work',()=>{
 const adjusted={...settings,
  registration_opens_at:'2026-10-31T11:01',
  registration_ends_at:'2026-10-31T14:03',
  voting_starts_at:'2026-10-31T14:03',
  voting_ends_at:'2026-10-31T20:37',
  results_at:'2026-10-31T22:00'};
 assert.equal(validContestTimeline(adjusted),true);
 assert.equal(contestClock(adjusted,when('2026-10-31T14:02:59')).phase,'registration');
 assert.equal(contestClock(adjusted,when('2026-10-31T14:03:00')).phase,'voting');
});

test('chronology and Minsk-local date errors are rejected',()=>{
 const good={...settings,
  registration_opens_at:'2026-10-30T21:00',
  registration_ends_at:'2026-10-31T02:00',
  voting_starts_at:'2026-10-31T02:00',
  voting_ends_at:'2026-10-31T04:45',
  results_at:'2026-10-31T05:05'};
 assert.equal(validContestTimeline(good),true);
 assert.equal(validContestTimeline({...good,registration_opens_at:'2026-10-31T02:00'}),false);
 assert.equal(validContestTimeline({...good,registration_ends_at:'2026-10-31T02:01'}),false);
 assert.equal(validContestTimeline({...good,voting_starts_at:'2026-10-31T05:00'}),false);
 assert.equal(validContestTimeline({...good,voting_ends_at:'2026-10-31T01:00'}),false);
 assert.equal(validContestTimeline({...good,results_at:'2026-10-31T04:44'}),false);
 assert.equal(validContestTimeline({...good,contest_date:'2026-11-01'}),false);
 assert.equal(validContestTimeline({...good,voting_starts_at:'2026-10-32T03:00'}),false);
});

test('Minsk date and associated BALI event ID validation',()=>{
 assert.equal(isContestDate('2026-02-30'),false);
 assert.equal(isContestDate('2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-30','2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-30__2','2026-10-31'),true);
 assert.equal(eligiblePartyDay('2026-10-29','2026-10-31'),false);
 assert.equal(contestClock({...settings,enabled:0},when('2026-10-31T04:00:00')).phase,'disabled');
 const legacy=contestMandatoryTimes('2026-10-31');
 assert.deepEqual(legacy,{opens:'2026-10-30T22:00',voteStart:'2026-10-31T03:00'});
});
