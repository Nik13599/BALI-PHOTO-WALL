// Unified control room: all three sections use the existing PHOTO WALL admin
// session. Cross-server status is read by the Node backend with a server-only key.
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({
 '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let active='screen',photoPage=1,screenLoaded=false,refreshing=false;
let latestStatus=null,photoData=null,contestData=null;
const notice=(message,bad=false)=>{
 const target=$('controlMessage');target.textContent=message;target.classList.toggle('bad',bad);
};
async function api(url,opts={}){
 const response=await fetch(url,{cache:'no-store',credentials:'same-origin',...opts});
 let data;try{data=await response.json()}catch{data={};}
 if(!response.ok)throw Object.assign(Error(data?.error||'Ошибка сервера '+response.status),{status:response.status});
 return data;
}
const action=(url,payload,method='POST')=>api(url,{method,headers:{
 'Content-Type':'application/json','X-BALI-Action':'1'},body:JSON.stringify(payload)});
function showDashboard(){
 $('controlDashboard').hidden=false;$('controlLogin').hidden=true;
 switchTab(active);refreshAll(true).catch(e=>notice(e.message,true));
}
async function checkSession(){
 try{await api('/api/admin/me');showDashboard();}
 catch(e){$('controlLogin').hidden=false;$('controlDashboard').hidden=true;}
}
$('controlLoginForm').addEventListener('submit',async event=>{
 event.preventDefault();const button=event.currentTarget.querySelector('button');
 button.disabled=true;
 try{await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({password:$('controlPassword').value})});
  $('controlPassword').value='';$('controlLoginMessage').textContent='';showDashboard();
 }catch(e){$('controlLoginMessage').textContent=e.message;}
 finally{button.disabled=false;}
});
$('controlLogout').addEventListener('click',async()=>{
 try{await api('/api/admin/logout',{method:'POST',headers:{'X-BALI-Action':'1'}})}
 catch{}location.assign('/admin/control');
});
function switchTab(name){
 active=name;for(const tab of document.querySelectorAll('[data-tab]')){
  const selected=tab.dataset.tab===name;
  tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));
 }
 for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==name;
 const hash='#'+name;if(location.hash!==hash)history.replaceState(null,'',hash);
 refreshPanel().catch(e=>notice(e.message,true));
}
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>switchTab(button.dataset.tab));
const initial=(location.hash||'').slice(1);
if(['screen','photos','contest'].includes(initial))active=initial;
function badge(name,online){
 $(name+'Dot').classList.toggle('online',online);
 $(name+'Dot').classList.toggle('offline',!online);
 $(name+'Online').textContent=online?'НА СВЯЗИ':'НЕТ СВЯЗИ';
}
function metric(container,name,value){
 const element=document.createElement('div'),large=document.createElement('strong'),small=document.createElement('small');
 large.textContent=String(value);small.textContent=name;element.append(large,small);container.append(element);
}
function renderStatus(response){
 latestStatus=response;
 const wall=response.photoWall,central=response.baliMenu;
 badge('club',wall?.online===true);badge('bali',central?.online===true);
 $('clubMetric').textContent=(wall?.ordinary?.total??0)+' фото · '+(wall?.ordinary?.pending??0)+' ждут проверки';
 $('clubScreen').textContent=wall?.screenConnected
  ?'LED-экран подключён · '+(wall.screenLayout||'режим неизвестен')
  :'LED-экран не подключён или не отправляет сигнал';
 $('baliMetric').textContent=central?.online
  ?(central.usage?.contestEntries??0)+' заявок · '+(central.usage?.contestVotes??0)+' голосов'
  :'Сервер BALI-MENU недоступен';
 $('baliDetail').textContent=central?.online
  ?'D1: '+(central.usage?.awardReceipts??0)+' подтверждений призов · показатели записей, не квота Cloudflare'
  :'Причина: '+(central?.error||'сервер не ответил');
 $('syncText').textContent='Последняя проверка: '+new Date().toLocaleTimeString('ru-RU')+
  ' · ответ '+response.responseMs+' мс';
 $('photosCounter').textContent=wall?.ordinary?.pending?String(wall.ordinary.pending):'';
 $('contestCounter').textContent=central?.online&&central.usage?.contestEntries
  ?String(central.usage.contestEntries):'';
 if(active==='photos'&&wall?.ordinary){
  const element=$('ordinaryStats');element.replaceChildren();
  metric(element,'Всего на клубном сервере',wall.ordinary.total);
  metric(element,'Ожидают модерации',wall.ordinary.pending);
  metric(element,'Одобрены',wall.ordinary.approved);
  metric(element,'Отклонены',wall.ordinary.rejected);
 }
}
async function refreshStatus(){
 try{renderStatus(await api('/api/admin/control/status'));}
 catch(e){
  if(e.status===401){location.reload();return;}
  badge('club',false);badge('bali',false);
  $('syncText').textContent='Не удалось получить статус: '+e.message;
 }
}
function renderScreen(formValues){
 const form=$('screenForm');
 for(const [key,value] of Object.entries(formValues.settings||{})){
  const field=form.elements.namedItem(key);if(!field)continue;
  if(field.type==='checkbox')field.checked=Boolean(value);
  else field.value=String(value);
 }
 $('screenSaved').textContent=formValues.updatedAt
  ?'Последнее сохранение: '+new Date(formValues.updatedAt).toLocaleTimeString('ru-RU')
  :'Сохранены настройки по умолчанию';
 screenLoaded=true;
}
async function loadScreen(){if(!screenLoaded)renderScreen(await api('/api/admin/control/screen'));}
$('screenForm').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type=submit]');
 const settings={};
 for(const element of form.elements){
  if(!element.name)continue;
  settings[element.name]=element.type==='checkbox'?element.checked:
   element.type==='number'?Number(element.value):element.value;
 }
 button.disabled=true;
 try{renderScreen(await action('/api/admin/control/screen',settings));
  notice('Настройки сохранены на клубном компьютере. LED-экран получит их автоматически.');}
 catch(e){notice(e.message,true);}finally{button.disabled=false;}
});
async function loadPhotos(){
 photoData=await api('/api/admin/dashboard?page='+photoPage);
 photoPage=photoData.page;
 $('photosPage').textContent=photoPage+' / '+photoData.pages;
 $('photosPrev').disabled=photoPage<=1;
 $('photosNext').disabled=photoPage>=photoData.pages;
 const root=$('ordinaryPhotoGrid');
 if(!photoData.photos.length){root.innerHTML='<div class="control-empty">Фотографий пока нет.</div>';return;}
 root.innerHTML=photoData.photos.map(p=>'<article class="control-photo">'+
  '<img loading="lazy" src="/api/admin/photos/'+p.id+'" alt="Фото гостя №'+p.id+'">'+
  '<strong>Фото №'+p.id+'</strong>'+
  '<small>'+({pending:'Ожидает решения',approved:'На экране',rejected:'Отклонено'}[p.status]||p.status)+
  ' · поток '+escapeHtml(p.screen_lane||'auto')+'</small>'+
  '<div class="control-photo-actions">'+
  (p.status!=='approved'?'<button class="approve" data-photo-status="approved" data-photo-id="'+p.id+'">Одобрить</button>':'')+
  (p.status!=='rejected'?'<button class="reject" data-photo-status="rejected" data-photo-id="'+p.id+'">Отклонить</button>':'')+
  '<button data-delete-photo="'+p.id+'">Удалить</button></div></article>').join('');
}
$('photosPrev').addEventListener('click',()=>{if(photoPage>1){photoPage--;loadPhotos().catch(e=>notice(e.message,true));}});
$('photosNext').addEventListener('click',()=>{if(photoData&&photoPage<photoData.pages){photoPage++;loadPhotos().catch(e=>notice(e.message,true));}});
$('ordinaryPhotoGrid').addEventListener('click',async e=>{
 const button=e.target.closest('button');if(!button)return;
 const photoId=Number(button.dataset.photoId||button.dataset.deletePhoto);
 if(!Number.isSafeInteger(photoId)||photoId<=0)return;
 if(button.dataset.deletePhoto&&!confirm('Удалить обычное фото №'+photoId+' с клубного компьютера?'))return;
 button.disabled=true;
 try{
  if(button.dataset.deletePhoto)await action('/api/admin/photos/'+photoId,{},'DELETE');
  else await action('/api/admin/photos/'+photoId+'/status',{status:button.dataset.photoStatus});
  await loadPhotos();await refreshStatus();notice('Действие с фотографией №'+photoId+' выполнено.');
 }catch(err){button.disabled=false;notice(err.message,true);}
});
function contestPhase(c){
 if(!c)return 'Конкурс пока не создан';
 if(c.state==='draft')return 'Приём конкурсных фотографий · 23:00–00:00';
 if(c.state==='awaiting_results'||c.state==='live'&&Date.now()>c.endsAt)return 'Идёт сверка итогов с BALI-MENU';
 if(c.state==='live')return 'Голосование идёт · осталось '+Math.max(0,Math.ceil((c.endsAt-Date.now())/60000))+' мин';
 return 'Конкурс завершён · '+(c.finishedAt?new Date(c.finishedAt).toLocaleString('ru-RU'):'итоги готовы');
}
function renderContestControls(c,rewards){
 const formHost=$('contestConfig');
 if(document.activeElement?.closest('#controlContestForm'))return;
 const locked=Boolean(c&&c.state!=='draft');
 const places=c?.prizePlaces||3;
 const bonusNames={free_entry:'Бесплатный вход',shot:'Шоты',cocktail:'Коктейли',hookah:'Кальян'};
 const prizeForm=[1,2,3].map(n=>{
  const prize=(rewards.prizes||[]).find(p=>p.place===n);
  const current=new Map((prize?.bonuses||[]).map(b=>[b.code,b.quantity]));
  return '<fieldset class="control-prize" data-prize-place="'+n+'" '+(n>places?'hidden':'')+'>'+
   '<legend>'+({1:'🥇 1 место',2:'🥈 2 место',3:'🥉 3 место'}[n])+'</legend>'+
   '<label>BALI Coin<input name="coins'+n+'" type="number" class="field" min="0" max="100000" value="'+(prize?.baliCoins||0)+'"></label>'+
   Object.entries(bonusNames).map(([code,name])=>
    '<label>'+name+'<input class="field" type="number" min="0" max="100" name="bonus'+n+code+'" value="'+(current.get(code)||0)+'"></label>').join('')+
   '</fieldset>';
 }).join('');
 formHost.innerHTML='<h2>Параметры конкурса и призовые места</h2>'+
  '<p class="muted">Управление подготовкой до 00:00. Заявки поступают из BALI-MENU, а модерация выполняется на клубном компьютере.</p>'+
  '<form id="controlContestForm" class="control-fields" '+(locked?'data-locked="1"':'')+'>'+
  '<label>Название<input name="title" class="field" maxlength="90" required value="'+escapeHtml(c?.title||'КОРОЛЬ И КОРОЛЕВА НОЧИ')+'"></label>'+
  '<label>Количество призовых мест<select name="prizePlaces" class="field"><option value="1" '+(places===1?'selected':'')+'>1 · Золотая корона</option><option value="3" '+(places===3?'selected':'')+'>3 · Золото, серебро, бронза</option></select></label>'+
  '<label>Форма конкурсных фотографий<select name="shape" class="field">'+
  [['square','Квадрат 1:1'],['portrait','Вертикальная 9:16'],['landscape','Горизонтальная 16:9']].map(([k,t])=>'<option value="'+k+'" '+((c?.shape||'square')===k?'selected':'')+'>'+t+'</option>').join('')+'</select></label>'+
  '<label>Длительность голосования, мин<input name="durationMinutes" class="field" type="number" min="1" max="120" value="'+Math.round((c?.durationSeconds||600)/60)+'"></label>'+
  '<label>Высота ленты, px<input name="tileHeight" class="field" type="number" min="100" max="550" value="'+(c?.tileHeight||240)+'"></label>'+
  '<label>Скорость ленты, px/сек<input name="tileSpeed" class="field" type="number" min="20" max="250" value="'+(c?.tileSpeed||80)+'"></label>'+
  '<div class="control-prize-grid">'+prizeForm+'</div>'+
  '<div class="control-form-actions"><button type="submit" class="button primary" '+(locked?'disabled':'')+'>СОХРАНИТЬ КОНКУРС И ПРИЗЫ</button>'+
  '<small class="muted">'+(locked?'Настройки закреплены после старта голосования.':
   'Призовые места и бонусы сохраняются до запуска в 00:00.')+'</small></div></form>';
 if(locked)formHost.querySelectorAll('input,select').forEach(element=>element.disabled=true);
}
$('contestConfig').addEventListener('change',event=>{
 if(event.target.name!=='prizePlaces')return;
 const places=Number(event.target.value);
 for(const box of $('contestConfig').querySelectorAll('[data-prize-place]'))
  box.hidden=Number(box.dataset.prizePlace)>places;
});
$('contestConfig').addEventListener('submit',async event=>{
 if(event.target.id!=='controlContestForm')return;
 event.preventDefault();
 const form=event.target,button=form.querySelector('button[type="submit"]');
 if(button.disabled)return;
 button.disabled=true;
 const val=name=>form.elements.namedItem(name).value;
 const places=Number(val('prizePlaces'));
 const bonuses=['free_entry','shot','cocktail','hookah'];
 const prizes=Array.from({length:places},(_,i)=>{
  const n=i+1;
  return {baliCoins:Number(val('coins'+n)),bonuses:bonuses.map(code=>({
   code,quantity:Number(val('bonus'+n+code))
  })).filter(b=>b.quantity>0)};
 });
 try{
  await action('/api/admin/contest/settings',{
   title:val('title'),prizePlaces:places,shape:val('shape'),
   tileHeight:Number(val('tileHeight')),tileSpeed:Number(val('tileSpeed')),
   durationSeconds:Number(val('durationMinutes'))*60
  });
  await action('/api/admin/contest/prizes',{prizes});
  notice('Параметры конкурса и награды записаны на PHOTO WALL. Голоса и карты остаются в BALI-MENU.');
  await loadContest();
 }catch(error){notice('Не удалось завершить сохранение: '+error.message,true);button.disabled=false;}
});
async function loadContest(){
 const [a,rewards]=await Promise.all([
  api('/api/admin/contest'),api('/api/admin/contest/rewards')
 ]);
 contestData=a;
 const c=a.contest,local=a.counts||{},remote=latestStatus?.baliMenu;
 renderContestControls(c,rewards);
 $('contestStatus').textContent=contestPhase(c)+' · голосование с 00:00 · '+(c?.prizePlaces||3)+' призовых мест.';
 const stats=$('contestStats');stats.replaceChildren();
 metric(stats,'Одобрено на PHOTO WALL',local.approved||0);
 metric(stats,'Ждут модерации',local.pending||0);
 metric(stats,'Голосов на сайте BALI-MENU',remote?.online?remote.usage.contestVotes:'нет связи');
 metric(stats,'Голосов в локальном зеркале',local.votes||0);
 $('contestPhotoGrid').innerHTML=!a.entries?.length?
  '<div class="control-empty">Заявки ещё не поступали. Регистрация и номера карт проверяются на сервере BALI-MENU.</div>':
  a.entries.slice(0,100).map(e=>'<article class="control-photo">'+
  '<img loading="lazy" src="/api/admin/contest/photo/'+e.id+'" alt="Конкурсное фото №'+e.id+'">'+
  '<strong>№'+e.id+' · '+escapeHtml(e.display_name)+'</strong>'+
  '<small>BALI Card: '+escapeHtml(e.card_id||'не установлена')+'</small>'+
  '<small>'+({pending:'Ожидает модерации',approved:'Допущен',rejected:'Отклонён'}[e.status]||e.status)+'</small>'+
  '<div class="control-photo-actions">'+
  (c?.state==='draft'&&e.status!=='approved'?'<button class="approve" data-entry-id="'+e.id+'" data-entry-status="approved">Одобрить</button>':'')+
  (c?.state==='draft'&&e.status!=='rejected'?'<button class="reject" data-entry-id="'+e.id+'" data-entry-status="rejected">Отклонить</button>':'')+
  '<a href="/admin/contest" class="button secondary">Кадр / настройки ↗</a></div></article>').join('');
 const names={1:'🥇 Золото',2:'🥈 Серебро',3:'🥉 Бронза'};
 const deliveries=new Map((rewards.deliveries||[]).map(r=>[r.place,r]));
 $('contestRewards').innerHTML=Array.from({length:c?.prizePlaces||3},(_,i)=>{
  const p=(rewards.prizes||[]).find(p=>p.place===i+1);
  const d=deliveries.get(i+1),note=d?(d.status==='credited'?'✓ Начислено на BALI Card':
   '⌛ Ожидает начисления · попыток '+d.attempts):'Приз ещё не передан';
  return '<article class="control-reward"><strong>'+names[i+1]+'</strong>'+
   (p?.baliCoins||0)+' BALI Coin · '+escapeHtml((p?.bonuses||[]).map(b=>b.quantity+' × '+b.code).join(', ')||'без бонусов')+
   '<div>'+escapeHtml(note)+'</div></article>';
 }).join('');
}
$('contestPhotoGrid').addEventListener('click',async event=>{
 const button=event.target.closest('button[data-entry-id]');if(!button)return;
 if(!contestData?.contest||contestData.contest.state!=='draft')return;
 button.disabled=true;
 try{await action('/api/admin/contest/entries/'+button.dataset.entryId+'/status',{status:button.dataset.entryStatus});
  await loadContest();notice('Статус конкурсной заявки изменён.');}
 catch(e){notice(e.message,true);button.disabled=false;}
});
async function refreshPanel(){
 if($('controlDashboard').hidden)return;
 if(active==='screen')await loadScreen();
 if(active==='photos')await loadPhotos();
 if(active==='contest')await loadContest();
}
async function refreshAll(force=false){
 if(refreshing)return;refreshing=true;
 try{await refreshStatus();if(force||active!=='screen')await refreshPanel();}
 finally{refreshing=false;}
}
$('controlRefresh').addEventListener('click',()=>refreshAll(true).catch(e=>notice(e.message,true)));
setInterval(()=>{if(!document.hidden&&!$('controlDashboard').hidden)
 refreshAll(true).catch(e=>notice(e.message,true));},10000);
checkSession().catch(console.error);
})();