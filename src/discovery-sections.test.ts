import { describe, expect, it } from 'vitest';
import type { Series } from '../shared/contracts';
import { discoverySections } from './discovery-sections';
const series = (id: string, tags: string[] = []): Series => ({ id, title: `作品${id}`, cover: '', intro: '', totalEpisodes: 12, actors: [], tags });
const visible = (sections: ReturnType<typeof discoverySections>) => [sections.hero, ...sections.hot, ...sections.latest, ...sections.topics.flatMap(row => row.items), ...sections.other].filter((row): row is Series => !!row);

describe('发现分区真实来源与去重', () => {
  it('去除源内和跨主视觉、热播、新剧、主题的重复作品', () => {
    const home = Array.from({ length: 28 }, (_, n) => series(String(n + 1), [n % 2 ? '爱情' : '喜剧']));
    const sections = discoverySections([home[0], ...home], home.slice(0, 12), home.slice(5, 19));
    const ids = visible(sections).map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sections.hero?.id).toBe('1');
    expect(sections.hot.map(row => row.id)).toEqual(['2', '3', '4', '5', '6', '7']);
    expect(sections.latest.map(row => row.id)).toEqual(['8', '9', '10', '11', '12', '13']);
    expect(sections.topics.length).toBeGreaterThan(0);
    for (const topic of sections.topics) expect(topic.items.every(row => row.tags.includes(topic.name))).toBe(true);
  });
  it('新剧接口缺失时不会把热门片单标成新上架', () => {
    const sections = discoverySections([series('1'), series('2')], [series('2')], []);
    expect(sections.latest).toEqual([]);
    expect(sections.hero?.id).toBe('1');
    expect(sections.hot[0]?.id).toBe('2');
    expect(sections.topics).toEqual([]);
  });
  it('无主题或少量作品仍保留真实未重复作品，没有补造标签', () => {
    const sections = discoverySections([series('1'), series('2', ['唯一标签']), series('3')], [], []);
    expect(sections.topics).toEqual([]);
    expect(sections.other.map(row => row.id)).toEqual(['2', '3']);
    expect(discoverySections([], [], [])).toEqual({ hero: undefined, hot: [], latest: [], topics: [], other: [] });
  });
  it('重复源条目不把一个作品凑成主题片单', () => {
    const duplicate = series('2', ['爱情']);
    expect(discoverySections([series('1'), duplicate, duplicate], [], []).topics).toEqual([]);
  });
});
