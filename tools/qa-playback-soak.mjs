// One application lifetime, real local HLS, 20 natural transitions, no cloud writes.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),workName=process.argv.includes('--final')?'playback-link-soak-final':'playback-link-soak',work=path.join(root,'_work',workName);await mkdir(work,{recursive:true});
process.env.TEMP=work;process.env.TMP=work;
const sourceFiles=['src/components/Player.tsx','src/playback/HlsDeck.ts','src/playback/MediaSessionLease.ts','src/playback/SeamlessSwitcher.ts','src/playback/MediaReconnectCoordinator.ts','src/playback/MediaPreload.ts','src/playback/PlaybackTrace.ts','shared/playback-diagnostics.ts','tools/qa-playback-soak.mjs'];
const hashSources=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
const sourceHashes=await hashSources();
let prefix=(await readFile(path.join(root,'tools','qa-playback-stall.mjs'),'utf8')).split('const server=createServer(')[0];
prefix=prefix.replace("'./quiet-electron.mjs'",JSON.stringify(pathToFileURL(path.join(root,'tools','quiet-electron.mjs')).href)).replace("'_work/playback-stall-qa'",JSON.stringify('_work/'+workName));
const fixture=String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Hls from 'hls.js';
import Player from '../../src/components/Player';
import '../../src/styles.css';
const d=window.__soak={sessions:new Map(),attempts:{},generations:{},deletes:{},posts:[],progressSaves:0,cloudWrites:0,engines:new Set(),allEngines:new Set(),frames:{},sequence:[],errors:[],hlsErrors:[],samples:[],badRateSamples:[],intervals:new Map(),timeouts:new Map(),peakIntervals:0,peakTimeouts:0,peakDecoders:0,peakLeaseHandles:0,steadyLeasePeak:0,ownerMismatches:0,rateErrors:0,backwardFrames:0,unexpectedPauseMaxMs:0,pauseSince:null};
d.primingRateSamples=0;
const si=window.setInterval.bind(window),ci=window.clearInterval.bind(window),st=window.setTimeout.bind(window),ct=window.clearTimeout.bind(window);
window.setInterval=(fn,ms,...args)=>{const id=si(fn,ms,...args);d.intervals.set(id,ms);d.peakIntervals=Math.max(d.peakIntervals,d.intervals.size);return id;};
window.clearInterval=id=>{d.intervals.delete(id);ci(id);};
window.setTimeout=(fn,ms,...args)=>{if(typeof fn!=='function')return st(fn,ms,...args);let id;id=st(()=>{d.timeouts.delete(id);Reflect.apply(fn,window,args);},ms);d.timeouts.set(id,ms);d.peakTimeouts=Math.max(d.peakTimeouts,d.timeouts.size);return id;};
window.clearTimeout=id=>{d.timeouts.delete(id);ct(id);};
const attach=Hls.prototype.attachMedia,destroy=Hls.prototype.destroy;
Hls.prototype.attachMedia=function(video){d.engines.add(this);d.allEngines.add(this);this.on(Hls.Events.ERROR,(_event,error)=>d.hlsErrors.push({at:performance.now(),type:error.type,details:error.details,fatal:error.fatal}));const result=attach.call(this,video);d.peakDecoders=Math.max(d.peakDecoders,[...d.engines].filter(engine=>engine.media).length);return result;};
Hls.prototype.destroy=function(){d.engines.delete(this);return destroy.call(this);};
const detail={series:{id:'12345678',title:'本地镜像连续播放压力',totalEpisodes:22,cover:'',intro:'',tags:[],actors:[]},episodes:Array.from({length:22},(_,n)=>({index:n+1,vid:String(12345670+n),title:'镜像第'+(n+1)+'集',duration:60}))};
const active=()=>document.querySelector('video[data-active=true]');
window.hongguo={
 async request(route,options={}){
  if(route.endsWith('/seasons'))return{seriesId:'12345678',status:'single',currentSeason:1,seasons:[]};
  if(route.endsWith('/next-season'))return{seriesId:'12345678',status:'none',season:1,nextSeason:null,next:null,source:null,firstEpisode:null};
  if(route==='/media/session'&&options.method==='POST'){
   const ep=options.body.episode,n=d.attempts[ep]=(d.attempts[ep]||0)+1;d.posts.push({at:performance.now(),episode:ep,attempt:n,start:options.body.start});
   if(ep===9&&n===1){while(active()?.dataset.episode==='8'&&active().currentTime<58.2)await new Promise(resolve=>st(resolve,100));throw new TypeError('Failed to fetch');}
   if(ep===9&&n===2||ep===5&&(n>=2&&n<=4||n>=6&&n<=8)||ep===14&&n>=2&&n<=4)throw new TypeError('Failed to fetch');
   const generation=d.generations[ep]=(d.generations[ep]||0)+1,id='s-'+ep+'-'+generation,session={id,phase:'complete',duration:60,videoCodec:'h264',url:location.origin+'/media/'+id+'/index.m3u8',episode:ep,generation};
   d.sessions.set(id,session);d.peakLeaseHandles=Math.max(d.peakLeaseHandles,d.sessions.size);st(()=>{d.steadyLeasePeak=Math.max(d.steadyLeasePeak,d.sessions.size);},20);return session;
  }
  if(route.startsWith('/media/session/')){const id=route.split('/').at(-1);if(options.method==='DELETE'){d.deletes[id]=(d.deletes[id]||0)+1;d.sessions.delete(id);return{};}const session=d.sessions.get(id);if(!session)throw new Error('播放会话已过期');return session;}
  if(route.startsWith('/catalog/danmaku'))return{seriesId:'12345678',vid:'12345671',source:'mobile',start:0,end:60,items:[],hasMore:false};
  if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
  if(route==='/account/progress'){d.cloudWrites++;throw new Error('Unexpected cloud write in mirror test');}
  throw new Error('Unexpected mirror route');
 },
 async getLibrary(){return{history:[],favorites:[]};},async saveProgress(){d.progressSaves++;},onLibrary(){return()=>{};},onShutdown(){return()=>{};},onVisibility(){return()=>{};},async window(){return false;},async recordPlaybackDiagnostics(){},async savePlaybackDiagnostics(){},async reportPlaybackDiagnostics(){}
};
function Fixture(){const [settings,update]=useState({theme:'dark',quality:'1080p',rate:3,autoplay:true,volume:0,cacheGB:4,danmaku:{enabled:false}}),[open,setOpen]=useState(true);d.stop=()=>setOpen(false);return open?<Player detail={detail} initialEpisode={1} initialPosition={0} settings={settings} accountKey="local" onSettings={patch=>update(previous=>({...previous,...patch}))} onClose={()=>setOpen(false)} onLibrary={()=>{}}/>:null;}
createRoot(document.getElementById('root')).render(<Fixture/>);
const seen=new WeakSet();si(()=>{
 for(const video of document.querySelectorAll('video')){
  if(seen.has(video))continue;seen.add(video);
  const frame=(_now,meta)=>{
   if(video.dataset.active==='true'){
    const ep=Number(video.dataset.episode),engine=[...d.engines].find(engine=>engine.media===video),sid=engine?.url?.match(/\/media\/(s-\d+-\d+)\//)?.[1]||'',session=d.sessions.get(sid),at=performance.now();
    if(!session||session.episode!==ep)d.ownerMismatches++;
    const item=d.frames[ep]||(d.frames[ep]={count:0,firstAt:at,lastAt:at,lastTime:meta.mediaTime,backward:0,sids:new Set(),slots:new Set()});
    if(!video.seeking&&!video.paused&&meta.mediaTime<item.lastTime-.5){item.backward++;d.backwardFrames++;}
    item.count++;item.lastAt=at;item.lastTime=meta.mediaTime;item.sids.add(sid);item.slots.add(Array.from(document.querySelectorAll('video')).indexOf(video));
    if(d.sequence.at(-1)!==ep){d.sequence.push(ep);console.info('SOAK '+JSON.stringify({episode:ep,naturalCuts:d.sequence.length-1,atMs:Math.round(at),liveHandles:d.sessions.size,decoders:d.engines.size}));}
   }
   video.requestVideoFrameCallback(frame);
  };video.requestVideoFrameCallback(frame);
 }
 const v=active(),at=performance.now();if(!v)return;
 if(v.readyState>=2&&!v.paused&&!v.seeking&&v.playbackRate!==3){const cover=document.querySelector('.player-startup-cover'),style=cover?getComputedStyle(cover):null,startupCover=!!cover&&cover.getClientRects().length>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0;startupCover?d.primingRateSamples++:d.rateErrors++;d.badRateSamples.push({at,episode:Number(v.dataset.episode),time:v.currentTime,rate:v.playbackRate,ready:v.readyState,startupCover});}
 if(v.paused&&!v.ended&&v.readyState>=2){d.pauseSince??=at;d.unexpectedPauseMaxMs=Math.max(d.unexpectedPauseMaxMs,at-d.pauseSince);}else d.pauseSince=null;
 const error=document.querySelector('.player-error p')?.textContent;if(error&&d.errors.at(-1)?.message!==error)d.errors.push({at,message:error});
 d.samples.push({at,episode:Number(v.dataset.episode),time:v.currentTime,rate:v.playbackRate,paused:v.paused,ended:v.ended,ready:v.readyState,leaseHandles:d.sessions.size,intervals:d.intervals.size,timeouts:d.timeouts.size});if(d.samples.length>2000)d.samples.shift();
},new URLSearchParams(location.search).has('startup-probe')?1:100);
`;
const start=prefix.indexOf("await writeFile(path.join(work,'fixture.jsx'),String.raw"),end=prefix.indexOf('\nawait build',start);if(start<0||end<start)throw new Error('HLS fixture seam changed');
prefix=prefix.slice(0,start)+"await writeFile(path.join(work,'fixture.jsx'),"+JSON.stringify(fixture)+");\n"+prefix.slice(end);
const driver=prefix+String.raw`
const http=[];const server=createServer(async(req,res)=>{const pathname=new URL(req.url,'http://fixture').pathname;let status=200;try{let file=decodeURIComponent(pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Invalid mirror path');const match=file.match(/^media\/(s-(\d+)-(\d+))\/(.+)$/);if(match){const ep=Number(match[2]),generation=Number(match[3]),sn=Number(match[4].match(/^seg(\d+)\.m4s$/)?.[1]??-1);if(ep===5&&(generation===1&&sn>=7||generation===2&&sn>=19)||ep===14&&generation===1&&sn>=7){status=404;res.writeHead(status);res.end();return;}file='media/'+match[4];}const body=await readFile(path.join(work,file));res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{status=404;res.writeHead(status);res.end();}finally{if(pathname.startsWith('/media/')&&http.length<4096)http.push({at:Date.now(),path:pathname,status});}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page,cdp;const checks=[],pageErrors=[],started=Date.now(),startupProbe=process.argv.includes('--startup-probe');
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));};
const snapshot=()=>page.evaluate(()=>{const d=window.__soak;return{sequence:d.sequence,frames:Object.fromEntries(Object.entries(d.frames).map(([ep,item])=>[ep,{...item,sids:[...item.sids],slots:[...item.slots]}])),posts:d.posts,attempts:d.attempts,deletes:d.deletes,cloudWrites:d.cloudWrites,progressSaves:d.progressSaves,peakLeaseHandles:d.peakLeaseHandles,steadyLeasePeak:d.steadyLeasePeak,liveHandles:d.sessions.size,peakDecoders:d.peakDecoders,liveDecoders:[...d.engines].filter(engine=>engine.media).length,totalEngines:d.allEngines.size,intervals:[...d.intervals.values()],timeouts:[...d.timeouts.values()],peakIntervals:d.peakIntervals,peakTimeouts:d.peakTimeouts,ownerMismatches:d.ownerMismatches,rateErrors:d.rateErrors,primingRateSamples:d.primingRateSamples,badRateSamples:d.badRateSamples,backwardFrames:d.backwardFrames,unexpectedPauseMaxMs:d.unexpectedPauseMaxMs,errors:d.errors,hlsErrors:d.hlsErrors,samples:d.samples};});
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,startupProbe?'probe-profile':'profile'),HG_QA_ORIGIN:origin+(startupProbe?'/?startup-probe':''),TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>pageErrors.push(error.message));page.on('console',entry=>{if(entry.text().startsWith('SOAK '))console.log(entry.text());});cdp=await page.context().newCDPSession(page).catch(()=>null);
 await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>.2,undefined,{timeout:20000});
 if(startupProbe){await page.waitForTimeout(5000);const probe=await snapshot();check('启动priming采样阶段确认',true,{rateErrors:probe.rateErrors,primingRateSamples:probe.primingRateSamples,badRateSamples:probe.badRateSamples});if(probe.badRateSamples.length)await writeFile(path.join(work,'bad-rate-probe.json'),JSON.stringify(probe,null,2));await page.evaluate(()=>window.__soak.stop());await page.waitForTimeout(500);}
 else{
 await page.waitForFunction(()=>{const d=window.__soak,v=document.querySelector('video[data-active=true]');return d.sequence.length>=21&&v?.dataset.episode==='21'&&v.currentTime>2&&!v.paused;},undefined,{timeout:700000,polling:500});await page.waitForTimeout(3200);
 const result=await snapshot();check('单次启动20个自然切集无跳集或回跳',result.sequence.length===21&&result.sequence.every((ep,n)=>ep===n+1),{sequence:result.sequence,elapsedMs:Date.now()-started});
 check('每集均真实解码且当前3倍速/SID归属正确',Object.values(result.frames).every(item=>item.count>=25&&item.slots.length===1&&item.sids.every(sid=>/^s-\d+-\d+$/.test(sid)))&&result.ownerMismatches===0&&result.rateErrors===0&&result.backwardFrames===0,{frames:result.frames,ownerMismatches:result.ownerMismatches,rateErrors:result.rateErrors,backwardFrames:result.backwardFrames});
 check('主动短故障均恢复，没有终止错误或非片尾长暂停',result.errors.length===0&&result.unexpectedPauseMaxMs<1500,{errors:result.errors,unexpectedPauseMaxMs:result.unexpectedPauseMaxMs,attempts:result.attempts});
 check('两解码槽、事务最多三lease、稳定状态最多两lease',result.peakLeaseHandles<=3&&result.steadyLeasePeak<=2&&result.peakDecoders<=2,{peakLeaseHandles:result.peakLeaseHandles,steadyLeasePeak:result.steadyLeasePeak,peakDecoders:result.peakDecoders,totalEngines:result.totalEngines});
 check('同集两次故障及warm尾部接管均使用有限预算',result.attempts[5]===9&&result.attempts[9]===3&&result.attempts[14]===5,{attempts:result.attempts});
 await page.evaluate(()=>window.__soak.stop());await page.waitForTimeout(1000);const closed=await snapshot(),targets=cdp?await cdp.send('Target.getTargets').catch(()=>null):null,workers=targets?.targetInfos?.filter(target=>target.type==='worker').length??null;
 check('退出后旧slot/lease/定时器取消闭环，无重复释放',closed.liveHandles===0&&closed.liveDecoders===0&&closed.intervals.length===0&&closed.timeouts.length===0&&Object.values(closed.deletes).every(count=>count===1)&&closed.cloudWrites===0,{liveHandles:closed.liveHandles,liveDecoders:closed.liveDecoders,intervals:closed.intervals,timeouts:closed.timeouts,workerTargets:workers,cloudWrites:closed.cloudWrites});
 if(workers!==null)check('退出后HLS dedicated worker均已结束',workers===0,{workers});
 }
 if(checks.some(item=>!item.ok)||pageErrors.length)process.exitCode=1;
}catch(error){check('持续连播压力执行',false,{message:error.message,elapsedMs:Date.now()-started});process.exitCode=1;}
finally{const result=page?await snapshot().catch(()=>({})):{};await writeFile(path.join(work,startupProbe?'probe-result.json':'result.json'),JSON.stringify({mode:'isolated mirror, not phone E2E',singleAppLifetime:true,noSyntheticTimeAssignment:true,elapsedMs:Date.now()-started,checks,pageErrors,http,...result},null,2));if(page)await page.screenshot({path:path.join(work,startupProbe?'probe-result.png':'result.png')}).catch(()=>{});if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
`;
await writeFile(path.join(work,'source-hashes.json'),JSON.stringify(sourceHashes,null,2));await writeFile(path.join(work,'driver.mjs'),driver);await import(pathToFileURL(path.join(work,'driver.mjs')).href);
if(!process.argv.includes('--startup-probe')){
 const result=JSON.parse(await readFile(path.join(work,'result.json'),'utf8'));
 const sourceHashesAfterRun=await hashSources();
 const bundleSHA256=createHash('sha256').update(await readFile(path.join(work,'fixture.js'))).digest('hex');
 const sourceStable=sourceFiles.every(file=>sourceHashes[file]===sourceHashesAfterRun[file]);
 await writeFile(path.join(work,'provenance.json'),JSON.stringify({bundleSHA256,sourceHashes,sourceHashesAfterRun,sourceStable,elapsedMs:result.elapsedMs,cuts:result.sequence.length-1,rateErrors:result.rateErrors,primingRateSamples:result.primingRateSamples,rawBadRateSamples:result.badRateSamples,checks:result.checks},null,2));
 if(!sourceStable){console.log(JSON.stringify({name:'实际运行源码未发生中途漂移',ok:false}));process.exitCode=1;}
}
