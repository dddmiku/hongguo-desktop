import {quietElectron as electron} from './quiet-electron.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','fullscreen-qa');await mkdir(out,{recursive:true});
const instance=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(root,'_work','fullscreen-data')},timeout:60000});
const page=await instance.firstWindow();const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{if(!value)throw new Error(name);checks.push({name,ok:true});console.log(JSON.stringify(checks.at(-1)));};
try{
  await page.waitForSelector('.series-card',{timeout:90000});await page.evaluate(()=>window.hongguo.saveSettings({autoplay:false,rate:1}));
  await page.locator('.series-poster-button').first().click();await page.waitForSelector('.detail-hero',{timeout:90000});
  await page.getByRole('dialog').getByRole('button',{name:/立即播放|继续第/}).first().click();await page.waitForSelector('.player-page');
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.currentTime>1&&!v.paused;},undefined,{timeout:180000});
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('全屏（F）',{exact:true}).click();await page.waitForTimeout(650);
  const full=await page.evaluate(()=>{const layout=document.querySelector('.playback-layout'),stage=document.querySelector('.video-stage'),v=document.querySelector('video[data-active=true]');return {fullscreen:document.fullscreenElement?.className||null,viewport:{width:innerWidth,height:innerHeight},layout:layout.getBoundingClientRect().toJSON(),stage:stage.getBoundingClientRect().toJSON(),video:v.getBoundingClientRect().toJSON(),time:v.currentTime};});
  await page.screenshot({path:path.join(out,'fullscreen.png')});
  if(!full.fullscreen||Math.abs(full.stage.width-full.viewport.width)>2||Math.abs(full.stage.height-full.viewport.height)>2)throw new Error('视频没有铺满全屏视口：'+JSON.stringify(full));
  checks.push({name:'播放器铺满屏幕',ok:true,detail:full});
  await page.keyboard.press('Control+k');check('全屏内搜索快捷键不会聚焦屏幕外',await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')!=='搜索剧名、演员或关键词'));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);check('Esc只退出全屏，播放器与播放进度保留',await page.locator('.player-page').count()===1&&await page.locator('video[data-active=true]').evaluate(v=>v.currentTime>0));
  await page.keyboard.press('f');await page.waitForFunction(()=>document.fullscreenElement?.classList.contains('playback-layout'));check('F进入视频全屏',true);
  await page.keyboard.press('f');await page.waitForFunction(()=>!document.fullscreenElement);check('F退出视频全屏',true);
  const beforeDouble=await page.locator('video[data-active=true]').evaluate(v=>v.paused);await page.locator('video[data-active=true]').dblclick({position:{x:80,y:100}});await page.waitForFunction(()=>!!document.fullscreenElement);await page.waitForTimeout(300);check('双击全屏不改变播放状态',await page.locator('video[data-active=true]').evaluate(v=>v.paused)===beforeDouble);
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('评论',{exact:true}).click();check('全屏评论面板在屏幕内',await page.locator('.comments-panel').evaluate(e=>{const r=e.getBoundingClientRect();return r.top===0&&r.bottom<=innerHeight+2&&r.right<=innerWidth+2;}));await page.getByLabel('关闭评论',{exact:true}).click();
  check('关闭评论恢复全宽视频',await page.locator('.video-stage').evaluate(e=>Math.abs(e.getBoundingClientRect().width-innerWidth)<2));
  const initial=Number((await page.locator('.player-heading span').textContent()).match(/第\s*(\d+)/)?.[1]);await page.keyboard.press('j');await page.waitForFunction(expected=>document.querySelector('.player-heading span')?.textContent.includes(`第 ${expected} 集`),initial+1);await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>1,undefined,{timeout:120000});check('切集后保持视频全屏',await page.evaluate(()=>!!document.fullscreenElement));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByLabel('播放画质').selectOption('720p');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>1,undefined,{timeout:120000});check('切换画质后保持全屏',await page.evaluate(()=>!!document.fullscreenElement));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('退出全屏（Esc）').click();await page.waitForFunction(()=>!document.fullscreenElement);check('退出按钮恢复原窗口',await instance.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isFullScreen()));
  await page.screenshot({path:path.join(out,'restored.png')});check('无渲染错误',errors.length===0);
}catch(e){checks.push({name:'全屏验收',ok:false,error:e.message});console.error(e.message);process.exitCode=1;}
finally{await writeFile(path.join(out,'results.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
