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
  private online=true;
  private disposed=false;
  private nextAllowed=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending:{generation:number;promise:Promise<SyncResult>}|undefined;
  constructor(private dependencies:Dependencies){}
  get available(){return !this.disposed&&this.active&&this.online&&this.uid!=='local';}
  setAccount(uid:string){
    if(uid===this.uid)return;
    this.uid=uid;this.generation++;this.nextAllowed=0;this.schedule(120000);
  }
  setActive(active:boolean){this.active=active;this.schedule(120000);}
  setOnline(online:boolean){
    const reconnect=!this.online&&online;this.online=online;
    if(reconnect)this.nextAllowed=0;
    this.schedule(reconnect?0:120000);
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
    this.nextAllowed=Date.now()+60000;
    let retry=false;
    const promise=Promise.resolve().then(()=>this.dependencies.load({uid,background:!force,isCurrent})).then(result=>{
      if(!isCurrent())return cached();
      retry=!!result.retry;this.dependencies.publish(result);return result;
    }).catch(error=>{if(!isCurrent())return cached();retry=true;throw error;}).finally(()=>{
      if(this.pending?.promise===promise)this.pending=undefined;
      if(isCurrent()){
        if(retry)this.nextAllowed=Date.now()+30000;
        this.schedule(retry?30000:120000);
      }else this.schedule(0);
    });
    this.pending={generation,promise};return promise;
  }
  dispose(){this.disposed=true;this.generation++;clearTimeout(this.timer);this.timer=undefined;}
}
