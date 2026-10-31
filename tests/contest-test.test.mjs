import test from 'node:test';
import assert from 'node:assert/strict';
import {testContestSession,chooseContestEvent} from '../contest-test.mjs';
const id='test_01234567-89ab-cdef-0123-456789abcdef';
const policy={test:{enabled:true},current:{session:{testSessionId:id,date:'2026-11-03',eventId:'2026-11-03__3'}}};
const data={1:{bali_event_id:'2026-10-31',test_session_id:''},2:{bali_event_id:'2026-11-03__3',test_session_id:id},3:{test_session_id:'test_old'}};
test('A rehearsal selects only its exact event even if another test or live event is newer',()=>{
 assert.equal(testContestSession(policy).testSessionId,id);
 assert.equal(chooseContestEvent([{id:3},{id:1},{id:2}],policy,id=>data[id]).id,2);
 assert.equal(chooseContestEvent([{id:1}],policy,id=>data[id]),null);
});
test('Stopping test restores the named ordinary contest and never falls back to a test event',()=>{
 const normal={test:{enabled:false},session:{eventId:'2026-10-31'}};
 assert.equal(chooseContestEvent([{id:3},{id:2},{id:1}],normal,id=>data[id]).id,1);
 assert.equal(chooseContestEvent([{id:3},{id:2}],normal,id=>data[id]),null);
});
test('An invalid test event identifier cannot select rehearsal photos',()=>{
 assert.equal(testContestSession({...policy,current:{session:{...policy.current.session,eventId:'2026-11-03'}}}),null);
});
