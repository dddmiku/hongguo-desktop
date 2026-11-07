// Exercise the real Electron main, preload, React UI and SQLite with an isolated cloud fixture.
import {_electron as electron,expect} from '@playwright/test';
import {build} from 'esbuild';
import {cp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const baseline=process.argv.includes('--baseline');
const baselineRef='f0a13a76f759c11081ca8f8f351c14db23dc0cff';
const root=process.cwd(),out=path.join(root,'_work','history-autosync',baseline?'baseline':'current'),fixture=path.join(out,'fixture');
await mkdir(out,{recursive:true});await rm(fixture,{recursive:true,force:true});await mkdir(fixture);
await cp(path.join(root,'dist'),path.join(fixture,'dist'),{recursive:true});
await cp(path.join(root,'assets'),path.join(fixture,'assets'),{recursive:true});
await cp(path.join(root,'out','preload.cjs'),path.join(fixture,'preload.cjs'));
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
await writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'history-autosync-qa',version,main:'main.cjs'}));
const mock=`
const stamp=Date.now()/1000;
globalThis.cloud={uid:'fixture-a',revision:0,reads:[],offline:false,hold:false,releases:[]};
const history=(uid,revision)=>Array.from({length:120},(_,n)=>({series:{id:String(12345678+n),title:'历史剧 '+String(n+1).padStart(3,'0'),cover:'',intro:'',totalEpisodes:100,tags:[],actors:[]},episode:n===0?1+revision:1,position:n===0?10+revision:10,duration:60,watchedAt:stamp-n*60+(n===0?revision*1000:0),uid}));
export class Supervisor {
 async start(){} async stop(){} async diagnostics(){return '';}
 async request(route,options={}) {
  const cloud=globalThis.cloud;
  if(route==='/account/logout') {cloud.uid='local';return {};}
  if(route==='/account/login') {cloud.uid=options.body.uid;return {};}
  if(route==='/account/session')return {loggedIn:cloud.uid!=='local',uid:cloud.uid,nickname:'测试账号',avatar:'',mobile:''};
  if(route.startsWith('/account/history')) {
   const uid=cloud.uid,revision=cloud.revision,query=new URL('http://fixture'+route),cursor=query.searchParams.get('cursor');
   cloud.reads.push({uid,revision,cursor});
   if(cloud.offline)throw new Error('fixture offline');
   if(cloud.hold)await new Promise(resolve=>cloud.releases.push(resolve));
   const rows=history(uid,revision),start=cursor?100:0;
   return {items:rows.slice(start,start+100),hasMore:!cursor,nextCursor:cursor?null:'older',complete:!!cursor,total:120};
  }
  if(route==='/account/favorites')return {items:[]};
  if(route.startsWith('/catalog'))return {items:history(cloud.uid,0).slice(0,20).map(item=>item.series),hasMore:false};
  return {ok:true};
 }
}`;
await build({entryPoints:[path.join(root,'electron','main.ts')],outfile:path.join(fixture,'main.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],plugins:[{name:'cloud-fixture',setup(builder){
 if(baseline)builder.onLoad({filter:/electron[\\/]main\.ts$/},()=>({contents:execFileSync('git',['show',baselineRef+':electron/main.ts'],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:path.join(root,'electron')}));
 builder.onResolve({filter:/^\.\/supervisor$/},()=>({path:'fixture',namespace:'cloud'}));builder.onLoad({filter:/.*/,namespace:'cloud'},()=>({contents:mock,loader:'ts'}));}}]});
const instance=await electron.launch({args:[fixture],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(fixture,'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:30000});
const page=await instance.firstWindow(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const pass=(name,detail)=>{checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)));};
const advance=async(ms=61000)=>instance.evaluate((_electron,ms)=>{const now=Date.now();Date.now=()=>now+ms;},ms);
const focus=()=>instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].emit('focus'));
try {
 await page.waitForSelector('.app-shell');
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getLibrary()).historyTotal),{timeout:3000}).toBeGreaterThanOrEqual(100);
 pass('启动时云历史自动写入SQLite');
 await page.waitForFunction(()=>document.querySelector('.continue-card small')?.textContent?.includes('第 1 集'));
 await instance.evaluate(()=>{globalThis.cloud.revision=1;});await advance();await focus();
 await page.waitForFunction(()=>document.querySelector('.continue-card small')?.textContent?.includes('第 2 集'),undefined,{timeout:3000});
 pass('停留首页时接着看自动刷新，无需进入历史页');
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await instance.evaluate(()=>{globalThis.cloud.revision=2;});await advance();
 await page.getByRole('button',{name:'发现',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.continue-card small')?.textContent?.includes('第 3 集'),undefined,{timeout:3000});
 pass('从其他页面回首页自动刷新，保留片单');
 await page.getByRole('button',{name:'观看历史',exact:true}).click();
 await page.waitForSelector('.history-card');
 await instance.evaluate(()=>{globalThis.cloud.revision=3;});await advance();await focus();
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getHistory()).items[0]?.episode),{timeout:3000}).toBe(4);
 await page.waitForFunction(()=>document.querySelector('.history-card .history-info p')?.textContent?.includes('第 4 集'),undefined,{timeout:3000});
 pass('返回客户端后手机新进度自动更新列表，无需点击同步');
 await page.getByRole('button',{name:'更早的观看记录'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===100);
 await instance.evaluate(()=>{globalThis.cloud.revision=4;});await advance();await focus();
 await page.waitForFunction(()=>document.querySelector('.history-card .history-info p')?.textContent?.includes('第 5 集'));
 if(await page.locator('.history-card').count()<100)throw new Error('自动同步把已展开的历史重置为第一页');
 pass('自动刷新保留已展开的历史分页');
 await page.getByLabel('搜索观看历史').fill('001');
 await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===1);
 await instance.evaluate(()=>{globalThis.cloud.revision=5;});await advance();await focus();
 await page.waitForFunction(()=>document.querySelector('.history-card .history-info p')?.textContent?.includes('第 6 集'));
 if(await page.getByLabel('搜索观看历史').inputValue()!=='001'||await page.locator('.history-card').count()!==1)throw new Error('自动刷新清空了历史搜索或筛选');
 pass('自动刷新保留历史搜索与匹配结果');
 await page.getByRole('button',{name:'清除历史搜索'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===50);
 const reads=await instance.evaluate(()=>globalThis.cloud.reads.filter(read=>!read.cursor).length);
 for(let n=0;n<5;n++){await focus();await page.getByRole('button',{name:'发现',exact:true}).click();await page.getByRole('button',{name:'观看历史',exact:true}).click();}
 await page.waitForTimeout(250);
 if(await instance.evaluate(()=>globalThis.cloud.reads.filter(read=>!read.cursor).length)!==reads)throw new Error('频繁切换触发重复云端同步');
 pass('短时间反复聚焦和切页合并为一次同步');
 await page.getByRole('button',{name:'发现',exact:true}).click();
 await instance.evaluate(()=>{globalThis.cloud.revision=6;});await advance();
 await page.getByRole('button',{name:'我的片库',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.drawer-history small')?.textContent?.includes('第 7 集'));
 pass('打开片库抽屉自动更新继续观看');
 await instance.evaluate(()=>{globalThis.cloud.offline=true;});await advance();await focus();await page.waitForTimeout(100);
 if((await page.evaluate(()=>window.hongguo.getLibrary())).history[0].episode!==7)throw new Error('同步失败丢失本机进度');
 await page.evaluate(async()=>{window.__qaOnline=false;Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>window.__qaOnline});window.dispatchEvent(new Event('offline'));await window.hongguo.getLibrary();});
 await instance.evaluate(()=>{globalThis.cloud.offline=false;globalThis.cloud.revision=7;});
 await page.evaluate(()=>{window.__qaOnline=true;window.dispatchEvent(new Event('online'));});
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getLibrary()).history[0]?.episode),{timeout:3000}).toBe(8);
 await page.evaluate(()=>window.hongguo.syncLibrary({background:true}));
 pass('断网保留记录，网络恢复后自动补同步');
 await instance.evaluate(()=>{globalThis.cloud.hold=true;globalThis.cloud.revision=8;});await advance();await focus();
 await expect.poll(()=>instance.evaluate(()=>globalThis.cloud.releases.length),{timeout:3000}).toBeGreaterThan(0);
 await page.evaluate(()=>window.hongguo.request('/account/logout',{method:'POST'}));
 await page.evaluate(()=>window.hongguo.request('/account/login',{method:'POST',body:{uid:'fixture-b'}}));
 await instance.evaluate(()=>{globalThis.cloud.hold=false;globalThis.cloud.releases.splice(0).forEach(resolve=>resolve());});
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getLibrary()).history[0]?.uid),{timeout:3000}).toBe('fixture-b');
 const library=await page.evaluate(()=>window.hongguo.getLibrary());
 if(library.history.some(item=>item.uid!=='fixture-b'))throw new Error('切换账号混入上个账号同步结果');
 pass('同步中切换账号自动拉取新账号并隔离旧响应');
 await page.screenshot({path:path.join(out,'automatic-history.png')});
 if(errors.length)throw new Error(errors.join('\n'));
}catch(error){
 const detail=await page.evaluate(async()=>({library:await window.hongguo.getLibrary(),firstCard:document.querySelector('.history-card .history-info p')?.textContent,home:document.querySelector('.continue-card small')?.textContent})).catch(()=>({}));
 const cloud=await instance.evaluate(()=>({reads:globalThis.cloud.reads,uid:globalThis.cloud.uid,revision:globalThis.cloud.revision})).catch(()=>({}));
 checks.push({name:'历史自动同步',ok:false,error:error.message,detail,cloud});console.error(error.stack);process.exitCode=1;
}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
