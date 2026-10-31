// Strict server-side profile format for BOTH independent photo-wall live feeds.
export const SCREEN_AREAS=Object.freeze(['general','contest']);
export const SCREEN_DEFAULTS=Object.freeze({
 maxPhotos:500,columns:0,gap:2,fit:'contain',layout:'puzzle',centerGrowth:true,
 liveInterval:8,liveFocus:40,liveTransition:1400,liveFit:'cover',livePause:false,showcaseInterval:3,
 carouselStart:10,carouselSpeed:85,carouselOuterSpeed:120,carouselTopHeight:12,
 carouselBottomHeight:12,carouselCenterSplit:50,carouselPause:false,
 logoPos:'tl',livePos:'tr',eventPos:'bl',hintPos:'bc',qrPos:'br',
 logoX:0,logoY:0,liveX:0,liveY:0,eventX:0,eventY:0,hintX:0,hintY:0,qrX:0,qrY:0,
 logoSize:28,liveSize:20,eventSize:32,qrSize:92,inset:18,
 showLogo:true,showLive:true,showEvent:true,showQr:true,showHint:true
});
const ranges={
 maxPhotos:[1,500],columns:[0,40],gap:[0,16],
 liveInterval:[3,45],liveFocus:[25,65],liveTransition:[300,2500],showcaseInterval:[2,12],
 carouselStart:[5,30],carouselSpeed:[20,260],carouselOuterSpeed:[20,300],
 carouselTopHeight:[6,25],carouselBottomHeight:[6,25],carouselCenterSplit:[25,75],
 logoX:[-250,250],logoY:[-250,250],liveX:[-250,250],liveY:[-250,250],
 eventX:[-250,250],eventY:[-250,250],hintX:[-250,250],hintY:[-250,250],
 qrX:[-250,250],qrY:[-250,250],logoSize:[24,240],liveSize:[10,55],
 eventSize:[12,85],qrSize:[40,250],inset:[0,80]
};
const layouts=new Set(['puzzle','grid','live-mosaic','carousel-quad','carousel-double',
 'carousel-triple','carousel-festival',
 'showcase-spotlight','showcase-film','showcase-cascade']);
const anchors=new Set(['tl','tc','tr','ml','mc','mr','bl','bc','br']);
export function screenArea(value){return SCREEN_AREAS.includes(value)?value:null;}
export function screenProfile(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid screen profile');
 if(Object.keys(raw).some(k=>!Object.hasOwn(SCREEN_DEFAULTS,k)))throw Error('Unknown screen profile setting');
 const result={};
 for(const [key,defaultValue] of Object.entries(SCREEN_DEFAULTS)){
  const value=Object.hasOwn(raw,key)?raw[key]:defaultValue,range=ranges[key];
  if(range){
   if(typeof value!=='number'||!Number.isSafeInteger(value)||value<range[0]||value>range[1])
    throw Error('Invalid screen setting: '+key);
   result[key]=value;
  }else if(typeof defaultValue==='boolean'){
   if(typeof value!=='boolean')throw Error('Invalid screen setting: '+key);
   result[key]=value;
  }else if(key==='layout'){
   if(!layouts.has(value))throw Error('Invalid screen layout');
   result[key]=value;
  }else if(key==='fit'||key==='liveFit'){
   if(!['cover','contain'].includes(value))throw Error('Invalid image fit');
   result[key]=value;
  }else if(key.endsWith('Pos')){
   if(!anchors.has(value))throw Error('Invalid element position');
   result[key]=value;
  }else throw Error('Unsupported screen setting');
 }
 return result;
}
