// Single source of truth for the Minsk-local photo contest clock.
// contestDate is the calendar date on which 01:00 and 03:00 occur.
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
export function minskDay(now=Date.now()){
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Minsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}
export function isContestDate(value){
  return typeof value==='string'&&DATE.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00+03:00'))&&
    new Date(Date.parse(value+'T12:00:00+03:00')).toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'})===value;
}
export function contestClock(settings,now=Date.now()){
  const date=settings?.contest_date;
  const start=settings?.voting_start||'01:00';
  const end=settings?.voting_end||'03:00';
  if(!isContestDate(date)||!TIME.test(start)||!TIME.test(end)||end<=start)
    return {phase:'disabled',registrationEndsAt:null,votingEndsAt:null,votingStartsAt:null};
  const begins=Date.parse(date+'T'+start+':00+03:00');
  const finishes=Date.parse(date+'T'+end+':00+03:00');
  const phase=settings?.enabled!==1?'disabled':now<begins?'registration':now<finishes?'voting':'closed';
  return {phase,registrationEndsAt:begins,votingStartsAt:begins,votingEndsAt:finishes};
}
export function eligiblePartyDay(partyId,contestDate){
  if(!/^\d{4}-\d{2}-\d{2}(?:__(?:2|3))?$/.test(partyId||'')||!isContestDate(contestDate))return false;
  const previous=new Date(Date.parse(contestDate+'T12:00:00+03:00')-86400000)
    .toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'});
  return partyId.slice(0,10)===contestDate||partyId.slice(0,10)===previous;
}
