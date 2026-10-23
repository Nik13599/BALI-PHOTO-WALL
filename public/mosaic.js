/* Orientation-aware justified photo mosaic. Pure geometry; no dependencies. */
(function(root){
  'use strict';
  function aspect(photo){
    const width=Number(photo?.width),height=Number(photo?.height);
    return width>0&&height>0 ? Math.max(.28,Math.min(4,width/height)) : 1;
  }
  function partition(items,rowCount){
    const ratios=items.map(aspect);
    const result=[];
    let offset=0,sumRemaining=ratios.reduce((a,b)=>a+b,0);
    for(let row=0;row<rowCount;row++){
      const rowsLeft=rowCount-row;
      const maxEnd=items.length-(rowsLeft-1);
      let end=offset+1,partial=ratios[offset];
      const target=sumRemaining/rowsLeft;
      while(end<maxEnd){
        const candidate=partial+ratios[end];
        if(Math.abs(candidate-target)>Math.abs(partial-target) && partial>0)break;
        partial=candidate;end++;
      }
      result.push({start:offset,end,ratioSum:partial});
      sumRemaining-=partial;offset=end;
    }
    return result;
  }
  function geometry(items,width,height,gap,groups){
    const availableHeight=Math.max(1,height-gap*(groups.length-1));
    const raws=groups.map(group=>
      Math.max(1,width-gap*(group.end-group.start-1))/group.ratioSum);
    const rawTotal=raws.reduce((a,b)=>a+b,0);
    let usedHeight=0,score=0;
    const rows=groups.map((group,i)=>{
      const count=group.end-group.start;
      const h=i===groups.length-1?Math.max(1,availableHeight-usedHeight):
        Math.max(1,availableHeight*raws[i]/rawTotal);
      usedHeight+=h;
      const usableWidth=Math.max(1,width-gap*(count-1));
      const current=items.slice(group.start,group.end);
      const widths=current.map(photo=>usableWidth*aspect(photo)/group.ratioSum);
      // A uniform mismatch within a row is much less objectionable than
      // cutting everyone to a fixed-size rectangle.
      const cropPenalty=Math.log(Math.max(.00001,raws[i]/h));
      score+=count*cropPenalty*cropPenalty;
      // Avoid an isolated image with extreme height next to tiny rows.
      if(items.length>4&&count===1)score+=.5;
      return {items:current,height:h,widths};
    });
    return {rows,score};
  }
  function compute(photos,width,height,gap=2){
    const items=photos.slice(0,500),n=items.length;
    if(!n)return {rows:[],count:0};
    const W=Math.max(1,Number(width)||1),H=Math.max(1,Number(height)||1);
    const G=Math.max(0,Math.min(24,Number(gap)||0));
    const total=items.reduce((s,p)=>s+aspect(p),0);
    const estimated=Math.sqrt(Math.max(1,total*H/W));
    let best=null;
    const upper=Math.min(n,Math.max(2,Math.ceil(estimated*1.6)+3));
    for(let count=1;count<=upper;count++){
      if(H-(count-1)*G<count)continue;
      const rows=partition(items,count);
      const candidate=geometry(items,W,H,G,rows);
      candidate.score+=Math.abs(count-estimated)*.01;
      if(!best||candidate.score<best.score)best=candidate;
    }
    return {rows:best?.rows||geometry(items,W,H,G,partition(items,1)).rows,count:n};
  }
  root.BaliMosaic=Object.freeze({compute,aspect});
})(globalThis);
