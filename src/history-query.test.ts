import { describe, expect, it } from 'vitest';
import { continueWatching, episodeFinished, groupHistory, historyDay, historyPlaybackTarget, isHistoryFinished, nextHistory, normalizeHistoryQuery } from './history-query';
import type { HistoryItem } from '../shared/contracts';
const item = (index: number, at: number): HistoryItem => ({ series: { id: String(12345678 + index), title: '测试 ' + index, cover: '', intro: '', totalEpisodes: 10, tags: [], actors: [] }, episode: 1, position: 10, duration: 60, watchedAt: at, uid: 'fixture' });
describe('真实历史浏览', () => {
  it('分页浏览120条不在100处截断，重复页不堆积', () => { let items: HistoryItem[] = []; for (let offset = 0; offset < 120; offset += 50) items = nextHistory(items, Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => item(i + offset, 1000 - i - offset))); expect(items).toHaveLength(120); expect(nextHistory(items, items.slice(0, 50))).toHaveLength(120); });
  it('按真实日期区分今天昨天与跨年记录', () => { const now = new Date(2026, 10, 7, 12); expect(historyDay(new Date(2026, 10, 7, 8).getTime(), now).label).toBe('今天'); expect(historyDay(new Date(2026, 10, 6, 23).getTime() / 1000, now).label).toBe('昨天'); expect(historyDay(new Date(2025, 11, 31).getTime() / 1000, now).label).toContain('2025 年'); });
  it('同日分组保留所有记录，不用导入时间覆盖观看时间', () => { const now = new Date(2026, 10, 7), today = now.getTime() / 1000; const groups = groupHistory([item(1, today), item(2, today - 3600), item(3, today - 86400)], now); expect(groups.map(g => g.label)).toEqual(['今天', '昨天']); expect(groups[1].items).toHaveLength(2); });
  it('点开最后一集不等于看完，云历史未知时长不虚报看完', () => { const viewed = { ...item(1, 1000), episode: 10 }; expect(isHistoryFinished(viewed)).toBe(false); expect(isHistoryFinished({ ...viewed, position: 60 })).toBe(true); expect(isHistoryFinished({ ...viewed, duration: 0, position: 999 })).toBe(false); });
  it('过滤看完的剧后才取最新三部，保留未知时长和原始历史', () => {
    const finished = { ...item(1, 5000), episode: 10, position: 59 };
    const unknown = { ...item(2, 4000), episode: 10, duration: 0 };
    const history = [item(5, 1000), finished, unknown, item(3, 3000), item(4, 2000)];
    expect(continueWatching(history)).toEqual([unknown, history[3], history[4]]);
    expect(history).toContain(finished);
  });
  it('按实际可播列表续看，跳过缺集且新一集不继承上一集的时间', () => {
    const current = { ...item(1, 1000), position: 10.5 };
    const available = [4, 1, 8].map(index => ({ index, vid: String(index), title: '' }));
    expect(historyPlaybackTarget(available, current)).toEqual({ episode: 1, position: 10.5, action: 'resume' });
    expect(historyPlaybackTarget(available, { ...current, position: 60 })).toEqual({ episode: 4, position: 0, action: 'next' });
    expect(historyPlaybackTarget(available, { ...current, episode: 6 })).toEqual({ episode: 8, position: 0, action: 'next' });
    expect(historyPlaybackTarget(available, { ...current, episode: 8, position: 60 })).toEqual({ episode: 8, position: 0, action: 'replay' });
    expect(historyPlaybackTarget([], current)).toBeUndefined();
    expect(episodeFinished({ ...current, duration: 0 })).toBe(false);
  });
  it('搜索与筛选映射为分页查询，首屏不携带旧cursor', () => expect(normalizeHistoryQuery({ search: '  皇后 ', period: 'week', status: 'unfinished' })).toEqual({ search: '皇后', period: 'week', status: 'unfinished', cursor: undefined, limit: 50 }));
});
