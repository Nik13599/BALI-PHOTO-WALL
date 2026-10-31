const page = document.body.dataset.page;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
async function api(url, options={}) {
  const response = await fetch(url,{credentials:'same-origin',...options});
  const body = await response.json().catch(()=>({}));
  if (!response.ok) { const error = new Error(body.error || 'Ошибка сервера'); error.code=response.status; throw error; }
  return body;
}
const action = (url, body, method='POST') => api(url,{method,headers:{'Content-Type':'application/json','X-BALI-Action':'1'},body:JSON.stringify(body)});
function notice(selector,text,bad=false) {
  const elem=$(selector); if(!elem) return;
  elem.textContent=text; elem.className='alert '+(bad?'bad':'good');
}
async function optimizePhoto(file) {
  if(file.size<=900000) return file;
  try {
    const bitmap=await createImageBitmap(file);
    const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.76));
    if(blob && blob.size<file.size) return new File([blob],'bali-photo.webp',{type:'image/webp'});
  } catch(error) { console.warn('Browser image optimization unavailable',error); }
  return file;
}
if(page==='guest') {
  const form=$('#uploadForm'), input=$('#photo'), btn=$('#uploadBtn');
  let uploadPolicy='any';
  let cropReady=false;
  api('/api/public').then(data=>{
    uploadPolicy=data.uploadShape==='square'?'square':'any';
    globalThis.BaliCropEditor?.setPolicy(uploadPolicy);
    $('#eventName').textContent=data.event?.name||'Нет активного мероприятия';
    const hint=$('#guestLimitsText');
    if(hint){
      hint.textContent=(data.limit===null
        ? 'Ограничение на количество фотографий от одного гостя отключено.'
        : 'До '+data.limit+' фото от одного гостя за мероприятие.')+
        ' Фото проходят модерацию и удаляются через установленный срок.';
    }
  })
    .catch(()=>$('#eventName').textContent='Сервис временно недоступен');
  input.addEventListener('change',async()=>{
    document.body.classList.toggle('has-photo',!!input.files[0]);
    $('#fileLabel').textContent=input.files[0]?.name || 'ВЫБРАТЬ ФОТОГРАФИЮ';
    cropReady=false;
    if(!input.files[0]){notice('#guestMessage','');return;}
    if(!['image/jpeg','image/png','image/webp'].includes(input.files[0].type)){
      input.value='';document.body.classList.remove('has-photo');
      notice('#guestMessage','Выбери JPEG, PNG или WebP',true);return;
    }
    try{
      if(!globalThis.BaliCropEditor?.load)throw new Error('Редактор обрезки не загрузился');
      await globalThis.BaliCropEditor.load(input.files[0]);
      cropReady=true;
      notice('#guestMessage','Передвинь фотографию, чтобы выбрать область показа.');
    }catch(error){
      // A blocked canvas/image decoder must not make ordinary guest uploads impossible.
      // The square-only rule still requires a working crop editor.
      if(uploadPolicy==='square'){
        input.value='';document.body.classList.remove('has-photo');
        notice('#guestMessage','Для квадратного кадра нужен редактор обрезки. Перезагрузи страницу.',true);
      }else{
        notice('#guestMessage','Можно отправить оригинальный снимок без обрезки.');
      }
      console.warn('Guest image editor unavailable:',error.message);
    }
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const file=input.files[0]; if(!file) return notice('#guestMessage','Выберите фотографию',true);
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)) return notice('#guestMessage','Нужен JPEG, PNG или WebP',true);
    if(!$('#consent').checked) return notice('#guestMessage','Подтвердите согласие на показ',true);
    btn.disabled=true; btn.textContent='ОТПРАВЛЯЕМ…';
    try {
      // Recheck the administrator's policy before sending an already edited photo.
      const current=await api('/api/public');
      const latest=current.uploadShape==='square'?'square':'any';
      if(latest!==uploadPolicy){
        uploadPolicy=latest;
        globalThis.BaliCropEditor?.setPolicy(uploadPolicy);
        throw new Error('Администратор изменил требования к формату. Проверьте обрезку и нажмите «Отправить» ещё раз.');
      }
      if(latest==='square'&&!cropReady)
        throw new Error('Для формата 1:1 обнови страницу и выбери кадр в редакторе.');
      const optimized=cropReady
        ? await globalThis.BaliCropEditor.exportFile()
        : await optimizePhoto(file);
      if(optimized.size>8*1024*1024)
        throw new Error('Снимок слишком большой. Выбери JPEG/PNG/WebP до 8 МБ.');
      const data=new FormData(); data.append('photo',optimized); data.append('consent','yes');
      let resp,result;
      for(let attempt=0;attempt<4;attempt++){
        resp=await fetch('/api/upload',{method:'POST',body:data,credentials:'same-origin'});
        result=await resp.json().catch(()=>({}));
        if(resp.status!==503 || result.code!=='BUSY' || attempt===3)break;
        notice('#guestMessage','Много фотографий одновременно. Пробуем ещё раз…');
        await new Promise(resolve=>setTimeout(resolve,1400*(attempt+1)+Math.random()*1000));
      }
      if(!resp.ok) throw new Error(result.error||'Ошибка загрузки');
      notice('#guestMessage','✓ Фото принято! Оно появится на экране после проверки.');
      form.reset();globalThis.BaliCropEditor?.clear();cropReady=false;
      document.body.classList.remove('has-photo');$('#fileLabel').textContent='ВЫБРАТЬ ФОТОГРАФИЮ';
    } catch(error) {notice('#guestMessage',error.message,true);}
    finally {btn.disabled=false;btn.innerHTML='ОТПРАВИТЬ ФОТО <span>↗</span>';}
  });
}
if(page==='admin') {
  const adminArea=location.pathname.endsWith('/contest')?'contest':'general';
  document.body.dataset.adminArea=adminArea;
  let replacingContestPhotoId=null;
  let busy=false;
  let previousDashboard=null;
  let selectedEventId=null;
  let displayedEventId=null;
  let pageNumber=1;
  let activePhotoStatus='pending';
  let contestFormDirty=false;
  const root=$('#adminRoot');
  async function refreshLocalBroadcast(){
   try{
    const data=await api('/api/admin/broadcast-state'),status=$('#localBroadcastStatus');
    if(status)status.textContent=data.active?'● ЭФИР '+data.runId.slice(0,8)+' · '+data.folder:
     '○ Трансляция не запущена. Включите в Telegram Admin.';
    const button=$('#restoreBroadcastPhotos');if(button)button.disabled=!data.active;
   }catch(error){const status=$('#localBroadcastStatus');if(status)status.textContent='Сервер недоступен: '+error.message}
  }
  async function loadDashboard(){
    if(busy) return;
    busy=true;
    try {
      const query=new URLSearchParams({page:String(pageNumber),status:activePhotoStatus,area:adminArea});
      if(selectedEventId!==null)query.set('eventId',String(selectedEventId));
      const data=await api('/api/admin/dashboard?'+query.toString());
      pageNumber=data.page;
      const signature=JSON.stringify([data.active,data.selected,data.events,data.photos,data.page,data.pages,data.total,data.counts,data.status]);
      if(signature===previousDashboard) return;
      previousDashboard=signature;
      if(!$('#dashboard')) {
        root.innerHTML=`<section id="dashboard" class="bali-admin-v2">
<div class="admin-heading">
  <div class="admin-identity"><div class="eyebrow">PHOTO WALL · ${adminArea==='contest'?'ROYAL CONTEST':'GENERAL CONTROL'}</div><h1>${adminArea==='contest'?'♛ МОДЕРАЦИЯ КОНКУРСА':'ОБЩАЯ ФОТОСТЕНА'}</h1><span class="muted" id="activeEvent"></span></div>
  <div class="admin-links"><a class="button secondary" href="/live/${adminArea}" target="_blank" rel="noopener">◩ ТРАНСЛЯЦИЯ</a><a class="button secondary" href="https://app.baliminsk.by/telegram-admin.html#tcPhoto" target="_blank" rel="noopener noreferrer">📲 TELEGRAM MINI APP</a><a class="button secondary" href="/control/${adminArea}" target="_blank" rel="noopener">⚙ НАСТРОЙКА ЭКРАНА</a><button type="button" class="button secondary" id="logoutBtn">ВЫЙТИ</button></div>
</div>
<nav class="admin-area-links" aria-label="Рабочие зоны PHOTO WALL"><a href="/admin/general" class="admin-area-link ${adminArea==='general'?'selected':''}">◩ ОБЩИЕ ФОТО</a></nav>
<div class="admin-quick-actions" aria-label="Управление PHOTO WALL">
  <button class="button secondary" type="button" data-open-panel="bulkPanel">＋ ЗАГРУЗИТЬ ФОТО</button>
  ${adminArea==='contest'?'<button class="button secondary" type="button" data-open-panel="contestPanel">⚙ ДОПОЛНИТЕЛЬНО</button>':''}
  <button class="button secondary" type="button" data-open-panel="eventPanel">📁 АРХИВ</button>
</div>
<div class="contest-moderation-banner"><b>Модерация конкурса</b>
 <span>1. Проверь фото. 2. Одобри или отклони. 3. Одобренные попадут в голосование.</span>
 <strong id="contestModeratorCounter" aria-live="polite">Проверяем новые фото…</strong></div>
<section class="panel" id="localBroadcastPanel" style="margin:10px 0;padding:13px">
 <h3>📡 ЕДИНЫЙ ЭФИР BALI</h3><p id="localBroadcastStatus" class="muted">Проверяем трансляцию…</p>
 <div style="display:flex;flex-wrap:wrap;gap:8px">
 <a class="button primary" href="https://app.baliminsk.by/telegram-admin.html#tcPhoto" target="_blank" rel="noopener">TELEGRAM ADMIN · ЗАПУСК</a>
 <a class="button secondary" href="/screen" target="_blank" rel="noopener">ЕДИНЫЙ LED-ЭКРАН</a>
 <button type="button" class="button secondary" id="restoreBroadcastPhotos">ВОССТАНОВИТЬ ФОТО</button>
 </div><p id="restoreBroadcastStatus" class="muted"></p>
 <small class="muted">Новая трансляция запускается исключительно в Telegram Admin. Здесь только модерация, архив и восстановление фотографий.</small>
 </section><details class="panel admin-drawer" id="eventPanel"><summary>${adminArea==='contest'?'Выбрать мероприятие конкурса':'Мероприятие и формат загрузки'}</summary>
  <div class="event-panel">
    <form id="eventForm" class="event-form"><input class="field" id="newEvent" maxlength="90" placeholder="Название новой вечеринки" required aria-label="Название новой вечеринки"><button class="button primary" type="submit">СОЗДАТЬ</button></form>
    <div id="eventList" class="event-list"></div>
    <div class="event-upload-policy"><label for="eventUploadShape">Формат фотографий на мероприятии</label><div class="event-upload-policy-controls"><select id="eventUploadShape" class="field"><option value="any">Любые пропорции</option><option value="square">Только квадратные 1:1</option></select><button id="saveUploadShape" type="button" class="button secondary">СОХРАНИТЬ</button></div></div>
  </div>
</details>
<details class="panel admin-bulk-panel admin-drawer" id="bulkPanel"><summary>Загрузка фотографий модератором</summary>
  <p class="muted">Можно выбрать сразу несколько JPEG, PNG или WebP. Фото отправляются партиями.</p>
  <form id="bulkPhotoForm">
    <input type="file" class="field" id="bulkPhotoFiles" accept="image/jpeg,image/png,image/webp" multiple required aria-label="Выберите фотографии">
    <div class="bulk-form-row"><label>Поток<select class="field" id="bulkPhotoLane"><option value="auto">Автоматически</option><option value="top">↑ Верхний</option><option value="bottom">↓ Нижний</option></select></label>
    <label>Статус<select class="field" id="bulkPhotoStatus"><option value="approved">Сразу на экран</option><option value="pending">На проверку</option></select></label>
    <button type="submit" class="button primary" id="bulkPhotoSubmit">ЗАГРУЗИТЬ</button></div>
    <div class="bulk-progress" id="bulkProgress" role="status" aria-live="polite"></div>
  </form>
</details>
<details class="panel admin-contest-panel admin-drawer" id="contestPanel"><summary>⚙ Технические настройки · редко нужны</summary>
  <form id="contestSettings" class="contest-settings-grid">
    <label class="contest-switch"><input type="checkbox" id="contestEnabled"> Конкурс включён</label>
    <label>Дата голосования (Минск)<input class="field" type="date" id="contestDate" required></label>
    <label>Открытие регистрации<input class="field" type="datetime-local" step="60" id="registrationOpensAt" required></label>
    <label>Закрытие регистрации<input class="field" type="datetime-local" step="60" id="registrationClosesAt" required></label>
    <label>Начало голосования<input class="field" type="datetime-local" step="60" id="votingStartsLocal" required></label>
    <label>Конец голосования<input class="field" type="datetime-local" step="60" id="votingEndsLocal" required></label>
    <label>Объявление победителя<input class="field" type="datetime-local" step="60" id="resultsLocal" required></label>
    <label>BALI Event ID (необязательно)<input class="field" id="contestBaliEvent" maxlength="16" placeholder="2026-10-30"></label>
    <button class="button primary" type="submit" id="contestSave">СОХРАНИТЬ РАСПИСАНИЕ</button>
  </form>
  <p class="muted" id="contestPhase">Загружаем расписание конкурса…</p>
  <p class="muted admin-hint">Все даты и часы устанавливаются вручную с точностью до минуты, по Минску (UTC+3). Регистрация заканчивается до голосования, итоги не раньше окончания. После начала голосования прошедшие этапы нельзя изменять.</p>
  <div class="panel" id="contestCloudQueuePanel" style="margin:12px 0;padding:12px;">
    <b>☁ Передача фото из Telegram</b>
    <p class="muted" id="contestCloudQueueStatus">Проверяем состояние облачной очереди…</p>
    <button id="contestCloudQueueRetry" type="button" class="button secondary">↻ ПРОВЕРИТЬ И ПЕРЕДАТЬ ФОТО ИЗ ОБЛАКА</button>
  </div>
  <div class="contest-candidates-head"><h3>Участники конкурса</h3><a id="contestExport" class="button secondary" href="#" download>↓ CSV</a></div>
  <form id="contestCandidateForm" class="event-form"><label>№ фото<input class="field" id="contestPhotoId" type="number" inputmode="numeric" min="1" required placeholder="ID"></label><label>Имя участника<input class="field" id="contestName" minlength="2" maxlength="70" required placeholder="Имя"></label><input type="hidden" id="contestCategory" value="king"><button class="button secondary" type="submit">＋ ДОБАВИТЬ</button></form>
  <div id="contestCandidates" class="event-list"></div><p class="muted" id="contestMessage" role="status"></p>
</details>
<nav class="admin-tabs" role="tablist" aria-label="Разделы фотографий">
  <button class="admin-tab" type="button" role="tab" data-admin-tab="pending">⏳ НОВЫЕ <b data-count="pending">0</b></button>
  <button class="admin-tab" type="button" role="tab" data-admin-tab="approved">✓ ${adminArea==='contest'?'ОДОБРЕНЫ':'НА ЭКРАНЕ'} <b data-count="approved">0</b></button>
  
  <button class="admin-tab" type="button" role="tab" data-admin-tab="rejected">× ОТКЛОНЕНЫ <b data-count="rejected">0</b></button>
</nav>
<section class="admin-photo-section" aria-live="off">
  <div class="admin-section-head"><div><h2 id="photoSectionTitle">Ожидают проверки</h2><p class="muted" id="selectedEvent"></p></div><span class="muted" id="photoCount"></span></div>
  <input type="file" id="contestReplaceFile" accept="image/jpeg,image/png,image/webp" hidden aria-label="Заменить фото конкурсанта">
  <div id="photoGrid" class="photo-grid"></div>
  <div class="page-controls" id="pageControls"></div>
</section>
<div class="alert" id="adminMessage" role="status" aria-live="polite"></div>
</section>`;
      }
      if(adminArea==='contest' && $('#bulkPhotoStatus')){
        $('#bulkPhotoStatus').value='pending';
        $('#bulkPhotoStatus').querySelector('option[value="approved"]').disabled=true;
      }
      $('#activeEvent').textContent=data.active?.name || 'Не выбрано';
      $('#photoCount').textContent=data.total+' фото · '+data.page+' / '+data.pages+' стр.';
      const counter=$('#contestModeratorCounter');
      if(counter)counter.textContent='Новые: '+(Number(data.counts?.pending)||0)+
       ' · одобренные: '+(Number(data.counts?.approved)||0);
      $('#selectedEvent').textContent=data.selected?.name||'Нет выбранного мероприятия';
      displayedEventId=data.selected?.id||null;
      void refreshLocalBroadcast();
      if($('#eventForm'))$('#eventForm').hidden=true;
      if($('#contestSettings'))$('#contestSettings').hidden=true;
      if(document.activeElement!==$('#eventUploadShape'))
        $('#eventUploadShape').value=data.selected?.upload_shape==='square'?'square':'any';
      $('#saveUploadShape').disabled=!displayedEventId;
      const sectionNames={pending:adminArea==='contest'?'Конкурс · ждут одобрения':'Ожидают проверки',approved:adminArea==='contest'?'Конкурс · одобренные':'Фотографии на экране',rejected:'Отклонённые фотографии'};
      $('#photoSectionTitle').textContent=sectionNames[activePhotoStatus]||'Фотографии';
      root.querySelectorAll('[data-admin-tab]').forEach(button=>{
        const current=button.dataset.adminTab===activePhotoStatus;
        button.classList.toggle('selected',current);
        button.setAttribute('aria-selected',String(current));
        button.tabIndex=current?0:-1;
      });
      root.querySelectorAll('[data-count]').forEach(element=>{
        element.textContent=String(data.counts?.[element.dataset.count]||0);
      });
      $('#eventList').innerHTML=data.events.map(e=>
        '<div class="event-choice"><button type="button" class="chip '+(e.id===data.selected?.id?'selected':'')+'" data-view="'+e.id+'">'+esc(e.name)+(e.active?' · ИДЁТ':'')+'</button>'+(e.active?'':'<button type="button" class="chip activate" data-activate="'+e.id+'" title="Вывести фото этого мероприятия на экраны">СДЕЛАТЬ АКТИВНЫМ</button>')+'</div>'
      ).join('');
      const actions=p=>{
        const photo=String(p.id);
        if(activePhotoStatus==='pending')return '<button class="button small approve" data-photo="'+photo+'" data-status="approved">✓ '+(adminArea==='contest'?'ДОПУСТИТЬ':'НА ЭКРАН')+'</button><button class="button small reject" data-photo="'+photo+'" data-status="rejected">× ОТКЛОНИТЬ</button>';
        if(activePhotoStatus==='approved')return '<button class="button small" data-photo="'+photo+'" data-status="pending">↩ НА ПРОВЕРКУ</button>'+(adminArea==='contest'&&!p.contest?'<button class="button small" data-contest-photo="'+photo+'">♛ ДОБАВИТЬ УЧАСТНИКА</button>':'');
        
        return '<button class="button small approve" data-photo="'+photo+'" data-status="approved">✓ ОДОБРИТЬ</button><button class="button small" data-photo="'+photo+'" data-status="pending">↩ НА ПРОВЕРКУ</button>';
      };
      $('#photoGrid').innerHTML=data.photos.length ? data.photos.map(p=>
        '<article class="photo-card '+(p.contest?'contest-photo':'')+'"><a href="/api/admin/photos/'+p.id+'?full=1" target="_blank" rel="noopener" title="Открыть полное фото"><img loading="lazy" alt="Фото #'+p.id+'" src="/api/admin/photos/'+p.id+'"></a><div class="photo-meta"><span>#'+p.id+(p.contest?' · ♛':'')+'</span><span class="status '+p.status+'">'+({pending:'ОЖИДАЕТ',approved:'ОДОБРЕНО',rejected:'ОТКЛОНЕНО'}[p.status])+'</span></div>'+
        (adminArea==='contest'&&p.telegramName?'<div class="photo-meta" style="display:block;overflow-wrap:anywhere">'+
          '<strong>'+esc(p.telegramName)+'</strong> · BALI Card '+esc(p.cardNumber||'не указан')+
          (p.telegramUsername?' · '+esc(p.telegramUsername):' · Telegram без @username')+
          '</div>':'')+
        (adminArea==='general'&&p.status==='approved'?'<label class="photo-lane-label">Поток <select class="photo-lane-select" data-lane-photo="'+p.id+'" aria-label="Направление фотографии #'+p.id+'"><option value="auto" '+((p.screen_lane||'auto')==='auto'?'selected':'')+'>Авто</option><option value="top" '+(p.screen_lane==='top'?'selected':'')+'>↑ Верх</option><option value="bottom" '+(p.screen_lane==='bottom'?'selected':'')+'>↓ Низ</option></select></label>':'')+
        '<div class="photo-actions">'+actions(p)+(adminArea==='contest'?'<button class="button small secondary" type="button" data-replace-photo="'+p.id+'">↥ ЗАМЕНИТЬ С ПК</button>':'')+'<button class="button small delete" data-photo="'+p.id+'" data-delete="true">Удалить</button></div></article>'
      ).join('') : '<div class="empty">'+({pending:'Новых фотографий пока нет. Как только гости загрузят снимки, они появятся здесь.',approved:'На обычной фотостене пока нет опубликованных фотографий.',contest:'В конкурсе пока нет одобренных фотографий.',rejected:'Отклонённых фотографий нет.'}[activePhotoStatus]||'Фотографий нет.')+'</div>';
      $('#pageControls').innerHTML = data.pages>1
        ? '<button class="button secondary" type="button" data-page="prev" '+(data.page<=1?'disabled':'')+'>← НАЗАД</button><span>Страница '+data.page+' из '+data.pages+'</span><button class="button secondary" type="button" data-page="next" '+(data.page>=data.pages?'disabled':'')+'>ВПЕРЁД →</button>'
        : '';
      if(adminArea==='contest'&&$('#contestPanel')?.open)void loadContest();
    } catch(error){
      if(error.code===401){if($('#dashboard')) {location.reload();return;}}
      notice('#adminMessage',error.message,true);
    } finally {busy=false;}
  }
  async function refreshCloudQueue(){
   const node=$('#contestCloudQueueStatus');if(!node)return;
   try{
    const state=await api('/api/admin/contest/cloud-queue');
    if(!node.isConnected)return;
    const at=state.checkedAtMs?new Date(state.checkedAtMs).toLocaleTimeString('ru-RU',{timeZone:'Europe/Minsk'}):null;
    const cloud=state.cloud,parts=[];
    if(cloud){
     parts.push('В облаке ожидают: '+cloud.waiting+' фото');
     if(cloud.events?.length)
      parts.push('Мероприятия: '+cloud.events.map(e=>e.eventId+' ('+e.count+')').join(', '));
     const selected=$('#contestBaliEvent')?.value?.trim();
     if(selected&&cloud.events?.some(e=>e.eventId!==selected)&&
       !cloud.events?.some(e=>e.eventId===selected))
      parts.push('Внимание: BALI Event ID выбранного конкурса ('+selected+
       ') не совпадает с мероприятием фото в облаке.');
    }else parts.push('Не удалось получить количество ожидающих фото из Cloudflare.');
    parts.push(state.running?'Передача выполняется…':
     at?'Последняя проверка '+at+' · принято '+state.delivered+' · ошибок '+state.failed+
      (state.reason?' · '+state.reason:''):
     'Пока не проверено. Нажмите кнопку, чтобы запросить доставку.');
    node.textContent=parts.join(' | ');
   }catch(error){node.textContent='Состояние очереди: '+error.message}
  }
  async function loadContest(){
    if(adminArea!=='contest'||!displayedEventId||!$('#contestPanel')?.open)return;
    const label=$('#contestMessage');
    try{
      const data=await api('/api/admin/contest?eventId='+displayedEventId);
      const settings=data.settings;
      const date=settings.contestDate||'';
      const previousDate=date?new Date(Date.parse(date+'T12:00:00+03:00')-86400000).toISOString().slice(0,10):'';
      const startLocal=date?date+'T03:00':'';
      const endLocal=settings.votingEndsLocal&&settings.votingEndsLocal>startLocal?
        settings.votingEndsLocal:(date?date+'T04:00':'');
      const values={
        contestEnabled:!!settings.enabled,
        contestDate:date,
        registrationOpensAt:settings.registrationOpensAt||(previousDate?previousDate+'T22:00':''),
        registrationClosesAt:settings.registrationClosesAt||startLocal,
        votingStartsLocal:settings.votingStartsLocal||startLocal,
        votingEndsLocal:settings.votingEndsLocal||endLocal,
        resultsLocal:settings.resultsLocal||endLocal,
        contestBaliEvent:settings.baliEventId||''
      };
      if(!contestFormDirty){
        for(const [id,value] of Object.entries(values)){
          const control=$('#'+id);if(!control)continue;
          if(control.type==='checkbox')control.checked=value;
          else control.value=value;
        }
      }
      const phase={disabled:'выключен',waiting:'ожидание начала',registration:'идёт регистрация',
        awaiting_voting:'ожидание голосования',voting:'идёт голосование',awaiting_results:'ожидание результатов',
        closed:'конкурс завершён'}[settings.phase]||settings.phase;
      $('#contestPhase').textContent=(data.liveContestEventId===displayedEventId?'● ЭТОТ КОНКУРС ТРАНСЛИРУЕТСЯ В TELEGRAM. ':'В TELEGRAM СЕЙЧАС: '+(data.liveContestName||'нет активного конкурса')+'. ')+'Этап: '+phase+
        (settings.finalizedAt?' · победитель: фото #'+(settings.winnerPhotoId||'нет')+
         ' · голосов победителя: '+settings.winnerVotes+' · всего: '+settings.totalVotes:
         settings.phase==='closed'?' · ожидается итог подсчёта':'')+
        (settings.tallyError?' · ошибка подсчёта: '+settings.tallyError:'');
      const locked=!!settings.finalizedAt||settings.phase==='closed';
      const started=!!settings.enabled&&['voting','awaiting_results','closed'].includes(settings.phase);
      const ended=!!settings.enabled&&['awaiting_results','closed'].includes(settings.phase);
      for(const id of ['contestEnabled','contestDate','contestBaliEvent',
        'registrationOpensAt','registrationClosesAt','votingStartsLocal']){
        const control=$('#'+id);
        control.disabled=locked||started;
        control.readOnly=false;
      }
      $('#votingEndsLocal').disabled=locked||ended;
      $('#resultsLocal').disabled=locked;
      $('#contestSave').disabled=locked;
      $('#contestSave').textContent=locked?'РЕЗУЛЬТАТ ЗАФИКСИРОВАН':'СОХРАНИТЬ ДАТЫ И ВРЕМЯ';
      $('#contestExport').href='/api/admin/contest/export?eventId='+displayedEventId;
      $('#contestCandidates').replaceChildren(...data.candidates.map(c=>{
        const row=document.createElement('div');row.className='event-choice';
        const title=document.createElement('span');
        title.textContent='#'+c.photoId+' · '+c.name+' · '+'КОРОЛЬ/КОРОЛЕВА'+
          (c.status==='approved'?'':' · Фото не одобрено');
        const remove=document.createElement('button');remove.type='button';remove.className='button small delete';
        remove.dataset.contestRemove=String(c.photoId);remove.textContent='Убрать из конкурса';
        row.append(title,remove);return row;
      }));
      label.textContent='Участников: '+data.candidates.length+' · конкурс '+
       (data.settings.enabled?'включён':'выключен')+' · этап: '+phase;
    }catch(error){label.textContent='Ошибка настроек конкурса: '+error.message}
  }
  root.addEventListener('click',event=>{
    if(event.target.closest('#contestPanel>summary'))setTimeout(()=>void loadContest(),0);
  });
  root.addEventListener('input',event=>{
    if(event.target.closest('#contestSettings'))contestFormDirty=true;
  });
  root.addEventListener('change',event=>{
    if(!event.target.closest('#contestSettings'))return;
    contestFormDirty=true;
    if(event.target.id==='contestDate'){
      // Move all five local timestamps by the same number of calendar days.
      // Keep each manually chosen clock hour and minute unchanged.
      const selected=event.target.value;
      const previous=$('#votingStartsLocal').value.slice(0,10);
      const delta=Date.parse(selected+'T12:00:00Z')-Date.parse(previous+'T12:00:00Z');
      if(Number.isFinite(delta)&&selected!==previous){
        for(const id of ['registrationOpensAt','registrationClosesAt','votingStartsLocal',
          'votingEndsLocal','resultsLocal']){
          const element=$('#'+id),raw=element.value;
          if(!raw||element.disabled)continue;
          const shifted=new Date(Date.parse(raw+':00Z')+delta);
          if(Number.isFinite(shifted.getTime()))element.value=shifted.toISOString().slice(0,16);
        }
      }
    }else if(event.target.id==='votingStartsLocal'){
      // Contest ID/date is the Minsk-local date of the vote start.
      const date=event.target.value.slice(0,10);
      if(date)$('#contestDate').value=date;
    }
  });
  api('/api/admin/me').then(loadDashboard).catch(()=>{});
  setInterval(()=>{if(adminArea==='contest'&&$('#contestPanel')?.open){void loadContest();void refreshCloudQueue()}},5000);
  if(adminArea==='contest')void refreshCloudQueue();
  $('#restoreBroadcastPhotos')?.addEventListener('click',async()=>{
   const status=$('#restoreBroadcastStatus'),button=$('#restoreBroadcastPhotos');
   if(!confirm('Индексировать вручную скопированные WebP-фотографии текущего эфира?'))return;
   button.disabled=true;status.textContent='Восстановление…';
   try{const result=await action('/api/admin/broadcast-restore',{});
    status.textContent=result.imported+' восстановлено · '+result.skipped+' уже существовало · '+result.failed+' пропущено. '+result.folder;
    previousDashboard=null;await loadDashboard();}
   catch(error){status.textContent='Ошибка восстановления: '+error.message}
   finally{button.disabled=false}
  });
  root.addEventListener('submit',async event=>{
    if(event.target.id==='loginForm'){
      event.preventDefault();
      try {
        await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value})});
        root.innerHTML='<div class="panel"><p class="muted">Загружаем панель модерации…</p><div id="adminMessage" class="alert" role="status"></div></div>';await loadDashboard();
      } catch(error){notice('#adminMessage',error.message,true);}
    }
    if(event.target.id==='contestSettings'){
      event.preventDefault();if(!displayedEventId)return;
      try{
        await action('/api/admin/contest/settings',{eventId:displayedEventId,
          enabled:$('#contestEnabled').checked,contestDate:$('#contestDate').value,
          registrationOpensAt:$('#registrationOpensAt').value,
          registrationClosesAt:$('#registrationClosesAt').value,
          votingStartsLocal:$('#votingStartsLocal').value,
          votingEndsLocal:$('#votingEndsLocal').value,
          resultsLocal:$('#resultsLocal').value,
          baliEventId:$('#contestBaliEvent').value.trim()});
        contestFormDirty=false;
        await loadContest();notice('#adminMessage','Расписание конкурса сохранено.');
      }catch(error){notice('#adminMessage',error.message,true)}
    }
    if(event.target.id==='contestCandidateForm'){
      event.preventDefault();if(!displayedEventId)return;
      try{
        await action('/api/admin/contest/candidates',{action:'add',eventId:displayedEventId,
         photoId:Number($('#contestPhotoId').value),name:$('#contestName').value.trim(),
         category:$('#contestCategory').value});
        $('#contestPhotoId').value='';$('#contestName').value='';
        previousDashboard=null;await loadDashboard();await loadContest();notice('#adminMessage','Участник конкурса сохранён.');
      }catch(error){notice('#adminMessage',error.message,true)}
    }
    if(event.target.id==='bulkPhotoForm'){
      event.preventDefault();
      const files=[...$('#bulkPhotoFiles').files];
      if(!displayedEventId||!files.length)return;
      const allowed=files.filter(file=>['image/jpeg','image/png','image/webp'].includes(file.type));
      if(allowed.length!==files.length){
        notice('#adminMessage','Выбери только JPEG, PNG или WebP.',true);return;
      }
      const button=$('#bulkPhotoSubmit'),progress=$('#bulkProgress');
      button.disabled=true;
      let imported=0,failed=0,done=0;
      try{
        for(let index=0;index<files.length;index+=8){
          const form=new FormData();
          form.append('eventId',String(displayedEventId));
           form.append('area',adminArea);
          form.append('lane',$('#bulkPhotoLane').value);
          form.append('status',$('#bulkPhotoStatus').value);
          for(const file of files.slice(index,index+8)){
            const optimized=await optimizePhoto(file);
            form.append('photos',optimized,file.name);
          }
          const result=await api('/api/admin/photos/bulk',{
            method:'POST',headers:{'X-BALI-Action':'1'},body:form
          });
          imported+=result.imported;failed+=result.failed;
          done+=Math.min(8,files.length-index);
          progress.textContent='Обработано '+done+' из '+files.length+' · загружено '+imported+' · ошибок '+failed;
        }
        $('#bulkPhotoFiles').value='';
        previousDashboard=null;await loadDashboard();
        notice('#adminMessage','Массовая загрузка завершена: '+imported+' фото. Ошибок: '+failed,failed>0);
      }catch(error){
        progress.textContent='Загрузка остановлена после '+done+' из '+files.length+' файлов.';
        notice('#adminMessage',error.message+'. Уже импортированные фотографии сохранены.',true);
      }finally{button.disabled=false;}
    }
    if(event.target.id==='eventForm'){
      event.preventDefault();
      const name=$('#newEvent').value.trim();
      if(!name) return;
      try{await action('/api/admin/events',{name});selectedEventId=null;pageNumber=1;$('#newEvent').value='';await loadDashboard();}
      catch(error){notice('#adminMessage',error.message,true);}
    }
  });
  root.addEventListener('change',async event=>{
    if(event.target.id==='contestReplaceFile'){
      const file=event.target.files?.[0],id=replacingContestPhotoId;
      replacingContestPhotoId=null;
      if(!file||!Number.isSafeInteger(id)||id<1)return;
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size===0||file.size>8*1024*1024){
        notice('#adminMessage','Нужен JPG, PNG или WebP до 8 МБ.',true);event.target.value='';return;
      }
      try{
        const form=new FormData();form.append('photo',file,file.name);
        await api('/api/admin/photos/'+id+'/replace',{method:'POST',
          headers:{'X-BALI-Action':'1'},body:form});
        previousDashboard=null;
        await loadDashboard();
        notice('#adminMessage','Фото #'+id+' заменено. Номер участника и голоса не изменились.');
      }catch(error){notice('#adminMessage',error.message,true)}
      finally{event.target.value=''}
      return;
    }
    const input=event.target.closest('[data-lane-photo]');
    if(!input)return;
    const id=Number(input.dataset.lanePhoto);
    const value=input.value;
    try{
      await action('/api/admin/photos/'+id+'/screen-lane',{lane:value});
      previousDashboard=null;
      await loadDashboard();
      notice('#adminMessage','Поток фотографии сохранён.');
    }catch(error){
      notice('#adminMessage',error.message,true);
      previousDashboard=null;await loadDashboard();
    }
  });
  root.addEventListener('click',async event=>{
    const el=event.target.closest('button');if(!el)return;
    try{
      if(el.id==='contestCloudQueueRetry'){
        el.disabled=true;
        const label=$('#contestCloudQueueStatus');
        if(label)label.textContent='Запускаем повторную передачу из Cloudflare…';
        try{
         const result=await action('/api/admin/contest/cloud-queue/retry',{});
         if(label)label.textContent=result.started?'Запрос принят. Фото проверяются и передаются…':
          'Предыдущая синхронизация ещё выполняется.';
         setTimeout(()=>void refreshCloudQueue(),1500);
        }catch(error){if(label)label.textContent='Ошибка: '+error.message}
        finally{el.disabled=false}
      }else if(el.dataset.replacePhoto){
        if(adminArea!=='contest')throw Error('Замена доступна только для конкурса');
        const id=Number(el.dataset.replacePhoto);
        if(!Number.isSafeInteger(id)||id<1)return;
        const input=$('#contestReplaceFile');
        if(!input)return;
        replacingContestPhotoId=id;
        input.value='';
        input.click();
      }else if(el.dataset.openPanel){
        const panel=$('#'+el.dataset.openPanel);
        if(panel){panel.open=!panel.open;if(panel.open&&panel.id==='contestPanel')await loadContest();}
      }else if(el.dataset.adminTab){
        if(activePhotoStatus===el.dataset.adminTab)return;
        activePhotoStatus=el.dataset.adminTab;pageNumber=1;previousDashboard=null;
        await loadDashboard();
        
      }else if(el.dataset.contestPhoto){
        $('#contestPanel').open=true;$('#contestPhotoId').value=el.dataset.contestPhoto;
        $('#contestPanel').scrollIntoView({behavior:'smooth',block:'start'});
        await loadContest();$('#contestName').focus();
      }else if(el.dataset.contestRemove){
        if(!displayedEventId||!confirm('Убрать фотографию из конкурса? Само фото останется.'))return;
        await action('/api/admin/contest/candidates',{action:'remove',
         eventId:displayedEventId,photoId:Number(el.dataset.contestRemove)});
        await loadContest();
      }else if(el.id==='logoutBtn'){await action('/api/admin/logout',{});location.reload();}
      else if(el.id==='saveUploadShape'){
        if(!displayedEventId)return;
        await action('/api/admin/events/'+displayedEventId+'/upload-shape',{uploadShape:$('#eventUploadShape').value});
        previousDashboard=null;await loadDashboard();
        notice('#adminMessage','✓ Формат загрузки сохранён.');
      }
      else if(el.dataset.view){selectedEventId=Number(el.dataset.view);pageNumber=1;contestFormDirty=false;previousDashboard=null;await loadDashboard();if($('#contestPanel')?.open)await loadContest();}
      else if(el.dataset.page){pageNumber=Math.max(1,pageNumber+(el.dataset.page==='next'?1:-1));await loadDashboard();}
      else if(el.dataset.activate){
        if(!confirm('Сделать это мероприятие текущим? Показ на LED-экране переключится.'))return;
        await action('/api/admin/events/'+el.dataset.activate+'/activate',{});
        selectedEventId=null;pageNumber=1;contestFormDirty=false;previousDashboard=null;await loadDashboard();
      }
      else if(el.dataset.status){await action('/api/admin/photos/'+el.dataset.photo+'/status',{status:el.dataset.status});await loadDashboard();}
      else if(el.dataset.delete){if(!confirm('Удалить фотографию без возможности восстановления?'))return;
        await action('/api/admin/photos/'+el.dataset.photo,{},'DELETE');await loadDashboard();}
    }catch(error){notice('#adminMessage',error.message,true);}
  });
  setInterval(()=>{if($('#dashboard')&&!document.hidden)loadDashboard();},6000);
}
if(page==='screen'){
  const MAX_WALL_PHOTOS=500;
  const screenPath=location.pathname;
  const broadcastArea=screenPath.endsWith('/contest')||new URLSearchParams(location.search).get('feed')==='contest'?'contest':'general';
  const controller=screenPath.startsWith('/control/');
  document.body.dataset.screenArea=broadcastArea;
  document.body.dataset.screenMode=controller?'control':'broadcast';
  const broadcastLink=$('#controlLiveLink');
  if(broadcastLink)broadcastLink.href='/live/'+broadcastArea;
  if(broadcastArea==='contest'){
    const hint=$('#eventHint');
    if(hint)hint.textContent='КОРОЛЬ / КОРОЛЕВА · ГОЛОСОВАНИЕ В ПРИЛОЖЕНИИ BALI';
    const qrSetting=$('#setShowQr');
    if(qrSetting){
      qrSetting.disabled=true;
      qrSetting.closest('label')?.setAttribute('title','Конкурс не использует QR загрузки обычной фотостены');
    }
    const qrBlock=$('#wallQR');
    if(qrBlock)qrBlock.hidden=true;
  }
  const profileTitle=$('#wallSettings .wall-settings-head strong');
  if(profileTitle)profileTitle.textContent=broadcastArea==='contest'?'♛ Пульт конкурса':'◩ Пульт общей фотостены';
  const defaults={
    maxPhotos:500,columns:0,gap:2,fit:'contain',layout:'puzzle',centerGrowth:true,
    liveInterval:8,liveFocus:40,liveTransition:1400,liveFit:'cover',livePause:false,showcaseInterval:3,
    carouselStart:10,carouselSpeed:85,carouselOuterSpeed:120,carouselTopHeight:12,carouselBottomHeight:12,carouselCenterSplit:50,carouselPause:false,
    logoPos:'tl',livePos:'tr',eventPos:'bl',hintPos:'bc',qrPos:'br',
    logoX:0,logoY:0,liveX:0,liveY:0,eventX:0,eventY:0,hintX:0,hintY:0,qrX:0,qrY:0,
    logoSize:28,liveSize:20,eventSize:32,qrSize:92,inset:18,
    showLogo:true,showLive:true,showEvent:true,showQr:true,showHint:true
  };
  const limits={
    maxPhotos:[1,500],columns:[0,40],gap:[0,16],
    liveInterval:[3,45],liveFocus:[25,65],liveTransition:[300,2500],showcaseInterval:[2,12],
    carouselStart:[5,30],carouselSpeed:[20,260],carouselOuterSpeed:[20,300],carouselTopHeight:[6,25],carouselBottomHeight:[6,25],carouselCenterSplit:[25,75],
    logoX:[-250,250],logoY:[-250,250],liveX:[-250,250],liveY:[-250,250],
    eventX:[-250,250],eventY:[-250,250],hintX:[-250,250],hintY:[-250,250],
    qrX:[-250,250],qrY:[-250,250],
    logoSize:[24,240],liveSize:[10,55],eventSize:[12,85],
    qrSize:[40,250],inset:[0,80]
  };
  let settings={...defaults};
  const embeddedLogo=$('#wallLogo')?.getAttribute('src')||'/bali-logo.svg';
  let profileRevision=-1,logoRevision=-1,dirtyProfile=false,profileSaveTimer=0,profileLoading=false;
  const profileUrl='/api/screen/profile?feed='+broadcastArea;
  const profileSaveUrl='/api/admin/screen/profile?feed='+broadcastArea;
  const profileLogoUrl='/api/screen/profile-logo?feed='+broadcastArea;
  function profileNotice(message,bad=false){
    const label=$('#screenProfileMessage');
    if(!label)return;
    label.textContent=message;
    label.style.color=bad?'#ff9a8c':'#d7ff4d';
  }
  function useRemoteLogo(revision){
    if(revision===logoRevision)return;
    logoRevision=revision;
    $('#wallLogo').src=revision>0?profileLogoUrl+'&v='+revision:embeddedLogo;
  }
  async function syncProfile(force=false){
    if(profileLoading||controller&&dirtyProfile&&!force)return;
    profileLoading=true;
    try{
      const saved=await api(profileUrl);
      if(!controller||!dirtyProfile){
        if(force||profileRevision!==saved.revision){
          settings={...defaults,...saved.settings};
          profileRevision=saved.revision;
          applySettings();
        }
      }
      useRemoteLogo(saved.logoRevision||0);
      if(controller&&profileRevision<0)profileRevision=saved.revision;
      if(controller&&force)profileNotice('Настройки загружены с сервера');
    }catch(error){
      console.warn('Screen settings sync:',error.message);
      if(controller)profileNotice('Настройки не получены: '+error.message,true);
    }finally{profileLoading=false;}
  }
  function saveProfileSoon(){
    if(!controller)return;
    dirtyProfile=true;
    profileNotice('Сохраняем настройки на сервере…');
    clearTimeout(profileSaveTimer);
    profileSaveTimer=setTimeout(async()=>{
      const snapshot={...settings};
      try{
        const response=await action(profileSaveUrl,{settings:snapshot});
        profileRevision=response.revision;
        if(JSON.stringify(snapshot)===JSON.stringify(settings))dirtyProfile=false;
        profileNotice('✓ Настройки сохранены · трансляция обновится автоматически');
      }catch(error){
        profileNotice('Не удалось сохранить: '+error.message,true);
      }
    },450);
  }
  const screen=$('#wallScreen'),grid=$('#wallGrid'),empty=$('#wallEmpty'),login=$('#screenLogin'),panel=$('#wallSettings');
  const controls=[...document.querySelectorAll('[data-wall-setting]')];
  let photos=[],eventId=null,signature='',failedPolls=0,wasAuthenticated=false;
  const setShown=(element,visible)=>{ if(element)element.hidden=!visible; };
  const floatingElements={logo:$('#wallLogo'),live:$('#wallLive'),event:$('#screenEvent'),hint:$('#eventHint'),qr:$('#wallQR')};
  const anchors={tl:[0,0],tc:[.5,0],tr:[1,0],ml:[0,.5],mc:[.5,.5],mr:[1,.5],bl:[0,1],bc:[.5,1],br:[1,1]};
  function positionFloating(){
    for(const [key,element] of Object.entries(floatingElements)){
      const pos=anchors[settings[key+'Pos']]||anchors.tl;
      const responsiveScale=Math.max(.65,Math.min(1,Math.min(screen.clientWidth/960,screen.clientHeight/540)));
      const dx=Math.round((settings[key+'X']||0)*responsiveScale);
      const dy=Math.round((settings[key+'Y']||0)*responsiveScale);
      const inset=Math.round(settings.inset*responsiveScale);
      element.style.left=pos[0]===0?inset+'px':pos[0]===.5?'50%':'auto';
      element.style.right=pos[0]===1?inset+'px':'auto';
      element.style.top=pos[1]===0?inset+'px':pos[1]===.5?'50%':'auto';
      element.style.bottom=pos[1]===1?inset+'px':'auto';
      element.style.transform='translate(calc('+(pos[0]===.5?'-50% + ':'')+dx+'px),calc('+(pos[1]===.5?'-50% + ':'')+dy+'px))';
    }
  }
  function syncShiftControls(){
    const key=$('#wallShiftTarget').value;
    $('#wallShiftX').value=String(settings[key+'X']);
    $('#wallShiftY').value=String(settings[key+'Y']);
    $('#wallShiftXValue').textContent=String(settings[key+'X']);
    $('#wallShiftYValue').textContent=String(settings[key+'Y']);
  }
  $('#wallShiftTarget').addEventListener('change',syncShiftControls);
  for(const [axis,input] of [['X',$('#wallShiftX')],['Y',$('#wallShiftY')]]){
    input.addEventListener('input',()=>{
      const key=$('#wallShiftTarget').value+axis;
      settings[key]=Number(input.value);
      syncShiftControls();positionFloating();saveProfileSoon();
    });
  }
  function applySettings(){
    const fitScale=Math.max(.65,Math.min(1,Math.min(screen.clientWidth/960,screen.clientHeight/540)));
    screen.style.setProperty('--wall-gap',settings.gap+'px');
    screen.style.setProperty('--bali-display-scale',String(fitScale));
    screen.style.setProperty('--wall-fit',settings.fit);
    screen.style.setProperty('--wall-logo-size',Math.max(17,Math.round(settings.logoSize*fitScale))+'px');
    screen.style.setProperty('--wall-live-size',Math.max(10,Math.round(settings.liveSize*fitScale))+'px');
    screen.style.setProperty('--wall-event-size',Math.max(10,Math.round(settings.eventSize*fitScale))+'px');
    screen.style.setProperty('--wall-qr-size',Math.max(36,Math.round(settings.qrSize*fitScale))+'px');
    screen.style.setProperty('--wall-inset',Math.round(settings.inset*fitScale)+'px');
    setShown($('#wallLogo'),settings.showLogo);
    setShown($('#wallLive'),settings.showLive);
    setShown($('#screenEvent'),settings.showEvent);
    setShown($('#eventHint'),settings.showHint);
    setShown($('#wallQR'),broadcastArea==='general'&&settings.showQr);
    positionFloating();syncShiftControls();
    $('#columnsSettings').hidden=settings.layout!=='grid';
    $('#carouselSettings').hidden=!globalThis.BaliCarousel?.isCarousel(settings.layout);
    $('#liveMosaicSettings').hidden=settings.layout!=='live-mosaic';
    $('#showcaseSettings').hidden=!settings.layout.startsWith('showcase-');
    for(const control of controls){
      const key=control.dataset.wallSetting;
      if(control.type==='checkbox')control.checked=settings[key];
      else control.value=String(settings[key]);
      const output=document.getElementById('out'+key[0].toUpperCase()+key.slice(1));
      if(output)output.textContent=key==='columns' && settings[key]===0?'Авто':settings[key];
    }
    layout();
  }
  function getPhotoUrl(id,n){
    // A full-size photo is used for one or a few images, while lightweight
    // thumbnails keep a 500-tile wall responsive on standard LED hardware.
    return (n<=6 ? '/api/photos/'+id : '/api/screen/thumbnail/'+id)+'?feed='+broadcastArea;
  }
  function buildTile(photo,n,existing){
    const tile=existing.get(photo.id) || document.createElement('div');
    tile.className='wall-tile';
    tile.dataset.id=String(photo.id);
    let img=tile.querySelector('img');
    if(!img){
      img=document.createElement('img');
      img.alt='';
      img.decoding='async';
      img.loading='eager';
      img.addEventListener('error',()=>tile.classList.add('wall-tile-error'));
      img.addEventListener('load',()=>tile.classList.remove('wall-tile-error'));
      tile.append(img);
    }
    const source=getPhotoUrl(photo.id,n);
    if(img.getAttribute('src')!==source)img.src=source;
    return tile;
  }
  function layout(){
    const all=photos.slice(0,settings.maxPhotos);
    const n=all.length;
    setShown(empty,n===0);
    if(!n){
      grid.replaceChildren();
      globalThis.BaliCarouselWall?.stop();
      globalThis.BaliLiveWall?.stop();
      globalThis.BaliShowcaseWall?.stop();
      return;
    }
    if(settings.layout==='live-mosaic' && globalThis.BaliLiveWall){
      globalThis.BaliCarouselWall?.stop();
      globalThis.BaliLiveWall.render({grid,photos:all,eventId,settings,getPhotoUrl});
      return;
    }
    globalThis.BaliLiveWall?.stop();
    if(settings.layout.startsWith('showcase-')&&globalThis.BaliShowcaseWall){
      globalThis.BaliCarouselWall?.stop();
      globalThis.BaliShowcaseWall.render({grid,photos:all,eventId,settings,getPhotoUrl});
      return;
    }
    globalThis.BaliShowcaseWall?.stop();
    if(globalThis.BaliCarousel?.isCarousel(settings.layout) && n>=settings.carouselStart &&
        globalThis.BaliCarouselWall){
      globalThis.BaliCarouselWall.render({grid,photos:all,eventId,settings,getPhotoUrl});
      return;
    }
    globalThis.BaliCarouselWall?.stop();
    const stage=grid.querySelector('.wall-cluster')||document.createElement('div');
    stage.className='wall-cluster';
    const boxW=grid.clientWidth||screen.clientWidth;
    const boxH=grid.clientHeight||screen.clientHeight;
    // A small gallery lives in the centre. Every incoming photo grows the
    // composition outward until its bounds meet the LED screen edges.
    const scale=settings.centerGrowth?Math.min(1,.68+.047*Math.sqrt(n)):1;
    let stageW=Math.max(1,boxW*scale),stageH=Math.max(1,boxH*scale);
    if(n===1 && settings.layout==='puzzle'){
      // One portrait or square remains entirely visible, never forced into 16:9.
      const ratio=Math.max(.28,Math.min(4,(Number(all[0].width)||1)/(Number(all[0].height)||1)));
      if(stageW/stageH>ratio)stageW=stageH*ratio;
      else stageH=stageW/ratio;
    }
    const oldRects=new Map([...stage.querySelectorAll('.wall-tile')].map(el=>[Number(el.dataset.id),el.getBoundingClientRect()]));
    const existing=new Map([...stage.querySelectorAll('.wall-tile')].map(el=>[Number(el.dataset.id),el]));
    const fragment=document.createDocumentFragment();
    if((settings.layout==='puzzle'||globalThis.BaliCarousel?.isCarousel(settings.layout)) && globalThis.BaliMosaic){
      const mosaic=globalThis.BaliMosaic.compute(all,stageW,stageH,settings.gap);
      for(const rowData of mosaic.rows){
        const row=document.createElement('div');
        row.className='wall-grid-row wall-puzzle-row';
        row.style.flex='0 0 '+rowData.height+'px';
        for(let i=0;i<rowData.items.length;i++){
          const tile=buildTile(rowData.items[i],n,existing);
          tile.style.flex='0 0 '+rowData.widths[i]+'px';
          row.append(tile);
        }
        fragment.append(row);
      }
    } else {
      const ratio=Math.max(.65,stageW/Math.max(1,stageH));
      let cols=settings.columns||Math.max(1,Math.round(Math.sqrt(n*ratio)));
      if(!settings.columns && n===3)cols=3;
      cols=Math.min(n,Math.max(1,cols));
      const rows=Math.ceil(n/cols);
      const perRow=Math.floor(n/rows),extra=n%rows;
      let offset=0;
      for(let rowIndex=0;rowIndex<rows;rowIndex++){
        const row=document.createElement('div');row.className='wall-grid-row';
        const count=perRow+(rowIndex<extra?1:0);
        for(let col=0;col<count;col++){
          const tile=buildTile(all[offset++],n,existing);
          tile.style.removeProperty('flex');
          row.append(tile);
        }
        fragment.append(row);
      }
    }
    stage.style.setProperty('--wall-fit',(settings.layout==='puzzle'||globalThis.BaliCarousel?.isCarousel(settings.layout))?'contain':settings.fit);
    stage.style.width=stageW+'px';
    stage.style.height=stageH+'px';
    stage.replaceChildren(fragment);
    if(stage.parentElement!==grid)grid.replaceChildren(stage);
    // Only animate a reasonably sized gallery. Hundreds of animated tiles
    // would overload a modest LED controller and delay new photographs.
    if(n<=80 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      const nextRects=new Map([...stage.querySelectorAll('.wall-tile')].map(el=>[Number(el.dataset.id),el.getBoundingClientRect()]));
      for(const tile of stage.querySelectorAll('.wall-tile')){
        const id=Number(tile.dataset.id),was=oldRects.get(id),next=nextRects.get(id);
        if(!next)continue;
        const from=was?
          {transform:'translate('+(was.left-next.left)+'px,'+(was.top-next.top)+'px) scale('+(was.width/Math.max(1,next.width))+','+(was.height/Math.max(1,next.height))+')',opacity:1}:
          {transform:'scale(.92)',opacity:0};
        if(was && Math.abs(was.left-next.left)+Math.abs(was.top-next.top)+Math.abs(was.width-next.width)<1)continue;
        tile.animate([from,{transform:'none',opacity:1}],{
          duration:620,easing:'cubic-bezier(.18,.8,.18,1)'
        });
      }
    }
  }
  function clearWall(){
    const result=$('#royalResult');if(result)result.hidden=true;lastRoyalWinner=null;countdownEnd=null;countdown.hidden=true;
    $('#wallGrid').style.removeProperty('display');$('#wallEmpty').style.removeProperty('display');
    photos=[];signature='';eventId=null;
    const candidates=$('#contestOverlay');if(candidates)candidates.hidden=true;
    globalThis.BaliCarouselWall?.reset();
    globalThis.BaliLiveWall?.reset();
    layout();
  }
  let countdownEnd=null,countdownClockOffset=0;
  const countdown=document.createElement('div');countdown.className='royal-test-countdown';countdown.hidden=true;
  countdown.setAttribute('role','status');document.body.append(countdown);
  function paintContestCountdown(){
   const left=countdownEnd?Math.max(0,Math.ceil((countdownEnd-(Date.now()+countdownClockOffset))/1000)):null;
   countdown.hidden=left===null;
   if(left!==null)countdown.textContent=left>0?'ПОБЕДИТЕЛЬ ЧЕРЕЗ '+left:'ВЫБИРАЕМ ПОБЕДИТЕЛЯ…';
  }
  setInterval(paintContestCountdown,200);
  let lastRoyalWinner=null,contestCarouselSignature='';
  function showContestCarousel(contest){
    const overlay=$('#contestOverlay'),track=$('#contestOverlayTrack');
    if(!overlay||!track)return;
    const entries=contest?.phase!=='closed'&&Array.isArray(contest?.participants)?
      contest.participants.slice(0,10):[];
    if(!entries.length){overlay.hidden=true;contestCarouselSignature='';track.replaceChildren();return}
    const next=String(contest.event?.id||'')+':'+entries.map(x=>x.id+'/'+x.number+'/'+x.name).join('|');
    overlay.hidden=false;
    if(next===contestCarouselSignature)return;
    contestCarouselSignature=next;
    const makeCard=participant=>{
     const card=document.createElement('article');card.className='contest-overlay-card';
     const badge=document.createElement('span');badge.className='contest-overlay-number';
     badge.textContent='№ '+String(participant.number);
     const image=document.createElement('img');image.alt='Участник конкурса № '+participant.number;
     image.loading='eager';image.decoding='async';
     image.src='/api/screen/thumbnail/'+encodeURIComponent(participant.id)+'?feed=contest';
     const name=document.createElement('strong');
     name.textContent=participant.name||'Участник № '+participant.number;
     card.append(badge,image,name);
     return card;
    };
    const loop=entries.length>1;
    const items=loop?entries.concat(entries):entries;
    track.replaceChildren(...items.map(makeCard));
    track.classList.toggle('is-static',!loop);
    track.style.setProperty('--bali-contest-marquee-duration',Math.max(24,entries.length*6)+'s');
  }
  async function refresh(){
    try{
      const data=await api('/api/screen');
      const contestData=await api('/api/screen/contest').catch(()=>null);
      showContestCarousel(contestData);
      await syncProfile();
      failedPolls=0;
      wasAuthenticated=true;
      login.hidden=true;
      const event=data.event?.id??null;
      const eventName=data.event?.name||'BALI NIGHT CLUB';
      $('#screenEvent').textContent=eventName;
      countdownEnd=contestData?.testMode&&Number.isSafeInteger(contestData.countdownEndsAtMs)&&!contestData.finalized?contestData.countdownEndsAtMs:null;
      countdownClockOffset=Number.isSafeInteger(contestData?.serverNowMs)?contestData.serverNowMs-Date.now():0;paintContestCountdown();
      const royal=$('#royalResult');
      if(royal){
        const winners=Array.isArray(contestData?.winners)?contestData.winners:
          (contestData?.winner?[{...contestData.winner,place:1}]:[]);
        const ready=contestData?.phase==='closed'&&contestData.finalized===true&&winners.length>0;
        const key=ready?(contestData?.event?.id||event)+':'+winners.map(w=>w.place+'/'+w.id+'/'+w.votes).join(';'):null;
        const grid=$('#wallGrid');
        if(ready){
          const heading=royal.querySelector('.royal-podium-heading');
          if(heading)heading.textContent='🏆 '+String(contestData?.contestTitle||'ПОБЕДИТЕЛИ BALI');
          grid.style.display='none';
          $('#wallEmpty').style.display='none';
          if(lastRoyalWinner!==key){
            const podium=$('#royalPodium');
            const frag=document.createDocumentFragment();
            for(const w of winners.slice(0,3)){
              if(![1,2,3].includes(w.place)||!Number.isSafeInteger(Number(w.id)))continue;
              const item=document.createElement('div');item.className='royal-place';
              item.dataset.place=String(w.place);
              const crown=document.createElement('div');crown.className='royal-place-crown';
              // A real vector crown, not a font-dependent chess glyph.
              // The crown overlaps the photo's upper edge; face tracking is not implied.
              crown.innerHTML='<svg viewBox="0 0 120 92" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Корона"><path d="M9 28 33 46 59 7 87 46 111 28 101 73H19Z" fill="currentColor" stroke="#fff4c9" stroke-width="2.5" stroke-linejoin="round"/><path d="M18 70h84v14H18z" fill="currentColor" stroke="#fff4c9" stroke-width="2.5"/><path d="M25 76h70" stroke="#fff4c9" stroke-width="3" stroke-linecap="round"/><circle cx="9" cy="27" r="6" fill="#fff2bf"/><circle cx="59" cy="7" r="6" fill="#fff2bf"/><circle cx="111" cy="27" r="6" fill="#fff2bf"/></svg>';
              const image=document.createElement('img');image.className='royal-place-photo';
              image.alt='Фотография призёра BALI';
              image.src='/api/screen/thumbnail/'+encodeURIComponent(w.id)+'?feed=contest';
              const name=document.createElement('strong');name.className='royal-place-name';
              name.textContent=w.name||'Участник BALI';
              const medal=document.createElement('div');medal.className='royal-place-medal';
              medal.textContent=w.place===1?'🥇 ЗОЛОТО · 1 МЕСТО':
                w.place===2?'🥈 СЕРЕБРО · 2 МЕСТО':'🥉 БРОНЗА · 3 МЕСТО';
              const votes=document.createElement('span');votes.className='royal-place-votes';
              votes.textContent=Number(w.votes||0)+' голосов';
              item.append(crown,image,name,medal,votes);frag.append(item);
            }
            podium.replaceChildren(frag);
            royal.hidden=true;
            void royal.offsetWidth;
            royal.hidden=false;
            lastRoyalWinner=key;
          }
        }else{
          royal.hidden=true;
          lastRoyalWinner=null;
          grid.style.removeProperty('display');
          $('#wallEmpty').style.removeProperty('display');
          if(data.phase==='closed'){
            $('#screenEvent').textContent=data.finalized?'КОНКУРС ЗАВЕРШЁН · НЕТ ГОЛОСОВ':'ПОДВОДИМ ИТОГИ · ОЖИДАЕМ BALI';
          }
        }
      }

      // Update on photos or event identity changes; do not redraw every poll.
      const incoming=(data.photos||[]).slice(0,MAX_WALL_PHOTOS);
      const nextSignature=event+':'+incoming.map(photo=>[photo.id,photo.width,photo.height,photo.screen_lane].join('/')).join(',');
      if(nextSignature!==signature){
        if(eventId!==event){globalThis.BaliCarouselWall?.reset();globalThis.BaliLiveWall?.reset();}
        eventId=event;
        signature=nextSignature;
        photos=incoming;
        layout();
      }
    }catch(error){
      if(error.code===401){
        wasAuthenticated=false;
        login.hidden=false;
        clearWall();
      } else {
        console.warn('Photo wall sync:',error.message);
        if(++failedPolls>=3){
          clearWall();
          $('#screenEvent').textContent='НЕТ СОЕДИНЕНИЯ С СЕРВЕРОМ';
        }
      }
    }
  }
  $('#screenLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#screenLoginForm button');
    button.disabled=true;
    try{
      await api('/api/screen/login',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:$('#screenPassword').value})
      });
      $('#screenPassword').value='';
      notice('#screenLoginMessage','');
      login.hidden=true;
      await refresh();
    }catch(error){notice('#screenLoginMessage',error.message,true)}
    finally{button.disabled=false}
  });
  function togglePanel(open){
    panel.hidden=!open;
    $('#wallSettingsToggle').setAttribute('aria-expanded',String(open));
  }
  $('#wallSettingsToggle').addEventListener('click',()=>togglePanel(panel.hidden));
  $('#wallSettingsClose').addEventListener('click',()=>togglePanel(false));
  $('#wallDone').addEventListener('click',()=>togglePanel(false));
  $('#liveMosaicNext').addEventListener('click',()=>globalThis.BaliLiveWall?.next());
  $('#wallLogoDefault').addEventListener('click',async()=>{
    if(!controller)return;
    try{
      const response=await api('/api/admin/screen/logo?feed='+broadcastArea,{
        method:'DELETE',headers:{'X-BALI-Action':'1'}});
      logoRevision=-1;useRemoteLogo(response.logoRevision||0);
      $('#wallLogoUpload').value='';
      profileNotice('Вернули фирменный логотип BALI');
    }catch(error){profileNotice(error.message,true)}
  });
  $('#wallLogoUpload').addEventListener('change',async event=>{
    if(!controller)return;
    const file=event.target.files?.[0];if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>1048576){
      profileNotice('Логотип: PNG/JPG/WebP до 1 МБ',true);event.target.value='';return;
    }
    try{
      const data=new FormData();data.append('logo',file);
      const response=await api('/api/admin/screen/logo?feed='+broadcastArea,{
        method:'POST',headers:{'X-BALI-Action':'1'},body:data});
      logoRevision=-1;useRemoteLogo(response.logoRevision||0);
      profileNotice('Логотип сохранён для всех экранов трансляции');
    }catch(error){profileNotice(error.message,true)}
  });
  $('#wallReset').addEventListener('click',()=>{
    if(!controller)return;
    settings={...defaults};applySettings();saveProfileSoon();
  });
  for(const input of controls){
    const change=()=>{
      if(!controller)return;
      const key=input.dataset.wallSetting;
      settings[key]=input.type==='checkbox'?input.checked:
        key==='fit'||key==='layout'||key==='liveFit'||key.endsWith('Pos')?input.value:Number(input.value);
      applySettings();saveProfileSoon();
    };
    input.addEventListener(input.type==='range'?'input':'change',change);
  }
  $('#fullscreenBtn').addEventListener('click',()=>{
    if(document.fullscreenElement)document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(()=>{});
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')togglePanel(false)});
  let resizeFrame=0;
  window.addEventListener('resize',()=>{
    cancelAnimationFrame(resizeFrame);
    resizeFrame=requestAnimationFrame(layout);
  });
  applySettings();
  syncProfile(true).then(refresh);
  setInterval(refresh,4000);
  if(controller){
    panel.hidden=false;
    $('#wallSettingsToggle').setAttribute('aria-expanded','true');
    profileNotice('Пульт экрана · настройки сохраняются для трансляции');
  }else{
    panel.hidden=true;
    $('#wallSettingsToggle').hidden=true;
  }
}
