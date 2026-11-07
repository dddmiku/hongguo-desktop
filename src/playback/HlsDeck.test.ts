import { afterEach, describe, expect, it, vi } from 'vitest';
import Hls from 'hls.js';
import type { MediaSession, NativeBridge } from '../../shared/contracts';
import { HlsDeckLoader } from './HlsDeck';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('播放会话异步取消', () => {
  it('POST 返回前取消时只删除一次会话，不挂载解码器或遗留续租计时器', async () => {
    vi.useFakeTimers();
    let completePost!: (session: MediaSession) => void;
    const pendingPost = new Promise<MediaSession>(resolve => { completePost = resolve; });
    const request = vi.fn((path: string) => path === '/media/session' ? pendingPost : Promise.resolve({}));
    const video = {
      pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(),
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
});
