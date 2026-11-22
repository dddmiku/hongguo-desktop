import {MediaSessionRecoveryError} from './MediaSessionLease';

const cancelled=()=>new DOMException('Playback recovery cancelled','AbortError');
const wait=(signal:AbortSignal,delay:number)=>new Promise<void>((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(cancelled());};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});

/** One recovery budget per interruption, reset by decoded health, not by POST success. */
export class MediaReconnectCoordinator<T> {
  private pending:Promise<T>|null=null;
  private incident=false;
  private elapsed=0;
  private attempt=0;
  private sampledAt:number;
  private wasAllowed:boolean;
  constructor(private signal:AbortSignal,private allowed:()=>boolean,
    private onRetry:(attempt:number,delay:number)=>void=()=>{},private now=()=>performance.now(),
    private budgetMs=60000,private stopTask:()=>void=()=>{}){this.sampledAt=now();this.wasAllowed=allowed();}
  get recovering(){return this.pending!==null;}
  observeIntent(){this.sample();}
  private sample(){
    const now=this.now();if(this.incident&&this.wasAllowed)this.elapsed+=Math.max(0,now-this.sampledAt);
    this.sampledAt=now;this.wasAllowed=this.allowed();
  }
  markHealthy(){if(this.pending)return;this.incident=false;this.elapsed=0;this.attempt=0;this.sampledAt=this.now();this.wasAllowed=this.allowed();}
  private check(){if(this.signal.aborted)throw cancelled();}
  private observeTask(task:()=>Promise<T>):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      let finished=false;
      const finish=(value:T|undefined,error?:unknown)=>{
        if(finished)return;finished=true;clearInterval(timer);this.signal.removeEventListener('abort',abort);
        if(error!==undefined){try{this.stopTask();}catch{}reject(error);}else resolve(value as T);
      };
      const abort=()=>finish(undefined,cancelled());
      const timer=setInterval(()=>{this.sample();if(this.allowed()&&this.elapsed>=this.budgetMs)finish(undefined,new MediaSessionRecoveryError());},250);
      this.signal.addEventListener('abort',abort,{once:true});
      if(this.signal.aborted){abort();return;}
      // The transport may not be cancellable across IPC. Observe it so a late result
      // is consumed, but never delivered after its owner was cancelled.
      void Promise.resolve().then(()=>{this.check();return task();}).then(value=>finish(value),error=>finish(undefined,error));
    });
  }
  private async delay(ms:number){
    let remaining=ms;
    while(remaining>0){
      this.check();this.sample();
      if(this.allowed()&&this.elapsed>=this.budgetMs)throw new MediaSessionRecoveryError();
      const allowed=this.allowed(),step=Math.min(250,remaining);
      await wait(this.signal,step);this.sample();
      if(allowed)remaining-=step;
    }
  }
  run(task:()=>Promise<T>):Promise<T>{
    if(this.pending)return this.pending;
    if(this.signal.aborted)return Promise.reject(cancelled());
    const retryUnhealthyReplacement=this.incident&&this.attempt>0;
    this.sample();this.incident=true;
    const promise=(async()=>{
      // API ready is not playback health. A replacement that never decoded may
      // fail again; continue this incident with its existing backoff and budget.
      if(retryUnhealthyReplacement&&this.attempt>0){
        const delay=Math.min(8000,1000*2**Math.min(3,this.attempt-1));
        this.onRetry(this.attempt,delay);await this.delay(delay);
      }
      for(;;){
        this.check();this.sample();
        if(!this.allowed()){await wait(this.signal,250);continue;}
        if(this.elapsed>=this.budgetMs)throw new MediaSessionRecoveryError();
        this.attempt++;
        try{const result=await this.observeTask(task);this.check();this.sample();return result;}
        catch(error){
          this.check();this.sample();
          if(!(error instanceof MediaSessionRecoveryError))throw error;
          if(this.elapsed>=this.budgetMs)throw error;
          const delay=Math.min(8000,1000*2**Math.min(3,this.attempt-1));
          this.onRetry(this.attempt,delay);await this.delay(delay);
        }
      }
    })();
    this.pending=promise;
    void promise.finally(()=>{if(this.pending===promise)this.pending=null;}).catch(()=>{});
    return promise;
  }
}
