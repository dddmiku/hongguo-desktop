import fs from 'node:fs/promises';
import path from 'node:path';
import type { HistoryItem, Library, PlaybackProgress, Series, Settings } from '../shared/contracts';

export const defaults: Settings = { theme: 'dark', quality: '1080p', rate: 1, autoplay: true, volume: .8, cacheGB: 4, closeToTray: true, bossKey: 'CommandOrControl+Shift+B' };
type Data = { schema: 1; settings: Settings; libraries: Record<string, Library>; outbox: Record<string,HistoryItem> };
export function mergeHistory(local: HistoryItem[], remote: HistoryItem[], uid: string): HistoryItem[] {
  const map = new Map<string, HistoryItem>();
  for (const item of [...local, ...remote]) {
    if (item.uid !== uid || !/^\d+$/.test(item.series.id)) continue;
    const prev = map.get(item.series.id);
    if (!prev || item.watchedAt > prev.watchedAt) map.set(item.series.id, item);
  }
  return [...map.values()].sort((a, b) => b.watchedAt - a.watchedAt).slice(0, 1000);
}
export function validateSettings(value: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {};
  if (value.theme && ['dark', 'light', 'system'].includes(value.theme)) clean.theme = value.theme;
  if (value.quality && ['auto','1080p','720p','540p','480p'].includes(value.quality)) clean.quality = value.quality;
  if (typeof value.rate === 'number' && [.75,1,1.25,1.5,2,2.5,3].includes(value.rate)) clean.rate = value.rate;
  if (typeof value.volume === 'number' && Number.isFinite(value.volume)) clean.volume = Math.max(0,Math.min(1,value.volume));
  if (typeof value.cacheGB === 'number' && Number.isFinite(value.cacheGB)) clean.cacheGB = Math.max(1,Math.min(32,value.cacheGB));
  if (typeof value.autoplay === 'boolean') clean.autoplay = value.autoplay;
  if (typeof value.closeToTray === 'boolean') clean.closeToTray = value.closeToTray;
  if (typeof value.bossKey === 'string' && value.bossKey.length < 80 && /^(CommandOrControl|Control|Alt|Shift)(\+(CommandOrControl|Control|Alt|Shift))*\+[A-Z0-9]$/.test(value.bossKey)) clean.bossKey = value.bossKey;
  return clean;
}
export class Store {
  private data: Data = {schema:1,settings:{...defaults},libraries:{},outbox:{}};
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    await fs.mkdir(path.dirname(this.file), {recursive:true});
    try {
      const d = JSON.parse(await fs.readFile(this.file,'utf8'));
      if (d.schema === 1 && d.libraries && typeof d.libraries === 'object') this.data = {schema:1, settings:{...defaults,...validateSettings(d.settings || {})}, libraries:d.libraries,outbox:d.outbox&&typeof d.outbox==='object'?d.outbox:{}};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await fs.copyFile(this.file, this.file+'.bak').catch(()=>{});
    }
  }
  settings() { return {...this.data.settings}; }
  async saveSettings(value: Partial<Settings>) { this.data.settings = {...this.data.settings,...validateSettings(value)}; await this.persist(); return this.settings(); }
  library(uid: string): Library { return structuredClone(this.data.libraries[uid] || {history:[],favorites:[]}); }
  private current(uid: string) { return this.data.libraries[uid] ||= {history:[],favorites:[]}; }
  async progress(uid: string, value: PlaybackProgress) {
    if (!/^\d+$/.test(value.series.id) || !Number.isInteger(value.episode) || value.episode < 1 || !Number.isFinite(value.position) || !Number.isFinite(value.duration)) throw new Error('无效的播放进度');
    const item: HistoryItem = {...value, position:Math.max(0,value.position), duration:Math.max(0,value.duration), watchedAt:Date.now()/1000, uid};
    const lib = this.current(uid);
    lib.history = mergeHistory(lib.history,[item],uid);
    if(uid!=='local')this.data.outbox[uid+':'+value.series.id]=item;
    await this.persist();
    return item;
  }
  async favorite(uid:string,series:Series) {
    if (!/^\d+$/.test(series.id)) throw new Error('无效的剧集');
    const lib = this.current(uid), existing = lib.favorites.some(s=>s.id===series.id);
    lib.favorites = existing ? lib.favorites.filter(s=>s.id!==series.id) : [series,...lib.favorites].slice(0,1000);
    await this.persist(); return !existing;
  }
  async remove(uid:string,id:string) { const lib=this.current(uid); lib.history=lib.history.filter(i=>i.series.id!==id); delete this.data.outbox[uid+':'+id]; await this.persist(); return this.library(uid); }
  async merge(uid:string,history:HistoryItem[],favorites:Series[]|null) {
    const lib=this.current(uid); lib.history=mergeHistory(lib.history,history,uid);
    if (favorites) lib.favorites=[...new Map(favorites.filter(s=>/^\d+$/.test(s.id)).map(s=>[s.id,s])).values()].slice(0,1000);
    await this.persist(); return this.library(uid);
  }
  private persist() {
    const raw=JSON.stringify(this.data);
    this.writes=this.writes.catch(()=>{}).then(async()=>{await fs.writeFile(this.file+'.part',raw,'utf8');await fs.rename(this.file+'.part',this.file);});
    return this.writes;
  }
  flush() { return this.writes; }
  pending(uid:string) { return Object.values(this.data.outbox).filter(i=>i.uid===uid); }
  async acknowledge(item:HistoryItem) { const key=item.uid+':'+item.series.id;if(this.data.outbox[key]?.watchedAt===item.watchedAt){delete this.data.outbox[key];await this.persist();} }
}
