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
  api('/api/public').then(data=>{
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
  input.addEventListener('change',()=>$('#fileLabel').textContent=input.files[0]?.name || 'Выбрать фотографию');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const file=input.files[0]; if(!file) return notice('#guestMessage','Выберите фотографию',true);
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)) return notice('#guestMessage','Нужен JPEG, PNG или WebP',true);
    if(!$('#consent').checked) return notice('#guestMessage','Подтвердите согласие на показ',true);
    btn.disabled=true; btn.textContent='ОТПРАВЛЯЕМ…';
    try {
      const optimized=await optimizePhoto(file);
      if(optimized.size>8*1024*1024) throw new Error('Фото слишком большое даже после сжатия. Выберите другое.');
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
      form.reset(); $('#fileLabel').textContent='Выбрать фотографию';
    } catch(error) {notice('#guestMessage',error.message,true);}
    finally {btn.disabled=false;btn.innerHTML='ОТПРАВИТЬ НА ЭКРАН <span>↗</span>';}
  });
}
if(page==='admin') {
  let busy=false;
  let previousDashboard=null;
  let selectedEventId=null;
  let pageNumber=1;
  const root=$('#adminRoot');
  async function loadDashboard(){
    if(busy) return;
    busy=true;
    try {
      const query=new URLSearchParams({page:String(pageNumber)});
      if(selectedEventId!==null)query.set('eventId',String(selectedEventId));
      const data=await api('/api/admin/dashboard?'+query.toString());
      pageNumber=data.page;
      const signature=JSON.stringify([data.active,data.selected,data.events,data.photos,data.page,data.pages,data.total]);
      if(signature===previousDashboard) return;
      previousDashboard=signature;
      if(!$('#dashboard')) {
        root.innerHTML='<section id="dashboard"><div class="admin-heading"><div><div class="eyebrow">CONTROL ROOM</div><h1>МОДЕРАЦИЯ <span class="glow">ФОТО</span></h1></div><div class="admin-links"><a class="button secondary" href="/screen" target="_blank" rel="noopener">LED-ЭКРАН ↗</a><button class="button secondary" id="logoutBtn">ВЫЙТИ</button></div></div><div class="panel event-panel"><div><h2>Мероприятие</h2><p class="muted" id="activeEvent"></p></div><form id="eventForm" class="event-form"><input class="field" id="newEvent" maxlength="90" placeholder="Название новой вечеринки" required><button class="button primary" type="submit">СОЗДАТЬ</button></form><div id="eventList" class="event-list"></div></div><div class="admin-section-head"><div><h2>Фотографии мероприятия</h2><p class="muted" id="selectedEvent"></p></div><span class="muted" id="photoCount"></span></div><div id="photoGrid" class="photo-grid"></div><div class="page-controls" id="pageControls"></div><div class="alert" id="adminMessage" role="status"></div></section>';
      }
      $('#activeEvent').textContent=data.active?.name || 'Не выбрано';
      $('#photoCount').textContent=data.total+' всего · '+data.page+' / '+data.pages+' стр.';
      $('#selectedEvent').textContent=data.selected?.name||'Нет выбранного мероприятия';
      $('#eventList').innerHTML=data.events.map(e=>
        '<div class="event-choice"><button type="button" class="chip '+(e.id===data.selected?.id?'selected':'')+'" data-view="'+e.id+'">'+esc(e.name)+(e.active?' · ИДЁТ':'')+'</button>'+(e.active?'':'<button type="button" class="chip activate" data-activate="'+e.id+'" title="Вывести фото этого мероприятия на экраны">СДЕЛАТЬ АКТИВНЫМ</button>')+'</div>'
      ).join('');
      $('#photoGrid').innerHTML=data.photos.length ? data.photos.map(p=>
        '<article class="photo-card"><a href="/api/admin/photos/'+p.id+'?full=1" target="_blank" rel="noopener" title="Открыть полное фото"><img loading="lazy" alt="Фото гостя" src="/api/admin/photos/'+p.id+'"></a><div class="photo-meta"><span>#'+p.id+'</span><span class="status '+p.status+'">'+({pending:'НА ПРОВЕРКЕ',approved:'ОДОБРЕНО',rejected:'ОТКЛОНЕНО'}[p.status])+'</span></div><div class="photo-actions"><button class="button small approve" data-photo="'+p.id+'" data-status="approved">✓ Одобрить</button><button class="button small reject" data-photo="'+p.id+'" data-status="rejected">× Отклонить</button><button class="button small delete" data-photo="'+p.id+'" data-delete="true">Удалить</button></div></article>'
      ).join('') : '<div class="empty">В выбранном мероприятии фотографий нет.</div>';
      $('#pageControls').innerHTML = data.pages>1
        ? '<button class="button secondary" type="button" data-page="prev" '+(data.page<=1?'disabled':'')+'>← НАЗАД</button><span>Страница '+data.page+' из '+data.pages+'</span><button class="button secondary" type="button" data-page="next" '+(data.page>=data.pages?'disabled':'')+'>ВПЕРЁД →</button>'
        : '';
    } catch(error){
      if(error.code===401){if($('#dashboard')) {location.reload();return;}}
      notice('#adminMessage',error.message,true);
    } finally {busy=false;}
  }
  api('/api/admin/me').then(loadDashboard).catch(()=>{});
  root.addEventListener('submit',async event=>{
    if(event.target.id==='loginForm'){
      event.preventDefault();
      try {
        await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value})});
        root.innerHTML='<div class="panel"><p class="muted">Загружаем панель модерации…</p><div id="adminMessage" class="alert" role="status"></div></div>';await loadDashboard();
      } catch(error){notice('#adminMessage',error.message,true);}
    }
    if(event.target.id==='eventForm'){
      event.preventDefault();
      const name=$('#newEvent').value.trim();
      if(!name) return;
      try{await action('/api/admin/events',{name});selectedEventId=null;pageNumber=1;$('#newEvent').value='';await loadDashboard();}
      catch(error){notice('#adminMessage',error.message,true);}
    }
  });
  root.addEventListener('click',async event=>{
    const el=event.target.closest('button');if(!el)return;
    try{
      if(el.id==='logoutBtn'){await action('/api/admin/logout',{});location.reload();}
      else if(el.dataset.view){selectedEventId=Number(el.dataset.view);pageNumber=1;await loadDashboard();}
      else if(el.dataset.page){pageNumber=Math.max(1,pageNumber+(el.dataset.page==='next'?1:-1));await loadDashboard();}
      else if(el.dataset.activate){
        if(!confirm('Сделать это мероприятие текущим? Показ на LED-экране переключится.'))return;
        await action('/api/admin/events/'+el.dataset.activate+'/activate',{});
        selectedEventId=null;pageNumber=1;await loadDashboard();
      }
      else if(el.dataset.status){await action('/api/admin/photos/'+el.dataset.photo+'/status',{status:el.dataset.status});await loadDashboard();}
      else if(el.dataset.delete){if(!confirm('Удалить фотографию без возможности восстановления?'))return;
        await action('/api/admin/photos/'+el.dataset.photo,{},'DELETE');await loadDashboard();}
    }catch(error){notice('#adminMessage',error.message,true);}
  });
  setInterval(()=>{if($('#dashboard')&&!document.hidden)loadDashboard();},6000);
}
if(page==='screen'){
  const center=$('#screenCenter'),login=$('#screenLogin'),settingsPanel=$('#wallSettings');
  const storageKey='bali-photo-wall-led-settings-v1';
  const defaults={limit:500,layout:'auto',columns:8,gap:4,fit:'cover',qr:true,qrSize:80,logo:true,logoSize:200};
  const clampInt=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Math.round(Number(value)))):fallback;
  function normalize(source={}){
    return {
      limit:clampInt(source.limit,1,500,defaults.limit),
      layout:source.layout==='manual'?'manual':'auto',
      columns:clampInt(source.columns,1,50,defaults.columns),
      gap:clampInt(source.gap,0,24,defaults.gap),
      fit:source.fit==='contain'?'contain':'cover',
      qr:typeof source.qr==='boolean'?source.qr:defaults.qr,
      qrSize:clampInt(source.qrSize,50,180,defaults.qrSize),
      logo:typeof source.logo==='boolean'?source.logo:defaults.logo,
      logoSize:clampInt(source.logoSize,100,340,defaults.logoSize)
    };
  }
  let saved={};
  try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}')||{};}catch{}
  let preferences=normalize(saved);
  let photos=[],signature=null,failedPolls=0;
  let tiles=new Map();
  const settingInputs={
    limit:$('#wallLimit'),layout:$('#wallLayout'),columns:$('#wallColumns'),
    gap:$('#wallGap'),fit:$('#wallFit'),qr:$('#wallQr'),qrSize:$('#wallQrSize'),
    logo:$('#wallLogo'),logoSize:$('#wallLogoSize')
  };
  function syncControls(){
    for(const [key,input] of Object.entries(settingInputs)){
      if(input.type==='checkbox')input.checked=preferences[key];
      else input.value=String(preferences[key]);
    }
    $('#wallColumnsGroup').hidden=preferences.layout!=='manual';
    $('#wallGapValue').textContent=preferences.gap+' px';
    $('#wallQrSizeValue').textContent=preferences.qrSize+' px';
    $('#wallLogoSizeValue').textContent=preferences.logoSize+' px';
    const root=document.querySelector('.screen');
    root.style.setProperty('--wall-gap',preferences.gap+'px');
    root.style.setProperty('--wall-fit',preferences.fit);
    root.style.setProperty('--qr-size',preferences.qrSize+'px');
    root.style.setProperty('--logo-size',preferences.logoSize+'px');
    $('#screenQr').hidden=!preferences.qr;
    $('#screenLogo').hidden=!preferences.logo;
  }
  function saveSettings(){
    try{localStorage.setItem(storageKey,JSON.stringify(preferences));}catch{}
  }
  function autoColumns(count){
    if(count<=2)return count;
    const width=Math.max(1,center.clientWidth);
    const height=Math.max(1,center.clientHeight);
    let best=1,score=Infinity;
    for(let columns=1;columns<=Math.min(count,50);columns++){
      const rows=Math.ceil(count/columns);
      const aspect=(width/columns)/(height/rows);
      // Favor comfortable image shapes and limit underfilled final rows.
      const penalty=Math.abs(Math.log(Math.max(.01,aspect)/(4/3)))+
        (columns*rows-count)/count*.3;
      if(penalty<score){score=penalty;best=columns;}
    }
    return best;
  }
  function showPlaceholder(){
    center.innerHTML='<div class="screen-placeholder"><div class="line">ПОДЕЛИСЬ <span class="glow">МОМЕНТОМ</span></div><p>Твои фотографии на экранах BALI</p></div>';
    tiles.clear();
    $('#wallCount').textContent='0 фотографий';
  }
  function buildTile(id,useThumbnail){
    const tile=document.createElement('div');
    tile.className='wall-tile';
    const img=document.createElement('img');
    img.alt='Фото гостя BALI';
    img.loading='eager';
    img.decoding='async';
    img.onerror=()=>tile.classList.add('failed');
    tile.append(img);
    tile.dataset.photoId=String(id);
    tile.dataset.thumb=String(useThumbnail);
    img.src='/api/photos/'+encodeURIComponent(id)+(useThumbnail?'?thumb=1':'');
    return tile;
  }
  function renderWall(){
    const visible=photos.slice(0,preferences.limit);
    $('#wallCount').textContent='Показано '+visible.length+' из '+photos.length;
    if(!visible.length){showPlaceholder();return;}
    const count=visible.length;
    const columns=Math.max(1,Math.min(count,preferences.layout==='manual'?preferences.columns:autoColumns(count)));
    const rows=Math.ceil(count/columns);
    const useThumbnail=count>12;
    const updatedTiles=new Map();
    const fragment=document.createDocumentFragment();
    let offset=0;
    // Balance the last row instead of leaving dark, unused cells.
    const even=Math.floor(count/rows),extra=count%rows;
    for(let rowIndex=0;rowIndex<rows;rowIndex++){
      const row=document.createElement('div');
      row.className='wall-row';
      const rowLength=even+(rowIndex<extra?1:0);
      for(let index=0;index<rowLength;index++){
        const id=visible[offset++].id;
        let tile=tiles.get(id);
        if(!tile || tile.dataset.thumb!==String(useThumbnail))tile=buildTile(id,useThumbnail);
        updatedTiles.set(id,tile);
        row.append(tile);
      }
      fragment.append(row);
    }
    center.replaceChildren(fragment);
    tiles=updatedTiles;
  }
  function changePreference(key){
    const input=settingInputs[key];
    const value=input.type==='checkbox'?input.checked:input.value;
    preferences=normalize({...preferences,[key]:value});
    saveSettings();
    syncControls();
    renderWall();
  }
  for(const [key,input] of Object.entries(settingInputs)){
    input.addEventListener(['gap','qrSize','logoSize'].includes(key)?'input':'change',()=>changePreference(key));
  }
  $('#wallReset').addEventListener('click',()=>{
    preferences={...defaults};
    saveSettings();syncControls();renderWall();
  });
  function togglePanel(open){
    settingsPanel.hidden=!open;
    $('#settingsBtn').setAttribute('aria-expanded',String(open));
  }
  $('#settingsBtn').addEventListener('click',()=>togglePanel(settingsPanel.hidden));
  $('#settingsClose').addEventListener('click',()=>togglePanel(false));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')togglePanel(false);});
  $('#fullscreenBtn').addEventListener('click',()=>{
    if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
    else document.documentElement.requestFullscreen().catch(()=>{});
  });
  let resizeQueued=false;
  window.addEventListener('resize',()=>{
    if(resizeQueued)return;
    resizeQueued=true;
    requestAnimationFrame(()=>{resizeQueued=false;renderWall();});
  });
  async function refresh(){
    try{
      const data=await api('/api/screen');
      failedPolls=0;
      login.hidden=true;
      $('#screenEvent').textContent=data.event?.name||'BALI NIGHT CLUB';
      const list=Array.isArray(data.photos)?data.photos:[];
      const nextSignature=list.map(photo=>photo.id).join(',');
      if(nextSignature!==signature){
        signature=nextSignature;photos=list;
        renderWall();
      }
    }catch(error){
      if(error.code===401){
        login.hidden=false;photos=[];signature=null;showPlaceholder();
      }else{
        console.warn('LED sync error:',error.message);
        if(++failedPolls>=3){
          photos=[];signature=null;showPlaceholder();
          $('#screenEvent').textContent='СОЕДИНЕНИЕ С СЕРВЕРОМ ПОТЕРЯНО';
        }
      }
    }
  }
  $('#screenLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#screenLoginForm button');
    button.disabled=true;
    try{
      await api('/api/screen/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#screenPassword').value})});
      $('#screenPassword').value='';
      login.hidden=true;
      await refresh();
    }catch(error){notice('#screenLoginMessage',error.message,true);}
    finally{button.disabled=false;}
  });
  syncControls();
  refresh();
  setInterval(refresh,5000);
}
