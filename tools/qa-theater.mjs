import {quietElectron as electron} from './quiet-electron.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','theater-qa');await mkdir(out,{recursive:true});
const instance=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(root,'_work','theater-data')},timeout:60000});
const page=await instance.firstWindow(),errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
const check=(name,ok,detail)=>{if(!ok)throw new Error(name+': '+JSON.stringify(detail));checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)));};
const geometry=()=>page.evaluate(()=>{const stage=document.querySelector('.video-stage').getBoundingClientRect(),video=document.querySelector('video[data-active=true]'),header=document.querySelector('.app-header').getBoundingClientRect();return {width:stage.width,height:stage.height,x:stage.x,y:stage.y,viewportWidth:innerWidth,viewportHeight:innerHeight,headerHeight:header.height,fullscreen:!!document.fullscreenElement,position:video.currentTime,paused:video.paused};});
try{
  await instance.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setBounds({x:0,y:0,width:2560,height:1440});});
  await page.waitForSelector('.series-card',{timeout:90000});await page.evaluate(()=>window.hongguo.saveSettings({autoplay:false,rate:1}));
  await page.locator('.series-poster-button').first().click();await page.waitForSelector('.detail-hero',{timeout:90000});await page.getByRole('dialog').getByRole('button',{name:/立即播放|继续第/}).first().click();
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.currentTime>1&&!v.paused;},undefined,{timeout:180000});
  const normal=await geometry();await page.screenshot({path:path.join(out,'normal.png')});await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('剧场模式（T）',{exact:true}).click();
  await page.waitForSelector('.player-theater');await page.waitForTimeout(300);const theater=await geometry();await page.screenshot({path:path.join(out,'theater.png')});
  check('剧场按钮实际扩大播放区',theater.width>normal.width*1.5&&theater.height>normal.height+200,{normal,theater});
  check('剧场保持窗口内观看和顶部导航',!theater.fullscreen&&theater.width>=theater.viewportWidth-10&&theater.y>=theater.headerHeight,{theater});
  check('切换剧场不重开视频或暂停',theater.position>=normal.position&&!theater.paused,{normalTime:normal.position,theaterTime:theater.position});
  check('剧场按钮反馈状态与退出入口',await page.getByTitle('退出剧场模式（T）',{exact:true}).getAttribute('aria-pressed')==='true');
  await page.keyboard.press('t');await page.waitForFunction(()=>!document.querySelector('.player-theater'));await page.waitForTimeout(200);const restored=await geometry();check('T恢复正常播放区域',Math.abs(restored.width-normal.width)<2&&Math.abs(restored.height-normal.height)<2,{restored});
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(2560,900));await page.waitForTimeout(200);await page.locator('.content-scroll').evaluate(node=>node.scrollTop=60);const scroll=await page.locator('.content-scroll').evaluate(node=>node.scrollTop);check('较矮窗口存在真实可滚动选集区域',scroll>0,{scroll});
  await page.keyboard.press('t');await page.waitForSelector('.player-theater');await page.waitForTimeout(100);check('进入剧场定位到视频顶部',await page.locator('.content-scroll').evaluate(node=>node.scrollTop)===0);
  await page.keyboard.press('t');await page.waitForFunction(()=>!document.querySelector('.player-theater'));await page.waitForTimeout(100);check('退出剧场恢复浏览位置',Math.abs(await page.locator('.content-scroll').evaluate(node=>node.scrollTop)-scroll)<1);
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(2560,1440));await page.waitForTimeout(150);
  await page.keyboard.press('t');await page.waitForSelector('.player-theater');await page.keyboard.press('f');await page.waitForFunction(()=>!!document.fullscreenElement);const fullscreen=await geometry();check('剧场中的真全屏仍铺满屏幕',Math.abs(fullscreen.width-fullscreen.viewportWidth)<2&&Math.abs(fullscreen.height-fullscreen.viewportHeight)<2,{fullscreen});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);check('退出真全屏仍保留剧场模式',await page.locator('.player-theater').count()===1);
  check('无渲染异常',errors.length===0,{errors});
}catch(error){checks.push({name:'剧场验收',ok:false,error:error.message});console.error(error.message);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
