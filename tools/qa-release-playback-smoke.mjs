// Packaged, real anonymous upstream playback. No copied account state or synthetic media.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,lstat,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root=path.resolve(process.cwd()),expected='1.5.7',argument=process.argv.find(value=>value.startsWith('--exe='));
const executable=argument?argument.slice(6):path.join(process.env.ProgramFiles,'hongguo-desktop','红果桌面.exe');
if(!path.isAbsolute(executable)||!(await lstat(executable)).isFile())throw new Error('Smoke requires an absolute existing EXE path');
const label=path.resolve(executable).startsWith(path.join(root,'release','win-unpacked')+path.sep)?'unpacked':path.resolve(executable).startsWith(path.join(process.env.ProgramFiles,'hongguo-desktop')+path.sep)?'installed':'custom';
const out=path.join(root,'_work','release-playback-smoke',label),profile=path.join(out,'profile'),owner=path.join(profile,'qa-owner.json');
await mkdir(out,{recursive:true});
const previous=await lstat(profile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(previous){
 const resolved=await realpath(profile),resolvedOut=await realpath(out);
 if(previous.isSymbolicLink()||!previous.isDirectory()||path.dirname(resolved)!==resolvedOut||JSON.parse(await readFile(owner,'utf8')).kind!=='release-playback-smoke')throw new Error('Unowned smoke profile; no files were removed');
 await rm(resolved,{recursive:true,force:true});
}
await mkdir(profile);await writeFile(owner,JSON.stringify({kind:'release-playback-smoke'}));
const exec=promisify(execFile),ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const metadata=await exec(ps,['-NoProfile','-NonInteractive','-Command','(Get-Item -LiteralPath $env:HG_SMOKE_EXE).VersionInfo.ProductVersion'],{windowsHide:true,env:{...process.env,HG_SMOKE_EXE:executable}});
if(metadata.stdout.trim()!==expected+'.0')throw new Error('Packaged EXE is not 1.5.7.0; wait for the build to finish');
async function productionPids(){
 const code='$r=(Join-Path $env:ProgramFiles "hongguo-desktop")+"\\"; ConvertTo-Json -InputObject @((Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($r,[StringComparison]::OrdinalIgnoreCase)}).ProcessId) -Compress';
 const result=await exec(ps,['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:15000});return JSON.parse(result.stdout.trim());
}
const before=await productionPids(),checks=[],pageErrors=[];let instance,page,measurements;
const check=(name,ok,detail={})=>{checks.push({name,ok,...detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const poll=async(test,timeout)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await test();if(value)return value;if(await page.evaluate(()=>!!window.__releaseSmoke?.terminalSeen))throw new Error('Terminal playback error appeared');await page.waitForTimeout(200);}throw new Error('Playback smoke timed out');};
try{
 instance=await electron.launch({executablePath:executable,args:[],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:90000});
 page=await instance.firstWindow();page.on('pageerror',error=>pageErrors.push(['Error','TypeError','RangeError','SyntaxError'].includes(error.name)?error.name:'other'));
 await page.waitForSelector('.app-shell',{timeout:30000});
 const start=await page.evaluate(async()=>{const health=await window.hongguo.request('/health'),session=await window.hongguo.request('/account/session');return{ok:health.ok,signer:health.signer,version:health.version,loggedOut:!session.loggedIn,dtoBridge:typeof window.hongguo.mediaRequestResult==='function',diagnosticBridge:typeof window.hongguo.recordPlaybackDiagnostics==='function'};});
 check('packaged native/Python/signer ready and logged out',start.ok&&start.signer&&start.version===expected&&start.loggedOut&&start.dtoBridge&&start.diagnosticBridge,start);
 const isolation=await instance.evaluate(({app,BrowserWindow,webContents})=>({profile:app.getPath('userData'),hidden:BrowserWindow.getAllWindows().every(window=>!window.isVisible()),muted:webContents.getAllWebContents().every(contents=>contents.isAudioMuted())}));
 check('isolated hidden and silent',path.resolve(isolation.profile)===path.resolve(profile)&&isolation.hidden&&isolation.muted);
 await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:3,autoplay:true,volume:0,danmaku:{enabled:false}}));await page.reload();await page.waitForSelector('.app-shell');
 await instance.evaluate(({ipcMain})=>{
  globalThis.__releaseSmokeMain={ids:new Map(),dto:[],cloudProgressRequests:0};
  const original=ipcMain._invokeHandlers.get('media:request');if(!original)throw new Error('Packaged media IPC is absent');
  ipcMain.removeHandler('media:request');ipcMain.handle('media:request',async(...args)=>{
   const result=await original(...args),options=args[2]??{},data=result?.ok===true?result.data:null;
   if(data){
    let localUrl=false;try{const url=new URL(data.url);localUrl=url.hostname==='127.0.0.1'&&url.pathname==='/media/session/'+data.id+'/index.m3u8';}catch{}
    const valid=typeof data.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(data.id)&&localUrl&&['preparing','ready','complete','error','cancelled'].includes(data.phase);
    globalThis.__releaseSmokeMain.dto.push({valid,phase:data.phase,episode:options.body?.episode});globalThis.__releaseSmokeMain.dto=globalThis.__releaseSmokeMain.dto.slice(-40);
    if(options.method==='POST'&&Number.isInteger(options.body?.episode))globalThis.__releaseSmokeMain.ids.set(options.body.episode,data.id);
   }
   return result;
  });
  const originalFetch=globalThis.fetch;globalThis.fetch=(...args)=>{try{if(new URL(String(args[0])).pathname==='/account/progress')globalThis.__releaseSmokeMain.cloudProgressRequests++;}catch{}return originalFetch(...args);};
 });
 await page.evaluate(()=>{
  const data=window.__releaseSmoke={frames:[],events:[],samples:[],terminalSeen:false},seen=new WeakSet();
  const attach=()=>{data.terminalSeen||=!!document.querySelector('.player-error');for(const video of document.querySelectorAll('video')){
   if(seen.has(video))continue;seen.add(video);
   if(!video.requestVideoFrameCallback)throw new Error('Frame presentation API required');
   for(const name of ['waiting','playing','pause','ended','stalled'])video.addEventListener(name,()=>{if(video.dataset.active==='true')data.events.push({name,at:performance.now(),episode:Number(video.dataset.episode),time:video.currentTime});if(data.events.length>600)data.events.shift();});
   const frame=(_now,metadata)=>{if(!video.isConnected)return;const css=getComputedStyle(video),rect=video.getBoundingClientRect(),active=video.dataset.active==='true',cover=!!document.querySelector('.player-startup-cover,.playback-placeholder');
    data.frames.push({at:performance.now(),slot:[...document.querySelectorAll('video')].indexOf(video),episode:active?Number(video.dataset.episode):null,active,cover,status:!!document.querySelector('.player-status'),rendered:css.display!=='none'&&css.visibility==='visible'&&Number(css.opacity)>0&&rect.width>0&&rect.height>0,opacity:Number(css.opacity),display:css.display,visibility:css.visibility,mediaTime:metadata.mediaTime,currentTime:video.currentTime,rate:video.playbackRate,paused:video.paused,width:video.videoWidth,height:video.videoHeight,presentedFrames:metadata.presentedFrames});if(data.frames.length>6000)data.frames.shift();video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
  }};
  new MutationObserver(attach).observe(document.body,{childList:true,subtree:true});attach();
  setInterval(()=>{const v=document.querySelector('video[data-active=true]');if(!v)return;data.terminalSeen||=!!document.querySelector('.player-error');data.samples.push({at:performance.now(),episode:Number(v.dataset.episode),time:v.currentTime,nativeDuration:Number.isFinite(v.duration)?v.duration:null,rate:v.playbackRate,paused:v.paused,ended:v.ended,cover:!!document.querySelector('.player-startup-cover,.playback-placeholder'),status:!!document.querySelector('.player-status')});if(data.samples.length>1200)data.samples.shift();},200);
 });
 const query='人前小保姆',search=page.getByLabel('搜索剧名、演员或关键词');await search.fill(query);await search.press('Enter');
 const card=page.locator('.series-card').filter({hasText:query}).first();await card.waitFor({timeout:120000});const seriesId=await card.getAttribute('data-series-id');
 check('real anonymous catalog candidate found',!!seriesId,{query,seriesHash:createHash('sha256').update(seriesId||'').digest('hex').slice(0,12)});
 await card.locator('.series-poster-button').click();await page.waitForSelector('.detail-hero',{timeout:120000});
 const playStarted=Date.now();await page.getByRole('dialog').locator('.episode-grid button').first().click();
 const first=await poll(()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),frames=window.__releaseSmoke.frames;if(!v||v.paused||v.videoWidth<=0||v.playbackRate!==3||document.querySelector('.player-startup-cover,.playback-placeholder,.player-status'))return null;const frame=frames.find(frame=>frame.episode===Number(v.dataset.episode)&&frame.active&&!frame.cover&&!frame.status&&frame.rendered&&!frame.paused&&frame.rate===3);return frame?{episode:Number(v.dataset.episode),duration:Number.isFinite(v.duration)?v.duration:null,firstObservedFrame:frames.find(frame=>frame.active)??null,frame}:null;}),180000);
 check('actual displayed first frames at 3x after startup cover clears',first.frame.rate===3&&first.frame.width>0&&first.frame.mediaTime<5,{firstFrameWaitMs:Date.now()-playStarted,episode:first.episode,duration:first.duration,firstObservedFrame:first.firstObservedFrame,firstDisplayedFrame:first.frame});
 async function stable(episode){return poll(()=>page.evaluate(episode=>{
  const d=window.__releaseSmoke,v=document.querySelector('video[data-active=true]'),frames=d.frames.filter(frame=>frame.episode===episode&&frame.active),last=frames.at(-1);if(!v||Number(v.dataset.episode)!==episode||v.paused||document.querySelector('.player-startup-cover,.playback-placeholder,.player-status')||!last)return null;
  const first=frames.findLast(frame=>last.at-frame.at>=3200);if(!first)return null;const elapsed=(last.at-first.at)/1000,advance=last.mediaTime-first.mediaTime,rate=advance/elapsed;
  if(rate<2.7||rate>3.3||frames.some(frame=>frame.at>=first.at&&(frame.cover||frame.status||!frame.rendered||frame.paused||frame.rate!==3))||d.events.some(event=>event.episode===episode&&event.name==='waiting'&&event.at>=first.at&&event.at<=last.at)||d.samples.some(sample=>sample.episode===episode&&sample.at>=first.at&&sample.at<=last.at&&(sample.paused||sample.rate!==3||sample.cover||sample.status)))return null;
  return{episode,observedMs:last.at-first.at,mediaAdvanceSeconds:advance,actualMediaPerWallSecond:rate,nativeDuration:Number.isFinite(v.duration)?v.duration:null,frames:frames.filter(frame=>frame.at>=first.at).length,startAt:first.at,endAt:last.at};
 },episode),45000);}
 const initialStable=await stable(first.episode);check('first episode sustained decoded 3x',initialStable.observedMs>=3200,initialStable);
 const id=await instance.evaluate((_electron,episode)=>globalThis.__releaseSmokeMain.ids.get(episode),first.episode);
 const dto=await page.evaluate(async id=>{const reply=await window.hongguo.mediaRequestResult('/media/session/'+id);return{ok:reply.ok,phase:reply.ok?reply.data.phase:null,duration:reply.ok?reply.data.duration:null};},id);
 check('real media DTO readable through packaged NativeBridge',dto.ok&&['ready','complete'].includes(dto.phase)&&dto.duration>0,dto);
 await page.evaluate(episode=>window.hongguo.recordPlaybackDiagnostics({v:1,events:[{v:1,type:'playback_event',sequence:1,elapsedMs:0,stage:'pipeline',action:'inspect',reason:'none',episode}]}),first.episode);
 check('packaged diagnostics bridge callable',true);
 const next=await poll(()=>page.evaluate(previous=>{const v=document.querySelector('video[data-active=true]');return v&&!v.paused&&Number(v.dataset.episode)!==previous&&window.__releaseSmoke.frames.some(frame=>frame.episode===Number(v.dataset.episode))?Number(v.dataset.episode):null;},first.episode),Math.min(300000,Math.max(120000,(first.duration||180)/3*1000+90000)));
 check('at least one natural automatic episode transition',next>first.episode,{from:first.episode,to:next});
 const nextStable=await stable(next);check('next episode has 3.2s sustained actual decoded 3x',nextStable.observedMs>=3200,nextStable);
 measurements=await page.evaluate(()=>{const d=window.__releaseSmoke,lastAt=performance.now();return{terminalSeen:d.terminalSeen,events:d.events,frameCount:d.frames.length,firstObservedFrame:d.frames.find(frame=>frame.active)??null,badFrames:d.frames.filter(frame=>frame.active&&(frame.rate!==3||frame.cover||frame.status||!frame.rendered||frame.paused)).slice(0,40),lastFrames:d.frames.slice(-20),lastSamples:d.samples.slice(-20),waitingIntervals:d.events.filter(event=>event.name==='waiting').map(event=>{const resumed=d.events.find(next=>next.episode===event.episode&&next.name==='playing'&&next.at>=event.at);return{episode:event.episode,durationMs:(resumed?.at??lastAt)-event.at,resumed:!!resumed};})};});
 check('no page or terminal playback error',pageErrors.length===0&&!measurements.terminalSeen,{pageErrorCount:pageErrors.length,terminalSeen:measurements.terminalSeen});
 const stored=JSON.parse(await readFile(path.join(profile,'library.json'),'utf8')),cloud=await instance.evaluate(()=>globalThis.__releaseSmokeMain.cloudProgressRequests);
 check('no account progress uploaded',Object.keys(stored.outbox||{}).length===0&&cloud===0,{outbox:0,cloudProgressRequests:cloud});
 await page.screenshot({path:path.join(out,'playback.png')});
}catch(error){checks.push({name:'packaged playback smoke interrupted',ok:false,errorType:['Error','TypeError','RangeError','SyntaxError','TimeoutError'].includes(error.name)?error.name:'other'});console.log(JSON.stringify(checks.at(-1)));process.exitCode=1;}
finally{
 if(page&&!measurements)measurements=await page.evaluate(()=>{const d=window.__releaseSmoke;return d?{terminalSeen:d.terminalSeen,events:d.events,frameCount:d.frames.length,firstObservedFrame:d.frames.find(frame=>frame.active)??null,badFrames:d.frames.filter(frame=>frame.active&&(frame.rate!==3||frame.cover||frame.status||!frame.rendered||frame.paused)).slice(0,40),lastFrames:d.frames.slice(-20),lastSamples:d.samples.slice(-20)}:null;}).catch(()=>null);
 const dto=await instance?.evaluate(()=>globalThis.__releaseSmokeMain?.dto??[]).catch(()=>[]);
 await instance?.evaluate(({app})=>app.quit()).catch(()=>{});await instance?.close().catch(()=>{});
 const after=await productionPids(),preserved=before.every(pid=>after.includes(pid));checks.push({name:'production processes untouched',ok:preserved,beforeCount:before.length});if(!preserved)process.exitCode=1;
 await writeFile(path.join(out,'result.json'),JSON.stringify({expectedVersion:expected,executable,label,checks,pageErrors,measurements,dto,realAnonymousUpstream:true,noSyntheticSeek:true,profileIsolated:true},null,2));
}
