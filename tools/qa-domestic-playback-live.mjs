// Verify real, authenticated mobile sources in the PC renderer, using an isolated silent profile.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),installed=process.argv.includes('--installed');
const out=path.join(root,'_work/domestic-playback-live',installed?'installed':'current');
const profile=path.join(out,'profile');await mkdir(profile,{recursive:true});
for(const name of ['account-session.dpapi','desktop-device.json'])await copyFile(path.join(process.env.APPDATA,'红果桌面',name),path.join(profile,name));
const first='7663491547907755033',title='无敌财神！我觉醒了唯一隐藏职业';
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.name));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const decoded=episode=>page.evaluate(({first,episode})=>{const video=document.querySelector('video[data-active=true]');return video?.dataset.seriesId===first&&video.dataset.episode===String(episode)&&video.videoWidth>0&&video.readyState>=2&&video.currentTime>1&&!video.paused&&!document.querySelector('.player-error');},{first,episode});
try{
  await page.waitForSelector('.app-shell');await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:1,volume:0,autoplay:false,danmaku:{enabled:false}}));await page.reload();
  const search=page.getByLabel('搜索剧名、演员或关键词');await search.fill(title);await search.press('Enter');
  await page.locator(`.series-card[data-series-id="${first}"]`).first().locator('.series-poster-button').click({timeout:60000});
  await page.getByRole('dialog').getByRole('button',{name:'播放第 54 集',exact:true}).click({timeout:30000});
  for(const episode of [54,55,70]){
    if(episode!==54)await page.locator('.player-page .episode-grid button').filter({hasText:new RegExp(`^${episode}$`)}).click();
    await expect.poll(()=>decoded(episode),{timeout:90000}).toBe(true);
    const frame=await page.locator('video[data-active=true]').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,time:video.currentTime,series:video.dataset.seriesId,episode:Number(video.dataset.episode)}));
    check(`PC 实际解码第 ${episode} 集`,frame.series===first&&frame.episode===episode&&frame.width>0&&frame.time>1,frame);
    if(episode===54)await page.screenshot({path:path.join(out,'episode54.png')});
  }
  check('真实片源全程静音且无界面异常',errors.length===0&&await instance.evaluate(({webContents})=>webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'PC 真实后续集播放',ok:false,errorType:error.name});console.error(error.name);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
