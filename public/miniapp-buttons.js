/* Windows PHOTO WALL operator control of Telegram Mini App buttons. */
(() => {
 const root=document.getElementById('miniappButtonsPanel');
 if(!root)return;
 const names=[['wall','ПОКАЖИ СЕБЯ'],['registration','КОРОЛЬ / КОРОЛЕВА'],['vote','ГОЛОСОВАТЬ']];
 const days=['ВС','ПН','ВТ','СР','ЧТ','ПТ','СБ'];
 const initial=()=>names.map(([key,label])=>
  '<fieldset class="miniapp-btn-row" data-mini-button="'+key+'"><legend>'+label+'</legend>'+
  '<label><input type="checkbox" data-property="visible" checked> Показывать в Telegram</label>'+
  '<label>Режим <select class="field" data-property="mode"><option value="auto">По расписанию</option><option value="manual-on">Включить вручную</option><option value="manual-off">Выключить вручную</option></select></label>'+
  '<div class="miniapp-btn-times"><label>С <input class="field" type="time" data-property="start"></label>'+
  '<label>До <input class="field" type="time" data-property="end"></label>'+
  '<label><input type="checkbox" data-property="nextDay"> Закончить на следующий день</label></div>'+
  '<div class="miniapp-btn-weekdays">Дни начала: '+days.map((d,i)=>
   '<label><input type="checkbox" data-day="'+i+'">'+d+'</label>').join('')+'</div>'+
  '<p data-result="'+key+'" class="miniapp-btn-result"></p></fieldset>').join('');
 root.innerHTML='<details id="miniappButtonsDetails" class="miniapp-control-panel">'+
  '<summary>📲 Кнопки Telegram Mini App · расписание и ручное управление</summary>'+
  '<p class="wall-setting-note">Этот компьютер определяет видимость, расписание и включение трёх кнопок. Время Минска. Для голосования дополнительно необходимы включённый конкурс и участники.</p>'+
  '<form id="miniappButtonsForm">'+initial()+
  '<button class="button primary" type="submit">СОХРАНИТЬ И ПЕРЕДАТЬ В TELEGRAM</button>'+
  '<p id="miniappButtonsMessage" role="status" class="wall-setting-note"></p></form></details>';
 const form=root.querySelector('form'),message=root.querySelector('#miniappButtonsMessage');
 let revision=0,dirty=false;
 form.addEventListener('change',()=>{dirty=true;message.textContent='Есть несохранённые изменения.'});
 const field=(row,prop)=>row.querySelector('[data-property="'+prop+'"]');
 function loadValue(key,value){
  const row=root.querySelector('[data-mini-button="'+key+'"]');
  for(const prop of ['visible','mode','start','end','nextDay']){
   const element=field(row,prop);
   if(element.type==='checkbox')element.checked=value[prop];else element.value=value[prop];
  }
  row.querySelectorAll('[data-day]').forEach(x=>x.checked=value.days.includes(Number(x.dataset.day)));
 }
 function collect(){
  const result={};
  for(const [key] of names){
   const row=root.querySelector('[data-mini-button="'+key+'"]');
   result[key]={visible:field(row,'visible').checked,mode:field(row,'mode').value,
    start:field(row,'start').value,end:field(row,'end').value,
    nextDay:field(row,'nextDay').checked,
    days:[...row.querySelectorAll('[data-day]:checked')].map(x=>Number(x.dataset.day))};
  }
  return result;
 }
 async function refresh(){
  try{
   const response=await fetch('/api/admin/miniapp/buttons',{cache:'no-store',credentials:'same-origin'});
   if(response.status===401){message.textContent='Настройки доступны после входа администратора PHOTO WALL.';return;}
   const data=await response.json();
   if(!response.ok)throw Error(data.error||'Не удалось прочитать настройки');
   if(!dirty){revision=data.revision;for(const [key] of names)loadValue(key,data.settings[key]);}
   for(const [key] of names){
    const item=data.current.buttons[key];
    const el=root.querySelector('[data-result="'+key+'"]');
    el.textContent=item.open?'● ОТКРЫТА':item.visible?'○ ЗАКРЫТА':'СКРЫТА';
   }
  }catch(err){message.textContent=err.message}
 }
 form.addEventListener('submit',async e=>{
  e.preventDefault();
  message.textContent='Сохраняем…';
  try{
   const response=await fetch('/api/admin/miniapp/buttons',{method:'POST',cache:'no-store',
    credentials:'same-origin',headers:{'Content-Type':'application/json','X-BALI-Action':'1'},
    body:JSON.stringify({settings:collect(),expectedRevision:revision})});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(result.error||'Настройки не сохранены');
   revision=result.revision;dirty=false;message.textContent='✓ Настройки сохранены. Telegram увидит их при очередном обновлении.';
   await refresh();
  }catch(err){message.textContent='Ошибка: '+err.message}
 });
 if(location.hash==='#miniapp-buttons'){
  root.querySelector('details').open=true;
  document.getElementById('wallSettingsToggle')?.click();
 }
 void refresh();setInterval(()=>{if(!document.hidden)void refresh()},30000);
})();