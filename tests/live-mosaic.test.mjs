import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/live-mosaic.js';

const engine=globalThis.BaliLiveMosaic;
const images=n=>Array.from({length:n},(_,i)=>({
  id:i+1,width:[1000,750,1600,500][i%4],height:1000
}));

function checkGeometry(layout,width,height,gap){
  assert.ok(layout.tiles.length>0);
  for(const tile of layout.tiles){
    assert.ok(tile.width>0&&tile.height>0,'photos must be visible');
    assert.ok(tile.x>=-1e-6&&tile.y>=-1e-6,'no negative coordinates');
    assert.ok(tile.x+tile.width<=width+1e-6,'tile must fit horizontally');
    assert.ok(tile.y+tile.height<=height+1e-6,'tile must fit vertically');
  }
  // For a single approved photo the stage deliberately leaves breathing room.
  const total=layout.tiles.reduce((acc,t)=>acc+t.width*t.height,0);
  if(layout.tiles.length>1)
    assert.ok(total>width*height*(1-.25),'multi-photo mosaic must cover most of LED');
  for(let i=0;i<layout.tiles.length;i++){
    const a=layout.tiles[i];
    for(let j=i+1;j<layout.tiles.length;j++){
      const b=layout.tiles[j];
      const w=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x);
      const h=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
      assert.ok(w<=1e-5 || h<=1e-5,'photo rectangles must never overlap');
    }
  }
}

test('live mosaic contains all approved photo IDs, with no duplicates, on full HD screens',()=>{
  for(const count of [1,2,3,4,5,6,10,20,50,100,200,500]){
    const photos=images(count);
    const mosaic=engine.compute(photos,1920,1080,{focusId:photos[0].id,gap:2,focusSize:40,seed:count*41});
    assert.equal(mosaic.tiles.length,count);
    assert.equal(new Set(mosaic.tiles.map(t=>t.id)).size,count);
    assert.deepEqual(mosaic.tiles.map(t=>t.id).sort((a,b)=>a-b),photos.map(t=>t.id));
    checkGeometry(mosaic,1920,1080,2);
  }
});

test('full-screen spotlight remains prominent even when the wall has 500 photos',()=>{
  for(const count of [5,10,50,500]){
    const mosaic=engine.compute(images(count),1920,1080,{focusId:2,focusSize:50,gap:2,seed:751});
    assert.equal(mosaic.focusId,2);
    const focus=mosaic.tiles.find(t=>t.id===2);
    assert.ok(focus.width*focus.height>1920*1080*.2,'featured photo must be significantly enlarged');
  }
});

test('new random seeds and spotlight positions yield visibly different mosaic layouts',()=>{
  const arr=images(18);
  const list=[1,21,333,4055].map(seed=>engine.compute(arr,1920,1080,{seed,focusId:3,focusSize:43,gap:2}));
  const geometry=l=>JSON.stringify(l.tiles.map(t=>[t.id,Math.round(t.x),Math.round(t.y),Math.round(t.width)]));
  assert.equal(new Set(list.map(geometry)).size,list.length);
  const changed=engine.compute(arr,1920,1080,{seed:21,focusId:4,focusSize:43,gap:2});
  assert.notDeepEqual(geometry(changed),geometry(list[1]));
});

test('each approved photo gets exactly one turn as focus before re-shuffling',()=>{
  const order=engine.focusOrder(images(67),20261024);
  assert.equal(order.length,67);
  assert.equal(new Set(order).size,67);
  assert.ok(order.every(id=>id>=1&&id<=67));
  assert.notDeepEqual(order,engine.focusOrder(images(67),20261025));
});

test('spotlight scale and layouts remain valid on vertical displays',()=>{
  for(const [w,h] of [[1080,1920],[720,1280],[3840,1080],[1280,720]]){
    for(const focusSize of [25,40,65]){
      const result=engine.compute(images(20),w,h,{seed:focusSize,focusId:12,focusSize,gap:4});
      assert.equal(result.tiles.length,20);
      checkGeometry(result,w,h,4);
    }
  }
});

test('no photo is reused or drawn when source is empty',()=>{
  assert.deepEqual(engine.compute([],1920,1080),{tiles:[],focusId:null});
});

test('a single approved photo remains centered, uncropped and modest on LED displays',()=>{
 const cases=[
  {w:1920,h:1080,pw:1000,ph:1000},
  {w:1920,h:1080,pw:750,ph:1000},
  {w:1920,h:1080,pw:1600,ph:900},
  {w:1080,h:1920,pw:750,ph:1000}
 ];
 for(const {w,h,pw,ph} of cases){
  const photo={id:17,width:pw,height:ph};
  const layout=engine.compute([photo],w,h,{focusId:17,focusSize:65,gap:2,seed:3});
  assert.equal(layout.tiles.length,1);
  const t=layout.tiles[0];
  assert.ok(t.width<=w*.65+.001,'no single image should occupy the entire width');
  assert.ok(t.height<=h*.7+.001,'no single image should occupy the entire height');
  assert.ok(Math.abs((t.x+t.width/2)-w/2)<.001);
  assert.ok(Math.abs((t.y+t.height/2)-h/2)<.001);
  assert.ok(Math.abs(t.width/t.height-pw/ph)<.000001,'keep aspect ratio');
 }
});
