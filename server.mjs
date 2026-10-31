import express from 'express';
import {testContestSession,chooseContestEvent} from './contest-test.mjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {contestClock,minskDay,isContestDate,eligiblePartyDay,validContestTimeline,contestMandatoryTimes,contestVotingGate,queuedContestTicketAllowed} from './contest-clock.mjs';
import {BUTTON_DEFAULTS,normalizeButtons,publicButtons,buttonWindow} from './miniapp-controls.mjs';
import {screenArea,screenProfile,SCREEN_DEFAULTS} from './screen-profile.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Temporary contest pause: ordinary photo uploads remain operational.
const PHOTO_CONTEST_PAUSED=true;
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PHOTOS = path.join(DATA, 'photos');
const UPLOADS = path.join(DATA, 'temporary-uploads');
const THUMBS = path.join(DATA, 'thumbnails');
fs.mkdirSync(PHOTOS, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });

const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';
const SCREEN_PASSWORD = process.env.SCREEN_PASSWORD || '';
if (PASSWORD.length < 12 || PASSWORD.includes('CHANGE_') || SCREEN_PASSWORD.length < 12 || SCREEN_PASSWORD.includes('CHANGE_') || SECRET.length < 32 || SECRET.includes('CHANGE_')) {
  console.error('Set ADMIN_PASSWORD and SCREEN_PASSWORD (each 12+ chars) and SESSION_SECRET (32+ chars) in .env');
  process.exit(1);
}
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3100);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3100').replace(/\/+$/, '');
const retentionSetting = Number(process.env.RETENTION_DAYS || 7);
if (!Number.isFinite(retentionSetting) || !Number.isInteger(retentionSetting) || retentionSetting < 1 || retentionSetting > 90) {
  console.error('RETENTION_DAYS must be an integer from 1 to 90'); process.exit(1);
}
const RETENTION_DAYS = retentionSetting;
// 0 disables an artificial photo-count cap. Hardware capacity still applies.
const MAX_PHOTOS_PER_EVENT = Number(process.env.MAX_PHOTOS_PER_EVENT ?? 0);
// Guest photo caps were removed. Legacy .env MAX_PHOTOS_PER_GUEST is ignored.
const MIN_FREE_DISK_MB = Number(process.env.MIN_FREE_DISK_MB || 512);
const MAX_ACTIVE_UPLOADS = Number(process.env.MAX_ACTIVE_UPLOADS || 12);
const UPLOAD_REQUESTS_PER_HOUR = Number(process.env.UPLOAD_REQUESTS_PER_HOUR ?? 0);
if (!Number.isSafeInteger(MAX_PHOTOS_PER_EVENT) || MAX_PHOTOS_PER_EVENT < 0 || MAX_PHOTOS_PER_EVENT > 100000000 ||
    !Number.isSafeInteger(MIN_FREE_DISK_MB) || MIN_FREE_DISK_MB < 100 || MIN_FREE_DISK_MB > 100000 ||
    !Number.isSafeInteger(MAX_ACTIVE_UPLOADS) || MAX_ACTIVE_UPLOADS < 2 || MAX_ACTIVE_UPLOADS > 32 ||
    !Number.isSafeInteger(UPLOAD_REQUESTS_PER_HOUR) || UPLOAD_REQUESTS_PER_HOUR < 0 || UPLOAD_REQUESTS_PER_HOUR > 10000000) {
  console.error('Check MAX_PHOTOS_PER_EVENT (0-100000000), MIN_FREE_DISK_MB (100-100000), MAX_ACTIVE_UPLOADS (2-32), UPLOAD_REQUESTS_PER_HOUR (0-10000000)');
  process.exit(1);
}
const db = new Database(path.join(DATA, 'bali-photo-wall.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    filename TEXT NOT NULL UNIQUE,
    guest_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS photos_event_status ON photos(event_id, status, created_at);
  CREATE INDEX IF NOT EXISTS photos_guest_event ON photos(guest_id, event_id);
`);
if (!db.prepare('SELECT 1 FROM events LIMIT 1').get()) {
  db.prepare('INSERT INTO events (name,active,created_at) VALUES (?,1,?)').run('BALI PHOTO WALL', Date.now());
}
// Schema upgrades preserve photos and events from existing Windows installations.
const eventFields=db.pragma('table_info(events)').map(x=>x.name);
if(!eventFields.includes('upload_shape'))db.exec("ALTER TABLE events ADD COLUMN upload_shape TEXT NOT NULL DEFAULT 'any'");
const photoFields=db.pragma('table_info(photos)').map(x=>x.name);
if(!photoFields.includes('width'))db.exec('ALTER TABLE photos ADD COLUMN width INTEGER');
if(!photoFields.includes('height'))db.exec('ALTER TABLE photos ADD COLUMN height');
if(!photoFields.includes('screen_lane'))db.exec("ALTER TABLE photos ADD COLUMN screen_lane TEXT NOT NULL DEFAULT 'auto' CHECK(screen_lane IN ('auto','top','bottom'))");
if(!photoFields.includes('photo_area'))db.exec("ALTER TABLE photos ADD COLUMN photo_area TEXT NOT NULL DEFAULT 'general' CHECK(photo_area IN ('general','contest'))");
// Photo-contest state stays on THIS Windows/PHOTO WALL SQLite server.
db.exec(`
 CREATE TABLE IF NOT EXISTS contest_settings(
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  voting_open INTEGER NOT NULL DEFAULT 0 CHECK(voting_open IN (0,1)),
  updated_at INTEGER NOT NULL DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS contest_candidates(
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 70),
  category TEXT NOT NULL CHECK(category IN ('king','queen')),
  registered_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_contest_candidates_event ON contest_candidates(event_id);
 CREATE TABLE IF NOT EXISTS contest_telegram_entries(
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  bali_uid TEXT NOT NULL,
  bali_event_id TEXT NOT NULL,
  photo_id INTEGER NOT NULL UNIQUE REFERENCES photos(id) ON DELETE CASCADE,
  telegram_username TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (event_id,bali_uid)
 );
 CREATE INDEX IF NOT EXISTS idx_contest_telegram_entries_photo ON contest_telegram_entries(photo_id);
`);
// Preserve Telegram-signed display names independently of editable nomination labels.
const entryFields=db.pragma('table_info(contest_telegram_entries)').map(x=>x.name);
if(!entryFields.includes('telegram_display_name'))db.exec("ALTER TABLE contest_telegram_entries ADD COLUMN telegram_display_name TEXT NOT NULL DEFAULT ''");
if(!entryFields.includes('bali_card_number'))db.exec("ALTER TABLE contest_telegram_entries ADD COLUMN bali_card_number TEXT NOT NULL DEFAULT ''");
if(!entryFields.includes('telegram_provider_id'))db.exec("ALTER TABLE contest_telegram_entries ADD COLUMN telegram_provider_id TEXT NOT NULL DEFAULT ''");

// Keep all historic contest photos separate, including pending and rejected.
db.exec("UPDATE photos SET photo_area='contest' WHERE photo_area='general' AND id IN (SELECT photo_id FROM contest_candidates)");
db.exec("CREATE INDEX IF NOT EXISTS idx_photos_area_status ON photos(event_id,photo_area,status,created_at)");
db.exec(`CREATE TABLE IF NOT EXISTS screen_profiles(
 area TEXT PRIMARY KEY CHECK(area IN ('general','contest')),
 settings_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS miniapp_button_settings(
 id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
)`);
const miniappRow=()=>db.prepare('SELECT settings_json,revision FROM miniapp_button_settings WHERE id=1').get();
function miniappSnapshot(){
 const row=miniappRow();
 let settings=BUTTON_DEFAULTS;
 if(row)try{settings=normalizeButtons(JSON.parse(row.settings_json));}
 catch(error){console.error('Mini App button configuration:',error.message);}
 return {settings,revision:row?.revision||0,current:publicButtons(settings)};
}
const profileRow=db.prepare('SELECT settings_json,revision,updated_at FROM screen_profiles WHERE area=?');
const screenLogoFile=area=>path.join(DATA,'screen-logo-'+area+'.webp');
function screenProfileData(area){
 const row=profileRow.get(area);
 let settings=SCREEN_DEFAULTS;
 if(row){try{settings=screenProfile(JSON.parse(row.settings_json));}catch(error){
   console.error('Invalid saved screen profile:',area,error.message);}}
 let logoRevision=0;
 try{logoRevision=Math.floor(fs.statSync(screenLogoFile(area)).mtimeMs);}catch{}
 return {ok:true,area,settings,revision:row?.revision||0,logoRevision};
}
const clockFields=db.pragma('table_info(contest_settings)').map(x=>x.name);
for(const [name,definition] of [
 ['test_session_id',"TEXT NOT NULL DEFAULT ''"],
 ['contest_date',"TEXT NOT NULL DEFAULT ''"],
 ['voting_start',"TEXT NOT NULL DEFAULT '03:00'"],
 ['voting_end',"TEXT NOT NULL DEFAULT '04:00'"],
 ['bali_event_id',"TEXT NOT NULL DEFAULT ''"],
 ['winner_photo_id','INTEGER'],
 ['winner_votes','INTEGER NOT NULL DEFAULT 0'],
 ['total_votes','INTEGER NOT NULL DEFAULT 0'],
 ['finalized_at','INTEGER'],
 ['registration_opens_at',"TEXT NOT NULL DEFAULT ''"],
 ['registration_ends_at',"TEXT NOT NULL DEFAULT ''"],
 ['voting_starts_at',"TEXT NOT NULL DEFAULT ''"],
 ['voting_ends_at',"TEXT NOT NULL DEFAULT ''"],
 ['results_at',"TEXT NOT NULL DEFAULT ''"]
])if(!clockFields.includes(name))db.exec('ALTER TABLE contest_settings ADD COLUMN '+name+' '+definition);
// Legacy untouched competitions used to end at 06:00. New BALI default
// is 03:00-04:00; preserve any manually edited event (updated_at > 0).
db.prepare("UPDATE contest_settings SET voting_end='04:00' WHERE voting_end='06:00' AND voting_starts_at='' AND updated_at=0").run();
const contestRow=id=>db.prepare('SELECT * FROM contest_settings WHERE event_id=?').get(id);
const contestSettings=id=>contestRow(id)||{
 event_id:id,enabled:0,voting_open:0,contest_date:minskDay(Date.now()+86400000),
 voting_start:'03:00',voting_end:'04:00',bali_event_id:'',
 winner_photo_id:null,winner_votes:0,total_votes:0,finalized_at:null
};
const eligibleCandidates=id=>db.prepare("SELECT c.photo_id AS photoId,c.name,c.category,c.registered_at AS registeredAt,p.status FROM contest_candidates c JOIN photos p ON p.id=c.photo_id AND p.event_id=c.event_id WHERE c.event_id=? AND p.photo_area='contest' AND p.status='approved' ORDER BY c.registered_at,c.photo_id LIMIT 300").all(id);

// Preserve immutable top-three snapshots across weekly competition cycles.
db.exec(`CREATE TABLE IF NOT EXISTS contest_podium (
 event_id INTEGER PRIMARY KEY REFERENCES events(id),
 target_places INTEGER NOT NULL,
 winners_json TEXT NOT NULL,
 finalized_at INTEGER NOT NULL
)`);
const contestPodium=id=>{
 const row=db.prepare('SELECT target_places,winners_json,finalized_at FROM contest_podium WHERE event_id=?').get(id);
 if(!row)return null;
 try{return {places:row.target_places,winners:JSON.parse(row.winners_json),finalizedAt:row.finalized_at}}
 catch{return {places:row.target_places,winners:[],finalizedAt:row.finalized_at}}
};
// Upgrade old finalized single-winner events into the new archive without
// modifying their historic vote counts or inventing other podium places.
for(const legacy of db.prepare(`SELECT s.event_id AS eventId,s.winner_photo_id AS photoId,
 s.winner_votes AS votes,s.finalized_at AS finalizedAt
 FROM contest_settings s WHERE s.finalized_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM contest_podium p WHERE p.event_id=s.event_id)`).all()){
 const candidate=legacy.photoId?db.prepare(
  'SELECT name FROM contest_candidates WHERE event_id=? AND photo_id=?'
 ).get(legacy.eventId,legacy.photoId):null;
 const username=legacy.photoId?db.prepare(
  'SELECT telegram_username AS username,telegram_display_name AS telegramName FROM contest_telegram_entries WHERE photo_id=?'
 ).get(legacy.photoId):null;
 const winners=candidate?[{id:legacy.photoId,name:username?.telegramName||candidate.name,place:1,
  submittedName:candidate.name,telegramName:username?.telegramName||null,
  votes:Number(legacy.votes)||0,telegramUsername:username?.username||null}]:[];
 db.prepare('INSERT OR IGNORE INTO contest_podium(event_id,target_places,winners_json,finalized_at) VALUES(?,?,?,?)')
  .run(legacy.eventId,1,JSON.stringify(winners),legacy.finalizedAt);
}
const reservedWinnerPhotoIds=()=>{
 const result=new Set();
 for(const row of db.prepare('SELECT winners_json FROM contest_podium').all()){
  try{
   for(const w of JSON.parse(row.winners_json)){
    if(Number.isSafeInteger(w.id)&&w.id>0)result.add(w.id);
   }
  }catch{}
 }
 return result;
};
const telegramContestMatches=(control,event,settings)=>{
 if(!control||!event||!settings)return false;
 if(control.resultContestId)return control.resultContestId==='event_'+event.id;
 const session=control.current?.session||control.session;
 const date=session?.eventId||session?.date||'';
 return !!date&&(!settings.bali_event_id||settings.bali_event_id===date)&&
  eligiblePartyDay(date,settings.contest_date);
};
/* Read-only Telegram Admin schedule. This supersedes Windows button clocks
   but never changes Windows event/candidate/photo data. */
let telegramSchedule={expires:0,value:null,pending:null,lastGoodAt:0,lastWarningAt:0};
async function telegramPhotoSchedule(){
 // Only isolated local smoke fixtures may bypass the real Telegram authority.
 // This never runs on a production Windows server.
 if(process.env.PHOTO_WALL_OFFLINE_LEGACY_FIXTURE==='1' &&
    process.env.ALLOW_LEGACY_EVENT_CONTROL==='1' &&
    process.env.NODE_ENV!=='production')return null;
 if(Date.now()<telegramSchedule.expires)return telegramSchedule.value;
 if(telegramSchedule.pending)return telegramSchedule.pending;
 telegramSchedule.pending=(async()=>{
  try{
   const response=await fetch('https://app.baliminsk.by/api/tg-bali/photo-controls',{
    headers:{Accept:'application/json'},redirect:'manual',
    signal:AbortSignal.timeout(4500)});
   const value=await response.json().catch(()=>null);
   if(!response.ok||value?.ok!==true||!value?.buttons?.vote||!value?.buttons?.registration)
    throw Error('Telegram Admin schedule unavailable');
   telegramSchedule.value=value;
   telegramSchedule.lastGoodAt=Date.now();
   telegramSchedule.expires=Date.now()+5000;
  }catch(error){
   const now=Date.now();
   // Temporary 5-second upstream timeouts must NOT clear the active
   // broadcast, which would make the moderator see the wrong event
   // and remove the winner mosaic from the club screen.
   // The grace period is bounded: after 120s fail closed and do not
   // accept new operations based on stale Telegram instructions.
   if(!telegramSchedule.lastGoodAt||now-telegramSchedule.lastGoodAt>120000)
    telegramSchedule.value=null;
   telegramSchedule.expires=now+5000;
   if(now-telegramSchedule.lastWarningAt>60000){
    telegramSchedule.lastWarningAt=now;
    console.warn('Telegram Admin synchronization delayed:',error.message);
   }
  }finally{telegramSchedule.pending=null}
  return telegramSchedule.value;
 })();
 return telegramSchedule.pending;
}

/* One Telegram broadcast action = one durable folder; never create a folder
   on a browser refresh, process restart or mere timetable edit. */
let activeBroadcast=null,broadcastSyncPending=null;
db.exec(`CREATE TABLE IF NOT EXISTS managed_broadcast_runs(
 run_id TEXT PRIMARY KEY,folder TEXT NOT NULL UNIQUE,
 general_event_id INTEGER NOT NULL REFERENCES events(id),
 contest_event_id INTEGER NOT NULL REFERENCES events(id),
 event_date TEXT NOT NULL,created_at_ms INTEGER NOT NULL);`);
// A cancellation is not complete until PHOTO WALL has removed every related
// nomination, media file and contest event. Keep a durable deletion manifest
// to retry interrupted disk operations after a Windows restart.
db.exec(`CREATE TABLE IF NOT EXISTS managed_broadcast_cancellations(
 run_id TEXT PRIMARY KEY,files_json TEXT NOT NULL,
 folder TEXT NOT NULL,contest_event_id INTEGER,requested_at_ms INTEGER NOT NULL,finished_at_ms INTEGER
)`);
async function deleteCancelledBroadcast(runId){
 if(!/^[a-f0-9-]{36}$/.test(runId||''))return;
 let record=db.prepare('SELECT * FROM managed_broadcast_cancellations WHERE run_id=?').get(runId);
 if(record?.finished_at_ms)return;
 if(!record){
  const run=db.prepare('SELECT * FROM managed_broadcast_runs WHERE run_id=?').get(runId);
  db.transaction(()=>{
   if(db.prepare('SELECT 1 FROM managed_broadcast_cancellations WHERE run_id=?').get(runId))return;
   const filenames=run?db.prepare('SELECT filename FROM photos WHERE event_id=? AND photo_area=\'contest\'')
     .all(run.contest_event_id).map(x=>x.filename):[];
   db.prepare('INSERT INTO managed_broadcast_cancellations(run_id,files_json,folder,contest_event_id,requested_at_ms) VALUES(?,?,?,?,?)')
    .run(runId,JSON.stringify(filenames),run?.folder||'',run?.contest_event_id||null,Date.now());
   if(!run)return;
   db.prepare('DELETE FROM contest_photo_replacements WHERE event_id=?').run(run.contest_event_id);
   // A cancelled result has no permanent podium. Remove its FK first.
   db.prepare('DELETE FROM contest_podium WHERE event_id=?').run(run.contest_event_id);
   // photos cascade into contest_candidates and contest_telegram_entries.
   db.prepare("DELETE FROM photos WHERE event_id=? AND photo_area='contest'").run(run.contest_event_id);
   db.prepare('DELETE FROM managed_broadcast_runs WHERE run_id=?').run(runId);
   // Ordinary guest photo-wall event and its images remain in the archive.
   db.prepare('DELETE FROM events WHERE id=?').run(run.contest_event_id);
  })();
  record=db.prepare('SELECT * FROM managed_broadcast_cancellations WHERE run_id=?').get(runId);
 }
 const filenames=JSON.parse(record.files_json);
 for(const name of filenames){
  for(const root of [PHOTOS,THUMBS])
   await fsp.rm(path.join(root,name),{force:true,recursive:true,maxRetries:12,retryDelay:250});
 }
 // Do not remove the run folder: it also contains ordinary PHOTO WALL photos.
 // Those images follow their independent retention policy.
 db.prepare('UPDATE managed_broadcast_cancellations SET finished_at_ms=? WHERE run_id=? AND finished_at_ms IS NULL')
  .run(Date.now(),runId);
}
async function synchronizeBroadcast(){
 if(broadcastSyncPending)return broadcastSyncPending;
 broadcastSyncPending=(async()=>{
  const policy=await telegramPhotoSchedule(),intent=policy?.broadcast;
  if(intent?.cancelRunId){
   activeBroadcast=null;
   await deleteCancelledBroadcast(intent.cancelRunId);
  }
  if(PHOTO_CONTEST_PAUSED||!intent?.active||!/^[a-f0-9-]{36}$/.test(intent.runId||'')){
   activeBroadcast=null;ensureStandaloneGeneralEvent();return null;
  }
  if(activeBroadcast?.runId===intent.runId)return activeBroadcast;
  let saved=db.prepare('SELECT * FROM managed_broadcast_runs WHERE run_id=?').get(intent.runId);
  if(!saved){
   const time=Number(intent.startsAtMs)||Date.now();
   const folder='broadcast-'+new Date(time+10800000).toISOString().slice(0,19)
    .replace(/[-:T]/g,'')+'-'+intent.runId.replaceAll('-','').slice(0,10);
   for(const base of [PHOTOS,THUMBS])
    fs.mkdirSync(path.join(base,'streams',folder),{recursive:true});
   const selected=policy.session?.date||'';
   const partyDate=/^\d{4}-\d{2}-\d{2}$/.test(selected)?
    selected:new Date(time+10800000).toISOString().slice(0,10);
   const nextDay=new Date(Date.parse(partyDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
   db.transaction(()=>{
    const existing=db.prepare('SELECT * FROM managed_broadcast_runs WHERE run_id=?').get(intent.runId);
    if(existing){saved=existing;return}
    const now=Date.now();
    db.prepare('UPDATE events SET active=0').run();
    // A new royal contest in the same club night must NOT reset the
    // independent ordinary PHOTO WALL mosaic. Reuse the nightly gallery.
    const generalName='BALI PHOTO WALL · '+partyDate;
    const existingGeneral=db.prepare('SELECT id FROM events WHERE name=? ORDER BY id DESC LIMIT 1').get(generalName);
    const generalId=existingGeneral?Number(existingGeneral.id):
     Number(db.prepare('INSERT INTO events(name,active,created_at) VALUES(?,1,?)')
      .run(generalName,now).lastInsertRowid);
    if(existingGeneral)db.prepare('UPDATE events SET active=1 WHERE id=?').run(generalId);
    const contestId=Number(db.prepare('INSERT INTO events(name,active,created_at) VALUES(?,0,?)')
     .run('КОРОЛЬ / КОРОЛЕВА · '+partyDate,now).lastInsertRowid);
    db.prepare("INSERT INTO contest_settings(event_id,enabled,voting_open,contest_date,voting_start,voting_end,bali_event_id,updated_at) VALUES(?,1,0,?,'03:00','04:00',?,?)")
     .run(contestId,nextDay,partyDate,now);
    db.prepare('INSERT INTO managed_broadcast_runs(run_id,folder,general_event_id,contest_event_id,event_date,created_at_ms) VALUES(?,?,?,?,?,?)')
     .run(intent.runId,folder,generalId,contestId,partyDate,now);
    saved=db.prepare('SELECT * FROM managed_broadcast_runs WHERE run_id=?').get(intent.runId);
   })();
  }
  activeBroadcast={runId:intent.runId,folder:saved.folder,
   generalEventId:saved.general_event_id,contestEventId:saved.contest_event_id,
   eventDate:saved.event_date};
  if(db.prepare('SELECT active FROM events WHERE id=?').get(saved.general_event_id)?.active!==1)
   db.transaction(()=>{db.prepare('UPDATE events SET active=0').run();
    db.prepare('UPDATE events SET active=1 WHERE id=?').run(saved.general_event_id)})();
  return activeBroadcast;
 })().finally(()=>{broadcastSyncPending=null});
 return broadcastSyncPending;
}
function runFilename(eventId){
 const current=activeBroadcast,name=crypto.randomUUID()+'.webp';
 return current&&[current.generalEventId,current.contestEventId].includes(Number(eventId))?
  'streams/'+current.folder+'/'+name:name;
}
async function ensurePhotoFolders(filename){
 const folder=path.dirname(filename);
 await Promise.all([fsp.mkdir(path.join(PHOTOS,folder),{recursive:true}),
  fsp.mkdir(path.join(THUMBS,folder),{recursive:true})]);
}
// A newly saved Telegram Admin competition becomes its own PHOTO WALL event.
// Never reuse or alter the general photo wall event, and never duplicate a day.
let syncContestPending=null;
async function ensureTelegramContest(){
 if(PHOTO_CONTEST_PAUSED)return;

 if(syncContestPending)return syncContestPending;
 syncContestPending=(async()=>{
  const policy=await telegramPhotoSchedule(),session=policy?.current?.session||policy?.session;
  const testSession=testContestSession(policy);
  if(policy?.broadcast){
   await synchronizeBroadcast();
   if(!testSession)return; // Only explicit Telegram Admin runs may create competitions.
  }
  if(testSession){
   if(!db.prepare('SELECT 1 FROM contest_settings WHERE test_session_id=?').get(testSession.testSessionId)){
    db.transaction(()=>{
     const now=Date.now(),date=testSession.date;
     const id=db.prepare('INSERT INTO events(name,active,created_at) VALUES(?,0,?)').run('ТЕСТ КОНКУРСА BALI',now).lastInsertRowid;
     db.prepare("INSERT INTO contest_settings(event_id,enabled,voting_open,contest_date,voting_start,voting_end,bali_event_id,test_session_id,updated_at) VALUES(?,1,0,?,'03:00','04:00',?,?,?)")
      .run(id,date,testSession.eventId,testSession.testSessionId,now);
    })();
   }
   return;
  }
  if(!session||!/\d{4}-\d{2}-\d{2}$/.test(session.date||'')||
     !String(session.partyName||'').trim()||!String(session.contestName||'').trim())return;
  const partyDate=session.date;
  const nextDay=new Date(Date.parse(partyDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const resultDate=Number.isSafeInteger(policy.resultAtMs)?
   new Date(policy.resultAtMs+10800000).toISOString().slice(0,10):'';
  const contestDate=[partyDate,nextDay].includes(resultDate)?resultDate:nextDay;
  db.transaction(()=>{
   if(db.prepare("SELECT 1 FROM contest_settings WHERE bali_event_id=? AND test_session_id='' LIMIT 1").get(partyDate))return;
   // Adopt a single already configured unbound event instead of silently
   // abandoning its existing contestants when Telegram Admin names are saved.
   const eligible=db.prepare("SELECT event_id,contest_date FROM contest_settings WHERE enabled=1 AND bali_event_id='' AND finalized_at IS NULL")
    .all().filter(x=>eligiblePartyDay(partyDate,x.contest_date));
   if(eligible.length===1){
    const otherDates=db.prepare('SELECT DISTINCT bali_event_id AS d FROM contest_telegram_entries WHERE event_id=?')
     .all(eligible[0].event_id);
    if(otherDates.every(x=>x.d===partyDate)){
     db.prepare('UPDATE contest_settings SET bali_event_id=?,updated_at=? WHERE event_id=?')
      .run(partyDate,Date.now(),eligible[0].event_id);
     console.log('PHOTO WALL: linked existing contest',eligible[0].event_id,partyDate);
     return;
    }
   }
   const name=(String(session.partyName).trim()+' · '+String(session.contestName).trim()).slice(0,90);
   const id=db.prepare('INSERT INTO events(name,active,created_at) VALUES(?,0,?)').run(name,Date.now()).lastInsertRowid;
   db.prepare("INSERT INTO contest_settings(event_id,enabled,voting_open,contest_date,voting_start,voting_end,bali_event_id,updated_at) VALUES(?,1,0,?,'03:00','04:00',?,?)")
    .run(id,contestDate,partyDate,Date.now());
   console.log('PHOTO WALL: created Telegram-linked competition',id,partyDate);
  })();
 })().catch(error=>console.warn('Telegram competition sync:',error.message))
  .finally(()=>{syncContestPending=null});
 return syncContestPending;
}
let finalizing=null,lastTallyError='',lastTallyAttempt=0;
async function finalizeContest(){
 if(PHOTO_CONTEST_PAUSED)return;

 if(finalizing)return finalizing;
 const event=currentContestEvent.get();
 if(!event)return;
 const settings=contestRow(event.id);
 if(!settings||settings.enabled!==1||settings.finalized_at)return;
 const telegram=await telegramPhotoSchedule();
 if(!telegramContestMatches(telegram,event,settings)||
    !Number.isSafeInteger(telegram.resultAtMs)||Date.now()<telegram.resultAtMs)return;
 if(Date.now()-lastTallyAttempt<3000)return;
 lastTallyAttempt=Date.now();
 finalizing=(async()=>{
  const contestId='event_'+event.id;
  const uri='https://app.baliminsk.by/api/tg-bali/photo-contest-tally-feed?contestId='+encodeURIComponent(contestId);
  const response=await fetch(uri,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(6500)});
  if(!response.ok)throw Error('BALI vote tally HTTP '+response.status);
  const tally=await response.json();
  if(tally?.ok!==true||tally.contestId!==contestId||!Array.isArray(tally.candidates))
   throw Error('BALI vote tally mismatch');
  const candidates=eligibleCandidates(event.id),count=new Map();
  for(const row of tally.candidates){
   if(!/^p_[1-9][0-9]{0,9}$/.test(row.id||'')||
      !Number.isSafeInteger(row.votes)||row.votes<0||row.votes>10000000||count.has(row.id))
     throw Error('Invalid BALI vote tally');
   count.set(row.id,row.votes);
  }
  const ranked=candidates.map(c=>({...c,votes:count.get('p_'+c.photoId)||0}))
   .sort((a,b)=>b.votes-a.votes||a.registeredAt-b.registeredAt||a.photoId-b.photoId);
  const total=ranked.reduce((n,c)=>n+c.votes,0);
  if(!Number.isSafeInteger(tally.total)||tally.total<total)
   throw Error('Vote tally response is inconsistent');
  // A moderator may disqualify/remove an approved photo after ballots.
  // Such votes are excluded from ranking, not silently awarded elsewhere.
  if(tally.total>total)console.warn('Contest ballot exclusions:',tally.total-total);
  const places=telegram.winnerCount===3?3:1;
  const winners=(ranked[0]?.votes>0?ranked.slice(0,places):[]).map((c,index)=>{
   const nomination=db.prepare('SELECT telegram_username AS username,telegram_display_name AS telegramName FROM contest_telegram_entries WHERE photo_id=?').get(c.photoId);
   return {id:c.photoId,name:nomination?.telegramName||c.name,submittedName:c.name,
    votes:c.votes,place:index+1,telegramUsername:nomination?.username||null,
    telegramName:nomination?.telegramName||null};
  });
  const winner=winners[0]||null,now=Date.now();
  db.transaction(()=>{
   db.prepare('INSERT OR IGNORE INTO contest_podium(event_id,target_places,winners_json,finalized_at) VALUES(?,?,?,?)')
    .run(event.id,places,JSON.stringify(winners),now);
   db.prepare('UPDATE contest_settings SET winner_photo_id=?,winner_votes=?,total_votes=?,finalized_at=?,voting_open=0,updated_at=? WHERE event_id=? AND finalized_at IS NULL')
    .run(winner?.id||null,winner?.votes||0,total,now,now,event.id);
  })();
  lastTallyError='';
 })().catch(error=>{lastTallyError=String(error.message||error);console.error('Contest tally retry:',lastTallyError)})
  .finally(()=>{finalizing=null});
 return finalizing;
}
const currentEvent = db.prepare('SELECT id,name,upload_shape FROM events WHERE active=1 ORDER BY id DESC LIMIT 1');
function ensureStandaloneGeneralEvent(){
 const active=currentEvent.get();
 if(active)return active;
 const day=new Date(Date.now()+10800000).toISOString().slice(0,10);
 const name='BALI PHOTO WALL · '+day;
 const old=db.prepare('SELECT id FROM events WHERE name=? ORDER BY id DESC LIMIT 1').get(name);
 if(old)db.prepare('UPDATE events SET active=1 WHERE id=?').run(old.id);
 else db.prepare("INSERT INTO events(name,active,created_at) VALUES(?,1,?)").run(name,Date.now());
 return currentEvent.get();
}

// The royal contest selected by the Windows moderator need not be the
// current GENERAL photo-wall event. Enabled/saved contest settings win.
const recentContestEvents=db.prepare(
 'SELECT e.id,e.name,e.upload_shape FROM events e '+
 "JOIN contest_settings s ON s.event_id=e.id WHERE s.enabled=1 AND s.test_session_id='' "+
 'ORDER BY s.updated_at DESC,e.id DESC LIMIT 40'
);
const currentContestEvent={get(){
 // Telegram Admin's explicit rehearsal works without a public live broadcast.
 const test=testContestSession(telegramSchedule.value);
 if(test)return db.prepare('SELECT e.id,e.name,e.upload_shape FROM events e JOIN contest_settings s ON s.event_id=e.id WHERE s.test_session_id=? AND s.enabled=1').get(test.testSessionId)||null;
 // Telegram Admin is the time authority; old Windows clocks cannot override it.
 if(telegramSchedule.value?.broadcast){
  if(!telegramSchedule.value.broadcast.active||!activeBroadcast)return null;
  return db.prepare('SELECT id,name,upload_shape FROM events WHERE id=?').get(activeBroadcast.contestEventId)||null;
 }
 const choices=recentContestEvents.all();
 return chooseContestEvent(choices,telegramSchedule.value,contestSettings)||
  (testContestSession(telegramSchedule.value)?null:currentEvent.get());
}};
const selectPhoto = db.prepare('SELECT * FROM photos WHERE id=?');
const secureEqual = (a, b) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Scope every signed cookie to its purpose. A screen token MUST never grant
// admin access even if copied or renamed to "bali_admin".
const PURPOSES = Object.freeze({bali_guest:'guest',bali_screen:'screen',bali_admin:'admin'});
const mac = (value,purpose) => crypto.createHmac('sha256', SECRET)
  .update('bali-photo-wall:v2:' + purpose + ':' + value).digest('base64url');
const signed = (value,purpose) => value + '.' + mac(value,purpose);
function checked(value,purpose) {
  if (!value || !Object.values(PURPOSES).includes(purpose)) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const data = value.slice(0, dot);
  return secureEqual(mac(data,purpose), value.slice(dot + 1)) ? data : null;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      try { out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim()); } catch {}
    }
  }
  return out;
}
function cookieOptions(req, maxAge) {
  const host = String(req.headers.host || '').toLowerCase();
  const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) || /^\[::1\](?::\d+)?$/.test(host);
  // Keep HTTPS cookies Secure on the public domain while allowing a
  // localhost-only operator session on the club's own computer.
  return { httpOnly: true, secure: req.secure || (!localHost && process.env.NODE_ENV === 'production'), sameSite: 'strict', path: '/', maxAge };
}
function guestIdentity(req, res) {
  const id = checked(cookies(req).bali_guest,PURPOSES.bali_guest);
  if (id && /^[a-f0-9-]{36}$/.test(id)) return id;
  const fresh = crypto.randomUUID();
  res.cookie('bali_guest', signed(fresh,PURPOSES.bali_guest), cookieOptions(req, 30 * 86400000));
  return fresh;
}
function validSession(req, name) {
  const raw = checked(cookies(req)[name],PURPOSES[name]);
  const expires = Number(raw);
  return Boolean(raw && Number.isSafeInteger(expires) && expires >= Date.now());
}
function adminAuth(req, res, next) {
  if (!validSession(req,'bali_admin')) return res.status(401).json({ error: 'Требуется вход сотрудника' });
  next();
}
function screenAuth(req, res, next) {
  if (!validSession(req,'bali_screen') && !validSession(req,'bali_admin')) return res.status(401).json({ error: 'Требуется вход оператора экрана' });
  next();
}
function verifyPassword(supplied, stored) {
  return typeof supplied === 'string' && secureEqual(
    crypto.createHash('sha256').update(supplied).digest('hex'),
    crypto.createHash('sha256').update(stored).digest('hex')
  );
}
function requireAction(req, res, next) {
  if (req.get('X-BALI-Action') !== '1') return res.status(403).json({ error: 'Запрос отклонён' });
  next();
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res)).catch(next); }
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
// A fresh nonce authorizes only the server's own inline page assets.
app.use((req,res,next)=>{res.locals.pageNonce=crypto.randomBytes(16).toString('base64');next();});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'",(req,res)=>"'nonce-"+res.locals.pageNonce+"'"], scriptSrc: ["'self'",(req,res)=>"'nonce-"+res.locals.pageNonce+"'"],
      connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      baseUri: ["'self'"], formAction: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api', (_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
app.use(express.static(path.join(ROOT, 'public'), { index: false, dotfiles: 'deny', maxAge: '15m' }));

// Browsers on the venue's network occasionally receive the HTML but not its
// static CSS/JS/logo (plain unstyled white screens). The served HTML is now
// self-contained. Existing static URLs remain for compatibility and debugging.
const PAGE_ASSETS=new Map([
 ['guest',{file:'guest.html',css:['style.css','guest-compact.css'],js:['crop.js','guest.js']}],
 ['admin',{file:'admin.html',css:['style.css','admin-compact.css','areas.css'],js:['app.js']}],
 ['screen',{file:'screen.html',css:['style.css','screen-broadcast.css','showcase-wall.css'],
   js:['mosaic.js','carousel.js','carousel-wall.js','live-mosaic.js','live-wall.js','showcase-wall.js','app.js']}]
]);
const pageCache=new Map();
const pageAssetDir=path.join(ROOT,'public');
const escapeHtmlPayload=(value,tag)=>value.replace(new RegExp('</'+tag,'gi'),'<\\/'+tag);
function pageTemplate(page){
 if(pageCache.has(page))return pageCache.get(page);
 const config=PAGE_ASSETS.get(page);
 if(!config)throw Error('Unknown PHOTO WALL page');
 let html=fs.readFileSync(path.join(pageAssetDir,config.file),'utf8');
 const orderedStyles=config.css.map(file=>fs.readFileSync(path.join(pageAssetDir,file),'utf8'));
 const orderedScripts=config.js.map(file=>fs.readFileSync(path.join(pageAssetDir,file),'utf8'));
 const logo=fs.readFileSync(path.join(pageAssetDir,'bali-logo.svg')).toString('base64');
 // Remove dependency on loading the logo over a second HTTP request.
 html=html.replaceAll('src="/bali-logo.svg"','src="data:image/svg+xml;base64,'+logo+'"');
 // Include the styles/scripts inside the document, while preserving ordering.
 html=html.replace(/<link\s+rel="stylesheet"\s+href="\/[^"]+"\s*\/?\s*>/g,'');
 html=html.replace(/<script\s+defer\s+src="\/[^"]+"\s*><\/script>/g,'');
 const styles=orderedStyles.map(content=>'<style nonce="__BALI_PAGE_NONCE__">\n'+
   escapeHtmlPayload(content,'style')+'\n</style>').join('\n');
 const scripts=orderedScripts.map(content=>'<script nonce="__BALI_PAGE_NONCE__">\n'+
   escapeHtmlPayload(content,'script')+'\n</script>').join('\n');
 html=html.replace('</head>',styles+'\n</head>');
 // App scripts need the body DOM already parsed: the original script tags had defer.
 html=html.replace('</body>',scripts+'\n</body>');
 const template=page==='screen'?{html,qr:true}:{html,qr:false};
 pageCache.set(page,template);
 return template;
}
async function serveBaliPage(req,res,page){
 try{
  const template=pageTemplate(page);
  let html=template.html;
  if(template.qr){
   const svg=await QRCode.toString(PUBLIC_URL.replace(/\/$/,'')+'/upload',
    {type:'svg',margin:1,width:320,color:{dark:'#111111',light:'#ffffff'}});
   html=html.replaceAll('src="/qr.svg"','src="data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')+'"');
  }
  html=html.replaceAll('__BALI_PAGE_NONCE__',res.locals.pageNonce);
  res.set('Cache-Control','no-store').type('html').send(html);
 }catch(error){
  console.error('PHOTO WALL page assets unavailable:',page,error);
  res.status(503).type('text').send('PHOTO WALL: файлы страницы не найдены. Проверьте обновление Windows.');
 }
}

// Give guests a dedicated permanent URL independent of the root landing page.
// Both addresses serve the SAME common-wall upload flow, never the contest form.
function guestUploadPage(req,res){
 guestIdentity(req,res);
 res.set('Cache-Control','no-store');
 return serveBaliPage(req,res,'guest');
}
app.get('/',(req,res)=>res.set('Cache-Control','no-store').redirect(302,'/upload'));
app.get('/upload',guestUploadPage);
app.get('/admin', (_req,res) => res.redirect(302,'/admin/general'));
app.get('/admin/general', (req,res) => serveBaliPage(req,res,'admin'));
app.get('/admin/contest', (req,res) => serveBaliPage(req,res,'admin'));
app.get('/screen', (req,res) => serveBaliPage(req,res,'screen'));
app.get('/live',(_req,res)=>res.redirect(302,'/screen'));
app.get('/operator',(_req,res)=>res.redirect(302,'/control/general'));
app.get('/control',(_req,res)=>res.redirect(302,'/control/general'));
for(const area of ['general','contest']){
 app.get('/live/'+area,(_req,res)=>res.redirect(302,'/screen'));
 app.get('/control/'+area,(req,res)=>{
   if(!validSession(req,'bali_admin'))return res.redirect(302,'/admin/'+area);
   serveBaliPage(req,res,'screen');
 });
}
// Telegram Admin is the ONLY normal control room. The Windows service
// handles moderation through a short-lived, action-bound Google-admin proof.
db.exec(`CREATE TABLE IF NOT EXISTS contest_moderation_nonces(
 nonce TEXT PRIMARY KEY,used_at_ms INTEGER NOT NULL
)`);
app.post('/api/operator/contest-moderation',asyncRoute(async(req,res)=>{
 if(PHOTO_CONTEST_PAUSED)return res.status(410).json({error:'Фотоконкурсы временно отключены'});
 const payload=req.body||{},auth=String(req.headers.authorization||'');
 if(!/^Bearer [A-Za-z0-9_.-]{40,1500}$/.test(auth)||req.get('Content-Type')?.split(';')[0]!=='application/json')
  return res.status(403).json({error:'Требуется подтверждение Telegram Admin'});
 const {runId,action,photoId=0,page=1,status='pending'}=payload;
 if(!/^[a-f0-9-]{36}$/.test(runId||'')||!['list','approve','reject','reset'].includes(action)||
   !Number.isSafeInteger(photoId)||photoId<0||!Number.isSafeInteger(page)||page<1||page>10000||
   !['pending','approved','rejected'].includes(status))
  return res.status(400).json({error:'Неверное действие модерации'});
 let proof;
 try{
  const response=await fetch('https://app.baliminsk.by/api/tg-bali/photo-contest-moderation-proof',{
   method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',
   body:JSON.stringify({proof:auth.slice(7),runId,action,photoId,page,status}),
   signal:AbortSignal.timeout(5000)});
  proof=response.ok?await response.json():null;
 }catch{}
 if(proof?.ok!==true||!/^[a-f0-9-]{36}$/.test(proof.nonce||''))
  return res.status(403).json({error:'Подтверждение администратора недействительно'});
 await synchronizeBroadcast();
 if(!activeBroadcast||activeBroadcast.runId!==runId)
  return res.status(409).json({error:'Конкурс уже изменён или завершён'});
 const eventId=activeBroadcast.contestEventId;
 if(action==='list'){
  const counts=db.prepare("SELECT status,COUNT(*) AS n FROM photos WHERE event_id=? AND photo_area='contest' GROUP BY status")
   .all(eventId);
  const count=Object.fromEntries(['pending','approved','rejected'].map(s=>[s,Number(counts.find(r=>r.status===s)?.n)||0]));
  const photos=db.prepare("SELECT p.id,p.status,p.filename,t.telegram_username AS username,t.telegram_display_name AS name,"+
   "t.bali_card_number AS cardNumber,t.telegram_provider_id AS telegramId FROM photos p "+
   "JOIN contest_telegram_entries t ON t.photo_id=p.id AND t.event_id=p.event_id "+
   "WHERE p.event_id=? AND p.photo_area='contest' AND p.status=? "+
   "ORDER BY p.created_at DESC,p.id DESC LIMIT 12 OFFSET ?").all(eventId,status,(page-1)*12);
  const items=await Promise.all(photos.map(async item=>{
   let thumbnailData='';
   try{
    const file=fs.existsSync(path.join(THUMBS,item.filename))?
     path.join(THUMBS,item.filename):path.join(PHOTOS,item.filename);
    // Read and close the Windows file handle before Sharp touches the
    // pixels; an open image decoder can otherwise block photo deletion.
    const bytes=await fsp.readFile(file);
    const resized=await sharp(bytes).resize({width:180,height:180,fit:'inside',withoutEnlargement:true})
     .webp({quality:55}).toBuffer();
    if(resized.length<45000)thumbnailData='data:image/webp;base64,'+resized.toString('base64');
   }catch{}
   return {id:item.id,status:item.status,name:item.name,username:item.username,
    cardNumber:item.cardNumber,telegramId:item.telegramId,thumbnailData};
  }));
  return res.json({ok:true,runId,items,counts:count,page,pages:Math.max(1,Math.ceil(count[status]/12))});
 }
 if(!Number.isSafeInteger(photoId)||photoId<=0)return res.status(400).json({error:'Некорректная фотография'});
 const item=selectPhoto.get(photoId);
 if(!item||item.event_id!==eventId||item.photo_area!=='contest')
  return res.status(404).json({error:'Фотография не принадлежит текущему конкурсу'});
 if(await contestPhotoMutationLocked(item))
  return res.status(409).json({error:'После начала голосования модерация заблокирована'});
 const inserted=db.prepare('INSERT OR IGNORE INTO contest_moderation_nonces(nonce,used_at_ms) VALUES(?,?)')
  .run(proof.nonce,Date.now());
 if(inserted.changes!==1)return res.status(409).json({error:'Действие уже выполнялось'});
 const next=action==='approve'?'approved':action==='reject'?'rejected':'pending';
 const result=db.prepare("UPDATE photos SET status=? WHERE id=? AND event_id=? AND photo_area='contest'")
  .run(next,photoId,eventId);
 if(result.changes!==1)return res.status(409).json({error:'Фотография изменилась'});
 return res.json({ok:true,runId,photoId,status:next});
}));
app.get('/api/operator/ready',asyncRoute(async(_req,res)=>{
 await synchronizeBroadcast();
 // Telegram Admin polls this endpoint every few seconds; this guarantees
 // automatic finalization even if nobody has opened the club LED screen.
 await finalizeContest();
 // Anonymous dashboard receives only aggregate counters, never guest photos,
 // names, access tokens or BALI IDs. It cannot control a broadcast.
 const contestId=activeBroadcast?.contestEventId;
 const counts=contestId?db.prepare(`SELECT
  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
  SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
  FROM photos WHERE event_id=? AND photo_area='contest'`).get(contestId):null;
 const registered=contestId?db.prepare(
  'SELECT COUNT(*) AS n FROM contest_telegram_entries WHERE event_id=?').get(contestId)?.n||0:0;
 const final=contestId?contestSettings(contestId):null;
 res.set('Cache-Control','no-store').json({ok:true,managedBroadcast:true,
  runId:activeBroadcast?.runId||null,
  cancelledRunId:db.prepare('SELECT run_id FROM managed_broadcast_cancellations WHERE finished_at_ms IS NOT NULL ORDER BY finished_at_ms DESC LIMIT 1').get()?.run_id||null,
  cancelledContestId:(()=>{const x=db.prepare('SELECT contest_event_id FROM managed_broadcast_cancellations WHERE finished_at_ms IS NOT NULL ORDER BY finished_at_ms DESC LIMIT 1').get();return x?.contest_event_id?'event_'+x.contest_event_id:null})(),
  screen:'/screen',
  contestFinalized:!!final?.finalized_at,
  counts:{pending:Number(counts?.pending)||0,approved:Number(counts?.approved)||0,
   rejected:Number(counts?.rejected)||0,registered:Number(registered)||0}});
}));
/* Local operator can restore already curated WebP photos copied from an
   earlier broadcast folder. They are indexed only in the CURRENT run. */
app.get('/api/admin/broadcast-state',adminAuth,asyncRoute(async(_req,res)=>{
 await synchronizeBroadcast();
 res.json({ok:true,active:!!activeBroadcast,runId:activeBroadcast?.runId||null,
  folder:activeBroadcast?'data/photos/streams/'+activeBroadcast.folder:null,
  telegramAdmin:'https://app.baliminsk.by/telegram-admin.html#tcPhoto',
  screen:'/screen'});
}));
app.post('/api/admin/broadcast-restore',adminAuth,requireAction,asyncRoute(async(_req,res)=>{
 await synchronizeBroadcast();
 const run=activeBroadcast;
 if(!run)return res.status(409).json({error:'Запусти трансляцию через Telegram Admin'});
 const dir=path.join(PHOTOS,'streams',run.folder);
 const entries=(await fsp.readdir(dir,{withFileTypes:true})).filter(x=>x.isFile()&&/^[a-f0-9-]{36}\.webp$/i.test(x.name)).slice(0,2000);
 const exists=db.prepare('SELECT id FROM photos WHERE filename=?');
 const insert=db.prepare("INSERT INTO photos(event_id,filename,guest_id,status,created_at,width,height,photo_area) VALUES(?,?,?,'approved',?,?,?,'general')");
 let imported=0,skipped=0,failed=0;
 for(const file of entries){
  const filename='streams/'+run.folder+'/'+file.name;
  if(exists.get(filename)){skipped++;continue}
  try{
   const full=path.join(dir,file.name),stat=await fsp.stat(full);
   if(stat.size<=0||stat.size>8*1024*1024){failed++;continue}
   const info=await sharp(full,{limitInputPixels:36_000_000,failOn:'error'}).metadata();
   if(info.format!=='webp'||!info.width||!info.height){failed++;continue}
   const thumb=path.join(THUMBS,filename);await fsp.mkdir(path.dirname(thumb),{recursive:true});
   if(!fs.existsSync(thumb))
    await sharp(full).resize({width:360,height:360,fit:'inside',withoutEnlargement:true})
     .webp({quality:65}).toFile(thumb);
   insert.run(run.generalEventId,filename,'operator-restored',Date.now(),info.width,info.height);
   imported++;
  }catch(error){failed++;console.warn('PHOTO WALL restore skipped:',error.message)}
 }
 res.json({ok:true,imported,skipped,failed,folder:'data/photos/streams/'+run.folder});
}));
app.get('/healthz', (_req,res) => {
 const required=['style.css','admin-compact.css','areas.css','screen-broadcast.css',
  'app.js','guest.js','crop.js','bali-logo.svg'];
 const missing=required.filter(file=>!fs.existsSync(path.join(pageAssetDir,file)));
 res.json({ok:missing.length===0,assetsOk:missing.length===0,missingAssets:missing,managedBroadcast:true,runId:activeBroadcast?.runId||null});
});

/* Single Windows authority for Telegram's button clocks and visibility.
   The public endpoint contains only harmless display rules, never credentials. */
app.get('/api/miniapp/buttons',(_req,res)=>{
 const config=miniappSnapshot();
 const event=currentEvent.get();
 res.json({ok:true,revision:config.revision,eventAvailable:!!event,...config.current});
});
app.get('/api/admin/miniapp/buttons',adminAuth,(_req,res)=>{
 res.json({ok:true,...miniappSnapshot()});
});
app.post('/api/admin/miniapp/buttons',adminAuth,requireAction,(req,res)=>{
 const payload=req.body||{},expected=payload.expectedRevision;
 if(Object.keys(payload).sort().join(',')!=='expectedRevision,settings'||
   !Number.isSafeInteger(expected)||expected<0)
  return res.status(400).json({error:'Некорректные параметры'});
 let next;
 try{next=normalizeButtons(payload.settings)}
 catch(error){return res.status(400).json({error:error.message})}
 const current=miniappRow();
 if((current?.revision||0)!==expected)
  return res.status(409).json({error:'Настройки изменены в другом окне. Обновите панель.'});
 if(current)db.prepare('UPDATE miniapp_button_settings SET settings_json=?,revision=revision+1,updated_at=? WHERE id=1')
   .run(JSON.stringify(next),Date.now());
 else db.prepare('INSERT INTO miniapp_button_settings(id,settings_json,revision,updated_at) VALUES(1,?,1,?)')
   .run(JSON.stringify(next),Date.now());
 res.json({ok:true,...miniappSnapshot()});
});
app.get('/api/public', asyncRoute(async(req,res)=>{
  await synchronizeBroadcast();
  guestIdentity(req,res);
  const event = currentEvent.get();
  res.json({ event:ensureStandaloneGeneralEvent()||event, uploadShape:event?.upload_shape||'any', limit:null });
}));
// Public contest feed for Telegram Mini App. Approved nominations only.
// Never return upload tokens, guest identifiers, source filenames or staff data.
app.get('/api/contest/status',asyncRoute(async(_req,res)=>{
 if(PHOTO_CONTEST_PAUSED)return res.json({contest_available:false,registration_open:false,voting_open:false,phase:'paused',candidates:[],winners:[]});
 await ensureTelegramContest();
 await finalizeContest();
 const event=currentContestEvent.get(),settings=event?contestSettings(event.id):null;
 const control=await telegramPhotoSchedule();
 const voteRule=control?.buttons.vote;
 const registrationRule=control?.buttons.registration;
 const clock=contestClock(settings),enabled=!!event&&settings.enabled===1;
 const rows=enabled?eligibleCandidates(event.id):[];
 const resultDue=!!settings?.finalized_at||(telegramContestMatches(control,event,settings)&&
  Number.isSafeInteger(control?.resultAtMs)&&Date.now()>=control.resultAtMs);
 const voting=enabled&&!resultDue&&voteRule?.open===true&&rows.length>0;
 const actualPhase=resultDue?'closed':voteRule?.open?'voting':
  registrationRule?.open?'registration':'waiting';
 const base=PUBLIC_URL.startsWith('https://baliminsk.online')?PUBLIC_URL:'https://baliminsk.online';
 const podium=settings?.finalized_at?contestPodium(event.id):null;
 const winner=settings?.finalized_at&&settings.winner_photo_id?rows.find(x=>x.photoId===settings.winner_photo_id):null;
 res.json({test_supported:true,test_session_id:settings?.test_session_id||null,
  contest_available:enabled,contest_id:enabled?'event_'+event.id:null,
  phase:actualPhase,contest_date:settings?.contest_date||null,bali_event_id:settings?.bali_event_id||null,
  broadcast_run_id:activeBroadcast?.runId||null,
  server_now:Date.now(),registration_open:enabled&&registrationRule?.open===true,
  registration_ends_at:registrationRule?.closesAtMs??null,
  voting_starts_at:voteRule?.open?control.serverNowMs:voteRule?.nextOpensAtMs??null,
  voting_ends_at:voteRule?.closesAtMs??null,voting_open:voting,
  vote_button_open:voteRule?.open===true,vote_button_visible:voteRule?.visible!==false,
  vote_button_mode:voteRule?.mode||'auto',
  approved_count:rows.length,ballot_blocked_reason:!control?'telegram-settings-unavailable':
   !voteRule?.visible?'hidden':!voteRule?.open?'schedule':
   rows.length===0?'no-approved-candidates':null,
  result_pending:resultDue&&!settings.finalized_at,
  winner:winner?{id:'p_'+winner.photoId,name:winner.name,
   photoUrl:base+'/api/contest/photo/p_'+winner.photoId,votes:settings.winner_votes}:null,
  winners:(podium?.winners||[]).map(w=>({id:'p_'+w.id,place:w.place,name:w.name,votes:w.votes,
   photoUrl:base+'/api/contest/photo/p_'+w.id})),
  candidates:voting?rows.map(x=>({id:'p_'+x.photoId,name:x.name,category:'king',
   photoUrl:base+'/api/contest/photo/p_'+x.photoId})):[]});
}));

// Persistent results for Telegram Admin. The public view omits
// Telegram handles, BALI UIDs, phone numbers, and private image paths.
function historicalContests(privateDetails=false){
 const rows=db.prepare(`SELECT e.id,e.name,s.contest_date,s.bali_event_id,s.total_votes,
  p.target_places,p.winners_json,p.finalized_at FROM contest_podium p
  JOIN events e ON e.id=p.event_id JOIN contest_settings s ON s.event_id=e.id
  WHERE s.test_session_id=''
  ORDER BY p.finalized_at DESC,e.id DESC LIMIT 250`).all();
 return rows.map(r=>{
  let winners=[];try{winners=JSON.parse(r.winners_json)}catch{}
  return {id:r.id,partyName:r.name,contestDate:r.contest_date,
   partyDate:r.bali_event_id||r.contest_date,finalizedAt:r.finalized_at,
   totalVotes:r.total_votes,configuredPlaces:r.target_places,
   winners:winners.map(w=>{
    if(!privateDetails)return {place:w.place,name:w.name,votes:w.votes};
    const identity=db.prepare('SELECT bali_uid AS uid,telegram_username AS username,telegram_display_name AS telegramName FROM contest_telegram_entries WHERE photo_id=?').get(w.id);
    return {place:w.place,name:w.name,votes:w.votes,photoId:w.id,
     photoUrl:'https://baliminsk.online/api/contest/photo/p_'+w.id,
     telegramUsername:identity?.username||w.telegramUsername||null,
     telegramName:identity?.telegramName||w.telegramName||null,
     submittedName:w.submittedName||null,
     baliUid:identity?.uid||null};
   })};
 });
}
app.get('/api/contest/history',(_req,res)=>{
 res.set('Cache-Control','no-store');
 res.json({ok:true,contests:historicalContests(false)});
});
app.get('/api/admin/contest/history',adminAuth,(_req,res)=>{
 res.set('Cache-Control','private,no-store');
 res.json({ok:true,contests:historicalContests(true)});
});

// Telegram Admin retrieves a more detailed archive only with its own
// short-lived HMAC proof. Never publish BALI UID or Telegram handles openly.
app.get('/api/contest/history-private',asyncRoute(async(req,res)=>{
 const auth=String(req.headers.authorization||'');
 if(!/^Bearer [A-Za-z0-9_.-]{40,1024}$/.test(auth))
  return res.status(403).json({error:'Administrator verification required'});
 let verified=false;
 try{
  const response=await fetch('https://app.baliminsk.by/api/tg-bali/photo-contest-history-proof',{
   method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({proof:auth.slice(7)}),signal:AbortSignal.timeout(5000)
  });
  verified=response.ok&&(await response.json())?.ok===true;
 }catch{}
 if(!verified)return res.status(403).json({error:'Telegram Admin verification expired'});
 res.set('Cache-Control','private,no-store');
 res.json({ok:true,contests:historicalContests(true)});
}));

app.get('/qr.svg', asyncRoute(async (_req, res) => {
  const svg = await QRCode.toString(PUBLIC_URL.replace(/\/$/,'') + '/upload', { type: 'svg', margin: 1, width: 320, color: {dark:'#111111',light:'#ffffff'} });
  res.type('image/svg+xml').set('Cache-Control','public,max-age=600').send(svg);
}));

// No hourly upload-request quota by default. Optional anti-abuse throttle
// can be enabled by setting UPLOAD_REQUESTS_PER_HOUR to a positive number.
const uploadLimiter = UPLOAD_REQUESTS_PER_HOUR === 0
  ? (_req,_res,next) => next()
  : rateLimit({windowMs:3600000,limit:UPLOAD_REQUESTS_PER_HOUR,
    standardHeaders:'draft-8',legacyHeaders:false});
let activeUploads = 0;
function reserveUploadSlot(req,res,next) {
  if (activeUploads >= MAX_ACTIVE_UPLOADS) {
    res.set('Retry-After','3');
    return res.status(503).json({error:'Много фотографий одновременно. Повторяем отправку…',code:'BUSY'});
  }
  activeUploads++;
  let released=false;
  const release=()=>{
    if(released)return;
    released=true;
    activeUploads--;
  };
  res.once('finish',release);
  res.once('close',release);
  next();
}
const upload = multer({ storage:multer.diskStorage({
  destination: (_req,_file,cb) => cb(null, UPLOADS),
  filename: (_req,_file,cb) => cb(null, crypto.randomUUID() + '.tmp')
}), limits: {fileSize: 8*1024*1024, files:1, fields:2} });
// Clean up uploads even when the controller rejects a request.
app.use('/api/upload', (req,res,next) => {
  const discard=()=> { if(req.file?.path) fsp.unlink(req.file.path).catch(()=>{}); };
  res.on('finish',discard);
  res.on('close',discard);
  next();
});
app.post('/api/upload', uploadLimiter, reserveUploadSlot, upload.single('photo'), asyncRoute(async (req,res) => {
  await synchronizeBroadcast();
  const event = ensureStandaloneGeneralEvent();
  if (!event) return res.status(409).json({error:'Сейчас нет активного мероприятия'});
  if (req.body?.consent !== 'yes') return res.status(400).json({error:'Необходимо согласие на показ фотографии'});
  if (!req.file?.path) return res.status(400).json({error:'Выберите фотографию'});
  const guest = guestIdentity(req,res);
  const alreadyInEvent = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id=?').get(event.id).n;
  if (MAX_PHOTOS_PER_EVENT > 0 && alreadyInEvent >= MAX_PHOTOS_PER_EVENT) return res.status(409).json({error:'Достигнут установленный лимит фотографий мероприятия'});
  try {
    const filesystem = await fsp.statfs(DATA);
    if (Number(filesystem.bavail)*Number(filesystem.bsize) < MIN_FREE_DISK_MB * 1048576) {
      return res.status(507).json({error:'На сервере недостаточно места для новых фотографий'});
    }
  } catch (error) {
    // Some platforms do not support filesystem statistics.
    if (!['ENOSYS','ENOTSUP','EOPNOTSUPP'].includes(error.code)) throw error;
    console.warn('Filesystem free space cannot be verified on this operating system');
  }
  let processed;
  try {
    const input = sharp(req.file.path, {limitInputPixels: 36_000_000, failOn: 'error'});
    const info = await input.metadata();
    if (!['jpeg','png','webp'].includes(info.format)) throw new Error('format');
    processed = await input.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
      .webp({quality:76,effort:2}).toBuffer();
  } catch {
    return res.status(415).json({error:'Поддерживаются JPEG, PNG и WebP без повреждений'});
  }
  // Never silently replace a guest's chosen crop with a different server crop.
  // Reject unsquared uploads if the moderator requires square photos.
  if(currentEvent.get()?.upload_shape==='square'){
    const shape=await sharp(processed).metadata();
    if(shape.width!==shape.height){
      return res.status(422).json({error:'На это мероприятие принимаются только квадратные фото 1:1. Проверьте обрезку и отправьте снова.'});
    }
  }
  const dimension=await sharp(processed).metadata();
  const filename = runFilename(event.id);
  const thumbnail = await sharp(processed).resize({width:360,height:360,fit:'inside',withoutEnlargement:true}).webp({quality:65}).toBuffer();
  const discardProcessed = () => Promise.all([
    fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{}),
    fsp.unlink(path.join(THUMBS,filename)).catch(()=>{})
  ]);
  try {
    await ensurePhotoFolders(filename);
   await fsp.writeFile(path.join(PHOTOS,filename),processed,{flag:'wx'});
    await fsp.writeFile(path.join(THUMBS,filename),thumbnail,{flag:'wx'});
    // Preserve the optional per-event quota and active-event check atomically.
    const result = db.prepare(`INSERT INTO photos(event_id,filename,guest_id,status,created_at,width,height)
      SELECT ?, ?, ?, 'pending', ?, ?, ?
      WHERE (? = 0 OR (SELECT COUNT(*) FROM photos WHERE event_id=?) < ?)
        AND EXISTS (SELECT 1 FROM events WHERE id=? AND active=1)`)
      .run(event.id,filename,guest,Date.now(),dimension.width,dimension.height,
        MAX_PHOTOS_PER_EVENT,event.id,MAX_PHOTOS_PER_EVENT,event.id);
    if (!result.changes) {
      await discardProcessed();
      if (currentEvent.get()?.id !== event.id)
        return res.status(409).json({error:'Мероприятие изменилось во время загрузки. Повторите отправку.'});
      const total = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id=?').get(event.id).n;
      const eventCapped = MAX_PHOTOS_PER_EVENT > 0 && total >= MAX_PHOTOS_PER_EVENT;
      return res.status(409)
        .json({error:eventCapped?'Достигнут установленный лимит фотографий мероприятия':'Мероприятие изменилось. Повторите отправку.'});
    }
    res.status(201).json({id:result.lastInsertRowid,status:'pending',message:'Фото отправлено на проверку'});
  } catch (error) {
    await discardProcessed();
    throw error;
  }
}));
/* Competition images go ONLY to this dedicated PHOTO WALL disk and SQLite.
   A 180-second BALI ID ticket is verified over HTTPS with the BALI Worker.
   No raw Telegram/Firebase tokens, Gmail, BALI COIN or voter data enter here. */
const contestOrigin='https://app.baliminsk.by';
app.options('/api/contest/entry',(req,res)=>{
 if(req.headers.origin!==contestOrigin)return res.status(403).end();
 res.set('Access-Control-Allow-Origin',contestOrigin);
 res.set('Access-Control-Allow-Methods','POST, OPTIONS');
 res.set('Access-Control-Allow-Headers','Content-Type');
 res.set('Vary','Origin');
 res.status(204).end();
});
app.use('/api/contest/entry',(req,res,next)=>{
 if(req.headers.origin===contestOrigin){
  res.set('Access-Control-Allow-Origin',contestOrigin);
  res.set('Vary','Origin');
 }
 next();
});
const contestUpload=multer({storage:multer.diskStorage({
 destination:(_req,_file,cb)=>cb(null,UPLOADS),
 filename:(_req,_file,cb)=>cb(null,crypto.randomUUID()+'.tmp')
}),limits:{fileSize:8*1024*1024,files:1,fields:1,parts:2}});
app.use('/api/contest/entry',(req,res,next)=>{
 const discard=()=>{if(req.file?.path)fsp.unlink(req.file.path).catch(()=>{})};
 res.on('finish',discard);res.on('close',discard);next();
});
app.post('/api/contest/entry',uploadLimiter,reserveUploadSlot,contestUpload.single('photo'),asyncRoute(async(req,res)=>{
 if(PHOTO_CONTEST_PAUSED)return res.status(410).json({error:'Фотоконкурс временно отключён. Отправь фото через общую фотостену.'});
 if(req.headers.origin!==contestOrigin)return res.status(403).json({error:'Отправляй фото из приложения BALI'});
 if(!req.file?.path)return res.status(400).json({error:'Выбери фото'});
 const ticket=String(req.body?.ticket||'');
 if(ticket.length<60||ticket.length>2800)return res.status(400).json({error:'Подтверждение конкурса отсутствует'});
 let proof=null;
 try{
  const verify=await fetch('https://app.baliminsk.by/api/tg-bali/photo-contest-upload-proof',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ticket}),signal:AbortSignal.timeout(6000),redirect:'error'
  });
  if(verify.ok){const data=await verify.json();if(data?.ok)proof=data.contestant;}
 }catch{}
 if(!proof||!/^[-A-Za-z0-9_]{1,100}$/.test(proof.uid||'')||
    !/^\d{4}-\d{2}-\d{2}(?:__\d+)?$/.test(proof.eventId||'')||
    typeof proof.name!=='string'||proof.name.length<2||proof.name.length>70||
    !/^(?:|@[A-Za-z0-9_]{5,32})$/.test(proof.username||'')||
    typeof proof.telegramName!=='string'||proof.telegramName.length>100||
    (proof.cardNumber!==undefined&&!/^\d{6}$/.test(proof.cardNumber))||
    (proof.telegramId!==undefined&&!/^\d{1,25}$/.test(proof.telegramId)))
   return res.status(401).json({error:'Подтверждение истекло. Попробуй отправить фото снова.'});
 // A queued nomination belongs to the event that was open when it was
 // submitted, not necessarily the event currently shown on club screens.
 // The event ID in the ticket is signed by BALI's Telegram backend.
 await ensureTelegramContest();
 let event=currentContestEvent.get();
 if(proof.broadcastRunId){
  if(db.prepare('SELECT 1 FROM managed_broadcast_cancellations WHERE run_id=?').get(proof.broadcastRunId))
   return res.status(409).json({error:'Этот конкурс отменён и удалён. Отправь фото на новый конкурс.'});
  if(!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(proof.broadcastRunId))
   return res.status(401).json({error:'Некорректный ID запуска конкурса'});
  const assigned=db.prepare('SELECT e.id,e.name,e.upload_shape FROM managed_broadcast_runs b '+
   'JOIN events e ON e.id=b.contest_event_id WHERE b.run_id=?').get(proof.broadcastRunId);
  if(!assigned)return res.status(409).json({error:'Запуск конкурса ещё не синхронизирован. Фото сохранено в очереди Telegram.'});
  if(!proof.queued&&activeBroadcast?.runId!==proof.broadcastRunId)
   return res.status(409).json({error:'Запущена другая трансляция, повторите подачу фотографии'});
  event=assigned;
 }
 if(proof.queued&&!proof.broadcastRunId){
  // Never silently attach yesterday's queued photo to today's current
  // contest. Look up the originally signed BALI Event ID, including a
  // historic contest whose enabled flag was later turned off.
  const possible=db.prepare("SELECT e.id,e.name,e.upload_shape,s.bali_event_id,s.contest_date FROM events e "+
   "JOIN contest_settings s ON s.event_id=e.id "+
   "WHERE s.bali_event_id=? OR s.bali_event_id=''").all(proof.eventId)
   .filter(x=>eligiblePartyDay(proof.eventId,x.contest_date));
  const exact=possible.filter(x=>x.bali_event_id===proof.eventId);
  const unbound=possible.filter(x=>!x.bali_event_id);
  if(exact.length===1)event=exact[0];
  else if(exact.length===0&&unbound.length===1)event=unbound[0];
  else return res.status(409).json({error:
   possible.length===0?'Для отложенного фото не найден исторический конкурс. Укажи его BALI Event ID в Windows.':
   'Несколько конкурсов подходят для отложенного фото. Укажи BALI Event ID у нужного конкурса в Windows.'});
 }
 if(!event)return res.status(409).json({error:'Не найдено мероприятие конкурса для этой заявки'});
 const setting=contestSettings(event.id);
 if((setting.test_session_id||'')!==(proof.testSessionId||''))return res.status(409).json({error:'Тестовая сессия изменилась. Отправь фото в текущий тест заново.'});
 const validQueued=queuedContestTicketAllowed(proof,setting);
 // The signed Cloudflare queue photo was originally submitted and accepted
 // under the THEN-current registration policy. Only live/direct submissions
 // must obey the CURRENT Windows registration window and voting time.
 const insideRegistration=!proof.queued&&setting.enabled===1&&
  Number.isSafeInteger(proof.queuedAtMs)&&Date.now()-proof.queuedAtMs<=180000;
 // The 180-second proof was issued only after Telegram Admin's registration
 // check. Windows must not reapply its old, conflicting button schedule.
 if(!insideRegistration&&!validQueued)
  return res.status(409).json({error:proof.queued?
   'Не удалось подтвердить исходную конкурсную заявку из очереди':
   'Заявка не подтверждена расписанием Telegram Admin или срок пропуска истёк'});
 if(!eligiblePartyDay(proof.eventId,setting.contest_date)||
   (setting.bali_event_id&&proof.eventId!==setting.bali_event_id))
  return res.status(409).json({error:'Дата/мероприятие заявки не совпадает с конкурсом PHOTO WALL'});
 if(db.prepare('SELECT 1 FROM contest_telegram_entries WHERE event_id=? AND bali_uid=?').get(event.id,proof.uid))
   return res.status(409).json({error:'Ты уже отправил(а) фото на этот конкурс. Второе фото не требуется.'});
 let processed;
 try{
  const image=sharp(req.file.path,{limitInputPixels:36_000_000,failOn:'error'});
  const meta=await image.metadata();
  if(!['jpeg','png','webp'].includes(meta.format))throw Error('image-format');
  processed=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
    .webp({quality:77,effort:4}).toBuffer();
 }catch{return res.status(415).json({error:'Только корректные JPEG, PNG или WebP до 8 МБ'})}
 const dimension=await sharp(processed).metadata();
 if(event.upload_shape==='square'&&dimension.width!==dimension.height)
  return res.status(422).json({error:'Для этой вечеринки фото должно быть квадратным, 1:1'});
 try{
  const stat=await fsp.statfs(DATA);
  if(Number(stat.bavail)*Number(stat.bsize)<MIN_FREE_DISK_MB*1048576)
    return res.status(507).json({error:'На фотосервере недостаточно места'});
 }catch(error){if(!['ENOSYS','ENOTSUP','EOPNOTSUPP'].includes(error.code))throw error}
 const filename=runFilename(event.id);
 const thumbnail=await sharp(processed).resize({width:360,height:360,fit:'inside',withoutEnlargement:true})
  .webp({quality:65}).toBuffer();
 const cleanup=()=>Promise.all([fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{}),fsp.unlink(path.join(THUMBS,filename)).catch(()=>{})]);
 try{
  await ensurePhotoFolders(filename);
   await fsp.writeFile(path.join(PHOTOS,filename),processed,{flag:'wx'});
  await fsp.writeFile(path.join(THUMBS,filename),thumbnail,{flag:'wx'});
  const insert=db.transaction(()=>{
   const now=Date.now();
   if(proof.queued&&!queuedContestTicketAllowed(proof,contestSettings(event.id),now))
     throw Error('event-changed');
   // Telegram Admin validates the time when it issues a signed entry ticket.
   // The old Windows-only registration clock may disagree and must not veto it.
   if((!proof.queued&&currentContestEvent.get()?.id!==event.id)||
      (!proof.queued&&(!insideRegistration||contestSettings(event.id).enabled!==1)))
    throw Error('event-changed');
   if(db.prepare('SELECT 1 FROM contest_telegram_entries WHERE event_id=? AND bali_uid=?').get(event.id,proof.uid))
     throw Error('already-registered');
   const submissionAt=validQueued?proof.queuedAtMs:now;
   const id=db.prepare("INSERT INTO photos(event_id,filename,guest_id,status,created_at,width,height,photo_area) VALUES(?,?,?,?,?,? ,?,'contest')")
     .run(event.id,filename,'contest:'+crypto.randomUUID(),setting.test_session_id?'approved':'pending',submissionAt,dimension.width,dimension.height).lastInsertRowid;
   db.prepare('INSERT INTO contest_telegram_entries(event_id,bali_uid,bali_event_id,photo_id,telegram_username,telegram_display_name,bali_card_number,telegram_provider_id,registered_at) VALUES(?,?,?,?,?,?,?,?,?)')
     .run(event.id,proof.uid,proof.eventId,id,proof.username,proof.telegramName||proof.name,
      proof.cardNumber||'',proof.telegramId||'',submissionAt);
   // One royal nomination, legacy DB category uses "king" internally.
   db.prepare('INSERT INTO contest_candidates(photo_id,event_id,name,category,registered_at) VALUES(?,?,?,?,?)')
     .run(id,event.id,proof.name,'king',submissionAt);
   return id;
  });
  const id=insert();
  return res.status(201).json({ok:true,id,status:setting.test_session_id?'approved':'pending',
   message:setting.test_session_id?'Тестовое фото принято и готово к голосованию':'Фото отправлено на модерацию конкурса'});
 }catch(error){
  await cleanup();
  return res.status(409).json({error:error?.message==='already-registered'?'Фото уже подано на конкурс.':'Мероприятие изменилось или фотография не принята. Попробуй снова.'});
 }
}));

const servePhoto = (row,res,privateView=false,fullView=false) => {
  if (!row || (!privateView && row.status !== 'approved')) return res.status(404).end();
  res.set('Cache-Control', 'private,no-store');
  const filename = privateView && !fullView && fs.existsSync(path.join(THUMBS,row.filename))
    ? path.join(THUMBS,row.filename) : path.join(PHOTOS,row.filename);
  return res.type('image/webp').sendFile(filename);
};
// Only currently nominated and approved competition photographs are public.
app.get('/api/contest/photo/:id', (req,res)=>{
 const match=/^p_([1-9][0-9]{0,9})$/.exec(req.params.id);
 if(!match)return res.status(404).end();
 const event=currentContestEvent.get();
 if(!event)return res.status(404).end();
 const row=db.prepare("SELECT p.* FROM photos p "+
  "JOIN contest_candidates c ON c.photo_id=p.id AND c.event_id=p.event_id "+
  "JOIN contest_settings s ON s.event_id=p.event_id "+
  "WHERE p.id=? AND p.event_id=? AND p.photo_area='contest' AND p.status='approved' AND s.enabled=1")
  .get(Number(match[1]),event.id);
 // Photo bytes must remain readable after approval, even before voting or
 // after voting has closed. Telegram D1 controls the ballot, not image URLs.
 // The SQL above already requires an approved nominated contest photograph.
 // Helmet defaults to Cross-Origin-Resource-Policy: same-origin, which blocks
 // an <img> embedded inside app.baliminsk.by even when this URL returns 200.
 // Only this approved public contest image endpoint is cross-origin embeddable.
 res.set('Cross-Origin-Resource-Policy','cross-origin');
 return servePhoto(row,res);
});
app.get('/api/photos/:id', screenAuth, (req,res) => {
 const photo=selectPhoto.get(Number(req.params.id));
 const area=req.query.feed==='contest'?'contest':'general';
 if(!photo||photo.photo_area!==area)return res.status(404).end();
 return servePhoto(photo,res);
});
// Keep LED transfers bounded. The newest 500 approved photos are enough
// for a full mosaic, and database size is not an app-level upload quota.
app.get('/api/screen', screenAuth, asyncRoute(async (_req,res) => {
  await synchronizeBroadcast();
  const event = ensureStandaloneGeneralEvent();
  const photos = event ? db.prepare("SELECT id,created_at,width,height,filename,screen_lane FROM photos p WHERE event_id=? AND status='approved' AND photo_area='general' ORDER BY created_at DESC,id DESC LIMIT 500").all(event.id) : [];
  const update=db.prepare('UPDATE photos SET width=?,height=? WHERE id=? AND (width IS NULL OR height IS NULL)');
  // Upgrade photos created before width/height metadata existed, once per photo.
  for(const photo of photos){
    if(photo.width>0 && photo.height>0)continue;
    try {
      const info=await sharp(path.join(PHOTOS,photo.filename)).metadata();
      photo.width=info.width||1;photo.height=info.height||1;
      update.run(photo.width,photo.height,photo.id);
    } catch {photo.width=1;photo.height=1;update.run(1,1,photo.id);}
  }
  res.json({event,photos:photos.map(({id,created_at,width,height,screen_lane})=>({id,created_at,width,height,screen_lane}))});
}));
/* Contest media is a separate LED feed, not mixed into the guests' wall. */
app.get('/api/screen/contest',screenAuth,asyncRoute(async(_req,res)=>{
 if(PHOTO_CONTEST_PAUSED)return res.json({event:null,photos:[],participants:[],phase:'paused',finalized:false,winners:[]});
 await ensureTelegramContest();
 await finalizeContest();
 const event=currentContestEvent.get(),settings=event?contestSettings(event.id):null;
 const policy=await telegramPhotoSchedule();
 const resultDue=telegramContestMatches(policy,event,settings)&&
  Number.isSafeInteger(policy?.resultAtMs)&&Date.now()>=policy.resultAtMs;
 const phase=settings?.finalized_at||resultDue?'closed':
  policy?.buttons.vote?.open?'voting':policy?.buttons.registration?.open?'registration':'waiting';
 const candidates=event?eligibleCandidates(event.id):[];
 const podium=phase==='closed'&&settings?.finalized_at?contestPodium(event.id):null;
 const winners=podium?.winners||[];
 const visible=phase==='closed'?winners.map(w=>({photoId:w.id})):candidates;
 const participants=phase==='closed'?[]:candidates.slice(0,10).map((c,i)=>({id:c.photoId,number:i+1,name:c.name||'Участник №'+(i+1)}));
 const photos=visible.slice(0,500).map(c=>
  db.prepare("SELECT id,created_at,width,height,screen_lane FROM photos WHERE id=? AND status='approved' AND photo_area='contest'").get(c.photoId)).filter(Boolean);
 const contestTitle=policy?.current?.session?.contestName||policy?.session?.contestName||'ПОБЕДИТЕЛИ BALI';
 res.json({event,photos,participants,phase,contestTitle:String(contestTitle).slice(0,90),
  finalized:!!settings?.finalized_at,serverNowMs:Date.now(),
  testMode:!!settings?.test_session_id,
  countdownEndsAtMs:settings?.test_session_id&&policy?.test?.phase==='countdown'?policy.test.deadlineMs:null,
  winner:winners[0]?{id:winners[0].id,name:winners[0].name,votes:winners[0].votes,totalVotes:settings.total_votes}:null,
  winners:winners.map(w=>({id:w.id,name:w.name,votes:w.votes,place:w.place})),
  winnerCount:podium?.places||1,
  resultError:phase==='closed'&&!settings?.finalized_at?'Ожидаем подтверждённые голоса BALI':null});
}));
// Only approved photos may appear in the LED mosaic, even as thumbnails.
// Unapproved originals remain accessible to the moderator only.
app.get('/api/screen/thumbnail/:id', screenAuth, (req,res) => {
  const photo = selectPhoto.get(Number(req.params.id));
  if(!photo || photo.status!=='approved'||photo.photo_area!==(req.query.feed==='contest'?'contest':'general'))return res.status(404).end();
  const thumbnail=path.join(THUMBS,photo.filename);
  const original=path.join(PHOTOS,photo.filename);
  res.set('Cache-Control','private,no-store');
  res.type('image/webp').sendFile(fs.existsSync(thumbnail)?thumbnail:original);
});

// Live displays read a persistent profile. Only a signed-in PHOTO WALL
// moderator can edit the corresponding visual controller.
app.get('/api/screen/profile',screenAuth,(req,res)=>{
 const area=screenArea(req.query.feed);
 if(!area)return res.status(400).json({error:'Выбери экран фотостены или конкурса'});
 res.json(screenProfileData(area));
});
app.post('/api/admin/screen/profile',adminAuth,requireAction,(req,res)=>{
 const area=screenArea(req.query.feed);
 if(!area)return res.status(400).json({error:'Выбери вид трансляции'});
 let settings;
 try{settings=screenProfile(req.body?.settings);}catch(error){
   return res.status(400).json({error:'Неверные параметры экрана: '+error.message});
 }
 db.prepare(`INSERT INTO screen_profiles(area,settings_json,revision,updated_at)
 VALUES(?,?,1,?)
 ON CONFLICT(area) DO UPDATE SET settings_json=excluded.settings_json,
 revision=screen_profiles.revision+1,updated_at=excluded.updated_at`)
 .run(area,JSON.stringify(settings),Date.now());
 res.json(screenProfileData(area));
});
const logoUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:1024*1024,files:1,fields:0}});
app.post('/api/admin/screen/logo',adminAuth,requireAction,logoUpload.single('logo'),asyncRoute(async(req,res)=>{
 const area=screenArea(req.query.feed);
 if(!area)return res.status(400).json({error:'Выбери экран'});
 if(!req.file?.buffer)return res.status(400).json({error:'Выбери изображение логотипа'});
 const image=sharp(req.file.buffer,{limitInputPixels:5_000_000,failOn:'error'});
 const meta=await image.metadata();
 if(!['png','jpeg','webp'].includes(meta.format))
  return res.status(415).json({error:'Нужен PNG, JPG или WebP'});
 const converted=await image.resize({width:1200,height:1200,fit:'inside',withoutEnlargement:true})
   .webp({quality:86}).toBuffer();
 const destination=screenLogoFile(area),temp=destination+'.'+crypto.randomUUID()+'.tmp';
 try{await fsp.writeFile(temp,converted,{flag:'wx'});await fsp.rename(temp,destination);}
 finally{await fsp.unlink(temp).catch(()=>{});}
 res.json(screenProfileData(area));
}));
app.delete('/api/admin/screen/logo',adminAuth,requireAction,asyncRoute(async(req,res)=>{
 const area=screenArea(req.query.feed);
 if(!area)return res.status(400).json({error:'Выбери экран'});
 await fsp.unlink(screenLogoFile(area)).catch(error=>{if(error.code!=='ENOENT')throw error});
 res.json(screenProfileData(area));
}));
app.get('/api/screen/profile-logo',screenAuth,(req,res)=>{
 const area=screenArea(req.query.feed);
 if(!area)return res.status(404).end();
 const file=screenLogoFile(area);
 if(!fs.existsSync(file))return res.status(404).end();
 res.set('Cache-Control','private,no-store').type('image/webp').sendFile(file);
});

const loginLimiter = rateLimit({windowMs:900000,limit:10,standardHeaders:'draft-8',legacyHeaders:false});
app.post('/api/screen/login', loginLimiter, (req,res) => {
  if (!verifyPassword(req.body?.password, SCREEN_PASSWORD)) return res.status(401).json({error:'Неверный пароль экрана'});
  res.cookie('bali_screen',signed(String(Date.now()+24*3600000),PURPOSES.bali_screen),cookieOptions(req,24*3600000));
  res.json({ok:true});
});
app.post('/api/admin/login', loginLimiter, (req,res) => {
  if (!verifyPassword(req.body?.password, PASSWORD)) return res.status(401).json({error:'Неверный пароль'});
  res.cookie('bali_admin',signed(String(Date.now()+12*3600000),PURPOSES.bali_admin),cookieOptions(req,12*3600000));
  res.json({ok:true});
});
app.post('/api/admin/logout', requireAction, (_req,res) => {
  res.clearCookie('bali_admin',{path:'/'});
  res.json({ok:true});
});
app.get('/api/admin/me', adminAuth, (_req,res) => res.json({ok:true}));
app.get('/api/admin/photos/:id', adminAuth, (req,res) => servePhoto(selectPhoto.get(Number(req.params.id)),res,true,req.query.full==='1'));
// Moderator bulk import: bounded 8-file batches to avoid exhausting club hardware.
// Auth and CSRF-action checks happen BEFORE parsing multipart uploads.
const adminBatchUpload=multer({
  storage:multer.diskStorage({
    destination:(_req,_file,callback)=>callback(null,UPLOADS),
    filename:(_req,_file,callback)=>callback(null,crypto.randomUUID()+'.tmp')
  }),
  limits:{fileSize:8*1024*1024,files:8,fields:4,parts:12}
});
app.post('/api/admin/photos/bulk',adminAuth,requireAction,reserveUploadSlot,
  adminBatchUpload.array('photos',8),asyncRoute(async(req,res)=>{
  const files=Array.isArray(req.files)?req.files:[];
  const clean=()=>Promise.all(files.map(file=>fsp.unlink(file.path).catch(()=>{})));
  try {
    if(!files.length)return res.status(400).json({error:'Выберите фотографии для загрузки'});
    const id=Number(req.body?.eventId);
    const event=Number.isSafeInteger(id)&&id>0?
      db.prepare('SELECT id,upload_shape FROM events WHERE id=?').get(id):null;
    if(!event)return res.status(404).json({error:'Мероприятие не найдено'});
    const area=req.body?.area||'general';
    if(!['general','contest'].includes(area))return res.status(400).json({error:'Неизвестный раздел загрузки'});
    const status=req.body?.status==='pending'?'pending':'approved';
    const lane=['top','bottom'].includes(req.body?.lane)?req.body.lane:'auto';
    const results=[];
    const insert=db.prepare('INSERT INTO photos(event_id,filename,guest_id,status,created_at,width,height,screen_lane,photo_area) VALUES (?,?,?,?,?,?,?,?,?)');
    for(const file of files){
      const result={name:file.originalname.slice(0,180)};
      let filename=null;
      try{
        if(MAX_PHOTOS_PER_EVENT>0){
          const count=db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id=?').get(event.id).n;
          if(count>=MAX_PHOTOS_PER_EVENT)throw new Error('Достигнут лимит фото мероприятия');
        }
        const filesystem=await fsp.statfs(DATA);
        if(Number(filesystem.bavail)*Number(filesystem.bsize)<MIN_FREE_DISK_MB*1048576)
          throw new Error('Недостаточно свободного места на диске');
        const photo=sharp(file.path,{limitInputPixels:36_000_000,failOn:'error'});
        const info=await photo.metadata();
        if(!['jpeg','png','webp'].includes(info.format))throw new Error('Поддерживаются только JPEG, PNG и WebP');
        const image=await photo.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
          .webp({quality:77,effort:4}).toBuffer();
        const size=await sharp(image).metadata();
        if(event.upload_shape==='square'&&size.width!==size.height)
          throw new Error('Для мероприятия разрешены только квадратные фото 1:1');
        const thumbnail=await sharp(image).resize({width:360,height:360,fit:'inside',withoutEnlargement:true})
          .webp({quality:65}).toBuffer();
        filename=runFilename(event.id);
        await ensurePhotoFolders(filename);
   await fsp.writeFile(path.join(PHOTOS,filename),image,{flag:'wx'});
        await fsp.writeFile(path.join(THUMBS,filename),thumbnail,{flag:'wx'});
        const record=insert.run(event.id,filename,'moderator-import',status,Date.now(),size.width,size.height,lane,area);
        result.id=Number(record.lastInsertRowid);result.ok=true;
      }catch(error){
        result.ok=false;
        result.error=error.message||'Не удалось обработать фото';
        if(filename){
          await fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{});
          await fsp.unlink(path.join(THUMBS,filename)).catch(()=>{});
        }
      }
      results.push(result);
    }
    const imported=results.filter(x=>x.ok).length;
    res.json({ok:imported===files.length,imported,failed:files.length-imported,results});
  }finally{await clean();}
}));
// Independent moderator-only competition control. These routes can never
// credit BALI COIN or mutate the Firebase/TG user directory.
app.get('/api/admin/contest',adminAuth,asyncRoute(async(req,res)=>{
 const raw=String(req.query.eventId||'');
 if(!/^[1-9][0-9]{0,9}$/.test(raw))return res.status(400).json({error:'Выберите мероприятие'});
 const id=Number(raw),event=db.prepare('SELECT id,name FROM events WHERE id=?').get(id);
 if(!event)return res.status(404).json({error:'Мероприятие не найдено'});
 await finalizeContest();
 const settings=contestSettings(id),clock=contestClock(settings);
 const candidates=db.prepare("SELECT c.photo_id AS photoId,c.name,c.category,p.status FROM contest_candidates c JOIN photos p ON p.id=c.photo_id WHERE c.event_id=? ORDER BY c.registered_at DESC LIMIT 300").all(id);
 const liveEvent=currentContestEvent.get();
 res.json({ok:true,event,liveContestEventId:liveEvent?.id||null,
  liveContestName:liveEvent?.name||null,
  settings:{enabled:!!settings.enabled,contestDate:settings.contest_date,
   votingStart:settings.voting_start,votingEnd:settings.voting_end,
   baliEventId:settings.bali_event_id,phase:clock.phase,
   votingOpen:clock.phase==='voting',finalizedAt:settings.finalized_at,
   winnerPhotoId:settings.winner_photo_id,winnerVotes:settings.winner_votes,
   totalVotes:settings.total_votes,registrationStartsAt:clock.registrationStartsAt,
   registrationEndsAt:clock.registrationEndsAt,votingStartsAt:clock.votingStartsAt,
   votingEndsAt:clock.votingEndsAt,resultsAt:clock.resultsAt,
   registrationOpensAt:settings.registration_opens_at||'',
   registrationClosesAt:settings.registration_ends_at||'',
   votingStartsLocal:settings.voting_starts_at||'',
   votingEndsLocal:settings.voting_ends_at||'',
   resultsLocal:settings.results_at||'',
   tallyError:lastTallyError},candidates});
}));
app.post('/api/admin/contest/settings',adminAuth,requireAction,(req,res)=>{
  if(process.env.ALLOW_LEGACY_EVENT_CONTROL!=='1')return res.status(403).json({error:'Расписание и запуск конкурса доступны только в Telegram Admin'});
 const i=req.body||{},id=Number(i.eventId);
 const fields=['registrationOpensAt','registrationClosesAt','votingStartsLocal','votingEndsLocal','resultsLocal'];
 const advanced=fields.some(key=>Object.hasOwn(i,key));
 const allowed=['eventId','enabled','contestDate','baliEventId',...(advanced?fields:['votingStart','votingEnd'])];
 if(!Number.isSafeInteger(id)||id<1||typeof i.enabled!=='boolean'||
   !isContestDate(i.contestDate)||typeof i.baliEventId!=='string'||
   (i.baliEventId!==''&&!/^\d{4}-\d{2}-\d{2}(?:__(?:2|3))?$/.test(i.baliEventId))||
   Object.keys(i).sort().join(',')!==allowed.sort().join(','))
   return res.status(400).json({error:'Заполни расписание конкурса и мероприятие'});
 if(!db.prepare('SELECT 1 FROM events WHERE id=?').get(id))
   return res.status(404).json({error:'Мероприятие не найдено'});
 if(i.baliEventId&&!eligiblePartyDay(i.baliEventId,i.contestDate))
   return res.status(400).json({error:'BALI Event ID должен относиться к дате конкурса или предыдущему дню'});
 let timeline;
 if(advanced){
   timeline={contest_date:i.contestDate,registration_opens_at:i.registrationOpensAt,
     registration_ends_at:i.registrationClosesAt,voting_starts_at:i.votingStartsLocal,
     voting_ends_at:i.votingEndsLocal,results_at:i.resultsLocal};
   if(!validContestTimeline(timeline))
     return res.status(400).json({error:'Неверный порядок времени: открытие регистрации < закрытие регистрации ≤ начало голосования < конец голосования ≤ итоги. Дата конкурса должна совпадать с днём начала голосования по Минску.'});
 }else{
   // Legacy clients retain the original fixed times, but manual schedules
   // saved by the updated moderator may use ANY valid hour and minute.
   if(i.votingStart!=='03:00'||
     !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.votingEnd)||i.votingEnd<='03:00')
     return res.status(400).json({error:'Проверь время голосования'});
   timeline={registration_opens_at:'',registration_ends_at:'',voting_starts_at:'',
     voting_ends_at:'',results_at:''};
 }
 const start=advanced?i.votingStartsLocal.slice(11):'03:00';
 const end=advanced?i.votingEndsLocal.slice(11):i.votingEnd;
 const prev=contestRow(id),prevClock=contestClock(prev),now=Date.now();
 if(prev?.finalized_at)
   return res.status(409).json({error:'Результат уже зафиксирован. Для следующего конкурса создай другое мероприятие.'});
 if(prev?.enabled===1&&prevClock.votingStartsAt!==null&&now>=prevClock.votingStartsAt){
   if(prevClock.phase==='closed')
     return res.status(409).json({error:'Конкурс завершён по расписанию. Для нового конкурса создай другое мероприятие.'});
   const unmodified=prev.contest_date===i.contestDate&&prev.enabled===Number(i.enabled)&&
     prev.bali_event_id===i.baliEventId&&prev.voting_start===start&&
     (prev.registration_opens_at||'')===timeline.registration_opens_at&&
     (prev.registration_ends_at||'')===timeline.registration_ends_at&&
     (prev.voting_starts_at||'')===timeline.voting_starts_at;
   if(!unmodified)
     return res.status(409).json({error:'После начала голосования нельзя менять прошедшие этапы и дату конкурса. Окончание голосования и результаты можно перенести.'});
   if(prevClock.phase==='awaiting_results'&&(prev.voting_ends_at||'')!==timeline.voting_ends_at)
     return res.status(409).json({error:'Голосование уже завершено: разрешено менять только время результатов.'});
   if(prevClock.phase==='voting'&&advanced&&Date.parse(i.votingEndsLocal+':00+03:00')<=now)
     return res.status(409).json({error:'Окончание действующего голосования должно быть в будущем.'});
   if(prevClock.phase==='awaiting_results'&&advanced&&Date.parse(i.resultsLocal+':00+03:00')<=now)
     return res.status(409).json({error:'Новое время результатов должно быть в будущем.'});
 }
 db.prepare(`INSERT INTO contest_settings(event_id,enabled,voting_open,contest_date,voting_start,voting_end,bali_event_id,
   registration_opens_at,registration_ends_at,voting_starts_at,voting_ends_at,results_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(event_id) DO UPDATE SET enabled=excluded.enabled,voting_open=0,
     contest_date=excluded.contest_date,voting_start=excluded.voting_start,
     voting_end=excluded.voting_end,bali_event_id=excluded.bali_event_id,
     registration_opens_at=excluded.registration_opens_at,registration_ends_at=excluded.registration_ends_at,
     voting_starts_at=excluded.voting_starts_at,voting_ends_at=excluded.voting_ends_at,
     results_at=excluded.results_at,updated_at=excluded.updated_at`)
   .run(id,Number(i.enabled),0,i.contestDate,start,end,i.baliEventId,
     timeline.registration_opens_at,timeline.registration_ends_at,timeline.voting_starts_at,
     timeline.voting_ends_at,timeline.results_at,Date.now());
 res.json({ok:true,phase:contestClock(contestSettings(id)).phase});
});
app.post('/api/admin/contest/candidates',adminAuth,requireAction,asyncRoute(async(req,res)=>{
 const input=req.body||{},eventId=Number(input.eventId),photoId=Number(input.photoId);
 if(!Number.isSafeInteger(eventId)||eventId<1||!Number.isSafeInteger(photoId)||photoId<1||
   !['add','remove'].includes(input.action)||
   Object.keys(input).some(k=>!['eventId','photoId','name','category','action'].includes(k)))
  return res.status(400).json({error:'Некорректные данные участника'});
 const photo=db.prepare('SELECT id,status,photo_area FROM photos WHERE id=? AND event_id=?').get(photoId,eventId);
 if(!photo)return res.status(404).json({error:'Фотография не найдена в мероприятии'});
 const control=await telegramPhotoSchedule();
 if(!control)return res.status(503).json({error:'Расписание Telegram Admin недоступно. Изменение участников отложено.'});
 if(control.buttons.vote?.open===true||
    (control.resultContestId==='event_'+eventId&&
     Number.isSafeInteger(control.resultAtMs)&&Date.now()>=control.resultAtMs))
   return res.status(409).json({error:'Список участников закрыт таймером голосования Telegram Admin'});
 if(input.action==='add'){
  const name=typeof input.name==='string'?input.name.trim():'';
  if(name.length<2||name.length>70||/[<>\u0000-\u001f\u007f]/.test(name)||
     !['king','queen'].includes(input.category)||photo.status!=='approved'||photo.photo_area!=='contest')
   return res.status(400).json({error:'Участнику требуется одобренное фото, имя и категория'});
  db.prepare('INSERT INTO contest_candidates(photo_id,event_id,name,category,registered_at) VALUES(?,?,?,?,?) '+
   'ON CONFLICT(photo_id) DO UPDATE SET name=excluded.name,category=excluded.category')
   .run(photoId,eventId,name,input.category,Date.now());
 }else{
  db.prepare('DELETE FROM contest_candidates WHERE photo_id=? AND event_id=?').run(photoId,eventId);
  const remaining=db.prepare("SELECT COUNT(*) AS n FROM contest_candidates c JOIN photos p ON p.id=c.photo_id "+
   "WHERE c.event_id=? AND p.status='approved'").get(eventId);
  if(!remaining.n)db.prepare('UPDATE contest_settings SET voting_open=0 WHERE event_id=?').run(eventId);
 }
 res.json({ok:true});
}));
app.get('/api/admin/contest/export',adminAuth,(req,res)=>{
 const id=Number(req.query.eventId);
 if(!Number.isSafeInteger(id)||id<1||!db.prepare('SELECT 1 FROM events WHERE id=?').get(id))
  return res.status(400).json({error:'Выберите мероприятие'});
 const rows=db.prepare("SELECT p.id AS photoId,p.status,p.created_at AS uploadedAt,c.name,c.category "+
  "FROM photos p LEFT JOIN contest_candidates c ON c.photo_id=p.id AND c.event_id=p.event_id "+
  "WHERE p.event_id=? ORDER BY p.created_at,p.id LIMIT 100000").all(id);
 const cell=v=>'"'+String(v??'').replace(/"/g,'""').replace(/^[=+@-]/,m=>String.fromCharCode(39)+m)+'"';
 const lines=['photo_id;status;uploaded_at;candidate_name;category',
  ...rows.map(r=>[r.photoId,r.status,r.uploadedAt,r.name,r.category].map(cell).join(';'))];
 res.type('text/csv; charset=utf-8')
  .set('Content-Disposition','attachment; filename="bali-photo-contest-'+id+'.csv"')
  .send('\uFEFF'+lines.join('\n'));
});
app.get('/api/admin/dashboard', adminAuth, asyncRoute(async(req,res) => {
  // After Windows restart restore the Telegram-selected run before choosing
  // the moderation queue. Never fall back to the GENERAL photo event.
  await synchronizeBroadcast();
  const events = db.prepare('SELECT id,name,active,created_at,upload_shape FROM events ORDER BY id DESC').all();
  const active = currentEvent.get();
  const requested = req.query.eventId;
  const selected = requested === undefined ? (req.query.area==='contest'&&activeBroadcast?
   db.prepare('SELECT id,name,upload_shape FROM events WHERE id=?').get(activeBroadcast.contestEventId):active)
    : (typeof requested === 'string' && /^\d+$/.test(requested)
      ? db.prepare('SELECT id,name,upload_shape FROM events WHERE id=?').get(Number(requested)) : null);
  if (requested !== undefined && !selected) return res.status(404).json({error:'Мероприятие не найдено'});
  const PAGE_SIZE = 48;
  const rawPage = req.query.page ?? '1';
  if (typeof rawPage !== 'string' || !/^[1-9][0-9]{0,5}$/.test(rawPage)) {
    return res.status(400).json({error:'Неверный номер страницы'});
  }
  const area=req.query.area||'general';
  if(typeof area!=='string'||!['general','contest'].includes(area))
    return res.status(400).json({error:'Неизвестная зона управления'});
  const status=req.query.status??'pending';
  if(typeof status!=='string'||!['pending','approved','rejected'].includes(status))
    return res.status(400).json({error:'Неизвестная очередь фотографий'});
  const counts=selected?db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
    COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS approved,
    COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rejected
    FROM photos WHERE event_id=? AND photo_area=?`).get(selected.id,area):{pending:0,approved:0,rejected:0};
  const total=counts[status],pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),page=Math.min(Number(rawPage),pages);
  const photos=selected?db.prepare(`SELECT p.id,p.status,p.created_at,p.screen_lane,p.photo_area,
    CASE WHEN c.photo_id IS NULL THEN 0 ELSE 1 END AS contest,
    t.telegram_username AS telegramUsername,t.telegram_display_name AS telegramName,
    t.bali_card_number AS cardNumber,t.telegram_provider_id AS telegramId
    FROM photos p LEFT JOIN contest_candidates c ON c.photo_id=p.id
    LEFT JOIN contest_telegram_entries t ON t.photo_id=p.id
    WHERE p.event_id=? AND p.photo_area=? AND p.status=?
    ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`).all(selected.id,area,status,PAGE_SIZE,(page-1)*PAGE_SIZE):[];
  res.json({events,active,selected,photos,status,area,counts,page,pages,total,pageSize:PAGE_SIZE});
}));
const makeEvent = db.transaction(name => {
  db.prepare('UPDATE events SET active=0').run();
  return db.prepare('INSERT INTO events(name,active,created_at) VALUES (?,1,?)').run(name,Date.now()).lastInsertRowid;
});
app.post('/api/admin/events', adminAuth, requireAction, (req,res) => {
  if(process.env.ALLOW_LEGACY_EVENT_CONTROL!=='1')return res.status(403).json({error:'Создание нового эфира доступно только в Telegram Admin'});
  if(telegramSchedule.value?.broadcast?.active)return res.status(403).json({error:'Запуск трансляции только через Telegram Admin'});
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 3 || name.length > 90) return res.status(400).json({error:'Название мероприятия: 3–90 символов'});
  const id = makeEvent(name);
  res.status(201).json({id});
});
const activateEvent = db.transaction(id => {
  const item = db.prepare('SELECT id FROM events WHERE id=?').get(id);
  if (!item) return false;
  db.prepare('UPDATE events SET active=0').run();
  db.prepare('UPDATE events SET active=1 WHERE id=?').run(id);
  return true;
});
app.post('/api/admin/events/:id/upload-shape', adminAuth, requireAction, (req,res)=>{
  const id=Number(req.params.id);
  const shape=req.body?.uploadShape;
  if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Некорректное мероприятие'});
  if(!['any','square'].includes(shape))return res.status(400).json({error:'Выберите любые форматы или только квадратные'});
  const result=db.prepare('UPDATE events SET upload_shape=? WHERE id=?').run(shape,id);
  if(!result.changes)return res.status(404).json({error:'Мероприятие не найдено'});
  res.json({ok:true,uploadShape:shape});
});
app.post('/api/admin/events/:id/activate', adminAuth, requireAction, (req,res) => {
  if(process.env.ALLOW_LEGACY_EVENT_CONTROL!=='1')return res.status(403).json({error:'Запуск эфира доступен только в Telegram Admin'});
  if(telegramSchedule.value?.broadcast?.active)return res.status(403).json({error:'Выбор эфира только через Telegram Admin'});
  if (!activateEvent(Number(req.params.id))) return res.status(404).json({error:'Мероприятие не найдено'});
  res.json({ok:true});
});
app.post('/api/admin/photos/:id/screen-lane', adminAuth, requireAction, (req,res) => {
  const lane=req.body?.lane;
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1 || !['auto','top','bottom'].includes(lane))
    return res.status(400).json({error:'Выберите верхний, нижний или автоматический поток'});
  const result=db.prepare('UPDATE photos SET screen_lane=? WHERE id=?').run(lane,id);
  if(!result.changes)return res.status(404).json({error:'Фотография не найдена'});
  res.json({ok:true,lane});
});
// Contest photographs become immutable as soon as Telegram opens voting.
// Never let a moderator remove a finalist or alter the tally after the deadline,
// including during an upstream outage or after the Windows process restarts.
async function contestPhotoMutationLocked(photo){
 if(photo.photo_area!=='contest')return false;
 // The old end-to-end smoke fixture deliberately has no Telegram session.
 // Never apply this bypass outside isolated non-production test mode.
 if(process.env.PHOTO_WALL_OFFLINE_LEGACY_FIXTURE==='1'&&
    process.env.ALLOW_LEGACY_EVENT_CONTROL==='1'&&
    process.env.NODE_ENV!=='production')return false;
 const settings=contestSettings(photo.event_id);
 if(!settings||settings.finalized_at)return true;
 const control=await telegramPhotoSchedule();
 if(settings.test_session_id){
  const rehearsal=testContestSession(control);
  return !(rehearsal?.testSessionId===settings.test_session_id&&control?.test?.phase==='registration');
 }
 await synchronizeBroadcast();
 return !(activeBroadcast?.contestEventId===photo.event_id&&
  control?.broadcast?.active===true&&
  control?.contestPhase==='registration'&&
  Number.isSafeInteger(control?.registrationEndsAtMs)&&
  Date.now()<control.registrationEndsAtMs);
}
// Local Photoshop/JPG/PNG/WebP replacement of an existing contest entry.
// Do not allocate another contestant, rename a Card, touch D1, or reset votes.
db.exec(`CREATE TABLE IF NOT EXISTS contest_photo_replacements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 photo_id INTEGER NOT NULL, event_id INTEGER NOT NULL,
 old_filename TEXT NOT NULL,new_filename TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL
)`);
const contestReplacementUpload=multer({storage:multer.memoryStorage(),
 limits:{fileSize:8*1024*1024,files:1,fields:0}});
app.post('/api/admin/photos/:id/replace',adminAuth,requireAction,reserveUploadSlot,
 contestReplacementUpload.single('photo'),asyncRoute(async(req,res)=>{
 const id=Number(req.params.id);
 const photo=Number.isSafeInteger(id)&&id>0?selectPhoto.get(id):null;
 if(!photo||photo.photo_area!=='contest')return res.status(404).json({error:'Конкурсная фотография не найдена'});
 if(await contestPhotoMutationLocked(photo))return res.status(409).json({error:'После начала голосования менять фотографию нельзя'});
 if(!req.file?.buffer)return res.status(400).json({error:'Выберите JPG, PNG или WebP'});
 let image,thumb,dimensions;
 try{
  const input=sharp(req.file.buffer,{limitInputPixels:36_000_000,failOn:'error'});
  const info=await input.metadata();
  if(!['jpeg','png','webp'].includes(info.format)||info.width<50||info.height<50)
   return res.status(415).json({error:'Нужен JPG, PNG или WebP не меньше 50×50'});
  image=await input.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
    .webp({quality:80,effort:4}).toBuffer();
  dimensions=await sharp(image).metadata();
  thumb=await sharp(image).resize({width:360,height:360,fit:'inside',withoutEnlargement:true})
    .webp({quality:65}).toBuffer();
 }catch{return res.status(415).json({error:'Изображение не читается или повреждено'})}
 const filesystem=await fsp.statfs(DATA);
 if(Number(filesystem.bavail)*Number(filesystem.bsize)<MIN_FREE_DISK_MB*1048576)
  return res.status(507).json({error:'Недостаточно места на Windows-диске'});
 const newFilename=runFilename(photo.event_id);
 const fullPath=path.join(PHOTOS,newFilename),thumbPath=path.join(THUMBS,newFilename);
 let saved=false;
 try{
  await ensurePhotoFolders(newFilename);
  await fsp.writeFile(fullPath,image,{flag:'wx'});
  await fsp.writeFile(thumbPath,thumb,{flag:'wx'});
  // Read the authoritative Telegram clock AGAIN after image processing and IO.
  // If the deadline has passed or a different run became active, do not swap.
  const latest=selectPhoto.get(id);
  if(!latest||latest.filename!==photo.filename||await contestPhotoMutationLocked(latest))
   return res.status(409).json({error:'Фотография изменилась или голосование уже началось'});
  const result=db.transaction(()=>{
   const current=selectPhoto.get(id);
   if(!current||current.filename!==photo.filename||current.photo_area!=='contest')return false;
   const updated=db.prepare('UPDATE photos SET filename=?,width=?,height=? WHERE id=? AND filename=? AND photo_area=?')
    .run(newFilename,dimensions.width,dimensions.height,id,photo.filename,'contest');
   if(updated.changes!==1)return false;
   db.prepare('INSERT INTO contest_photo_replacements(photo_id,event_id,old_filename,new_filename,created_at_ms) VALUES(?,?,?,?,?)')
    .run(id,photo.event_id,photo.filename,newFilename,Date.now());
   return true;
  })();
  if(!result)return res.status(409).json({error:'Фото изменено в другом окне'});
  saved=true;
  await Promise.all([fsp.unlink(path.join(PHOTOS,photo.filename)).catch(()=>{}),
                     fsp.unlink(path.join(THUMBS,photo.filename)).catch(()=>{})]);
  return res.json({ok:true,photoId:id,version:Date.now(),width:dimensions.width,height:dimensions.height});
 }finally{
  if(!saved)await Promise.all([fsp.unlink(fullPath).catch(()=>{}),fsp.unlink(thumbPath).catch(()=>{})]);
 }
}));
app.post('/api/admin/photos/:id/status', adminAuth, requireAction, asyncRoute(async(req,res) => {
 const status=req.body?.status;
 if(!['approved','rejected','pending'].includes(status))return res.status(400).json({error:'Неизвестный статус'});
 const photo=selectPhoto.get(Number(req.params.id));
 if(!photo)return res.status(404).json({error:'Фотография не найдена'});
 if(await contestPhotoMutationLocked(photo))return res.status(409).json({error:'Голосование началось или завершено. Конкурсное фото уже нельзя изменять.'});
 db.prepare('UPDATE photos SET status=? WHERE id=?').run(status,photo.id);
 res.json({ok:true});
}));
app.delete('/api/admin/photos/:id', adminAuth, requireAction, asyncRoute(async (req,res) => {
  const item = selectPhoto.get(Number(req.params.id));
  if (!item) return res.status(404).json({error:'Фотография не найдена'});
  if(await contestPhotoMutationLocked(item))return res.status(409).json({error:'Нельзя удалить конкурсное фото после начала голосования либо из архива победителей.'});
  db.prepare('DELETE FROM photos WHERE id=?').run(item.id);
  await Promise.all([
    fsp.unlink(path.join(PHOTOS,item.filename)).catch(()=>{}),
    fsp.unlink(path.join(THUMBS,item.filename)).catch(()=>{})
  ]);
  res.json({ok:true});
}));
async function cleanup() {
  // An interrupted upload may leave a temporary file behind.
  const leftovers = await fsp.readdir(UPLOADS,{withFileTypes:true});
  for (const item of leftovers) {
    if (!item.isFile() || !item.name.endsWith('.tmp')) continue;
    const filename = path.join(UPLOADS,item.name);
    try {
      const stat = await fsp.stat(filename);
      if (Date.now()-stat.mtimeMs > 2*3600000) await fsp.unlink(filename);
    } catch (error) {
      if (error.code!=='ENOENT') console.warn('Temporary file cleanup failed',error.message);
    }
  }
  // Only finalists retain their original approved images for the permanent
  // results archive. Ordinary photos follow configured retention and expire.
  const protectedIds=reservedWinnerPhotoIds();
  // Never expire ballots' contestant images while their competition is
  // unfinished, including a club PC outage spanning the normal retention
  // period. Otherwise a delayed result could finalize an empty contest.
  const inProgressIds=new Set(db.prepare(
   "SELECT p.id FROM photos p JOIN contest_settings s ON s.event_id=p.event_id "+
   "WHERE p.photo_area='contest' AND s.enabled=1 AND s.finalized_at IS NULL"
  ).all().map(row=>row.id));
  const old = db.prepare('SELECT id,filename FROM photos WHERE created_at < ?').all(Date.now()-RETENTION_DAYS*86400000)
   .filter(item=>!protectedIds.has(item.id)&&!inProgressIds.has(item.id));
  for (const item of old) {
    db.prepare('DELETE FROM photos WHERE id=?').run(item.id);
    await Promise.all([
      fsp.unlink(path.join(PHOTOS,item.filename)).catch(()=>{}),
      fsp.unlink(path.join(THUMBS,item.filename)).catch(()=>{})
    ]);
  }
  if (old.length) console.log('Expired photos removed:',old.length);
  // A crash can happen between saving a processed file and its DB INSERT,
  // or between deleting its DB row and unlinking the file. Reconcile both
  // directories against committed records after a conservative grace period.
  const known = new Set(db.prepare('SELECT filename FROM photos').all().map(p=>p.filename));
  for (const directory of [PHOTOS,THUMBS]) {
    const entries = await fsp.readdir(directory,{withFileTypes:true});
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.webp') || known.has(entry.name)) continue;
      const fullPath = path.join(directory,entry.name);
      try {
        const stat = await fsp.stat(fullPath);
        if (Date.now()-stat.mtimeMs > 2*3600000) await fsp.unlink(fullPath);
      } catch(error) {
        if(error.code!=='ENOENT') console.warn('Photo file cleanup failed',error.message);
      }
    }
  }
}
cleanup().catch(console.error);
setInterval(()=>finalizeContest().catch(console.error),2000).unref();
// Independent poll continues even when the browser/LED screen is closed.
// Scheduled Telegram runs can therefore start after the Windows PC comes online.
setInterval(()=>synchronizeBroadcast().catch(e=>console.warn('Broadcast sync:',e.message)),2500).unref();
void synchronizeBroadcast().catch(e=>console.warn('Broadcast startup:',e.message));
// Pull the cloud escrow after boot and while the computer is online. Cloudflare
// pushes queued bytes only to this site's verified public HTTPS hostname.
let draining=false;
let lastQueueSync={running:false,checkedAtMs:null,ok:null,delivered:0,failed:0,reason:null};
async function drainQueuedPhotos(){
 if(draining)return lastQueueSync;
 draining=true;
 lastQueueSync={...lastQueueSync,running:true,checkedAtMs:Date.now()};
 try{
  const response=await fetch('https://app.baliminsk.by/api/tg-bali/photo-contest-queue-drain',{
   method:'POST',redirect:'error',headers:{Accept:'application/json'},
   signal:AbortSignal.timeout(65000)});
  const status=await response.json().catch(()=>({}));
  lastQueueSync={running:false,checkedAtMs:Date.now(),ok:response.ok&&status.ok===true,
   delivered:Number(status.delivered)||0,failed:Number(status.failed)||0,
   reason:response.ok?(status.lastError||status.error||null):'Cloudflare HTTP '+response.status};
  if(lastQueueSync.delivered)console.log('Photos from cloud queue:',lastQueueSync.delivered);
  if(lastQueueSync.failed||!lastQueueSync.ok)
   console.warn('Photo queue delivery:',lastQueueSync.reason||('Errors: '+lastQueueSync.failed));
 }catch(error){
  lastQueueSync={running:false,checkedAtMs:Date.now(),ok:false,delivered:0,failed:0,
   reason:'Не удалось связаться с облачной очередью: '+(error?.message||'таймаут')};
  console.warn('Photo queue sync postponed:',error.message);
 }finally{draining=false}
 return lastQueueSync;
}
// Show the real Cloudflare queue for each BALI Event ID even when the
// outbound server cannot currently complete a PHOTO WALL upload.
let queueSummaryCache={until:0,value:null};
async function cloudQueueSummary(){
 if(Date.now()<queueSummaryCache.until)return queueSummaryCache.value;
 let value=null;
 try{
  const response=await fetch('https://app.baliminsk.by/api/tg-bali/photo-contest-queue-summary',{
   redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(3500)});
  const body=await response.json().catch(()=>null);
  if(response.ok&&body?.ok===true)value={waiting:body.waiting,events:body.events,hasMore:body.hasMore};
 }catch{}
 queueSummaryCache={until:Date.now()+10000,value};
 return value;
}
app.get('/api/admin/contest/cloud-queue',adminAuth,asyncRoute(async(_req,res)=>{
 res.json({ok:true,...lastQueueSync,cloud:await cloudQueueSummary()});
}));
app.post('/api/admin/contest/cloud-queue/retry',adminAuth,requireAction,(_req,res)=>{
 if(draining)return res.json({ok:true,started:false,...lastQueueSync});
 void drainQueuedPhotos().catch(error=>console.warn('Cloud queue retry:',error.message));
 res.status(202).json({ok:true,started:true});
});
setTimeout(()=>drainQueuedPhotos().catch(console.error),3000).unref();
setInterval(()=>drainQueuedPhotos().catch(console.error),45000).unref();
setInterval(()=>ensureTelegramContest().catch(console.error),30000).unref();
setInterval(()=>cleanup().catch(console.error),3600000).unref();
app.use((err,req,res,_next) => {
  console.error('Request error:',err.message);
  if (err.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'Размер файла превышает 8 МБ'});
  if (err instanceof multer.MulterError) return res.status(400).json({error:'Ошибка загрузки файла'});
  res.status(500).json({error:'Не удалось обработать запрос'});
});
app.listen(PORT,HOST,()=>console.log('BALI PHOTO WALL:',`http://${HOST}:${PORT}`));
