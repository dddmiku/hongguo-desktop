// Real Player/Main/preload with local HLS and an isolated, silent guest profile.
// Compare requests, actual TimeRanges and the UI bar; never read production data.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import path from 'node:path';

const root=process.cwd(),work=path.join(root,'_work','paused-buffer');
const installed=process.argv.includes('--installed'),packaged=process.argv.includes('--packaged');
const mode=installed?'installed':packaged?'packaged':'source';
const option=(name,fallback)=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3)||fallback;
const rate=Number(option('rate','3')),duration=Number(option('duration','120')),scenario=option('scenario','basic');
const label=option('label',`${mode}-${scenario}-${rate}x-${duration}s`);
if(![1,3].includes(rate))throw new Error('rate must be 1 or 3');
if(![51,120].includes(duration))throw new Error('duration must be 51 or 120');
if(!['basic','late','rate','quality','visibility'].includes(scenario))throw new Error('unknown scenario');
await mkdir(work,{recursive:true});
const media=path.join(work,`media-${duration}s`);await mkdir(media,{recursive:true});
try{await access(path.join(media,'index.m3u8'));}catch{
  execFileSync(path.join(root,'runtime','ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=20','-t',String(duration),'-c:v','libx264','-threads','2','-preset','ultrafast','-pix_fmt','yuv420p','-g','40','-an','-f','hls','-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_filename',path.join(media,'seg-%03d.ts'),path.join(media,'index.m3u8')],{windowsHide:true,timeout:60000});
}
const requests=[],checks=[],errors=[],samples=[],gates=[];let instance,page,origin,gateFrom=Infinity;
const started=Date.now();
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture.invalid'),match=url.pathname.match(/^\/episode\/(\d+)\/session\/([a-z0-9-]+)\/(index\.m3u8|seg-\d+\.ts)$/);
  if(!match){res.writeHead(404).end();return;}
  const entry={at:Date.now()-started,episode:Number(match[1]),session:match[2],file:match[3],bytes:0,complete:false,aborted:false};requests.push(entry);
  res.on('close',()=>{if(!entry.complete)entry.aborted=true;});
  try{
    const body=await readFile(path.join(media,entry.file));
    if(entry.file.endsWith('.ts')){
      const segment=Number(entry.file.match(/\d+/)[0]);
      if(entry.episode===1&&segment>=gateFrom)await new Promise(resolve=>gates.push(resolve));
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    if(res.destroyed)return;
    res.writeHead(200,{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store','Content-Type':entry.file.endsWith('.ts')?'video/mp2t':'application/vnd.apple.mpegurl'}).end(body);
    entry.complete=true;entry.bytes=body.length;entry.completeAt=Date.now()-started;
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const check=(name,ok,detail)=>{checks.push({name,ok,...detail===undefined?{}:{detail}});console.log(JSON.stringify(checks.at(-1)));if(!ok)process.exitCode=1;};
const observe=async(name)=>{
  const state=await page.evaluate(()=>{
    const video=document.querySelector('video[data-active=true]'),bar=document.querySelector('.buffer-bar');
    const ranges=[];if(video)for(let i=0;i<video.buffered.length;i++)ranges.push({start:video.buffered.start(i),end:video.buffered.end(i)});
    return{episode:Number(video?.dataset.episode),time:video?.currentTime,duration:video?.duration,paused:video?.paused,seeking:video?.seeking,ended:video?.ended,width:video?.videoWidth,rate:video?.playbackRate,ranges,barPercent:parseFloat(bar?.style.width||'0'),pending:!!document.querySelector('.switch-status'),terminal:!!document.querySelector('.player-error'),frames:window.__pausedBufferFrames||0,visibility:window.__pausedBufferVisibility||[]};
  });
  const activeRequests=requests.filter(r=>r.episode===state.episode&&r.file.endsWith('.ts'));
  const result={name,at:Date.now()-started,...state,segments:activeRequests.length,bytes:activeRequests.reduce((n,r)=>n+r.bytes,0)};samples.push(result);return result;
};
try{
  instance=await electron.launch({...(installed||packaged?{executablePath:process.env.HG_QA_EXECUTABLE||path.join(installed?process.env.ProgramFiles:root,installed?'hongguo-desktop':'release/win-unpacked','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile-'+mode),HG_TEST_BACKGROUND:'1',TEMP:work,TMP:work},timeout:60000});
  page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));
  const actualProfile=await instance.evaluate(({app})=>app.getPath('userData'));
  if(path.resolve(actualProfile)!==path.join(work,'profile-'+mode))throw new Error('QA profile is not isolated');
  await instance.evaluate(({ipcMain},{origin,duration})=>{
    const series={id:'9999999999999997801',title:'暂停缓冲测试剧',cover:'',intro:'合成本地 HLS',totalEpisodes:3,tags:[],actors:[]};
    const detail={series,episodes:[1,2,3].map(index=>({index,vid:String(99997800+index),title:`第 ${index} 集`,duration}))};
    let count=0;const sessions=new Map();globalThis.__pausedBufferAudit={creates:[],trace:[]};
    ipcMain.removeHandler('playback:diagnostics');ipcMain.handle('playback:diagnostics',(_e,snapshot)=>{globalThis.__pausedBufferAudit.trace=snapshot?.events||[];});
    const fixture=(route,options={})=>{
      if(route==='/account/session')return{loggedIn:false,uid:'',nickname:'',avatar:'',mobile:''};
      if(route===`/catalog/series/${series.id}`)return detail;
      if(route.endsWith('/next-season'))return{seriesId:series.id,status:'none'};
      if(route.endsWith('/seasons'))return{seriesId:series.id,status:'single',currentSeason:1,seasons:[],complete:true};
      if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
      if(route.startsWith('/catalog/danmaku'))return{items:[],start:0,end:duration,hasMore:false,seriesId:series.id,vid:detail.episodes[0].vid,source:'mobile'};
      if(route.startsWith('/catalog/filters'))return{groups:[]};
      if(route.startsWith('/catalog/'))return{items:[series],hasMore:false,cursor:null};
      if(route.startsWith('/media/session')){
        if(options.method==='DELETE')return{};
        if(route==='/media/session'){
          globalThis.__pausedBufferAudit.creates.push({episode:options.body.episode,start:options.body.start||0,quality:options.body.quality});
          const id='paused-'+ ++count;
          const s={id,phase:'complete',url:`${origin}/episode/${options.body.episode}/session/${id}/index.m3u8`,duration};sessions.set(s.id,s);return s;
        }
        return sessions.get(route.split('/').at(-1));
      }
      if(route==='/media/cache/settings')return{};
      throw new Error('Unexpected pause-buffer fixture route');
    };
    for(const channel of ['api:request','media:request'])ipcMain.removeHandler(channel);
    ipcMain.handle('api:request',(_e,route,options)=>fixture(route,options));
    ipcMain.handle('media:request',async(_e,route,options)=>({ok:true,data:fixture(route,options)}));
  },{origin,duration});
  await page.waitForSelector('.app-shell');
  await page.evaluate(rate=>window.hongguo.saveSettings({rate,quality:'1080p',autoplay:true,volume:0,danmaku:{enabled:false}}),rate);
  await page.reload();await page.waitForSelector('.app-shell');
  await page.getByLabel('搜索剧名、演员或关键词').fill('暂停缓冲测试剧');
  await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  await page.locator('.series-poster-button').first().click();
  await page.getByRole('dialog').getByRole('button',{name:'播放第 1 集',exact:true}).click();
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.videoWidth>0&&!v.paused&&v.currentTime>.3;},undefined,{timeout:20000});
  await page.evaluate(()=>{
    window.__pausedBufferFrames=0;window.__pausedBufferVisibility=[];
    window.hongguo.onVisibility(visible=>window.__pausedBufferVisibility.push(visible));
    for(const video of document.querySelectorAll('video')){
      const frame=()=>{if(video.dataset.active==='true')window.__pausedBufferFrames++;video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
    }
  });
  const playing=await observe('playing');check('真实本地 HLS 已开始解码',playing.width>0&&!playing.paused,playing);
  if(scenario==='late'){
    await page.waitForFunction(rate=>{const v=document.querySelector('video[data-active=true]');return v?.buffered.length&&v.buffered.end(0)-v.currentTime>=Math.max(18,rate*8)-2;},rate,{timeout:10000});
    const normal=await observe('normal-budget-reached');
    check('先达到正常播放前向预算再暂停',normal.ranges.at(-1).end-normal.time>=Math.max(18,rate*8)-2,normal);
  }
  if(scenario==='visibility'){
    const received=requests.filter(r=>r.episode===1&&r.file.endsWith('.ts')).map(r=>Number(r.file.match(/\d+/)[0]));
    gateFrom=Math.max(...received)+2;
  }
  await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.paused);
  const paused=await observe('paused');
  let expectedRate=rate;
  if(scenario==='rate'){
    expectedRate=rate===3?1:3;
    await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByLabel('播放倍速').selectOption(String(expectedRate));
    await page.waitForFunction(value=>document.querySelector('video[data-active=true]')?.playbackRate===value,expectedRate);
    const changed=await observe('paused-rate-changed');check('暂停时改变倍速仍保持暂停',changed.paused&&Math.abs(changed.time-paused.time)<.05,changed);
  }
  if(scenario==='quality'){
    await page.locator('video[data-active=true]').evaluate(video=>window.__pausedBufferOldVideo=video);
    await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByLabel('播放画质').selectOption('720p');
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v!==window.__pausedBufferOldVideo&&v.videoWidth>0&&!document.querySelector('.switch-status');},undefined,{timeout:15000});
    const changed=await observe('paused-quality-changed');
    check('暂停换画质提交新解码槽后仍保持暂停',changed.paused&&changed.episode===paused.episode&&Math.abs(changed.time-paused.time)<.15,changed);
  }
  if(scenario==='visibility'){
    const timeout=Date.now()+5000;while(!gates.length&&Date.now()<timeout)await page.waitForTimeout(25);
    check('隐藏前缓存未满且分片正在等待',gates.length>0,{gateFrom,waiting:gates.length});
    // Exercise the real main-process visibility bridge without showing a QA window.
    // qa-player-visibility.mjs independently covers actual native minimize/restore.
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].emit('hide'));
    await page.waitForFunction(()=>window.__pausedBufferVisibility.at(-1)===false);
    await page.waitForTimeout(250);gateFrom=Infinity;gates.splice(0).forEach(resolve=>resolve());
    await page.waitForTimeout(250);const hidden=await observe('hidden');
    await page.waitForTimeout(1200);const hiddenLater=await observe('hidden+1.2s');
    check('隐藏期间停止新分片请求且保持暂停',hiddenLater.segments===hidden.segments&&hiddenLater.paused&&Math.abs(hiddenLater.time-paused.time)<.05&&hidden.ranges.at(-1).end-hidden.time<60,{hidden,hiddenLater});
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].emit('show'));
    await page.waitForFunction(()=>window.__pausedBufferVisibility.at(-1)===true);
  }
  await page.waitForTimeout(1000);await observe('paused+1s');
  await page.waitForTimeout(3000);const middle=await observe('paused+4s');
  await page.waitForTimeout(3000);const filled=await observe('paused+7s');
  const target=Math.min(duration,paused.time+60);
  check('暂停后当前集继续预缓冲至60秒预算或片尾',filled.ranges.some(r=>r.start<=paused.time+.2&&r.end>=target-.15)&&filled.segments>paused.segments,{target,paused,middle,filled});
  check('缓冲增长同步显示在进度条',Math.abs(filled.barPercent-(filled.ranges.at(-1)?.end||0)/duration*100)<1,filled);
  check('暂停期间不播放不切集且无遗留任务',filled.paused&&filled.episode===paused.episode&&Math.abs(filled.time-paused.time)<.15&&filled.rate===expectedRate&&!filled.pending&&!filled.terminal,filled);
  if(duration===51)check('短片缓冲到结尾不会自动切集',filled.barPercent>=99.9&&!filled.ended&&filled.episode===1&&filled.paused,filled);
  const settledSegments=filled.segments;await page.waitForTimeout(1200);const settled=await observe('paused-budget-stable');
  check('达到暂停预算后停止继续无限预读',settled.segments===settledSegments&&settled.ranges.at(-1).end<=Math.min(duration,paused.time+64),settled);
  await page.keyboard.press('Space');await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&!v.paused;});
  const resumed=await observe('resumed');await page.waitForTimeout(1300);const moving=await observe('resumed+1.3s');
  check('恢复后同集继续实际解码与推进',moving.episode===paused.episode&&!moving.paused&&moving.time-resumed.time>.5&&moving.frames-resumed.frames>=8&&!moving.terminal,{resumed,moving});
  if(duration===120){
    // Keep more than the normal 30 s ceiling but less than the paused 60 s budget.
    // A stale paused budget would request additional first-episode fragments here.
    await page.locator('video[data-active=true]').evaluate(video=>{video.currentTime=video.buffered.end(video.buffered.length-1)-35;});
    await page.waitForFunction(()=>!document.querySelector('video[data-active=true]')?.seeking);
    const normalAgain=await observe('resumed-normal-budget');await page.waitForTimeout(1000);const normalStable=await observe('resumed-normal-budget+1s');
    check('恢复播放后收回暂停额外预算',normalStable.time>normalAgain.time+.5&&!normalStable.paused&&normalStable.segments===settled.segments,{normalAgain,normalStable});
  }
  check('无渲染异常且实例静音隐藏',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(c=>c.isAudioMuted())),errors);
}catch(error){check('执行暂停缓冲回归',false,{errorType:error.name,message:String(error.message).slice(0,300)});}
finally{
  gateFrom=Infinity;gates.splice(0).forEach(resolve=>resolve());
  let audit;
  if(instance){
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.webContents.send('app:flush')).catch(()=>{});
    if(page)await page.waitForTimeout(100).catch(()=>{});
    audit=await instance.evaluate(()=>globalThis.__pausedBufferAudit).catch(()=>null);
    await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});
  }
  await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(work,label+'.json'),JSON.stringify({mode,rate,duration,scenario,checks,errors,samples,requests,audit},null,2));
  if(checks.some(c=>!c.ok))process.exitCode=1;
}
