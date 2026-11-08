// Measure a genuinely cold source and repeated end-of-episode transitions in an isolated account-free app.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const baseline=process.argv.includes('--baseline'),installed=process.argv.includes('--installed'),cold=process.argv.includes('--cold');
const root=process.cwd(),label=baseline?'baseline':installed?'installed':cold?'cold-current':'current';
const out=path.join(root,'_work','playback-startup',label),profile=path.join(out,'profile');
await mkdir(out,{recursive:true});
if(cold){if(path.relative(out,profile)!=='profile')throw new Error('QA profile escapes workspace');await rm(profile,{recursive:true,force:true});}
const instance=await electron.launch({...(baseline||installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[],timeline=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const state=()=>page.evaluate(()=>{const video=document.querySelector('video[data-active=true]');return{episode:video?.dataset.episode,time:video?.currentTime,mediaDuration:video?.duration,buffered:video?.buffered.length?video.buffered.end(video.buffered.length-1):0,paused:video?.paused,ended:video?.ended,ready:video?.readyState,status:document.querySelector('.player-status')?.textContent,pending:document.querySelector('.switch-status')?.textContent,cover:!!document.querySelector('.player-startup-cover,.playback-placeholder'),eos:window.__eos||[]};});
try{
 await page.waitForSelector('.app-shell');
 await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:3,autoplay:true,volume:0,danmaku:{enabled:false}}));await page.reload();
 await page.evaluate(()=>{window.__eos=[];const original=MediaSource.prototype.endOfStream;MediaSource.prototype.endOfStream=function(...args){const video=document.querySelector('video[data-active=true]');window.__eos.push({time:video?.currentTime,duration:video?.duration,mediaDuration:this.duration});return original.apply(this,args);};});
 await instance.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('api:request');globalThis.__startupRequests=[];ipcMain.removeHandler('api:request');ipcMain.handle('api:request',async(...args)=>{const route=args[1],start=performance.now(),result=await original(...args);if(route.startsWith('/media/session'))globalThis.__startupRequests.push({route,ms:performance.now()-start,episode:args[2]?.body?.episode,phase:result?.phase,delivery:result?.delivery,duration:result?.duration,id:result?.id});return result;});});
 await page.getByLabel('搜索剧名、演员或关键词').fill('手握九阳神功');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 const card=page.locator('.series-card[data-series-id="7694200376563616792"]').first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();
 await page.waitForSelector('.detail-hero',{timeout:60000});
 for(let n=0;n<2;n++){const more=page.getByRole('button',{name:/显示更多集数/});if(await more.count())await more.click();}
 const start=performance.now();await page.getByRole('dialog').getByRole('button',{name:'播放第 150 集',exact:true}).click();
 await page.waitForTimeout(150);const first=await state();timeline.push({ms:performance.now()-start,...first});
 const preparingImage=first.cover?page.screenshot({path:path.join(out,'first-preparing.png')}):Promise.resolve();
 await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');return !!v&&v.readyState>=2&&v.videoWidth>0&&!v.paused&&v.currentTime>0&&!document.querySelector('.player-status')&&!document.querySelector('.switch-status');}),{timeout:180000,intervals:[50,100,200]}).toBe(true);
 const playing=await state(),firstPlayingMs=performance.now()-start;await preparingImage;
 console.log(JSON.stringify({firstPlayingMs,firstState:first,playing}));
 check('首次进入有实际解码画面',playing.ready>=2&&playing.time>0,{firstPlayingMs});
 const measurement=JSON.stringify({cold,firstPlayingMs,timeline,requests:await instance.evaluate(()=>globalThis.__startupRequests)},null,2);
 await writeFile(path.join(out,'first-start.json'),measurement);
 await writeFile(path.join(out,cold?'cold-first-start.json':'warm-first-start.json'),measurement);
 for(let n=0;n<4;n++){
  const before=await state();
  await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=false]');return !!v&&v.readyState>=2&&v.videoWidth>0&&v.paused;}),{timeout:120000}).toBe(true);
  await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),slider=document.querySelector('input[aria-label="播放进度"]');return !!v&&!!slider&&v.duration>=Number(slider.max)-.25;}),{timeout:30000}).toBe(true);
  await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=Math.max(0,v.duration-.2);});
  const started=performance.now();
  try{await expect.poll(()=>page.evaluate(()=>Number(document.querySelector('video[data-active=true]')?.dataset.episode)),{timeout:12000,intervals:[100,200,500]}).toBe(Number(before.episode)+1);}
  catch(error){timeline.push({ms:performance.now()-started,...await state()});throw error;}
  const after=await state();timeline.push({from:before.episode,transitionMs:performance.now()-started,...after});
  check('3倍速片尾自动切到第 '+after.episode+' 集',Number(after.episode)===Number(before.episode)+1&&!after.paused,{transitionMs:performance.now()-started,...after});
 }
 await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),slider=document.querySelector('input[aria-label="播放进度"]');return !!v&&!!slider&&v.duration>=Number(slider.max)-.25;}),{timeout:30000}).toBe(true);
 await page.keyboard.press('k');
 await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=v.duration-.2;});
 const pausedEpisode=Number((await state()).episode);await page.waitForTimeout(1500);
 check('手动暂停到片尾不会误触发下一集',Number((await state()).episode)===pausedEpisode&&(await state()).paused);
 await page.locator('.autoplay-switch input').click();
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getSettings()).autoplay),{timeout:10000}).toBe(false);
 await expect.poll(()=>page.locator('.autoplay-switch input').isChecked(),{timeout:10000}).toBe(false);
 await page.evaluate(()=>document.activeElement instanceof HTMLElement&&document.activeElement.blur());
 await page.keyboard.press('k');await page.waitForTimeout(1800);
 check('关闭自动连播后不会跳集',Number((await state()).episode)===pausedEpisode&&(await state()).paused);
 await page.locator('.autoplay-switch input').click();
 await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getSettings()).autoplay),{timeout:10000}).toBe(true);
 await page.evaluate(()=>document.activeElement instanceof HTMLElement&&document.activeElement.blur());
 await page.keyboard.press('k');
 await expect.poll(()=>page.evaluate(()=>Number(document.querySelector('video[data-active=true]')?.dataset.episode)),{timeout:120000}).toBe(pausedEpisode+1);
 check('重新开启连播并恢复播放后可以继续下一集',Number((await state()).episode)===pausedEpisode+1&&!(await state()).paused);
 await expect.poll(()=>page.evaluate(()=>Number(document.querySelector('video[data-active=true]')?.dataset.episode)),{timeout:120000,intervals:[200,500]}).toBe(pausedEpisode+2);
 check('从集首完整播放后自然续播下一集',Number((await state()).episode)===pausedEpisode+2&&!(await state()).paused);
 check('首次准备不长时间显示黑底',first.cover||first.ready>=2,{firstState:first});
 check('没有界面异常',errors.length===0,errors);
}catch(error){checks.push({name:'首播与自动连播',ok:false,error:error.message,final:await state().catch(()=>null)});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors,timeline,requests:await instance.evaluate(()=>globalThis.__startupRequests||[]).catch(()=>[])},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
