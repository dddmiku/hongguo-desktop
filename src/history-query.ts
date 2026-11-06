import type { HistoryItem, HistoryQuery } from '../shared/contracts';

export function seconds(value: number) { return value > 1e12 ? value / 1000 : value; }
export function isHistoryFinished(item: HistoryItem) {
  return item.series.totalEpisodes > 0 && item.episode >= item.series.totalEpisodes && item.duration > 0 && item.position >= Math.max(0, item.duration - 3);
}
export function episodeFinished(item: HistoryItem) { return item.duration > 0 && item.position >= Math.max(0, item.duration - 3); }
export function historyDay(value: number, now = new Date()): { key: string; label: string } {
  if(!Number.isFinite(value)||value<=0)return {key:'unknown',label:'观看时间未知'};
  const date = new Date(seconds(value) * 1000);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()), viewed = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((start.getTime() - viewed.getTime()) / 86400000);
  const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  return { key, label: days === 0 ? '今天' : days === 1 ? '昨天' : (date.getFullYear() === now.getFullYear() ? '' : date.getFullYear() + ' 年 ') + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日' };
}
export function groupHistory(items: HistoryItem[], now = new Date()) {
  const groups: Array<{ key: string; label: string; items: HistoryItem[] }> = [];
  for (const item of items) {
    const day = historyDay(item.watchedAt, now), last = groups.at(-1);
    if (last?.key === day.key) last.items.push(item); else groups.push({ ...day, items: [item] });
  }
  return groups;
}
export function normalizeHistoryQuery(value: HistoryQuery): HistoryQuery {
  return { search: (value.search || '').trim().slice(0, 80), period: ['today', 'week', 'month'].includes(value.period || '') ? value.period : 'all', status: ['unfinished', 'finished'].includes(value.status || '') ? value.status : 'all', cursor: value.cursor || undefined, limit: 50 };
}
export function nextHistory(items: HistoryItem[], incoming: HistoryItem[]) {
  const known = new Set(items.map(item => item.series.id));
  return [...items, ...incoming.filter(item => { if (known.has(item.series.id)) return false; known.add(item.series.id); return true; })];
}
export function resumeHistory(item: HistoryItem): HistoryItem {
  if (episodeFinished(item) && !isHistoryFinished(item) && item.episode < item.series.totalEpisodes) return { ...item, episode: item.episode + 1, position: 0, duration: 0 };
  return item;
}
export function positionLabel(value: number) { return Math.floor(Math.max(0, value) / 60) + ':' + String(Math.floor(Math.max(0, value) % 60)).padStart(2, '0'); }
