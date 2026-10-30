/* BALI PHOTO WALL: lightweight, independent guest upload client.
   The 50KB moderation/LED script is intentionally not loaded by guests. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
const form=$('uploadForm'),input=$('photo'),button=$('uploadBtn');
const eventName=$('eventName'),message=$('guestMessage'),fileLabel=$('fileLabel');
const preview=$('photoPreview'),previewImage=$('photoPreviewImage');
const editButton=$('editPhoto'),editor=$('cropEditor'),limit=$('guestLimitsText');
let policy='any',eventAvailable=false,ready=false,selected=null;
let cropped=false,loadingCrop=null,previewUrl=null,submitting=false;
const allowed=['image/jpeg','image/png','image/webp'];
function status(text,error=false){message.textContent=text;message.className='alert '+(error?'bad':'good');}
function setState(){
 button.disabled=!ready||!eventAvailable||!selected||submitting;
 button.textContent=submitting?'ОТПРАВЛЯЕМ…':'ОТПРАВИТЬ ФОТО ↗';
}
function clearPreview(){
 if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
 previewImage.removeAttribute('src');
 preview.hidden=true;
 cropped=false;editor.hidden=true;
 globalThis.BaliCropEditor?.clear();
}
function showPreview(file){
 clearPreview();
 previewUrl=URL.createObjectURL(file);
 previewImage.src=previewUrl;
 preview.hidden=false;
 editor.hidden=true;
 editButton.hidden=false;
 editButton.textContent='✂ ОБРЕЗАТЬ';
 document.body.classList.add('has-photo');
}
async function getSettings(){
 ready=false;setState();
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),9500);
 try{
  const response=await fetch('/api/public',{cache:'no-store',credentials:'same-origin',signal:controller.signal});
  if(!response.ok)throw Error('HTTP '+response.status);
  const data=await response.json();
  policy=data.uploadShape==='square'?'square':'any';
  eventAvailable=!!data.event?.id;
  eventName.textContent=data.event?.name||'Сейчас нет активного мероприятия';
  limit.textContent=eventAvailable?'Фото появится на фотостене после одобрения.':'Загрузка откроется после запуска мероприятия.';
  ready=true;
  $('reloadStatus').hidden=true;
  if(selected&&policy==='square'&&!cropped)await openCrop();
 }catch(error){
  eventName.textContent='Нет связи с PHOTO WALL';
  limit.textContent='Проверьте соединение и повторите запрос.';
  $('reloadStatus').hidden=false;
  status('Не удалось проверить мероприятие. Повторите подключение.',true);
 }finally{clearTimeout(timer);setState();}
}
function loadCropScript(){
 if(globalThis.BaliCropEditor)return Promise.resolve(globalThis.BaliCropEditor);
 if(loadingCrop)return loadingCrop;
 loadingCrop=new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  script.src='/crop.js?v=20261031-guest-fast-v1';
  script.async=true;
  script.onload=()=>globalThis.BaliCropEditor?resolve(globalThis.BaliCropEditor):reject(Error('Редактор не запустился'));
  script.onerror=()=>reject(Error('Не удалось загрузить редактор обрезки'));
  document.head.append(script);
 }).catch(error=>{loadingCrop=null;throw error;});
 return loadingCrop;
}
async function openCrop(){
 if(!selected)return;
 editButton.disabled=true;
 editButton.textContent='ОТКРЫВАЕМ…';
 try{
  const engine=await loadCropScript();
  engine.setPolicy(policy);
  await engine.load(selected);
  cropped=true;
  preview.hidden=true;
  editor.hidden=false;
  editButton.textContent='✓ КАДР ВЫБРАН';
  status('Готово. При необходимости поправьте кадр и отправьте фото.');
 }catch(error){
  cropped=false;
  if(policy==='square'){
   status('Для квадратного фото редактор обязателен. Попробуйте другую фотографию или обновите страницу.',true);
  }else{
   preview.hidden=false;
   status('Не удалось обрезать фото. Его можно отправить как есть.',true);
  }
  console.warn('BALI crop:',error.message);
 }finally{editButton.disabled=false;setState();}
}
input.addEventListener('change',async()=>{
 const file=input.files?.[0]||null;
 selected=null;
 clearPreview();
 document.body.classList.remove('has-photo');
 if(!file){fileLabel.textContent='ВЫБРАТЬ ФОТОГРАФИЮ';editButton.hidden=true;setState();return;}
 if(!allowed.includes(file.type)){
  input.value='';editButton.hidden=true;
  status('Выберите JPG, PNG или WEBP. Формат HEIC пока не поддерживается.',true);
  setState();return;
 }
 if(file.size>8*1024*1024){
  input.value='';editButton.hidden=true;
  status('Файл больше 8 МБ. Уменьшите фотографию перед отправкой.',true);
  setState();return;
 }
 selected=file;
 fileLabel.textContent=file.name.length>40?file.name.slice(0,36)+'…':file.name;
 showPreview(file);
 status('Фото выбрано. Отправка не требует обязательной обрезки.');
 setState();
 if(policy==='square'&&ready)await openCrop();
});
editButton.addEventListener('click',openCrop);
$('reloadStatus').addEventListener('click',getSettings);
$('consent').addEventListener('change',setState);
form.addEventListener('submit',async event=>{
 event.preventDefault();
 if(submitting)return;
 if(!ready||!eventAvailable)return status('Проверьте подключение к мероприятию.',true);
 if(!selected)return status('Выберите фотографию.',true);
 if(!$('consent').checked)return status('Подтвердите согласие на показ фотографии.',true);
 if(policy==='square'&&!cropped)return status('Сначала обрежьте фото до 1:1.',true);
 submitting=true;setState();
 const file=selected;
 try{
  const body=new FormData();
  body.append('photo',cropped?await globalThis.BaliCropEditor.exportFile():file);
  body.append('consent','yes');
  let response=null,result=null;
  for(let attempt=0;attempt<4;attempt++){
   status('Отправляем фотографию, не закрывайте страницу…');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
   try{
    response=await fetch('/api/upload',{method:'POST',body,credentials:'same-origin',signal:controller.signal});
    result=await response.json().catch(()=>({}));
   }finally{clearTimeout(timer);}
   if(response.status!==503||result.code!=='BUSY'||attempt===3)break;
   status('Сервер занят, повторяем отправку…');
   await new Promise(resolve=>setTimeout(resolve,1200*(attempt+1)));
  }
  if(!response.ok)throw Error(result?.error||'Ошибка при отправке');
  form.reset();selected=null;clearPreview();
  document.body.classList.remove('has-photo');
  fileLabel.textContent='ВЫБРАТЬ ФОТОГРАФИЮ';
  editButton.hidden=true;
  status('✓ ФОТО ОТПРАВЛЕНО! После одобрения оно появится на экране.');
 }catch(error){
  status(error.name==='AbortError'?
   'Время ожидания истекло. Проверьте соединение и очередь модератора перед повторной отправкой.':
   error.message||'Нет связи с сервером. Попробуйте позже.',true);
 }finally{submitting=false;setState();}
});
window.addEventListener('pagehide',()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);});
getSettings();
})();
