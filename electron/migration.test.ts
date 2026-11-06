import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readLegacy } from './migration';

const workspace = path.resolve('_work/migration-tests');
let directory: string;
const item = (id: string, title = '测试剧集') => ({ seriesId: id, title, cover: 'https://example.com/cover.jpg', intro: '合成数据库测试', actors: ['演员'], tags: ['题材'], episodeCount: 30 });
const schema = `CREATE TABLE history(series_id TEXT PRIMARY KEY,series_json TEXT,last_episode INTEGER,updated_at INTEGER);
CREATE TABLE favorites(series_id TEXT PRIMARY KEY,series_json TEXT,updated_at INTEGER);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);`;

beforeEach(async () => { await fs.mkdir(workspace, { recursive: true }); directory = await fs.mkdtemp(path.join(workspace, 'case-')); });
afterEach(async () => { if (directory.startsWith(workspace + path.sep)) await fs.rm(directory, { recursive: true, force: true }); });

function database(extra = '') { const db = new DatabaseSync(path.join(directory, 'guoban.sqlite3')); db.exec(schema + extra); return db; }
async function digest(file: string) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }

describe('legacy migration reader', () => {
  it('does not fabricate a legacy installation when files are absent', async () => {
    expect(await readLegacy(directory)).toEqual({ library: { history: [], favorites: [] }, source: '' });
  });
  it('maps the actual legacy schema and leaves the database and credentials unchanged', async () => {
    const db = database();
    db.prepare('INSERT INTO history VALUES (?,?,?,?)').run('100000000000000001', JSON.stringify(item('100000000000000001')), 7, 1790000100);
    db.prepare('INSERT INTO favorites VALUES (?,?,?)').run('100000000000000002', JSON.stringify(item('100000000000000002')), 1790000000);
    db.close();
    const account = path.join(directory, 'desktop-account.json');
    await fs.writeFile(account, JSON.stringify({ uid: '200000000000000001', token: 'fixture-token', cookie: 'fixture-cookie=1', user_name: '测试账号', mobile: 'fixture-mobile', saved_at: 1790000000, secret_extra: 'must-not-import' }));
    const before = await Promise.all([digest(path.join(directory, 'guoban.sqlite3')), digest(account)]);
    const result = await readLegacy(directory);
    expect(result.library.history[0]).toMatchObject({ episode: 7, position: 0, duration: 0, watchedAt: 1790000100, uid: '200000000000000001', series: { id: '100000000000000001', title: '测试剧集', totalEpisodes: 30 } });
    expect(result.library.favorites).toHaveLength(1);
    expect(Object.keys(result.session!)).toEqual(['uid', 'token', 'cookie', 'user_name', 'mobile', 'saved_at']);
    expect(await Promise.all([digest(path.join(directory, 'guoban.sqlite3')), digest(account)])).toEqual(before);
    expect(await readLegacy(directory)).toEqual(result);
  });
  it('reads a consistent WAL snapshot and imports explicit position columns when available', async () => {
    const db = database('ALTER TABLE history ADD COLUMN position REAL;ALTER TABLE history ADD COLUMN duration REAL;PRAGMA journal_mode=WAL;');
    db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?)').run('100000000000000003', JSON.stringify(item('100000000000000003')), 9, 1790000000000, 18.5, 90);
    const result = await readLegacy(directory);
    expect(result.library.history[0]).toMatchObject({ episode: 9, position: 18.5, duration: 90, watchedAt: 1790000000, uid: 'local' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM history').get()?.n).toBe(1);
    db.close();
  });
  it('skips malformed records and mismatched IDs without polluting the imported library', async () => {
    const db = database();
    db.prepare('INSERT INTO history VALUES (?,?,?,?)').run('100000000000000001', '{bad json', 7, 1790000100);
    db.prepare('INSERT INTO history VALUES (?,?,?,?)').run('100000000000000002', JSON.stringify(item('100000000000000009')), 7, 1790000100);
    db.prepare('INSERT INTO history VALUES (?,?,?,?)').run('not-an-id', JSON.stringify(item('not-an-id')), 7, 1790000100);
    db.close();
    expect((await readLegacy(directory)).library.history).toEqual([]);
  });
  it('imports only valid SQLite preferences and never reads WebView or arbitrary credential files', async () => {
    const db = database();
    db.prepare('INSERT INTO settings VALUES (?,?,?)').run('guoban:preferences', JSON.stringify({ autoNext: false, playbackRate: 3, theme: 'light', unsafe: 'ignored' }), 1);
    db.prepare('INSERT INTO settings VALUES (?,?,?)').run('guoban:quality', '720p', 1);
    db.close();
    await fs.writeFile(path.join(directory, 'desktop-account.json.backup'), JSON.stringify({ token: 'do-not-read', uid: '200000000000000001' }));
    const result = await readLegacy(directory);
    expect(result.settings).toEqual({ theme: 'light', rate: 3, autoplay: false, quality: '720p' });
    expect(result.session).toBeUndefined();
  });
  it('keeps library migration working when the fixed session file is invalid', async () => {
    const db = database(); db.close();
    await fs.writeFile(path.join(directory, 'desktop-account.json'), '{bad json');
    expect((await readLegacy(directory)).session).toBeUndefined();
  });
  it('preserves cookie-only sessions with a nonnumeric secure account identifier', async () => {
    await fs.writeFile(path.join(directory, 'desktop-account.json'), JSON.stringify({ uid: 'MS4wLjABAAAA_fixture-secure-id+/=', token: '', cookie: 'fixture-cookie=1' }));
    const result = await readLegacy(directory);
    expect(result.session).toEqual({ uid: 'MS4wLjABAAAA_fixture-secure-id+/=', cookie: 'fixture-cookie=1' });
  });
  it('rejects a damaged database with an actionable message and does not modify it', async () => {
    const file = path.join(directory, 'guoban.sqlite3'); await fs.writeFile(file, 'not-sqlite'); const before = await digest(file);
    await expect(readLegacy(directory)).rejects.toThrow('旧数据未被修改');
    expect(await digest(file)).toBe(before);
  });
});
