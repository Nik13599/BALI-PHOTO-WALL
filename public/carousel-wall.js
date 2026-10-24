/* BALI PHOTO WALL optional animated LED carousels.
   Incoming photographs enter a large track, then graduate to its small track
   after completing a full cycle. Moderators can assign a track per photograph. */
(function(root){
'use strict';
const engine=root.BaliCarousel;
if(!engine)return;
let activeEvent=null,state=null,stage=null,context=null;
const tracks=new Map();
const reduceMotion=()=>root.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
const aspect=p=>{
  const w=Number(p.width),h=Number(p.height);
  return w>0&&h>0?Math.max(.42,Math.min(2.3,w/h)):1;
};
function definitions(settings){
  const top=settings.carouselTopHeight,bottom=settings.carouselBottomHeight;
  const center=100-top-bottom;
  const upper=center*settings.carouselCenterSplit/100;
  const lower=center-upper;
  if(settings.layout==='carousel-double')
    return [{key:'top-main',size:settings.carouselCenterSplit,speed:settings.carouselSpeed,direction:'left'},
      {key:'bottom-main',size:100-settings.carouselCenterSplit,speed:settings.carouselSpeed,direction:'right'}];
  if(settings.layout==='carousel-triple')
    return [{key:'top-small',size:top+bottom,speed:settings.carouselOuterSpeed,direction:'right'},
      {key:'top-main',size:upper,speed:settings.carouselSpeed,direction:'left'},
      {key:'bottom-main',size:lower,speed:settings.carouselSpeed,direction:'right'}];
  if(settings.layout==='carousel-festival')
    return [{key:'top-small',size:Math.max(8,top+4),speed:settings.carouselOuterSpeed,direction:'left'},
      {key:'top-main',size:Math.max(12,upper-4),speed:settings.carouselSpeed,direction:'right'},
      {key:'bottom-main',size:Math.max(12,lower-4),speed:settings.carouselSpeed,direction:'left'},
      {key:'bottom-small',size:Math.max(8,bottom+4),speed:settings.carouselOuterSpeed,direction:'right'}];
  return [{key:'top-small',size:top,speed:settings.carouselOuterSpeed,direction:'left'},
    {key:'top-main',size:upper,speed:settings.carouselSpeed,direction:'left'},
    {key:'bottom-main',size:lower,speed:settings.carouselSpeed,direction:'right'},
    {key:'bottom-small',size:bottom,speed:settings.carouselOuterSpeed,direction:'right'}];
}
function photosFor(key,layout){
  const [lane,kind]=key.split('-');
  if(layout==='carousel-double')return [...state[lane].featured,...state[lane].waiting,...state[lane].archive];
  if(kind==='main')return state[lane].featured;
  if(layout==='carousel-triple')return [...state.top.archive,...state.bottom.archive];
  return state[lane].archive;
}
function makeTile(p,height,count,src){
  const tile=document.createElement('div');
  tile.className='carousel-tile';
  tile.style.width=Math.max(20,Math.round(Math.max(1,height)*aspect(p)))+'px';
  const img=document.createElement('img');
  img.alt='Фотография гостя BALI';
  img.decoding='async';
  img.loading='lazy';
  img.src=src(p.id,count);
  tile.append(img);
  return tile;
}
function repaint(key){
  const item=tracks.get(key);
  if(!item||!stage||!stage.isConnected)return;
  const {band,speed,direction}=item;
  const source=photosFor(key,context.settings.layout);
  band.replaceChildren();
  if(!source.length){
    const empty=document.createElement('div');
    empty.className='carousel-band-empty';
    empty.textContent=key.endsWith('small')?'Прошедшие фотографии появятся здесь':'Ожидаем одобренные фотографии';
    band.append(empty);
    return;
  }
  const ticker=document.createElement('div');
  ticker.className='carousel-ticker';
  const first=document.createElement('div');
  first.className='carousel-sequence';
  const tileHeight=Math.max(36,band.clientHeight-context.settings.gap*2);
  // One repetition is long enough for a smooth loop on very wide LED screens.
  const expanded=[...source];
  const minWidth=band.clientWidth*1.12;
  let estimated=source.reduce((sum,p)=>sum+tileHeight*aspect(p)+context.settings.gap,0);
  while(estimated<minWidth && expanded.length<300){
    expanded.push(...source.slice(0,Math.max(1,Math.min(source.length,300-expanded.length))));
    estimated=expanded.reduce((sum,p)=>sum+tileHeight*aspect(p)+context.settings.gap,0);
  }
  for(const photo of expanded)first.append(makeTile(photo,tileHeight,source.length,context.getPhotoUrl));
  const second=first.cloneNode(true);
  second.setAttribute('aria-hidden','true');
  ticker.append(first,second);
  ticker.style.setProperty('--carousel-gap',context.settings.gap+'px');
  ticker.style.setProperty('--carousel-direction',direction);
  band.append(ticker);
  const width=first.getBoundingClientRect().width+context.settings.gap;
  ticker.style.setProperty('--carousel-distance',width+'px');
  ticker.style.animationDuration=Math.max(5,width/Math.max(1,speed))+'s';
  ticker.classList.add(direction==='right'?'carousel-move-right':'carousel-move-left');
  if(context.settings.carouselPause||reduceMotion())ticker.style.animationPlayState='paused';
  if(key.endsWith('main')&&context.settings.layout!=='carousel-double'){
    ticker.addEventListener('animationiteration',()=>{
      if(document.hidden||context.settings.carouselPause||reduceMotion())return;
      const lane=key.startsWith('top')?'top':'bottom';
      engine.advance(state,lane);
      repaint(key);
      repaint(lane==='top'?'top-small':'bottom-small');
      if(context.settings.layout==='carousel-triple')repaint('top-small');
    });
  }
}
function render(args){
  const {grid,photos,eventId,settings}=args;
  if(activeEvent!==eventId){activeEvent=eventId;state=null;}
  state=engine.sync(state,photos);
  context=args;
  if(stage?.parentElement!==grid){
    stage=document.createElement('div');
    stage.className='carousel-stage';
    grid.replaceChildren(stage);
  }
  const layout=definitions(settings);
  // Rebuild only when the selected mode changes, or screen settings/queue change.
  const token=JSON.stringify({mode:settings.layout,photos:photos.map(p=>[p.id,p.screen_lane]),
    props:[settings.carouselSpeed,settings.carouselOuterSpeed,settings.carouselTopHeight,
      settings.carouselBottomHeight,settings.carouselCenterSplit,settings.carouselPause,settings.gap,
      grid.clientWidth,grid.clientHeight]});
  if(stage.dataset.renderToken===token)return;
  stage.dataset.renderToken=token;
  tracks.clear();
  stage.replaceChildren();
  for(const spec of layout){
    const band=document.createElement('div');
    band.className='carousel-band '+(spec.key.endsWith('main')?'carousel-main':'carousel-small');
    band.style.flexBasis=spec.size+'%';
    band.dataset.band=spec.key;
    stage.append(band);
    tracks.set(spec.key,{band,speed:spec.speed,direction:spec.direction});
  }
  for(const key of tracks.keys())repaint(key);
}
function stop(){
  if(stage){stage.remove();stage=null;}
  tracks.clear();
}
function reset(){stop();state=null;activeEvent=null;context=null;}
root.BaliCarouselWall=Object.freeze({render,stop,reset});
})(globalThis);
