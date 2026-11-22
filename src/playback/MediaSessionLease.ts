import type {MediaSession} from '../../shared/contracts';
import {MediaRequestError,requestMedia,isRetryableMediaRequestError,type MediaRequestTransport} from '../../shared/media-request';
type Transport=MediaRequestTransport;
type Payload={seriesId:string;episode:number;quality:string;start:number;acceptHevc?:boolean};
const aborted=()=>new DOMException('Playback preparation cancelled','AbortError');
const expired=(error:unknown)=>error instanceof MediaRequestError?error.code==='MEDIA_SESSION_EXPIRED':error instanceof Error&&/播放会话(?:已过期|不存在)|请求的资源不存在或参数不正确/.test(error.message);
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
export class MediaSessionNeedsRecoveryError extends Error{
  constructor(message:string){super(message);this.name='MediaSessionNeedsRecoveryError';}
}
const transientTransport=isRetryableMediaRequestError;
const pause=(signal:AbortSignal,delay=150)=>new Promise<void>((resolve,reject)=>{
  const cancel=()=>{clearTimeout(timer);reject(aborted());};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},delay);
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
});

/** Lease ownership only. The decoded-playback coordinator owns all retry policy. */
export class MediaSessionLease {
  private current:MediaSession|null=null;
  private released=false;
  private reconnecting:Promise<MediaSession>|null=null;
  private reconnectAbort:AbortController|null=null;
  private deleted=new Set<string>();
  private held=new Map<string,number>();
  private hold(id:string){this.held.set(id,(this.held.get(id)||0)+1);}
  private unhold(id:string){const count=(this.held.get(id)||0)-1;if(count>0)this.held.set(id,count);else this.held.delete(id);}
  constructor(private transport:Transport,private payload:Payload,private signal:AbortSignal){}
  get id(){return this.current?.id||'';}
  private check(operation?:AbortSignal){if(this.released||this.signal.aborted||operation?.aborted)throw aborted();}
  private dispose(id:string){
    if(!id||this.deleted.has(id))return;this.deleted.add(id);
    void requestMedia(this.transport,`/media/session/${id}`,{method:'DELETE'}).catch(()=>{});
  }
  private validate(value:unknown):MediaSession{
    if(!value||typeof value!=='object')throw new Error('播放会话返回异常，请重试');
    const session=value as MediaSession;
    if(typeof session.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)||typeof session.url!=='string'
        ||!['preparing','ready','complete','error','cancelled'].includes(session.phase))throw new Error('播放会话返回异常，请重试');
    return session;
  }
  private accept(value:unknown):MediaSession{
    const session=this.validate(value);this.current=session;
    if(this.released||this.signal.aborted){this.dispose(session.id);throw aborted();}
    return session;
  }
  private async ready(session:MediaSession,operation=this.signal,committed=true):Promise<MediaSession>{
    const deadline=Date.now()+120000;
    while(session.phase==='preparing'){
      this.check(operation);if(Date.now()>deadline)throw new Error('准备时间较长，请重试当前集');
      await pause(operation);this.check(operation);
      const result=await requestMedia(this.transport,`/media/session/${session.id}`);this.check(operation);
      if(committed&&session.id!==this.id&&this.current)return this.ready(this.current,operation);
      const next=this.validate(result);
      if(next.id!==session.id)throw new Error('播放会话返回标识异常，请重试');
      session=committed?this.accept(next):next;
    }
    this.check(operation);
    if(session.phase==='cancelled')throw new SessionStateError('cancelled','播放会话已过期，请重新连接');
    if(session.phase==='error')throw new SessionStateError('error',session.error||'视频准备失败，请重试当前集');
    return session;
  }
  async open(prefetched?:Promise<MediaSession>):Promise<MediaSession>{
    this.check();
    try{
      const session=this.accept(await(prefetched??requestMedia(this.transport,'/media/session',{method:'POST',body:this.payload})));
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
      const result=await requestMedia(this.transport,`/media/session/${id}`);this.check();
      if(id!==this.id&&this.current)return this.current;
      const current=await this.ready(this.accept(result));
      return current;
    }catch(error){
      this.check();
      if(id!==this.id&&this.current)return this.current;
      if(expired(error)||error instanceof SessionStateError)throw new MediaSessionNeedsRecoveryError(error instanceof Error?error.message:'播放会话已过期');
      throw error;
    }
  }
  async reconnect(position=this.payload.start):Promise<MediaSession>{
    this.check();
    if(this.reconnecting)return this.reconnecting;
    const previous=this.current;
    const operation=new AbortController();this.reconnectAbort=operation;
    if(previous)this.hold(previous.id);
    let candidate:MediaSession|null=null;
    const payload={...this.payload,start:Number.isFinite(position)?Math.max(0,position):this.payload.start};
    this.reconnecting=(async()=>{
      try{
        const result=await requestMedia(this.transport,'/media/session',{method:'POST',body:payload});
        candidate=this.validate(result);this.hold(candidate.id);
        const replacement=await this.ready(candidate,operation.signal,false);
        this.check(operation.signal);
        this.current=replacement;
        if(previous&&previous.id!==replacement.id)this.dispose(previous.id);
        return replacement;
      }
      catch(error){
        if(candidate&&candidate.id!==previous?.id)this.dispose(candidate.id);
        this.check(operation.signal);
        if(error instanceof MediaSessionTaskError)throw error;
        if(error instanceof MediaSessionRecoveryError)throw error;
        if(error instanceof SessionStateError){
          if(error.phase==='error')throw new MediaSessionTaskError(error.message);
          throw new Error('播放会话已过期，请重新连接');
        }
        if(expired(error))throw new Error('播放连接已失效，请重试当前集');
        if(transientTransport(error))throw new MediaSessionRecoveryError();
        throw error;
      }
      finally{
        if(previous){this.unhold(previous.id);if(this.released)this.dispose(previous.id);}
        if(candidate){this.unhold(candidate.id);if(this.released)this.dispose(candidate.id);}
        if(this.reconnectAbort===operation){this.reconnectAbort=null;this.reconnecting=null;}
      }
    })();
    return this.reconnecting;
  }
  cancelReconnect(){this.reconnectAbort?.abort();this.reconnectAbort=null;this.reconnecting=null;for(const id of this.held.keys())if(id!==this.id)this.dispose(id);}
  release(){if(this.released)return;this.released=true;this.cancelReconnect();this.dispose(this.id);for(const id of this.held.keys())this.dispose(id);}
}
