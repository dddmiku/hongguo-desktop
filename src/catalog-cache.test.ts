import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogResult } from './catalog-cache';
const data: CatalogResult = { items: [{ id: '12345678', title: '测试剧', cover: 'https://example.com/poster.jpg', intro: '', totalEpisodes: 8, tags: [], actors: [] }], hasMore: false };
const storage = new Map<string, string>();
beforeEach(() => { vi.resetModules(); storage.clear(); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) }); });
describe('公开片单缓存', () => {
  it('导航读取可直接呈现曾加载的真实片单，并与调用者隔离', async () => { const cache = await import('./catalog-cache'); cache.writeCatalog('/catalog/home?mode=discover', data); const first = cache.readCatalog('/catalog/home?mode=discover')!; first.items[0].title = '修改'; expect(cache.readCatalog('/catalog/home?mode=discover')?.items[0].title).toBe('测试剧'); });
  it('重启后可读取公开片单且不会保存账号秘密', async () => { const cache = await import('./catalog-cache'); cache.writeCatalog('/catalog/home?mode=discover', { ...data, token: 'credential', cookie: 'private' } as CatalogResult); expect([...storage.values()].join('')).not.toMatch(/credential|private/); vi.resetModules(); const restarted = await import('./catalog-cache'); expect(restarted.readCatalog('/catalog/home?mode=discover')?.items).toHaveLength(1); });
  it('推荐与搜索只保留在内存，换号可清理', async () => { const cache = await import('./catalog-cache'); cache.writeCatalog('/catalog/home?mode=recommend#uid-a', data); cache.writeCatalog('/catalog/search?q=test', data); expect([...storage.values()].join('')).not.toContain('测试剧'); cache.clearPrivateCatalogs(); expect(cache.readCatalog('/catalog/home?mode=recommend#uid-a')).toBeNull(); });
  it('失败或空数据不覆盖已有可用片单', async () => { const cache = await import('./catalog-cache'); cache.writeCatalog('/catalog/home?mode=discover', data); cache.writeCatalog('/catalog/home?mode=discover', { items: [] }); expect(cache.readCatalog('/catalog/home?mode=discover')?.items).toHaveLength(1); });
  it('存储损坏时仍允许下一次网络结果写入', async () => { storage.set('hongguo:public-catalog-v2', 'broken'); const cache = await import('./catalog-cache'); expect(cache.readCatalog('/catalog/home?mode=discover')).toBeNull(); cache.writeCatalog('/catalog/home?mode=discover', data); expect(cache.readCatalog('/catalog/home?mode=discover')?.items).toHaveLength(1); });
  it('缓存有数量上限', async () => { const cache = await import('./catalog-cache'); for (let n = 0; n < 30; n++) cache.writeCatalog(`/catalog/rank?board=${n}`, data); expect(JSON.parse([...storage.values()][0])).toHaveLength(12); });
  it('公开筛选面板可单独缓存并在重启后完整保留多维分类', async () => {
    let cache = await import('./catalog-cache');
    const groups = [{ type: 'category_dim_theme', name: '题材', items: [{ id: 'cate_5021', name: '年代' }] }, { type: 'category_dim_role', name: '设定', items: Array.from({ length: 80 }, (_, n) => ({ id: `cate_${5200 + n}`, name: `设定 ${n}` })) }];
    cache.writeCatalog('/catalog/filters?genre=short_play', { items: [], filters: { groups } });
    vi.resetModules(); cache = await import('./catalog-cache');
    expect(cache.readCatalog('/catalog/filters?genre=short_play')?.filters).toMatchObject({ groups });
  });
  it('题材、设定、背景及后续页的缓存相互独立', async () => {
    const cache = await import('./catalog-cache');
    for (const [query, title] of [['theme=cate_5000', '爱情'], ['theme=cate_5021', '年代'], ['setting=cate_5221&background=cate_5338', '女强现代'], ['theme=cate_5000&cursor=next', '爱情第二页']]) cache.writeCatalog(`/catalog/browse?${query}`, { ...data, items: [{ ...data.items[0], title }] });
    expect(cache.readCatalog('/catalog/browse?theme=cate_5000')?.items[0].title).toBe('爱情');
    expect(cache.readCatalog('/catalog/browse?theme=cate_5000&cursor=next')?.items[0].title).toBe('爱情第二页');
    expect(cache.readCatalog('/catalog/browse?setting=cate_5221&background=cate_5338')?.items[0].title).toBe('女强现代');
  });
  it('超过160部的合并片单在内存保持完整，不能把截断片单和末页游标落盘', async () => {
    let cache = await import('./catalog-cache');
    const key = '/catalog/rank?board=recommend&genre=series';
    const items = Array.from({ length: 200 }, (_, index) => ({ ...data.items[0], id: String(12345678 + index) }));
    cache.writeCatalog(key, { items: items.slice(0, 160), hasMore: true, cursor: 'after-160' });
    cache.writeCatalog(key, { items, hasMore: true, cursor: 'after-200' });
    const restored = cache.readCatalog(key)!;
    expect(restored.items.map(item => item.id)).toEqual(items.map(item => item.id));
    expect(restored.cursor).toBe('after-200');
    expect(restored.hasMore).toBe(true);
    expect(JSON.parse([...storage.values()].at(-1)!).some((row: { key: string }) => row.key === key)).toBe(false);
    vi.resetModules(); cache = await import('./catalog-cache');
    expect(cache.readCatalog(key)).toBeNull();
  });
  it('恰好160部的完整片单可恢复，但一次性分页游标不跨重启', async () => {
    let cache = await import('./catalog-cache');
    const key = '/catalog/rank?board=new&genre=series';
    const items = Array.from({ length: 160 }, (_, index) => ({ ...data.items[0], id: String(22345678 + index) }));
    cache.writeCatalog(key, { items, hasMore: true, cursor: 'after-160' });
    vi.resetModules(); cache = await import('./catalog-cache');
    expect(cache.readCatalog(key)).toMatchObject({ items, hasMore: false, cursor: '' });
  });
  it('片单超过内存容量时整条退出缓存，不能继续恢复过期前缀或游标', async () => {
    let cache = await import('./catalog-cache');
    const key = '/catalog/rank?board=recommend&genre=series';
    cache.writeCatalog(key, { ...data, hasMore: true, cursor: 'after-1' });
    cache.writeCatalog(key, { items: Array.from({ length: 1001 }, (_, index) => ({ ...data.items[0], id: String(32345678 + index) })), hasMore: true, cursor: 'after-1001' });
    expect(cache.readCatalog(key)).toBeNull();
    vi.resetModules(); cache = await import('./catalog-cache');
    expect(cache.readCatalog(key)).toBeNull();
  });
  it('不恢复旧版可能已截断但保留后续游标的片单', async () => {
    const key = '/catalog/rank?board=recommend&genre=series';
    storage.set('hongguo:public-catalog-v1', JSON.stringify([{ key, at: Date.now(), data: { ...data, hasMore: true, cursor: 'after-200' } }]));
    const cache = await import('./catalog-cache');
    expect(cache.readCatalog(key)).toBeNull();
  });
  it('磁盘条目超过容量时整条忽略，不截断其分页前缀', async () => {
    const key = '/catalog/rank?board=recommend&genre=series';
    storage.set('hongguo:public-catalog-v2', JSON.stringify([{ key, at: Date.now(), data: { items: Array.from({ length: 200 }, (_, index) => ({ ...data.items[0], id: String(42345678 + index) })), hasMore: true, cursor: 'after-200' } }]));
    const cache = await import('./catalog-cache');
    expect(cache.readCatalog(key)).toBeNull();
  });
});
import {readCatalog,writeCatalog} from './catalog-cache';
describe('片单缓存不落盘一次性分页令牌',()=>{
  it('显示缓存仍在，恢复后的分页游标为空',async()=>{
    const key='/catalog/rank?board=recommend&genre=series';
    const item={id:'12345678',title:'缓存剧',cover:'',intro:'',totalEpisodes:1,tags:[],actors:[]};
    writeCatalog(key,{items:[item],hasMore:true,cursor:'one-time-token'});
    vi.resetModules();
    const restored=(await import('./catalog-cache')).readCatalog(key);
    expect(restored?.items).toHaveLength(1);
    expect(restored?.hasMore).toBe(false);
    expect(restored?.cursor).toBe('');
  });
});
