import {describe,it,expect} from 'vitest';
import {Store,mergeHistory,validateSettings} from './store';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {HistoryItem,Series} from '../shared/contracts';
const series:Series={id:'1234567890123456789',title:'测试剧',cover:'',intro:'',totalEpisodes:30,tags:[],actors:[]};
const item=(episode:number,at:number,uid='a'):HistoryItem=>({series,episode,position:5,duration:60,watchedAt:at,uid});
describe('历史合并',()=>{
  it('按真实观看时间选择进度，允许回看更早的集数',()=>expect(mergeHistory([item(20,10)],[item(3,20)],'a')[0].episode).toBe(3));
  it('隔离账号且保留元数据为空的真实记录',()=>expect(mergeHistory([item(1,10,'b')],[item(2,20,'a')],'a')).toEqual([item(2,20,'a')]));
  it('重复同步不会使条数增长',()=>{let list=[item(1,10)];for(let i=0;i<10;i++)list=mergeHistory(list,[item(2,20)],'a');expect(list).toHaveLength(1);});
});
describe('本机存储',()=>{
  it('离线上报队列落盘，旧请求确认不会删除更新进度',async()=>{await mkdir(path.join(process.cwd(),'_work'),{recursive:true});const dir=await mkdtemp(path.join(process.cwd(),'_work/outbox-'));try{const s=new Store(path.join(dir,'library.json'));await s.load();const first=await s.progress('a',{series,episode:3,position:10,duration:60});await new Promise(r=>setTimeout(r,2));await s.progress('a',{series,episode:3,position:20,duration:60});await s.acknowledge(first);const restored=new Store(path.join(dir,'library.json'));await restored.load();expect(restored.pending('a')).toHaveLength(1);expect(restored.pending('a')[0].position).toBe(20);expect(restored.pending('b')).toHaveLength(0);}finally{await rm(dir,{recursive:true,force:true});}});
  it('并发保存后可重新读取且账号隔离',async()=>{const dir=await mkdtemp(path.join(process.cwd(),'_work/store-'));try{const file=path.join(dir,'library.json'),s=new Store(file);await s.load();await Promise.all([s.progress('a',{series,episode:3,position:20,duration:60}),s.favorite('b',series),s.saveSettings({rate:2})]);const reloaded=new Store(file);await reloaded.load();expect(reloaded.library('a').history[0].episode).toBe(3);expect(reloaded.library('a').favorites).toHaveLength(0);expect(reloaded.library('b').favorites).toHaveLength(1);expect(reloaded.settings().rate).toBe(2);expect(JSON.parse(await readFile(file,'utf8')).schema).toBe(1);}finally{await rm(dir,{recursive:true,force:true});}});
  it('过滤无效设置，限制缓存容量',()=>expect(validateSettings({rate:99,cacheGB:100,quality:'bad',volume:-1})).toEqual({cacheGB:32,volume:0}));
});
