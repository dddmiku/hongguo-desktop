/** Closed schema: no arbitrary strings, messages, URLs, headers, account or session identifiers. */
export const PLAYBACK_TRACE_CAPACITY=200;
export const playbackTraceStages=['player','deck','lease','decoder','hls','transport','switcher','recovery','visibility','intent','preload','session','checkpoint','lifecycle','source','pipeline'] as const;
export const playbackTraceActions=['inspect','read','open','create','request','response','attach','prepare','prepared','prewarm','prewarm-ready','play','pause','manual-play','manual-pause','resume','suspend','seek','seeking','seeked','waiting','playing','ended','progress','sample','buffered','seal','unseal','replace','renew','reconnect','retry','recover','recovered','commit','settle','release','cancel','active','inactive','start','stop','error','failed','fatal','dispose','abort','success','failed-before-ready','ready','background','foreground','begin','complete'] as const;
export const playbackTraceReasons=['timeout','network-failed','transport-failed','session-expired','session-replaced','resource-not-found','http-error','decode-error','frag-load','manifest-load','source-failed','pipeline-failed','buffer-empty','no-progress','recovery-budget','aborted','cancelled','released','prewarm','auto-switch','manual-pause','manual-play','seek','window-hidden','window-restored','document-hidden','document-visible','paused','ended','healthy','unknown','initial','terminal','recovery','new-intent','none','disposed','expired'] as const;
export type PlaybackTraceStage=typeof playbackTraceStages[number];
export type PlaybackTraceAction=typeof playbackTraceActions[number];
export type PlaybackTraceReason=typeof playbackTraceReasons[number];
export type PlaybackIntentAction='manual-play'|'manual-pause'|'seek'|'retry';

export interface PlaybackTraceInput {
  stage:PlaybackTraceStage;action:PlaybackTraceAction;reason?:PlaybackTraceReason;
  observer?:'renderer'|'main';receivedAtMs?:number;
  occurredAtMs?:number;bootStartedAtMs?:number;traceGeneration?:number;contextGeneration?:number;
  deckSlot?:number;episode?:number;jobGeneration?:number;leaseGeneration?:number;intentGeneration?:number;
  httpStatus?:number;attempt?:number;currentTime?:number;duration?:number;bufferedAhead?:number;
  sourceDuration?:number;bufferedEnd?:number;decodedTime?:number;decodedFrameAgeMs?:number;volume?:number;muted?:boolean;transportPending?:boolean;reconnecting?:boolean;
  readyState?:number;networkState?:number;mediaErrorCode?:number;playbackRate?:number;
  active?:boolean;paused?:boolean;ended?:boolean;seeking?:boolean;sealed?:boolean;prewarm?:boolean;
}
export interface PlaybackDiagnosticEvent extends PlaybackTraceInput {
  v:1;type:'playback_event';sequence:number;elapsedMs:number;
}
export interface PlaybackTraceSnapshot {v:1;events:PlaybackDiagnosticEvent[];}
export type PlaybackTraceEvent=PlaybackDiagnosticEvent;

const stages=new Set<string>(playbackTraceStages),actions=new Set<string>(playbackTraceActions),reasons=new Set<string>(playbackTraceReasons);
const numericFields={
  receivedAtMs:[0,1e13,false],
  occurredAtMs:[0,1e13,false],bootStartedAtMs:[0,1e13,false],traceGeneration:[0,1e9,true],contextGeneration:[0,1e9,true],
  deckSlot:[0,1,true],episode:[0,100000,true],jobGeneration:[0,1e9,true],leaseGeneration:[0,1e9,true],intentGeneration:[0,1e9,true],
  httpStatus:[100,599,true],attempt:[0,100,true],currentTime:[0,86400,false],duration:[0,86400,false],bufferedAhead:[0,86400,false],
  sourceDuration:[0,86400,false],bufferedEnd:[0,86400,false],decodedTime:[0,86400,false],decodedFrameAgeMs:[0,2592000000,false],volume:[0,1,false],
  readyState:[0,4,true],networkState:[0,3,true],mediaErrorCode:[0,4,true],playbackRate:[.0625,16,false],
} as const;
const booleanFields=['active','paused','ended','seeking','sealed','prewarm','muted','transportPending','reconnecting'] as const;
const record=(input:unknown):object|null=>typeof input==='object'&&input!==null&&!Array.isArray(input)?input:null;
// Own data properties only: never invoke getters or spread an untrusted payload.
function own(input:object,key:string):unknown {
  try {const descriptor=Object.getOwnPropertyDescriptor(input,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;}catch{return undefined;}
}
const safeEnum=(value:unknown,allowed:Set<string>)=>typeof value==='string'&&value.length<=64&&allowed.has(value)?value:null;
function numeric(value:unknown,min:number,max:number,integer:boolean){
  return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!integer||Number.isInteger(value))?value:null;
}
export function sanitizePlaybackTraceInput(input:unknown):PlaybackTraceInput|null {
  const object=record(input);if(!object)return null;
  const stage=safeEnum(own(object,'stage'),stages),action=safeEnum(own(object,'action'),actions);
  if(!stage||!action)return null;
  const output:PlaybackTraceInput={stage:stage as PlaybackTraceStage,action:action as PlaybackTraceAction};
  const observer=own(object,'observer');if(observer==='renderer'||observer==='main')output.observer=observer;
  const reason=safeEnum(own(object,'reason'),reasons);if(reason)output.reason=reason as PlaybackTraceReason;
  for(const key of Object.keys(numericFields) as Array<keyof typeof numericFields>){
    const [min,max,integer]=numericFields[key],value=numeric(own(object,key),min,max,integer);
    if(value!==null)output[key]=value;
  }
  for(const key of booleanFields){const value=own(object,key);if(typeof value==='boolean')output[key]=value;}
  return output;
}
export function sanitizePlaybackDiagnosticEvent(input:unknown):PlaybackDiagnosticEvent|null {
  const object=record(input);if(!object||own(object,'v')!==1||own(object,'type')!=='playback_event')return null;
  const sequence=numeric(own(object,'sequence'),1,1e9,true),elapsedMs=numeric(own(object,'elapsedMs'),0,2592000000,false);
  if(sequence===null||elapsedMs===null)return null;
  const safe=sanitizePlaybackTraceInput(object);return safe?{v:1,type:'playback_event',sequence,elapsedMs,...safe}:null;
}
export const sanitizePlaybackTraceEvent=sanitizePlaybackDiagnosticEvent;
export function sanitizePlaybackTraceSnapshot(input:unknown):PlaybackTraceSnapshot|null {
  const object=record(input);if(!object||own(object,'v')!==1)return null;
  const incoming=own(object,'events');if(!Array.isArray(incoming))return null;
  const length=own(incoming,'length');if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0)return null;
  const events:PlaybackDiagnosticEvent[]=[];
  for(let index=Math.max(0,length-PLAYBACK_TRACE_CAPACITY);index<length;index++){
    const event=sanitizePlaybackDiagnosticEvent(own(incoming,String(index)));if(event)events.push(event);
  }
  return {v:1,events};
}
