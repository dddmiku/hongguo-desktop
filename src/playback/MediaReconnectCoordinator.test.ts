import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MediaReconnectCoordinator} from './MediaReconnectCoordinator';
import {MediaSessionLease,MediaSessionRecoveryError,MediaSessionTaskError} from './MediaSessionLease';

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
const setup=(allowed=()=>true,budgetMs?:number)=>{
  const abort=new AbortController(),onRetry=vi.fn();
  const coordinator=new MediaReconnectCoordinator<string>(abort.signal,allowed,onRetry,()=>Date.now(),budgetMs);
  return {abort,onRetry,coordinator};
};
function observe<T>(promise:Promise<T>){
  const state:{status:'pending'|'fulfilled'|'rejected';value?:T;error?:unknown}={status:'pending'};
  const finished=promise.then(value=>{state.status='fulfilled';state.value=value;},error=>{state.status='rejected';state.error=error;});
  return {state,finished};
}

describe('decoded-health-owned media reconnect budget',()=>{
  it('owns unhealthy incident backoff even when a caller forgets the UI reconnecting flag',async()=>{
    const {coordinator}=setup(),task=vi.fn(async()=>'api-ready-without-video-health');
    await coordinator.run(task);const next=observe(coordinator.run(task));
    await vi.advanceTimersByTimeAsync(999);expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);await next.finished;expect(task).toHaveBeenCalledTimes(2);
  });
  it('paces repeated API-ready but undecoded replacement faults with the same incident backoff',async()=>{
    const {coordinator,onRetry}=setup(),calls:number[]=[],task=vi.fn(async()=>{calls.push(Date.now());return 'ready-not-healthy';});
    for(const delay of [0,1000,2000,4000,8000,8000]){
      const next=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(delay);await next.finished;
      expect(next.state.status).toBe('fulfilled');
    }
    expect(calls).toEqual([0,1000,3000,7000,15000,23000]);
    expect(onRetry.mock.calls).toEqual([[1,1000],[2,2000],[3,4000],[4,8000],[5,8000]]);
    coordinator.markHealthy();await expect(coordinator.run(task)).resolves.toBe('ready-not-healthy');
    expect(calls.at(-1)).toBe(23000);
  });
  it('does not let endless ready replies with no new decoded frames reset the 60s deadline',async()=>{
    const {coordinator}=setup(),calls:number[]=[],task=vi.fn(async()=>{calls.push(Date.now());return 'ready-not-healthy';});
    const result=observe((async()=>{for(let n=0;n<20;n++)await coordinator.run(task);})());
    await vi.advanceTimersByTimeAsync(60000);await result.finished;
    expect(result.state.error).toBeInstanceOf(MediaSessionRecoveryError);
    expect(calls).toEqual([0,1000,3000,7000,15000,23000,31000,39000,47000,55000]);
    await vi.advanceTimersByTimeAsync(120000);expect(task).toHaveBeenCalledTimes(10);
  });
  it('pauses and coalesces an unhealthy replacement backoff without spending hidden time',async()=>{
    let allowed=true;const {coordinator}=setup(()=>allowed),task=vi.fn(async()=>'ready-not-healthy');
    await coordinator.run(task);const first=coordinator.run(task),next=observe(first);
    const shared=coordinator.run(vi.fn(async()=>'wrong'));expect(shared).toBe(first);
    await vi.advanceTimersByTimeAsync(500);allowed=false;coordinator.observeIntent();
    await vi.advanceTimersByTimeAsync(70000);expect(task).toHaveBeenCalledTimes(1);
    allowed=true;coordinator.observeIntent();await vi.advanceTimersByTimeAsync(500);await next.finished;
    expect(task).toHaveBeenCalledTimes(2);await expect(shared).resolves.toBe('ready-not-healthy');
  });
  it('coalesces simultaneous faults into the same promise and a single task',async()=>{
    const {coordinator}=setup();let release!:(value:string)=>void;
    const task=vi.fn(()=>new Promise<string>(resolve=>{release=resolve;})),other=vi.fn(async()=>'other');
    const first=coordinator.run(task),second=coordinator.run(other);
    await Promise.resolve();
    expect(second).toBe(first);expect(coordinator.recovering).toBe(true);expect(task).toHaveBeenCalledTimes(1);expect(other).not.toHaveBeenCalled();
    release('prepared');await expect(first).resolves.toBe('prepared');await Promise.resolve();expect(coordinator.recovering).toBe(false);
  });
  it('retries typed transport failures after exactly 1, 2, 4 and capped 8 seconds',async()=>{
    const {coordinator,onRetry}=setup();const calls:number[]=[];
    const task=vi.fn(async()=>{calls.push(Date.now());if(calls.length<6)throw new MediaSessionRecoveryError();return 'prepared';});
    const result=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(23000);await result.finished;
    expect(calls).toEqual([0,1000,3000,7000,15000,23000]);
    expect(onRetry.mock.calls).toEqual([[1,1000],[2,2000],[3,4000],[4,8000],[5,8000]]);expect(result.state.value).toBe('prepared');
  });
  it('makes only one lease POST per coordinator attempt rather than nested lease retries',async()=>{
    const abort=new AbortController(),request=vi.fn(async(_path:string,options?:{method?:string})=>{
      if(options?.method==='POST')throw new TypeError('Failed to fetch');return {};
    });
    const lease=new MediaSessionLease({request},{seriesId:'12345678',episode:126,quality:'1080p',start:59},abort.signal);
    await lease.open(Promise.resolve({id:'existing',phase:'complete',url:'/index.m3u8'}));
    const coordinator=new MediaReconnectCoordinator(abort.signal,()=>true,()=>{},()=>Date.now());
    const result=observe(coordinator.run(()=>lease.reconnect()));await vi.advanceTimersByTimeAsync(999);
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(2);
    abort.abort();await result.finished;lease.release();expect(result.state.error).toMatchObject({name:'AbortError'});
  });
  it('preserves source/business errors immediately without retrying or rewriting them',async()=>{
    for(const failure of [new Error('source unavailable'),new MediaSessionTaskError('encode failed')]){
      const {coordinator,onRetry}=setup(),task=vi.fn(async()=>{throw failure;});
      await expect(coordinator.run(task)).rejects.toBe(failure);expect(task).toHaveBeenCalledTimes(1);expect(onRetry).not.toHaveBeenCalled();
    }
  });
  it('does not mistake a business Error with transport-like wording for the typed retry signal',async()=>{
    const {coordinator,onRetry}=setup(),failure=new Error('Failed to fetch'),task=vi.fn(async()=>{throw failure;});
    await expect(coordinator.run(task)).rejects.toBe(failure);expect(task).toHaveBeenCalledTimes(1);expect(onRetry).not.toHaveBeenCalled();
  });
  it('does not reset cumulative incident time when replacement POST succeeds',async()=>{
    const {coordinator}=setup(),task=vi.fn(async()=>'prepared');
    await expect(coordinator.run(task)).resolves.toBe('prepared');await vi.advanceTimersByTimeAsync(57000);
    const next=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(1000);await next.finished;
    expect(next.state.value).toBe('prepared');await vi.advanceTimersByTimeAsync(2000);
    await expect(coordinator.run(task)).rejects.toBeInstanceOf(MediaSessionRecoveryError);expect(task).toHaveBeenCalledTimes(2);
    coordinator.markHealthy();await expect(coordinator.run(task)).resolves.toBe('prepared');expect(task).toHaveBeenCalledTimes(3);
  });
  it('preserves retry-attempt backoff across prepared jobs and resets it only on decoded health',async()=>{
    const {coordinator,onRetry,abort}=setup();let fail=true;
    const first=observe(coordinator.run(async()=>{if(fail){fail=false;throw new MediaSessionRecoveryError();}return 'prepared';}));
    await vi.advanceTimersByTimeAsync(1000);await first.finished;expect(onRetry).toHaveBeenLastCalledWith(1,1000);
    let failSecond=true;const second=observe(coordinator.run(async()=>{if(failSecond){failSecond=false;throw new MediaSessionRecoveryError();}return 'prepared';}));await vi.advanceTimersByTimeAsync(2000);
    expect(onRetry).toHaveBeenLastCalledWith(3,4000);await vi.advanceTimersByTimeAsync(4000);await second.finished;
    coordinator.markHealthy();const retry=observe(coordinator.run(async()=>{throw new MediaSessionRecoveryError();}));
    await vi.advanceTimersByTimeAsync(0);expect(onRetry).toHaveBeenLastCalledWith(1,1000);abort.abort();await retry.finished;
  });
  it('emits no requests and spends no budget while initially paused, hidden or offline',async()=>{
    let allowed=false;const {coordinator,abort}=setup(()=>allowed),task=vi.fn(async()=>'prepared');
    const result=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(90000);expect(task).not.toHaveBeenCalled();
    allowed=true;await vi.advanceTimersByTimeAsync(250);await result.finished;expect(result.state.value).toBe('prepared');expect(task).toHaveBeenCalledTimes(1);abort.abort();
  });
  it('pauses retry delay and incident budget for an accurately sampled inactive window',async()=>{
    const allowed=()=>Date.now()<500||Date.now()>=6500;const {coordinator}=setup(allowed,2000),calls:number[]=[];
    const result=observe(coordinator.run(async()=>{calls.push(Date.now());if(calls.length===1)throw new MediaSessionRecoveryError();return 'prepared';}));
    await vi.advanceTimersByTimeAsync(6500);expect(calls).toEqual([0]);expect(result.state.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(500);await result.finished;expect(calls).toEqual([0,7000]);expect(result.state.value).toBe('prepared');
  });
  it('does not charge a paused window that occurs while one request is in flight',async()=>{
    let allowed=true;const {coordinator}=setup(()=>allowed);let release!:(value:string)=>void;
    const first=observe(coordinator.run(()=>new Promise<string>(resolve=>{release=resolve;})));
    await vi.advanceTimersByTimeAsync(500);allowed=false;await vi.advanceTimersByTimeAsync(70000);
    release('prepared');await first.finished;allowed=true;
    const task=vi.fn(async()=>'next-prepared');const next=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(1000);await next.finished;
    expect(next.state.value).toBe('next-prepared');expect(task).toHaveBeenCalledTimes(1);
  });
  it('rejects at the 60 second deadline instead of completing the rest of an 8 second delay',async()=>{
    const {coordinator,abort}=setup(),calls:number[]=[];
    const result=observe(coordinator.run(async()=>{calls.push(Date.now());throw new MediaSessionRecoveryError();}));
    try{
      await vi.advanceTimersByTimeAsync(59999);expect(result.state.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);expect(result.state.status).toBe('rejected');expect(result.state.error).toBeInstanceOf(MediaSessionRecoveryError);
      expect(calls.every(time=>time<60000)).toBe(true);const count=calls.length;await vi.advanceTimersByTimeAsync(120000);expect(calls).toHaveLength(count);
    }finally{abort.abort();await result.finished;}
  });
  it('does not issue more downloads after an exhausted incident without decoded health',async()=>{
    const {coordinator}=setup(()=>true,3000),task=vi.fn(async()=>{throw new MediaSessionRecoveryError();});
    const result=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(3000);await result.finished;
    expect(result.state.error).toBeInstanceOf(MediaSessionRecoveryError);expect(task).toHaveBeenCalledTimes(2);
    await expect(coordinator.run(task)).rejects.toBeInstanceOf(MediaSessionRecoveryError);expect(task).toHaveBeenCalledTimes(2);
    coordinator.markHealthy();const fresh=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(0);expect(task).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);await fresh.finished;
  });
  it('cancels a backoff wait immediately and never starts another attempt',async()=>{
    const {coordinator,abort}=setup(),task=vi.fn(async()=>{throw new MediaSessionRecoveryError();});
    const result=observe(coordinator.run(task));await vi.advanceTimersByTimeAsync(500);abort.abort();await result.finished;
    expect(result.state.error).toMatchObject({name:'AbortError'});await vi.advanceTimersByTimeAsync(10000);expect(task).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight wait before its late successful result and never delivers it',async()=>{
    const {coordinator,abort}=setup();let release!:(value:string)=>void;
    const result=observe(coordinator.run(()=>new Promise<string>(resolve=>{release=resolve;})));await Promise.resolve();abort.abort();await vi.advanceTimersByTimeAsync(0);
    const cancelledBeforeReply=result.state.status==='rejected';release('late-prepared');await result.finished;
    expect(cancelledBeforeReply).toBe(true);expect(result.state.error).toMatchObject({name:'AbortError'});expect(result.state.value).toBeUndefined();
  });
  it('never invokes a task when its owning signal was already cancelled',async()=>{
    const {coordinator,abort}=setup(),task=vi.fn(async()=>'prepared');abort.abort();
    await expect(coordinator.run(task)).rejects.toMatchObject({name:'AbortError'});expect(task).not.toHaveBeenCalled();
  });
  it('reopens a bounded budget rather than disabling it when decoded health arrives during pending recovery',async()=>{
    const {coordinator,abort}=setup(),task=vi.fn(async()=>{throw new MediaSessionRecoveryError();});
    const result=observe(coordinator.run(task));
    try{
      await vi.advanceTimersByTimeAsync(1000);coordinator.markHealthy();await vi.advanceTimersByTimeAsync(60000);
      expect(result.state.status).toBe('rejected');expect(result.state.error).toBeInstanceOf(MediaSessionRecoveryError);
      const count=task.mock.calls.length;await vi.advanceTimersByTimeAsync(120000);expect(task).toHaveBeenCalledTimes(count);
    }finally{abort.abort();await result.finished;}
  });
  it('expires an in-flight request at its budget deadline and never delivers its late prepared result',async()=>{
    const {coordinator}=setup();let release!:(value:string)=>void;
    const result=observe(coordinator.run(()=>new Promise<string>(resolve=>{release=resolve;})));await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60000);const rejectedBeforeReply=result.state.status==='rejected';
    release('late-prepared');await result.finished;
    expect(rejectedBeforeReply).toBe(true);expect(result.state.error).toBeInstanceOf(MediaSessionRecoveryError);expect(result.state.value).toBeUndefined();
  });
  it('stops one abandoned job once when its budget expires and consumes late completion',async()=>{
    const abort=new AbortController(),stopTask=vi.fn();let release!:(value:string)=>void;
    const coordinator=new MediaReconnectCoordinator<string>(abort.signal,()=>true,()=>{},()=>Date.now(),1000,stopTask);
    const result=observe(coordinator.run(()=>new Promise<string>(resolve=>{release=resolve;})));await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);await result.finished;expect(stopTask).toHaveBeenCalledTimes(1);
    release('late-prepared');await vi.advanceTimersByTimeAsync(0);expect(stopTask).toHaveBeenCalledTimes(1);expect(result.state.value).toBeUndefined();
  });
  it('preserves cancellation even if abandoned-job cleanup fails and never stops successful work',async()=>{
    const abort=new AbortController(),stopTask=vi.fn(()=>{throw new Error('cleanup failure');});let release!:(value:string)=>void;
    const coordinator=new MediaReconnectCoordinator<string>(abort.signal,()=>true,()=>{},()=>Date.now(),60000,stopTask);
    await expect(coordinator.run(async()=>'prepared')).resolves.toBe('prepared');expect(stopTask).not.toHaveBeenCalled();
    coordinator.markHealthy();
    const result=observe(coordinator.run(()=>new Promise<string>(resolve=>{release=resolve;})));await Promise.resolve();abort.abort();await result.finished;
    expect(stopTask).toHaveBeenCalledTimes(1);expect(result.state.error).toMatchObject({name:'AbortError'});release('late-prepared');await vi.advanceTimersByTimeAsync(0);
  });
});
