import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryItem, Library, Series, Settings } from '../shared/contracts';
import { validateSettings } from './store';
import { readLegacyPreferences } from './legacy-preferences';

export interface LegacyImport {
  library: Library;
  /** Main-process only. Never expose this field to a renderer or a diagnostic log. */
  session?: Record<string, unknown>;
  settings?: Partial<Settings>;
  /** Empty when neither supported legacy file exists. Main process owns the import marker. */
  source: string;
}

type Row = Record<string, unknown>;
const text = (value: unknown, max = 5000): string => typeof value === 'string' ? value.slice(0, max) : '';
const number = (value: unknown, fallback = 0): number => { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback; };
const identifier = (value: unknown): string => { const id = typeof value === 'bigint' ? String(value) : typeof value === 'string' ? value : ''; return /^\d{8,24}$/.test(id) ? id : ''; };
// Legacy account identifiers may be opaque encoded values, rather than numeric user IDs.
const accountIdentifier = (value: unknown): string => typeof value === 'string' && /^[\x21-\x7e]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : '';
const names = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 100).map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? text((item as Row).name || (item as Row).title, 100) : '').filter(Boolean).map(item => item.slice(0, 100)) : [];
const timestamp = (value: unknown): number => { const result = number(value); return result > 1e12 ? result / 1000 : result; };

function parse(value: unknown): Row | undefined {
  if (typeof value !== 'string' || value.length > 256 * 1024) return undefined;
  try { const result: unknown = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result as Row : undefined; }
  catch { return undefined; }
}

function series(row: Row): Series | undefined {
  const data = parse(row.series_json); if (!data) return undefined;
  const id = identifier(row.series_id);
  if (!id || ((data.seriesId || data.id) && identifier(data.seriesId || data.id) !== id)) return undefined;
  const title = text(data.title || data.name, 300).trim(); if (!title) return undefined;
  return { id, title, cover: text(data.cover || data.coverUrl, 5000), intro: text(data.intro || data.description, 20000),
    totalEpisodes: Math.min(100000, Math.floor(number(data.episodeCount ?? data.totalEpisodes ?? data.total_episodes))),
    tags: names(data.tags), actors: names(data.actors), ...(text(data.score, 20) ? { score: text(data.score, 20) } : {}) };
}

function columns(db: DatabaseSync, table: 'history' | 'favorites' | 'settings'): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => text(row.name)));
}

function readLibrary(db: DatabaseSync, uid: string): Library {
  const history: HistoryItem[] = [], favorites: Series[] = [];
  const historyColumns = columns(db, 'history');
  if (['series_id', 'series_json', 'last_episode', 'updated_at'].every(key => historyColumns.has(key))) {
    const optional = ['position', 'duration', 'watched_at'].filter(key => historyColumns.has(key));
    const rows = db.prepare(`SELECT series_id,series_json,last_episode,updated_at${optional.length ? ',' + optional.join(',') : ''} FROM history ORDER BY updated_at DESC LIMIT 10000`).all() as Row[];
    for (const row of rows) {
      const item = series(row); if (!item) continue;
      const data = parse(row.series_json) || {};
      const episode = Math.min(item.totalEpisodes || 100000, Math.max(1, Math.floor(number(row.last_episode, 1))));
      const duration = Math.min(86400, number(row.duration ?? data.duration));
      const position = Math.min(duration || 86400, number(row.position ?? data.lastPosition ?? data.position));
      history.push({ series: item, episode, position, duration, watchedAt: timestamp(row.watched_at ?? row.updated_at), uid });
    }
  }
  const favoriteColumns = columns(db, 'favorites');
  if (['series_id', 'series_json'].every(key => favoriteColumns.has(key))) {
    const order = favoriteColumns.has('updated_at') ? ' ORDER BY updated_at DESC' : '';
    const rows = db.prepare(`SELECT series_id,series_json FROM favorites${order} LIMIT 10000`).all() as Row[];
    for (const row of rows) { const item = series(row); if (item) favorites.push(item); }
  }
  return { history: [...new Map(history.sort((a, b) => b.watchedAt - a.watchedAt).map(item => [item.series.id, item])).values()].slice(0, 1000),
    favorites: [...new Map(favorites.map(item => [item.id, item])).values()].slice(0, 1000) };
}

function readSettings(db: DatabaseSync): Partial<Settings> | undefined {
  const available = columns(db, 'settings'); if (!available.has('key') || !available.has('value')) return undefined;
  const rows = db.prepare('SELECT key,value FROM settings LIMIT 1000').all() as Row[];
  const merged: Partial<Settings> = {};
  for (const row of rows) {
    const key = text(row.key), raw = text(row.value, 256 * 1024);
    if (['preferences', 'guoban:preferences', 'playback_preferences', 'settings'].includes(key)) {
      const data = parse(raw); if (!data) continue;
      Object.assign(merged, validateSettings({ ...data, autoplay: data.autoNext ?? data.autoplay, rate: data.playbackRate ?? data.rate } as Partial<Settings>));
    }
    if (key === 'quality' || key === 'guoban:quality') {
      let value: unknown = raw; try { value = JSON.parse(raw); } catch { /* A plain quality string is also valid. */ }
      Object.assign(merged, validateSettings({ quality: typeof value === 'string' ? value : '' }));
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

async function exists(file: string): Promise<boolean> {
  try { const info = await fs.stat(file); return info.isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new Error('旧版数据目录暂时无法读取'); }
}

async function readSession(file: string): Promise<Record<string, unknown> | undefined> {
  const info = await fs.stat(file); if (info.size > 128 * 1024) return undefined;
  const data = parse(await fs.readFile(file, 'utf8')); if (!data) return undefined;
  const uid = accountIdentifier(data.uid), token = text(data.token, 16384), cookie = text(data.cookie, 65536);
  if (!uid || !(token || cookie) || /[\r\n]/.test(token + cookie)) return undefined;
  const session: Record<string, unknown> = { uid };
  if (token) session.token = token;
  if (cookie) session.cookie = cookie;
  if (typeof data.user_name === 'string') session.user_name = text(data.user_name, 300);
  if (typeof data.mobile === 'string') session.mobile = text(data.mobile, 32);
  if (typeof data.saved_at === 'number' && Number.isFinite(data.saved_at)) session.saved_at = timestamp(data.saved_at);
  return session;
}

/** Read supported legacy files without touching the old installation, cache, cloud or outbox. */
export async function readLegacy(root: string, webviewRoot?: string): Promise<LegacyImport> {
  const directory = path.resolve(root), database = path.join(directory, 'guoban.sqlite3'), account = path.join(directory, 'desktop-account.json');
  const [hasDatabase, hasAccount] = await Promise.all([exists(database), exists(account)]);
  const result: LegacyImport = { library: { history: [], favorites: [] }, source: hasDatabase || hasAccount ? directory : '' };
  if (hasAccount) { try { result.session = await readSession(account); } catch { /* An unavailable credential must not prevent library migration. */ } }
  if (hasDatabase) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(database, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN;');
      result.library = readLibrary(db, typeof result.session?.uid === 'string' ? result.session.uid : 'local');
      result.settings = readSettings(db);
      db.exec('ROLLBACK');
    } catch { throw new Error('旧版观看数据库暂时无法读取，旧数据未被修改，请退出旧客户端后重试导入'); }
    finally { db?.close(); }
  }
  if (webviewRoot) {
    try { const preferences = await readLegacyPreferences(webviewRoot); if (Object.keys(preferences).length) { result.settings = { ...result.settings, ...preferences }; if (!result.source) result.source = path.resolve(webviewRoot); } }
    catch { /* Browser preference migration is optional; preserve validated SQLite/default preferences. */ }
  }
  return result;
}
