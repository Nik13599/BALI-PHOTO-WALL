// Single source of truth for the Minsk-local contest timeline (UTC+03:00 year-round).
// Existing deployments without a detailed timeline keep their original 01:00-03:00 behaviour.
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
  const match=typeof value==='string'?value.match(LOCAL):null;
  if(!match||!isContestDate(match[1]))return null;
  const milliseconds=Date.parse(value+':00+03:00');
  return Number.isFinite(milliseconds)?milliseconds:null;
}
export function validContestTimeline(input){
  const names=['registration_opens_at','registration_ends_at','voting_starts_at','voting_ends_at','results_at'];
  const points=names.map(name=>minskLocalMillis(input?.[name]));
  if(points.some(n=>n===null))return false;
  const [opens,registrationEnds,votingStarts,votingEnds,results]=points;
  if(!(opens<registrationEnds && registrationEnds<=votingStarts && votingStarts<votingEnds && votingEnds<=results))return false;
  if(!isContestDate(input?.contest_date)||input.voting_starts_at.slice(0,10)!==input.contest_date)return false;
  // Do not allow accidental month-long registrations or delays that leave stale contests running.
  return votingStarts-opens<=30*86400000 && votingEnds-votingStarts<=24*3600000 &&
    results-votingEnds<=24*3600000;
}
export function contestClock(settings,now=Date.now()){
  const date=settings?.contest_date;
  const start=settings?.voting_start||'01:00';
  const end=settings?.voting_end||'03:00';
  const advanced=validContestTimeline(settings);
  if(!isContestDate(date)||(!advanced&&(!TIME.test(start)||!TIME.test(end)||end<=start)))
    return {phase:'disabled',registrationStartsAt:null,registrationEndsAt:null,
      votingStartsAt:null,votingEndsAt:null,resultsAt:null};
  const begins=Date.parse(date+'T'+start+':00+03:00');
  const finishes=Date.parse(date+'T'+end+':00+03:00');
  const regStart=advanced?minskLocalMillis(settings.registration_opens_at):Number.NEGATIVE_INFINITY;
  const regEnd=advanced?minskLocalMillis(settings.registration_ends_at):begins;
  const voteStart=advanced?minskLocalMillis(settings.voting_starts_at):begins;
  const voteEnd=advanced?minskLocalMillis(settings.voting_ends_at):finishes;
  const resultTime=advanced?minskLocalMillis(settings.results_at):finishes;
  let phase='disabled';
  if(settings?.enabled===1){
    phase=now<regStart?'waiting':
      now<regEnd?'registration':
      now<voteStart?'waiting':
      now<voteEnd?'voting':
      now<resultTime?'awaiting_results':'closed';
  }
  return {phase,registrationStartsAt:Number.isFinite(regStart)?regStart:null,
    registrationEndsAt:regEnd,votingStartsAt:voteStart,votingEndsAt:voteEnd,resultsAt:resultTime};
}
export function eligiblePartyDay(partyId,contestDate){
  if(!/^\d{4}-\d{2}-\d{2}(?:__(?:2|3))?$/.test(partyId||'')||!isContestDate(contestDate))return false;
  const previous=new Date(Date.parse(contestDate+'T12:00:00+03:00')-86400000)
    .toLocaleDateString('sv-SE',{timeZone:'Europe/Minsk'});
  return partyId.slice(0,10)===contestDate||partyId.slice(0,10)===previous;
}
