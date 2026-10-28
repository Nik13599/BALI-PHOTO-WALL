const root=document.getElementById('contestAdminRoot');
const msg=document.getElementById('contestAdminMessage');
const dialog=document.getElementById('contestCropDialog');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null,selectedId=null,replacingId=null,busy=false,last='',lastRewards='';
const api=async(url,opts={})=>{
  const res=await fetch(url,{credentials:'same-origin',...opts}),body=await res.json().catch(()=>({}));
  if(!res.ok){const e=new Error(body.error||'Ошибка сервера');e.status=res.status;throw e;}
  return body;
};
const post=(url,value={})=>api(url,{method:'POST',headers:{'Content-Type':'application/json','X-BALI-Action':'1'},body:JSON.stringify(value)});
function notify(text,error=false){msg.textContent=text;msg.className='alert '+(error?'bad':'good');}
const canEdit=c=>Boolean(c?.state==='draft'&&(!c.startsAt||Date.now()<c.startsAt));
const bonusNames={free_entry:'Бесплатный вход',shot:'Шоты',cocktail:'Коктейли',hookah:'Кальяны'};
function rewardForm(index,current){
  const have=new Map((current?.bonuses||[]).map(b=>[b.code,b.quantity]));
  return '<fieldset class="contest-prize"><legend>'+({0:'🥇 1 место',1:'🥈 2 место',2:'🥉 3 место'}[index])+'</legend>'+
    '<label>BALI Coin<input name="coin-'+index+'" class="field" type="number" min="0" max="100000" value="'+(current?.baliCoins||0)+'"></label>'+
    Object.entries(bonusNames).map(([code,name])=>'<label>'+name+'<input name="bonus-'+index+'-'+code+'" class="field" type="number" min="0" max="100" value="'+(have.get(code)||0)+'"></label>').join('')+'</fieldset>';
}
function panel(data,rewards){
  const c=data.contest,counts=data.counts||{pending:0,approved:0,rejected:0,votes:0};
  const prizes=rewards.prizes||[],places=c?.prizePlaces||3,allowEdit=canEdit(c);
  return '<div class="admin-heading contest-heading"><div><div class="eyebrow">LIVE CONTROL · BALI</div><h1>КОРОЛЬ И <span class="glow">КОРОЛЕВА НОЧИ</span></h1></div>'+
    '<div class="contest-status">'+(c?({draft:'ПРИЁМ ЗАЯВОК',live:'ИДЁТ ГОЛОСОВАНИЕ',awaiting_results:'СВЕРКА ИТОГОВ',complete:'ЗАВЕРШЁН'}[c.state]):'НЕ СОЗДАН')+'</div></div>'+
    '<div class="contest-metrics">'+[['pending','Заявок на проверке'],['approved','Допущено'],['votes','Голосов (зеркало)'],['rejected','Отклонено']].map(([key,label])=>
      '<div><strong>'+counts[key]+'</strong><span>'+label+'</span></div>').join('')+'</div>'+
    '<section class="panel contest-panel"><h2>Параметры конкурса и LED-трансляции</h2>'+
    '<form id="contestSettingsForm" class="contest-form">'+
    '<label>Название<input class="field" name="title" maxlength="90" required value="'+esc(c?.title||'КОРОЛЬ И КОРОЛЕВА НОЧИ')+'"></label>'+
    '<label>Призовых мест<select class="field" name="prizePlaces"><option value="1" '+(c?.prizePlaces===1?'selected':'')+'>1 · Золотая корона</option><option value="3" '+(c?.prizePlaces!==1?'selected':'')+'>3 · Золото, серебро, бронза</option></select></label>'+
    '<label>Формат фотографий<select class="field" name="shape">'+
    [['square','1:1 · Квадрат'],['portrait','9:16 · Вертикальный'],['landscape','16:9 · Горизонтальный']].map(([v,t])=>
      '<option value="'+v+'" '+((c?.shape||'square')===v?'selected':'')+'>'+t+'</option>').join('')+'</select></label>'+
    '<label>Высота конкурсной ленты, px<input class="field" type="number" name="tileHeight" min="100" max="550" value="'+(c?.tileHeight||240)+'" required></label>'+
    '<label>Скорость движения, px/сек<input class="field" type="number" name="tileSpeed" min="20" max="250" value="'+(c?.tileSpeed||80)+'" required></label>'+
    '<label>Время голосования, минуты<input class="field" type="number" name="durationMinutes" min="1" max="120" value="'+(c?Math.round(c.durationSeconds/60)||10:10)+'" required></label>'+
    '<div class="contest-form-actions"><button class="button secondary" type="submit" '+(!allowEdit?'disabled':'')+'>СОХРАНИТЬ НАСТРОЙКИ</button>'+
    '<button class="button primary" id="contestStart" type="button" '+(!c||c.state!=='draft'||(c.startsAt&&Date.now()<c.startsAt)?'disabled':'')+'>▶ ЗАПУСТИТЬ ГОЛОСОВАНИЕ</button></div></form>'+
    (c?.state==='live'?'<div class="contest-live-timer" id="contestTimer"></div>':'')+
    '<p class="muted">Заявки принимаются с 23:00 до 00:00 по Минску. Голосование запускается автоматически в 00:00. Итоги сверяются с BALI-MENU; фотомозаика продолжает движение.</p></section>'+
    '<section class="panel contest-panel"><div class="contest-panel-heading"><h2>Призы BALI Card</h2><small>'+ (rewards.configured?'Сервер начислений настроен':'⚠ Адрес сервера начислений пока не указан')+'</small></div>'+
    '<form id="contestPrizesForm"><div class="contest-prizes">'+Array.from({length:places},(_,i)=>rewardForm(i,prizes.find(p=>p.place===i+1))).join('')+'</div>'+
    '<button type="submit" class="button primary" '+(!c||c.state!=='draft'?'disabled':'')+'>СОХРАНИТЬ ПРИЗЫ</button></form>'+
    '<p class="muted">Награды отправляются на сервер BALI Card после итогового подсчёта. PHOTO WALL не меняет баланс карты напрямую.</p></section>'+
    '<section class="panel contest-panel"><div class="contest-panel-heading"><h2>Заявки участников</h2><small>Всего '+data.entries.length+'</small></div>'+
    '<div class="contest-entry-grid">'+(data.entries.length?data.entries.map(e=>entryCard(e,c)).join(''):'<div class="empty">Конкурсных заявок пока нет. Приём осуществляется только с доверенного сервера регистрации.</div>')+'</div></section>'+
    (c?.state==='complete'?results(data,rewards):'');
}
function entryCard(e,c){
  return '<article class="contest-entry"><div class="contest-entry-image"><img alt="Конкурсное фото" loading="lazy" src="/api/admin/contest/photo/'+e.id+'?rev='+(e.imageRevision||0)+'"></div>'+
  '<div class="contest-entry-info"><strong>#'+e.id+' · '+esc(e.display_name)+'</strong><small>'+
  ({pending:'Ожидает проверки',approved:'Допущен',rejected:'Отклонён'}[e.status]||e.status)+' · BALI Card '+esc(e.card_id||'не подтверждена')+' · '+e.votes+' голосов (зеркало)</small></div>'+
  '<div class="contest-entry-actions"><button class="button secondary small" data-crop="'+e.id+'" '+(!canEdit(c)?'disabled':'')+'>✂ Кадр</button>'+
  '<button class="button secondary small" data-replace="'+e.id+'" '+(c?.state!=='draft'?'disabled':'')+'>↥ Заменить с ПК</button>'+
  (e.status!=='approved'?'<button class="button approve small" data-id="'+e.id+'" data-status="approved" '+(c?.state!=='draft'?'disabled':'')+'>Одобрить</button>':'')+
  (e.status!=='rejected'?'<button class="button reject small" data-id="'+e.id+'" data-status="rejected" '+(c?.state!=='draft'?'disabled':'')+'>Отклонить</button>':'')+'</div></article>';
}
function results(data,rewards){
  const names=new Map(data.entries.map(e=>[e.id,e.display_name]));
  const items=data.winners.length?data.winners.map(w=>'<div class="contest-result"><strong>'+({1:'🥇 Золото',2:'🥈 Серебро',3:'🥉 Бронза'}[w.place])+'</strong>'+
    '<span>'+esc(names.get(w.id)||'Участник #'+w.id)+'</span><b>'+w.votes+' голосов</b></div>').join('')
    :'<p class="muted">Голосов нет. Автоматический победитель не назначен.</p>';
  const deliveries=rewards.deliveries||[];
  return '<section class="panel contest-panel"><div class="contest-panel-heading"><h2>🏆 Итоги и начисление призов</h2>'+
    '<button class="button secondary small" id="retryRewards" type="button">↻ Проверить начисления</button></div>'+
    '<div class="contest-results">'+items+'</div><h3>Передача в BALI Card</h3>'+
    (deliveries.length?deliveries.map(x=>'<p class="contest-delivery">'+x.place+' место · карта '+esc(x.card_id)+' · '+
      (x.status==='credited'?'✓ Начислено':'⏳ Ожидает начисления')+
      (x.last_error?' · '+esc(x.last_error):'')+'</p>').join(''):
      '<p class="muted">Передача наград пока не подтверждена. Проверьте настройки призов, привязку BALI Card и подключение сервера.</p>')+
    '</section>';
}
async function refresh(force=false){
  if(busy||(!force&&root.querySelector('input:focus,select:focus')))return;
  busy=true;
  try{
    const [contest,rewards]=await Promise.all([api('/api/admin/contest'),api('/api/admin/contest/rewards')]);
    const next=JSON.stringify([contest.contest,contest.entries,contest.winners,contest.counts,rewards]);state=contest;
    if(!force&&next===last)return;
    last=next;root.innerHTML=panel(contest,rewards);
  }catch(e){
    if(e.status===401&&!root.querySelector('#contestLogin'))
      root.innerHTML='<section class="login-card"><h2>Сессия истекла</h2><a class="button primary" href="/admin">Войти заново</a></section>';
    else if(e.status!==401)notify(e.message,true);
  }finally{busy=false;}
}
root.addEventListener('submit',async e=>{
  if(e.target.id==='contestLoginForm'){
    e.preventDefault();
    try{await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('contestPassword').value})});await refresh(true);}
    catch(err){notify(err.message,true);}return;
  }
  if(e.target.id==='contestSettingsForm'){
    e.preventDefault();const f=new FormData(e.target);
    try{await post('/api/admin/contest/settings',{title:f.get('title'),prizePlaces:Number(f.get('prizePlaces')),
      shape:f.get('shape'),tileHeight:Number(f.get('tileHeight')),tileSpeed:Number(f.get('tileSpeed')),
      durationSeconds:Number(f.get('durationMinutes'))*60});notify('Настройки сохранены');await refresh(true);}
    catch(err){notify(err.message,true);}
  }
  if(e.target.id==='contestPrizesForm'){
    e.preventDefault();const f=new FormData(e.target),places=state?.contest?.prizePlaces||0;
    const prizes=Array.from({length:places},(_,i)=>({
      baliCoins:Number(f.get('coin-'+i)),
      bonuses:Object.keys(bonusNames).map(code=>({code,quantity:Number(f.get('bonus-'+i+'-'+code))})).filter(b=>b.quantity>0)
    }));
    try{await post('/api/admin/contest/prizes',{prizes});notify('Награды сохранены');await refresh(true);}
    catch(err){notify(err.message,true);}
  }
});
root.addEventListener('click',async e=>{
  const btn=e.target.closest('button');if(!btn)return;
  try{
    if(btn.id==='contestStart'){
      if(!confirm('Запустить голосование? Изменять состав участников, формат фото и призы после старта будет нельзя.'))return;
      await post('/api/admin/contest/start');notify('Конкурс запущен');await refresh(true);
    }else if(btn.id==='retryRewards'){
      await post('/api/admin/contest/rewards/retry');notify('Проверка и повторная отправка поставлены в очередь');await refresh(true);
    }else if(btn.dataset.id){
      await post('/api/admin/contest/entries/'+btn.dataset.id+'/status',{status:btn.dataset.status});await refresh(true);
    }else if(btn.dataset.replace){
       if(!canEdit(state?.contest))throw Error('После старта голосования замена запрещена');
       replacingId=Number(btn.dataset.replace);
       const input=document.getElementById('contestReplaceFile');
       input.value='';input.click();
    }else if(btn.dataset.crop){
      selectedId=Number(btn.dataset.crop);
      document.getElementById('contestCropImage').src='/api/admin/contest/photo/'+selectedId+'?original=1';
      document.getElementById('contestCropPreview').dataset.shape=state?.contest?.shape||'square';
      document.getElementById('contestCropX').value='50';document.getElementById('contestCropY').value='50';
      drawCrop();dialog.showModal();
    }
  }catch(err){notify(err.message,true);}
});
const replaceInput=document.getElementById('contestReplaceFile');
replaceInput.addEventListener('change',async()=>{
  const file=replaceInput.files?.[0],id=replacingId;
  if(!file||!id)return;
  if(!canEdit(state?.contest)){notify('После старта голосования изменения закрыты',true);return;}
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024||file.size===0){
    notify('Выберите JPG, PNG или WebP размером до 8 МБ',true);return;
  }
  const participant=state?.entries?.find(e=>e.id===id);
  if(!confirm('Заменить фото №'+id+' ('+(participant?.display_name||'гость')+')? Номер и карта сохранятся.'))return;
  const form=new FormData();form.append('photo',file,file.name);
  try{
    const response=await fetch('/api/admin/contest/entries/'+id+'/replace',{
      method:'POST',credentials:'same-origin',headers:{'X-BALI-Action':'1'},body:form});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(result.error||'Не удалось заменить фотографию');
    notify('Фото №'+id+' успешно заменено. Номер и BALI Card сохранены.');
    last='';await refresh(true);
  }catch(error){notify(error.message,true);}
  finally{replaceInput.value='';replacingId=null;}
});
function drawCrop(){
  const x=document.getElementById('contestCropX').value,y=document.getElementById('contestCropY').value;
  document.getElementById('contestCropImage').style.objectPosition=x+'% '+y+'%';
}
for(const axis of ['X','Y'])document.getElementById('contestCrop'+axis).addEventListener('input',drawCrop);
const preview=document.getElementById('contestCropPreview');let touch=null;
preview.addEventListener('pointerdown',e=>{touch={x:e.clientX,y:e.clientY,px:Number(document.getElementById('contestCropX').value),py:Number(document.getElementById('contestCropY').value)};preview.setPointerCapture(e.pointerId)});
preview.addEventListener('pointermove',e=>{
  if(!touch)return;
  document.getElementById('contestCropX').value=String(Math.max(0,Math.min(100,touch.px+(touch.x-e.clientX)*100/Math.max(1,preview.clientWidth))));
  document.getElementById('contestCropY').value=String(Math.max(0,Math.min(100,touch.py+(touch.y-e.clientY)*100/Math.max(1,preview.clientHeight))));
  drawCrop();
});
preview.addEventListener('pointerup',()=>{touch=null});
preview.addEventListener('pointercancel',()=>{touch=null});
document.getElementById('contestSaveCrop').addEventListener('click',async()=>{
  if(!selectedId)return;
  try{
    await post('/api/admin/contest/entries/'+selectedId+'/crop',{x:Number(document.getElementById('contestCropX').value),y:Number(document.getElementById('contestCropY').value)});
    dialog.close();notify('Кадр сохранён');await refresh(true);
  }catch(e){notify(e.message,true);}
});
function tick(){
  if(state?.contest?.state!=='live')return;
  const el=document.getElementById('contestTimer');if(!el)return;
  const ms=Math.max(0,state.contest.endsAt-(Date.now()+(state.serverNow-state.receivedAt)));
  const s=Math.ceil(ms/1000);el.textContent='ГОЛОСОВАНИЕ · '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}
const originalRefresh=refresh;
refresh=async function(force=false){await originalRefresh(force);if(state)state.receivedAt=Date.now();tick();};
refresh().catch(console.error);
setInterval(()=>{if(!document.hidden)refresh().catch(console.error)},6000);
setInterval(tick,500);
