import Hls from 'hls.js';
import type { MediaSession, NativeBridge } from '../../shared/contracts';
import type { PlaybackTarget, PreparedDeck } from './SeamlessSwitcher';

export interface VideoDeck extends PreparedDeck { video: HTMLVideoElement; hls: Hls | null; sessionId: string; }
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
              private onFatal: (deck: VideoDeck, message: string) => void) {}
  async prepare(index: number, target: PlaybackTarget, signal: AbortSignal): Promise<VideoDeck> {
    if (signal.aborted) throw aborted();
    const video = this.videos[index];
    const previous = this.decks.get(index); if (previous) await previous.release();
    let sessionId = '', engine: Hls | null = null, released = false, settled = false,leaseTimer:ReturnType<typeof setInterval>|undefined;
    video.pause(); video.muted = true; video.volume = 0; video.style.visibility = 'visible';
    const deck: VideoDeck = { index, target, video, hls: null, sessionId: '', release: () => {
      if (released) return; released = true; clearInterval(leaseTimer);engine?.destroy();
      if (this.decks.get(index) === deck) { this.decks.delete(index); video.pause(); video.removeAttribute('src'); video.load(); }
      if (sessionId) void this.bridge.request(`/media/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    } };
    this.decks.set(index, deck);
    const abort = () => { void deck.release(); }; signal.addEventListener('abort', abort, { once: true });
    try {
      let session = await this.bridge.request<MediaSession>('/media/session', { method: 'POST', body: { seriesId: target.seriesId, episode: target.episode, quality: target.quality, start: target.start } });
      sessionId = session.id; deck.sessionId = session.id;
      leaseTimer=setInterval(()=>{if(!released)void this.bridge.request(`/media/session/${sessionId}`).catch(()=>{});},60000);
      if (signal.aborted) { void this.bridge.request(`/media/session/${sessionId}`, { method: 'DELETE' }).catch(() => {}); throw aborted(); }
      const deadline = Date.now() + 120000;
      while (session.phase === 'preparing') {
        if (signal.aborted) throw aborted(); if (Date.now() > deadline) throw new Error('准备时间较长，请重试当前集');
        await wait(300, signal); session = await this.bridge.request<MediaSession>(`/media/session/${sessionId}`);
      }
      if (signal.aborted) throw aborted();
      if (session.phase === 'error' || session.phase === 'cancelled') throw new Error(session.error || '视频准备失败');
      await new Promise<void>((resolve, reject) => {
        let priming = false, frameId = 0;
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
          engine = new Hls({ enableWorker: true, maxBufferLength: 25, maxMaxBufferLength: 60, backBufferLength: 20,
            manifestLoadingMaxRetry: 8, fragLoadingMaxRetry: 8, manifestLoadingRetryDelay: 800, fragLoadingRetryDelay: 800 });
          deck.hls = engine;
          engine.on(Hls.Events.MANIFEST_PARSED, ready); engine.on(Hls.Events.LEVEL_UPDATED, ready);
          engine.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || released || signal.aborted) return;
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) engine?.recoverMediaError();
            else if (!settled) finish(new Error('网络或片源中断，请重试'));
            else this.onFatal(deck, '网络或片源中断，重试可从当前进度继续');
          });
          engine.attachMedia(video); engine.loadSource(session.url);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = session.url;
        else finish(new Error('当前设备不支持视频播放'));
      });
      if (signal.aborted) throw aborted();
      signal.removeEventListener('abort', abort);
      return deck;
    } catch (error) { signal.removeEventListener('abort', abort); void deck.release(); throw error; }
  }
}
