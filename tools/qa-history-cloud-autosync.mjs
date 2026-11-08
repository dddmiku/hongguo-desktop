// Real account reads in a fresh isolated profile. No SMS, login mutation or playback/progress writes.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {copyFile,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),out=path.join(root,'_work','history-cloud-autosync'),profile=path.join(out,'profile');
if(path.relative(out,profile)!=='profile')throw new Error('QA profile path escapes the workspace');
await mkdir(out,{recursive:true});await rm(profile,{recursive:true,force:true});await mkdir(profile);
await copyFile(path.join(process.env.APPDATA,'红果桌面','account-session.dpapi'),path.join(profile,'account-session.dpapi'));
const installed=process.argv.includes('--installed');
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
 await page.waitForSelector('.app-shell');
 await page.evaluate(()=>{window.__autoLibraryEvents=[];window.hongguo.onLibrary(library=>window.__autoLibraryEvents.push({recent:library.history.length,total:library.historyTotal}));});
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.request('/account/session')).loggedIn),{timeout:30000}).toBe(true);
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getLibrary()).history.length),{timeout:90000}).toBeGreaterThan(0);
 const automatic=await page.evaluate(async()=>{const library=await window.hongguo.getLibrary(),session=await window.hongguo.request('/account/session');return{library,uid:session.uid};});
 check('真实账号无需点击同步就自动取得云端记录',automatic.library.history.length>0&&automatic.library.history.every(item=>item.uid===automatic.uid),{recent:automatic.library.history.length,total:automatic.library.historyTotal});
 const homepage=await page.locator('.continue-card small').allTextContents();
 check('首页继续观看显示真实自动同步集数',homepage.some(text=>text.includes('第 '+automatic.library.history[0].episode+' 集')),{episode:automatic.library.history[0].episode,homeCards:homepage.length});
 const cloud=await page.evaluate(()=>window.hongguo.request('/account/history?limit=100&refresh=true'));
 check('自动同步记录属于真实手机历史接口',cloud.items.some(remote=>automatic.library.history.some(local=>local.series.id===remote.series.id&&local.episode===remote.episode)),{cloudPage:cloud.items.length,automaticRecent:automatic.library.history.length});
 const persisted=JSON.parse(await readFile(path.join(profile,'library.json'),'utf8'));
 check('只读云同步不生成待上传播放记录',Object.keys(persisted.outbox||{}).length===0,{pending:0});
 check('真实账号自动同步无界面错误',errors.length===0,errors);
}catch(error){
 const state=await page.evaluate(async()=>({library:await window.hongguo.getLibrary(),session:await window.hongguo.request('/account/session'),events:window.__autoLibraryEvents})).catch(()=>({}));
 const uid=value=>createHash('sha256').update(value||'local').digest('hex').slice(0,8);
 checks.push({name:'真实账号自动历史',ok:false,error:error.message,state:{recent:state.library?.history?.length,total:state.library?.historyTotal,loggedIn:state.session?.loggedIn,account:uid(state.session?.uid),libraryAccounts:[...new Set((state.library?.history||[]).map(item=>uid(item.uid)))],events:state.events}});console.error(error.stack);process.exitCode=1;
}
finally{await writeFile(path.join(out,installed?'installed-result.json':'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
