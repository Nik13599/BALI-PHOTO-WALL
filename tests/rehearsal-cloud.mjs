/* Controlled Cloudflare handoff for the real-server rehearsal integration test.
   No outbound network requests are performed by this subprocess. */
import {readFileSync} from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async (input,options={})=>{
 const url=String(input);
 if(!url.startsWith('https://app.baliminsk.by/'))return original(input,options);
 const state=JSON.parse(readFileSync(process.env.REHEARSAL_POLICY_FILE,'utf8'));
 if(url.includes('/photo-controls'))return Response.json({...state.policy,serverNowMs:Date.now()});
 if(url.includes('/photo-contest-upload-proof')){
  const proof=JSON.parse(Buffer.from(JSON.parse(options.body).ticket,'base64url').toString());
  return Response.json({ok:true,contestant:{...proof,queued:false,queuedAtMs:Date.now()}});
 }
 if(url.includes('/photo-contest-tally-feed'))return Response.json({ok:true,
  contestId:new URL(url).searchParams.get('contestId'),candidates:state.tally,
  total:state.tally.reduce((n,x)=>n+x.votes,0)});
 return Response.json({ok:false},{status:503});
};
