/* Browser-only photo crop editor. No images leave the device until submit. */
(function(root){
  'use strict';
  const canvas=document.getElementById('cropCanvas');
  if(!canvas)return;
  const editor=document.getElementById('cropEditor');
  const ctx=canvas.getContext('2d');
  const buttons=[...document.querySelectorAll('[data-ratio]')];
  const zoom=document.getElementById('cropZoom');
  const options={square:1,portrait:3/4,landscape:4/3};
  let picture=null,policy='any',mode='original',factor=1,x=0,y=0,loading=0,drag=null;
  let release=()=>{};
  const touches=new Map();let pinchDistance=0,pinchFactor=1;
  function imageWidth(){return picture?.width||picture?.naturalWidth||0;}
  function imageHeight(){return picture?.height||picture?.naturalHeight||0;}
  function ratio(){return mode==='original'?imageWidth()/Math.max(1,imageHeight()):options[mode]||1;}
  function cropRect(){
    const iw=imageWidth(),ih=imageHeight(),r=ratio();
    const baseW=Math.min(iw,ih*r)/factor,baseH=baseW/r;
    x=Math.max(-(iw-baseW)/2,Math.min((iw-baseW)/2,x));
    y=Math.max(-(ih-baseH)/2,Math.min((ih-baseH)/2,y));
    return {left:(iw-baseW)/2+x,top:(ih-baseH)/2+y,w:baseW,h:baseH};
  }
  function draw(){
    if(!picture)return;
    const r=ratio();
    canvas.width=760;
    canvas.height=Math.max(1,Math.round(760/r));
    canvas.style.aspectRatio=String(r);
    const rect=cropRect();
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.imageSmoothingQuality='high';
    ctx.drawImage(picture,rect.left,rect.top,rect.w,rect.h,0,0,canvas.width,canvas.height);
    zoom.value=String(factor);
    document.getElementById('cropZoomValue').textContent=Math.round(factor*100)+'%';
    document.getElementById('cropPolicyLabel').textContent=policy==='square'?'Только квадрат 1:1':'Передвинь и обрежь фотографию';
    buttons.forEach(button=>{
      button.classList.toggle('selected',button.dataset.ratio===mode);
      button.hidden=policy==='square'&&button.dataset.ratio!=='square';
    });
  }
  function selectMode(next){
    if(policy==='square'&&next!=='square')return;
    if(next!=='original'&&!Object.hasOwn(options,next))return;
    mode=next;x=0;y=0;factor=1;draw();
  }
  buttons.forEach(button=>button.addEventListener('click',()=>selectMode(button.dataset.ratio)));
  zoom.addEventListener('input',()=>{factor=Number(zoom.value);draw();});
  canvas.addEventListener('pointerdown',event=>{
    if(!picture)return;
    event.preventDefault();
    touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(touches.size===1)drag={id:event.pointerId,px:event.clientX,py:event.clientY};
    if(touches.size===2){const [a,b]=[...touches.values()];pinchDistance=Math.hypot(a.x-b.x,a.y-b.y);pinchFactor=factor;drag=null;}
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove',event=>{
    if(!picture||!touches.has(event.pointerId))return;
    event.preventDefault();
    touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(touches.size===2){
      const [a,b]=[...touches.values()];
      if(pinchDistance>0)factor=Math.max(1,Math.min(Number(zoom.max),pinchFactor*Math.hypot(a.x-b.x,a.y-b.y)/pinchDistance));
      draw();return;
    }
    if(!drag||event.pointerId!==drag.id)return;
    const rect=cropRect();
    x-=(event.clientX-drag.px)*rect.w/Math.max(1,canvas.getBoundingClientRect().width);
    y-=(event.clientY-drag.py)*rect.h/Math.max(1,canvas.getBoundingClientRect().height);
    drag.px=event.clientX;drag.py=event.clientY;draw();
  });
  const stop=event=>{touches.delete(event.pointerId);drag=null;pinchDistance=0;
    if(touches.size===1){const [id,point]=[...touches.entries()][0];drag={id,px:point.x,py:point.y};}
  };
  canvas.addEventListener('pointerup',stop);
  canvas.addEventListener('pointercancel',stop);
  canvas.addEventListener('keydown',event=>{
    if(!picture||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();const step=Math.min(imageWidth(),imageHeight())*.025;
    if(event.key==='ArrowLeft')x-=step;
    if(event.key==='ArrowRight')x+=step;
    if(event.key==='ArrowUp')y-=step;
    if(event.key==='ArrowDown')y+=step;
    draw();
  });
  async function load(file){
    const id=++loading;
    release();picture=null;editor.hidden=true;drag=null;touches.clear();
    if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Нужен JPEG, PNG или WebP');
    let img,dispose;
    if(typeof createImageBitmap==='function'){
      img=await createImageBitmap(file);
      dispose=()=>img.close();
    } else {
      const url=URL.createObjectURL(file);
      img=new Image();
      try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Не удалось открыть изображение'));img.src=url;});}
      catch(error){URL.revokeObjectURL(url);throw error;}
      dispose=()=>URL.revokeObjectURL(url);
    }
    if(loading!==id){dispose();return;}
    if(!img.width&&!img.naturalWidth){dispose();throw new Error('Изображение не удалось прочитать');}
    picture=img;release=dispose;
    mode=policy==='square'?'square':'original';factor=1;x=0;y=0;
    editor.hidden=false;draw();
  }
  function setPolicy(next){
    const nextPolicy=next==='square'?'square':'any';
    const changed=policy!==nextPolicy;
    policy=nextPolicy;
    if(picture && (nextPolicy==='square'&&mode!=='square'))selectMode('square');
    else if(picture)draw();
    return changed;
  }
  async function exportFile(){
    if(!picture)throw new Error('Сначала выберите и обрежьте фотографию');
    const rect=cropRect();
    const r=ratio();
    let width=Math.max(1,Math.min(1600,Math.round(imageWidth()),Math.round(imageHeight()*r)));
    let height=Math.max(1,Math.round(width/r));
    if(mode==='square'||policy==='square'){width=Math.min(width,height);height=width;}
    const output=document.createElement('canvas');output.width=width;output.height=height;
    const context=output.getContext('2d');context.imageSmoothingQuality='high';
    context.drawImage(picture,rect.left,rect.top,rect.w,rect.h,0,0,width,height);
    const blob=await new Promise(resolve=>output.toBlob(resolve,'image/webp',.82));
    if(!blob||blob.size>8*1024*1024)throw new Error('Не удалось подготовить фотографию до 8 МБ');
    return new File([blob],'bali-cropped.webp',{type:'image/webp'});
  }
  function reset(){if(!picture)return;factor=1;x=0;y=0;draw();}
  function clear(){
    ++loading;release();release=()=>{};picture=null;editor.hidden=true;drag=null;touches.clear();
  }
  root.BaliCropEditor={load,setPolicy,exportFile,clear,reset};
})(globalThis);
