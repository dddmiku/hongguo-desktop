// Real main/preload/React/SQLite; simulated phone reads, never real account writes.
// Only the main-process clock is scaled 100x. No focus or manual refresh in the core repro.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),baseline=process.argv.includes('--baseline'),realTime=process.argv.includes('--real-time');
const scale=realTime?1:100,deadline=realTime?18000:550;
const out=path.join(root,'_work','continue-watch-qa',baseline?'baseline':realTime?'real-time':'current');
const fixture=path.join(out,'fixture'),profile=path.join(fixture,'profile');
if(path.relative(out,profile)!==path.join('fixture','profile'))throw new Error('QA profile escapes workspace');
await mkdir(fixture,{recursive:true});await rm(profile,{recursive:true,force:true});
await cp(path.join(root,'dist'),path.join(fixture,'dist'),{recursive:true});
await cp(path.join(root,'assets'),path.join(fixture,'assets'),{recursive:true});
await writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'continue-watching-qa',version:'1.0.0',main:'main.cjs'}));
const mock=String.raw`
globalThis.phone={revision:0,reads:[],writes:0,uid:'fixture-phone'};
const stamp=Date.now()/1000;
function rows(){return Array.from({length:8},(_,i)=>({series:{id:String(12345678+i),title:'续看测试 '+(i+1),cover:'',intro:'',totalEpisodes:100,tags:[],actors:[]},episode:i===0?1+phone.revision:1,position:i===0?10+phone.revision:10,duration:60,watchedAt:stamp-i*60+(i===0?phone.revision*1000:0),uid:phone.uid}));}
export class Supervisor {
 async start(){} async stop(){} async diagnostics(){return '';}
 async request(route,options={}){
  if(route==='/account/session')return{loggedIn:phone.uid!=='local',uid:phone.uid,nickname:'测试账号',avatar:'',mobile:''};
  if(route==='/account/logout'){phone.uid='local';return{};}
  if(route.startsWith('/account/history')){phone.reads.push({at:Date.now(),revision:phone.revision,fresh:route.includes('refresh=true')});return{items:rows(),hasMore:false,nextCursor:null,complete:true,total:8};}
  if(route.startsWith('/account/favorites'))return{items:[]};
  if(route.startsWith('/account/progress')){phone.writes++;throw new Error('Unexpected progress write in read-only QA');}
  if(route.startsWith('/catalog'))return{items:rows().map(row=>row.series),hasMore:false};
  return{};
 }
}`;
const plugins=[{name:'phone-fixture',setup(builder){
 if(baseline)builder.onLoad({filter:/electron[\/](main|preload|library-sync)\.ts$/},args=>({contents:execFileSync('git',['show','f9dc969:'+path.relative(root,args.path).replaceAll('\\','/')],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:path.dirname(args.path)}));
 builder.onResolve({filter:/^\.\/supervisor$/},()=>({path:'phone',namespace:'phone-fixture'}));
 builder.onLoad({filter:/.*/,namespace:'phone-fixture'},()=>({contents:mock,loader:'ts'}));
}}];
const clock=realTime?'':'const qaStart=performance.now(),qaDate=Date.now(),qaTimeout=globalThis.setTimeout;Date.now=()=>qaDate+(performance.now()-qaStart)*100;globalThis.setTimeout=(fn,ms,...args)=>qaTimeout(fn,ms>=15000?ms/100:ms,...args);';
await build({entryPoints:[path.join(root,'electron','main.ts')],outfile:path.join(fixture,'main.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],plugins,banner:{js:clock}});
await build({entryPoints:[path.join(root,'electron','preload.ts')],outfile:path.join(fixture,'preload.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],plugins});
const instance=await electron.launch({args:[fixture],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
const pass=(name,detail)=>{checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)));};
const nextPhone=revision=>instance.evaluate((_electron,revision)=>{phone.revision=revision;},revision);
const home=()=>page.locator('.discovery-resume').first();
try{
 await page.waitForSelector('.discovery-resume');await expect(home()).toContainText('第 1 集');
 pass('真实主进程自动读取手机初始历史');
 const oldUrl=page.url();
 for(const revision of realTime?[1,2]:[1,2,3]){
  await nextPhone(revision);const started=performance.now();
  await expect(home()).toContainText('第 '+(revision+1)+' 集',{timeout:deadline});
  pass('停留首页无焦点/切页/刷新，自动更新第 '+(revision+1)+' 集',{elapsedMs:Math.round(performance.now()-started),clockScale:scale});
 }
 if(page.url()!==oldUrl)throw new Error('Auto refresh navigated the page');
 const readState=await instance.evaluate(()=>({reads:phone.reads,writes:phone.writes}));
 if(readState.reads.some(read=>!read.fresh)||readState.writes)throw new Error('Automatic sync must fresh-read only');
 pass('自动同步强制取新历史且没有播放进度写入',{reads:readState.reads.length,writes:readState.writes});
 if(!realTime){
 await page.getByRole('button',{name:'设置',exact:true}).click();
 const reads=await instance.evaluate(()=>phone.reads.length);await nextPhone(4);await page.waitForTimeout(550);
 if(await instance.evaluate(()=>phone.reads.length)!==reads)throw new Error('Settings page retained high-frequency polling');
 pass('离开片库页面恢复低频同步，不持续抢占播放资源');
 await page.getByRole('button',{name:'发现',exact:true}).click();await expect(home()).toContainText('第 5 集',{timeout:550});
 pass('回到首页立即补取超过15秒的手机进度');
 await page.evaluate(()=>window.hongguo.setOnline(false));await nextPhone(5);
 const offlineReads=await instance.evaluate(()=>phone.reads.length);await page.waitForTimeout(550);
 if(await instance.evaluate(()=>phone.reads.length)!==offlineReads)throw new Error('Offline polling still active');
 await expect(home()).toContainText('第 5 集');
 await page.evaluate(()=>window.hongguo.setOnline(true));await expect(home()).toContainText('第 6 集',{timeout:550});
 pass('断网保留续看，恢复网络立即更新');
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].emit('hide'));
 const hiddenReads=await instance.evaluate(()=>phone.reads.length);await nextPhone(6);await page.waitForTimeout(550);
 if(await instance.evaluate(()=>phone.reads.length)!==hiddenReads)throw new Error('Hidden polling still active');
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].emit('show'));await expect(home()).toContainText('第 7 集',{timeout:550});
 pass('隐藏停轮询，窗口恢复后自动刷新');
 await page.getByRole('button',{name:'我的片库',exact:true}).click();await nextPhone(7);
 await expect(page.locator('.drawer-history').first()).toContainText('第 8 集',{timeout:550});
 pass('片库抽屉同样自动更新最新集数');
 }
 if(errors.length)throw new Error(errors.join('\n'));
}catch(error){checks.push({name:'续看近实时自动刷新',ok:false,error:error.message});console.error(error.message);process.exitCode=1;}
finally{await page.screenshot({path:path.join(out,'home.png')}).catch(()=>{});await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors,baseline,clockScale:scale,noManualFocusInCoreRepro:true},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
