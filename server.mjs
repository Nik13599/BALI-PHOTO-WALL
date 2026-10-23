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
  const localHost = ['localhost','127.0.0.1','::1'].includes(req.hostname);
  // Keep HTTPS cookies Secure on the public domain while allowing a
  // localhost-only operator session on the club's own computer.
  return { httpOnly: true, secure: req.secure || (!localHost && process.env.NODE_ENV === 'production'), sameSite: 'strict', path: '/', maxAge };
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

const uploadLimiter = rateLimit({windowMs:3600000,limit:4000,standardHeaders:'draft-8',legacyHeaders:false});
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
app.post('/api/upload', uploadLimiter, upload.single('photo'), asyncRoute(async (req,res) => {
  const event = currentEvent.get();
  if (!event) return res.status(409).json({error:'Сейчас нет активного мероприятия'});
  if (req.body?.consent !== 'yes') return res.status(400).json({error:'Необходимо согласие на показ фотографии'});
  if (!req.file?.path) return res.status(400).json({error:'Выберите фотографию'});
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
  const thumbnail = await sharp(processed).resize({width:360,height:360,fit:'inside',withoutEnlargement:true}).webp({quality:65}).toBuffer();
  const discardProcessed = () => Promise.all([
    fsp.unlink(path.join(PHOTOS,filename)).catch(()=>{}),
    fsp.unlink(path.join(THUMBS,filename)).catch(()=>{})
  ]);
  try {
    await fsp.writeFile(path.join(PHOTOS,filename),processed,{flag:'wx'});
    await fsp.writeFile(path.join(THUMBS,filename),thumbnail,{flag:'wx'});
    // The final count check and INSERT execute as one SQLite statement. Four
    // simultaneous requests from one browser can never exceed three rows.
    const result = db.prepare(`INSERT INTO photos(event_id,filename,guest_id,status,created_at)
      SELECT ?, ?, ?, 'pending', ?
      WHERE (SELECT COUNT(*) FROM photos WHERE event_id=? AND guest_id=?) < 3`)
      .run(event.id,filename,guest,Date.now(),event.id,guest);
    if (!result.changes) {
      await discardProcessed();
      return res.status(429).json({error:'Лимит: 3 фотографии за мероприятие'});
    }
    res.status(201).json({id:result.lastInsertRowid,status:'pending',message:'Фото отправлено на проверку'});
  } catch (error) {
    await discardProcessed();
    throw error;
  }
}));
const servePhoto = (row,res,privateView=false,fullView=false) => {
  if (!row || (!privateView && row.status !== 'approved')) return res.status(404).end();
  res.set('Cache-Control', 'private,no-store');
  const filename = privateView && !fullView && fs.existsSync(path.join(THUMBS,row.filename))
    ? path.join(THUMBS,row.filename) : path.join(PHOTOS,row.filename);
  return res.type('image/webp').sendFile(filename);
};
app.get('/api/photos/:id', screenAuth, (req,res) => servePhoto(selectPhoto.get(Number(req.params.id)),res));
app.get('/api/screen', screenAuth, (_req,res) => {
  const event = currentEvent.get();
  const photos = event ? db.prepare("SELECT id,created_at FROM photos WHERE event_id=? AND status='approved' ORDER BY created_at DESC,id DESC").all(event.id) : [];
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
app.get('/api/admin/photos/:id', adminAuth, (req,res) => servePhoto(selectPhoto.get(Number(req.params.id)),res,true,req.query.full==='1'));
app.get('/api/admin/dashboard', adminAuth, (req,res) => {
  const events = db.prepare('SELECT id,name,active,created_at FROM events ORDER BY id DESC LIMIT 100').all();
  const active = currentEvent.get();
  const requested = req.query.eventId;
  const selected = requested === undefined ? active
    : (typeof requested === 'string' && /^\d+$/.test(requested)
      ? db.prepare('SELECT id,name FROM events WHERE id=?').get(Number(requested)) : null);
  if (requested !== undefined && !selected) return res.status(404).json({error:'Мероприятие не найдено'});
  const PAGE_SIZE = 48;
  const rawPage = req.query.page ?? '1';
  if (typeof rawPage !== 'string' || !/^[1-9][0-9]{0,5}$/.test(rawPage)) {
    return res.status(400).json({error:'Неверный номер страницы'});
  }
  const total = selected ? db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id=?').get(selected.id).n : 0;
  const pages = Math.max(1,Math.ceil(total/PAGE_SIZE));
  const page = Math.min(Number(rawPage),pages);
  const photos = selected ? db.prepare('SELECT id,status,created_at FROM photos WHERE event_id=? ORDER BY CASE status WHEN ? THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT ? OFFSET ?')
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
