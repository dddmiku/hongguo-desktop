// Verify real, authenticated mobile sources in the PC renderer, using an isolated silent profile.
import {expect} from '@playwright/test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),installed=process.argv.includes('--installed');
const out=path.join(root,'_work/domestic-playback-live','episode175-installed');
const profile=path.join(out,'profile');await mkdir(profile,{recursive:true});
for(const name of ['account-session.dpapi','desktop-device.json'])await copyFile(path.join(process.env.APPDATA,'红果桌面',name),path.join(profile,name));
const first='7703527132676246553',title='我家仙妻不太正经第四季';
const installedExe=[path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),path.join(process.env.ProgramFiles,'hongguo-desktop/红果桌面.exe')].find(p=>require('node:fs').existsSync(p));
const instance=await electron.launch({...(installed?{executablePath:installedExe,args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.name));page.on('console',m=>{const t=m.text();if(t.startsWith('IPC')||t.startsWith('POLL'))console.log('CONSOLE '+t)});page.on('request',r=>{if(r.url().includes('/catalog/'))console.log('REQ '+r.url().replace(/^https?:\/\/127\.0\.0\.1:\d+/,''))});page.on('response',async r=>{if(r.url().includes('/catalog/')){let n=-1;try{n=(await r.body()).length}catch{}console.log('RESP '+r.status()+' '+n+' '+r.url().replace(/^https?:\/\/127\.0\.0\.1:\d+/,''))}});page.on('requestfailed',r=>{if(r.url().includes('/catalog/'))console.log('FAIL '+(r.failure()?.errorText||''))});
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const debug=async(stage)=>{try{await page.screenshot({path:path.join(out,`debug-${stage}.png`)});const snap=await page.evaluate(()=>({url:location.hash,dialogs:[...document.querySelectorAll('[role=dialog]')].map(d=>d.innerText.slice(0,400)),errors:[...document.querySelectorAll('.player-error')].map(e=>e.innerText.slice(0,200)),cards:document.querySelectorAll('.series-card').length,video:document.querySelector('video')?{ready:document.querySelector('video').readyState,src:!!document.querySelector('video').currentSrc}:null}));console.log('DEBUG '+stage+' '+JSON.stringify(snap));}catch(e){console.log('DEBUG-FAIL '+stage);}};
const decoded=episode=>page.evaluate(({first,episode})=>{const video=document.querySelector('video[data-active=true]');return video?.dataset.seriesId===first&&video.dataset.episode===String(episode)&&video.videoWidth>0&&video.readyState>=2&&video.currentTime>1&&!video.paused&&!document.querySelector('.player-error');},{first,episode});
try{
  await page.waitForSelector('.app-shell');await debug('shell');await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:1,volume:0,autoplay:false,danmaku:{enabled:false}}));await page.reload();
  const search=page.getByLabel('搜索剧名、演员或关键词');await search.fill(title);await search.press('Enter');
  await debug('search');
  await page.evaluate(()=>{const orig=window.hongguo.request;window.hongguo.request=async(...a)=>{const t=performance.now();try{const r=await orig(...a);console.log('IPC ok '+(performance.now()-t).toFixed(0)+'ms '+a[0]+' eps='+((r&&r.episodes)||[]).length);return r;}catch(e){console.log('IPC fail '+(performance.now()-t).toFixed(0)+'ms '+a[0]+' '+String(e).slice(0,120));throw e;}};});
  await page.locator(`.series-card[data-series-id="${first}"]`).first().locator('.series-poster-button').click({timeout:60000});
  for(let i=0;i<6;i++){await page.waitForTimeout(2000);console.log('POLL'+i+' '+JSON.stringify(await page.evaluate(()=>({txt:(document.querySelector('[role=dialog]')?.innerText||'').replace(/\s+/g,' ').slice(0,60)}))));}
  await debug('dialog');
  console.log('DBG direct-detail '+JSON.stringify(await page.evaluate(async()=>{try{const r=await window.hongguo.request('/catalog/series/7703527132676246553');return {ok:true,eps:(r.episodes||[]).length};}catch(e){return {ok:false,msg:String(e).slice(0,200)};}})));
  const more=page.getByRole('dialog').getByRole('button',{name:'显示更多集数'});
  if(await more.count()){await more.click();await page.waitForTimeout(500);}
  const episodeButton=page.getByRole('dialog').locator('.episode-grid button').filter({hasText:/^175$/});
  console.log('EPBTN count='+await episodeButton.count());
  await episodeButton.first().click({timeout:120000});
  await debug('player');
  for(const episode of [175,176,177]){
    if(episode!==175)await page.locator('.player-page .episode-grid button').filter({hasText:new RegExp(`^${episode}$`)}).click();
    try{await expect.poll(()=>decoded(episode),{timeout:90000}).toBe(true);}catch(e){await debug('ep'+episode);throw e;}
    const frame=await page.locator('video[data-active=true]').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,time:video.currentTime,series:video.dataset.seriesId,episode:Number(video.dataset.episode)}));
    check(`PC 实际解码第 ${episode} 集`,frame.series===first&&frame.episode===episode&&frame.width>0&&frame.time>1,frame);
    if(episode===175)await page.screenshot({path:path.join(out,'episode175.png')});
  }
  check('真实片源全程静音且无界面异常',errors.length===0&&await instance.evaluate(({webContents})=>webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'PC 真实后续集播放',ok:false,errorType:error.name});console.error(error.name);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
