// Bounded real anonymous online check; no IPC replacement, copied account data or URL logging.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile,lstat,realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root=process.cwd(),work=path.join(root,'_work','paused-buffer');
const executable=path.join(root,'release','win-unpacked','红果桌面.exe');
const profile=path.join(work,'profile-online'),owner=path.join(profile,'qa-owner.json');
await mkdir(work,{recursive:true});
const existing=await lstat(profile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(existing){
  if(!existing.isDirectory()||existing.isSymbolicLink()||path.dirname(await realpath(profile))!==await realpath(work)||JSON.parse(await readFile(owner,'utf8')).kind!=='paused-buffer-online')throw new Error('Online QA profile ownership mismatch');
}else{await mkdir(profile);await writeFile(owner,JSON.stringify({kind:'paused-buffer-online'}));}
const checks=[],samples=[],pageErrors=[];let instance,page,stage='launch',passed=false,seriesHash=null;
const started=Date.now();
const check=(name,ok,details={})=>{checks.push({name,ok,...details});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error('Online assertion failed');};
async function sample(label){
  const state=await page.evaluate(()=>{
    const v=document.querySelector('video[data-active=true]'),ranges=[];
    if(v)for(let i=0;i<v.buffered.length;i++)ranges.push({start:v.buffered.start(i),end:v.buffered.end(i)});
    return{episode:Number(v?.dataset.episode)||null,time:v?.currentTime??null,duration:Number.isFinite(v?.duration)?v.duration:null,paused:v?.paused??null,ended:v?.ended??null,seeking:v?.seeking??null,width:v?.videoWidth??0,height:v?.videoHeight??0,rate:v?.playbackRate??null,ranges,barPercent:parseFloat(document.querySelector('.buffer-bar')?.style.width||'0'),frames:window.__onlinePause?.frames??0,frameMediaTime:window.__onlinePause?.frameMediaTime??null,terminal:!!document.querySelector('.player-error'),pending:!!document.querySelector('.switch-status'),cover:!!document.querySelector('.player-startup-cover,.playback-placeholder'),status:!!document.querySelector('.player-status')};
  });
  const row={label,elapsedMs:Date.now()-started,...state};samples.push(row);return row;
}
async function until(predicate,timeout,label){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const state=await sample(label);if(state.terminal)throw new Error('Terminal media state');if(predicate(state))return state;await page.waitForTimeout(250);}
  throw new Error('Bounded stage timeout');
}
try{
  instance=await electron.launch({executablePath:executable,args:[],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:work,TMP:work},timeout:60000});
  page=await instance.firstWindow();page.on('pageerror',error=>pageErrors.push(['Error','TypeError','RangeError','SyntaxError','TimeoutError'].includes(error.name)?error.name:'other'));
  const isolated=await instance.evaluate(({app,BrowserWindow,webContents})=>({profile:app.getPath('userData'),version:app.getVersion(),hidden:BrowserWindow.getAllWindows().every(w=>!w.isVisible()),muted:webContents.getAllWebContents().every(c=>c.isAudioMuted())}));
  check('packaged isolated hidden silent instance',path.resolve(isolated.profile)===path.resolve(profile)&&isolated.hidden&&isolated.muted,{version:isolated.version});
  stage='homepage';await page.waitForSelector('.app-shell',{timeout:30000});
  await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:3,autoplay:true,volume:0,danmaku:{enabled:false}}));
  await page.reload();
  const card=page.locator('.series-card').first();await card.waitFor({timeout:30000});
  const seriesId=await card.getAttribute('data-series-id');seriesHash=createHash('sha256').update(seriesId||'').digest('hex').slice(0,12);
  check('real homepage has a playable catalog card',!!seriesId,{seriesHash});
  stage='detail';await card.locator('.series-poster-button').click();
  const firstEpisode=page.getByRole('dialog').locator('.episode-grid button').first();await firstEpisode.waitFor({timeout:30000});
  await page.evaluate(()=>{
    const data=window.__onlinePause={frames:0,frameMediaTime:null},seen=new WeakSet();
    const attach=()=>{for(const video of document.querySelectorAll('video')){if(seen.has(video))continue;seen.add(video);const frame=(_time,meta)=>{if(!video.isConnected)return;if(video.dataset.active==='true'){data.frames++;data.frameMediaTime=meta.mediaTime;}video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);}};
    new MutationObserver(attach).observe(document.body,{childList:true,subtree:true});attach();
  });
  stage='start-playback';await firstEpisode.click();
  const playing=await until(s=>s.frames>=3&&s.width>0&&s.height>0&&!s.paused&&!s.cover&&!s.pending&&s.time>.1&&s.duration>0&&s.rate===3,90000,'starting');
  check('real online first episode decoding at 3x',true,{episode:playing.episode,duration:playing.duration,width:playing.width,height:playing.height,frames:playing.frames});
  stage='pause';await page.keyboard.press('k');
  const paused=await until(s=>s.paused,3000,'pausing'),target=Math.min(paused.duration,paused.time+60);
  const aheadBefore=Math.max(0,...paused.ranges.filter(r=>r.start<=paused.time+.2).map(r=>r.end-paused.time));
  stage='paused-buffer';
  const filled=await until(s=>s.ranges.some(r=>r.start<=paused.time+.2&&r.end>=target-.2),90000,'buffering-paused');
  await page.waitForTimeout(1200);const stable=await sample('paused-buffer-stable');
  check('real online pause reaches forward budget or end',stable.ranges.some(r=>r.start<=paused.time+.2&&r.end>=target-.2),{target,aheadBefore,paused,filled,stable});
  check('real online pause remains still in original episode',stable.paused&&stable.episode===paused.episode&&Math.abs(stable.time-paused.time)<.1&&!stable.ended&&!stable.pending&&!stable.terminal,{timeAdvance:stable.time-paused.time,episode:stable.episode});
  const lastRange=stable.ranges.at(-1),bufferPercent=(lastRange?.end||0)/stable.duration*100;
  check('real online buffer bar matches native buffered range',Math.abs(stable.barPercent-bufferPercent)<1,{barPercent:stable.barPercent,bufferPercent});
  stage='resume';await page.keyboard.press('Space');const resumed=await until(s=>!s.paused,3000,'resuming');await page.waitForTimeout(1400);const moved=await sample('resumed+1.4s');
  check('real online resume decodes and advances',!moved.paused&&moved.episode===paused.episode&&moved.time-resumed.time>.5&&moved.frames-resumed.frames>=8&&!moved.terminal,{resumed,moved});
  check('no renderer exception during online pause check',pageErrors.length===0,{pageErrors});passed=true;stage='complete';
}catch(error){
  const errorType=['Error','TypeError','RangeError','SyntaxError','TimeoutError'].includes(error.name)?error.name:'other';
  checks.push({name:'bounded real online pause check',ok:false,stage,errorType});console.log(JSON.stringify(checks.at(-1)));process.exitCode=1;
}finally{
  if(page)await sample('final').catch(()=>{});
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  await writeFile(path.join(work,'online-pause-result.json'),JSON.stringify({passed,stage,seriesHash,checks,pageErrors,samples,realAnonymousUpstream:true,noIpcReplacement:true,isolatedProfile:true},null,2));
}
