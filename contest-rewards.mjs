// Durable outbound reward delivery. The BALI Card server, never the photo wall,
// owns balances and bonus ledgers. Delivery is at-least-once and requires
// idempotency on the receiver, keyed by rewardId.
import crypto from 'node:crypto';

const BONUSES=['free_entry','shot','cocktail','hookah'];
const json=value=>JSON.stringify(value);
const safeId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const now=()=>Date.now();
const fail=(res,status,error)=>res.status(status).json({error});

export function registerContestRewards({app,db,adminAuth,requireAction}) {
  const fields=db.pragma('table_info(contest_entries)').map(x=>x.name);
  if(!fields.includes('card_id'))db.exec("ALTER TABLE contest_entries ADD COLUMN card_id TEXT");
  db.exec(
    "CREATE TABLE IF NOT EXISTS contest_prizes ("+
      "contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,"+
      "place INTEGER NOT NULL CHECK(place IN (1,2,3)),"+
      "coin_amount INTEGER NOT NULL DEFAULT 0 CHECK(coin_amount>=0 AND coin_amount<=100000),"+
      "bonuses TEXT NOT NULL DEFAULT '[]',"+
      "PRIMARY KEY(contest_id,place));"+
    "CREATE TABLE IF NOT EXISTS contest_reward_outbox ("+
      "reward_id TEXT PRIMARY KEY,contest_id INTEGER NOT NULL,entry_id INTEGER NOT NULL,"+
      "place INTEGER NOT NULL,card_id TEXT NOT NULL,prize_json TEXT NOT NULL,"+
      "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','credited')),"+
      "attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,"+
      "last_error TEXT,last_attempt_at INTEGER,credited_at INTEGER,created_at INTEGER NOT NULL,"+
      "UNIQUE(contest_id,place));"+
    "CREATE INDEX IF NOT EXISTS contest_outbox_due ON contest_reward_outbox(status,next_attempt_at)"
  );
  const selectContest=()=>db.prepare(
    "SELECT c.* FROM contests c JOIN events e ON e.id=c.event_id WHERE e.active=1 LIMIT 1"
  ).get();

  const validateBonusList=value=>{
    if(!Array.isArray(value)||value.length>4)return null;
    const seen=new Set(),clean=[];
    for(const item of value){
      const code=item?.code,amount=Number(item?.quantity);
      if(!BONUSES.includes(code)||seen.has(code)||!Number.isInteger(amount)||amount<1||amount>100)return null;
      seen.add(code);clean.push({code,quantity:amount});
    }
    return clean;
  };
  const savePrizes=db.transaction((contestId,prizes)=>{
    for(const [index,prize] of prizes.entries()) {
      db.prepare('INSERT INTO contest_prizes(contest_id,place,coin_amount,bonuses) VALUES(?,?,?,?) ON CONFLICT(contest_id,place) DO UPDATE SET coin_amount=excluded.coin_amount,bonuses=excluded.bonuses')
        .run(contestId,index+1,prize.baliCoins,json(prize.bonuses));
    }
    db.prepare('DELETE FROM contest_prizes WHERE contest_id=? AND place>?').run(contestId,prizes.length);
  });
  app.post('/api/admin/contest/prizes',adminAuth,requireAction,(req,res)=>{
    const contest=selectContest();
    if(!contest)return fail(res,404,'Сначала создайте конкурс');
    if(contest.state!=='draft')return fail(res,409,'Призы фиксируются при запуске конкурса');
    if(!Array.isArray(req.body?.prizes)||req.body.prizes.length!==contest.prize_places)
      return fail(res,400,'Укажите награды для каждого призового места');
    const prizes=[];
    for(const prize of req.body.prizes){
      const baliCoins=Number(prize?.baliCoins),bonuses=validateBonusList(prize?.bonuses);
      if(!Number.isSafeInteger(baliCoins)||baliCoins<0||baliCoins>100000||!bonuses)
        return fail(res,400,'Недопустимое количество BALI Coin или бонусов');
      prizes.push({baliCoins,bonuses});
    }
    savePrizes(contest.id,prizes);
    res.json({ok:true});
  });
  const prizesFor=contestId=>db.prepare(
    'SELECT place,coin_amount,bonuses FROM contest_prizes WHERE contest_id=? ORDER BY place'
  ).all(contestId).map(p=>({place:p.place,baliCoins:p.coin_amount,bonuses:JSON.parse(p.bonuses)}));

  app.get('/api/admin/contest/rewards',adminAuth,(_req,res)=>{
    enqueue();
    const contest=selectContest();
    if(!contest)return res.json({prizes:[],deliveries:[],configured:false});
    const deliveries=db.prepare(
      'SELECT reward_id,place,card_id,status,attempts,last_error,credited_at,last_attempt_at FROM contest_reward_outbox WHERE contest_id=? ORDER BY place'
    ).all(contest.id);
    res.json({prizes:prizesFor(contest.id),deliveries,configured:Boolean(
      /^https:\/\//.test(process.env.BALI_REWARDS_WEBHOOK_URL||'')&&process.env.BALI_REWARDS_SECRET&&process.env.BALI_REWARDS_SECRET.length>=32
    )});
  });

  // Create once, only for a completed contest with actual votes.
  const enqueue=db.transaction(()=>{
    const matches=db.prepare(
      "SELECT w.contest_id,w.entry_id,w.place,w.votes,e.external_id,e.card_id,c.event_id,"+
      "c.title,c.finished_at FROM contest_winners w JOIN contests c ON c.id=w.contest_id "+
      "JOIN contest_entries e ON e.id=w.entry_id WHERE c.state='complete'"
    ).all();
    const prizeQuery=db.prepare('SELECT coin_amount,bonuses FROM contest_prizes WHERE contest_id=? AND place=?');
    const insert=db.prepare(
      'INSERT OR IGNORE INTO contest_reward_outbox(reward_id,contest_id,entry_id,place,card_id,prize_json,created_at) VALUES(?,?,?,?,?,?,?)'
    );
    for(const item of matches){
      // Missing trusted Card identity: do not credit a guessed user.
      if(!/^[0-9]{6}$/.test(item.card_id||''))continue;
      const prize=prizeQuery.get(item.contest_id,item.place);
      // No configured reward is a valid zero-prize result, not an implicit credit.
      if(!prize)continue;
      const bonuses=JSON.parse(prize.bonuses);
      if(prize.coin_amount===0&&bonuses.length===0)continue;
      const rewardId='bali-photo-wall:contest:'+item.contest_id+':place:'+item.place;
      insert.run(rewardId,item.contest_id,item.entry_id,item.place,item.card_id,json({
        rewardId,source:'bali-photo-wall',
        contestId:item.contest_id,eventId:item.event_id,contestTitle:item.title,
        entryExternalId:item.external_id,baliCardId:item.card_id,place:item.place,
        votes:item.votes,prizes:{baliCoins:prize.coin_amount,bonuses},
        finishedAt:item.finished_at
      }),now());
    }
  });

  let sending=false;
  async function deliver(){
    if(sending)return;
    sending=true;
    try{
      enqueue();
      const url=process.env.BALI_REWARDS_WEBHOOK_URL||'';
      const secret=process.env.BALI_REWARDS_SECRET||'';
      if(!/^https:\/\//.test(url)||secret.length<32||secret.includes('CHANGE_'))return;
      const endpoint=new URL(url);
      if(endpoint.username||endpoint.password||!endpoint.hostname||
        /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(endpoint.hostname))return;
      const pending=db.prepare(
        "SELECT reward_id,prize_json,attempts FROM contest_reward_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 5"
      ).all(now());
      for(const item of pending){
        const stamp=now();
        try{
          const signature=crypto.createHmac('sha256',secret).update(item.prize_json).digest('hex');
          const controller=new AbortController();
          const timeout=setTimeout(()=>controller.abort(),8000);
          let response;
          try{
            response=await fetch(url,{method:'POST',signal:controller.signal,redirect:'error',
              headers:{'Content-Type':'application/json','X-BALI-Signature':'sha256='+signature,
                'X-BALI-Reward-Id':item.reward_id},body:item.prize_json});
          }finally{clearTimeout(timeout);}
          const answer=await response.json().catch(()=>({}));
          // The receiver must acknowledge the exact immutable idempotency key after
          // the credit transaction was committed. HTTP 2xx alone is insufficient.
          if(!response.ok||answer.credited!==true||answer.rewardId!==item.reward_id)
            throw new Error('Сервер наград не подтвердил начисление: HTTP '+response.status);
          db.prepare("UPDATE contest_reward_outbox SET status='credited',attempts=attempts+1,last_attempt_at=?,credited_at=?,last_error=NULL WHERE reward_id=? AND status='pending'")
            .run(stamp,now(),item.reward_id);
        }catch(err){
          const tries=item.attempts+1;
          const delay=Math.min(30*60000,Math.pow(2,Math.min(tries,9))*15000);
          db.prepare('UPDATE contest_reward_outbox SET attempts=attempts+1,last_error=?,last_attempt_at=?,next_attempt_at=? WHERE reward_id=? AND status=?')
            .run(String(err.message||err).slice(0,300),stamp,stamp+delay,item.reward_id,'pending');
        }
      }
    }catch(err){console.error('Contest reward outbox:',err.message)}
    finally{sending=false;}
  }
  app.post('/api/admin/contest/rewards/retry',adminAuth,requireAction,(_req,res)=>{
    const contest=selectContest();
    if(!contest||contest.state!=='complete')return fail(res,409,'Начисления возможны после завершения');
    db.prepare("UPDATE contest_reward_outbox SET next_attempt_at=0 WHERE contest_id=? AND status='pending'")
      .run(contest.id);
    deliver().catch(console.error);
    res.json({ok:true,message:'Повторная отправка поставлена в очередь'});
  });
  deliver().catch(console.error);
  setInterval(()=>deliver().catch(console.error),15000).unref();
}
