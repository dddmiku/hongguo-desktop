import Hls from 'hls.js';
import type { MediaSession, NativeBridge } from '../../shared/contracts';
import type { PlaybackTarget, PreparedDeck } from './SeamlessSwitcher';
import {episodeDuration} from './timeline';
import {hardwareHevc} from './capabilities';
import {mediaPreload} from './MediaPreload';
import {MediaSessionLease,MediaSessionRecoveryError,MediaSessionTaskError} from './MediaSessionLease';
import {PlaybackCheckpoint} from './PlaybackCheckpoint';
import {playbackBufferConfig} from './BufferBudget';
import {PlaybackRecovery} from './PlaybackRecovery';

export interface VideoDeck extends PreparedDeck { video: HTMLVideoElement; hls: Hls | null; sessionId: string; duration: number; sealed: boolean; suspendPlayback:()=>void; resumePlayback:(position:number)=>void; }
const aborted = () => new DOMException('Cancelled', 'AbortError');
// Buffered HEVC with no compositor frame is a decode stall; try H.264 before the general timeout.
const HEVC_FRAME_TIMEOUT_MS = 12000;
const HEVC_FRAME_TIMEOUT_CODE = 'hevc-first-frame-timeout';

/** A detached decoder slot. No account writes and no audible background playback. */
export class HlsDeckLoader {
  private decks = new Map<number, VideoDeck>();
  constructor(private videos: HTMLVideoElement[], private bridge: NativeBridge,
              private onFatal: (deck: VideoDeck, message: string) => void,
              private onPreparing:(target:PlaybackTarget,message:string)=>void=()=>{},
              private playbackIntent:(deck:VideoDeck)=>boolean|undefined=()=>undefined,
              private playbackRate:()=>number=()=>1) {}
  async prepare(index: number, target: PlaybackTarget, signal: AbortSignal, prewarm=false): Promise<VideoDeck> {
    if (signal.aborted) throw aborted();
    const video = this.videos[index];
    const previous = this.decks.get(index); if (previous) await previous.release();
    let sessionId = '', engine: Hls | null = null, released = false, settled = false,acceptHevc=false,usingHevc=false,leaseTimer:ReturnType<typeof setInterval>|undefined,recoveryTimer:ReturnType<typeof setInterval>|undefined;
    let lease:MediaSessionLease|null=null,reconnectPlayback:(session:MediaSession,position:number)=>void=()=>{},applyReplacement:(session:MediaSession,position:number)=>void=()=>{},requestReconnect:(position:number)=>void=()=>{};
    let restoreListener:(()=>void)|undefined,reconnecting=false,reconnectPosition=0,reconnectHealthySince:number|null=null;
    const recovery=new PlaybackRecovery();
    const checkpoint=new PlaybackCheckpoint(video,target.start);
    const suspendPlayback=()=>{recovery.reset();engine?.stopLoad();video.pause();};
    const resumePlayback=(position:number)=>{
      if(released||!Number.isFinite(position))return;
      recovery.reset();recovery.rebase(performance.now(),Math.max(0,position));
      engine?.startLoad(Math.max(0,position));
    };
    const rememberPosition=()=>checkpoint.capture();
    const positionEvents=['timeupdate','seeking','seeked','playing','pause'];
    for(const event of positionEvents)video.addEventListener(event,rememberPosition);
    video.pause(); video.muted = true; video.volume = 0; video.style.visibility = 'visible';
    const deck: VideoDeck = { index, target, video, hls: null, sessionId: '', duration:episodeDuration(0,target.duration),sealed:false,suspendPlayback,resumePlayback,release: () => {
      if (released) return; released = true; clearInterval(leaseTimer);clearInterval(recoveryTimer);engine?.destroy();
      if(restoreListener)video.removeEventListener('canplay',restoreListener);
      for(const event of positionEvents)video.removeEventListener(event,rememberPosition);
      if (this.decks.get(index) === deck) { this.decks.delete(index); video.pause(); video.removeAttribute('src'); video.load(); }
      lease?.release();
    } };
    this.decks.set(index, deck);
    const fatalLease=(message:string)=>{clearInterval(leaseTimer);leaseTimer=undefined;clearInterval(recoveryTimer);recoveryTimer=undefined;if(!released)this.onFatal(deck,message);};
    const abort = () => { void deck.release(); }; signal.addEventListener('abort', abort, { once: true });
    try {
      this.onPreparing(target,'正在连接片源');
      acceptHevc = !target.compatible && await hardwareHevc();
      if (signal.aborted || released) throw aborted();
      lease=new MediaSessionLease(this.bridge,{seriesId:target.seriesId,episode:target.episode,quality:target.quality,start:target.start,...(acceptHevc?{acceptHevc:true}:{})},signal);
      const session=await lease.open(mediaPreload(this.bridge).claim(target)??undefined);
      usingHevc=acceptHevc&&session.videoCodec?.toLowerCase()==='hevc';
      sessionId = session.id; deck.sessionId = session.id;
      if (signal.aborted || released) throw aborted();
      leaseTimer=setInterval(()=>{
        if(released||!lease)return;
        const position=checkpoint.read();
        void lease.read(position).then(current=>{
          if(!released)applyReplacement(current,position);
        }).catch(error=>{
          if(released||!(error instanceof Error))return;
          if(error instanceof MediaSessionTaskError||error instanceof MediaSessionRecoveryError||error.message==='播放连接已失效，请重试当前集')fatalLease(error.message);
        });
      },60000);
      if (signal.aborted) throw aborted();
      if (session.phase === 'error' || session.phase === 'cancelled') throw new Error(session.error || '视频准备失败');
      deck.duration=episodeDuration(session.duration,target.duration);
      this.onPreparing(target,'正在打开画面');
      await new Promise<void>((resolve, reject) => {
        let priming = false, frameDecoded=false, frameId = 0,lastBufferedFragment=-1,endSignalled=false,mainFragmentBuffered=false;
        let hevcFrameTimeout:ReturnType<typeof setTimeout>|undefined;
        const restorePosition=(position:number)=>{
          const resume=this.playbackIntent(deck)??!video.paused;
          if(restoreListener)video.removeEventListener('canplay',restoreListener);
          restoreListener=()=>{
            restoreListener=undefined;
            if(released||signal.aborted)return;
            if(Number.isFinite(video.duration)&&video.duration>=position&&Math.abs(video.currentTime-position)>.1)video.currentTime=position;
            if(this.playbackIntent(deck)??resume)void video.play().catch(()=>{});else video.pause();
          };
          video.addEventListener('canplay',restoreListener,{once:true});
        };
        reconnectPlayback=(replacement,position)=>{
          if(released||signal.aborted)return;
          restorePosition(position);
          usingHevc=acceptHevc&&replacement.videoCodec?.toLowerCase()==='hevc';
          lastBufferedFragment=-1;endSignalled=false;deck.sealed=false;
          if(engine){engine.config.startPosition=position;engine.loadSource(replacement.url);engine.startLoad(position);}
          else video.src=replacement.url;
        };
        applyReplacement=(replacement,position)=>{
          if(released||signal.aborted||replacement.id===deck.sessionId)return;
          sessionId=replacement.id;deck.sessionId=replacement.id;
          reconnecting=true;reconnectPosition=position;reconnectHealthySince=null;
          recovery.rebase(performance.now(),position);
          reconnectPlayback(replacement,position);
        };
        requestReconnect=(position)=>{
          if(released||signal.aborted||reconnecting||!lease)return;
          reconnecting=true;reconnectPosition=position;reconnectHealthySince=null;
          recovery.rebase(performance.now(),position);
          this.onPreparing(target,'播放连接暂时中断，正在重新连接');
          void lease.reconnect(position).then(replacement=>{
            if(released||signal.aborted)return;
            if(replacement.id===deck.sessionId){reconnecting=false;return;}
            applyReplacement(replacement,position);
          }).catch(error=>{
            reconnecting=false;
            if(released||signal.aborted)return;
            const message=error instanceof Error?error.message:'播放连接暂时不可用，请重试当前集';
            if(!settled)finish(new Error(message));else fatalLease(message);
          });
        };
        const finishStream=()=>{
          const details=engine?.levels[engine.currentLevel]?.details;
          if(!engine||endSignalled||details?.live!==false||details.fragments.at(-1)?.sn!==lastBufferedFragment)return;
          // Audio/video tail lengths can differ; a fully appended final VOD fragment still seals both buffers.
          endSignalled=true;deck.sealed=true;engine.trigger(Hls.Events.BUFFER_EOS,{type:null});
        };
        const timeout = setTimeout(() => finish(new Error('视频解码超时，请重试')), 120000);
        const cleanup = () => {
          clearTimeout(timeout); signal.removeEventListener('abort', stop);
          if(hevcFrameTimeout)clearTimeout(hevcFrameTimeout);
          for (const name of ['loadeddata', 'loadedmetadata', 'durationchange', 'canplay', 'seeked']) video.removeEventListener(name, ready);
          if (frameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameId);
        };
        const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); video.pause(); error ? reject(error) : resolve(); };
        const prewarmBufferSeconds=prewarm?Math.max(4,this.playbackRate()*3):0;
        const hasPrewarmBuffer=()=>{
          if(!prewarm)return true;
          const position=Math.max(0,video.currentTime);
          for(let i=0;i<video.buffered.length;i++){
            const end=video.buffered.end(i);
            // A sealed short episode cannot reach the normal lead, but its entire remaining range is sufficient.
            const fullTail=deck.sealed&&Number.isFinite(video.duration)&&video.duration>position&&end>=video.duration-.05;
            if(video.buffered.start(i)<=position+.05&&(end-position>=prewarmBufferSeconds||fullTail))return true;
          }
          return false;
        };
        const finishWhenReady=()=>{if(frameDecoded&&hasPrewarmBuffer())finish();};
        const watchHevcFrame=()=>{
          if(!usingHevc||!mainFragmentBuffered||settled||hevcFrameTimeout)return;
          hevcFrameTimeout=setTimeout(()=>finish(Object.assign(new Error('视频解码超时，请重试'),{code:HEVC_FRAME_TIMEOUT_CODE})),HEVC_FRAME_TIMEOUT_MS);
        };
        const stop = () => finish(aborted());
        signal.addEventListener('abort', stop, { once: true });
        const ready = () => {
          const complete=engine?.levels[engine.currentLevel]?.details?.live===false;
          deck.duration=episodeDuration(deck.duration,target.duration,video.duration,complete);
          if (settled || priming || signal.aborted || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
          if (target.start > .1) {
            const complete = engine?.levels[engine.currentLevel]?.details?.live === false;
            if (!Number.isFinite(video.duration) || !complete && video.duration < target.start + .1) return;
            const start = Math.min(target.start, Math.max(0, video.duration - .2));
            if (Math.abs(video.currentTime - start) > .1) { video.currentTime = start; return; }
          }
          priming = true;
          if (video.requestVideoFrameCallback) frameId = video.requestVideoFrameCallback(() => {frameDecoded=true;video.pause();finishWhenReady();});
          else requestAnimationFrame(() => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {frameDecoded=true;video.pause();finishWhenReady();} else priming = false; });
          void video.play().catch(() => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {frameDecoded=true;video.pause();finishWhenReady();} else priming = false; });
        };
        for (const name of ['loadeddata', 'loadedmetadata', 'durationchange', 'canplay', 'seeked']) video.addEventListener(name, ready);
        if (Hls.isSupported()) {
          engine = new Hls({ enableWorker: true, ...playbackBufferConfig(this.playbackRate(),true),
            startPosition:0,lowLatencyMode:false,liveSyncDuration:86400,liveMaxLatencyDuration:Infinity,maxLiveSyncPlaybackRate:1,
            manifestLoadingMaxRetry: 8, fragLoadingMaxRetry: 8, manifestLoadingRetryDelay: 800, fragLoadingRetryDelay: 800 });
          deck.hls = engine;
          engine.on(Hls.Events.MANIFEST_PARSED, ready); engine.on(Hls.Events.LEVEL_UPDATED,()=>{ready();finishStream();finishWhenReady();});
          engine.on(Hls.Events.FRAG_BUFFERED,(_event,data)=>{if(data.frag.type==='main'){mainFragmentBuffered=true;lastBufferedFragment=typeof data.frag.sn==='number'?data.frag.sn:-1;watchHevcFrame();finishStream();finishWhenReady();}});
          engine.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || released || signal.aborted) return;
            if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&lease){
              const position=checkpoint.read();
              requestReconnect(position);return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && acceptHevc) {
              target.compatible = true;
              if (!settled) finish(new Error('显卡解码暂不可用，正在切换兼容播放'));
              else this.onFatal(deck, '显卡解码暂不可用，正在切换兼容播放');
            }
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) engine?.recoverMediaError();
            else if (!settled) finish(new Error('网络或片源中断，请重试'));
            else this.onFatal(deck, '网络或片源中断，重试可从当前进度继续');
          });
          engine.attachMedia(video); engine.loadSource(session.url);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = session.url;
        else finish(new Error('当前设备不支持视频播放'));
      });
      if (signal.aborted) throw aborted();
      recoveryTimer=setInterval(()=>{
        if(released||signal.aborted)return;
        const enabled=this.playbackIntent(deck)===true;
        const position=checkpoint.read();
        let bufferedAhead=0;
        for(let i=0;i<video.buffered.length;i++){
          if(video.buffered.start(i)<=position+.05&&video.buffered.end(i)>position){bufferedAhead=video.buffered.end(i)-position;break;}
        }
        // The sealed final samples belong to PlaybackEnd's short completion check.
        const atTail=deck.sealed&&Number.isFinite(video.duration)&&video.duration-position<=.35;
        const action=recovery.inspect({time:position,now:performance.now(),enabled:enabled&&(!atTail||video.paused),paused:video.paused,ended:video.ended,seeking:video.seeking,bufferedAhead});
        if(action==='failed'){this.onFatal(deck,'播放停滞，自动恢复未成功，请重试当前集');return;}
        if(reconnecting){
          if(action==='resume')void video.play().catch(()=>{});
          if(!video.paused&&position>=reconnectPosition+.5){
            reconnectHealthySince??=performance.now();
            if(performance.now()-reconnectHealthySince>=1000)reconnecting=false;
          }else reconnectHealthySince=null;
          return;
        }
        if(!action)return;
        if(action==='resume'){void video.play().catch(()=>{});return;}
        this.onPreparing(target,'播放暂时中断，正在恢复');
        if(action==='recover'){
          if(usingHevc&&bufferedAhead>.5){target.compatible=true;this.onFatal(deck,'显卡解码暂不可用，正在切换兼容播放');return;}
          if(engine){
            if(bufferedAhead>.5){
              if(restoreListener)video.removeEventListener('canplay',restoreListener);
              restoreListener=()=>{restoreListener=undefined;if(!released&&!signal.aborted&&(this.playbackIntent(deck)??false))void video.play().catch(()=>{});};
              video.addEventListener('canplay',restoreListener,{once:true});
              engine.recoverMediaError();
            }else engine.startLoad(position);
          }
          if(!video.error)void video.play().catch(()=>{});
          return;
        }
        if(action==='reconnect'&&lease){
          requestReconnect(position);
        }
      },250);
      signal.removeEventListener('abort', abort);
      return deck;
    } catch (error) {
      signal.removeEventListener('abort', abort); void deck.release();
      const hevcFrameStalled=usingHevc&&error instanceof Error&&(error as Error&{code?:string}).code===HEVC_FRAME_TIMEOUT_CODE;
      if(hevcFrameStalled&&!signal.aborted)target.compatible=true;
      if (!signal.aborted && (hevcFrameStalled || target.compatible && (error as Error).message === '显卡解码暂不可用，正在切换兼容播放')) return this.prepare(index,target,signal,prewarm);
      if(error instanceof Error&&error.name!=='AbortError'){
        const readable=error.message.replace(/^Error invoking remote method (?:'[^'\r\n]+'|"[^"\r\n]+"): (?:Error: )?/, '');
        if(readable!==error.message)throw new Error(readable);
      }
      throw error;
    }
  }
}
