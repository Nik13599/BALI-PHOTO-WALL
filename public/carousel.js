/* Queue engine for the optional BALI PHOTO WALL LED carousel modes.
   No dependencies, no DOM. Screen authenticated photos only. */
(function(root){
  'use strict';
  const MAX_FEATURED=12;
  const variants=Object.freeze(['carousel-quad','carousel-double','carousel-triple','carousel-festival']);
  function isCarousel(layout){return variants.includes(layout);}
  function assignedLane(photo){
    if(photo.screen_lane==='top'||photo.screen_lane==='bottom')return photo.screen_lane;
    return Number(photo.id)%2===0?'top':'bottom';
  }
  function initialLane(){
    return {featured:[],waiting:[],archive:[]};
  }
  function makeState(items){
    const result={top:initialLane(),bottom:initialLane()};
    for(const photo of items){
      const lane=result[assignedLane(photo)];
      if(lane.featured.length<MAX_FEATURED)lane.featured.push(photo);
      else lane.waiting.push(photo);
    }
    return result;
  }
  function sync(state,items){
    if(!state)return makeState(items);
    const allowed=new Map(items.map(photo=>[Number(photo.id),photo]));
    const next={top:initialLane(),bottom:initialLane()};
    // Preserve progression for existing approved photos and ensure moderator
    // lane changes are applied immediately (without duplicating entries).
    const seen=new Set();
    for(const laneName of ['top','bottom']){
      for(const collection of ['featured','waiting','archive']){
        for(const old of state[laneName][collection]){
          const item=allowed.get(Number(old.id));
          if(!item || seen.has(Number(item.id)))continue;
          if(assignedLane(item)===laneName){
            next[laneName][collection].push(item);seen.add(Number(item.id));
          }
        }
      }
    }
    // Newly approved images enter the large central track first.
    for(const item of items){
      if(seen.has(Number(item.id)))continue;
      const lane=next[assignedLane(item)];
      lane.featured.unshift(item);
      seen.add(Number(item.id));
    }
    for(const name of ['top','bottom']){
      const lane=next[name];
      while(lane.featured.length>MAX_FEATURED)lane.waiting.unshift(lane.featured.pop());
      if(!lane.featured.length && lane.waiting.length)lane.featured.push(lane.waiting.shift());
    }
    return next;
  }
  function advance(state,name){
    const lane=state[name];
    if(!lane)return false;
    // The leading featured photo has finished a full visual pass. It goes to
    // the smaller corresponding outside belt; queued photos take its place.
    if(lane.featured.length>1)lane.archive.push(lane.featured.shift());
    if(lane.waiting.length)lane.featured.push(lane.waiting.shift());
    else {
      const minimum=Math.min(4,Math.max(1,Math.ceil((lane.featured.length+lane.archive.length)*.55)));
      if(lane.featured.length<minimum && lane.archive.length>1)
        lane.featured.push(lane.archive.shift()); // Recirculate after the small belt.
    }
    // For only a single photo in a lane it continues looping in the centre.
    return true;
  }
  function allIds(state){
    return ['top','bottom'].flatMap(name=>['featured','waiting','archive'].flatMap(kind=>state[name][kind].map(p=>p.id)));
  }
  root.BaliCarousel=Object.freeze({variants,isCarousel,assignedLane,makeState,sync,advance,allIds,MAX_FEATURED});
})(globalThis);
