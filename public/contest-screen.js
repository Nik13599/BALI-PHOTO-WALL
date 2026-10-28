// Contest graphics are an independent LED overlay. Existing BALI Photo Wall
// mosaic/carousel layout remains active underneath and is never replaced.
(()=>{
const overlay=document.getElementById('contestOverlay');
if(!overlay)return;
const stripWrap=document.getElementById('contestStripWrap');
const strip=document.getElementById('contestStrip');
const winners=document.getElementById('contestWinners');
const title=document.getElementById('contestOverlayTitle');
const timer=document.getElementById('contestOverlayTimer');
let signature='',current=null,serverOffset=0;
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function photoUrl(id){return '/api/screen/contest/photo/'+id}
function card(entry,contest){
  const ratio={square:1,portrait:9/16,landscape:16/9}[contest.shape]||1;
  const height=contest.tileHeight||240;
  const width=Math.round((height-32)*ratio);
  const el=document.createElement('div');
  el.className='contest-tile';
  el.style.cssText='height:'+height+'px;width:'+Math.max(90,width)+'px';
  const img=document.createElement('img');
  img.src=photoUrl(entry.id);img.alt='';img.loading='lazy';img.decoding='async';
  el.append(img);
  const label=document.createElement('span');
  label.className='contest-tile-label';
  label.textContent='№'+entry.id;
  el.append(label);
  return el;
}
function renderStrip(data){
  winners.hidden=true;stripWrap.hidden=false;timer.hidden=false;
  const people=data.entries;
  strip.replaceChildren();
  if(!people.length){stripWrap.hidden=true;return;}
  const first=document.createElement('div');
  first.className='contest-strip-track';
  const totalWidth=()=>[...first.children].reduce((sum,node)=>sum+node.getBoundingClientRect().width+14,0);
  // Repeat the approved set until the track is wider than the LED viewport.
  // Duplicating it then provides a seamless continuous conveyor.
  let i=0;
  const ratio={square:1,portrait:9/16,landscape:16/9}[data.contest.shape]||1;
  const cardWidth=Math.max(90,Math.round((data.contest.tileHeight-32)*ratio))+14;
  const repeatCount=Math.min(1000,Math.max(people.length,Math.ceil((window.innerWidth*1.6)/cardWidth)));
  while(i<repeatCount){first.append(card(people[i%people.length],data.contest));i++;}
  strip.append(first);
  strip.append(first.cloneNode(true));
  requestAnimationFrame(()=>{
    const width=first.getBoundingClientRect().width+14;
    const duration=Math.max(4,width/Math.max(20,data.contest.tileSpeed));
    strip.style.setProperty('--contest-track-width',width+'px');
    strip.style.setProperty('--contest-cycle',duration+'s');
  });
}
function crown(place){
  // Stylized crown character with metallic CSS shadow. Animation plays on LED.
  const color={1:'#f6cf63',2:'#d5dbec',3:'#c78d5b'}[place];
  return {color,symbol:'♛'};
}
function renderWinners(data){
  stripWrap.hidden=true;timer.hidden=true;
  winners.replaceChildren();
  if(!data.winners.length){overlay.hidden=true;return;}
  winners.hidden=false;
  for(const item of data.winners){
    const node=document.createElement('div');
    node.className='contest-winner place-'+item.place;
    node.dataset.count=String(data.winners.length);
    const wrap=document.createElement('div');
    wrap.className='contest-winner-image';
    const photo=document.createElement('img');
    photo.src=photoUrl(item.id);photo.alt='Победитель конкурса';
    wrap.append(photo);
    const crownEl=document.createElement('span');
    crownEl.className='contest-crown';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 100 80');svg.setAttribute('width','100%');svg.setAttribute('height','100%');
    const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');
    polygon.setAttribute('points','8,22 28,43 50,9 72,43 92,22 84,65 16,65');
    polygon.setAttribute('fill','currentColor');polygon.setAttribute('stroke','#fff8');polygon.setAttribute('stroke-width','1.5');
    const base=document.createElementNS('http://www.w3.org/2000/svg','rect');
    base.setAttribute('x','16');base.setAttribute('y','66');base.setAttribute('width','68');base.setAttribute('height','10');
    base.setAttribute('rx','2');base.setAttribute('fill','currentColor');
    svg.append(polygon,base);crownEl.append(svg);crownEl.setAttribute('aria-label','Корона');
    wrap.append(crownEl);
    const name=document.createElement('div');
    name.className='contest-winner-name';
    name.textContent=item.display_name||'Участник №'+item.id;
    const place=document.createElement('div');
    place.className='contest-winner-place';
    place.textContent=({1:'1 МЕСТО · ЗОЛОТО',2:'2 МЕСТО · СЕРЕБРО',3:'3 МЕСТО · БРОНЗА'})[item.place];
    node.append(wrap,name,place);winners.append(node);
  }
}
function tick(){
  if(!current||current.contest.state!=='live')return;
  const seconds=Math.max(0,Math.ceil((current.contest.endsAt-(Date.now()+serverOffset))/1000));
  timer.textContent='ГОЛОСОВАНИЕ · '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
}
async function refresh(){
  try{
    const response=await fetch('/api/screen/contest',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok){if(response.status===401){overlay.hidden=true;signature='';}return;}
    const data=await response.json();
    serverOffset=data.serverNow-Date.now();
    current=data;
    const next=JSON.stringify([data.contest,data.entries,data.winners]);
    if(signature!==next){
      signature=next;
      if(!data.contest||data.contest.state==='draft'||data.contest.state==='awaiting_results'){
        overlay.hidden=true;return;
      }
      title.textContent=data.contest.title;
      overlay.hidden=false;
      if(data.contest.state==='live')renderStrip(data);
      else if(data.contest.state==='complete')renderWinners(data);
    }
    tick();
  }catch(e){console.warn('Contest overlay sync:',e.message)}
}
const onResize=()=>{if(current?.contest?.state==='live'){signature='';refresh().catch(console.error)}};
window.addEventListener('resize',onResize);
setInterval(tick,500);
setInterval(()=>refresh().catch(console.error),2000);
refresh().catch(console.error);
})();
