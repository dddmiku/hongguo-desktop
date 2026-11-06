import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const root=process.cwd(),out=path.join(root,'_work','seamless-qa');await mkdir(out,{recursive:true});
const instance=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(root,'_work','seamless-data')},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
const check=(name,ok,detail)=>{if(!ok)throw new Error(name+': '+JSON.stringify(detail));checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));};
try{
  await page.waitForSelector('.series-card',{timeout:90000});
  await page.evaluate(()=>window.hongguo.saveSettings({autoplay:false,rate:1,quality:'1080p'}));
  await page.reload();await page.waitForSelector('.series-card',{timeout:90000});
  await page.locator('.series-poster-button').first().click();await page.waitForSelector('.detail-hero',{timeout:90000});
  await page.getByRole('dialog').getByRole('button',{name:/立即播放|继续第/}).first().click();await page.waitForSelector('.player-page');
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.currentTime>3&&!v.paused;},undefined,{timeout:180000});
  check('真实活动视频解码',true,await page.locator('video[data-active=true]').evaluate(v=>({width:v.videoWidth,height:v.videoHeight,time:v.currentTime})));
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=false]');return v&&v.readyState>=2&&v.videoWidth>0&&v.paused;},undefined,{timeout:120000});
  await page.evaluate(()=>{window.__samples=[];window.__sample=true;const c=document.createElement('canvas');c.width=32;c.height=18;const ctx=c.getContext('2d',{willReadFrequently:true});const sample=()=>{if(!window.__sample)return;const v=document.querySelector('video[data-active=true]');let light=-1;if(v&&v.readyState>=2&&v.videoWidth){try{ctx.drawImage(v,0,0,32,18);const data=ctx.getImageData(0,0,32,18).data;let sum=0;for(let i=0;i<data.length;i+=4)sum+=data[i]+data[i+1]+data[i+2];light=sum/(32*18*3);}catch{}}window.__samples.push({at:performance.now(),episode:v?.dataset.episode,ready:v?.readyState,width:v?.videoWidth,light});requestAnimationFrame(sample);};requestAnimationFrame(sample);});
  const before=await page.locator('video[data-active=true]').evaluate(v=>Number(v.dataset.episode));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('下一集（J）').click();
  await page.waitForFunction(expected=>document.querySelector('video[data-active=true]')?.dataset.episode===String(expected),before+1,{timeout:120000});
  await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>1,undefined,{timeout:60000});
  const sampled=await page.evaluate(()=>{window.__sample=false;return window.__samples;});
  const invalid=sampled.filter(s=>s.ready<2||!s.width||s.light<0),black=sampled.filter(s=>s.light>=0&&s.light<1);const switched=sampled.findIndex(s=>s.episode===String(before+1));const frameGap=switched>0?sampled[switched].at-sampled[switched-1].at:null;
  check('暖切集过程无媒体清空或黑帧',invalid.length===0&&black.length===0,{frames:sampled.length,invalid:invalid.length,black:black.length,frameGapMs:frameGap});
  await writeFile(path.join(out,'frames.json'),JSON.stringify(sampled,null,2));await page.screenshot({path:path.join(out,'after-switch.png')});
  const onScreen=await page.evaluate(()=>{const active=document.querySelector('video[data-active=true]');return [...document.querySelectorAll('video')].filter(v=>!v.paused&&!v.muted&&v.volume>0).length===1&&active.readyState>=2;});check('只有活动槽有声音',onScreen);
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('全屏（F）').click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.keyboard.press('j');await page.keyboard.press('j');await page.waitForFunction(expected=>Number(document.querySelector('video[data-active=true]')?.dataset.episode)===expected,before+3,{timeout:120000});
  check('快速连续切集只提交最后一集且保留全屏',await page.evaluate(()=>!!document.fullscreenElement&&document.querySelector('video[data-active=true]').readyState>=2));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);check('退出全屏仍是同一个播放器',await page.locator('.player-page').count()===1);
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('暂停（空格）').click();
  await page.getByLabel('播放画质').selectOption('720p');
  await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.readyState>=2&&document.querySelector('video[data-active=true]')?.paused&&document.querySelector('.switch-status')===null,undefined,{timeout:120000});
  check('暂停时切画质仍保持暂停',await page.locator('video[data-active=true]').evaluate(v=>v.paused));
  await page.getByTitle('播放（空格）').click();await page.waitForFunction(()=>!document.querySelector('video[data-active=true]').paused);
  await page.locator('.autoplay-switch input').check();
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return Number.isFinite(v.duration)&&v.duration>30;},undefined,{timeout:120000});
  const autoEpisode=await page.locator('video[data-active=true]').evaluate(v=>Number(v.dataset.episode));
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=false]');return v.readyState>=2&&v.videoWidth&&v.paused;},undefined,{timeout:120000});
  // Seeking near the real media end exercises its genuine pause/ended event chain.
  await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=v.duration-.15;});
  await page.waitForFunction(expected=>Number(document.querySelector('video[data-active=true]')?.dataset.episode)===expected,autoEpisode+1,{timeout:120000});
  check('自然结束自动切到已解码下一集',await page.locator('video[data-active=true]').evaluate(v=>v.readyState>=2&&!v.paused));
  check('无渲染异常',errors.length===0,errors);
}catch(error){checks.push({name:'无黑屏验收',ok:false,error:error.message});console.error(error.stack);process.exitCode=1;await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
