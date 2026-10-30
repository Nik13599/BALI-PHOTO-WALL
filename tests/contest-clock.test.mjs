import test from 'node:test';
import assert from 'node:assert/strict';
import {contestClock,isContestDate,eligiblePartyDay} from '../contest-clock.mjs';

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
