import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/carousel.js';

const C=globalThis.BaliCarousel;
const photo=(id,screen_lane='auto')=>({id,screen_lane,width:id%2?900:1600,height:1200});

test('all carousel variants are optional and original puzzle/grid unaffected',()=>{
  for(const key of ['carousel-quad','carousel-double','carousel-triple','carousel-festival'])
    assert.ok(C.isCarousel(key));
  assert.equal(C.isCarousel('puzzle'),false);
  assert.equal(C.isCarousel('grid'),false);
});
test('moderator upper/lower choices override deterministic automatic routing',()=>{
  assert.equal(C.assignedLane(photo(1,'top')),'top');
  assert.equal(C.assignedLane(photo(2,'bottom')),'bottom');
  assert.equal(C.assignedLane(photo(2,'auto')),'top');
  assert.equal(C.assignedLane(photo(1,'auto')),'bottom');
});
test('approved images enter central large band and graduate to matching outer queue',()=>{
  const items=Array.from({length:20},(_,id)=>photo(id+1,id%2?'top':'bottom'));
  const state=C.sync(null,items);
  assert.equal(C.allIds(state).length,20);
  assert.ok(state.top.featured.length>1);
  const moved=state.top.featured[0].id;
  C.advance(state,'top');
  assert.equal(state.top.archive[0].id,moved);
  assert.equal(state.bottom.archive.length,0);
  assert.equal(C.allIds(state).length,20);
  assert.equal(new Set(C.allIds(state)).size,20);
});
test('newly approved photos enter the central row without resetting finished photos',()=>{
  const items=Array.from({length:16},(_,i)=>photo(i+1,'top'));
  const old=C.sync(null,items);
  C.advance(old,'top');
  assert.ok(old.top.archive.length);
  const next=C.sync(old,[photo(30,'top'),...items]);
  assert.equal(next.top.featured[0].id,30);
  assert.equal(next.top.archive.length,1);
  assert.equal(new Set(C.allIds(next)).size,17);
});
test('moderator routing change moves photo from upper to lower without duplication',()=>{
  const old=C.sync(null,[photo(2,'top'),photo(3,'bottom')]);
  const next=C.sync(old,[photo(2,'bottom'),photo(3,'bottom')]);
  assert.equal(next.top.featured.length,0);
  assert.equal(C.allIds(next).length,2);
  assert.equal(next.bottom.featured.length,2);
});
test('hundreds of approved photos remain in memory only once across streams',()=>{
  const items=Array.from({length:500},(_,i)=>photo(i+1));
  let state=C.sync(null,items);
  for(let i=0;i<20;i++){
    C.advance(state,'top');C.advance(state,'bottom');
  }
  state=C.sync(state,items);
  assert.equal(C.allIds(state).length,500);
  assert.equal(new Set(C.allIds(state)).size,500);
});
