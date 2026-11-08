// Actual decoded video must survive account/settings/history navigation in an isolated profile.
import {quietElectron as electron} from './quiet-electron.mjs';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const root=process.cwd(),out=path.join(root,'_work','player-navigation');await mkdir(out,{recursive:true});
const installed=process.argv.includes('--installed');
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile'),TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[];
function check(name,ok,detail){checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);}
try{
 await page.waitForSelector('.app-shell');
 await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',autoplay:false,volume:0,rate:1.5}));await page.reload();
 await page.getByLabel('搜索剧名、演员或关键词').fill('人前小保姆');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 const card=page.locator('.series-card[data-series-id="7699859403758914622"]').first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();
 await page.getByRole('dialog').getByRole('button',{name:'播放第 1 集',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>1,undefined,{timeout:180000});
 await page.evaluate(()=>{window.__keptVideo=document.querySelector('video[data-active=true]');window.__keptTime=window.__keptVideo.currentTime;});
 await page.getByRole('button',{name:'登录账号',exact:true}).click();await page.waitForSelector('.account-page');
 await page.getByRole('button',{name:'返回播放',exact:true}).waitFor({timeout:3000});
 check('账号页保留当前播放器并提供返回入口',await page.locator('.player-page').count()===1&&await page.evaluate(()=>document.querySelector('video[data-active=true]')===window.__keptVideo));
 await page.waitForFunction(()=>window.__keptVideo.paused);
 const frozen=await page.evaluate(()=>window.__keptVideo.currentTime);await page.waitForTimeout(900);
 check('离开播放页暂停且无隐藏音频',await page.evaluate(at=>window.__keptVideo.paused&&Math.abs(window.__keptVideo.currentTime-at)<.1,frozen));
 await page.getByLabel('手机号',{exact:true}).fill('13800000000');await page.keyboard.press('k');
 check('账号页输入不触发隐藏播放器快捷键',await page.evaluate(()=>window.__keptVideo.paused));
 await page.getByRole('button',{name:'返回播放',exact:true}).click();
 await page.waitForFunction(()=>!window.__keptVideo.paused&&window.__keptVideo.currentTime>window.__keptTime,undefined,{timeout:8000});
 check('原解码器直接恢复集数位置和倍速',await page.evaluate(()=>document.querySelector('video[data-active=true]')===window.__keptVideo&&window.__keptVideo.dataset.episode==='1'&&window.__keptVideo.playbackRate===1.5));
 for(const route of ['设置','观看历史','我的收藏','发现']){
   await page.getByRole('button',{name:route,exact:true}).click();
   await page.getByRole('button',{name:'返回播放',exact:true}).waitFor();
   await page.waitForFunction(()=>window.__keptVideo.paused);
   await page.getByRole('button',{name:'返回播放',exact:true}).click();
   await page.waitForFunction(()=>!window.__keptVideo.paused,undefined,{timeout:8000});
   check(route+'往返保留同一个视频',await page.evaluate(()=>document.querySelector('video[data-active=true]')===window.__keptVideo));
 }
 await page.locator('.video-stage').hover({position:{x:15,y:15}});await page.getByTitle('暂停（空格）').click();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'返回播放',exact:true}).click();
 check('手动暂停后往返页面仍保持暂停',await page.evaluate(()=>window.__keptVideo.paused));
 await page.getByRole('button',{name:'登录账号',exact:true}).click();await page.getByRole('button',{name:'结束播放',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.player-page'));
 check('明确结束播放才释放会话',await page.locator('.playback-resume-bar').count()===0);
}catch(error){checks.push({name:'播放器导航验收',ok:false,error:error.message});console.error(error.message);process.exitCode=1;}
finally{await writeFile(path.join(out,installed?'installed-result.json':'result.json'),JSON.stringify({checks},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
