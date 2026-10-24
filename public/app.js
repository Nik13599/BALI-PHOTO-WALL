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
    $('#fileLabel').textContent=input.files[0]?.name || 'Выбрать фотографию';
    try{
      await globalThis.BaliCropEditor.load(input.files[0]);
      notice('#guestMessage','Передвинь и увеличь фотографию, чтобы выбрать область показа.');
    }catch(error){input.value='';notice('#guestMessage',error.message,true);}
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
        globalThis.BaliCropEditor.setPolicy(uploadPolicy);
        throw new Error('Администратор изменил требования к формату. Проверьте обрезку и нажмите «Отправить» ещё раз.');
      }
      const optimized=await globalThis.BaliCropEditor.exportFile();
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
      form.reset();globalThis.BaliCropEditor.clear();$('#fileLabel').textContent='Выбрать фотографию';
    } catch(error) {notice('#guestMessage',error.message,true);}
    finally {btn.disabled=false;btn.innerHTML='ОТПРАВИТЬ НА ЭКРАН <span>↗</span>';}
  });
}
if(page==='admin') {
  let busy=false;
  let previousDashboard=null;
  let selectedEventId=null;
  let displayedEventId=null;
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
        root.innerHTML='<section id="dashboard"><div class="admin-heading"><div><div class="eyebrow">CONTROL ROOM</div><h1>МОДЕРАЦИЯ <span class="glow">ФОТО</span></h1></div><div class="admin-links"><a class="button secondary" href="/screen" target="_blank" rel="noopener">LED-ЭКРАН ↗</a><button class="button secondary" id="logoutBtn">ВЫЙТИ</button></div></div><div class="panel event-panel"><div><h2>Мероприятие</h2><p class="muted" id="activeEvent"></p></div><form id="eventForm" class="event-form"><input class="field" id="newEvent" maxlength="90" placeholder="Название новой вечеринки" required><button class="button primary" type="submit">СОЗДАТЬ</button></form><div id="eventList" class="event-list"></div><div class="event-upload-policy"><label for="eventUploadShape">Формат загрузки фотографий для выбранного мероприятия</label><div class="event-upload-policy-controls"><select id="eventUploadShape" class="field"><option value="any">Любые: квадратные, вертикальные, горизонтальные</option><option value="square">Только квадратные 1:1</option></select><button id="saveUploadShape" type="button" class="button secondary">СОХРАНИТЬ ФОРМАТ</button></div><p class="muted">Гость выберет область фотографии перед отправкой. Для режима 1:1 другие соотношения сторон будут недоступны.</p></div></div><div class="admin-section-head"><div><h2>Фотографии мероприятия</h2><p class="muted" id="selectedEvent"></p></div><span class="muted" id="photoCount"></span></div><div id="photoGrid" class="photo-grid"></div><div class="page-controls" id="pageControls"></div><div class="alert" id="adminMessage" role="status"></div></section>';
      }
      $('#activeEvent').textContent=data.active?.name || 'Не выбрано';
      $('#photoCount').textContent=data.total+' всего · '+data.page+' / '+data.pages+' стр.';
      $('#selectedEvent').textContent=data.selected?.name||'Нет выбранного мероприятия';
      displayedEventId=data.selected?.id||null;
      $('#eventUploadShape').value=data.selected?.upload_shape==='square'?'square':'any';
      $('#saveUploadShape').disabled=!displayedEventId;
      $('#eventList').innerHTML=data.events.map(e=>
        '<div class="event-choice"><button type="button" class="chip '+(e.id===data.selected?.id?'selected':'')+'" data-view="'+e.id+'">'+esc(e.name)+(e.active?' · ИДЁТ':'')+'</button>'+(e.active?'':'<button type="button" class="chip activate" data-activate="'+e.id+'" title="Вывести фото этого мероприятия на экраны">СДЕЛАТЬ АКТИВНЫМ</button>')+'</div>'
      ).join('');
      $('#photoGrid').innerHTML=data.photos.length ? data.photos.map(p=>
        '<article class="photo-card"><a href="/api/admin/photos/'+p.id+'?full=1" target="_blank" rel="noopener" title="Открыть полное фото"><img loading="lazy" alt="Фото гостя" src="/api/admin/photos/'+p.id+'"></a><div class="photo-meta"><span>#'+p.id+'</span><span class="status '+p.status+'">'+({pending:'НА ПРОВЕРКЕ',approved:'ОДОБРЕНО',rejected:'ОТКЛОНЕНО'}[p.status])+'</span></div><label class="photo-lane-label">Карусель <select class="photo-lane-select" data-lane-photo="'+p.id+'" aria-label="Направление фотографии #'+p.id+'"><option value="auto" '+((p.screen_lane||'auto')==='auto'?'selected':'')+'>Автоматически</option><option value="top" '+(p.screen_lane==='top'?'selected':'')+'>↑ Верхняя</option><option value="bottom" '+(p.screen_lane==='bottom'?'selected':'')+'>↓ Нижняя</option></select></label><div class="photo-actions"><button class="button small approve" data-photo="'+p.id+'" data-status="approved">✓ Одобрить</button><button class="button small reject" data-photo="'+p.id+'" data-status="rejected">× Отклонить</button><button class="button small delete" data-photo="'+p.id+'" data-delete="true">Удалить</button></div></article>'
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
  root.addEventListener('change',async event=>{
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
      if(el.id==='logoutBtn'){await action('/api/admin/logout',{});location.reload();}
      else if(el.id==='saveUploadShape'){
        if(!displayedEventId)return;
        await action('/api/admin/events/'+displayedEventId+'/upload-shape',{uploadShape:$('#eventUploadShape').value});
        previousDashboard=null;await loadDashboard();
        notice('#adminMessage','✓ Формат загрузки сохранён.');
      }
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
  const MAX_WALL_PHOTOS=500;
  const STORE_KEY='bali-photo-wall-screen-settings-v1';
  const LOGO_KEY='bali-photo-wall-screen-logo-v1';
  const defaults={
    maxPhotos:500,columns:0,gap:2,fit:'contain',layout:'puzzle',centerGrowth:true,
    logoPos:'tl',livePos:'tr',eventPos:'bl',hintPos:'bc',qrPos:'br',
    logoX:0,logoY:0,liveX:0,liveY:0,eventX:0,eventY:0,hintX:0,hintY:0,qrX:0,qrY:0,
    logoSize:28,liveSize:20,eventSize:32,qrSize:92,inset:18,
    showLogo:true,showLive:true,showEvent:true,showQr:true,showHint:true
  };
  const limits={
    maxPhotos:[1,500],columns:[0,40],gap:[0,16],
    logoX:[-250,250],logoY:[-250,250],liveX:[-250,250],liveY:[-250,250],
    eventX:[-250,250],eventY:[-250,250],hintX:[-250,250],hintY:[-250,250],
    qrX:[-250,250],qrY:[-250,250],
    logoSize:[24,240],liveSize:[10,55],eventSize:[12,85],
    qrSize:[40,250],inset:[0,80]
  };
  let settings={...defaults};
  try {
    const saved=JSON.parse(localStorage.getItem(STORE_KEY)||'null');
    if(saved && typeof saved==='object'){
      for(const key of Object.keys(defaults)){
        if(key in limits && Number.isFinite(Number(saved[key])))
          settings[key]=Math.round(Math.min(limits[key][1],Math.max(limits[key][0],Number(saved[key]))));
        else if(key==='fit' && ['cover','contain'].includes(saved[key]))settings.fit=saved.fit;
        else if(key==='layout' && ['puzzle','grid'].includes(saved[key]))settings.layout=saved.layout;
        else if(key.endsWith('Pos') && ['tl','tc','tr','ml','mc','mr','bl','bc','br'].includes(saved[key]))settings[key]=saved[key];
        else if(typeof defaults[key]==='boolean' && typeof saved[key]==='boolean')
          settings[key]=saved[key];
      }
    }
  } catch { /* Damaged or disabled browser storage: use defaults */ }
  const screen=$('#wallScreen'),grid=$('#wallGrid'),empty=$('#wallEmpty'),login=$('#screenLogin'),panel=$('#wallSettings');
  const controls=[...document.querySelectorAll('[data-wall-setting]')];
  let photos=[],eventId=null,signature='',failedPolls=0,wasAuthenticated=false;
  const setShown=(element,visible)=>{ if(element)element.hidden=!visible; };
  const floatingElements={logo:$('#wallLogo'),live:$('#wallLive'),event:$('#screenEvent'),hint:$('#eventHint'),qr:$('#wallQR')};
  const anchors={tl:[0,0],tc:[.5,0],tr:[1,0],ml:[0,.5],mc:[.5,.5],mr:[1,.5],bl:[0,1],bc:[.5,1],br:[1,1]};
  function positionFloating(){
    for(const [key,element] of Object.entries(floatingElements)){
      const pos=anchors[settings[key+'Pos']]||anchors.tl;
      const dx=settings[key+'X']||0,dy=settings[key+'Y']||0;
      const inset=settings.inset;
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
      try{localStorage.setItem(STORE_KEY,JSON.stringify(settings));}catch{}
      syncShiftControls();positionFloating();
    });
  }
  function applySettings(){
    screen.style.setProperty('--wall-gap',settings.gap+'px');
    screen.style.setProperty('--wall-fit',settings.fit);
    screen.style.setProperty('--wall-logo-size',settings.logoSize+'px');
    screen.style.setProperty('--wall-live-size',settings.liveSize+'px');
    screen.style.setProperty('--wall-event-size',settings.eventSize+'px');
    screen.style.setProperty('--wall-qr-size',settings.qrSize+'px');
    screen.style.setProperty('--wall-inset',settings.inset+'px');
    setShown($('#wallLogo'),settings.showLogo);
    setShown($('#wallLive'),settings.showLive);
    setShown($('#screenEvent'),settings.showEvent);
    setShown($('#eventHint'),settings.showHint);
    setShown($('#wallQR'),settings.showQr);
    positionFloating();syncShiftControls();
    $('#columnsSettings').hidden=settings.layout!=='grid';
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
    return n<=6 ? '/api/photos/'+id : '/api/screen/thumbnail/'+id;
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
    if(!n){grid.replaceChildren();return;}
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
    if(settings.layout==='puzzle' && globalThis.BaliMosaic){
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
    stage.style.setProperty('--wall-fit',settings.layout==='puzzle'?'contain':settings.fit);
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
    photos=[];signature='';eventId=null;
    layout();
  }
  async function refresh(){
    try{
      const data=await api('/api/screen');
      failedPolls=0;
      wasAuthenticated=true;
      login.hidden=true;
      const event=data.event?.id??null;
      const eventName=data.event?.name||'BALI NIGHT CLUB';
      $('#screenEvent').textContent=eventName;
      // Update on photos or event identity changes; do not redraw every poll.
      const incoming=(data.photos||[]).slice(0,MAX_WALL_PHOTOS);
      const nextSignature=event+':'+incoming.map(photo=>[photo.id,photo.width,photo.height].join('/')).join(',');
      if(nextSignature!==signature){
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
  function restoreScreenLogo(){
    const logo=$('#wallLogo');
    let stored='';
    try{stored=localStorage.getItem(LOGO_KEY)||''}catch{}
    logo.src=/^data:image\/(png|jpeg|webp);base64,/.test(stored)?stored:'/bali-logo.svg';
  }
  function resetScreenLogo(){
    try{localStorage.removeItem(LOGO_KEY)}catch{}
    $('#wallLogoUpload').value='';
    $('#wallLogoMessage').textContent='';
    restoreScreenLogo();
  }
  $('#wallLogoDefault').addEventListener('click',resetScreenLogo);
  $('#wallLogoUpload').addEventListener('change',event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>1024*1024){
      $('#wallLogoMessage').textContent='PNG/JPG/WebP, максимум 1 МБ';
      event.target.value='';
      return;
    }
    const reader=new FileReader();
    reader.onload=()=>{
      const data=typeof reader.result==='string'?reader.result:'';
      if(!/^data:image\/(png|jpeg|webp);base64,/.test(data)){
        $('#wallLogoMessage').textContent='Не удалось прочитать логотип';return;
      }
      try{
        localStorage.setItem(LOGO_KEY,data);
        restoreScreenLogo();
        $('#wallLogoMessage').textContent='Логотип сохранён';
      }catch{
        $('#wallLogoMessage').textContent='Не удалось сохранить: недостаточно памяти браузера';
      }
    };
    reader.onerror=()=>{$('#wallLogoMessage').textContent='Ошибка чтения изображения'};
    reader.readAsDataURL(file);
  });
  $('#wallReset').addEventListener('click',()=>{
    settings={...defaults};
    try{localStorage.removeItem(STORE_KEY)}catch{}
    resetScreenLogo();
    applySettings();
  });
  for(const input of controls){
    const change=()=>{
      const key=input.dataset.wallSetting;
      settings[key]=input.type==='checkbox'?input.checked:
        key==='fit'||key==='layout'?input.value:Number(input.value);
      try{localStorage.setItem(STORE_KEY,JSON.stringify(settings))}catch{}
      applySettings();
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
  restoreScreenLogo();
  applySettings();
  refresh();
  setInterval(refresh,5000);
}
