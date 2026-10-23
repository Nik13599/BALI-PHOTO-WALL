import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PHOTOS = path.join(DATA, 'photos');
const UPLOADS = path.join(DATA, 'temporary-uploads');
fs.mkdirSync(PHOTOS, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

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
const RETENTION_DAYS = Math.min(90, Math.max(1, Number(process.env.RETENTION_DAYS || 7)));
const db = new Database(path.join(DATA, 'bali-photo-wall.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
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
const currentEvent = db.prepare('SELECT id,name FROM events WHERE active=1 ORDER BY id DESC LIMIT 1');
const selectPhoto = db.prepare('SELECT * FROM photos WHERE id=?');
const secureEqual = (a, b) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const mac = value => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
const signed = value => value + '.' + mac(value);
function checked(value) {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const data = value.slice(0, dot);
  return secureEqual(mac(data), value.slice(dot + 1)) ? data : null;
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
  return { httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge };
}
function guestIdentity(req, res) {
  const id = checked(cookies(req).bali_guest);
  if (id && /^[a-f0-9-]{36}$/.test(id)) return id;
  const fresh = crypto.randomUUID();
  res.cookie('bali_guest', signed(fresh), cookieOptions(req, 30 * 86400000));
  return fresh;
}
function validSession(req, name) {
  const raw = checked(cookies(req)[name]);
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
  res.json({ event, limit: 3 });
});
app.get('/qr.svg', asyncRoute(async (_req, res) => {
  const svg = await QRCode.toString(PUBLIC_URL + '/', { type: 'svg', margin: 1, width: 320, color: {dark:'#111111',light:'#ffffff'} });
  res.type('image/svg+xml').set('Cache-Control','public,max-age=600').send(svg);
}));

const uploadLimiter = rateLimit({windowMs:3600000,limit:1500,standardHeaders:'draft-8',legacyHeaders:false});
const upload = multer({ storage:multer.diskStorage({
  destination: (_req,_file,cb) => cb(null, UPLOADS),
  filename: (_req,_file,cb) => cb(null, crypto.randomUUID() + '.tmp')
}), limits: {fileSize: 8*1024*1024, files:1, fields:2} });
// Clean up uploads even when the controller rejects a request.
app.use('/api/upload', (req,res,next) => {
  res.on('finish',()=> { if(req.file?.path) fsp.unlink(req.file.path).catch(()=>{}); });
  next();
});
app.post('/api/upload', uploadLimiter, upload.single('photo'), asyncRoute(async (req,res) => {
  const event = currentEvent.get();
  if (!event) return res.status(409).json({error:'Сейчас нет активного мероприятия'});
  if (req.body?.consent !== 'yes') return res.status(400).json({error:'Необходимо согласие на показ фотографии'});
  if (!req.file?.buffer) return res.status(400).json({error:'Выберите фотографию'});
  const guest = guestIdentity(req,res);
  const used = db.prepare('SELECT count(*) AS n FROM photos WHERE event_id=? AND guest_id=?').get(event.id,guest).n;
  if (used >= 3) return res.status(429).json({error:'Лимит: 3 фотографии за мероприятие'});
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
  const filename = crypto.randomUUID() + '.webp';
  await fsp.writeFile(path.join(PHOTOS,filename),processed,{flag:'wx'});
  try {
    const result = db.prepare('INSERT INTO photos(event_id,filename,guest_id,status,created_at) VALUES (?,?,?, ?,?)')
      .run(event.id,filename,guest,'pending',Date.now());
    res.status(201).json({id:result.lastInsertRowid,status:'pending',message:'Фото отправлено на проверку'});
  } catch (error) {
    await fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{});
    throw error;
  }
}));
const servePhoto = (row,res,privateView=false) => {
  if (!row || (!privateView && row.status !== 'approved')) return res.status(404).end();
  res.set('Cache-Control', privateView ? 'private,no-store' : 'public,max-age=300');
  return res.type('image/webp').sendFile(path.join(PHOTOS,row.filename));
};
app.get('/api/photos/:id', screenAuth, (req,res) => servePhoto(selectPhoto.get(Number(req.params.id)),res));
app.get('/api/screen', screenAuth, (_req,res) => {
  const event = currentEvent.get();
  const photos = event ? db.prepare("SELECT id,created_at FROM photos WHERE event_id=? AND status='approved' ORDER BY created_at DESC LIMIT 150").all(event.id) : [];
  res.json({event,photos});
});

const loginLimiter = rateLimit({windowMs:900000,limit:10,standardHeaders:'draft-8',legacyHeaders:false});
app.post('/api/screen/login', loginLimiter, (req,res) => {
  if (!verifyPassword(req.body?.password, SCREEN_PASSWORD)) return res.status(401).json({error:'Неверный пароль экрана'});
  res.cookie('bali_screen',signed(String(Date.now()+24*3600000)),cookieOptions(req,24*3600000));
  res.json({ok:true});
});
app.post('/api/admin/login', loginLimiter, (req,res) => {
  if (!verifyPassword(req.body?.password, PASSWORD)) return res.status(401).json({error:'Неверный пароль'});
  res.cookie('bali_admin',signed(String(Date.now()+12*3600000)),cookieOptions(req,12*3600000));
  res.json({ok:true});
});
app.post('/api/admin/logout', requireAction, (_req,res) => {
  res.clearCookie('bali_admin',{path:'/'});
  res.json({ok:true});
});
app.get('/api/admin/me', adminAuth, (_req,res) => res.json({ok:true}));
app.get('/api/admin/photos/:id', adminAuth, (req,res) => servePhoto(selectPhoto.get(Number(req.params.id)),res,true));
app.get('/api/admin/dashboard', adminAuth, (_req,res) => {
  const events = db.prepare('SELECT id,name,active,created_at FROM events ORDER BY id DESC LIMIT 100').all();
  const active = currentEvent.get();
  const photos = active ? db.prepare('SELECT id,status,created_at FROM photos WHERE event_id=? ORDER BY CASE status WHEN ? THEN 0 ELSE 1 END,created_at DESC LIMIT 250')
    .all(active.id,'pending') : [];
  res.json({events,active,photos});
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
app.post('/api/admin/events/:id/activate', adminAuth, requireAction, (req,res) => {
  if (!activateEvent(Number(req.params.id))) return res.status(404).json({error:'Мероприятие не найдено'});
  res.json({ok:true});
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
  await fsp.unlink(path.join(PHOTOS,item.filename)).catch(()=>{});
  res.json({ok:true});
}));
async function cleanup() {
  const old = db.prepare('SELECT id,filename FROM photos WHERE created_at < ?').all(Date.now()-RETENTION_DAYS*86400000);
  for (const item of old) {
    db.prepare('DELETE FROM photos WHERE id=?').run(item.id);
    await fsp.unlink(path.join(PHOTOS,item.filename)).catch(()=>{});
  }
  if (old.length) console.log('Expired photos removed:',old.length);
}
cleanup().catch(console.error);
setInterval(()=>cleanup().catch(console.error),3600000).unref();
app.use((err,req,res,_next) => {
  console.error('Request error:',err.message);
  if (err.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'Размер файла превышает 8 МБ'});
  if (err instanceof multer.MulterError) return res.status(400).json({error:'Ошибка загрузки файла'});
  res.status(500).json({error:'Не удалось обработать запрос'});
});
app.listen(PORT,HOST,()=>console.log('BALI PHOTO WALL:',`http://${HOST}:${PORT}`));
