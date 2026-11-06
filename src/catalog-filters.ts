import type { Genre } from '../shared/contracts';
import type { CatalogFilterGroup, CatalogFilters } from './catalog-cache';

export type CatalogPage = 'discover' | 'recommend' | 'rank' | 'browse' | 'search';
export interface CatalogSelection { board: string; sort: string; theme: string; setting: string; background: string; expanded: boolean; }
export type CategoryKey = 'theme' | 'setting' | 'background';
export const categoryKeys: Record<string, CategoryKey> = { category_dim_theme: 'theme', category_dim_role: 'setting', category_dim_epoch: 'background' };
const defaults: CatalogSelection = { board: 'hot', sort: 'hot_score', theme: '', setting: '', background: '', expanded: false };
const preferences = new Map<string, CatalogSelection>();
const STORAGE = 'hongguo:catalog-selection-v1';
let loaded = false;

export function readCatalogSelection(scope: string): CatalogSelection {
  if (!loaded) {
    loaded = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      for (const [key, value] of raw && raw.length < 15000 ? JSON.parse(raw).slice(0, 16) : []) {
        if (typeof key !== 'string' || !value || typeof value !== 'object') continue;
        const clean = { ...defaults };
        for (const field of ['theme', 'setting', 'background'] as const) if (typeof value[field] === 'string' && /^[A-Za-z0-9_-]{0,80}$/.test(value[field])) clean[field] = value[field];
        if (['hot_score', 'online_time', 'hot_collect'].includes(value.sort)) clean.sort = value.sort;
        if (['hot', 'new'].includes(value.board)) clean.board = value.board;
        clean.expanded = value.expanded === true;
        preferences.set(key.slice(0, 80), clean);
      }
    } catch { /* Damaged public preferences never prevent browsing. */ }
  }
  return { ...(preferences.get(scope) || defaults) };
}

export function saveCatalogSelection(scope: string, value: CatalogSelection) {
  preferences.delete(scope); preferences.set(scope, { ...value });
  while (preferences.size > 16) preferences.delete(preferences.keys().next().value!);
  try { localStorage.setItem(STORAGE, JSON.stringify([...preferences])); } catch { /* Navigation still retains in memory. */ }
}

export function catalogGroups(filters?: CatalogFilters): CatalogFilterGroup[] {
  const rows = Array.isArray(filters) ? filters : filters?.groups || (filters?.themeOptions?.length ? [{ type: 'category_dim_theme', items: filters.themeOptions }] : []);
  const labels: Record<string, string> = { category_dim_theme: '题材', category_dim_role: '设定', category_dim_epoch: '背景' };
  const priority = ['动作', '爱情', '年代', '传奇'];
  return rows.filter(row => categoryKeys[row.type] && row.items?.length).map(row => ({
    type: row.type, name: row.name || labels[row.type],
    items: row.type === 'category_dim_theme' ? [...row.items.filter(option => priority.includes(option.name)).sort((a, b) => priority.indexOf(a.name) - priority.indexOf(b.name)), ...row.items.filter(option => !priority.includes(option.name))] : row.items,
  }));
}

export function categorySelected(value: CatalogSelection) { return !!(value.theme || value.setting || value.background); }

export function catalogRoute(page: CatalogPage, query: string, genre: Genre, value: CatalogSelection) {
  if (page === 'search') return `/catalog/search?q=${encodeURIComponent(query)}`;
  if (page === 'rank') return `/catalog/rank?board=${value.board}&genre=${genre}`;
  if (page === 'browse' || page === 'discover' && categorySelected(value)) return `/catalog/browse?genre=${genre}&sort=${value.sort}&theme=${encodeURIComponent(value.theme)}&setting=${encodeURIComponent(value.setting)}&background=${encodeURIComponent(value.background)}`;
  return `/catalog/home?genre=${genre}&mode=${page === 'recommend' ? 'recommend' : 'discover'}`;
}
