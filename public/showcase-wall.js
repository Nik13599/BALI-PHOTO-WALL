/* BALI PHOTO WALL · moving mass-photo showcases.
 * Three variants reuse approved screen images, never edit or duplicate data.
 * Every approved guest photo receives a full-size feature turn (default 3s).
 * Off-screen rail images are capped for modest Windows LED computers. */
(function(root){
'use strict';
const MODES=new Set(['showcase-spotlight','showcase-film','showcase-cascade']);
const reduced=()=>root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
let stage=null,grid=null,eventId=null,mode='',settings=null,getUrl=null;
let all=[],ids='',order=[],cursor=0,timer=null,timerMs=0,token='',currentId=null,layerIndex=0;
let focusLayers=[],caption=null,railHosts=[];
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
function shape(image){
 const w=Number(image.width),h=Number(image.height);
 return clamp(w>0&&h>0?w/h:1,.55,1.9);
}
function reshuffle(items){
 // Keep existing future turns intact while giving newly uploaded photos
 // the next opportunity. No guest is favoured repeatedly.
 const known=new Set(items.map(p=>p.id));
 const remaining=order.slice(cursor).filter(id=>known.has(id));
 const used=new Set(remaining);
 const fresh=items.map(p=>p.id).filter(id=>!used.has(id));
 order=[...fresh,...remaining];
 cursor=0;
 if(!order.length)order=items.map(p=>p.id);
}
function ensureStage(){
 if(stage&&stage.parentElement===grid&&mode===stage.dataset.mode)return;
 if(stage)stage.remove();
 stage=document.createElement('div');
 stage.className='showcase-stage showcase-'+mode.slice('showcase-'.length);
 stage.dataset.mode=mode;
 const ambient=document.createElement('div');ambient.className='showcase-ambient';
 const focus=document.createElement('div');focus.className='showcase-focus';
 focus.setAttribute('aria-label','Увеличенная фотография гостя BALI');
 focusLayers=[0,1].map(()=>{
  const img=document.createElement('img');
  img.className='showcase-focus-image';
  img.alt='Фото гостя BALI на главном LED-экране';
  img.decoding='async';
  focus.append(img);
  return img;
 });
 caption=document.createElement('div');
 caption.className='showcase-focus-caption';
 caption.textContent='BALI PHOTO WALL';
 focus.append(caption);
 stage.append(ambient,focus);
 railHosts=[];
 for(let i=0;i<(mode==='showcase-cascade'?4:mode==='showcase-film'?3:2);i++){
  const band=document.createElement('div');
  band.className='showcase-rail showcase-rail-'+(i+1);
  band.setAttribute('aria-hidden','true');
  stage.append(band);
  railHosts.push(band);
 }
 grid.replaceChildren(stage);
 currentId=null;layerIndex=0;token='';
}
function fillRails(){
 const railToken=mode+'|'+ids+'|'+settings.gap+'|'+settings.carouselSpeed+'|'+settings.carouselOuterSpeed;
 if(token===railToken)return;
 token=railToken;
 const limit=mode==='showcase-cascade'?48:mode==='showcase-film'?60:56;
 const source=all.slice(0,Math.min(all.length,limit));
 railHosts.forEach((host,index)=>{
  host.replaceChildren();
  const ticker=document.createElement('div');ticker.className='showcase-ticker';
  const sequence=document.createElement('div');sequence.className='showcase-sequence';
  const pool=source.filter((_p,i)=>i%railHosts.length===index);
  const actual=pool.length?pool:source;
  for(const p of actual){
   const holder=document.createElement('div');holder.className='showcase-thumb';
   holder.style.setProperty('--ratio',String(shape(p)));
   const image=document.createElement('img');
   image.src=getUrl(p.id,all.length>6?all.length:7);
   image.alt='';image.loading='lazy';image.decoding='async';
   holder.append(image);
   sequence.append(holder);
  }
  ticker.append(sequence,sequence.cloneNode(true));
  host.append(ticker);
  host.classList.toggle('showcase-reverse',index%2===1);
  const base=index%2===0?Number(settings.carouselSpeed):Number(settings.carouselOuterSpeed);
  ticker.style.setProperty('--showcase-scroll-duration',clamp(actual.length*180/Math.max(20,base),12,130)+'s');
 });
}
function feature(){
 if(!stage?.isConnected||!all.length||document.hidden||settings.carouselPause)return;
 if(cursor>=order.length){
  order=all.map(p=>p.id);
  // Rotate the cycle to avoid a repeating first/last photo junction.
  const offset=(Date.now()>>>0)%Math.max(1,order.length);
  order=order.slice(offset).concat(order.slice(0,offset));
  cursor=0;
 }
 const id=order[cursor++];
 if(currentId===id && all.length>1){feature();return;}
 currentId=id;
 const photo=all.find(p=>p.id===id);
 if(!photo)return;
 const next=1-layerIndex,incoming=focusLayers[next],outgoing=focusLayers[layerIndex];
 const url=getUrl(id,1);
 incoming.onload=()=>{
  if(currentId!==id||!stage?.isConnected)return;
  const animate=!reduced();
  incoming.style.transitionDuration=animate?'900ms':'0ms';
  outgoing.style.transitionDuration=animate?'900ms':'0ms';
  incoming.classList.add('is-active');
  outgoing.classList.remove('is-active');
 };
 incoming.onerror=()=>{if(currentId===id){incoming.classList.remove('is-active');}};
 incoming.classList.remove('is-active');
 incoming.src=url;
 if(incoming.complete&&incoming.naturalWidth>0)incoming.onload();
 layerIndex=next;
}
function startTimer(){
 const next=clamp(Number(settings.showcaseInterval)||3,2,12)*1000;
 if(timer&&timerMs===next)return;
 if(timer)root.clearInterval(timer);
 timerMs=next;
 timer=root.setInterval(()=>{if(!settings.carouselPause)feature();},next);
}
function render(args){
 if(!args?.grid||!MODES.has(args.settings?.layout))return;
 const changedEvent=eventId!==args.eventId;
 const nextIds=args.photos.map(p=>String(p.id)).join(',');
 const changed=changedEvent||nextIds!==ids;
 const previousMode=mode;
 grid=args.grid;eventId=args.eventId;all=args.photos;ids=nextIds;
 settings=args.settings;getUrl=args.getPhotoUrl;mode=settings.layout;
 if(changedEvent){order=[];cursor=0;currentId=null;}
 if(changed||!order.length)reshuffle(all);
 ensureStage();
 if(previousMode!==mode)token='';
 fillRails();
 stage.style.setProperty('--showcase-gap',settings.gap+'px');
 stage.classList.toggle('showcase-paused',settings.carouselPause||reduced());
 if(!currentId && all.length)feature();
 startTimer();
}
function stop(){
 if(timer)root.clearInterval(timer);
 timer=null;timerMs=0;
 if(stage)stage.remove();
 stage=null;grid=null;focusLayers=[];railHosts=[];caption=null;token='';currentId=null;
}
function reset(){
 stop();eventId=null;mode='';all=[];ids='';order=[];cursor=0;
}
root.BaliShowcaseWall=Object.freeze({render,stop,reset,modes:[...MODES]});
})(globalThis);
