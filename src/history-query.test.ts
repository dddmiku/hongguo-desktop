import { describe, expect, it } from 'vitest';
import { episodeFinished, groupHistory, historyDay, isHistoryFinished, nextHistory, normalizeHistoryQuery, resumeHistory } from './history-query';
import type { HistoryItem } from '../shared/contracts';
const item = (index: number, at: number): HistoryItem => ({ series: { id: String(12345678 + index), title: '测试 ' + index, cover: '', intro: '', totalEpisodes: 10, tags: [], actors: [] }, episode: 1, position: 10, duration: 60, watchedAt: at, uid: 'fixture' });
describe('真实历史浏览', () => {
  it('分页浏览120条不在100处截断，重复页不堆积', () => { let items: HistoryItem[] = []; for (let offset = 0; offset < 120; offset += 50) items = nextHistory(items, Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => item(i + offset, 1000 - i - offset))); expect(items).toHaveLength(120); expect(nextHistory(items, items.slice(0, 50))).toHaveLength(120); });
  it('按真实日期区分今天昨天与跨年记录', () => { const now = new Date(2026, 10, 7, 12); expect(historyDay(new Date(2026, 10, 7, 8).getTime(), now).label).toBe('今天'); expect(historyDay(new Date(2026, 10, 6, 23).getTime() / 1000, now).label).toBe('昨天'); expect(historyDay(new Date(2025, 11, 31).getTime() / 1000, now).label).toContain('2025 年'); });
  it('同日分组保留所有记录，不用导入时间覆盖观看时间', () => { const now = new Date(2026, 10, 7), today = now.getTime() / 1000; const groups = groupHistory([item(1, today), item(2, today - 3600), item(3, today - 86400)], now); expect(groups.map(g => g.label)).toEqual(['今天', '昨天']); expect(groups[1].items).toHaveLength(2); });
  it('点开最后一集不等于看完，云历史未知时长不虚报看完', () => { const viewed = { ...item(1, 1000), episode: 10 }; expect(isHistoryFinished(viewed)).toBe(false); expect(isHistoryFinished({ ...viewed, position: 60 })).toBe(true); expect(isHistoryFinished({ ...viewed, duration: 0, position: 999 })).toBe(false); });
  it('看完某集后接下一集，未看完保留精确秒级位置', () => { const current = item(1, 1000); expect(resumeHistory(current).position).toBe(10); const next = resumeHistory({ ...current, position: 60 }); expect(next.episode).toBe(2); expect(next.position).toBe(0); expect(episodeFinished({ ...current, duration: 0 })).toBe(false); });
  it('搜索与筛选映射为分页查询，首屏不携带旧cursor', () => expect(normalizeHistoryQuery({ search: '  皇后 ', period: 'week', status: 'unfinished' })).toEqual({ search: '皇后', period: 'week', status: 'unfinished', cursor: undefined, limit: 50 }));
});
