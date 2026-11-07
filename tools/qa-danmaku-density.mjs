// Reproduce the user's actual episode, playback speed and sparse density without account writes.
import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),out=path.join(root,'_work','density-qa');await mkdir(out,{recursive:true});
const installed=process.argv.includes('--installed');
const app=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,TEMP:out,TMP:out,HG_TEST_DATA_DIR:path.join(out,installed?'installed-profile':'profile'),HG_TEST_BACKGROUND:'1'},timeout:60000});
const page=await app.firstWindow(),samples=[],checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
 await page.waitForSelector('.app-shell');
 await page.evaluate(()=>window.hongguo.saveSettings({autoplay:false,volume:0,quality:'1080p',rate:1.5,danmaku:{enabled:true,opacity:.75,fontSize:18,area:.5,density:'sparse',blockedWords:[]}}));await page.reload();
 await page.evaluate(()=>{
  window.__danmakuRanges=[];
  window.__danmakuPaints=0;
  const clear=CanvasRenderingContext2D.prototype.clearRect,stroke=CanvasRenderingContext2D.prototype.strokeText,draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.classList.contains('danmaku-canvas')){window.__danmakuRanges=[];window.__danmakuPaints++;}return clear.apply(this,args);};
  CanvasRenderingContext2D.prototype.strokeText=function(...args){if(this.canvas.classList.contains('danmaku-canvas'))window.__danmakuRanges.push({left:args[1],right:args[1]+this.measureText(args[0]).width});return stroke.apply(this,args);};
  CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.classList.contains('danmaku-canvas'))window.__danmakuRanges.push({left:args[1],right:args[1]+args[3]});return draw.apply(this,args);};
 });
 await page.getByLabel('搜索剧名、演员或关键词').fill('和离后我带女儿');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 const card=page.locator('.series-card[data-series-id="7698294694886788121"]').first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();
 await page.getByRole('button',{name:/显示更多集数/}).click();await page.getByRole('button',{name:/显示更多集数/}).click();
 await page.getByRole('dialog').getByRole('button',{name:'播放第 248 集',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>19,undefined,{timeout:180000});
 while(true){const sample=await page.evaluate(()=>{
   const video=document.querySelector('video[data-active=true]'),canvas=document.querySelector('.danmaku-canvas'),width=canvas.getBoundingClientRect().width;
   const ranges=window.__danmakuRanges.map(r=>({left:Math.max(0,r.left),right:Math.min(width,r.right)})).filter(r=>r.right>r.left).sort((a,b)=>a.left-b.left);
   let edge=0,gap=0;for(const r of ranges){if(edge>0&&r.left>edge)gap=Math.max(gap,r.left-edge);edge=Math.max(edge,r.right);}
   return {time:video.currentTime,paused:video.paused,width,count:Number(canvas.dataset.activeCount),gap,middle:ranges.some(r=>r.left<width*.65&&r.right>width*.35),paints:window.__danmakuPaints,hidden:document.hidden};
  });samples.push(sample);if(sample.time>=45)break;await page.waitForTimeout(150);}
 const actual=samples.filter(s=>s.time>=20&&s.time<=45&&!s.paused),near34=actual.filter(s=>s.time>=33&&s.time<=35);
 check('稀疏弹幕数量保持有界',actual.length>30&&actual.every(s=>s.count<=12));
 check('第248集34秒附近没有左右两批之间的大片空带',near34.length>5&&near34.every(s=>s.gap<s.width*.25),{samples:near34.length,maxGap:Math.max(...near34.map(s=>s.gap)),width:near34[0]?.width});
 check('20至45秒连续滚动覆盖画面中部',actual.filter(s=>s.middle).length/actual.length>.95,{samples:actual.length,middleCovered:actual.filter(s=>s.middle).length});
 check('无渲染异常',errors.length===0,errors);
 await page.keyboard.press('k');await page.screenshot({path:path.join(out,installed?'installed.png':'sparse.png')});
}catch(error){checks.push({name:'真实稀疏弹幕验收',ok:false,error:error.message});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(path.join(out,installed?'installed-result.json':'result.json'),JSON.stringify({checks,samples},null,2));await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
