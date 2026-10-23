/* Aspect-preserving justified mosaic: no photo is stretched or cropped. */
(function(root){
'use strict';
function aspect(photo){
  const width=Number(photo?.width),height=Number(photo?.height);
  return width>0&&height>0 ? Math.max(.28,Math.min(4,width/height)) : 1;
}
function partition(items,rowCount){
  const ratio=items.map(aspect);
  let left=ratio.reduce((s,n)=>s+n,0);
  let start=0;
  const result=[];
  for(let i=0;i<rowCount;i++){
    const rowsLeft=rowCount-i;
    const last=items.length-(rowsLeft-1);
    let end=start+1,sum=ratio[start];
    const desired=left/rowsLeft;
    while(end<last){
      const next=sum+ratio[end];
      if(Math.abs(next-desired)>Math.abs(sum-desired))break;
      sum=next;end++;
    }
    result.push({start,end,ratioSum:sum});
    start=end;left-=sum;
  }
  return result;
}
function geometry(items,width,height,gap,groups){
  const natural=groups.map(group=>{
    const count=group.end-group.start;
    return (width-gap*(count-1))/group.ratioSum;
  });
  const naturalTotal=natural.reduce((a,b)=>a+b,0)+gap*(groups.length-1);
  const factor=Math.min(1,Math.max(.001,(height-gap*(groups.length-1))/
    Math.max(.001,naturalTotal-gap*(groups.length-1))));
  const rows=groups.map((group,i)=>{
    const h=natural[i]*factor;
    const photos=items.slice(group.start,group.end);
    return {items:photos,height:h,widths:photos.map(item=>h*aspect(item))};
  });
  const usedHeight=rows.reduce((a,r)=>a+r.height,0)+gap*(rows.length-1);
  const usedArea=rows.reduce((sum,row)=>sum+
    row.widths.reduce((a,w)=>a+w*row.height,0),0);
  const meanHeight=rows.reduce((sum,row)=>sum+row.height,0)/rows.length;
  const variance=rows.reduce((sum,row)=>sum+Math.pow(Math.log(row.height/Math.max(1,meanHeight)),2),0)/rows.length;
  const wasted=1-usedArea/Math.max(1,width*height);
  const lone=items.length>4?rows.filter(row=>row.items.length===1).length:0;
  return {rows,usedHeight,score:wasted+variance*.14+lone*.04};
}
function compute(input,width,height,gap=2){
  const items=input.slice(0,500),n=items.length;
  if(!n)return {rows:[],count:0,usedHeight:0};
  const W=Math.max(1,Number(width)||1);
  const H=Math.max(1,Number(height)||1);
  const G=Math.max(0,Math.min(24,Number(gap)||0));
  // Try plausible line counts; keep all tiles at their intrinsic aspect ratio.
  // The entire composition (not individual photos) scales when height is tight.
  const average=items.reduce((s,p)=>s+aspect(p),0)/n;
  const estimate=Math.sqrt(Math.max(1,n*average*H/W));
  const maxRows=Math.min(n,Math.max(3,Math.ceil(estimate*2.4)+5,Math.ceil(Math.sqrt(n)*1.6)));
  let best;
  for(let rowCount=1;rowCount<=maxRows;rowCount++){
    if((rowCount-1)*G>=H)break;
    const trial=geometry(items,W,H,G,partition(items,rowCount));
    if(!best||trial.score<best.score)best=trial;
  }
  return {rows:best.rows,count:n,usedHeight:best.usedHeight};
}
root.BaliMosaic=Object.freeze({compute,aspect});
})(globalThis);
