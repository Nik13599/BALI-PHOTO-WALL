import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/mosaic.js';

const {compute,aspect}=globalThis.BaliMosaic;
const photo=(id,ratio)=>({id,width:Math.round(1000*ratio),height:1000});

test('source orientation: square, portrait and landscape ratios',()=>{
  assert.equal(aspect(photo(1,1)),1);
  assert.equal(aspect(photo(2,.75)),.75);
  assert.equal(aspect(photo(3,1.5)),1.5);
});

test('puzzle packs 1-500 photos into full rectangular stage without empty rows',()=>{
  for(const count of [1,2,3,7,10,25,50,125,500]){
    const photos=Array.from({length:count},(_,i)=>photo(i+1,[.75,1,1.5,1.78][i%4]));
    const width=1920,height=1080,gap=2;
    const result=compute(photos,width,height,gap);
    const packed=result.rows.flatMap(r=>r.items.map(p=>p.id));
    assert.equal(packed.length,count);
    assert.equal(new Set(packed).size,count);
    assert.deepEqual(packed,photos.map(p=>p.id));
    const usedHeight=result.rows.reduce((sum,r)=>sum+r.height,0)+gap*(result.rows.length-1);
    assert.ok(Math.abs(usedHeight-height)<.001,'rows fill the intended centre stage');
    for(const row of result.rows){
      const widthSum=row.widths.reduce((sum,value)=>sum+value,0)+gap*(row.items.length-1);
      assert.ok(Math.abs(widthSum-width)<.001,'each row fills width without gaps');
      assert.ok(row.height>0&&row.widths.every(w=>w>0),'no zero-size photo tiles');
    }
  }
});

test('new photos change the mosaic while preserving old photo identities',()=>{
  const base=Array.from({length:10},(_,i)=>photo(i+1,[(3/4),1,4/3][i%3]));
  const before=compute(base,1600,900,3);
  const after=compute([photo(11,1.8),...base],1600,900,3);
  assert.equal(before.count,10);
  assert.equal(after.count,11);
  assert.equal(after.rows.flatMap(r=>r.items).filter(p=>p.id<=10).length,10);
});
