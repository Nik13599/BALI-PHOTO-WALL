/* Deterministic, testable full-screen random mosaic geometry.
 * One approved photo takes the spotlight; others tile the remaining screen.
 * No network, mutation or DOM side effects. */
(function(root){
'use strict';
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function random(seed){
  let state=(Number(seed)>>>0)||0x9e3779b9;
  return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
}
function shuffle(items,rnd){
  const arr=items.slice();
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(rnd()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function tile(region,photo){
  return {id:photo.id,x:region.x,y:region.y,width:region.width,height:region.height};
}
function split(region,items,gap,rnd,out){
  if(!items.length)return;
  if(items.length===1){out.push(tile(region,items[0]));return;}
  const horizontal=region.width/Math.max(1,region.height)>1.15
    ? true : region.height/Math.max(1,region.width)>1.15 ? false : rnd()>.5;
  const axis=horizontal?'width':'height';
  const count=items.length;
  const proposed=clamp(Math.round(count*(.35+rnd()*.3)),1,count-1);
  const first=items.slice(0,proposed),second=items.slice(proposed);
  const weightA=first.reduce((sum,p)=>sum+(p._weight||1),0);
  const weightB=second.reduce((sum,p)=>sum+(p._weight||1),0);
  const ratio=clamp(weightA/(weightA+weightB),.1,.9);
  const available=Math.max(0,region[axis]-gap);
  const sizeA=available*ratio,sizeB=available-sizeA;
  if(horizontal){
    split({x:region.x,y:region.y,width:sizeA,height:region.height},first,gap,rnd,out);
    split({x:region.x+sizeA+gap,y:region.y,width:sizeB,height:region.height},second,gap,rnd,out);
  }else{
    split({x:region.x,y:region.y,width:region.width,height:sizeA},first,gap,rnd,out);
    split({x:region.x,y:region.y+sizeA+gap,width:region.width,height:sizeB},second,gap,rnd,out);
  }
}
function squareCompute(photos,width,height,options={}){
  const items=photos.slice(0,500);
  if(!items.length)return {tiles:[],focusId:null};
  const W=Math.max(1,Number(width)||1),H=Math.max(1,Number(height)||1);
  const focus=items.find(p=>p.id===options.focusId)||items[0];
  if(items.length===1){
    const side=Math.min(W,H);
    return {tiles:[tile({x:(W-side)/2,y:(H-side)/2,width:side,height:side},focus)],focusId:focus.id};
  }
  const rnd=random(options.seed??1),gap=clamp(Number(options.gap)||0,0,16);
  const large=items.length>=5,needed=items.length+(large?3:0);
  let choice=null;
  for(let cols=1;cols<=Math.min(needed,40);cols++){
    const rows=Math.ceil(needed/cols);
    if(large&&cols<2)continue;
    const cell=Math.min((W-gap*(cols-1))/cols,(H-gap*(rows-1))/rows);
    if(cell>0&&(!choice||cell>choice.cell))choice={cols,rows,cell};
  }
  if(!choice)return {tiles:[],focusId:null};
  const {cols,rows,cell}=choice,step=cell+gap;
  const x0=(W-(cols*cell+(cols-1)*gap))/2;
  const y0=(H-(rows*cell+(rows-1)*gap))/2;
  const occupied=new Set(),tiles=[];
  const place=(photo,col,row,span=1)=>{
    for(let yy=row;yy<row+span;yy++)for(let xx=col;xx<col+span;xx++)occupied.add(yy*cols+xx);
    tiles.push(tile({x:x0+col*step,y:y0+row*step,width:span*cell+(span-1)*gap,height:span*cell+(span-1)*gap},photo));
  };
  if(large){
    const col=Math.floor(rnd()*(cols-1)),row=Math.floor(rnd()*(rows-1));
    place(focus,col,row,2);
  }
  const remaining=shuffle(large?items.filter(p=>p.id!==focus.id):items,rnd);
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    if(!remaining.length)break;
    if(!occupied.has(row*cols+col))place(remaining.shift(),col,row);
  }
  return {tiles,focusId:focus.id};
}
function compute(photos,width,height,options={}){
  if(options.squareTiles)return squareCompute(photos,width,height,options);
  const items=photos.slice(0,500);
  if(!items.length)return {tiles:[],focusId:null};
  const W=Math.max(1,Number(width)||1),H=Math.max(1,Number(height)||1);
  const gap=clamp(Number(options.gap)||0,0,Math.min(16,W/50,H/50));
  const rnd=random(options.seed??1);
  const chosen=items.find(p=>p.id===options.focusId)||items[0];
  const focusSize=clamp(Number(options.focusSize)||40,25,65)/100;
  // With a single photo there is no mosaic to rearrange. Display the entire
  // image at a restrained, centred size instead of expanding one tile to 100%
  // of the LED panel (which heavily crops portrait and square photos).
  if(items.length===1){
    const aspect=clamp((Number(chosen.width)||1)/Math.max(1,Number(chosen.height)||1),.25,4);
    const maxWidth=W*.65,maxHeight=H*.7;
    const w=Math.min(maxWidth,maxHeight*aspect);
    const h=w/aspect;
    return {tiles:[tile({x:(W-w)/2,y:(H-h)/2,width:w,height:h},chosen)],focusId:chosen.id};
  }
  const others=shuffle(items.filter(p=>p.id!==chosen.id),rnd)
    .map(p=>({...p,_weight:.72+rnd()*.75}));
  if(items.length<5){
    const focus={...chosen,_weight:items.length===1?1:1.5+focusSize*5};
    const tiles=[];split({x:0,y:0,width:W,height:H},shuffle([focus,...others],rnd),gap,rnd,tiles);
    return {tiles,focusId:chosen.id};
  }
  // The spotlight is always large and shifts around inside the central area.
  // Four edge rectangles cover the rest without overlapping the featured tile.
  const fw=W*clamp(focusSize*1.4+(rnd()-.5)*.09,.38,.79);
  const fh=H*clamp(focusSize*1.5+(rnd()-.5)*.08,.42,.82);
  const fx=W*(.08+rnd()*(.84-fw/W));
  const fy=H*(.08+rnd()*(.84-fh/H));
  const center={x:fx,y:fy,width:fw,height:fh};
  const regions=[
    {x:0,y:0,width:W,height:Math.max(0,fy-gap)},
    {x:0,y:fy+fh+gap,width:W,height:Math.max(0,H-fy-fh-gap)},
    {x:0,y:fy,width:Math.max(0,fx-gap),height:fh},
    {x:fx+fw+gap,y:fy,width:Math.max(0,W-fx-fw-gap),height:fh}
  ];
  // Every outer region receives at least one image, then distribute the rest
  // proportionally to each region's area (with randomness to change patterns).
  const groups=regions.map(()=>[]);
  const areas=regions.map(r=>r.width*r.height);
  for(let i=0;i<4;i++)groups[i].push(others.shift());
  while(others.length){
    const counts=groups.map((g,i)=>areas[i]/Math.pow(g.length+.5,.95)*(.82+rnd()*.36));
    const max=Math.max(...counts);
    const candidates=counts.map((v,i)=>v>=max-1e-12?i:-1).filter(i=>i>=0);
    groups[candidates[Math.floor(rnd()*candidates.length)]].push(others.shift());
  }
  const tiles=[tile(center,chosen)];
  regions.forEach((region,i)=>split(region,groups[i],gap,rnd,tiles));
  return {tiles,focusId:chosen.id};
}
function focusOrder(photos,seed){
  return shuffle(photos.map(p=>p.id),random(seed));
}
root.BaliLiveMosaic=Object.freeze({compute,focusOrder,shuffle,random});
})(globalThis);
