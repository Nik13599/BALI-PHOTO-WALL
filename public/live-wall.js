/* BALI PHOTO WALL: animated full-screen random photo mosaic.
 * Reuses image nodes and animates rect changes; never changes stored photos. */
(function(root){
'use strict';
const engine=root.BaliLiveMosaic;
if(!engine)return;
const reduced=()=>root.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
let stage=null,grid=null,photos=[],eventId=null,options=null,getPhotoUrl=null;
let signature='',sequence=[],position=0,round=0,layoutSeed=0,interval=null,intervalMs=0;
let active=false;
const nodes=new Map();
function makeSequence(newItems,changed){
  const all=newItems.map(p=>p.id);
  if(!changed && sequence.length===all.length && sequence.every(id=>all.includes(id)))return;
  const missing=all.filter(id=>!sequence.includes(id));
  const previous=sequence.filter(id=>all.includes(id));
  const upcoming=previous.slice(position).concat(previous.slice(0,position));
  // Newly approved images become featured next, rather than waiting a full tour.
  sequence=[...missing,...upcoming];
  if(!sequence.length)sequence=engine.focusOrder(newItems,(++round)*314159);
  position=0;
}
function makeNode(photo,total){
  let element=nodes.get(photo.id);
  if(!element){
    element=document.createElement('div');
    element.className='live-mosaic-tile';
    element.dataset.id=String(photo.id);
    const img=document.createElement('img');
    img.alt='Фото гостя BALI';
    img.loading='eager';img.decoding='async';
    img.addEventListener('error',()=>element.classList.add('wall-tile-error'));
    img.addEventListener('load',()=>element.classList.remove('wall-tile-error'));
    element.append(img);
    nodes.set(photo.id,element);
    stage.append(element);
  }
  return element;
}
function draw(){
  if(!active||!stage||!stage.isConnected||!options||!photos.length)return;
  if(position>=sequence.length){
    // Every approved photo has its turn before anybody is spotlighted again.
    let reordered=engine.focusOrder(photos,(++round*2654435761)>>>0);
    if(reordered.length>1 && reordered[0]===sequence[sequence.length-1])
      reordered=[...reordered.slice(1),reordered[0]];
    sequence=reordered;position=0;
  }
  const focusId=sequence[position];
  const width=Math.max(1,stage.clientWidth),height=Math.max(1,stage.clientHeight);
  const result=engine.compute(photos,width,height,{
    seed:(++layoutSeed*314159265+round*13891)>>>0,focusId,
    gap:options.gap,focusSize:options.liveFocus
  });
  const animate=!reduced() && photos.length<=125 && options.liveTransition>0;
  stage.style.setProperty('--live-transition',animate?options.liveTransition+'ms':'0ms');
  const keys=new Set(result.tiles.map(item=>item.id));
  for(const [id,node] of nodes){
    if(!keys.has(id)){node.remove();nodes.delete(id);}
  }
  for(const rect of result.tiles){
    const photo=photos.find(p=>p.id===rect.id);
    if(!photo)continue;
    const node=makeNode(photo,photos.length);
    const prominent=rect.id===focusId;
    node.classList.toggle('live-mosaic-feature',prominent);
    const img=node.firstElementChild;
    img.style.objectFit=options.liveFit||'cover';
    // Show original resolution of the spotlight; light thumbnails for the rest.
    const src=prominent?'/api/photos/'+photo.id:getPhotoUrl(photo.id,photos.length);
    if(img.getAttribute('src')!==src)img.src=src;
    node.style.left=rect.x+'px';
    node.style.top=rect.y+'px';
    node.style.width=Math.max(0,rect.width)+'px';
    node.style.height=Math.max(0,rect.height)+'px';
  }
}
function step(){
  if(!active||!photos.length || document.hidden||options.livePause||reduced())return;
  position+=1;
  draw();
}
function startTimer(){
  const next=options ? options.liveInterval*1000 : 0;
  if(interval && intervalMs===next)return;
  if(interval)root.clearInterval(interval);
  interval=null;intervalMs=next;
  if(active&&next>0)interval=root.setInterval(step,next);
}
function render(args){
  const {grid:target,photos:newPhotos,eventId:newEventId,settings,getPhotoUrl:src}=args;
  const ids=newPhotos.map(p=>[p.id,p.width,p.height].join('/')).join(',');
  const changed=signature!==ids || eventId!==newEventId;
  if(eventId!==newEventId){
    sequence=[];position=0;round=0;layoutSeed=0;
  }
  eventId=newEventId;
  signature=ids;
  grid=target;
  photos=newPhotos;
  options=settings;
  getPhotoUrl=src;
  active=true;
  if(!stage || stage.parentElement!==grid){
    stage=document.createElement('div');
    stage.className='live-mosaic-stage';
    grid.replaceChildren(stage);
    nodes.clear();
  }
  makeSequence(photos,changed);
  draw();
  startTimer();
}
function next(){if(!active||!sequence.length)return;position+=1;draw();}
function stop(){
  active=false;
  if(interval){root.clearInterval(interval);interval=null;}
  intervalMs=0;
  if(stage){stage.remove();stage=null;}
  nodes.clear();
  grid=null;options=null;getPhotoUrl=null;
}
function reset(){
  stop();photos=[];eventId=null;sequence=[];position=0;signature='';round=0;layoutSeed=0;
}
root.BaliLiveWall=Object.freeze({render,next,stop,reset});
})(globalThis);
