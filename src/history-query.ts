import type { Episode, HistoryItem, HistoryQuery } from '../shared/contracts';

export function seconds(value: number) { return value > 1e12 ? value / 1000 : value; }
export function isHistoryFinished(item: HistoryItem) {
  return item.series.totalEpisodes > 0 && item.episode >= item.series.totalEpisodes && episodeFinished(item);
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
export function continueWatching(history: HistoryItem[]) {
  return history.filter(item => !isHistoryFinished(item)).sort((a, b) => seconds(b.watchedAt) - seconds(a.watchedAt)).slice(0, 3);
}

type PlaybackTarget = { episode: number; position: number; action: 'start' | 'resume' | 'next' | 'replay' };

/** Resolve the saved position only after loading the playable episode list. */
export function historyPlaybackTarget(episodes: Episode[], item?: HistoryItem): PlaybackTarget | undefined {
  if (!episodes.length) return undefined;
  if (!item) return { episode: episodes[0].index, position: 0, action: 'start' };

  const current = episodes.find(episode => episode.index === item.episode);
  const next = episodes.reduce<Episode | undefined>((best, episode) =>
    episode.index > item.episode && (!best || episode.index < best.index) ? episode : best, undefined);
  if (current && !episodeFinished(item)) {
    return { episode: current.index, position: Number.isFinite(item.position) ? Math.max(0, item.position) : 0, action: 'resume' };
  }
  if (next) return { episode: next.index, position: 0, action: 'next' };
  if (current) return { episode: current.index, position: 0, action: 'replay' };
  return { episode: episodes[0].index, position: 0, action: 'start' };
}

export function continueWatchingLabel(item: HistoryItem) {
  const label = '第 ' + item.episode + ' 集';
  if (episodeFinished(item)) return label + '已看完';
  return item.position > 0 ? label + ' · ' + positionLabel(item.position) : label;
}
export function detailPlaybackLabel(target: PlaybackTarget) {
  const episode = '第 ' + target.episode + ' 集';
  if (target.action === 'resume') return '继续' + episode;
  if (target.action === 'next') return '播放' + episode;
  if (target.action === 'replay') return '重看' + episode;
  return '立即播放';
}
export function positionLabel(value: number) { return Math.floor(Math.max(0, value) / 60) + ':' + String(Math.floor(Math.max(0, value) % 60)).padStart(2, '0'); }
