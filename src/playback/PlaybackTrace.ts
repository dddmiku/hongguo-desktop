import {PLAYBACK_TRACE_CAPACITY,sanitizePlaybackTraceInput,type PlaybackDiagnosticEvent,type PlaybackIntentAction,type PlaybackTraceSnapshot} from '../../shared/playback-diagnostics';

export interface PlaybackTraceOptions {now?:()=>number;wallNow?:()=>number;sink?:(snapshot:PlaybackTraceSnapshot)=>void|Promise<void>;}
const failureActions=new Set(['error','failed','fatal','failed-before-ready']);
const intentActions=new Set(['manual-play','manual-pause','seek','retry']);
const defaultClock=()=>typeof performance!=='undefined'?performance.now():Date.now();
let recorderGeneration=0;

/** A fixed-size in-memory causal ledger. It has no timers, file access or retained media objects. */
export class PlaybackTrace {
  private events:PlaybackDiagnosticEvent[]=[];
  private sequence=0;
  private intentGeneration=0;
  private lastSignature='';
  // Two decoder slots plus one unscoped bucket. A global timestamp lets the
  // earlier warm-slot timer starve the currently presented slot forever.
  private sampledAt:Array<number|null>=[null,null,null];
  private elapsed=0;
  private disposed=false;
  private emitting=false;
  private pendingSnapshot:PlaybackTraceSnapshot|undefined;
  private clock:()=>number;
  private wallClock:()=>number;
  private readonly traceGeneration:number;
  private origin:number;
  private sink:PlaybackTraceOptions['sink'];
  constructor(options:PlaybackTraceOptions={}){
    this.clock=options.now??defaultClock;this.sink=options.sink;this.origin=this.readClock();
    this.wallClock=options.wallNow??(()=>Date.now());
    this.traceGeneration=recorderGeneration=Math.min(1e9,recorderGeneration+1);
  }
  private readClock(){try{const now=this.clock();return Number.isFinite(now)?now:0;}catch{return 0;}}
  private occurrenceTime(){try{const now=this.wallClock();return Number.isFinite(now)&&now>=0?Math.min(1e13,now):0;}catch{return 0;}}
  private elapsedTime(){this.elapsed=Math.max(this.elapsed,Math.min(2592000000,Math.max(0,this.readClock()-this.origin)));return this.elapsed;}
  private deliver(snapshot:PlaybackTraceSnapshot){
    if(this.disposed||!this.sink)return;
    if(this.emitting){this.pendingSnapshot=snapshot;return;}
    this.emitting=true;
    const finish=()=>{
      if(this.disposed){this.pendingSnapshot=undefined;this.emitting=false;return;}
      if(this.pendingSnapshot){
        // Keep the gate closed until one microtask drains only the latest pending snapshot.
        queueMicrotask(()=>{
          const next=this.pendingSnapshot;this.pendingSnapshot=undefined;this.emitting=false;
          if(next&&!this.disposed)this.deliver(next);
        });
      }else this.emitting=false;
    };
    try{const result=this.sink(snapshot);if(result)void Promise.resolve(result).then(finish,finish);else finish();}
    catch{finish();/* Diagnostics must never interrupt playback. */}
  }
  record(input:unknown):PlaybackDiagnosticEvent|null {
    if(this.disposed)return null;
    const safe=sanitizePlaybackTraceInput(input);if(!safe)return null;
    // Occurrence/recorder identity belong to this recorder. Boot and document
    // context identity belong to Electron main. None are caller state, and
    // forged values must not defeat deduplication before the trusted stamp.
    delete safe.occurredAtMs;delete safe.traceGeneration;delete safe.bootStartedAtMs;delete safe.contextGeneration;
    // Playback intent identity is recorder-local, not a caller supplied numeric identifier.
    safe.intentGeneration=this.intentGeneration;
    const signature=JSON.stringify(safe);if(signature===this.lastSignature)return null;
    const elapsedMs=this.elapsedTime();
    if(safe.action==='sample'){
      const bucket=safe.deckSlot??2,last=this.sampledAt[bucket];
      if(last!==null&&elapsedMs-last<2000)return null;
      this.sampledAt[bucket]=elapsedMs;
    }
    const event:PlaybackDiagnosticEvent={...safe,v:1,type:'playback_event',sequence:++this.sequence,elapsedMs,occurredAtMs:this.occurrenceTime(),traceGeneration:this.traceGeneration};
    this.lastSignature=signature;this.events.push(event);
    if(this.events.length>PLAYBACK_TRACE_CAPACITY)this.events.shift();
    if(failureActions.has(safe.action)&&this.sink){
      this.deliver(this.snapshot());
    }
    return Object.freeze({...event});
  }
  sample(input:unknown):PlaybackDiagnosticEvent|null {
    if(this.disposed)return null;
    const safe=sanitizePlaybackTraceInput(input);return safe?this.record({...safe,action:'sample'}):null;
  }
  beginIntent(action:PlaybackIntentAction):PlaybackDiagnosticEvent|null {
    if(this.disposed||!intentActions.has(action))return null;
    this.intentGeneration++;this.lastSignature='';
    return this.record({stage:'intent',action});
  }
  snapshot():PlaybackTraceSnapshot {return {v:1,events:this.events.map(event=>({...event}))};}
  dispose(){
    if(this.disposed)return;
    const finalFault=this.pendingSnapshot,sink=this.sink;
    this.disposed=true;this.events=[];this.lastSignature='';this.sampledAt=[null,null,null];
    this.pendingSnapshot=undefined;this.sink=undefined;this.clock=()=>0;this.wallClock=()=>0;
    // The IPC/file sink owns serialization. Do not let component teardown drop
    // the latest queued fault behind a still-pending earlier write. One detached
    // final delivery retains only the already sanitized numeric/enum snapshot.
    if(finalFault&&sink)try{void Promise.resolve(sink(finalFault)).catch(()=>{});}catch{}
  }
}
