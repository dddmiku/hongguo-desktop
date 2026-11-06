// Drive a genuine PC viewing action; never synthesize a library or cloud progress write.
import {_electron as electron} from '@playwright/test';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','official-sync-pc');await mkdir(out,{recursive:true});
const installRoot=path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop');
const executable=path.join(installRoot,'红果桌面.exe'),env={...process.env,TEMP:out,TMP:out};delete env.HG_TEST_DATA_DIR;
const dev=process.argv.includes('--dev');
const stopAt=Number(process.env.HG_SYNC_POSITION||45);
if(!Number.isFinite(stopAt)||stopAt<1||stopAt>3600)throw new Error('Invalid verification position');
const title='和离后我带女儿横扫魔域',sid='7698294694886788121';
await promisify(execFile)(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
 ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'build','close-installation-processes.ps1'),'-InstallDir',installRoot],{env,windowsHide:true,timeout:20000});
const instance=await electron.launch(dev?{args:[root],cwd:root,env,timeout:60000}:{executablePath:executable,args:[],env,timeout:60000});
const page=await instance.firstWindow();let result;
try{
 await page.waitForSelector('.app-shell',{timeout:30000});await page.evaluate(()=>window.hongguo.request('/health'));
 await page.getByRole('button',{name:'观看历史',exact:true}).click();await page.getByLabel('搜索观看历史').fill(title);
 await page.locator('.history-title').filter({hasText:title}).first().click();await page.waitForSelector('.detail-hero',{timeout:60000});
 await page.getByRole('button',{name:'播放第 20 集',exact:true}).click();
 await page.waitForFunction(stopAt=>{const v=document.querySelector('video[data-active=true]');return v?.dataset.episode==='20'&&v.currentTime>=stopAt&&!v.paused;},stopAt,{timeout:180000,polling:100});
 await page.keyboard.press('k');
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.paused);
 const media=await page.locator('video[data-active=true]').evaluate(v=>({episode:Number(v.dataset.episode),position:v.currentTime,width:v.videoWidth,height:v.videoHeight,paused:v.paused}));
 await page.waitForFunction(async({sid,position})=>{const h=await window.hongguo.getHistory({search:'和离后我带女儿横扫魔域'});return h.items.some(i=>i.series.id===sid&&i.episode===20&&i.position>=position-.1);},{sid,position:media.position},{timeout:20000});
 result={seriesId:sid,actualViewing:true,developmentBuild:dev,media,finishedAt:new Date().toISOString()};
 await page.screenshot({path:path.join(out,'pc-real-20.png')});
 const deadline=Date.now()+60000;
 let pending=true;
 while(pending&&Date.now()<deadline){
   const data=JSON.parse(await readFile(path.join(process.env.APPDATA,'红果桌面','library.json'),'utf8'));
   pending=Object.values(data.outbox??{}).some(item=>item.series?.id===sid);
   if(pending)await page.waitForTimeout(1000);
 }
 result.progressAcknowledged=!pending;
 if(pending)throw new Error('暂停后的真实进度仍待上报');
 console.log(JSON.stringify(result));
}finally{
 await writeFile(path.join(out,'result.json'),JSON.stringify(result??{failed:true},null,2));
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});
 if(!dev){const app=spawn(executable,[],{env,detached:true,stdio:'ignore',windowsHide:false});app.unref();}
}
