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
  api('/api/public').then(data=>$('#eventName').textContent=data.event?.name||'Нет активного мероприятия')
    .catch(()=>$('#eventName').textContent='Сервис временно недоступен');
  input.addEventListener('change',()=>$('#fileLabel').textContent=input.files[0]?.name || 'Выбрать фотографию');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const file=input.files[0]; if(!file) return notice('#guestMessage','Выберите фотографию',true);
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)) return notice('#guestMessage','Нужен JPEG, PNG или WebP',true);
    if(file.size>8*1024*1024) return notice('#guestMessage','Фото должно быть меньше 8 МБ',true);
    if(!$('#consent').checked) return notice('#guestMessage','Подтвердите согласие на показ',true);
    btn.disabled=true; btn.textContent='ОТПРАВЛЯЕМ…';
    try {
      const optimized=await optimizePhoto(file);
      const data=new FormData(); data.append('photo',optimized); data.append('consent','yes');
      const resp=await fetch('/api/upload',{method:'POST',body:data,credentials:'same-origin'});
      const result=await resp.json().catch(()=>({}));
      if(!resp.ok) throw new Error(result.error||'Ошибка загрузки');
      notice('#guestMessage','✓ Фото принято! Оно появится на экране после проверки.');
      form.reset(); $('#fileLabel').textContent='Выбрать фотографию';
    } catch(error) {notice('#guestMessage',error.message,true);}
    finally {btn.disabled=false;btn.innerHTML='ОТПРАВИТЬ НА ЭКРАН <span>↗</span>';}
  });
}
if(page==='admin') {
  let busy=false;
  const root=$('#adminRoot');
  async function loadDashboard(){
    if(busy) return;
    busy=true;
    try {
      const data=await api('/api/admin/dashboard');
      if(!$('#dashboard')) {
        root.innerHTML='<section id="dashboard"><div class="admin-heading"><div><div class="eyebrow">CONTROL ROOM</div><h1>МОДЕРАЦИЯ <span class="glow">ФОТО</span></h1></div><div class="admin-links"><a class="button secondary" href="/screen" target="_blank" rel="noopener">LED-ЭКРАН ↗</a><button class="button secondary" id="logoutBtn">ВЫЙТИ</button></div></div><div class="panel event-panel"><div><h2>Мероприятие</h2><p class="muted" id="activeEvent"></p></div><form id="eventForm" class="event-form"><input class="field" id="newEvent" maxlength="90" placeholder="Название новой вечеринки" required><button class="button primary" type="submit">СОЗДАТЬ</button></form><div id="eventList" class="event-list"></div></div><div class="admin-section-head"><h2>Очередь фотографий</h2><span class="muted" id="photoCount"></span></div><div id="photoGrid" class="photo-grid"></div><div class="alert" id="adminMessage" role="status"></div></section>';
      }
      $('#activeEvent').textContent=data.active?.name || 'Не выбрано';
      $('#photoCount').textContent=data.photos.length+' фото';
      $('#eventList').innerHTML=data.events.map(e=>'<button type="button" class="chip '+(e.active?'selected':'')+'" data-activate="'+e.id+'">'+esc(e.name)+(e.active?' ✓':'')+'</button>').join('');
      $('#photoGrid').innerHTML=data.photos.length ? data.photos.map(p=>
        '<article class="photo-card"><img loading="lazy" alt="Фото гостя" src="/api/admin/photos/'+p.id+'"><div class="photo-meta"><span>#'+p.id+'</span><span class="status '+p.status+'">'+({pending:'НА ПРОВЕРКЕ',approved:'ОДОБРЕНО',rejected:'ОТКЛОНЕНО'}[p.status])+'</span></div><div class="photo-actions"><button class="button small approve" data-photo="'+p.id+'" data-status="approved">✓ Одобрить</button><button class="button small reject" data-photo="'+p.id+'" data-status="rejected">× Отклонить</button><button class="button small delete" data-photo="'+p.id+'" data-delete="true">Удалить</button></div></article>'
      ).join('') : '<div class="empty">Пока фотографий нет. Покажите QR-код гостям.</div>';
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
        root.innerHTML='';await loadDashboard();
      } catch(error){notice('#adminMessage',error.message,true);}
    }
    if(event.target.id==='eventForm'){
      event.preventDefault();
      const name=$('#newEvent').value.trim();
      if(!name) return;
      try{await action('/api/admin/events',{name});$('#newEvent').value='';await loadDashboard();}
      catch(error){notice('#adminMessage',error.message,true);}
    }
  });
  root.addEventListener('click',async event=>{
    const el=event.target.closest('button');if(!el)return;
    try{
      if(el.id==='logoutBtn'){await action('/api/admin/logout',{});location.reload();}
      else if(el.dataset.activate){await action('/api/admin/events/'+el.dataset.activate+'/activate',{});await loadDashboard();}
      else if(el.dataset.status){await action('/api/admin/photos/'+el.dataset.photo+'/status',{status:el.dataset.status});await loadDashboard();}
      else if(el.dataset.delete){if(!confirm('Удалить фотографию без возможности восстановления?'))return;
        await action('/api/admin/photos/'+el.dataset.photo,{},'DELETE');await loadDashboard();}
    }catch(error){notice('#adminMessage',error.message,true);}
  });
  setInterval(()=>{if($('#dashboard')&&!document.hidden)loadDashboard();},6000);
}
if(page==='screen'){
  let photos=[],index=0,signature='',shownId=null;
  const center=$('#screenCenter'),background=$('#photoBackground'),login=$('#screenLogin');
  $('#screenLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#screenLoginForm button');
    button.disabled=true;
    try {
      await api('/api/screen/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#screenPassword').value})});
      $('#screenPassword').value='';
      login.hidden=true;
      await refresh();
    } catch(error) {notice('#screenLoginMessage',error.message,true);}
    finally {button.disabled=false;}
  });
  function render(){
    if(!photos.length){
      if(shownId!==null){center.innerHTML='<div class="screen-placeholder"><div class="line">ПОДЕЛИСЬ <span class="glow">МОМЕНТОМ</span></div><p>Твои фотографии на экранах BALI</p></div>';background.style.backgroundImage='none';shownId=null;}
      return;
    }
    const id=photos[index%photos.length]?.id;index++;
    if(!id || id===shownId && photos.length>1)return;
    shownId=id;const url='/api/photos/'+id;
    const img=new Image();img.onload=()=>{center.replaceChildren(img);background.style.backgroundImage='url("'+url+'")';};
    img.alt='Фото гостя BALI';img.className='screen-photo';img.src=url;
  }
  async function refresh(){
    try {
      const d=await api('/api/screen');
      login.hidden=true;
      $('#screenEvent').textContent=d.event?.name||'BALI NIGHT CLUB';
      const sig=d.photos.map(p=>p.id).join(',');
      if(sig!==signature){signature=sig;photos=d.photos;index=0;render();}
    }catch(error){if(error.code===401){login.hidden=false;} else console.warn(error.message);}
  }
  $('#fullscreenBtn').addEventListener('click',()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(()=>{}));
  refresh();setInterval(refresh,5000);setInterval(render,8000);
}
