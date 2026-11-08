import type {MediaSession,NativeBridge} from '../../shared/contracts';
import type {PlaybackTarget} from './SeamlessSwitcher';
import {hardwareHevc} from './capabilities';
type Entry={target:PlaybackTarget;promise:Promise<MediaSession>;session?:MediaSession;cancelled:boolean;claimed:boolean;timer?:ReturnType<typeof setTimeout>};
type MediaTransport={request:(path:string,options?:Parameters<NativeBridge['request']>[1])=>Promise<MediaSession>};
const same=(a:PlaybackTarget,b:PlaybackTarget)=>a.seriesId===b.seriesId&&a.episode===b.episode&&a.quality===b.quality&&!!a.compatible===!!b.compatible&&Math.abs(a.start-b.start)<.1;
const aborted=()=>new DOMException('Preparation cancelled','AbortError');

/** One short-lived source lease, handed to the real decoder instead of starting duplicate work. */
export class MediaPreload {
  private entry:Entry|null=null;
  constructor(private bridge:MediaTransport,private capability=hardwareHevc){}
  private release(entry:Entry){
    entry.cancelled=true;clearTimeout(entry.timer);
    if(entry.session&&!entry.claimed){const id=entry.session.id;entry.session=undefined;void this.bridge.request(`/media/session/${id}`,{method:'DELETE'}).catch(()=>{});}
  }
  prepare(target:PlaybackTarget){
    if(this.entry&&same(this.entry.target,target))return;
    this.clear();
    const entry:Entry={target:{...target},promise:undefined as unknown as Promise<MediaSession>,cancelled:false,claimed:false};
    this.entry=entry;
    entry.promise=Promise.resolve().then(async()=>{
      const acceptHevc=!target.compatible&&await this.capability();
      if(entry.cancelled)throw aborted();
      const session=await this.bridge.request('/media/session',{method:'POST',body:{seriesId:target.seriesId,episode:target.episode,quality:target.quality,start:target.start,...(acceptHevc?{acceptHevc:true}:{})}});
      if(!session||typeof session.id!=='string'||!session.id)throw new Error('播放准备未完成');
      entry.session=session;
      if(entry.cancelled&&!entry.claimed){this.release(entry);throw aborted();}
      return session;
    });
    void entry.promise.catch(()=>{if(this.entry===entry){clearTimeout(entry.timer);this.entry=null;}});
    entry.timer=setTimeout(()=>{if(this.entry===entry)this.clear();},30000);entry.timer.unref?.();
  }
  claim(target:PlaybackTarget){
    const entry=this.entry;if(!entry||entry.cancelled||!same(entry.target,target))return null;
    this.entry=null;entry.claimed=true;clearTimeout(entry.timer);return entry.promise;
  }
  clear(){const entry=this.entry;this.entry=null;if(entry)this.release(entry);}
}
const instances=new WeakMap<NativeBridge,MediaPreload>();
export function mediaPreload(bridge:NativeBridge){let value=instances.get(bridge);if(!value){value=new MediaPreload(bridge);instances.set(bridge,value);}return value;}
