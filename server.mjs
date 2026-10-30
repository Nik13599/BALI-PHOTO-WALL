import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {contestClock,minskDay,isContestDate,eligiblePartyDay} from './contest-clock.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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

const clockFields=db.pragma('table_info(contest_settings)').map(x=>x.name);
for(const [name,definition] of [
 ['contest_date',"TEXT NOT NULL DEFAULT ''"],
 ['voting_start',"TEXT NOT NULL DEFAULT '01:00'"],
 ['voting_end',"TEXT NOT NULL DEFAULT '03:00'"],
 ['bali_event_id',"TEXT NOT NULL DEFAULT ''"],
 ['winner_photo_id','INTEGER'],
 ['winner_votes','INTEGER NOT NULL DEFAULT 0'],
 ['total_votes','INTEGER NOT NULL DEFAULT 0'],
 ['finalized_at','INTEGER']
])if(!clockFields.includes(name))db.exec('ALTER TABLE contest_settings ADD COLUMN '+name+' '+definition);
const contestRow=id=>db.prepare('SELECT * FROM contest_settings WHERE event_id=?').get(id);
const contestSettings=id=>contestRow(id)||{
 event_id:id,enabled:0,voting_open:0,contest_date:minskDay(Date.now()+86400000),
 voting_start:'01:00',voting_end:'03:00',bali_event_id:'',
 winner_photo_id:null,winner_votes:0,total_votes:0,finalized_at:null
};
const eligibleCandidates=id=>db.prepare("SELECT c.photo_id AS photoId,c.name,c.category,c.registered_at AS registeredAt,p.status FROM contest_candidates c JOIN photos p ON p.id=c.photo_id AND p.event_id=c.event_id WHERE c.event_id=? AND p.status='approved' ORDER BY c.registered_at,c.photo_id LIMIT 300").all(id);
let finalizing=null,lastTallyError='',lastTallyAttempt=0;
async function finalizeContest(){
 if(finalizing)return finalizing;
 const event=currentEvent.get();
 if(!event)return;
 const settings=contestRow(event.id);
 if(!settings||contestClock(settings).phase!=='closed'||settings.finalized_at)return;
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
  const winner=ranked[0]?.votes>0?ranked[0]:null;
  db.prepare('UPDATE contest_settings SET winner_photo_id=?,winner_votes=?,total_votes=?,finalized_at=?,voting_open=0,updated_at=? WHERE event_id=? AND finalized_at IS NULL')
   .run(winner?.photoId||null,winner?.votes||0,total,Date.now(),Date.now(),event.id);
  lastTallyError='';
 })().catch(error=>{lastTallyError=String(error.message||error);console.error('Contest tally retry:',lastTallyError)})
  .finally(()=>{finalizing=null});
 return finalizing;
}
const currentEvent = db.prepare('SELECT id,name,upload_shape FROM events WHERE active=1 ORDER BY id DESC LIMIT 1');
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
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'"], scriptSrc: ["'self'"],
      connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      baseUri: ["'self'"], formAction: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api', (_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
app.use(express.static(path.join(ROOT, 'public'), { index: false, dotfiles: 'deny', maxAge: '15m' }));
app.get('/', (req, res) => { guestIdentity(req,res); res.sendFile(path.join(ROOT,'public','guest.html')); });
app.get('/admin', (_req,res) => res.sendFile(path.join(ROOT,'public','admin.html')));
app.get('/screen', (_req,res) => res.sendFile(path.join(ROOT,'public','screen.html')));
app.get('/healthz', (_req,res) => res.json({ok:true}));

app.get('/api/public', (req,res) => {
  guestIdentity(req,res);
  const event = currentEvent.get();
  res.json({ event, uploadShape:event?.upload_shape||'any', limit:null });
});
// Public contest feed for Telegram Mini App. Approved nominations only.
// Never return upload tokens, guest identifiers, source filenames or staff data.
app.get('/api/contest/status',asyncRoute(async(_req,res)=>{
 await finalizeContest();
 const event=currentEvent.get(),settings=event?contestSettings(event.id):null;
 const clock=contestClock(settings),enabled=!!event&&settings.enabled===1&&clock.phase!=='disabled';
 const rows=enabled?eligibleCandidates(event.id):[];
 const voting=clock.phase==='voting'&&rows.length>0;
 const base=PUBLIC_URL.startsWith('https://baliminsk.online')?PUBLIC_URL:'https://baliminsk.online';
 const winner=settings?.finalized_at&&settings.winner_photo_id?rows.find(x=>x.photoId===settings.winner_photo_id):null;
 res.json({contest_available:enabled,contest_id:enabled?'event_'+event.id:null,
  phase:clock.phase,contest_date:settings?.contest_date||null,bali_event_id:settings?.bali_event_id||null,
  server_now:Date.now(),registration_open:clock.phase==='registration',
  registration_ends_at:clock.registrationEndsAt,voting_starts_at:clock.votingStartsAt,
  voting_ends_at:clock.votingEndsAt,voting_open:voting,
  result_pending:clock.phase==='closed'&&!settings.finalized_at,
  winner:winner?{id:'p_'+winner.photoId,name:winner.name,
   photoUrl:base+'/api/contest/photo/p_'+winner.photoId,votes:settings.winner_votes}:null,
  candidates:voting?rows.map(x=>({id:'p_'+x.photoId,name:x.name,category:'king',
   photoUrl:base+'/api/contest/photo/p_'+x.photoId})):[]});
}));

app.get('/qr.svg', asyncRoute(async (_req, res) => {
  const svg = await QRCode.toString(PUBLIC_URL + '/', { type: 'svg', margin: 1, width: 320, color: {dark:'#111111',light:'#ffffff'} });
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
  const event = currentEvent.get();
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
      .webp({quality:77,effort:4}).toBuffer();
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
  const filename = crypto.randomUUID() + '.webp';
  const thumbnail = await sharp(processed).resize({width:360,height:360,fit:'inside',withoutEnlargement:true}).webp({quality:65}).toBuffer();
  const discardProcessed = () => Promise.all([
    fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{}),
    fsp.unlink(path.join(THUMBS,filename)).catch(()=>{})
  ]);
  try {
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
    !/^@[A-Za-z0-9_]{5,32}$/.test(proof.username||''))
   return res.status(401).json({error:'Подтверждение истекло. Попробуй отправить фото снова.'});
 const event=currentEvent.get();
 if(!event)return res.status(409).json({error:'Сейчас нет активной вечеринки на PHOTO WALL'});
 const setting=contestSettings(event.id);
 if(contestClock(setting).phase!=='registration')
  return res.status(409).json({error:'Приём конкурсных фото закрыт по расписанию'});
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
 const filename=crypto.randomUUID()+'.webp';
 const thumbnail=await sharp(processed).resize({width:360,height:360,fit:'inside',withoutEnlargement:true})
  .webp({quality:65}).toBuffer();
 const cleanup=()=>Promise.all([fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{}),fsp.unlink(path.join(THUMBS,filename)).catch(()=>{})]);
 try{
  await fsp.writeFile(path.join(PHOTOS,filename),processed,{flag:'wx'});
  await fsp.writeFile(path.join(THUMBS,filename),thumbnail,{flag:'wx'});
  const insert=db.transaction(()=>{
   const now=Date.now();
   if(currentEvent.get()?.id!==event.id||contestClock(contestSettings(event.id)).phase!=='registration')throw Error('event-changed');
   if(db.prepare('SELECT 1 FROM contest_telegram_entries WHERE event_id=? AND bali_uid=?').get(event.id,proof.uid))
     throw Error('already-registered');
   const id=db.prepare("INSERT INTO photos(event_id,filename,guest_id,status,created_at,width,height) VALUES(?,?,?,'pending',?,?,?)")
     .run(event.id,filename,'contest:'+crypto.randomUUID(),now,dimension.width,dimension.height).lastInsertRowid;
   db.prepare('INSERT INTO contest_telegram_entries(event_id,bali_uid,bali_event_id,photo_id,telegram_username,registered_at) VALUES(?,?,?,?,?,?)')
     .run(event.id,proof.uid,proof.eventId,id,proof.username,now);
   // One royal nomination, legacy DB category uses "king" internally.
   db.prepare('INSERT INTO contest_candidates(photo_id,event_id,name,category,registered_at) VALUES(?,?,?,?,?)')
     .run(id,event.id,proof.name,'king',now);
   return id;
  });
  const id=insert();
  return res.status(201).json({ok:true,id,status:'pending',message:'Фото отправлено на модерацию конкурса'});
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
 const event=currentEvent.get();
 if(!event)return res.status(404).end();
 const row=db.prepare("SELECT p.* FROM photos p "+
  "JOIN contest_candidates c ON c.photo_id=p.id AND c.event_id=p.event_id "+
  "JOIN contest_settings s ON s.event_id=p.event_id "+
  "WHERE p.id=? AND p.event_id=? AND p.status='approved' AND s.enabled=1")
  .get(Number(match[1]),event.id);
 const settings=contestSettings(event.id),clock=contestClock(settings);
 if(clock.phase!=='voting'&&!(settings.finalized_at&&settings.winner_photo_id===Number(match[1])))
  return res.status(404).end();
 return servePhoto(row,res);
});
app.get('/api/photos/:id', screenAuth, (req,res) => servePhoto(selectPhoto.get(Number(req.params.id)),res));
// Keep LED transfers bounded. The newest 500 approved photos are enough
// for a full mosaic, and database size is not an app-level upload quota.
app.get('/api/screen', screenAuth, asyncRoute(async (_req,res) => {
  const event = currentEvent.get();
  const photos = event ? db.prepare("SELECT id,created_at,width,height,filename,screen_lane FROM photos p WHERE event_id=? AND status='approved' AND NOT EXISTS (SELECT 1 FROM contest_candidates c WHERE c.photo_id=p.id) ORDER BY created_at DESC,id DESC LIMIT 500").all(event.id) : [];
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
 await finalizeContest();
 const event=currentEvent.get(),settings=event?contestSettings(event.id):null;
 const phase=contestClock(settings).phase;
 const candidates=event?eligibleCandidates(event.id):[];
 const winner=phase==='closed'&&settings?.finalized_at?
  candidates.find(c=>c.photoId===settings.winner_photo_id):null;
 const visible=phase==='closed'?(winner?[winner]:[]):candidates;
 const photos=visible.slice(0,500).map(c=>
  db.prepare('SELECT id,created_at,width,height,screen_lane FROM photos WHERE id=?').get(c.photoId)).filter(Boolean);
 res.json({event,photos,phase,finalized:!!settings?.finalized_at,
  winner:winner?{id:winner.photoId,name:winner.name,votes:settings.winner_votes,
   totalVotes:settings.total_votes}:null,
  resultError:phase==='closed'&&!settings?.finalized_at?'Ожидаем подтверждённые голоса BALI':null});
}));
// Only approved photos may appear in the LED mosaic, even as thumbnails.
// Unapproved originals remain accessible to the moderator only.
app.get('/api/screen/thumbnail/:id', screenAuth, (req,res) => {
  const photo = selectPhoto.get(Number(req.params.id));
  if(!photo || photo.status!=='approved')return res.status(404).end();
  const thumbnail=path.join(THUMBS,photo.filename);
  const original=path.join(PHOTOS,photo.filename);
  res.set('Cache-Control','private,no-store');
  res.type('image/webp').sendFile(fs.existsSync(thumbnail)?thumbnail:original);
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
  limits:{fileSize:8*1024*1024,files:8,fields:3,parts:11}
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
    const status=req.body?.status==='pending'?'pending':'approved';
    const lane=['top','bottom'].includes(req.body?.lane)?req.body.lane:'auto';
    const results=[];
    const insert=db.prepare('INSERT INTO photos(event_id,filename,guest_id,status,created_at,width,height,screen_lane) VALUES (?,?,?,?,?,?,?,?)');
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
        filename=crypto.randomUUID()+'.webp';
        await fsp.writeFile(path.join(PHOTOS,filename),image,{flag:'wx'});
        await fsp.writeFile(path.join(THUMBS,filename),thumbnail,{flag:'wx'});
        const record=insert.run(event.id,filename,'moderator-import',status,Date.now(),size.width,size.height,lane);
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
 res.json({ok:true,event,
  settings:{enabled:!!settings.enabled,contestDate:settings.contest_date,
   votingStart:settings.voting_start,votingEnd:settings.voting_end,
   baliEventId:settings.bali_event_id,phase:clock.phase,
   votingOpen:clock.phase==='voting',finalizedAt:settings.finalized_at,
   winnerPhotoId:settings.winner_photo_id,winnerVotes:settings.winner_votes,
   totalVotes:settings.total_votes,registrationEndsAt:clock.registrationEndsAt,
   votingEndsAt:clock.votingEndsAt,tallyError:lastTallyError},candidates});
}));
app.post('/api/admin/contest/settings',adminAuth,requireAction,(req,res)=>{
 const i=req.body||{},id=Number(i.eventId);
 if(!Number.isSafeInteger(id)||id<1||typeof i.enabled!=='boolean'||
  !isContestDate(i.contestDate)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(i.votingStart)||
  !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.votingEnd)||
  i.votingEnd<=i.votingStart||typeof i.baliEventId!=='string'||
  (i.baliEventId!==''&&!/^\d{4}-\d{2}-\d{2}(?:__(?:2|3))?$/.test(i.baliEventId))||
  Object.keys(i).sort().join(',')!=='baliEventId,contestDate,enabled,eventId,votingEnd,votingStart')
  return res.status(400).json({error:'Укажи дату, время открытия и закрытия голосования (по Минску)'});
 if(!db.prepare('SELECT 1 FROM events WHERE id=?').get(id))
  return res.status(404).json({error:'Мероприятие не найдено'});
 if(i.baliEventId&&!eligiblePartyDay(i.baliEventId,i.contestDate))
  return res.status(400).json({error:'BALI Event ID должен относиться к дате конкурса или предыдущему дню'});
 const previous=contestRow(id);
 if(previous?.enabled===1&&contestClock(previous).phase!=='registration'&&
   (previous.contest_date!==i.contestDate||previous.voting_start!==i.votingStart||previous.voting_end!==i.votingEnd||
    previous.enabled!==Number(i.enabled)||previous.bali_event_id!==i.baliEventId))
  return res.status(409).json({error:'После начала голосования расписание заблокировано. Для теста создай новое мероприятие.'});
 db.prepare('INSERT INTO contest_settings(event_id,enabled,voting_open,contest_date,voting_start,voting_end,bali_event_id,updated_at) VALUES(?,?,?,?,?,?,?,?) '+
  'ON CONFLICT(event_id) DO UPDATE SET enabled=excluded.enabled,voting_open=0,contest_date=excluded.contest_date,voting_start=excluded.voting_start,voting_end=excluded.voting_end,bali_event_id=excluded.bali_event_id,updated_at=excluded.updated_at')
  .run(id,Number(i.enabled),0,i.contestDate,i.votingStart,i.votingEnd,i.baliEventId,Date.now());
 res.json({ok:true,phase:contestClock(contestSettings(id)).phase});
});
app.post('/api/admin/contest/candidates',adminAuth,requireAction,(req,res)=>{
 const input=req.body||{},eventId=Number(input.eventId),photoId=Number(input.photoId);
 if(!Number.isSafeInteger(eventId)||eventId<1||!Number.isSafeInteger(photoId)||photoId<1||
   !['add','remove'].includes(input.action)||
   Object.keys(input).some(k=>!['eventId','photoId','name','category','action'].includes(k)))
  return res.status(400).json({error:'Некорректные данные участника'});
 const photo=db.prepare('SELECT id,status FROM photos WHERE id=? AND event_id=?').get(photoId,eventId);
 if(!photo)return res.status(404).json({error:'Фотография не найдена в мероприятии'});
 if(contestClock(contestSettings(eventId)).phase!=='registration')
   return res.status(409).json({error:'Список участников закрыт с началом голосования'});
 if(input.action==='add'){
  const name=typeof input.name==='string'?input.name.trim():'';
  if(name.length<2||name.length>70||/[<>\u0000-\u001f\u007f]/.test(name)||
     !['king','queen'].includes(input.category)||photo.status!=='approved')
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
});
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
app.get('/api/admin/dashboard', adminAuth, (req,res) => {
  const events = db.prepare('SELECT id,name,active,created_at,upload_shape FROM events ORDER BY id DESC').all();
  const active = currentEvent.get();
  const requested = req.query.eventId;
  const selected = requested === undefined ? active
    : (typeof requested === 'string' && /^\d+$/.test(requested)
      ? db.prepare('SELECT id,name,upload_shape FROM events WHERE id=?').get(Number(requested)) : null);
  if (requested !== undefined && !selected) return res.status(404).json({error:'Мероприятие не найдено'});
  const PAGE_SIZE = 48;
  const rawPage = req.query.page ?? '1';
  if (typeof rawPage !== 'string' || !/^[1-9][0-9]{0,5}$/.test(rawPage)) {
    return res.status(400).json({error:'Неверный номер страницы'});
  }
  const total = selected ? db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id=?').get(selected.id).n : 0;
  const pages = Math.max(1,Math.ceil(total/PAGE_SIZE));
  const page = Math.min(Number(rawPage),pages);
  const photos = selected ? db.prepare('SELECT p.id,p.status,p.created_at,p.screen_lane,CASE WHEN c.photo_id IS NULL THEN 0 ELSE 1 END AS contest FROM photos p LEFT JOIN contest_candidates c ON c.photo_id=p.id WHERE p.event_id=? ORDER BY CASE p.status WHEN ? THEN 0 ELSE 1 END,p.created_at DESC,p.id DESC LIMIT ? OFFSET ?')
    .all(selected.id,'pending',PAGE_SIZE,(page-1)*PAGE_SIZE) : [];
  res.json({events,active,selected,photos,page,pages,total,pageSize:PAGE_SIZE});
});
const makeEvent = db.transaction(name => {
  db.prepare('UPDATE events SET active=0').run();
  return db.prepare('INSERT INTO events(name,active,created_at) VALUES (?,1,?)').run(name,Date.now()).lastInsertRowid;
});
app.post('/api/admin/events', adminAuth, requireAction, (req,res) => {
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
app.post('/api/admin/photos/:id/status', adminAuth, requireAction, (req,res) => {
  const status = req.body?.status;
  if (!['approved','rejected','pending'].includes(status)) return res.status(400).json({error:'Неизвестный статус'});
  const result = db.prepare('UPDATE photos SET status=? WHERE id=?').run(status,Number(req.params.id));
  if (!result.changes) return res.status(404).json({error:'Фотография не найдена'});
  res.json({ok:true});
});
app.delete('/api/admin/photos/:id', adminAuth, requireAction, asyncRoute(async (req,res) => {
  const item = selectPhoto.get(Number(req.params.id));
  if (!item) return res.status(404).json({error:'Фотография не найдена'});
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
  const old = db.prepare('SELECT id,filename FROM photos WHERE created_at < ?').all(Date.now()-RETENTION_DAYS*86400000);
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
setInterval(()=>cleanup().catch(console.error),3600000).unref();
app.use((err,req,res,_next) => {
  console.error('Request error:',err.message);
  if (err.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'Размер файла превышает 8 МБ'});
  if (err instanceof multer.MulterError) return res.status(400).json({error:'Ошибка загрузки файла'});
  res.status(500).json({error:'Не удалось обработать запрос'});
});
app.listen(PORT,HOST,()=>console.log('BALI PHOTO WALL:',`http://${HOST}:${PORT}`));
