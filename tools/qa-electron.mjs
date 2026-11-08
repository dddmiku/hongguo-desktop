import {quietElectron as electron} from './quiet-electron.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','qa');await mkdir(out,{recursive:true});
const instance=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(root,'_work','qa-data')},timeout:60000});
const page=await instance.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];function pass(name,detail){results.push({name,ok:true,detail});console.log(JSON.stringify(results.at(-1)));}
try{
  await page.waitForSelector('.app-shell',{timeout:20000});pass('客户端启动');
  await page.waitForSelector('.series-card',{timeout:150000});
  const cards=await page.locator('.series-card').count();pass('真实片单加载',{cards});
  await page.screenshot({path:path.join(out,'home-dark.png')});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.waitForSelector('.settings-page');await page.screenshot({path:path.join(out,'settings-dark.png')});
  await page.getByRole('button',{name:'浅色',exact:true}).click();await page.waitForTimeout(350);await page.screenshot({path:path.join(out,'settings-light.png')});await page.getByRole('button',{name:'深色',exact:true}).click();pass('亮暗主题切换');
  await page.getByRole('button',{name:'发现',exact:true}).click();
  await page.waitForSelector('.series-card',{timeout:90000});
  await page.locator('.series-poster-button').first().click();
  await page.waitForSelector('.detail-hero',{timeout:90000});
  await page.screenshot({path:path.join(out,'detail.png')});pass('详情与选集加载');
  const playButton=page.getByRole('dialog').getByRole('button',{name:/立即播放|开始播放|继续第/}).first();await playButton.click();
  await page.waitForSelector('.player-page');
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.currentTime>2&&!v.paused;},undefined,{timeout:180000});
  pass('真实视频已解码播放',await page.locator('video[data-active=true]').evaluate(v=>({time:v.currentTime,width:v.videoWidth,height:v.videoHeight,duration:v.duration})));
  await page.screenshot({path:path.join(out,'player.png')});
  await page.getByTitle('评论',{exact:true}).click();await page.waitForSelector('.comments-panel');
  await page.waitForFunction(()=>!document.querySelector('.comments-list .loading-state'),undefined,{timeout:60000});if(await page.locator('.comment-error').count())throw new Error('评论接口失败');pass('真实评论加载',{items:await page.locator('.comment').count()});
  const initial=Number((await page.locator('.player-heading span').innerText()).match(/第\s*(\d+)/)?.[1]);await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('下一集（J）').click();
  await page.waitForFunction(expected=>document.querySelector('.player-heading span')?.textContent?.includes(`第 ${expected} 集`),initial+1,{timeout:20000});
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.currentTime>2&&!v.paused;},undefined,{timeout:180000});pass('连续切集播放');
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByLabel('播放倍速').selectOption('3');await page.waitForFunction(()=>document.querySelector('video[data-active=true]').playbackRate===3);await page.getByLabel('播放倍速').selectOption('2');await page.waitForTimeout(3500);const speed=await page.evaluate(()=>({focus:document.activeElement.tagName,rate:document.querySelector('video[data-active=true]').playbackRate,hidden:!!document.querySelector('.controls-hidden')}));if(speed.rate!==2||speed.focus==='SELECT'||!speed.hidden)throw new Error('倍速或控制栏未生效：'+JSON.stringify(speed));pass('倍速与控制栏收起',speed);
  await page.evaluate(()=>window.hongguo.window('close'));await page.waitForTimeout(500);pass('关闭到托盘暂停',await page.locator('video[data-active=true]').evaluate(v=>v.paused));
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByRole('button',{name:'我的片库',exact:true}).click();await page.getByRole('dialog',{name:'我的片库'}).getByRole('button',{name:'观看历史',exact:true}).first().click();await page.waitForTimeout(500);const entries=await page.locator('.history-card').count();if(!entries)throw new Error('观看记录未保存');pass('本地观看记录',{entries});
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,740));await page.waitForTimeout(300);if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('窄窗口横向溢出');await page.screenshot({path:path.join(out,'window-960.png')});pass('窄窗口布局');
  pass('运行时错误',{errors});
}catch(e){results.push({name:'QA中断',ok:false,error:e.stack});console.error(e.stack);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
if(results.some(r=>!r.ok)||errors.length)process.exitCode=1;
