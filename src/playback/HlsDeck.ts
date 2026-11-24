import Hls from 'hls.js';
import type { MediaSession, NativeBridge } from '../../shared/contracts';
import type { PlaybackTarget, PreparedDeck } from './SeamlessSwitcher';
import {episodeDuration} from './timeline';
import {hardwareHevc} from './capabilities';
import {mediaPreload} from './MediaPreload';
import {MediaSessionLease,MediaSessionRecoveryError,MediaSessionTaskError,MediaSessionNeedsRecoveryError} from './MediaSessionLease';
import {PlaybackCheckpoint} from './PlaybackCheckpoint';
import {playbackBufferConfig} from './BufferBudget';
import {PlaybackRecovery} from './PlaybackRecovery';
import {MediaReconnectCoordinator} from './MediaReconnectCoordinator';
import {PlaybackTrace} from './PlaybackTrace';
import {isRetryableMediaRequestError} from '../../shared/media-request';
import type {PlaybackTraceAction,PlaybackTraceReason} from '../../shared/playback-diagnostics';

export interface VideoDeck extends PreparedDeck { video: HTMLVideoElement; hls: Hls | null; sessionId: string; duration: number; sealed: boolean; suspendPlayback:()=>void; resumePlayback:(position:number)=>void; }
const aborted = () => new DOMException('Cancelled', 'AbortError');
// Buffered HEVC with no compositor frame is a decode stall; try H.264 before the general timeout.
const HEVC_FRAME_TIMEOUT_MS = 12000;
const HEVC_FRAME_TIMEOUT_CODE = 'hevc-first-frame-timeout';

/** A detached decoder slot. No account writes and no audible background playback. */
export class HlsDeckLoader {
  private decks = new Map<number, VideoDeck>();
  private generation=0;
  constructor(private videos: HTMLVideoElement[], private bridge: NativeBridge,
              private onFatal: (deck: VideoDeck, message: string) => void,
              private onPreparing:(target:PlaybackTarget,message:string)=>void=()=>{},
              private playbackIntent:(deck:VideoDeck)=>boolean|undefined=()=>undefined,
              private playbackRate:()=>number=()=>1,private trace?:PlaybackTrace) {}
  async prepare(index: number, target: PlaybackTarget, signal: AbortSignal, prewarm=false): Promise<VideoDeck> {
    if (signal.aborted) throw aborted();
    const video = this.videos[index];
    const jobGeneration=++this.generation;let leaseGeneration=0,lastFlushed=0;
    const record=(action:PlaybackTraceAction,reason:PlaybackTraceReason='none')=>this.trace?.record({
      stage:'deck',action,reason,deckSlot:index,episode:target.episode,jobGeneration,leaseGeneration,prewarm,
      currentTime:video.currentTime,duration:video.duration,paused:video.paused,ended:video.ended,readyState:video.readyState,playbackRate:video.playbackRate,
    });
    record('prepare','initial');
    const previous = this.decks.get(index); if (previous) await previous.release();
    let sessionId = '', engine: Hls | null = null, released = false, settled = false,acceptHevc=false,usingHevc=false,leaseTimer:ReturnType<typeof setInterval>|undefined,recoveryTimer:ReturnType<typeof setInterval>|undefined;
    let lease:MediaSessionLease|null=null,reconnectPlayback:(session:MediaSession,position:number)=>void=()=>{},applyReplacement:(session:MediaSession,position:number)=>void=()=>{},requestReconnect:(position:number)=>void=()=>{};
    let restoreListener:(()=>void)|undefined,reconnecting=false,reconnectPosition=0,reconnectHealthySince:number|null=null;
    const recovery=new PlaybackRecovery();
    let recoveryCoordinator:MediaReconnectCoordinator<MediaSession>;
    let healthFrame=0,healthyFrameSince:number|null=null,healthyFrameStart=0,lastDecodedTime:number|null=null,lastDecodedAt:number|null=null;
    const resetDecodedHealth=()=>{
      if(healthFrame&&video.cancelVideoFrameCallback)video.cancelVideoFrameCallback(healthFrame);
      healthFrame=0;healthyFrameSince=null;lastDecodedTime=null;lastDecodedAt=null;
    };
    const checkpoint=new PlaybackCheckpoint(video,target.start);
    const suspendPlayback=()=>{record('suspend','window-hidden');recovery.reset();engine?.stopLoad();video.pause();};
    const resumePlayback=(position:number)=>{
      if(released||!Number.isFinite(position))return;
      record('resume','window-restored');
      recovery.reset();recovery.rebase(performance.now(),Math.max(0,position));
      engine?.startLoad(Math.max(0,position));
    };
    const rememberPosition=()=>{checkpoint.capture();recoveryCoordinator?.observeIntent();};
    const positionEvents=['timeupdate','seeking','seeked','playing','pause'];
    for(const event of positionEvents)video.addEventListener(event,rememberPosition);
    video.pause(); video.muted = true; video.volume = 0; video.style.visibility = 'visible';
    const deck: VideoDeck = { index, target, video, hls: null, sessionId: '', duration:episodeDuration(0,target.duration),sealed:false,suspendPlayback,resumePlayback,release: () => {
      if (released) return; released = true; clearInterval(leaseTimer);clearInterval(recoveryTimer);engine?.destroy();
      record('release','released');
      resetDecodedHealth();
      if(restoreListener)video.removeEventListener('canplay',restoreListener);
      for(const event of positionEvents)video.removeEventListener(event,rememberPosition);
      if (this.decks.get(index) === deck) { this.decks.delete(index); video.pause(); video.removeAttribute('src'); video.load(); }
      lease?.release();
    } };
    this.decks.set(index, deck);
    recoveryCoordinator=new MediaReconnectCoordinator(signal,
      ()=>!released&&(typeof navigator==='undefined'||navigator.onLine!==false)&&(!settled||this.playbackIntent(deck)!==false),
      (attempt)=>{this.trace?.record({stage:'recovery',action:'retry',reason:'network-failed',deckSlot:index,episode:target.episode,jobGeneration,leaseGeneration,attempt});this.onPreparing(target,'播放连接暂时中断，等待网络恢复后自动重连');},undefined,60000,()=>lease?.cancelReconnect());
    const notifyFatal=(message:string,reason:PlaybackTraceReason='terminal')=>{record('fatal',reason);if(!released)this.onFatal(deck,message);};
    const fatalLease=(message:string)=>{clearInterval(leaseTimer);leaseTimer=undefined;clearInterval(recoveryTimer);recoveryTimer=undefined;notifyFatal(message);};
    const abort = () => { void deck.release(); }; signal.addEventListener('abort', abort, { once: true });
    try {
      this.onPreparing(target,'正在连接片源');
      acceptHevc = !target.compatible && await hardwareHevc();
      if (signal.aborted || released) throw aborted();
      lease=new MediaSessionLease(this.bridge,{seriesId:target.seriesId,episode:target.episode,quality:target.quality,start:target.start,...(acceptHevc?{acceptHevc:true}:{})},signal);
      let session:MediaSession;
      try{session=await lease.open(mediaPreload(this.bridge).claim(target)??undefined);}
      catch(error){
        if(signal.aborted||released)throw aborted();
        if(!(error instanceof MediaSessionRecoveryError)&&!isRetryableMediaRequestError(error))throw error;
        this.onPreparing(target,'正在等待片源连接恢复，稍后自动重试');
        // Startup shares the existing cancellable, foreground-bounded recovery policy.
        session=await recoveryCoordinator.run(()=>lease!.reconnect(target.start));
      }
      usingHevc=acceptHevc&&session.videoCodec?.toLowerCase()==='hevc';
      sessionId = session.id; deck.sessionId = session.id;
      leaseGeneration++;record('ready');
      if (signal.aborted || released) throw aborted();
      leaseTimer=setInterval(()=>{
        if(released||!lease)return;
        const position=checkpoint.read();
        void lease.read(position).then(current=>{
          if(!released)applyReplacement(current,position);
        }).catch(error=>{
          if(released||!(error instanceof Error))return;
          if(error instanceof MediaSessionRecoveryError||error instanceof MediaSessionNeedsRecoveryError)requestReconnect(position);
          else if(error instanceof MediaSessionTaskError||error.message==='播放连接已失效，请重试当前集')fatalLease(error.message);
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
            const rate=this.playbackRate();
            if(Number.isFinite(rate)&&rate>0){video.defaultPlaybackRate=rate;video.playbackRate=rate;}
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
          leaseGeneration++;record('replace','session-replaced');
          resetDecodedHealth();
          reconnecting=true;reconnectPosition=position;reconnectHealthySince=null;
          recovery.reset();
          recovery.rebase(performance.now(),position);
          reconnectPlayback(replacement,position);
        };
        requestReconnect=(position)=>{
          if(released||signal.aborted||recoveryCoordinator.recovering||!lease)return;
          reconnecting=true;reconnectPosition=position;reconnectHealthySince=null;
          recovery.rebase(performance.now(),position);
          this.onPreparing(target,'播放连接暂时中断，正在重新连接');
          record('reconnect','network-failed');
          void recoveryCoordinator.run(()=>lease!.reconnect(checkpoint.read())).then(replacement=>{
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
          record('seal');
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
            if(released||signal.aborted)return;
            this.trace?.record({stage:'hls',action:'error',reason:data.type===Hls.ErrorTypes.NETWORK_ERROR?'http-error':'decode-error',
              deckSlot:index,episode:target.episode,jobGeneration,leaseGeneration,httpStatus:data.response?.code,
              currentTime:video.currentTime,duration:video.duration,sealed:deck.sealed,readyState:video.readyState});
            if (!data.fatal) return;
            if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&lease){
              const position=checkpoint.read();
              requestReconnect(position);return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && acceptHevc) {
              target.compatible = true;
              if (!settled) finish(new Error('显卡解码暂不可用，正在切换兼容播放'));
              else notifyFatal('显卡解码暂不可用，正在切换兼容播放','decode-error');
            }
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) engine?.recoverMediaError();
            else if (!settled) finish(new Error('网络或片源中断，请重试'));
            else notifyFatal('网络或片源中断，重试可从当前进度继续','network-failed');
          });
          engine.attachMedia(video); engine.loadSource(session.url);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = session.url;
        else finish(new Error('当前设备不支持视频播放'));
      });
      if (signal.aborted) throw aborted();
      recoveryTimer=setInterval(()=>{
        if(released||signal.aborted)return;
        const enabled=this.playbackIntent(deck)===true;
        if(enabled&&!healthFrame&&video.requestVideoFrameCallback){
          const observedSession=deck.sessionId;
          healthFrame=video.requestVideoFrameCallback((_now,metadata)=>{
            healthFrame=0;
            if(released||observedSession!==deck.sessionId||!this.playbackIntent(deck)||recoveryCoordinator.recovering)return;
            const time=metadata?.mediaTime??video.currentTime,now=performance.now();
            lastDecodedAt=now;
            if(lastDecodedTime!==null&&time>lastDecodedTime+.000001){
              if(healthyFrameSince===null){healthyFrameSince=now;healthyFrameStart=time;}
              if(now-healthyFrameSince>=1000&&time-healthyFrameStart>=.5)recoveryCoordinator.markHealthy();
            }else healthyFrameSince=null;
            lastDecodedTime=time;
          });
        }
        const position=checkpoint.read();
        let bufferedAhead=0;
        for(let i=0;i<video.buffered.length;i++){
          if(video.buffered.start(i)<=position+.05&&video.buffered.end(i)>position){bufferedAhead=video.buffered.end(i)-position;break;}
        }
        // The sealed final samples belong to PlaybackEnd's short completion check.
        this.trace?.sample({stage:'decoder',action:'sample',deckSlot:index,episode:target.episode,jobGeneration,leaseGeneration,
          currentTime:position,duration:video.duration,bufferedAhead,readyState:video.readyState,paused:video.paused,ended:video.ended,
          seeking:video.seeking,sealed:deck.sealed,active:enabled,playbackRate:video.playbackRate,sourceDuration:deck.duration,
          bufferedEnd:video.buffered.length?video.buffered.end(video.buffered.length-1):0,decodedTime:lastDecodedTime??undefined,
          decodedFrameAgeMs:lastDecodedAt===null?undefined:performance.now()-lastDecodedAt,volume:video.volume,muted:video.muted,
          transportPending:recoveryCoordinator.recovering,reconnecting});
        if(this.trace&&performance.now()-lastFlushed>=15000){
          lastFlushed=performance.now();
          try{void this.bridge.recordPlaybackDiagnostics?.(this.trace.snapshot()).catch(()=>{});}catch{}
        }
        const atTail=deck.sealed&&Number.isFinite(video.duration)&&video.duration-position<=.35;
        // Transport/preparation recovery has its own bounded budget. The 18s decoder
        // watchdog must not terminate an in-flight source preparation or its backoff.
        if(recoveryCoordinator.recovering)return;
        const action=recovery.inspect({time:position,now:performance.now(),enabled:enabled&&(!atTail||video.paused),paused:video.paused,ended:video.ended,seeking:video.seeking,bufferedAhead});
        if(action==='failed'){notifyFatal('播放停滞，自动恢复未成功，请重试当前集','no-progress');return;}
        if(reconnecting){
          if(action==='resume')void video.play().catch(()=>{});
          if(!video.paused&&position>=reconnectPosition+.5){
            reconnectHealthySince??=performance.now();
            if(performance.now()-reconnectHealthySince>=1000)reconnecting=false;
          }else reconnectHealthySince=null;
          if(action==='reconnect'&&bufferedAhead<=.5)requestReconnect(position);
          return;
        }
        if(!action)return;
        if(action==='resume'){void video.play().catch(()=>{});return;}
        this.onPreparing(target,'播放暂时中断，正在恢复');
        if(action==='recover'){
          if(usingHevc&&bufferedAhead>.5){target.compatible=true;notifyFatal('显卡解码暂不可用，正在切换兼容播放','decode-error');return;}
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
      record(error instanceof Error&&error.name==='AbortError'?'cancel':'failed-before-ready',error instanceof Error&&error.name==='AbortError'?'aborted':'source-failed');
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
