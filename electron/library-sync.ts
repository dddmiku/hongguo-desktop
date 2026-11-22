import type {Library} from '../shared/contracts';

export interface SyncContext {uid:string; background:boolean; isCurrent:()=>boolean;}
export interface SyncResult {library:Library; warnings:string[]; retry?:boolean;}
interface Dependencies {
  load:(context:SyncContext)=>Promise<SyncResult>;
  library:()=>Library;
  publish:(result:SyncResult)=>void;
}

// One synchronization loop for startup, navigation, focus, reconnect and manual refresh.
export class LibrarySyncController {
  private uid='local';
  private generation=0;
  private active=false;
  private realtime=false;
  private online=true;
  private disposed=false;
  private nextAllowed=0;
  private lastAttempt:number|undefined;
  private retryUntil=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending:{generation:number;promise:Promise<SyncResult>}|undefined;
  constructor(private dependencies:Dependencies){}
  get available(){return !this.disposed&&this.active&&this.online&&this.uid!=='local';}
  private get interval(){return this.realtime?15000:120000;}
  private get cooldown(){return this.realtime?15000:60000;}
  private stateDelay(){return this.retryUntil?Math.max(0,this.retryUntil-Date.now()):this.realtime?Math.max(0,this.nextAllowed-Date.now()):this.interval;}
  setAccount(uid:string){
    if(uid===this.uid)return;
    this.uid=uid;this.generation++;this.nextAllowed=0;this.lastAttempt=undefined;this.retryUntil=0;this.schedule(this.realtime?0:this.interval);
  }
  setActive(active:boolean){if(active===this.active)return;this.active=active;this.schedule(this.stateDelay());}
  // Only visible resume/history views need near-realtime cloud reads. Playback keeps the slow cadence.
  setRealtime(realtime:boolean){
    if(realtime===this.realtime)return;
    this.realtime=realtime;
    this.nextAllowed=this.retryUntil||(this.lastAttempt===undefined?0:this.lastAttempt+this.cooldown);
    this.schedule(this.stateDelay());
  }
  setOnline(online:boolean){
    if(online===this.online)return;
    const reconnect=!this.online&&online;this.online=online;
    if(reconnect){this.nextAllowed=0;this.retryUntil=0;}
    this.schedule(reconnect?0:this.stateDelay());
  }
  private schedule(delay:number){
    clearTimeout(this.timer);this.timer=undefined;
    if(!this.available)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.request().catch(()=>{});},delay);
    this.timer.unref?.();
  }
  async request(force=false):Promise<SyncResult>{
    const cached=()=>({library:this.dependencies.library(),warnings:[]});
    if(this.disposed||this.uid==='local')return cached();
    if(!this.online){if(force)throw new Error('当前网络未连接，联网后会自动同步');return cached();}
    if(this.pending){
      if(this.pending.generation===this.generation)return this.pending.promise;
      await this.pending.promise.catch(()=>{});return this.request(force);
    }
    if(!force&&(!this.active||Date.now()<this.nextAllowed))return cached();
    clearTimeout(this.timer);this.timer=undefined;
    const generation=this.generation,uid=this.uid;
    const isCurrent=()=>!this.disposed&&generation===this.generation&&uid===this.uid;
    this.lastAttempt=Date.now();this.retryUntil=0;this.nextAllowed=this.lastAttempt+this.cooldown;
    let retry=false;
    const promise=Promise.resolve().then(()=>this.dependencies.load({uid,background:!force,isCurrent})).then(result=>{
      if(!isCurrent())return cached();
      retry=!!result.retry;this.dependencies.publish(result);return result;
    }).catch(error=>{if(!isCurrent())return cached();retry=true;throw error;}).finally(()=>{
      if(this.pending?.promise===promise)this.pending=undefined;
      if(isCurrent()){
        if(retry){this.retryUntil=Date.now()+30000;this.nextAllowed=this.retryUntil;}
        else{this.retryUntil=0;this.nextAllowed=(this.lastAttempt??Date.now())+this.cooldown;}
        this.schedule(retry?30000:this.interval);
      }else this.schedule(0);
    });
    this.pending={generation,promise};return promise;
  }
  dispose(){this.disposed=true;this.generation++;clearTimeout(this.timer);this.timer=undefined;}
}
