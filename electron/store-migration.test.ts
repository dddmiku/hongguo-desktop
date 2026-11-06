import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Store} from './store';
import {HistoryStore} from './history-store';
import type {HistoryItem} from '../shared/contracts';

const history=(uid:string):HistoryItem=>({series:{id:uid==='a'?'12345678':'87654321',title:'合成历史',cover:'',intro:'',
  totalEpisodes:2,tags:[],actors:[]},episode:1,position:10,duration:60,watchedAt:1700000000000,uid});
const schema1=()=>({schema:1,settings:{},libraries:{a:{history:[history('a')],favorites:[]},b:{history:[history('b')],favorites:[]}},outbox:{}});
const roots:string[]=[],stores:Store[]=[];
async function fixture(raw=JSON.stringify(schema1())){await fs.mkdir(path.join(process.cwd(),'_work'),{recursive:true});
  const root=await fs.mkdtemp(path.join(process.cwd(),'_work/store-migration-'));roots.push(root);
  const file=path.join(root,'library.json');await fs.writeFile(file,raw);return {file,raw};}
function store(file:string){const value=new Store(file);stores.push(value);return value;}
afterEach(async()=>{vi.restoreAllMocks();for(const value of stores.splice(0))value.close();
  for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

describe('JSON历史迁移失败不丢数据',()=>{
  it('第二账号写SQLite失败时源JSON保持schema1，重启幂等补齐全部账号',async()=>{
    const {file,raw}=await fixture();const original=HistoryStore.prototype.merge;
    const spy=vi.spyOn(HistoryStore.prototype,'merge').mockImplementation(function(this:HistoryStore,uid,items,local){
      if(uid==='b')throw new Error('synthetic SQLite failure');return original.call(this,uid,items,local);
    });
    await expect(store(file).load()).rejects.toThrow('迁移或保存未完成');
    expect(await fs.readFile(file,'utf8')).toBe(raw);expect(await fs.readFile(file+'.bak','utf8')).toBe(raw);
    spy.mockRestore();const retry=store(file);await retry.load();
    expect(retry.library('a').historyTotal).toBe(1);expect(retry.library('b').historyTotal).toBe(1);
    expect(JSON.parse(await fs.readFile(file,'utf8')).schema).toBe(2);
    expect(retry.library('a').history[0].watchedAt).toBe(1700000000);
  });

  it('备份槽被占用时不清JSON，也不覆盖之前的有效备份',async()=>{
    const {file,raw}=await fixture();const backup='last validated backup';await fs.writeFile(file+'.bak',backup);
    const rename=fs.rename;const spy=vi.spyOn(fs,'rename').mockImplementation(async(source,target)=>{
      if(String(target)===file+'.bak')throw Object.assign(new Error('synthetic sharing violation'),{code:'EACCES'});
      return rename(source,target);
    });
    await expect(store(file).load()).rejects.toThrow('迁移或保存未完成');
    expect(await fs.readFile(file,'utf8')).toBe(raw);expect(await fs.readFile(file+'.bak','utf8')).toBe(backup);
    spy.mockRestore();const retry=store(file);await retry.load();expect(retry.library('b').historyTotal).toBe(1);
  });

  it('坏JSON不覆盖原文和之前的有效备份',async()=>{
    const {file,raw}=await fixture('{"schema":1,"libraries":');const backup=JSON.stringify(schema1());
    await fs.writeFile(file+'.bak',backup);await expect(store(file).load()).rejects.toThrow('片库格式异常');
    expect(await fs.readFile(file,'utf8')).toBe(raw);expect(await fs.readFile(file+'.bak','utf8')).toBe(backup);
  });

  it('未来schema不降级覆盖，读取失败不落空片库',async()=>{
    const {file,raw}=await fixture(JSON.stringify({...schema1(),schema:999}));
    await expect(store(file).load()).rejects.toThrow('版本暂不支持');expect(await fs.readFile(file,'utf8')).toBe(raw);
    const read=fs.readFile;vi.spyOn(fs,'readFile').mockImplementation(async(...args)=>{
      if(String(args[0])===file)throw Object.assign(new Error('synthetic read denied'),{code:'EACCES'});
      return read(...args);
    });
    await expect(store(file).load()).rejects.toThrow('暂时无法读取');
  });

  it('提交schema2原子替换失败时保留schema1，重试不会漏或重复记录',async()=>{
    const {file,raw}=await fixture();const rename=fs.rename;
    const spy=vi.spyOn(fs,'rename').mockImplementation(async(source,target)=>{
      if(String(target)===file)throw new Error('synthetic final rename failure');return rename(source,target);
    });
    await expect(store(file).load()).rejects.toThrow('迁移或保存未完成');
    expect(await fs.readFile(file,'utf8')).toBe(raw);expect(await fs.readFile(file+'.bak','utf8')).toBe(raw);
    spy.mockRestore();const retry=store(file);await retry.load();
    expect(retry.library('a').historyTotal).toBe(1);expect(retry.library('b').historyTotal).toBe(1);
  });

  it('ENOENT首次创建schema2默认设置，并恢复历史残留的schema2',async()=>{
    const {file}=await fixture();await fs.rm(file);const fresh=store(file);await fresh.load();
    expect(fresh.library('a').historyTotal).toBe(0);expect(JSON.parse(await fs.readFile(file,'utf8')).schema).toBe(2);
    fresh.close();await fs.writeFile(file,JSON.stringify({...schema1(),schema:2}));
    const recovered=store(file);await recovered.load();expect(recovered.library('a').historyTotal).toBe(1);
  });

  it('来源账号不一致的JSON不迁入其他账号，也不被悄悄清除',async()=>{
    const value=schema1();value.libraries.a.history[0].uid='b';
    const {file,raw}=await fixture(JSON.stringify(value));
    await expect(store(file).load()).rejects.toThrow('片库格式异常');
    expect(await fs.readFile(file,'utf8')).toBe(raw);
  });
});
