// Real public series, decoded fourth episode and season transition in an isolated, silent profile.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),out=path.join(root,'_work/season-live');await mkdir(out,{recursive:true});
const installed=process.argv.includes('--installed');
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,installed?'installed-profile':'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.name));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const first='7698294694886788121',second='7704261228037671998';
const decoded=sid=>page.evaluate(sid=>{const v=document.querySelector('video[data-active=true]');return !!v&&v.dataset.seriesId===sid&&v.readyState>=2&&v.videoWidth>0&&!v.paused&&v.currentTime>0&&!document.querySelector('.switch-status')&&!document.querySelector('.player-status')&&!document.querySelector('.player-error');},sid);
try{
 await page.waitForSelector('.app-shell');await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:3,volume:0,autoplay:true,danmaku:{enabled:false}}));await page.reload();
 await page.getByLabel('搜索剧名、演员或关键词').fill('和离后我带女儿横扫魔域');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 const card=page.locator(`.series-card[data-series-id="${first}"]`).first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();await page.waitForSelector('.detail-hero',{timeout:60000});
 await page.getByLabel('全部季概览').locator('.season-overview-card').first().waitFor({timeout:120000});
 const values=await page.locator('.season-overview-card').evaluateAll(nodes=>nodes.map(node=>({title:node.querySelector('strong')?.textContent,count:node.querySelector('em')?.textContent,season:node.querySelector('small')?.textContent})));
 check('真实全部季概览显示每季集数',values.some(x=>x.count==='1000 集')&&values.some(x=>x.count==='521 集'),values);
 await page.getByLabel('全部季概览').getByRole('button',{name:/查看第 2 季/}).click();await expect.poll(()=>page.locator('.detail-hero h2').textContent(),{timeout:60000}).toContain('第二季');
 await page.getByRole('dialog').getByRole('button',{name:'播放第 4 集',exact:true}).click();await expect.poll(()=>decoded(second),{timeout:180000,intervals:[100,300]}).toBe(true);
 const fourth=await page.locator('video[data-active=true]').evaluate(v=>({episode:v.dataset.episode,width:v.videoWidth,height:v.videoHeight,time:v.currentTime,rate:v.playbackRate}));check('第二季第四集真实画面解码且无ProviderError',fourth.episode==='4'&&fourth.width>0&&fourth.time>0,fourth);
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.player-page'));
 await page.locator(`.series-card[data-series-id="${first}"]`).first().locator('.series-poster-button').click();await page.waitForSelector('.detail-hero');
 for(let n=0;n<8;n++){const more=page.getByRole('button',{name:/显示更多集数/});if(await more.count())await more.click();}
 await page.getByRole('dialog').getByRole('button',{name:'播放第 1000 集',exact:true}).click();await expect.poll(()=>decoded(first),{timeout:180000}).toBe(true);
 await page.locator('.next-season-card[data-season-status=ready]').waitFor({timeout:180000});
 check('当前季末已提前解码下一季首集',await page.locator('video[data-active=false]').evaluate(v=>v.dataset.seriesId==='7704261228037671998'&&v.readyState>=2&&v.videoWidth>0&&v.paused));
 await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('全屏（F）').click();await page.waitForFunction(()=>!!document.fullscreenElement);
 await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]'),slider=document.querySelector('[aria-label="播放进度"]');return v.duration>=Number(slider.max)-.25;},undefined,{timeout:120000});
 await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=v.duration-.2;});await expect.poll(()=>decoded(second),{timeout:120000}).toBe(true);
 const next=await page.locator('video[data-active=true]').evaluate(v=>({episode:v.dataset.episode,rate:v.playbackRate,fullscreen:!!document.fullscreenElement}));check('季末自动进入第二季第一集并保留全屏倍速',next.episode==='1'&&next.rate===3&&next.fullscreen,next);
 await page.keyboard.press('Escape');await page.keyboard.press('k');await page.waitForTimeout(500);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'返回播放',exact:true}).click();
 check('跨季后返回播放标题仍对应第二季',await page.locator('.player-heading h2').textContent()==='和离后我带女儿横扫魔域第二季');
 const library=await page.evaluate(()=>window.hongguo.getLibrary());check('两季历史使用各自剧集标识',library.history.some(x=>x.series.id===first&&x.episode===1000)&&library.history.some(x=>x.series.id===second&&x.episode===1));
 check('测试窗口全程静音',await instance.evaluate(({webContents})=>webContents.getAllWebContents().every(c=>c.isAudioMuted())));
 check('无界面异常',errors.length===0,errors);await page.screenshot({path:path.join(out,installed?'installed.png':'current.png')});
}catch(error){checks.push({name:'真实跨季回归',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(out,installed?'installed-result.json':'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
