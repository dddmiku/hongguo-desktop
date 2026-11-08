import Hls from 'hls.js';
import type { MediaSession, NativeBridge } from '../../shared/contracts';
import type { PlaybackTarget, PreparedDeck } from './SeamlessSwitcher';
import {episodeDuration} from './timeline';
import {hardwareHevc} from './capabilities';
import {mediaPreload} from './MediaPreload';

export interface VideoDeck extends PreparedDeck { video: HTMLVideoElement; hls: Hls | null; sessionId: string; duration: number; sealed: boolean; }
const aborted = () => new DOMException('Cancelled', 'AbortError');
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(aborted()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
});

/** A detached decoder slot. No account writes and no audible background playback. */
export class HlsDeckLoader {
  private decks = new Map<number, VideoDeck>();
  constructor(private videos: HTMLVideoElement[], private bridge: NativeBridge,
              private onFatal: (deck: VideoDeck, message: string) => void,
              private onPreparing:(target:PlaybackTarget,message:string)=>void=()=>{}) {}
  async prepare(index: number, target: PlaybackTarget, signal: AbortSignal): Promise<VideoDeck> {
    if (signal.aborted) throw aborted();
    const video = this.videos[index];
    const previous = this.decks.get(index); if (previous) await previous.release();
    let sessionId = '', engine: Hls | null = null, released = false, settled = false,leaseTimer:ReturnType<typeof setInterval>|undefined;
    video.pause(); video.muted = true; video.volume = 0; video.style.visibility = 'visible';
    const deck: VideoDeck = { index, target, video, hls: null, sessionId: '', duration:episodeDuration(0,target.duration),sealed:false,release: () => {
      if (released) return; released = true; clearInterval(leaseTimer);engine?.destroy();
      if (this.decks.get(index) === deck) { this.decks.delete(index); video.pause(); video.removeAttribute('src'); video.load(); }
      if (sessionId) void this.bridge.request(`/media/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    } };
    this.decks.set(index, deck);
    const abort = () => { void deck.release(); }; signal.addEventListener('abort', abort, { once: true });
    try {
      this.onPreparing(target,'正在连接片源');
      const acceptHevc = !target.compatible && await hardwareHevc();
      if (signal.aborted || released) throw aborted();
      let session = await (mediaPreload(this.bridge).claim(target)??this.bridge.request<MediaSession>('/media/session', { method: 'POST', body: { seriesId: target.seriesId, episode: target.episode, quality: target.quality, start: target.start, ...(acceptHevc ? {acceptHevc:true} : {}) } }));
      sessionId = session.id; deck.sessionId = session.id;
      if (signal.aborted || released) { void this.bridge.request(`/media/session/${sessionId}`, { method: 'DELETE' }).catch(() => {}); throw aborted(); }
      leaseTimer=setInterval(()=>{if(!released)void this.bridge.request(`/media/session/${sessionId}`).catch(()=>{});},60000);
      const deadline = Date.now() + 120000;
      while (session.phase === 'preparing') {
        if (signal.aborted) throw aborted(); if (Date.now() > deadline) throw new Error('准备时间较长，请重试当前集');
        await wait(150, signal); session = await this.bridge.request<MediaSession>(`/media/session/${sessionId}`);
      }
      if (signal.aborted) throw aborted();
      if (session.phase === 'error' || session.phase === 'cancelled') throw new Error(session.error || '视频准备失败');
      deck.duration=episodeDuration(session.duration,target.duration);
      this.onPreparing(target,'正在打开画面');
      await new Promise<void>((resolve, reject) => {
        let priming = false, frameId = 0,lastBufferedFragment=-1,endSignalled=false;
        const finishStream=()=>{
          const details=engine?.levels[engine.currentLevel]?.details;
          if(!engine||endSignalled||details?.live!==false||details.fragments.at(-1)?.sn!==lastBufferedFragment)return;
          // Audio/video tail lengths can differ; a fully appended final VOD fragment still seals both buffers.
          endSignalled=true;deck.sealed=true;engine.trigger(Hls.Events.BUFFER_EOS,{type:null});
        };
        const timeout = setTimeout(() => finish(new Error('视频解码超时，请重试')), 120000);
        const cleanup = () => {
          clearTimeout(timeout); signal.removeEventListener('abort', stop);
          for (const name of ['loadeddata', 'loadedmetadata', 'durationchange', 'canplay', 'seeked']) video.removeEventListener(name, ready);
          if (frameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameId);
        };
        const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); video.pause(); error ? reject(error) : resolve(); };
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
          if (video.requestVideoFrameCallback) frameId = video.requestVideoFrameCallback(() => finish());
          else requestAnimationFrame(() => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish(); else priming = false; });
          void video.play().catch(() => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish(); else priming = false; });
        };
        for (const name of ['loadeddata', 'loadedmetadata', 'durationchange', 'canplay', 'seeked']) video.addEventListener(name, ready);
        if (Hls.isSupported()) {
          engine = new Hls({ enableWorker: true, maxBufferLength: 6, maxMaxBufferLength: 12, maxBufferSize: 8*1024*1024, backBufferLength: 3,
            startPosition:0,lowLatencyMode:false,liveSyncDuration:86400,liveMaxLatencyDuration:Infinity,maxLiveSyncPlaybackRate:1,
            manifestLoadingMaxRetry: 8, fragLoadingMaxRetry: 8, manifestLoadingRetryDelay: 800, fragLoadingRetryDelay: 800 });
          deck.hls = engine;
          engine.on(Hls.Events.MANIFEST_PARSED, ready); engine.on(Hls.Events.LEVEL_UPDATED,()=>{ready();finishStream();});
          engine.on(Hls.Events.FRAG_BUFFERED,(_event,data)=>{if(data.frag.type==='main'){lastBufferedFragment=typeof data.frag.sn==='number'?data.frag.sn:-1;finishStream();}});
          engine.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || released || signal.aborted) return;
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
      deck.hls?.stopLoad();
      signal.removeEventListener('abort', abort);
      return deck;
    } catch (error) {
      signal.removeEventListener('abort', abort); void deck.release();
      if (target.compatible && !signal.aborted && (error as Error).message === '显卡解码暂不可用，正在切换兼容播放') return this.prepare(index,target,signal);
      throw error;
    }
  }
}
