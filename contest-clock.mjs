// Fixed recurring competition opening times, based on the Minsk server clock.
// Operators may configure only the end of voting and results time.
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
export function validContestTimeline(input){
 const mandatory=contestMandatoryTimes(input?.contest_date);
 if(!mandatory||input.registration_opens_at!==mandatory.opens||
    input.registration_ends_at!==mandatory.voteStart||
    input.voting_starts_at!==mandatory.voteStart)return false;
 const voteEnds=minskLocalMillis(input.voting_ends_at),results=minskLocalMillis(input.results_at),
  starts=minskLocalMillis(mandatory.voteStart);
 return voteEnds!==null&&results!==null&&starts<voteEnds&&voteEnds<=results&&
   voteEnds-starts<=24*3600000&&results-voteEnds<=24*3600000;
}
export function contestClock(settings,now=Date.now()){
 const date=settings?.contest_date,required=contestMandatoryTimes(date);
 if(!required)return {phase:'disabled',registrationStartsAt:null,registrationEndsAt:null,
   votingStartsAt:null,votingEndsAt:null,resultsAt:null};
 const opens=minskLocalMillis(required.opens),begins=minskLocalMillis(required.voteStart);
 const advanced=validContestTimeline(settings);
 let finishes=advanced?minskLocalMillis(settings.voting_ends_at):null;
 if(finishes===null){
   const configured=TIME.test(settings?.voting_end)?settings.voting_end:'06:00';
   finishes=Date.parse(date+'T'+(configured>'03:00'?configured:'06:00')+':00+03:00');
 }
 const results=advanced?minskLocalMillis(settings.results_at):finishes;
 let phase='disabled';
 if(settings?.enabled===1){
  phase=now<opens?'waiting':now<begins?'registration':now<finishes?'voting':now<results?'awaiting_results':'closed';
 }
 return {phase,registrationStartsAt:opens,registrationEndsAt:begins,votingStartsAt:begins,
   votingEndsAt:finishes,resultsAt:results};
}
export function eligiblePartyDay(partyId,contestDate){
 if(!/^\d{4}-\d{2}-\d{2}(?:__(?:2|3))?$/.test(partyId||'')||!isContestDate(contestDate))return false;
 const previous=new Date(Date.parse(contestDate+'T12:00:00+03:00')-86400000)
  .toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'});
 return partyId.slice(0,10)===contestDate||partyId.slice(0,10)===previous;
}
