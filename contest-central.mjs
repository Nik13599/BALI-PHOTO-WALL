// PHOTO WALL runs on the club Windows PC; final votes and registered identities
// belong to the existing BALI-MENU Cloudflare D1 backend.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
const isPositive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0;
const secret=()=>process.env.CONTEST_BRIDGE_KEY||'';
function nextMidnightMinsk(){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
    timeZone:'Europe/Minsk',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date()).map(x=>[x.type,Number(x.value)]));
  // Minsk UTC+3 throughout the operational calendar.
  return Date.UTC(parts.year,parts.month-1,parts.day+1,-3,0,0);
}
const secured=(req,res,next)=>{
  const value=secret();
  if(value.length<32||value.includes('CHANGE_'))return res.status(503).json({error:'Bridge not configured'});
  const given=req.get('X-BALI-Bridge-Key')||'';
  const actual=crypto.createHash('sha256').update(given).digest();
  const expected=crypto.createHash('sha256').update(value).digest();
  if(!crypto.timingSafeEqual(actual,expected))return res.status(401).json({error:'Invalid bridge key'});
  next();
};
export function registerCentralContest({app,db,DATA}){
 const dir=path.join(DATA,'contest');
 const thumbs=path.join(dir,'voting-thumbs');
 fs.mkdirSync(thumbs,{recursive:true});
 const cols=db.pragma('table_info(contests)').map(r=>r.name);
 if(!cols.includes('starts_at'))db.exec('ALTER TABLE contests ADD COLUMN starts_at INTEGER');
 const current=()=>db.prepare("SELECT c.* FROM contests c JOIN events e ON e.id=c.event_id WHERE e.active=1 ORDER BY c.id DESC LIMIT 1").get();
 const assigned=()=>{let c=current();if(c?.state==='draft'&&!c.starts_at){
   db.prepare("UPDATE contests SET starts_at=? WHERE id=? AND starts_at IS NULL").run(nextMidnightMinsk(),c.id);
   c=current();
 }return c;};
 const publicData=c=>{
  const n=Date.now(),starts=c?.starts_at||0;
  const phase=!c?'unconfigured':c.state==='complete'?'complete':
   c.state==='live'&&n>=c.ends_at?'awaiting_results':
   c.state==='live'?'voting':
   starts&&n>=starts?'awaiting_start':
   starts&&n>=starts-3600000?'registration':'scheduled';
  return {online:true,contest:c?{id:c.id,title:c.title,prizePlaces:c.prize_places,durationSeconds:c.duration_seconds,
   phase,registrationOpensAt:starts-3600000,startsAt:starts,
   endsAt:c.ends_at||null}:null,serverNow:n};
 };
 const tick=()=>{
  const c=assigned();if(!c||c.state!=='draft'||Date.now()<c.starts_at)return;
  const approved=db.prepare("SELECT COUNT(*) AS n FROM contest_entries WHERE contest_id=? AND status='approved'").get(c.id).n;
  const time=Date.now();
  if(!approved){
    // No approved contestant: close without creating a fictitious winner.
    db.prepare("UPDATE contests SET state='complete',started_at=?,ends_at=?,finished_at=? WHERE id=? AND state='draft'")
      .run(c.starts_at,c.starts_at,time,c.id);
    return;
  }
  db.prepare("UPDATE contests SET state='live',started_at=?,ends_at=? WHERE id=? AND state='draft'")
   .run(c.starts_at,c.starts_at+c.duration_seconds*1000,c.id);
 };
 app.get('/api/public/photo-wall-status',(_req,res)=>res.json(publicData(assigned())));
 app.get('/api/integrations/contest-state',secured,(_req,res)=>{
  tick();const c=assigned(),base=publicData(c);
  if(!c)return res.json({...base,entries:[]});
  const entries=c.state==='live'?db.prepare(
   "SELECT id AS number,external_id AS externalId,display_name AS name FROM contest_entries "+
   "WHERE contest_id=? AND status='approved' ORDER BY id").all(c.id):
   c.state==='complete'?db.prepare(
   "SELECT e.id AS number,e.external_id AS externalId,e.display_name AS name FROM contest_winners w "+
   "JOIN contest_entries e ON e.id=w.entry_id WHERE w.contest_id=? ORDER BY w.place").all(c.id):[];
  res.json({...base,entries});
 });
 // The public image route contains no name, Card ID, voter ID or registration metadata.
 app.get('/api/public/contest-photo/:number',(req,res)=>{
  (async()=>{
   const c=assigned();const id=Number(req.params.number);
   if(!c||!isPositive(id)||!['live','complete'].includes(c.state))return res.status(404).end();
   const e=db.prepare("SELECT id,filename,crop_filename FROM contest_entries WHERE id=? AND contest_id=? AND status='approved'")
     .get(id,c.id);
   if(!e)return res.status(404).end();
   if(c.state==='complete'){
    const awarded=db.prepare("SELECT 1 FROM contest_winners WHERE contest_id=? AND entry_id=?").get(c.id,e.id);
    if(!awarded)return res.status(404).end();
   }
   const source=e.crop_filename||e.filename;
   // The browser receives a compact gallery thumbnail; originals stay on Windows.
   // The source filename makes cache entries immutable when moderators recrop.
   const output=path.join(thumbs,e.id+'-'+source+'.webp');
   if(!fs.existsSync(output)){
    const image=await sharp(path.join(dir,source)).resize({
     width:450,height:450,fit:'inside',withoutEnlargement:true
    }).webp({quality:72,effort:3}).toBuffer();
    await fsp.writeFile(output,image,{flag:'wx'}).catch(error=>{
     if(error.code!=='EEXIST')throw error;
    });
   }
   res.set('Cross-Origin-Resource-Policy','cross-origin')
    .set('Cache-Control','public,max-age=300').type('image/webp').sendFile(output);
  })().catch(e=>{console.error('Contest thumbnail:',String(e?.message||e).slice(0,150));
   if(!res.headersSent)res.status(503).end();});
 });
 const finalize=db.transaction((c,ranked)=>{
  const current=db.prepare('SELECT state FROM contests WHERE id=?').get(c.id);
  if(current?.state!=='live')return;
  const winner=db.prepare("INSERT INTO contest_winners(contest_id,entry_id,place,votes) VALUES (?,?,?,?)");
  const byExternal=db.prepare("SELECT id FROM contest_entries WHERE contest_id=? AND external_id=? AND status='approved'");
  for(const [i,item] of ranked.slice(0,c.prize_places).entries()){
   if(item.votes===0)break;
   const e=byExternal.get(c.id,item.externalId);if(!e)throw Error('Unapproved winner: '+item.externalId);
   winner.run(c.id,e.id,i+1,item.votes);
  }
  db.prepare("UPDATE contests SET state='complete',finished_at=? WHERE id=? AND state='live'")
   .run(Date.now(),c.id);
 });
 let fetching=false;
 async function fetchAuthoritativeResults(){
  const c=assigned();
  if(fetching||!c||c.state!=='live'||!c.ends_at||Date.now()<c.ends_at||secret().length<32)return;
  fetching=true;
  try{
   const url=process.env.BALI_CONTEST_RESULTS_URL||'https://baliminsk.by/api/photo-contest/results';
   const endpoint=new URL(url);
   if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw Error('Results URL must be HTTPS');
   endpoint.searchParams.set('contestId',String(c.id));
   const response=await fetch(endpoint,{headers:{'X-BALI-Bridge-Key':secret()},
    signal:AbortSignal.timeout(9000),redirect:'error'});
   if(!response.ok)throw Error('BALI central results HTTP '+response.status);
   const result=await response.json();
   if(result?.contestId!==c.id||result?.ready!==true||!Array.isArray(result.ranked))throw Error('Results not confirmed');
   const approved=db.prepare("SELECT external_id FROM contest_entries WHERE contest_id=? AND status='approved'").all(c.id);
   if(approved.length!==result.ranked.length)throw Error('Central participant roster does not match');
   const approvedIds=new Set(approved.map(x=>x.external_id)),used=new Set();
   for(const row of result.ranked){
    if(!row||typeof row.externalId!=='string'||!approvedIds.has(row.externalId)||
      used.has(row.externalId)||!Number.isSafeInteger(row.votes)||row.votes<0)
      throw Error('Invalid authoritative ranking');
    used.add(row.externalId);
   }
   const ranked=[...result.ranked].sort((a,b)=>b.votes-a.votes||
     // Tie breaking is by stable PHOTO WALL registration number.
     Number(db.prepare('SELECT id FROM contest_entries WHERE contest_id=? AND external_id=?').get(c.id,a.externalId).id)-
     Number(db.prepare('SELECT id FROM contest_entries WHERE contest_id=? AND external_id=?').get(c.id,b.externalId).id));
   finalize(c,ranked);
  }catch(e){console.error('Waiting for central BALI contest results:',e.message);}
  finally{fetching=false;}
 }
 const interval=setInterval(()=>{try{tick();fetchAuthoritativeResults().catch(console.error)}catch(e){
  console.error('Contest schedule:',e.message)}},1500);interval.unref();
 tick();
}
