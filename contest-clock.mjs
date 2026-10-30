// Competition timetable with fully editable Minsk-local registration/voting/results times.
// Existing fixed-hour installations keep their legacy default until first manual save.
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL=/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
export function minskDay(now=Date.now()){
 return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Minsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}
export function isContestDate(value){
 return typeof value==='string'&&DATE.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00+03:00'))&&
  new Date(Date.parse(value+'T12:00:00+03:00')).toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'})===value;
}
export function minskLocalMillis(value){
 const m=typeof value==='string'?value.match(LOCAL):null;
 if(!m||!isContestDate(m[1]))return null;
 const valueMs=Date.parse(value+':00+03:00');
 return Number.isFinite(valueMs)?valueMs:null;
}
export function contestMandatoryTimes(date){
 if(!isContestDate(date))return null;
 const voteStart=date+'T03:00';
 const previous=new Date(Date.parse(date+'T12:00:00+03:00')-86400000)
  .toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'});
 return {opens:previous+'T22:00',voteStart};
}
// Every boundary can be configured independently in the moderator's control room.
// Dates are always Minsk local time (UTC+03:00, no daylight saving time).
export function validContestTimeline(input){
 if(!isContestDate(input?.contest_date))return false;
 const opens=minskLocalMillis(input.registration_opens_at);
 const closes=minskLocalMillis(input.registration_ends_at);
 const begins=minskLocalMillis(input.voting_starts_at);
 const finishes=minskLocalMillis(input.voting_ends_at);
 const results=minskLocalMillis(input.results_at);
 if([opens,closes,begins,finishes,results].some(v=>v===null))return false;
 // Contest date tracks the actual vote-start date; party ID compatibility
 // relies on the same Minsk-local date, not on a fixed 03:00 start.
 if(input.voting_starts_at.slice(0,10)!==input.contest_date)return false;
 // Registration and voting may have a gap between them, but never overlap.
 return opens<closes&&closes<=begins&&begins<finishes&&finishes<=results;
}
export function contestClock(settings,now=Date.now()){
 const date=settings?.contest_date,required=contestMandatoryTimes(date);
 if(!required)return {phase:'disabled',registrationStartsAt:null,registrationEndsAt:null,
   votingStartsAt:null,votingEndsAt:null,resultsAt:null};
 const advanced=validContestTimeline(settings);
 const opens=minskLocalMillis(advanced?settings.registration_opens_at:required.opens);
 const registrationEnds=minskLocalMillis(advanced?settings.registration_ends_at:required.voteStart);
 const begins=minskLocalMillis(advanced?settings.voting_starts_at:required.voteStart);
 let finishes=advanced?minskLocalMillis(settings.voting_ends_at):null;
 if(finishes===null){
  const configured=TIME.test(settings?.voting_end)?settings.voting_end:'04:00';
  finishes=Date.parse(date+'T'+(configured>'03:00'?configured:'04:00')+':00+03:00');
 }
 const results=advanced?minskLocalMillis(settings.results_at):finishes;
 let phase='disabled';
 if(settings?.enabled===1){
  phase=now<opens?'waiting':
    now<registrationEnds?'registration':
    now<begins?'awaiting_voting':
    now<finishes?'voting':
    now<results?'awaiting_results':'closed';
 }
 return {phase,registrationStartsAt:opens,registrationEndsAt:registrationEnds,
   votingStartsAt:begins,votingEndsAt:finishes,resultsAt:results};
}
export function eligiblePartyDay(partyId,contestDate){
 if(!/^\d{4}-\d{2}-\d{2}(?:__(?:2|3))?$/.test(partyId||'')||!isContestDate(contestDate))return false;
 const previous=new Date(Date.parse(contestDate+'T12:00:00+03:00')-86400000)
  .toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'});
 return partyId.slice(0,10)===contestDate||partyId.slice(0,10)===previous;
}

/* The Windows contest timeline, not a separate weekly 03:00 default, controls
   voting. An explicit operator hide/manual-off remains authoritative. */
export function contestVotingGate(settings,button,now=Date.now()){
 const clock=contestClock(settings,now);
 const visible=button?.visible!==false;
 const mode=button?.mode||'auto';
 const active=settings?.enabled===1&&!settings?.finalized_at;
 // These are all Windows PHOTO WALL settings. Explicit manual-on opens
 // voting for the current unfinalized event, regardless of weekly defaults.
 const buttonOpen=active&&visible&&mode!=='manual-off'&&
  (mode==='manual-on'||clock.phase==='voting');
 return {clock,visible,mode,buttonOpen};
}
