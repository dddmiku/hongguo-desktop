// Public official seasons and actual decoded video in an independent, silent profile.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),installed=process.argv.includes('--installed'),out=path.join(root,'_work/player-seasons-live',installed?'installed':'current');await mkdir(out,{recursive:true});
const first='7698294694886788121',second='7704261228037671998';
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.name));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const panel=()=>page.locator('.player-page .player-season-overview');
const card=season=>panel().getByRole('button',{name:new RegExp(`^播放第 ${season} 季：`)});
const decoded=sid=>page.evaluate(sid=>{const video=document.querySelector('video[data-active=true]');return video?.dataset.seriesId===sid&&video.dataset.episode==='1'&&video.readyState>=2&&video.videoWidth>0&&video.currentTime>.1&&!video.paused&&!document.querySelector('.switch-status,.player-error,.player-status');},sid);
try{
 await page.waitForSelector('.app-shell');await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:1.5,volume:0,autoplay:false,danmaku:{enabled:false}}));await page.reload();
 await page.getByLabel('搜索剧名、演员或关键词').fill('和离后我带女儿横扫魔域');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 await page.locator(`.series-card[data-series-id="${first}"]`).first().locator('.series-poster-button').click();await page.getByRole('dialog').getByRole('button',{name:'播放第 1 集',exact:true}).click();
 await expect.poll(()=>decoded(first),{timeout:180000}).toBe(true);await card(2).waitFor({timeout:120000});
 const cards=await panel().locator('.season-overview-card').evaluateAll(nodes=>nodes.map(node=>({title:node.querySelector('strong')?.textContent,count:node.querySelector('em')?.textContent,current:node.getAttribute('aria-current')})));
 check('播放页选集下方显示官方两季和真实集数',cards.length===2&&cards[0].count.startsWith('1000 集')&&cards[1].count.startsWith('521 集'),cards);
 check('正在播放第一季高亮',await card(1).getAttribute('aria-current')==='true');
 await page.evaluate(()=>{window.__playerSeasonNodes=[...document.querySelectorAll('video')];});
 await card(2).click();await expect.poll(()=>decoded(second),{timeout:180000}).toBe(true);
 check('点击第二季直接播放第一集并更新当前季',await card(2).getAttribute('aria-current')==='true'&&await page.locator('.player-heading h2').textContent()==='和离后我带女儿横扫魔域第二季');
 const media=await page.locator('video[data-active=true]').evaluate(v=>({width:v.videoWidth,height:v.videoHeight,time:v.currentTime,rate:v.playbackRate,volume:v.volume}));
 check('实际解码画面且保留倍速音量双视频槽',media.width>0&&media.time>0&&media.rate===1.5&&media.volume===0&&await page.evaluate(()=>window.__playerSeasonNodes.length===2&&window.__playerSeasonNodes.every((node,index)=>node===document.querySelectorAll('video')[index])),media);
 await card(1).click();await expect.poll(()=>decoded(first),{timeout:180000}).toBe(true);check('反向切第一季从首集播放并高亮',await card(1).getAttribute('aria-current')==='true');
 await page.keyboard.press('k');await expect.poll(()=>page.locator('video[data-active=true]').evaluate(v=>v.paused)).toBe(true);
 const library=await page.evaluate(()=>window.hongguo.getLibrary());check('两季播放历史按各自剧集标识保留',library.history.some(x=>x.series.id===first&&x.episode===1)&&library.history.some(x=>x.series.id===second&&x.episode===1));
 await panel().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'player-seasons.png')});
 check('测试窗口全程隐藏静音',await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(c=>c.isAudioMuted())));
 check('无界面异常',errors.length===0,errors);
}catch(error){checks.push({name:'官方播放页季卡验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
