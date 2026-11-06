// 只使用工作区内的合成账号与隔离SQLite，不读取真实userData。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {buildSync} from 'esbuild';

const require = createRequire(import.meta.url), root=process.cwd();
const base=path.join(root,'_work','history-migration-audit');
await fs.mkdir(base,{recursive:true});
const code=buildSync({entryPoints:[path.join(root,'electron','store.ts')],bundle:true,
  write:false,platform:'node',format:'cjs',external:['node:*']}).outputFiles[0].text;
const load=(overrides={})=>{const context={module:{exports:{}},exports:{},Buffer,structuredClone,
  console,process,require:name=>overrides[name]||require(name)};vm.runInNewContext(code,context);return context.module.exports.Store;};
const item=uid=>({series:{id:uid==='a'?'12345678':'87654321',title:'synthetic',cover:'',intro:'',
  totalEpisodes:2,tags:[],actors:[]},episode:1,position:10,duration:60,watchedAt:1700000000,uid});
const schema1={schema:1,settings:{},libraries:{a:{history:[item('a')],favorites:[]},b:{history:[item('b')],favorites:[]}},outbox:{}};
const results=[];
for(const name of ['backup-sharing-denied','later-account-sqlite-failure','corrupt-json-protects-backup']){
  const directory=path.join(base,name),file=path.join(directory,'library.json');
  if(path.dirname(path.resolve(directory))!==path.resolve(base))throw new Error('audit scope mismatch');
  await fs.mkdir(directory,{recursive:true});
  let store;
  try{
    const original=name==='corrupt-json-protects-backup'?'{"schema":1,"libraries":':JSON.stringify(schema1);
    const backup=JSON.stringify(schema1);
    await fs.writeFile(file,original);await fs.writeFile(file+'.bak',backup);
    const overrides={};
    if(name==='backup-sharing-denied')overrides['node:fs/promises']={...fs,rename:async(source,target,...args)=>{
      if(target===file+'.bak'){const error=new Error('synthetic backup sharing denial');error.code='EACCES';throw error;}
      return fs.rename(source,target,...args);
    }};
    if(name==='later-account-sqlite-failure'){
      let fail=true;
      class FaultyDatabase extends DatabaseSync{
        prepare(sql){const statement=super.prepare(sql);return new Proxy(statement,{get(target,key){
          if(key==='run'&&sql.includes('INSERT INTO history'))return(...args)=>{
            if(args[0]==='b'&&fail){fail=false;throw new Error('synthetic sqlite write failure');}
            return statement.run(...args);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});}
      }
      overrides['node:sqlite']={...require('node:sqlite'),DatabaseSync:FaultyDatabase};
    }
    store=new (load(overrides))(file);
    let failed=false;try{await store.load();}catch{failed=true;}
    const retained=await fs.readFile(file,'utf8'),backupRetained=await fs.readFile(file+'.bak','utf8');
    const observed={name,loadFailed:failed,originalPreserved:retained===original,
      backupPreserved:backupRetained===backup,schema:retained.startsWith('{"schema":2')?2:1};
    try{assert.equal(failed,true,'migration/read failure must reach caller');
      assert.equal(retained,original,'source JSON must not be overwritten on failure');
      assert.equal(backupRetained,backup,'last valid fixed backup must survive');
      if(name!=='corrupt-json-protects-backup'){
        store.close();store=new (load())(file);await store.load();
        assert.equal(store.library('a').historyTotal,1);assert.equal(store.library('b').historyTotal,1);
      }
      observed.ok=true;
    }catch(error){observed.ok=false;observed.failure=error.message;}
    results.push(observed);
  }finally{store?.close();await fs.rm(directory,{recursive:true,force:true});}
}
console.log(JSON.stringify(results,null,2));
if(results.some(result=>!result.ok))process.exitCode=1;
