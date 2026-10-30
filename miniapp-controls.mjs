/* Public Telegram button schedules controlled only by PHOTO WALL admin.
   Calendar time is Europe/Minsk (+03), never a guest device timezone. */
const WEEKDAYS=[0,1,2,3,4,5,6];
const TIME=/^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const BUTTON_DEFAULTS=Object.freeze({
 wall:{visible:true,mode:'auto',days:[5,6],start:'00:00',end:'06:00',nextDay:true},
 registration:{visible:true,mode:'auto',days:[5,6],start:'22:00',end:'03:00',nextDay:true},
 vote:{visible:true,mode:'auto',days:[6,0],start:'03:00',end:'04:00',nextDay:false}
});
export function normalizeButtons(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||
   Object.keys(raw).sort().join(',')!=='registration,vote,wall')throw Error('Три кнопки обязательны');
 const out={};
 for(const key of Object.keys(BUTTON_DEFAULTS)){
  const v=raw[key];
  if(!v||typeof v!=='object'||Array.isArray(v)||
    Object.keys(v).sort().join(',')!=='days,end,mode,nextDay,start,visible'||
    typeof v.visible!=='boolean'||!['auto','manual-on','manual-off'].includes(v.mode)||
    !Array.isArray(v.days)||v.days.length<1||v.days.length>7||
    v.days.some(d=>!WEEKDAYS.includes(d))||new Set(v.days).size!==v.days.length||
    !TIME.test(v.start)||!TIME.test(v.end)||typeof v.nextDay!=='boolean'||
    (v.nextDay===false&&v.end<=v.start))throw Error('Некорректное расписание '+key);
  out[key]={visible:v.visible,mode:v.mode,days:[...v.days].sort((a,b)=>a-b),
   start:v.start,end:v.end,nextDay:v.nextDay};
 }
 return out;
}
const mins=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
export function buttonWindow(setting,now=Date.now()){
 const local=new Date(now+3*3600000),weekday=local.getUTCDay();
 const midnightUtc=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-3*3600000;
 let open=false,nextAt=null,closesAt=null;
 for(let offset=-8;offset<=8;offset++){
  const day=(weekday+offset+70)%7;
  if(!setting.days.includes(day))continue;
  const start=midnightUtc+offset*86400000+mins(setting.start)*60000;
  const end=midnightUtc+offset*86400000+mins(setting.end)*60000+(setting.nextDay?86400000:0);
  if(now>=start&&now<end){open=true;closesAt=closesAt===null?end:Math.max(closesAt,end);}
  if(start>now&&(nextAt===null||start<nextAt))nextAt=start;
 }
 const manual=setting.mode==='manual-on';
 return {visible:setting.visible,open:setting.visible&&(manual||(setting.mode==='auto'&&open)),
  nextOpensAtMs:setting.visible&&setting.mode==='auto'&&!open?nextAt:null,
  closesAtMs:setting.visible&&(manual||open)?(manual?null:closesAt):null,
  mode:setting.mode};
}
export function publicButtons(config,now=Date.now()){
 const settings=normalizeButtons(config);
 return {serverNowMs:now,
  buttons:Object.fromEntries(Object.entries(settings).map(([key,s])=>
   [key,{...buttonWindow(s,now),start:s.start,end:s.end,days:s.days,nextDay:s.nextDay}]))};
}
