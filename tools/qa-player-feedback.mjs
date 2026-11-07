// Actual Electron UI + decoded media. Failure injection affects only the isolated test profile.
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
const root=process.cwd(),out=path.join(root,'_work','feedback-qa');await mkdir(out,{recursive:true});
const installed=process.argv.includes('--installed');
const affected=process.argv.includes('--affected');
const sid=affected?'7698294694886788121':'7699859403758914622',query=affected?'和离后我带女儿':'人前小保姆',episode=affected?221:1;
const env={...process.env,TEMP:out,TMP:out,HG_TEST_DATA_DIR:path.join(root,'_work',(installed?'feedback-installed-data':'feedback-data')+(affected?'-affected':''))};
const instance=await electron.launch(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe'),args:[],env,timeout:60000}:{args:['.'],cwd:root,env,timeout:60000});
const page=await instance.firstWindow(),checks=[];
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
 await page.waitForSelector('.app-shell');
 const startLibrary=await page.evaluate(()=>window.hongguo.getLibrary());
 const previous=startLibrary.favorites.find(s=>s.id===sid);
 if(previous)await page.evaluate(series=>window.hongguo.toggleFavorite(series,false),previous);
 await page.evaluate(()=>window.hongguo.saveSettings({autoplay:false,rate:1.5,quality:'1080p',volume:0,danmaku:{enabled:true,opacity:.8,fontSize:22,area:.5,density:'standard',blockedWords:[]}}));await page.reload();
 await page.getByLabel('搜索剧名、演员或关键词').fill(query);await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 const card=page.locator('.series-card').filter({hasText:query}).first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();
 if(affected)await page.getByRole('button',{name:/显示更多集数/}).click();
 await page.getByRole('dialog').getByRole('button',{name:`播放第 ${episode} 集`,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>1,undefined,{timeout:180000});
 await instance.evaluate(({ipcMain})=>{
   globalThis.__favoriteHandler=ipcMain._invokeHandlers.get('library:favorite');globalThis.__favoriteCalls=0;globalThis.__favoriteFail=true;
   ipcMain.removeHandler('library:favorite');ipcMain.handle('library:favorite',async(...args)=>{globalThis.__favoriteCalls++;await new Promise(resolve=>setTimeout(resolve,700));if(globalThis.__favoriteFail)throw new Error('收藏暂时未同步，请稍后重试（101144）');return globalThis.__favoriteHandler(...args);});
 });
 await page.locator('.player-favorite').click();
 await page.waitForFunction(()=>document.querySelector('.player-favorite')?.disabled&&document.querySelector('.player-feedback')?.textContent.includes('正在确认'));
 await page.locator('.player-favorite').evaluate(button=>{button.click();button.click();});
 check('收藏同步时显示处理反馈且防止重复提交',await instance.evaluate(()=>globalThis.__favoriteCalls===1));
 await page.waitForFunction(()=>document.querySelector('.player-feedback')?.textContent.includes('101144'));
 const bounds=await page.locator('.player-feedback').boundingBox(),stage=await page.locator('.video-stage').boundingBox();
 check('收藏失败反馈位于实际视频画面内',bounds.x>=stage.x&&bounds.y>=stage.y&&bounds.y+bounds.height<=stage.y+stage.height,{bounds,stage});
 check('失败后收藏状态保留且可重试',await page.locator('.player-favorite').getAttribute('aria-pressed')!=='true'&&!await page.locator('.player-favorite').isDisabled());
 await page.waitForFunction(()=>!document.querySelector('.player-feedback'),undefined,{timeout:7500});
 check('失败提示自动收起且按钮继续可用',!await page.locator('.player-favorite').isDisabled());
 await instance.evaluate(()=>{globalThis.__favoriteFail=false;});
 await page.locator('.player-favorite').click();await page.waitForFunction(()=>document.querySelector('.player-favorite')?.getAttribute('aria-pressed')==='true'&&document.querySelector('.player-feedback')?.textContent.includes('已加入收藏'));
 const library=await page.evaluate(()=>window.hongguo.getLibrary());check('收藏成功持久保存并更新按钮',library.favorites.some(s=>s.id===sid));
 await page.locator('.video-stage').hover({position:{x:15,y:15}});await page.getByTitle('全屏（F）').click();
 check('全屏内仍可看见操作反馈',await page.locator('.player-feedback').isVisible()&&await page.evaluate(()=>!!document.fullscreenElement));await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('.player-feedback'),undefined,{timeout:4500});
 check('成功提示自动收起且收藏状态保留',await page.locator('.player-favorite').getAttribute('aria-pressed')==='true');
 const detail=await page.evaluate(sid=>window.hongguo.request('/catalog/series/'+sid),sid);
 const full=detail.episodes[episode-1].duration;
 const first=await page.evaluate(({sid,episode,full})=>window.hongguo.request(`/catalog/danmaku?seriesId=${sid}&episode=${episode}&position=0&duration=${full}`),{sid,episode,full});
 const later=await page.evaluate(({sid,episode,full})=>window.hongguo.request(`/catalog/danmaku?seriesId=${sid}&episode=${episode}&position=30&duration=${full}`),{sid,episode,full});
 const seen=new Set(),samples=[];
 await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=20;});
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]').currentTime>=20&&!document.querySelector('video[data-active=true]').paused);
 while(true){const s=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),c=document.querySelector('.danmaku-canvas');return {time:v.currentTime,paused:v.paused,text:c.getAttribute('aria-label'),count:Number(c.dataset.activeCount)};});samples.push(s);for(const item of [...first.items,...later.items])if(s.text.includes(item.text))seen.add(item.id);if(s.time>=45)break;await page.waitForTimeout(150);}
 const boundary=samples.filter(s=>s.time>=28&&s.time<=33&&!s.paused);
 check('一倍半播放跨时间段持续显示真实弹幕',boundary.length>5&&boundary.filter(s=>s.count>0).length/boundary.length>.9&&later.items.some(item=>seen.has(item.id)),{samples:boundary.length,nonempty:boundary.filter(s=>s.count>0).length,seen:seen.size});
 await writeFile(path.join(out,'continuity.json'),JSON.stringify(samples,null,2));await page.keyboard.press('k');await page.screenshot({path:path.join(out,'feedback.png')});
}catch(error){checks.push({name:'播放器反馈验收',ok:false,error:error.message});console.error(error.stack);process.exitCode=1;await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,(installed?'installed-result':'result')+(affected?'-affected':'')+'.json'),JSON.stringify({checks},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
