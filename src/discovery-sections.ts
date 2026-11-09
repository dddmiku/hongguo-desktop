import type { Series } from '../shared/contracts';

export interface DiscoveryTopic { name: string; items: Series[]; }
export interface DiscoverySections { hero?: Series; hot: Series[]; latest: Series[]; topics: DiscoveryTopic[]; other: Series[]; }

/** Each visible title keeps its actual source; unavailable new releases never fall back to hot titles. */
export function discoverySections(home: Series[], hot: Series[], latest: Series[]): DiscoverySections {
  const used = new Set<string>();
  const take = (rows: Series[], limit: number) => rows.filter(row => {
    if (!row.id || used.has(row.id) || limit <= 0) return false;
    used.add(row.id); limit--; return true;
  });
  const hero = take(home, 1)[0];
  const hotItems = take(hot, 6), latestItems = take(latest, 6);
  const topics: DiscoveryTopic[] = [], topicNames = new Set<string>();
  for (let n = 0; n < 3; n++) {
    const candidates = new Map<string, Series[]>(), seen = new Set<string>();
    for (const row of home) {
      if (used.has(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      for (const tag of new Set(row.tags?.slice(0, 2).filter(tag => tag.trim() && !['短剧', '红果短剧', '漫剧', 'AI 剧'].includes(tag)) || [])) {
        if (topicNames.has(tag)) continue;
        const rows = candidates.get(tag) || []; rows.push(row); candidates.set(tag, rows);
      }
    }
    const winner = [...candidates].filter(([, rows]) => rows.length >= 2).sort((a, b) => b[1].length - a[1].length)[0];
    if (!winner) break;
    topicNames.add(winner[0]); topics.push({ name: winner[0], items: take(winner[1], 3) });
  }
  return { hero, hot: hotItems, latest: latestItems, topics, other: take(home, 6) };
}
