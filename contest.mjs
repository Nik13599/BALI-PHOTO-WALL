// Independent King & Queen of the Night competition module for BALI PHOTO WALL.
// Guest photos and competition entries intentionally use different storage and tables.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import rateLimit from 'express-rate-limit';

const SHAPES={square:[1,1],portrait:[9,16],landscape:[16,9]};
const positiveId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const error=(res,status,message)=>res.status(status).json({error:message});
const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)));
const now=()=>Date.now();

export function registerContestRoutes({app,db,DATA,UPLOADS,adminAuth,screenAuth,requireAction,asyncRoute}) {
  const directory=path.join(DATA,'contest');
  fs.mkdirSync(directory,{recursive:true});
  db.exec(
    "CREATE TABLE IF NOT EXISTS contests ("+
    "id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),"+
    "title TEXT NOT NULL DEFAULT 'КОРОЛЬ И КОРОЛЕВА НОЧИ',"+
    "prize_places INTEGER NOT NULL DEFAULT 3 CHECK(prize_places IN (1,3)),"+
    "shape TEXT NOT NULL DEFAULT 'square' CHECK(shape IN ('square','portrait','landscape')),"+
    "tile_height INTEGER NOT NULL DEFAULT 240,tile_speed INTEGER NOT NULL DEFAULT 80,"+
    "duration_seconds INTEGER NOT NULL DEFAULT 600,"+
    "state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','live','complete')),"+
    "started_at INTEGER,ends_at INTEGER,finished_at INTEGER,created_at INTEGER NOT NULL);"+
    "CREATE TABLE IF NOT EXISTS contest_entries ("+
    "id INTEGER PRIMARY KEY AUTOINCREMENT,contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,"+
    "external_id TEXT NOT NULL,display_name TEXT NOT NULL,filename TEXT NOT NULL UNIQUE,"+
    "crop_filename TEXT,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),"+
    "created_at INTEGER NOT NULL,UNIQUE(contest_id,external_id));"+
    "CREATE INDEX IF NOT EXISTS contest_entries_status ON contest_entries(contest_id,status);"+
    "CREATE TABLE IF NOT EXISTS contest_votes ("+
    "contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,"+
    "entry_id INTEGER NOT NULL REFERENCES contest_entries(id) ON DELETE CASCADE,"+
    "voter_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(contest_id,voter_hash));"+
    "CREATE INDEX IF NOT EXISTS contest_votes_entry ON contest_votes(entry_id);"+
    "CREATE TABLE IF NOT EXISTS contest_winners ("+
    "contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,"+
    "entry_id INTEGER NOT NULL REFERENCES contest_entries(id) ON DELETE CASCADE,"+
    "place INTEGER NOT NULL,votes INTEGER NOT NULL,PRIMARY KEY(contest_id,place),UNIQUE(contest_id,entry_id));"
  );
  // Local audit and image revision never leave the PHOTO WALL computer.
  // A revision changes image URLs in the LED and BALI-MENU voting gallery,
  // while keeping the same contestant, BALI Card, and voting number.
  const entryFields=db.pragma('table_info(contest_entries)').map(item=>item.name);
  if(!entryFields.includes('image_updated_at'))
    db.exec('ALTER TABLE contest_entries ADD COLUMN image_updated_at INTEGER NOT NULL DEFAULT 0');
  db.exec("CREATE TABLE IF NOT EXISTS contest_photo_moderation_log ("+
    "id INTEGER PRIMARY KEY AUTOINCREMENT,contest_id INTEGER NOT NULL,entry_id INTEGER NOT NULL,"+
    "action TEXT NOT NULL CHECK(action IN ('replace','approved','rejected','pending','crop')),"+
    "old_filename TEXT,new_filename TEXT,created_at INTEGER NOT NULL);"+
    "CREATE INDEX IF NOT EXISTS contest_photo_moderation_log_entry "+
    "ON contest_photo_moderation_log(contest_id,entry_id,created_at)");
  const audit=db.prepare('INSERT INTO contest_photo_moderation_log '+
    '(contest_id,entry_id,action,old_filename,new_filename,created_at) VALUES(?,?,?,?,?,?)');
  const selectActive=db.prepare("SELECT c.* FROM contests c JOIN events e ON e.id=c.event_id WHERE e.active=1 ORDER BY c.id DESC LIMIT 1");
  const selectById=db.prepare('SELECT * FROM contests WHERE id=?');
  const winnerList=db.prepare('SELECT w.entry_id AS id,w.place,w.votes,e.display_name FROM contest_winners w JOIN contest_entries e ON e.id=w.entry_id WHERE w.contest_id=? ORDER BY w.place');
  const entryById=db.prepare('SELECT * FROM contest_entries WHERE id=?');
  const ranked=db.prepare("SELECT e.id,COUNT(v.voter_hash) AS votes FROM contest_entries e LEFT JOIN contest_votes v ON v.entry_id=e.id WHERE e.contest_id=? AND e.status='approved' GROUP BY e.id ORDER BY votes DESC,e.created_at ASC,e.id ASC");
  const closeDue=db.transaction(()=>{
    // Production winners must come from the central BALI-MENU vote ledger.
    // Local ranking is retained only for isolated development tests.
    if(process.env.CONTEST_ALLOW_LOCAL_RESULTS!=='1')return;
    const contests=db.prepare("SELECT id,prize_places FROM contests WHERE state='live' AND ends_at<=?").all(now());
    for(const contest of contests){
      const rows=ranked.all(contest.id), total=rows.reduce((sum,row)=>sum+row.votes,0);
      // Never invent a winner when no one has voted.
      if(total>0){
        const award=db.prepare('INSERT INTO contest_winners(contest_id,entry_id,place,votes) VALUES (?,?,?,?)');
        rows.slice(0,contest.prize_places).forEach((row,index)=>award.run(contest.id,row.id,index+1,row.votes));
      }
      db.prepare("UPDATE contests SET state='complete',finished_at=? WHERE id=? AND state='live'").run(now(),contest.id);
    }
  });
  const finishDue=()=>{closeDue();return selectActive.get()||null;};
  setInterval(()=>{try{closeDue();}catch(err){console.error('Contest close failed:',err.message)}},1000).unref();

  // Only a trusted external registration/voting service may send applications and votes.
  // The key is transmitted in a header over HTTPS, never included in public pages.
  const bridgeKey=process.env.CONTEST_BRIDGE_KEY||'';
  const bridgeAuth=(req,res,next)=>{
    if(bridgeKey.length<32||bridgeKey.includes('CHANGE_'))return error(res,503,'Интеграция конкурса не настроена');
    const supplied=req.get('X-BALI-Bridge-Key')||'';
    const expected=crypto.createHash('sha256').update(bridgeKey).digest();
    const actual=crypto.createHash('sha256').update(supplied).digest();
    if(!crypto.timingSafeEqual(actual,expected))return error(res,401,'Недействительный ключ интеграции');
    next();
  };
  const integrationLimiter=rateLimit({windowMs:60000,limit:5000,standardHeaders:'draft-8',legacyHeaders:false});
  const upload=multer({
    storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,UPLOADS),filename:(_r,_f,cb)=>cb(null,crypto.randomUUID()+'.tmp')}),
    limits:{fileSize:8*1024*1024,files:1,fields:6}
  });

  function publicState(contest) {
    if(!contest)return {contest:null,entries:[],winners:[],serverNow:now()};
    const winners=winnerList.all(contest.id);
    const entries=contest.state==='live'
      ?db.prepare("SELECT id,display_name,image_updated_at AS imageRevision FROM contest_entries WHERE contest_id=? AND status='approved' ORDER BY id LIMIT 500").all(contest.id)
      :[];
    return {contest:{id:contest.id,title:contest.title,prizePlaces:contest.prize_places,shape:contest.shape,
      tileHeight:contest.tile_height,tileSpeed:contest.tile_speed,durationSeconds:contest.duration_seconds,
      state:contest.state==='live'&&now()>=contest.ends_at?'awaiting_results':contest.state,
      startsAt:contest.starts_at||null,
      startedAt:contest.started_at,endsAt:contest.ends_at,finishedAt:contest.finished_at},
      entries,winners,serverNow:now()};
  }
  app.get('/api/screen/contest',screenAuth,(_req,res)=>res.json(publicState(finishDue())));
  app.get('/api/screen/contest/photo/:id',screenAuth,(req,res)=>{
    const contest=finishDue(),entry=entryById.get(positiveId(req.params.id));
    if(!contest||!entry||entry.contest_id!==contest.id||entry.status!=='approved')return res.status(404).end();
    if(contest.state!=='live'&&!winnerList.all(contest.id).some(row=>row.id===entry.id))return res.status(404).end();
    res.set('Cache-Control','private,no-store').type('image/webp')
      .sendFile(path.join(directory,entry.crop_filename||entry.filename));
  });
  app.get('/api/admin/contest',adminAuth,(_req,res)=>{
    const contest=finishDue();
    if(!contest)return res.json({contest:null,entries:[],winners:[],counts:{pending:0,approved:0,rejected:0,votes:0}});
    const entries=db.prepare("SELECT e.id,e.external_id,e.card_id,e.display_name,e.status,e.created_at,e.crop_filename IS NOT NULL AS cropped,e.image_updated_at AS imageRevision,COUNT(v.voter_hash) AS votes FROM contest_entries e LEFT JOIN contest_votes v ON v.entry_id=e.id WHERE e.contest_id=? GROUP BY e.id ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,e.id DESC LIMIT 500").all(contest.id);
    const counts={pending:0,approved:0,rejected:0,votes:db.prepare('SELECT COUNT(*) AS n FROM contest_votes WHERE contest_id=?').get(contest.id).n};
    for(const item of entries)counts[item.status]++;
    res.json({...publicState(contest),entries,counts});
  });
  app.get('/api/admin/contest/photo/:id',adminAuth,(req,res)=>{
    const entry=entryById.get(positiveId(req.params.id));
    if(!entry)return res.status(404).end();
    const filename=req.query.original==='1'?entry.filename:(entry.crop_filename||entry.filename);
    res.set('Cache-Control','private,no-store').type('image/webp').sendFile(path.join(directory,filename));
  });
  app.post('/api/admin/contest/settings',adminAuth,requireAction,(req,res)=>{
    const active=db.prepare('SELECT id FROM events WHERE active=1 LIMIT 1').get();
    if(!active)return error(res,409,'Нет активного мероприятия');
    const prize=Number(req.body?.prizePlaces),shape=req.body?.shape;
    const tileHeight=Number(req.body?.tileHeight),tileSpeed=Number(req.body?.tileSpeed);
    const duration=Number(req.body?.durationSeconds);
    const title=typeof req.body?.title==='string'?req.body.title.trim():'';
    if(![1,3].includes(prize)||!Object.hasOwn(SHAPES,shape)||!Number.isInteger(tileHeight)||tileHeight<100||tileHeight>550||
      !Number.isInteger(tileSpeed)||tileSpeed<20||tileSpeed>250||!Number.isInteger(duration)||duration<60||duration>7200||
      title.length<5||title.length>90)return error(res,400,'Проверьте настройки конкурса');
    const old=db.prepare('SELECT * FROM contests WHERE event_id=?').get(active.id);
    if(old && old.state!=='draft')return error(res,409,'Изменять настройки можно до запуска конкурса');
    if(old)db.prepare('UPDATE contests SET title=?,prize_places=?,shape=?,tile_height=?,tile_speed=?,duration_seconds=? WHERE id=?')
      .run(title,prize,shape,tileHeight,tileSpeed,duration,old.id);
    else db.prepare('INSERT INTO contests(event_id,title,prize_places,shape,tile_height,tile_speed,duration_seconds,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(active.id,title,prize,shape,tileHeight,tileSpeed,duration,now());
    res.json({ok:true});
  });
  app.post('/api/admin/contest/entries/:id/status',adminAuth,requireAction,(req,res)=>{
    const entry=entryById.get(positiveId(req.params.id)),contest=entry&&selectById.get(entry.contest_id);
    if(!entry||!contest)return error(res,404,'Заявка не найдена');
    if(contest.state!=='draft')return error(res,409,'Модерация недоступна после начала голосования');
    if(!['approved','rejected','pending'].includes(req.body?.status))return error(res,400,'Недопустимый статус');
    const result=db.transaction(()=>{
      db.prepare('UPDATE contest_entries SET status=? WHERE id=?').run(req.body.status,entry.id);
      audit.run(entry.contest_id,entry.id,req.body.status,null,null,now());
    })();
    res.json({ok:true});
  });
  app.post('/api/admin/contest/entries/:id/crop',adminAuth,requireAction,asyncRoute(async(req,res)=>{
    const entry=entryById.get(positiveId(req.params.id)),contest=entry&&selectById.get(entry.contest_id);
    if(!entry||!contest)return error(res,404,'Заявка не найдена');
    if(contest.state!=='draft')return error(res,409,'Кадрирование закрыто после запуска');
    const x=Number(req.body?.x),y=Number(req.body?.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>100||y<0||y>100)return error(res,400,'Смещение: от 0 до 100%');
    const src=path.join(directory,entry.filename),info=await sharp(src).metadata();
    const [rw,rh]=SHAPES[contest.shape],aspect=rw/rh;
    const width=Math.min(info.width,Math.floor(info.height*aspect));
    const height=Math.min(info.height,Math.floor(info.width/aspect));
    if(width<1||height<1)return error(res,422,'Неподдерживаемый размер изображения');
    const left=Math.round((info.width-width)*x/100),top=Math.round((info.height-height)*y/100);
    const result=await sharp(src).extract({left,top,width,height})
      .resize({width:Math.min(1200,rw===16?1200:rw===9?810:1000)})
      .webp({quality:81,effort:4}).toBuffer();
    const filename=entry.id+'-'+crypto.randomUUID()+'.webp';
    await fsp.writeFile(path.join(directory,filename),result,{flag:'wx'});
    try{
      const revision=now();
      db.transaction(()=>{
        db.prepare("UPDATE contest_entries SET crop_filename=?,image_updated_at=? WHERE id=? AND "+
          "EXISTS(SELECT 1 FROM contests WHERE id=? AND state='draft')")
          .run(filename,revision,entry.id,entry.contest_id);
        audit.run(entry.contest_id,entry.id,'crop',entry.crop_filename||entry.filename,filename,revision);
      })();
      if(entry.crop_filename)await fsp.unlink(path.join(directory,entry.crop_filename)).catch(()=>{});
    }catch(err){await fsp.unlink(path.join(directory,filename)).catch(()=>{});throw err;}
    res.json({ok:true});
  }));
  // Moderator replacement from their own PC, including Photoshop-prepared
  // JPEG/PNG/WebP. The authenticated admin session and X-BALI-Action header
  // are checked BEFORE receiving a file. No file is forwarded to BALI-MENU.
  app.post('/api/admin/contest/entries/:id/replace',adminAuth,requireAction,
    upload.single('photo'),asyncRoute(async(req,res)=>{
      const discard=()=>req.file?.path?fsp.unlink(req.file.path).catch(()=>{}):Promise.resolve();
      let filename=null;
      try{
        const entry=entryById.get(positiveId(req.params.id));
        const contest=entry&&selectById.get(entry.contest_id);
        if(!entry||!contest)return error(res,404,'Заявка не найдена');
        if(contest.state!=='draft')return error(res,409,
          'Фотографии можно заменять только до запуска голосования');
        if(!req.file)return error(res,400,'Выберите файл фотографии');
        if(!['image/jpeg','image/png','image/webp'].includes(req.file.mimetype))
          return error(res,415,'Допустимы только JPG, PNG и WebP');
        // MIME can be forged. Sharp checks the real file signature, dimensions
        // and decoding; no executable file content is ever served back.
        const input=sharp(req.file.path,{limitInputPixels:36_000_000,failOn:'error'});
        const metadata=await input.metadata();
        if(!['jpeg','png','webp'].includes(metadata.format))
          return error(res,415,'Неподдерживаемый формат фотографии');
        if(!metadata.width||!metadata.height||metadata.width<50||metadata.height<50)
          return error(res,422,'Изображение слишком маленькое');
        const image=await input.rotate().resize({
          width:1600,height:1600,fit:'inside',withoutEnlargement:true
        }).webp({quality:85,effort:4}).toBuffer();
        // Unique filenames bust old thumbnail cache without changing the
        // contestant's public number or linked 6-digit BALI Card.
        filename=crypto.randomUUID()+'.webp';
        await fsp.writeFile(path.join(directory,filename),image,{flag:'wx'});
        const revision=Math.max(now(),Number(entry.image_updated_at||0)+1);
        const updated=db.transaction(()=>{
          const result=db.prepare("UPDATE contest_entries SET filename=?,crop_filename=NULL,"+
            "image_updated_at=? WHERE id=? AND filename=? AND "+
            "EXISTS(SELECT 1 FROM contests WHERE id=? AND state='draft')")
            .run(filename,revision,entry.id,entry.filename,entry.contest_id);
          if(!result.changes)return false;
          audit.run(entry.contest_id,entry.id,'replace',
            entry.crop_filename||entry.filename,filename,revision);
          return true;
        })();
        if(!updated)return error(res,409,'Заявка изменилась. Обновите страницу');
        // Only remove files AFTER the new version is durably committed.
        const obsolete=[entry.filename,entry.crop_filename].filter(Boolean);
        await Promise.all(obsolete.map(previous=>fsp.unlink(path.join(directory,previous)).catch(()=>{})));
        filename=null;
        res.json({ok:true,entryId:entry.id,number:entry.id,
          baliCardId:entry.card_id,status:entry.status,imageRevision:revision});
      }finally{
        if(filename)await fsp.unlink(path.join(directory,filename)).catch(()=>{});
        await discard();
      }
    }));
  app.post('/api/admin/contest/start',adminAuth,requireAction,(req,res)=>{
    finishDue();
    const contest=selectActive.get();
    if(!contest)return error(res,404,'Создайте конкурс в настройках');
    if(contest.state!=='draft')return error(res,409,'Конкурс уже запускался');
    if(process.env.CONTEST_ALLOW_LOCAL_RESULTS!=='1'&&contest.starts_at&&now()<contest.starts_at)
      return error(res,409,'Голосование откроется автоматически в 00:00');
    const count=db.prepare("SELECT COUNT(*) AS n FROM contest_entries WHERE contest_id=? AND status='approved'").get(contest.id).n;
    if(count<contest.prize_places)return error(res,409,'Одобренных участников меньше количества призовых мест');
    const started=now();
    db.prepare("UPDATE contests SET state='live',started_at=?,ends_at=? WHERE id=? AND state='draft'")
      .run(started,started+contest.duration_seconds*1000,contest.id);
    res.json({ok:true,endsAt:started+contest.duration_seconds*1000});
  });

  // Application API is *only* for the authenticated external registration service.
  app.post('/api/integrations/contest-entry',bridgeAuth,integrationLimiter,upload.single('photo'),
    asyncRoute(async(req,res)=>{
      const cleanup=()=>req.file?.path?fsp.unlink(req.file.path).catch(()=>{}):Promise.resolve();
      try{
        const contest=finishDue(),externalId=String(req.body?.externalId||'').trim();
        const name=String(req.body?.name||'').trim();
        const cardId=String(req.body?.baliCardId||'').trim();
        if(!contest||contest.state!=='draft'||
          (process.env.CONTEST_ALLOW_LOCAL_RESULTS!=='1'&&
            (!contest.starts_at||now()<contest.starts_at-3600000||now()>=contest.starts_at)))
          return error(res,409,'Приём заявок открыт только с 23:00 до 00:00');
        if(!/^[a-zA-Z0-9:_-]{3,100}$/.test(externalId)||!/^[0-9]{6}$/.test(cardId)||name.length<2||name.length>70||
          req.body?.consent!=='yes'||!req.file)return error(res,400,'Недостаточно данных или согласия участника');
        const existing=db.prepare('SELECT id,status FROM contest_entries WHERE contest_id=? AND external_id=?').get(contest.id,externalId);
        if(existing){res.json({ok:true,entryId:existing.id,status:existing.status,alreadyProcessed:true});return;}
        const image=sharp(req.file.path,{limitInputPixels:36_000_000,failOn:'error'});
        const meta=await image.metadata();
        if(!['jpeg','png','webp'].includes(meta.format))return error(res,415,'Только JPEG, PNG или WebP');
        const data=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
          .webp({quality:81,effort:4}).toBuffer();
        const filename=crypto.randomUUID()+'.webp';
        await fsp.writeFile(path.join(directory,filename),data,{flag:'wx'});
        try{
          const result=db.prepare('INSERT INTO contest_entries(contest_id,external_id,display_name,filename,card_id,status,created_at) VALUES (?,?,?,?,?,?,?)')
            .run(contest.id,externalId,name,filename,cardId,'pending',now());
          res.status(201).json({ok:true,entryId:Number(result.lastInsertRowid),status:'pending'});
        }catch(err){await fsp.unlink(path.join(directory,filename)).catch(()=>{});throw err;}
      }finally{await cleanup();}
    }));
  app.post('/api/integrations/contest-vote',bridgeAuth,integrationLimiter,(req,res)=>{
    const contest=finishDue();
    if(!contest||contest.state!=='live'||now()>=contest.ends_at)return error(res,409,'Голосование не активно');
    const externalId=String(req.body?.externalId||'').trim();
    const voterId=String(req.body?.voterId||'').trim();
    if(!/^[a-zA-Z0-9:_-]{3,100}$/.test(externalId)||voterId.length<3||voterId.length>180)
      return error(res,400,'Некорректные данные голосования');
    const entry=db.prepare("SELECT id FROM contest_entries WHERE contest_id=? AND external_id=? AND status='approved'")
      .get(contest.id,externalId);
    if(!entry)return error(res,404,'Участник не найден или не допущен');
    const voterHash=crypto.createHmac('sha256',process.env.SESSION_SECRET)
      .update('contest-voter:'+voterId).digest('hex');
    const result=db.prepare('INSERT OR IGNORE INTO contest_votes(contest_id,entry_id,voter_hash,created_at) VALUES (?,?,?,?)')
      .run(contest.id,entry.id,voterHash,now());
    if(!result.changes)return error(res,409,'Голос уже принят');
    res.status(201).json({ok:true});
  });
}
