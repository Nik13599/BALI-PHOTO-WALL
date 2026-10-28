// Single club-PC control room: LED configuration, ordinary-photo counts,
// and a read-only authenticated health bridge to existing BALI-MENU D1.
// Only operational settings are written here; no guest image bytes reach BALI-MENU.
import os from 'node:os';
const MODES=['puzzle','grid','live-mosaic','carousel-quad','carousel-double','carousel-triple','carousel-festival'];
const defaults={layout:'live-mosaic',maxPhotos:500,gap:2,fit:'contain',
 liveInterval:8,liveFocus:40,carouselSpeed:85,carouselOuterSpeed:120,
 showLogo:true,showLive:true,showEvent:true,showQr:true,showHint:true};
const ranges={maxPhotos:[1,500],gap:[0,16],liveInterval:[3,45],
 liveFocus:[25,65],carouselSpeed:[20,260],carouselOuterSpeed:[20,300]};
function valid(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const cleaned={};
 for(const [key,base] of Object.entries(defaults)){
  const v=value[key]===undefined?base:value[key];
  if(key==='layout'){if(!MODES.includes(v))return null;}
  else if(key==='fit'){if(!['cover','contain'].includes(v))return null;}
  else if(typeof base==='boolean'){if(typeof v!=='boolean')return null;}
  else if(!Number.isInteger(v)||v<ranges[key][0]||v>ranges[key][1])return null;
  cleaned[key]=v;
 }
 return cleaned;
}
const maskError=error=>String(error?.message||error).slice(0,120);
export function registerControlRoom({app,db,adminAuth,screenAuth,requireAction}){
 db.exec('CREATE TABLE IF NOT EXISTS wall_control_settings ('+
  'id INTEGER PRIMARY KEY CHECK(id=1),data_json TEXT NOT NULL,updated_at INTEGER NOT NULL)');
 const stored=()=>{const row=db.prepare('SELECT data_json,updated_at FROM wall_control_settings WHERE id=1').get();
  let settings=null;try{settings=valid(JSON.parse(row?.data_json||'null'))}catch{}
  return {settings:settings||{...defaults},updatedAt:row?.updated_at||0};
 };
 let lastScreenBeat=0;
 let screenMeta={};
 app.get('/api/screen/control-settings',screenAuth,(_req,res)=>
  res.json(stored()));
 app.post('/api/screen/control-heartbeat',screenAuth,(req,res)=>{
  lastScreenBeat=Date.now();
  const layout=req.body?.layout;
  screenMeta={layout:typeof layout==='string'&&MODES.includes(layout)?layout:null};
  res.json({ok:true});
 });
 app.get('/api/admin/control/screen',adminAuth,(_req,res)=>res.json(stored()));
 app.post('/api/admin/control/screen',adminAuth,requireAction,(req,res)=>{
  const settings=valid(req.body);
  if(!settings)return res.status(400).json({error:'Некорректные настройки LED'});
  // Monotonic revision lets screen windows detect changes promptly.
  const revision=Math.max(Date.now(),stored().updatedAt+1);
  db.prepare('INSERT INTO wall_control_settings(id,data_json,updated_at) VALUES(1,?,?) '+
   'ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at')
   .run(JSON.stringify(settings),revision);
  res.json({ok:true,updatedAt:revision,settings});
 });
 const guestStats=()=>{const active=db.prepare('SELECT id,name FROM events WHERE active=1 LIMIT 1').get();
  const counts=active?db.prepare("SELECT status,COUNT(*) AS n FROM photos WHERE event_id=? GROUP BY status")
    .all(active.id):[];
  const ordinary={pending:0,approved:0,rejected:0,total:0};
  for(const row of counts){ordinary[row.status]=row.n;ordinary.total+=row.n;}
  return {event:active?.name||null,ordinary};
 };
 app.get('/api/admin/control/status',adminAuth,async(_req,res)=>{
  const start=Date.now(),club=guestStats(),local={
   online:true,checkedAt:start,uptimeSeconds:Math.floor(process.uptime()),
   screenConnected:Date.now()-lastScreenBeat<16000&&lastScreenBeat>0,
   screenLastSeenAt:lastScreenBeat||null,screenLayout:screenMeta.layout||null,
   event:club.event,ordinary:club.ordinary,storage:'Windows / SQLite',system:'photo-wall'
  };
  const key=process.env.CONTEST_BRIDGE_KEY||'';
  const raw=process.env.BALI_CONTROL_STATUS_URL||'https://baliminsk.by/api/photo-wall-control-status';
  const central={online:false,configured:false,checkedAt:start,
   database:'Cloudflare D1',error:'Проверка не настроена'};
  try{
   const target=new URL(raw);
   if(target.protocol!=='https:'||target.username||target.password)
    throw Error('Нужен внешний HTTPS-адрес BALI-MENU');
   if(key.length<32||key.includes('CHANGE_'))throw Error('CONTEST_BRIDGE_KEY не настроен');
   central.configured=true;
   const response=await fetch(target,{headers:{'X-BALI-Bridge-Key':key},
    signal:AbortSignal.timeout(4500),redirect:'error'});
   if(!response.ok)throw Error('BALI-MENU HTTP '+response.status);
   const data=await response.json();
   if(data?.ok!==true||data?.system!=='bali-menu')throw Error('Неожиданный ответ BALI-MENU');
   Object.assign(central,{online:true,checkedAt:data.checkedAt||Date.now(),
    usage:data.usage,limits:data.limits,contest:data.contest,error:null});
  }catch(err){central.error=maskError(err);}
  res.set('Cache-Control','no-store').json({photoWall:local,baliMenu:central,
   responseMs:Date.now()-start});
 });
}
