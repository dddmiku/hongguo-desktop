import type {MediaSession} from '../../shared/contracts';
type Transport={request:(path:string,options?:{method?:string;body?:unknown})=>Promise<unknown>};
type Payload={seriesId:string;episode:number;quality:string;start:number;acceptHevc?:boolean};
const aborted=()=>new DOMException('Playback preparation cancelled','AbortError');
const expired=(error:unknown)=>error instanceof Error&&/播放会话(?:已过期|不存在)|请求的资源不存在或参数不正确/.test(error.message);
class SessionStateError extends Error{
  constructor(readonly phase:'error'|'cancelled',message:string){super(message);this.name='SessionStateError';}
}
/** A failed replacement job is a source/encode failure, not an expired connection. */
export class MediaSessionTaskError extends Error{
  constructor(message:string){super(message);this.name='MediaSessionTaskError';}
}
export class MediaSessionRecoveryError extends Error{
  constructor(){super('播放连接暂时不可用，请重试当前集');this.name='MediaSessionRecoveryError';}
}
const transientTransport=(error:unknown)=>error instanceof TypeError||error instanceof Error&&
  (['AbortError','TimeoutError','NetworkError'].includes(error.name)||/fetch failed|failed to fetch|network error|socket hang up|ECONNRESET|ETIMEDOUT/i.test(error.message));
const pause=(signal:AbortSignal,delay=150)=>new Promise<void>((resolve,reject)=>{
  const cancel=()=>{clearTimeout(timer);reject(aborted());};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},delay);
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
});

/** A player-owned lease. Session interruptions can recover while healthy heartbeats reset the retry budget. */
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
  private async ready(session:MediaSession):Promise<MediaSession>{
    const deadline=Date.now()+120000;
    while(session.phase==='preparing'){
      this.check();if(Date.now()>deadline)throw new Error('准备时间较长，请重试当前集');
      await pause(this.signal);this.check();
      const result=await this.transport.request(`/media/session/${session.id}`);this.check();
      if(session.id!==this.id&&this.current)return this.ready(this.current);
      session=this.accept(result);
    }
    this.check();
    if(session.phase==='cancelled')throw new SessionStateError('cancelled','播放会话已过期，请重新连接');
    if(session.phase==='error')throw new SessionStateError('error',session.error||'视频准备失败，请重试当前集');
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
      const current=await this.ready(this.accept(result));
      // A successful heartbeat proves this replacement is healthy. Allow one
      // future renewal for a later, independent interruption.
      this.renewed=false;
      return current;
    }catch(error){
      this.check();
      if(id!==this.id&&this.current)return this.current;
      if(expired(error)||error instanceof SessionStateError)return this.reconnect(position);throw error;
    }
  }
  async reconnect(position=this.payload.start):Promise<MediaSession>{
    this.check();
    if(this.reconnecting)return this.reconnecting;
    if(this.renewed)throw new Error('播放连接已失效，请重试当前集');
    this.renewed=true;this.dispose(this.id);
    const payload={...this.payload,start:Number.isFinite(position)?Math.max(0,position):this.payload.start};
    this.reconnecting=(async()=>{
      try{
        let result:unknown;
        for(let attempt=0;attempt<3;attempt++){
          this.check();
          try{result=await this.transport.request('/media/session',{method:'POST',body:payload});break;}
          catch(error){
            this.check();
            if(!transientTransport(error)||attempt===2)throw new MediaSessionRecoveryError();
            await pause(this.signal,150*2**attempt);
          }
        }
        return await this.ready(this.accept(result));
      }
      catch(error){
        this.check();
        if(error instanceof MediaSessionTaskError)throw error;
        if(error instanceof MediaSessionRecoveryError)throw error;
        if(error instanceof SessionStateError){
          if(error.phase==='error')throw new MediaSessionTaskError(error.message);
          throw new Error('播放会话已过期，请重新连接');
        }
        if(expired(error))throw new Error('播放连接已失效，请重试当前集');
        throw error;
      }
      finally{this.reconnecting=null;}
    })();
    return this.reconnecting;
  }
  release(){if(this.released)return;this.released=true;this.dispose(this.id);}
}
