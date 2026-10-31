/* The Telegram operator selects one isolated rehearsal. Production events
   remain intact and are restored as soon as rehearsal is switched off. */
export function testContestSession(policy){
 const session=policy?.current?.session||policy?.session;
 if(policy?.test?.enabled!==true||!/^test_[a-f0-9-]{36}$/.test(session?.testSessionId||'')||
   !/^\d{4}-\d{2}-\d{2}__3$/.test(session?.eventId||''))return null;
 return session;
}
export function chooseContestEvent(choices,policy,settingsFor){
 const test=testContestSession(policy);
 if(test)return choices.find(e=>settingsFor(e.id)?.test_session_id===test.testSessionId)||null;
 const normal=choices.filter(e=>!settingsFor(e.id)?.test_session_id);
 const session=policy?.current?.session||policy?.session;
 const eventId=session?.eventId||session?.date;
 return normal.find(e=>settingsFor(e.id)?.bali_event_id===eventId)||
  normal.find(e=>!settingsFor(e.id)?.finalized_at)||normal[0]||null;
}
