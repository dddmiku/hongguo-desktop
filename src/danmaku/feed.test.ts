import { describe, it, expect, vi } from 'vitest';
import type { DanmakuPage, NativeBridge } from '../../shared/contracts';
import { DanmakuFeed } from './feed';
const scope = { seriesId: '12345678', episode: 1, vid: '23456789' };
const page: DanmakuPage = { ...scope, source: 'mobile', start: 0, end: 30, hasMore: true, items: [{ id: '34567890', text: '测试弹幕', time: 3 }] };
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
describe('弹幕异步时间段读取', () => {
  it('同时间段只请求一次，延迟返回和关闭后的回复不能污染新播放器', async () => {
    let reply!: (value: DanmakuPage) => void;
    const request = vi.fn(() => new Promise<DanmakuPage>(resolve => { reply = resolve; }));
    const receive = vi.fn(), status = vi.fn();
    const feed = new DanmakuFeed(scope, request as NativeBridge['request'], receive, status);
    feed.ensure(1, 100); feed.ensure(20, 100); expect(request).toHaveBeenCalledTimes(1);
    feed.close(); reply(page); await flush(); expect(receive).not.toHaveBeenCalled();
  });
  it('只接受当前视频的真实列表，错误数据给出失败状态并可刷新重试', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ...page, vid: '99999999' }).mockResolvedValue(page);
    const receive = vi.fn(), status = vi.fn();
    const feed = new DanmakuFeed(scope, request as NativeBridge['request'], receive, status);
    feed.ensure(1, 100); await flush(); expect(receive).not.toHaveBeenCalled();
    expect(status.mock.calls.at(-1)?.[0].error).toContain('不正确');
    feed.refresh(1, 100); await flush(); expect(receive).toHaveBeenCalledWith(page); feed.close();
  });
  it('刷新世代使之前的请求失效，不重复计数同一条弹幕', async () => {
    let oldReply!: (value: DanmakuPage) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { oldReply = resolve; })).mockResolvedValue(page);
    const receive = vi.fn(), status = vi.fn();
    const feed = new DanmakuFeed(scope, request as NativeBridge['request'], receive, status);
    feed.ensure(0, 100); feed.refresh(0, 100); await flush();
    oldReply({ ...page, items: [{ id: '99999999', text: '过期', time: 3 }] }); await flush();
    expect(receive).toHaveBeenCalledTimes(1); expect(status.mock.calls.at(-1)?.[0].loaded).toBe(1); feed.close();
  });
});
