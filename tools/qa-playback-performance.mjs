// Isolated, hidden measurement. Hardware-independent assertions cover actual decode and idle work.
import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const exec=promisify(execFile),root=process.cwd(),out=path.join(root,'_work','performance','playback');await mkdir(out,{recursive:true});
const compatibility=process.argv.includes('--compatible'),installed=process.argv.includes('--installed');
const app=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,compatibility?'compatible':'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await app.firstWindow(),checks=[];
function check(name,ok,detail){checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);}
async function tree(){const pid=await app.evaluate(()=>process.pid);const code='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $rows=@(Get-CimInstance Win32_Process); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add([int]$env:HG_PERF_PID); do { $added=$false; foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)){$added=$true}} } while($added); $result=@(foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{pid=$id;name=$p.ProcessName+".exe";rssMB=[math]::Round($p.WorkingSet64/1MB,1);cpuSeconds=[math]::Round($p.CPU,4)}}}); ConvertTo-Json -InputObject $result -Compress';const result=await exec(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,env:{...process.env,HG_PERF_PID:String(pid)},timeout:15000});return JSON.parse(result.stdout);}
try{
 if(compatibility){await page.addInitScript(()=>{navigator.mediaCapabilities.decodingInfo=async()=>({supported:true,smooth:false,powerEfficient:false,keySystemAccess:null});});}
 await page.waitForSelector('.app-shell');await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:1.5,volume:0,autoplay:false,danmaku:{enabled:true,opacity:.75,fontSize:18,area:.5,density:'sparse',blockedWords:[]}}));await page.reload();
 await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('api:request');globalThis.__mediaStates=[];ipcMain.removeHandler('api:request');ipcMain.handle('api:request',async(...args)=>{const result=await original(...args);if(/^\/media\/session(?:\/|$)/.test(args[1])&&result?.delivery)globalThis.__mediaStates.push({delivery:result.delivery,codec:result.videoCodec,phase:result.phase});return result;});});
 await page.evaluate(()=>{window.__canvasPaints=0;window.__textMeasures=0;const clear=CanvasRenderingContext2D.prototype.clearRect,measure=CanvasRenderingContext2D.prototype.measureText;CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.classList.contains('danmaku-canvas'))window.__canvasPaints++;return clear.apply(this,args);};CanvasRenderingContext2D.prototype.measureText=function(...args){if(this.canvas.classList.contains('danmaku-canvas'))window.__textMeasures++;return measure.apply(this,args);};});
 await page.getByLabel('搜索剧名、演员或关键词').fill('和离后我带女儿');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 const card=page.locator('.series-card[data-series-id="7698294694886788121"]').first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();
 await page.getByRole('dialog').getByRole('button',{name:'播放第 1 集',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>2,undefined,{timeout:180000});
 await page.waitForTimeout(1500);
 const framesBefore=await page.locator('video[data-active=true]').evaluate(v=>({totalVideoFrames:v.getVideoPlaybackQuality().totalVideoFrames}));
 const processesBefore=await tree();await page.waitForTimeout(3500);const processesAfter=await tree();
 const actual=await page.locator('video[data-active=true]').evaluate(v=>({time:v.currentTime,paused:v.paused,width:v.videoWidth,frames:{totalVideoFrames:v.getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:v.getVideoPlaybackQuality().droppedVideoFrames},buffered:v.buffered.length?v.buffered.end(v.buffered.length-1)-v.currentTime:0}));
 const states=await app.evaluate(()=>globalThis.__mediaStates),native=states.some(s=>s.delivery==='remux'&&s.codec==='hevc');
 check('实际视频持续解码',!actual.paused&&actual.width>0&&actual.frames.totalVideoFrames>framesBefore.totalVideoFrames,actual);
 if(compatibility)check('硬解不可用时自动兼容转码',states.some(s=>s.delivery==='transcode'&&s.codec==='h264'),states.slice(-3));
 else check('支持硬解时保留原视频并跳过软件编码',native,states.slice(-3));
 check('活动视频前向缓存有界',actual.buffered<40,{buffered:actual.buffered});
 await page.getByRole('button',{name:'登录账号',exact:true}).click();await page.waitForSelector('.playback-resume-bar');await page.waitForTimeout(700);
 const idleBefore=await page.evaluate(()=>({paints:window.__canvasPaints,measures:window.__textMeasures,time:document.querySelector('video[data-active=true]').currentTime}));await page.waitForTimeout(1500);
 const idleAfter=await page.evaluate(()=>({paints:window.__canvasPaints,measures:window.__textMeasures,time:document.querySelector('video[data-active=true]').currentTime}));
 check('隐藏播放器暂停且停止弹幕重绘',Math.abs(idleAfter.time-idleBefore.time)<.05&&idleAfter.paints===idleBefore.paints,{idleBefore,idleAfter});
 await page.getByRole('button',{name:'返回播放',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('video[data-active=true]').paused);
 const performance={hardwareHevc:native,processesBefore,processesAfter,totalRssMB:Math.round(processesAfter.reduce((n,p)=>n+p.rssMB,0)),mode:compatibility?'compatible':'hardware'};
 await writeFile(path.join(out,compatibility?'compatible-metrics.json':'metrics.json'),JSON.stringify(performance,null,2));console.log(JSON.stringify({measurement:performance}));
}catch(error){checks.push({name:'播放性能验收',ok:false,error:error.message});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(path.join(out,compatibility?'compatible-result.json':'result.json'),JSON.stringify({checks},null,2));await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
