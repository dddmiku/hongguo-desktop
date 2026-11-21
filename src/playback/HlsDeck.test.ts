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
    startLoad = vi.fn();
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
  it('窗口隐藏恢复会清空旧的停滞预算并重新启动 HLS',async()=>{
    vi.useFakeTimers();
    const listeners=new Map<string,Set<(...args:any[])=>void>>();
    const video={
      readyState:2,videoWidth:1920,duration:80,currentTime:23.75,paused:false,ended:false,
      buffered:{length:0},style:{visibility:''},muted:false,volume:1,
      pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),
      addEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>{const set=listeners.get(name)||new Set();set.add(callback);listeners.set(name,set);}),
      removeEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>listeners.get(name)?.delete(callback)),
      play:vi.fn(async()=>{}),requestVideoFrameCallback:vi.fn((callback:(...args:any[])=>void)=>{queueMicrotask(()=>callback());return 1;}),
      cancelVideoFrameCallback:vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement',{HAVE_METADATA:1,HAVE_CURRENT_DATA:2});
    const request=vi.fn(async(path:string)=>path==='/media/session'
      ?{id:'visibility-session',phase:'complete',url:'/media/visibility.m3u8',duration:80,videoCodec:'h264'}
      :{});
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,vi.fn(),undefined,()=>true);
    const preparing=loader.prepare(0,{seriesId:'12345678',episode:54,quality:'1080p',start:23.75,compatible:true},new AbortController().signal);
    const engine=await vi.waitFor(()=>{expect((Hls as any).instances).toHaveLength(1);return (Hls as any).instances[0];});
    engine.emit((Hls as any).Events.MANIFEST_PARSED);
    const deck=await preparing;
    try{
      await vi.advanceTimersByTimeAsync(5500);
      expect(engine.startLoad).toHaveBeenCalledOnce();
      deck.suspendPlayback();expect(engine.stopLoad).toHaveBeenCalledOnce();
      deck.resumePlayback(23.75);expect(engine.startLoad).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5500);
      expect(engine.startLoad).toHaveBeenCalledTimes(3);
    }finally{deck.release();}
  });
  it('三倍速自动切集预热必须缓冲至少9秒才交付解码槽',async()=>{
    vi.useFakeTimers();
    const listeners=new Map<string,Set<(...args:any[])=>void>>();let bufferedEnd=0;
    const video={
      readyState:2,videoWidth:1920,duration:80,currentTime:0,paused:false,ended:false,
      buffered:{get length(){return bufferedEnd>0?1:0;},start:()=>0,end:()=>bufferedEnd},style:{visibility:''},muted:false,volume:1,
      pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),
      addEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>{const set=listeners.get(name)||new Set();set.add(callback);listeners.set(name,set);}),
      removeEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>listeners.get(name)?.delete(callback)),
      play:vi.fn(async()=>{}),requestVideoFrameCallback:vi.fn((callback:(...args:any[])=>void)=>{queueMicrotask(()=>callback());return 1;}),
      cancelVideoFrameCallback:vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement',{HAVE_METADATA:1,HAVE_CURRENT_DATA:2});
    const request=vi.fn(async(path:string)=>path==='/media/session'
      ?{id:'prewarm-session',phase:'complete',url:'/media/prewarm.m3u8',duration:80,videoCodec:'h264'}
      :{});
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,vi.fn(),undefined,()=>true,()=>3);
    let settled=false;
    const preparing=loader.prepare(0,{seriesId:'12345678',episode:55,quality:'1080p',start:0,compatible:true},new AbortController().signal,true)
      .then(deck=>{settled=true;return deck;});
    const engine=await vi.waitFor(()=>{expect((Hls as any).instances).toHaveLength(1);return (Hls as any).instances[0];});
    engine.emit((Hls as any).Events.MANIFEST_PARSED);
    await vi.waitFor(()=>expect(video.pause).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    bufferedEnd=2;engine.emit((Hls as any).Events.FRAG_BUFFERED,{frag:{type:'main',sn:0}});
    await Promise.resolve();expect(settled).toBe(false);
    bufferedEnd=8.5;engine.emit((Hls as any).Events.FRAG_BUFFERED,{frag:{type:'main',sn:1}});
    await Promise.resolve();expect(settled).toBe(false);
    bufferedEnd=9.5;engine.emit((Hls as any).Events.FRAG_BUFFERED,{frag:{type:'main',sn:2}});
    const deck=await preparing;expect(settled).toBe(true);deck.release();
  });
  it('三倍速短集只有最终 VOD 尾段完整缓存后才能按整集交付预热槽',async()=>{
    vi.useFakeTimers();
    let bufferedEnd=2;
    const video={
      readyState:2,videoWidth:1920,duration:6,currentTime:0,paused:true,ended:false,
      buffered:{length:1,start:()=>0,end:()=>bufferedEnd},style:{visibility:''},muted:false,volume:1,
      pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),
      play:vi.fn(async()=>{}),requestVideoFrameCallback:vi.fn((callback:(...args:any[])=>void)=>{queueMicrotask(()=>callback());return 1;}),
      cancelVideoFrameCallback:vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement',{HAVE_METADATA:1,HAVE_CURRENT_DATA:2});
    const request=vi.fn(async(path:string)=>path==='/media/session'
      ?{id:'short-prewarm-session',phase:'complete',url:'/media/short.m3u8',duration:6,videoCodec:'h264'}
      :{});
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,vi.fn(),undefined,()=>true,()=>3);
    const abort=new AbortController();let settled=false;
    const preparing=loader.prepare(0,{seriesId:'12345678',episode:56,quality:'1080p',start:0,compatible:true},abort.signal,true);
    const observed=preparing.then(()=>{settled=true;},()=>{});
    try{
      const engine=await vi.waitFor(()=>{expect((Hls as any).instances).toHaveLength(1);return (Hls as any).instances[0];});
      engine.levels=[{details:{live:true,fragments:[{sn:0},{sn:1},{sn:2}]}}];
      engine.emit((Hls as any).Events.MANIFEST_PARSED);
      await vi.waitFor(()=>expect(video.pause).toHaveBeenCalledTimes(2));
      engine.emit((Hls as any).Events.FRAG_BUFFERED,{frag:{type:'main',sn:0}});
      await Promise.resolve();expect(settled).toBe(false);
      bufferedEnd=6;engine.emit((Hls as any).Events.FRAG_BUFFERED,{frag:{type:'main',sn:2}});
      await Promise.resolve();expect(settled).toBe(false);
      engine.levels[0].details.live=false;engine.emit((Hls as any).Events.LEVEL_UPDATED);
      await Promise.resolve();await Promise.resolve();
      expect(settled).toBe(true);
      const deck=await preparing;expect(deck.sealed).toBe(true);deck.release();
    }finally{abort.abort();await observed;}
  });
  it('预热遇到 HEVC 解码失败切兼容后仍等待三倍速缓冲门槛',async()=>{
    vi.useFakeTimers();vi.mocked(hardwareHevc).mockResolvedValue(true);
    let bufferedEnd=2;
    const video={
      readyState:2,videoWidth:1920,duration:80,currentTime:0,paused:true,ended:false,
      buffered:{length:1,start:()=>0,end:()=>bufferedEnd},style:{visibility:''},muted:false,volume:1,
      pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),
      play:vi.fn(async()=>{}),requestVideoFrameCallback:vi.fn((callback:(...args:any[])=>void)=>{queueMicrotask(()=>callback());return 1;}),
      cancelVideoFrameCallback:vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement',{HAVE_METADATA:1,HAVE_CURRENT_DATA:2});
    let posts=0;
    const request=vi.fn(async(path:string,options?:{method?:string;body?:{acceptHevc?:boolean}})=>path==='/media/session'
      ?{id:'fallback-prewarm-'+(++posts),phase:'complete',url:'/media/fallback.m3u8',duration:80,videoCodec:options?.body?.acceptHevc?'hevc':'h264'}
      :{});
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,vi.fn(),undefined,()=>true,()=>3);
    const abort=new AbortController();let settled=false;
    const preparing=loader.prepare(0,{seriesId:'12345678',episode:57,quality:'1080p',start:0},abort.signal,true);
    const observed=preparing.then(()=>{settled=true;},()=>{});
    try{
      const first=await vi.waitFor(()=>{expect((Hls as any).instances).toHaveLength(1);return (Hls as any).instances[0];});
      first.emit((Hls as any).Events.ERROR,{fatal:true,type:(Hls as any).ErrorTypes.MEDIA_ERROR});
      const replacement=await vi.waitFor(()=>{expect((Hls as any).instances).toHaveLength(2);return (Hls as any).instances[1];});
      replacement.emit((Hls as any).Events.MANIFEST_PARSED);
      await vi.waitFor(()=>expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(0);expect(settled).toBe(false);
      bufferedEnd=9.5;replacement.emit((Hls as any).Events.FRAG_BUFFERED,{frag:{type:'main',sn:4}});
      const deck=await preparing;expect(deck.target.compatible).toBe(true);deck.release();
    }finally{abort.abort();await observed;}
  });
  it('后台心跳发现新取流任务失败时把线路原因显示给播放器',async()=>{
    vi.useFakeTimers();
    const listeners=new Map<string,Set<(...args:any[])=>void>>();
    const video={
      readyState:2,videoWidth:1920,duration:80,currentTime:23.75,paused:true,ended:false,
      buffered:{length:0},style:{visibility:''},muted:false,volume:1,
      pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),
      addEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>{const set=listeners.get(name)||new Set();set.add(callback);listeners.set(name,set);}),
      removeEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>listeners.get(name)?.delete(callback)),
      play:vi.fn(async()=>{}),requestVideoFrameCallback:vi.fn((callback:(...args:any[])=>void)=>{queueMicrotask(()=>callback());return 1;}),
      cancelVideoFrameCallback:vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement',{HAVE_METADATA:1,HAVE_CURRENT_DATA:2});
    const sourceFailure='各播放线路暂时连接失败，请重试当前集';let posts=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST'){
        posts++;
        return posts===1
          ? {id:'first',phase:'complete',url:'/media/first.m3u8',duration:80,videoCodec:'h264'}
          : {id:'replacement',phase:'error',error:sourceFailure,url:'/media/replacement.m3u8'};
      }
      if(path==='/media/session/first'&&!options)return {id:'first',phase:'error',error:'旧任务已结束',url:'/media/first.m3u8'};
      return {};
    });
    const fatal=vi.fn();
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,fatal);
    const preparing=loader.prepare(0,{seriesId:'12345678',episode:54,quality:'1080p',start:23.75,compatible:true},new AbortController().signal);
    let deck;
    try{
      await vi.waitFor(()=>expect((Hls as any).instances).toHaveLength(1));
      (Hls as any).instances[0].emit((Hls as any).Events.MANIFEST_PARSED);
      deck=await preparing;
      await vi.advanceTimersByTimeAsync(60000);
      expect(fatal).toHaveBeenCalledWith(deck,sourceFailure);
    }finally{deck?.release();}
  });
  it('续租网络故障用尽重试预算后停止续租和恢复计时器',async()=>{
    vi.useFakeTimers();
    const listeners=new Map<string,Set<(...args:any[])=>void>>();
    const video={
      readyState:2,videoWidth:1920,duration:80,currentTime:23.75,paused:true,ended:false,
      buffered:{length:0},style:{visibility:''},muted:false,volume:1,
      pause:vi.fn(),load:vi.fn(),removeAttribute:vi.fn(),
      addEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>{const set=listeners.get(name)||new Set();set.add(callback);listeners.set(name,set);}),
      removeEventListener:vi.fn((name:string,callback:(...args:any[])=>void)=>listeners.get(name)?.delete(callback)),
      play:vi.fn(async()=>{}),requestVideoFrameCallback:vi.fn((callback:(...args:any[])=>void)=>{queueMicrotask(()=>callback());return 1;}),
      cancelVideoFrameCallback:vi.fn(),
    } as unknown as HTMLVideoElement;
    vi.stubGlobal('HTMLMediaElement',{HAVE_METADATA:1,HAVE_CURRENT_DATA:2});
    let posts=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST'){
        posts++;if(posts===1)return {id:'first',phase:'complete',url:'/media/first.m3u8',duration:80,videoCodec:'h264'};
        throw new TypeError('fetch failed');
      }
      if(path==='/media/session/first'&&!options)throw new Error('播放会话已过期，请重新连接');
      return {};
    });
    const fatal=vi.fn();
    const loader=new HlsDeckLoader([video],{request} as unknown as NativeBridge,fatal);
    const preparing=loader.prepare(0,{seriesId:'12345678',episode:54,quality:'1080p',start:23.75,compatible:true},new AbortController().signal);
    const engine=await vi.waitFor(()=>{expect((Hls as any).instances).toHaveLength(1);return (Hls as any).instances[0];});
    engine.emit((Hls as any).Events.MANIFEST_PARSED);
    const deck=await preparing;
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(posts).toBe(4);
    expect(fatal).toHaveBeenCalledWith(deck,'播放连接暂时不可用，请重试当前集');
    await vi.advanceTimersByTimeAsync(120000);
    expect(posts).toBe(4);
    deck.release();
  });
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
