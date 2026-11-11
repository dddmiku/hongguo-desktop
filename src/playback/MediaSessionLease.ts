import type {MediaSession} from '../../shared/contracts';
type Transport={request:(path:string,options?:{method?:string;body?:unknown})=>Promise<unknown>};
type Payload={seriesId:string;episode:number;quality:string;start:number;acceptHevc?:boolean};
const aborted=()=>new DOMException('Playback preparation cancelled','AbortError');
const expired=(error:unknown)=>error instanceof Error&&/播放会话(?:已过期|不存在)|请求的资源不存在或参数不正确/.test(error.message);
const pause=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const cancel=()=>{clearTimeout(timer);reject(aborted());};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},150);
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
});

/** A player-owned lease. Expired loopback references are rebuilt once without changing the episode. */
export class MediaSessionLease {
  private current:MediaSession|null=null;
  private released=false;
  private renewed=false;
  private reconnecting:Promise<MediaSession>|null=null;
  private deleted=new Set<string>();
  constructor(private transport:Transport,private payload:Payload,private signal:AbortSignal){}
  get id(){return this.current?.id||'';}
  private check(){if(this.released||this.signal.aborted)throw aborted();}
  private dispose(id:string){
    if(!id||this.deleted.has(id))return;this.deleted.add(id);
    void this.transport.request(`/media/session/${id}`,{method:'DELETE'}).catch(()=>{});
  }
  private accept(value:unknown):MediaSession{
    if(!value||typeof value!=='object')throw new Error('播放会话返回异常，请重试');
    const session=value as MediaSession;
    if(typeof session.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)||typeof session.url!=='string'
        ||!['preparing','ready','complete','error','cancelled'].includes(session.phase))throw new Error('播放会话返回异常，请重试');
    this.current=session;
    if(this.released||this.signal.aborted){this.dispose(session.id);throw aborted();}
    return session;
  }
  private async ready(session:MediaSession){
    const deadline=Date.now()+120000;
    while(session.phase==='preparing'){
      this.check();if(Date.now()>deadline)throw new Error('准备时间较长，请重试当前集');
      await pause(this.signal);this.check();
      session=this.accept(await this.transport.request(`/media/session/${session.id}`));
    }
    this.check();
    if(session.phase==='cancelled')throw new Error('播放会话已过期，请重新连接');
    if(session.phase==='error')throw new Error(session.error||'视频准备失败，请重试当前集');
    return session;
  }
  async open(prefetched?:Promise<MediaSession>):Promise<MediaSession>{
    this.check();
    try{
      const session=this.accept(await(prefetched??this.transport.request('/media/session',{method:'POST',body:this.payload})));
      return await this.ready(session);
    }catch(error){
      this.check();
      if(expired(error))return this.reconnect();
      throw error;
    }
  }
  async read(position=this.payload.start):Promise<MediaSession>{
    this.check();
    const id=this.id;
    try{
      const result=await this.transport.request(`/media/session/${id}`);this.check();
      if(id!==this.id&&this.current)return this.current;
      return this.accept(result);
    }catch(error){
      this.check();
      if(id!==this.id&&this.current)return this.current;
      if(expired(error))return this.reconnect(position);throw error;
    }
  }
  async reconnect(position=this.payload.start):Promise<MediaSession>{
    this.check();
    if(this.reconnecting)return this.reconnecting;
    if(this.renewed)throw new Error('播放连接已失效，请重试当前集');
    this.renewed=true;this.dispose(this.id);
    const payload={...this.payload,start:Number.isFinite(position)?Math.max(0,position):this.payload.start};
    this.reconnecting=(async()=>{
      try{return await this.ready(this.accept(await this.transport.request('/media/session',{method:'POST',body:payload})));}
      catch(error){this.check();if(expired(error))throw new Error('播放连接已失效，请重试当前集');throw error;}
      finally{this.reconnecting=null;}
    })();
    return this.reconnecting;
  }
  release(){if(this.released)return;this.released=true;this.dispose(this.id);}
}
