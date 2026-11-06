import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSelection } from './catalog-filters';
const storage = new Map<string, string>();
const selected: CatalogSelection = { board: 'hot', sort: 'hot_score', theme: 'cate_5000', setting: 'cate_5221', background: 'cate_5338', expanded: true };
beforeEach(() => { vi.resetModules(); storage.clear(); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) }); });

describe('真实分类查询与返回状态', () => {
  it('首页选择题材后请求片库且完整保留设定、背景的独立上游 ID', async () => {
    const { catalogRoute } = await import('./catalog-filters');
    expect(catalogRoute('discover', '', 'short_play', selected)).toBe('/catalog/browse?genre=short_play&sort=hot_score&theme=cate_5000&setting=cate_5221&background=cate_5338');
    expect(catalogRoute('browse', '', 'short_play', { ...selected, theme: 'cate_5021', setting: '', background: '' })).toContain('theme=cate_5021&setting=&background=');
  });
  it('未选分类的首页仍请求公开发现，展开面板不会改变片单查询', async () => {
    const { catalogRoute } = await import('./catalog-filters');
    expect(catalogRoute('discover', '', 'short_play', { ...selected, theme: '', setting: '', background: '' })).toBe('/catalog/home?genre=short_play&mode=discover');
    expect(catalogRoute('browse', '', 'short_play', selected)).toBe(catalogRoute('browse', '', 'short_play', { ...selected, expanded: false }));
  });
  it('页面和作品类型切换后分别恢复筛选，重启也保留公开选项', async () => {
    let helper = await import('./catalog-filters');
    helper.saveCatalogSelection('browse:short_play', selected);
    helper.saveCatalogSelection('browse:comic_series', { ...selected, theme: 'cate_5876' });
    expect(helper.readCatalogSelection('discover:short_play').theme).toBe('');
    expect(helper.readCatalogSelection('browse:short_play')).toEqual(selected);
    vi.resetModules(); helper = await import('./catalog-filters');
    expect(helper.readCatalogSelection('browse:short_play')).toEqual(selected);
    expect(helper.readCatalogSelection('browse:comic_series').theme).toBe('cate_5876');
  });
  it('仅排列真实上游选项，不给缺少爱情的 AI 分类补造标签', async () => {
    const { catalogGroups } = await import('./catalog-filters');
    const rows = catalogGroups({ groups: [{ type: 'category_dim_theme', items: [{ id: 'cate_316', name: '剧情' }, { id: 'cate_6', name: '奇幻' }] }] });
    expect(rows[0].items.map(item => item.name)).toEqual(['剧情', '奇幻']);
    const live = catalogGroups({ groups: [{ type: 'category_dim_theme', items: [{ id: 'cate_5001', name: '家庭' }, { id: 'cate_5021', name: '年代' }, { id: 'cate_5000', name: '爱情' }] }] });
    expect(live[0].items.map(item => item.id)).toEqual(['cate_5000', 'cate_5021', 'cate_5001']);
  });
});
