import type { Series } from '../shared/contracts';

export interface CatalogFilterOption { id: string; name: string; }
export type CatalogFilters = { themes?: string[]; themeOptions?: CatalogFilterOption[] } | Array<{ type: string; items: CatalogFilterOption[] }>;
export interface CatalogResult { items: Series[]; hasMore?: boolean; cursor?: string; filters?: CatalogFilters; cached?: boolean; stale?: boolean; updating?: boolean; updatedAt?: number; warning?: string; }
interface Entry { at: number; data: CatalogResult; }
const memory = new Map<string, Entry>();
const STORAGE = 'hongguo:public-catalog-v1', MAX_ENTRIES = 12, MAX_AGE = 7 * 86400 * 1000;
let loaded = false;
const persistable = (key: string) => !key.includes('mode=recommend') && !key.startsWith('/catalog/search');

function series(value: Series): Series | null {
  if (!value || !/^\d+$/.test(String(value.id))) return null;
  const text = (value: unknown, max = 300) => typeof value === 'string' ? value.slice(0, max) : '';
  const names = (value: unknown) => Array.isArray(value) ? value.filter(i => typeof i === 'string').slice(0, 20).map(i => i.slice(0, 80)) : [];
  return { id: String(value.id), title: text(value.title), cover: /^https?:\/\//.test(value.cover || '') ? text(value.cover, 3000) : '', intro: text(value.intro, 3000), totalEpisodes: Number.isFinite(value.totalEpisodes) ? Math.max(0, value.totalEpisodes) : 0, tags: names(value.tags), actors: names(value.actors), ...(value.score ? { score: text(value.score, 30) } : {}) };
}
function clean(data: CatalogResult): CatalogResult {
  const options = (rows: unknown) => Array.isArray(rows) ? rows.slice(0, 80).filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').map(row => ({ id: row.id.slice(0, 80), name: row.name.slice(0, 80) })) : [];
  const filters: CatalogFilters | undefined = data.filters ? Array.isArray(data.filters) ? data.filters.slice(0, 20).filter(f => typeof f.type === 'string').map(f => ({ type: f.type.slice(0, 80), items: options(f.items) })) : { themeOptions: options(data.filters.themeOptions), themes: Array.isArray(data.filters.themes) ? data.filters.themes.filter(s => typeof s === 'string').slice(0, 80).map(s => s.slice(0, 80)) : [] } : undefined;
  return { items: (data.items || []).slice(0, 160).map(series).filter((item): item is Series => !!item), hasMore: !!data.hasMore, cursor: typeof data.cursor === 'string' ? data.cursor.slice(0, 1024) : '', filters, updatedAt: data.updatedAt };
}
function load() {
  if (loaded) return; loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE); if (!raw || raw.length > 700000) return;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(0, MAX_ENTRIES)) if (typeof row?.key === 'string' && persistable(row.key) && typeof row.at === 'number' && Date.now() - row.at < MAX_AGE && Array.isArray(row.data?.items)) memory.set(row.key, { at: row.at, data: clean(row.data) });
  } catch { /* A damaged cache must never prevent browsing. */ }
}
function prune() {
  const ordered = [...memory.entries()].sort((a, b) => b[1].at - a[1].at);
  memory.clear(); for (const [key, entry] of ordered.slice(0, MAX_ENTRIES)) if (Date.now() - entry.at < MAX_AGE) memory.set(key, entry);
}
export function readCatalog(key: string): CatalogResult | null {
  load(); const entry = memory.get(key);
  if (!entry || Date.now() - entry.at >= MAX_AGE) return null;
  return structuredClone({ ...entry.data, cached: true, updatedAt: entry.data.updatedAt || entry.at / 1000 });
}
export function writeCatalog(key: string, data: CatalogResult) {
  load(); if (!Array.isArray(data.items) || !data.items.length) return;
  const safe = clean(data); memory.set(key, { at: Date.now(), data: safe }); prune();
  try { localStorage.setItem(STORAGE, JSON.stringify([...memory.entries()].filter(([key]) => persistable(key)).map(([key, entry]) => ({ key, ...entry })))); } catch { /* Memory cache still serves navigation when disk storage is unavailable. */ }
}
export function clearPrivateCatalogs() { for (const key of memory.keys()) if (!persistable(key)) memory.delete(key); }
