import {describe,expect,it,vi} from 'vitest';
import {PlaybackTrace} from './PlaybackTrace';
import {sanitizePlaybackDiagnosticEvent,sanitizePlaybackTraceInput,sanitizePlaybackTraceSnapshot} from '../../shared/playback-diagnostics';

const event=(sequence=1)=>({v:1,type:'playback_event',sequence,elapsedMs:sequence,stage:'recovery',action:'recover',reason:'timeout',deckSlot:0,episode:126,leaseGeneration:1,httpStatus:404,currentTime:59,duration:59.2,bufferedAhead:0,paused:false,ended:false,sealed:false});

describe('playback trace privacy boundary',()=>{
  it('keeps optional numeric occurrence and scope fields while retaining legacy v1 compatibility',()=>{
    const scoped={...event(),occurredAtMs:1800000000000,bootStartedAtMs:1799999990000,traceGeneration:2,contextGeneration:3};
    expect(sanitizePlaybackDiagnosticEvent(scoped)).toEqual(scoped);
    expect(sanitizePlaybackDiagnosticEvent(event())).toEqual(event());
  });
  it('rejects unsafe optional scope values without adding strings or invoking clock accessors',()=>{
    const scoped={...event(),occurredAtMs:Infinity,bootStartedAtMs:-1,traceGeneration:1.5,contextGeneration:1e10};
    expect(sanitizePlaybackDiagnosticEvent(scoped)).toEqual(event());
    let accessed=false;Object.defineProperty(scoped,'occurredAtMs',{get(){accessed=true;return 1;}});
    expect(sanitizePlaybackDiagnosticEvent(scoped)).toEqual(event());expect(accessed).toBe(false);
  });
  it('keeps only schema-approved fields and never reads unknown getters',()=>{
    let accessed=false;
    const input={stage:'recovery',action:'recover',reason:'timeout',episode:126,message:'sensitive-test-token',headers:{Authorization:'sensitive-test-token'},url:'https://example.invalid/video?token=sensitive-test-token',uid:'12345678901234567',sessionId:'raw-session-secret'};
    Object.defineProperty(input,'token',{get(){accessed=true;throw new Error('must not execute');}});
    expect(sanitizePlaybackTraceInput(input)).toEqual({stage:'recovery',action:'recover',reason:'timeout',episode:126});
    expect(accessed).toBe(false);
  });
  it('rejects unsafe required strings and drops unsafe optional reason/code/message',()=>{
    expect(sanitizePlaybackTraceInput({stage:'https://example.invalid/?token=secret',action:'error'})).toBeNull();
    expect(sanitizePlaybackTraceInput({stage:'lease',action:'x'.repeat(1000000)})).toBeNull();
    expect(sanitizePlaybackTraceInput({stage:'lease',action:'error',reason:'https://example.invalid/?token=secret',code:'SECRET',message:'x'.repeat(1000000)})).toEqual({stage:'lease',action:'error'});
  });
  it('does not accept inherited values or invoke known field accessors',()=>{
    expect(sanitizePlaybackTraceInput(Object.create({stage:'lease',action:'error'}))).toBeNull();
    const input={action:'error'};let accessed=false;
    Object.defineProperty(input,'stage',{get(){accessed=true;return 'lease';}});
    expect(sanitizePlaybackTraceInput(input)).toBeNull();expect(accessed).toBe(false);
  });
  it('bounds numbers and rejects values that could be identifiers or invalid media state',()=>{
    expect(sanitizePlaybackTraceInput({stage:'decoder',action:'sample',episode:1e15,jobGeneration:Infinity,leaseGeneration:-1,httpStatus:999,currentTime:NaN,duration:1e15,readyState:5,paused:'false',ended:false})).toEqual({stage:'decoder',action:'sample',ended:false});
    expect(sanitizePlaybackTraceInput({stage:'decoder',action:'sample',deckSlot:1,episode:126,jobGeneration:2,leaseGeneration:3,currentTime:59,bufferedAhead:0,readyState:4,networkState:2,mediaErrorCode:0,playbackRate:3,httpStatus:404,attempt:2,paused:false})).toEqual({stage:'decoder',action:'sample',deckSlot:1,episode:126,jobGeneration:2,leaseGeneration:3,currentTime:59,bufferedAhead:0,readyState:4,networkState:2,mediaErrorCode:0,playbackRate:3,httpStatus:404,attempt:2,paused:false});
  });
  it('requires fixed event metadata and revalidates persisted records',()=>{
    expect(sanitizePlaybackDiagnosticEvent({...event(),token:'secret'})).toEqual(event());
    for(const patch of [{v:2},{type:'arbitrary-message'},{sequence:0},{elapsedMs:Infinity}])expect(sanitizePlaybackDiagnosticEvent({...event(),...patch})).toBeNull();
  });
  it('only processes the most recent 200 safe events in an untrusted snapshot',()=>{
    const parsed=sanitizePlaybackTraceSnapshot({v:1,events:Array.from({length:300},(_,i)=>({...event(i+1),token:'secret'})),url:'secret'});
    expect(parsed?.events).toHaveLength(200);expect(parsed?.events[0].sequence).toBe(101);
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(sanitizePlaybackTraceSnapshot({v:2,events:[event()]})).toBeNull();
  });
});

describe('bounded playback transition recorder',()=>{
  it('generates occurrence time and recorder identity locally, dropping all caller-supplied scope fields',()=>{
    let wall=1800000000000;const trace=new PlaybackTrace({now:()=>0,wallNow:()=>wall});
    const first=trace.record({stage:'deck',action:'play',occurredAtMs:1,traceGeneration:999999,bootStartedAtMs:1,contextGeneration:999999,intentGeneration:999999});
    expect(first?.occurredAtMs).toBe(wall);expect(first?.traceGeneration).toBeGreaterThan(0);expect(first?.traceGeneration).not.toBe(999999);
    expect(first).not.toHaveProperty('bootStartedAtMs');expect(first).not.toHaveProperty('contextGeneration');expect(first?.intentGeneration).toBe(0);
    wall+=250;const second=trace.record({stage:'deck',action:'pause',occurredAtMs:2,traceGeneration:888888});
    expect(second?.occurredAtMs).toBe(wall);expect(second?.traceGeneration).toBe(first?.traceGeneration);
  });
  it('does not let forged occurrence or host scope fields defeat transition deduplication',()=>{
    let wall=100;const wallNow=vi.fn(()=>wall),trace=new PlaybackTrace({now:()=>0,wallNow});
    trace.record({stage:'deck',action:'play',occurredAtMs:1,traceGeneration:2,bootStartedAtMs:3,contextGeneration:4});wall=200;
    expect(trace.record({stage:'deck',action:'play',occurredAtMs:1000,traceGeneration:2000,bootStartedAtMs:3000,contextGeneration:4000})).toBeNull();
    expect(trace.snapshot().events).toHaveLength(1);expect(wallNow).toHaveBeenCalledTimes(1);
  });
  it('gives separate recorders distinct local identities even when sequence and elapsed time match',()=>{
    const first=new PlaybackTrace({now:()=>0,wallNow:()=>100}),second=new PlaybackTrace({now:()=>0,wallNow:()=>100});
    const a=first.record({stage:'deck',action:'play'}),b=second.record({stage:'deck',action:'play'});
    expect(a?.sequence).toBe(b?.sequence);expect(a?.elapsedMs).toBe(b?.elapsedMs);
    expect(b?.traceGeneration).toBeGreaterThan(a?.traceGeneration??0);
  });
  it('preserves occurrence time across delayed asynchronous failure delivery',async()=>{
    let release!:()=>void,wall=100;const pending=new Promise<void>(resolve=>{release=resolve;});
    const sink=vi.fn().mockReturnValueOnce(pending).mockReturnValue(undefined),trace=new PlaybackTrace({now:()=>0,wallNow:()=>wall,sink});
    trace.record({stage:'lease',action:'error',jobGeneration:1});wall=200;trace.record({stage:'lease',action:'error',jobGeneration:2});
    wall=1000;release();await Promise.resolve();await Promise.resolve();
    expect(sink.mock.calls[1][0].events.map((value:{occurredAtMs:number})=>value.occurredAtMs)).toEqual([100,200]);
  });
  it('uses Date.now by default and contains invalid or throwing wall-clock providers',()=>{
    const date=vi.spyOn(Date,'now').mockReturnValue(1800000000000);
    try{expect(new PlaybackTrace({now:()=>0}).record({stage:'deck',action:'play'})?.occurredAtMs).toBe(1800000000000);}finally{date.mockRestore();}
    for(const wallNow of [()=>NaN,()=>-1,()=>Infinity,()=>{throw new Error('clock unavailable');}]){
      const captured=new PlaybackTrace({now:()=>0,wallNow}).record({stage:'deck',action:'play'});
      expect(captured?.occurredAtMs).toBe(0);expect(sanitizePlaybackDiagnosticEvent(captured)).not.toBeNull();
    }
  });
  it('records causal transitions and keeps at most 200 entries',()=>{
    let now=0;const trace=new PlaybackTrace({now:()=>now});
    for(let i=0;i<250;i++){now=i;trace.record({stage:'deck',action:i%2?'play':'pause',episode:126,jobGeneration:i});}
    const data=trace.snapshot();expect(data.events).toHaveLength(200);expect(data.events[0].sequence).toBe(51);expect(data.events.at(-1)?.sequence).toBe(250);
  });
  it('deduplicates identical sanitized state, ignoring secret or unknown fields',()=>{
    let now=0;const trace=new PlaybackTrace({now:()=>now});
    expect(trace.record({stage:'recovery',action:'recover',reason:'timeout',attempt:1})).not.toBeNull();
    now=5000;expect(trace.record({stage:'recovery',action:'recover',reason:'timeout',attempt:1,token:'do-not-log'})).toBeNull();
    expect(trace.record({stage:'recovery',action:'recover',reason:'timeout',attempt:2})).not.toBeNull();
    expect(trace.snapshot().events).toHaveLength(2);
  });
  it('samples no more often than 2000ms, including record(sample) calls',()=>{
    let now=0;const trace=new PlaybackTrace({now:()=>now});
    expect(trace.sample({stage:'decoder',action:'sample',currentTime:1})).not.toBeNull();
    now=1999;expect(trace.record({stage:'decoder',action:'sample',currentTime:2})).toBeNull();
    now=2000;expect(trace.sample({stage:'decoder',action:'sample',currentTime:3})).not.toBeNull();
    now=2001;expect(trace.sample({stage:'decoder',action:'sample',currentTime:4})).toBeNull();
  });
  it('samples both fixed decoder slots fairly when their timer order never changes',()=>{
    let now=0;const trace=new PlaybackTrace({now:()=>now});
    for(let tick=0;tick<5;tick++){
      now=tick*2000;
      trace.sample({stage:'decoder',action:'sample',deckSlot:0,active:tick%2===0,currentTime:tick+1});
      now+=10;
      trace.sample({stage:'decoder',action:'sample',deckSlot:1,active:tick%2===1,currentTime:tick+2});
    }
    const events=trace.snapshot().events;
    expect(events.filter(event=>event.deckSlot===0)).toHaveLength(5);
    expect(events.filter(event=>event.deckSlot===1)).toHaveLength(5);
    expect(events.filter(event=>event.deckSlot===1&&event.active)).toHaveLength(2);
  });
  it('keeps each decoder and unscoped sample independently throttled without growing a job map',()=>{
    let now=0;const trace=new PlaybackTrace({now:()=>now});
    for(const deckSlot of [0,1,undefined])expect(trace.sample({stage:'decoder',action:'sample',deckSlot,currentTime:1})).not.toBeNull();
    now=100;
    for(const deckSlot of [0,1,undefined])expect(trace.sample({stage:'decoder',action:'sample',deckSlot,jobGeneration:99,currentTime:2})).toBeNull();
    now=2000;
    for(const deckSlot of [0,1,undefined])expect(trace.sample({stage:'decoder',action:'sample',deckSlot,currentTime:3})).not.toBeNull();
    expect(trace.snapshot().events).toHaveLength(6);
  });
  it('does not throttle real transitions or errors between samples',()=>{
    let now=0;const sink=vi.fn();const trace=new PlaybackTrace({now:()=>now,sink});
    trace.sample({stage:'decoder',action:'sample',currentTime:59});now=1;
    trace.record({stage:'lease',action:'error',reason:'transport-failed',httpStatus:503});
    expect(sink).toHaveBeenCalledTimes(1);expect(sink.mock.calls[0][0].events).toHaveLength(2);
  });
  it('emits recent trace once for a duplicate failure and preserves recovery transitions',()=>{
    const sink=vi.fn();const trace=new PlaybackTrace({now:()=>0,sink});
    trace.record({stage:'recovery',action:'reconnect',reason:'session-expired'});
    trace.record({stage:'recovery',action:'failed',reason:'transport-failed'});
    trace.record({stage:'recovery',action:'failed',reason:'transport-failed'});
    expect(sink).toHaveBeenCalledTimes(1);
    trace.record({stage:'recovery',action:'recovered',reason:'healthy'});
    trace.record({stage:'recovery',action:'failed',reason:'transport-failed'});
    expect(sink).toHaveBeenCalledTimes(2);expect(trace.snapshot().events.map(e=>e.action)).toEqual(['reconnect','failed','recovered','failed']);
  });
  it('assigns local generations to manual pause/play/retry without accepting caller identifiers',()=>{
    const trace=new PlaybackTrace({now:()=>0});
    trace.record({stage:'deck',action:'play',intentGeneration:12345678,sessionId:'private'});
    trace.beginIntent('manual-pause');trace.record({stage:'deck',action:'pause'});
    trace.beginIntent('manual-play');trace.record({stage:'recovery',action:'recover'});
    trace.beginIntent('retry');
    expect(trace.snapshot().events.map(e=>e.intentGeneration)).toEqual([0,1,1,2,2,3]);
    expect(JSON.stringify(trace.snapshot())).not.toMatch(/private|12345678/);
  });
  it('copies snapshots and sink output so callers cannot mutate the ring',()=>{
    const sink=vi.fn(snapshot=>{snapshot.events[0].episode=999;});const trace=new PlaybackTrace({now:()=>0,sink});
    const captured=trace.record({stage:'lease',action:'error',episode:126});
    const snapshot=trace.snapshot();snapshot.events[0].episode=1;snapshot.events.length=0;
    expect(captured?.episode).toBe(126);expect(trace.snapshot().events[0].episode).toBe(126);
  });
  it('does not let sync or async sink failures affect playback',async()=>{
    for(const sink of [()=>{throw new Error('sink failure');},()=>Promise.reject(new Error('sink failure'))]){
      const trace=new PlaybackTrace({now:()=>0,sink});expect(()=>trace.record({stage:'lease',action:'error'})).not.toThrow();
    }
    await Promise.resolve();await Promise.resolve();
  });
  it('bounds asynchronous error emission to one active snapshot plus the latest pending snapshot',async()=>{
    let release!:()=>void;const first=new Promise<void>(resolve=>{release=resolve;});
    const sink=vi.fn().mockReturnValueOnce(first).mockReturnValue(undefined);
    const trace=new PlaybackTrace({now:()=>0,sink});
    for(let i=0;i<500;i++)trace.record({stage:'lease',action:'error',jobGeneration:i});
    expect(sink).toHaveBeenCalledTimes(1);release();await Promise.resolve();await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(2);expect(sink.mock.calls[1][0].events).toHaveLength(200);
    expect(sink.mock.calls[1][0].events.at(-1).sequence).toBe(500);
  });
  it('delivers the latest queued fault once on dispose even when an older write is still pending',async()=>{
    let release!:()=>void;const sink=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockResolvedValue(undefined);
    const trace=new PlaybackTrace({now:()=>0,sink});
    trace.record({stage:'lease',action:'error',jobGeneration:1});trace.record({stage:'lease',action:'error',jobGeneration:2});
    trace.dispose();expect(sink).toHaveBeenCalledTimes(2);expect(sink.mock.calls[1][0].events.at(-1).jobGeneration).toBe(2);
    expect(trace.snapshot().events).toEqual([]);
    release();await Promise.resolve();await Promise.resolve();trace.dispose();expect(sink).toHaveBeenCalledTimes(2);
  });
  it('keeps generated elapsed time monotonic even if an injected clock rolls backward',()=>{
    let now=1000;const trace=new PlaybackTrace({now:()=>now});
    now=1005;trace.record({stage:'deck',action:'play'});now=999;trace.record({stage:'deck',action:'pause'});
    expect(trace.snapshot().events.map(e=>e.elapsedMs)).toEqual([5,5]);
  });
  it('never emits unsafe strings and rejects oversized required event values',()=>{
    const sink=vi.fn();const trace=new PlaybackTrace({now:()=>0,sink});
    trace.record({stage:'lease',action:'error',reason:'https://x.invalid?token=secret',url:'secret',message:'secret',sessionId:'secret',uid:'secret',code:'secret'});
    expect(JSON.stringify(sink.mock.calls)).not.toContain('secret');
    expect(trace.record({stage:'lease',action:'secret'.repeat(1000000)})).toBeNull();
  });
  it('disposes retained events and callbacks and never samples again',()=>{
    const now=vi.fn(()=>0),sink=vi.fn();const trace=new PlaybackTrace({now,sink});
    trace.record({stage:'deck',action:'play'});trace.dispose();const calls=now.mock.calls.length;
    expect(trace.record({stage:'lease',action:'error'})).toBeNull();expect(trace.sample({stage:'decoder',action:'sample'})).toBeNull();
    expect(trace.snapshot().events).toEqual([]);expect(now).toHaveBeenCalledTimes(calls);expect(sink).not.toHaveBeenCalled();
  });
});
