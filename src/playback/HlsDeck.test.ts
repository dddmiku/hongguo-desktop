import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { MANIFEST_PARSED: 'manifestParsed', LEVEL_UPDATED: 'levelUpdated', FRAG_BUFFERED: 'fragBuffered', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static instances: FakeHls[] = [];
    static isSupported = vi.fn(() => true);
    config: Record<string, unknown> = {};
    levels: unknown[] = [];
    currentLevel = 0;
    private handlers = new Map<string, ((event: string, data?: any) => void)[]>();
    constructor(config: Record<string, unknown> = {}) { this.config = config; FakeHls.instances.push(this); }
    on(event: string, handler: (event: string, data?: any) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); }
    emit(event: string, data?: any) { for (const handler of this.handlers.get(event) ?? []) handler(event, data); }
    attachMedia() {}
    loadSource() {}
    startLoad() {}
    stopLoad = vi.fn();
    destroy() {}
    trigger() {}
  }
  return { default: FakeHls };
});
vi.mock('./capabilities', () => ({ hardwareHevc: vi.fn(async () => false) }));
import Hls from 'hls.js';
import type { MediaSession, NativeBridge } from '../../shared/contracts';
import { hardwareHevc } from './capabilities';
import { HlsDeckLoader } from './HlsDeck';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(hardwareHevc).mockReset().mockResolvedValue(false); (Hls as any).instances = []; });

describe('播放会话异步取消', () => {
  it('取流接口业务失败只交付可读错误，不把内部IPC前缀显示给播放器',async()=>{
    const request=vi.fn(async()=>{throw new Error("Error invoking remote method 'api:request': Error: 当前账号暂时不能播放这集");});
    const video={pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),style:{visibility:''},muted:false,volume:1} as unknown as HTMLVideoElement;
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,vi.fn());
    await expect(loader.prepare(0,{seriesId:'12345678',episode:54,quality:'1080p',start:0,compatible:true},new AbortController().signal))
      .rejects.toThrow(/^当前账号暂时不能播放这集$/);
  });
  it('POST 返回前取消时只删除一次会话，不挂载解码器或遗留续租计时器', async () => {
    vi.useFakeTimers();
    let completePost!: (session: MediaSession) => void;
    const pendingPost = new Promise<MediaSession>(resolve => { completePost = resolve; });
    const request = vi.fn((path: string) => path === '/media/session' ? pendingPost : Promise.resolve({}));
    const video = {
      pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), addEventListener:vi.fn(),removeEventListener:vi.fn(),
      style: { visibility: '' }, muted: false, volume: 1,
    } as unknown as HTMLVideoElement;
    const supported = vi.spyOn(Hls, 'isSupported');
    const fatal = vi.fn();
    const loader = new HlsDeckLoader([video], { request } as unknown as NativeBridge, fatal);
    const abort = new AbortController();
    const timersBefore = vi.getTimerCount();
    const preparing = loader.prepare(0, {
      seriesId: '12345678', episode: 2, quality: '1080p', start: 143.5,
    }, abort.signal);
    const cancelled = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });

    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    abort.abort();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.load).toHaveBeenCalledOnce();
    completePost({ id: 'cancelled-session', phase: 'ready', url: '/media/cancelled.m3u8' });
    await cancelled;

    expect(request.mock.calls).toEqual([
      ['/media/session', { method: 'POST', body: {
        seriesId: '12345678', episode: 2, quality: '1080p', start: 143.5,
      } }],
      ['/media/session/cancelled-session', { method: 'DELETE' }],
    ]);
    expect(supported).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
    await vi.advanceTimersByTimeAsync(180000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('HEVC 已缓冲但没有解出首帧时自动重试兼容片源', async () => {
    vi.useFakeTimers();
    vi.mocked(hardwareHevc).mockResolvedValue(true);
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    let frameRequests = 0;
    const video = {
      readyState: 2, videoWidth: 1920, duration: 36, currentTime: 0, paused: true, ended: false,
      buffered: { length: 0 }, style: { visibility: '' }, muted: false, volume: 1,
      pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(),
      addEventListener: vi.fn((name: string, callback: (...args: any[]) => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); }),
      removeEventListener: vi.fn((name: string, callback: (...args: any[]) => void) => listeners.get(name)?.delete(callback)),
      play: vi.fn(async () => {}),
      requestVideoFrameCallback: vi.fn((callback: (...args: any[]) => void) => { frameRequests++; if (frameRequests > 1) queueMicrotask(() => callback()); return frameRequests; }),
      cancelVideoFrameCallback: vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 });
    const request = vi.fn(async (path: string, options?: { method?: string; body?: { acceptHevc?: boolean } }) => {
      if (path === '/media/session' && options?.method === 'POST') {
        const id = `session-${request.mock.calls.filter(([route, opts]) => route === '/media/session' && opts?.method === 'POST').length}`;
        return { id, phase: 'complete', url: '/media/' + id + '.m3u8', duration: 36, videoCodec: options.body?.acceptHevc ? 'hevc' : 'h264' };
      }
      return {};
    });
    const abort = new AbortController();
    const loader = new HlsDeckLoader([video], { request } as unknown as NativeBridge, vi.fn());
    const preparing = loader.prepare(0, { seriesId: '12345678', episode: 114, quality: '1080p', start: 0 }, abort.signal);
    const settled = preparing.then(deck => { deck.release(); return 'resolved'; }, () => 'rejected');
    try {
      await vi.waitFor(() => expect((Hls as any).instances).toHaveLength(1));
      (Hls as any).instances[0].emit((Hls as any).Events.MANIFEST_PARSED);
      (Hls as any).instances[0].emit((Hls as any).Events.FRAG_BUFFERED, { frag: { type: 'main', sn: 0 } });
      await vi.advanceTimersByTimeAsync(12000);
      await vi.waitFor(() => expect((Hls as any).instances).toHaveLength(2));
      (Hls as any).instances[1].emit((Hls as any).Events.MANIFEST_PARSED);
      const deck = await preparing;
      expect(deck.target.compatible).toBe(true);
      expect(request.mock.calls.filter(([route, options]) => route === '/media/session' && options?.method === 'POST').map(([, options]) => options?.body?.acceptHevc ?? false)).toEqual([true, false]);
      deck.release();
    } finally {
      abort.abort();
      await settled;
    }
  });

  it('三倍速预热槽保留至少12秒媒体缓冲且首帧后继续加载', async () => {
    const video = {
      readyState: 2, videoWidth: 1920, duration: 36, currentTime: 0, paused: true, ended: false,
      buffered: { length: 0 }, style: { visibility: '' }, muted: false, volume: 1,
      pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      play: vi.fn(async () => {}), requestVideoFrameCallback: vi.fn((callback: (...args: any[]) => void) => { queueMicrotask(() => callback()); return 1; }),
      cancelVideoFrameCallback: vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 });
    const request = vi.fn(async (path: string) => path === '/media/session'
      ? { id: 'buffer-session', phase: 'complete', url: '/media/buffer.m3u8', duration: 36, videoCodec: 'h264' } as MediaSession
      : {});
    const loader = new HlsDeckLoader([video], { request } as unknown as NativeBridge, vi.fn(), undefined, undefined, () => 3);
    const preparing = loader.prepare(0, { seriesId: '12345678', episode: 115, quality: '1080p', start: 0, compatible: true }, new AbortController().signal);
    let deck;
    try {
      await vi.waitFor(() => expect((Hls as any).instances).toHaveLength(1));
      const engine = (Hls as any).instances[0];
      engine.emit((Hls as any).Events.MANIFEST_PARSED);
      deck = await preparing;
      expect(engine.config).toMatchObject({ maxBufferLength: 12, maxMaxBufferLength: 18 });
      expect(engine.stopLoad).not.toHaveBeenCalled();
    } finally {
      deck?.release();
    }
  });
});
