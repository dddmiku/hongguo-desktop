import fs from 'node:fs/promises';
import path from 'node:path';
import type { HistoryItem, HistoryQuery, Library, PlaybackProgress, Series, Settings } from '../shared/contracts';
import { HistoryStore,epochSeconds } from './history-store';
import { defaultDanmaku, danmakuPreferences } from '../shared/danmaku-settings';

export const defaults: Settings = { theme: 'dark', quality: '1080p', rate: 1, autoplay: true, volume: .8, cacheGB: 4, closeToTray: true, bossKey: 'CommandOrControl+Shift+B', danmaku: defaultDanmaku };
type Data = { schema: 1|2; settings: Settings; libraries: Record<string, Library>; outbox: Record<string,HistoryItem> };
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function storedHistory(value:unknown):value is HistoryItem {
  return record(value)&&record(value.series)&&typeof value.series.id==='string'&&/^\d+$/.test(value.series.id)&&
    Number.isInteger(value.episode)&&Number(value.episode)>0&&Number.isFinite(value.position)&&Number.isFinite(value.duration);
}
function storedData(raw:string):Data {
  const value:unknown=JSON.parse(raw);
  if(!record(value)||(value.schema!==1&&value.schema!==2)||!record(value.libraries))throw new Error('invalid schema');
  const libraries:Record<string,Library>=Object.create(null);
  for(const [uid,library]of Object.entries(value.libraries)){
    if(!record(library)||!Array.isArray(library.history)||!library.history.every(item=>storedHistory(item)&&item.uid===uid)||!Array.isArray(library.favorites)||
      !library.favorites.every(series=>record(series)&&typeof series.id==='string'&&/^\d+$/.test(series.id)))throw new Error('invalid library');
    libraries[uid]={history:library.history,favorites:library.favorites as Series[]};
  }
  if(value.settings!==undefined&&!record(value.settings))throw new Error('invalid settings');
  if(value.outbox!==undefined&&(!record(value.outbox)||!Object.values(value.outbox).every(storedHistory)))throw new Error('invalid outbox');
  if(record(value.outbox)&&Object.entries(value.outbox).some(([key,item])=>!storedHistory(item)||typeof item.uid!=='string'||key!==item.uid+':'+item.series.id))throw new Error('invalid outbox owner');
  return {schema:value.schema,settings:{...defaults,...validateSettings(value.settings||{})},libraries,
    outbox:{...(value.outbox||{})} as Record<string,HistoryItem>};
}
export function mergeHistory(local: HistoryItem[], remote: HistoryItem[], uid: string): HistoryItem[] {
  const map = new Map<string, HistoryItem>();
  for (const item of [...local, ...remote]) {
    if (item.uid !== uid || !/^\d+$/.test(item.series.id)) continue;
    const normalized={...item,watchedAt:epochSeconds(item.watchedAt)};const prev = map.get(item.series.id);
    if (!prev || normalized.watchedAt > prev.watchedAt) map.set(item.series.id, normalized);
  }
  return [...map.values()].sort((a, b) => b.watchedAt - a.watchedAt);
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
  if (record(value.danmaku)) clean.danmaku = danmakuPreferences(value.danmaku);
  if (typeof value.bossKey === 'string' && value.bossKey.length < 80 && /^(CommandOrControl|Control|Alt|Shift)(\+(CommandOrControl|Control|Alt|Shift))*\+[A-Z0-9]$/.test(value.bossKey)) clean.bossKey = value.bossKey;
  return clean;
}
export class Store {
  private data: Data = {schema:1,settings:{...defaults},libraries:{},outbox:{}};
  private writes: Promise<void> = Promise.resolve();
  private history!:HistoryStore;
  private historyClosed=true;
  constructor(private file: string) {}
  async load() {
    let raw:string|null=null;
    try {
      await fs.mkdir(path.dirname(this.file), {recursive:true});
      try{raw=await fs.readFile(this.file,'utf8');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }catch{throw new Error('本机片库暂时无法读取，原文件未修改，请关闭其他客户端后重试');}
    let candidate:Data;
    try{candidate=raw===null?{schema:2,settings:{...defaults},libraries:{},outbox:{}}:storedData(raw);}
    catch{throw new Error('本机片库格式异常或版本暂不支持，原文件和备份均已保留，请先导出诊断');}
    const previous=this.data;
    try{
      this.close();
      this.history=new HistoryStore(path.join(path.dirname(this.file),'history.sqlite3'));
      this.historyClosed=false;
      // 兼容先前异常中断后仍有内嵌JSON历史的schema2；逐账号写入可幂等重试。
      const embedded=Object.values(candidate.libraries).some(library=>library.history.length>0);
      if(raw!==null&&(candidate.schema===1||embedded)){
        // 先验证源数据，再原子更新一个固定备份槽；失败不破坏上一份有效备份。
        const backup=this.file+'.bak',pending=backup+'.part';
        await fs.writeFile(pending,raw,'utf8');await fs.rename(pending,backup);
        for(const [uid,library]of Object.entries(candidate.libraries))this.history.merge(uid,library.history);
        // 所有账号成功后才清除JSON历史、提交schema2，失败保留完整schema1原文。
        for(const library of Object.values(candidate.libraries))library.history=[];
      }
      for(const entry of Object.values(candidate.outbox))entry.watchedAt=epochSeconds(entry.watchedAt);
      candidate.schema=2;this.data=candidate;
      await this.persist();
    }catch{
      this.data=previous;this.close();
      throw new Error('本机片库迁移或保存未完成，原文件与有效备份已保留，请重试启动');
    }
  }
  settings() { return structuredClone(this.data.settings); }
  async saveSettings(value: Partial<Settings>) { this.data.settings = {...this.data.settings,...validateSettings(value)}; await this.persist(); return this.settings(); }
  library(uid: string): Library { const lib=this.data.libraries[uid];return {history:this.history.query(uid,{limit:50}).items,favorites:structuredClone(lib?.favorites||[]),historyTotal:this.history.count(uid)}; }
  historyPage(uid:string,query:HistoryQuery={}){return this.history.query(uid,query);}
  private current(uid: string) { return this.data.libraries[uid] ||= {history:[],favorites:[]}; }
  async progress(uid: string, value: PlaybackProgress) {
    if (!/^\d+$/.test(value.series.id) || !Number.isInteger(value.episode) || value.episode < 1 || !Number.isFinite(value.position) || !Number.isFinite(value.duration)) throw new Error('无效的播放进度');
    const item: HistoryItem = {...value, position:Math.max(0,value.position), duration:Math.max(0,value.duration), watchedAt:Date.now()/1000, uid};
    const lib = this.current(uid);
    this.history.merge(uid,[item],true);
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
  async remove(uid:string,id:string) { this.history.remove(uid,id);delete this.data.outbox[uid+':'+id]; await this.persist(); return this.library(uid); }
  async merge(uid:string,history:HistoryItem[],favorites:Series[]|null) {
    const lib=this.current(uid);this.history.merge(uid,history);
    if (favorites) lib.favorites=[...new Map(favorites.filter(s=>/^\d+$/.test(s.id)).map(s=>[s.id,s])).values()].slice(0,1000);
    await this.persist(); return this.library(uid);
  }
  private persist() {
    const raw=JSON.stringify(this.data);
    this.writes=this.writes.catch(()=>{}).then(async()=>{await fs.writeFile(this.file+'.part',raw,'utf8');await fs.rename(this.file+'.part',this.file);});
    return this.writes;
  }
  flush() { return this.writes; }
  close(){if(!this.historyClosed){this.history.close();this.historyClosed=true;}}
  pending(uid:string) { return Object.values(this.data.outbox).filter(i=>i.uid===uid); }
  async acknowledge(item:HistoryItem) { const key=item.uid+':'+item.series.id;if(this.data.outbox[key]?.watchedAt===item.watchedAt){delete this.data.outbox[key];await this.persist();} }
}
