// Real HLS/Player diagnosis. Production sources remain unchanged; no real account or media.
// --case=clean | tail404 | tail404-outage | warm-outage | warm-promote-outage | tail-eos-held | consecutive-outages
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.cwd(),realMode=process.argv.includes('--real-media'),controlMode=process.argv.includes('--controls'),work=path.join(root,'_work',realMode?'playback-link-real126':controlMode?'playback-link-controls':'playback-link-rootcause');await mkdir(work,{recursive:true});
const sourceFiles=['src/components/Player.tsx','src/playback/HlsDeck.ts','src/playback/MediaSessionLease.ts','src/playback/SeamlessSwitcher.ts','src/playback/MediaReconnectCoordinator.ts','src/playback/MediaPreload.ts','src/playback/PlaybackTrace.ts','shared/playback-diagnostics.ts','tools/qa-playback-link-rootcause.mjs'];
const hashSources=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
const sourceHashes=await hashSources();
process.env.TEMP=work;process.env.TMP=work;
let prefix=(await readFile(path.join(root,'tools','qa-playback-stall.mjs'),'utf8')).split('const server=createServer(')[0];
function replace(from,to){if(!prefix.includes(from))throw new Error('Existing HLS fixture seam changed: '+from.slice(0,60));prefix=prefix.replace(from,to);}
replace("'./quiet-electron.mjs'",JSON.stringify(pathToFileURL(path.join(root,'tools','quiet-electron.mjs')).href));
replace("'_work/playback-stall-qa'",realMode?"'_work/playback-link-real126'":controlMode?"'_work/playback-link-controls'":"'_work/playback-link-rootcause'");
replace("'-t','60'","'-t','59.9'");replace("'-g','40'","'-g','22'");replace("'-hls_time','2'","'-hls_time','1.1'");
replace("totalEpisodes:2","totalEpisodes:181");replace("episodes:[1,2].map","episodes:[126,127].map");
const sourceDuration=realMode?Number(process.env.HG_QA_SOURCE_DURATION||59.187007):59.9;
replace("duration:60}))","duration:"+sourceDuration+"}))");replace("duration:60,videoCodec","duration:"+sourceDuration+",videoCodec");
if(realMode){
 replace("{mkdir,readFile,writeFile}","{mkdir,readFile,writeFile,cp}");
 const start=prefix.indexOf('const generated=spawnSync('),end=prefix.indexOf("throw new Error('Local silent fixture generation failed');",start)+"throw new Error('Local silent fixture generation failed');".length;
 if(start<0||end<start)throw new Error('Existing fixture generation seam changed');
 prefix=prefix.slice(0,start)+"const input=process.env.HG_QA_MEDIA_DIR;if(!input)throw new Error('Set HG_QA_MEDIA_DIR to a read-only local HLS cache');const manifest=await readFile(path.join(input,'index.m3u8'),'utf8');const names=['index.m3u8',...manifest.split(/\\r?\\n/).filter(line=>/^[A-Za-z0-9_.-]+\\.m4s$/.test(line)),...Array.from(manifest.matchAll(/URI=\"([A-Za-z0-9_.-]+)\"/g),m=>m[1])];for(const name of new Set(names))await cp(path.join(input,name),path.join(media,name));\n"+prefix.slice(end);
}
replace("initialEpisode={1}","initialEpisode={126} initialPosition={['consecutive-outages','controls-interrupt','controls-cancel-late'].includes(new URLSearchParams(location.search).get('case'))?0:57}");
replace("data.setActive=setActive;","data.setVolume=volume=>update(previous=>({...previous,volume}));data.setActive=setActive;");
replace("rate:1,autoplay:false","rate:3,autoplay:true");
replace("let counter=0;const sessions=new Map();","let counter=0;const sessions=new Map();data.postCounts={};data.failureEndedAt=null;data.mode=new URLSearchParams(location.search).get('case');data.frames=[];data.samples=[];");
replace("const attach=Hls.prototype.attachMedia;","const trigger=Hls.prototype.trigger;Hls.prototype.trigger=function(event,...args){if(new URLSearchParams(location.search).get('case')==='tail-eos-held'&&event===Hls.Events.BUFFER_EOS){data.eosHeld=(data.eosHeld||0)+1;return;}return trigger.call(this,event,...args);};const attach=Hls.prototype.attachMedia;");
replace("if(route==='/media/session'&&options.method==='POST'){", "if(route==='/media/session'&&options.method==='POST'){const episode=options.body.episode,count=data.postCounts[episode]=(data.postCounts[episode]||0)+1;if(data.mode==='warm-outage'&&episode===127&&count===1)data.failureEndedAt=performance.now()+1500;const failure=data.mode==='tail404-outage'&&episode===126&&count>=2&&count<=4||data.mode==='warm-outage'&&episode===127&&performance.now()<data.failureEndedAt||data.mode==='warm-promote-outage'&&episode===127&&count<=2;if(failure){if(episode===126&&count===4||data.mode==='warm-promote-outage'&&episode===127&&count===2)data.failureEndedAt=performance.now();throw new TypeError('Failed to fetch');}");
replace("const failure=data.mode==='tail404-outage'", "const failure=data.mode==='consecutive-outages'&&episode===126&&(count>=2&&count<=4||count>=6&&count<=8)||data.mode==='tail404-outage'");
replace("const failure=data.mode==='consecutive-outages'", "const failure=data.mode==='controls-interrupt'&&episode===126&&count>=2&&count<=4||data.mode==='consecutive-outages'");
replace("const failure=data.mode==='controls-interrupt'", "if(data.mode==='controls-cancel-late'&&episode===126&&count===2){data.awaitingLate=true;await new Promise(resolve=>data.releaseLate=resolve);data.awaitingLate=false;}const failure=data.mode==='controls-interrupt'");
replace("if(episode===126&&count===4||", "if(episode===126&&(count===4||data.mode==='consecutive-outages'&&count===8)||");
replace("data.requests.push({route", "data.requests.push({at:performance.now(),route");
replace("createRoot(document.getElementById('root')).render(<Fixture/>);", "createRoot(document.getElementById('root')).render(<Fixture/>);const watched=new WeakSet();setInterval(()=>{for(const video of document.querySelectorAll('video')){if(watched.has(video))continue;watched.add(video);const frame=(_now,meta)=>{if(data.frames.length<2500)data.frames.push({at:performance.now(),episode:video.dataset.episode,active:video.dataset.active==='true',time:meta.mediaTime});video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);}const v=document.querySelector('video[data-active=true]');if(v&&data.samples.length<1200)data.samples.push({at:performance.now(),episode:v.dataset.episode,time:v.currentTime,duration:v.duration,ended:v.ended,paused:v.paused,seeking:v.seeking,ready:v.readyState,rate:v.playbackRate,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),error:document.querySelector('.player-error p')?.textContent||''});},100);");
replace("active:video.dataset.active==='true',time:meta.mediaTime", "active:video.dataset.active==='true',slot:Array.from(document.querySelectorAll('video')).indexOf(video),sessionId:data.engines.findLast(row=>row.video===video&&row.engine.media===video)?.engine.url?.match(/media\\/(fixture-\\d+)\\//)?.[1]||'',time:meta.mediaTime");
const driver=prefix+String.raw`
const scenario=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)||'tail404-outage';
if(!['clean','tail404','tail404-outage','warm-outage','warm-promote-outage','tail-eos-held','consecutive-outages','controls-interrupt','controls-cancel-late','replacement-before-health'].includes(scenario))throw new Error('Unknown local scenario');
const folder=path.join(work,scenario);await mkdir(folder,{recursive:true});
const playlist=await readFile(path.join(media,'index.m3u8'),'utf8'),finalSegment=playlist.split(/\r?\n/).filter(line=>/^seg\d+\.m4s$/.test(line)).at(-1),http=[];
const server=createServer(async(req,res)=>{const pathname=new URL(req.url,'http://fixture').pathname;let status=200;try{let file=decodeURIComponent(pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Invalid local path');const match=file.match(/^media\/(fixture-\d+)\/(.+)$/);if(match){const sn=Number(match[2].match(/^seg(\d+)\.m4s$/)?.[1]??-1);const consecutive=scenario==='consecutive-outages'&&(match[1]==='fixture-1'&&sn>=14||match[1]==='fixture-3'&&sn>=38)||scenario.startsWith('controls-')&&match[1]==='fixture-1'&&sn>=14;const badCandidate=scenario==='replacement-before-health'&&match[1]==='fixture-3';if(badCandidate||consecutive||(scenario.startsWith('tail404')||scenario==='replacement-before-health')&&match[1]==='fixture-1'&&match[2]===finalSegment){status=404;res.writeHead(status);res.end();return;}file='media/'+match[2];}const body=await readFile(path.join(work,file));res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{status=404;res.writeHead(status);res.end();}finally{if(pathname.startsWith('/media/'))http.push({at:Date.now(),path:pathname,status});}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[];
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));};
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(folder,'profile'),HG_QA_ORIGIN:origin+'/?case='+scenario,TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 const starting=['consecutive-outages','controls-interrupt','controls-cancel-late'].includes(scenario)?0:57;
 await page.waitForFunction(start=>{const v=document.querySelector('video[data-active=true]');return v?.videoWidth>0&&v.currentTime>start&&v.playbackRate===3;},starting,{timeout:20000});check('真实第126集HLS已解码，3倍速',true,{starting});
 if(scenario==='controls-interrupt'){await page.evaluate(()=>window.__qa.setVolume(.6));await page.keyboard.press('m');await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v.muted&&Math.abs(v.volume-.6)<.0001;});}
 if(['tail404-outage','consecutive-outages','controls-interrupt','controls-cancel-late','replacement-before-health'].includes(scenario)){
  await page.waitForFunction(()=>window.__qa.requests.filter(row=>row.method==='POST'&&row.body.episode===126).length>=2,undefined,{timeout:30000});
  const failure=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');return{episode:v.dataset.episode,time:v.currentTime,duration:v.duration,ended:v.ended,paused:v.paused,seeking:v.seeking,error:document.querySelector('.player-error p')?.textContent||''};});
  check('真实分片404已触发按原播放位置重连',http.some(row=>row.status===404)&&failure.episode==='126'&&(scenario!=='tail404-outage'||Math.floor(failure.time)===59),failure);
  if(scenario==='controls-cancel-late'){
   await page.getByRole('button',{name:'下一集',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.dataset.episode==='127');await page.waitForTimeout(400);
   await page.evaluate(()=>window.__qa.releaseLate());await page.waitForFunction(()=>window.__qa.requests.some(row=>row.route==='/media/session/fixture-3'&&row.method==='DELETE'),undefined,{timeout:3000});
   const late=await page.evaluate(()=>({posts:window.__qa.requests.filter(row=>row.method==='POST'&&row.body.episode===126).length,deletes:window.__qa.requests.filter(row=>row.route==='/media/session/fixture-3'&&row.method==='DELETE').length}));
   check('取消后迟到旧SID仅释放一次且未装入当前解码槽',late.posts===2&&late.deletes===1&&!http.some(row=>row.path.startsWith('/media/fixture-3/')),late);
  }
  if(scenario==='controls-interrupt'){
   const control=()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');return{time:v.currentTime,paused:v.paused,posts:window.__qa.requests.filter(row=>row.method==='POST'&&row.body.episode===126).length,rate:v.playbackRate,muted:v.muted,volume:v.volume};});
   await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('video[data-active=true]').paused);const paused=await control();await page.waitForTimeout(1500);const kept=await control();
   check('重连退避中手动暂停冻结时间轴且不后台追加POST',kept.paused&&Math.abs(kept.time-paused.time)<.05&&kept.posts===paused.posts,{paused,kept});
   await page.evaluate(()=>window.__qa.visibility(false));await page.waitForTimeout(600);await page.evaluate(()=>window.__qa.visibility(true));await page.waitForTimeout(600);const manual=await control();
   check('手动暂停后隐藏再回前台不会自动播放或续接',manual.paused&&manual.posts===paused.posts&&Math.abs(manual.time-paused.time)<.05,manual);
   await page.keyboard.press('k');await page.waitForFunction(()=>window.__qa.requests.filter(row=>row.method==='POST'&&row.body.episode===126).length>=3,undefined,{timeout:5000});
   await page.evaluate(()=>window.__qa.visibility(false));await page.waitForFunction(()=>document.querySelector('video[data-active=true]').paused);const hidden=await control();await page.waitForTimeout(1200);const hiddenKept=await control();
   check('播放意图保留的隐藏窗口暂停退避而不继续POST',hiddenKept.paused&&hiddenKept.posts===hidden.posts,{hidden,hiddenKept});
   await page.evaluate(()=>window.__qa.visibility(true));await page.waitForFunction(()=>!document.querySelector('video[data-active=true]').paused,undefined,{timeout:2000});check('回前台恢复用户此前播放意图',!(await control()).paused);
  }
  const recovered=await page.waitForFunction(()=>{const d=window.__qa,v=document.querySelector('video[data-active=true]');return v?.dataset.episode==='127'&&v.currentTime>2&&!v.paused&&v.videoWidth>0&&v.readyState>=2&&d.frames.filter(frame=>frame.active&&frame.episode==='127').length>=10;},undefined,{timeout:90000}).then(()=>true).catch(()=>false);
  const result=await page.evaluate(()=>{const d=window.__qa,v=document.querySelector('video[data-active=true]');return{episode:v.dataset.episode,time:v.currentTime,error:document.querySelector('.player-error p')?.textContent||'',healthyForMs:d.failureEndedAt===null?null:performance.now()-d.failureEndedAt,posts:d.requests.filter(row=>row.method==='POST'),framesAfterRecovery:d.frames.filter(frame=>frame.active&&d.failureEndedAt!==null&&frame.at>d.failureEndedAt).length};});
  check('短暂网络恢复后无需点击自动切127且已真实解码超过2秒',recovered,result);
  if(scenario==='replacement-before-health')check('ready后零有效媒体的新SID失败仍保留下一次恢复机会',result.posts.filter(row=>row.body.episode===126).length===3&&http.some(row=>row.path.startsWith('/media/fixture-3/'))&&!http.some(row=>row.path.startsWith('/media/fixture-3/')&&row.status===200)&&recovered,{currentPosts:result.posts.filter(row=>row.body.episode===126),badCandidateResponses:http.filter(row=>row.path.startsWith('/media/fixture-3/'))});
  const expectedPosts={'tail404-outage':5,'consecutive-outages':9,'controls-interrupt':5,'controls-cancel-late':2,'replacement-before-health':3}[scenario];
  check('故障POST严格匹配原有有限重试预算且无重复请求',result.posts.filter(row=>row.body.episode===126).length===expectedPosts,{expected:expectedPosts,actual:result.posts.filter(row=>row.body.episode===126).length});
  if(recovered){
   const initial=await page.evaluate(()=>({at:performance.now(),time:document.querySelector('video[data-active=true]').currentTime}));await page.waitForTimeout(3200);
   const sustained=await page.evaluate(initial=>{const d=window.__qa,v=document.querySelector('video[data-active=true]'),frames=d.frames.filter(frame=>frame.active&&frame.episode==='127'&&frame.at>=initial.at);return{elapsedMs:performance.now()-initial.at,episode:v.dataset.episode,time:v.currentTime,advanced:v.currentTime-initial.time,paused:v.paused,rate:v.playbackRate,muted:v.muted,volume:v.volume,error:document.querySelector('.player-error p')?.textContent||'',frames:frames.length,slots:[...new Set(frames.map(frame=>frame.slot))],sessionIds:[...new Set(frames.map(frame=>frame.sessionId))]};},initial);
   check('127新会话持续3秒以上播放且没有首帧假恢复',sustained.elapsedMs>=3000&&sustained.episode==='127'&&!sustained.paused&&!sustained.error&&sustained.rate===3&&sustained.advanced>=7&&sustained.frames>=20&&sustained.slots.length===1&&sustained.sessionIds.length===1&&/^fixture-\d+$/.test(sustained.sessionIds[0]),sustained);
   if(scenario==='controls-interrupt')check('重连及切集后静音、音量和三倍速偏好均保留',sustained.rate===3&&sustained.muted&&Math.abs(sustained.volume-.6)<.0001,sustained);
  }
  if(scenario==='consecutive-outages'){
   const independent=await page.evaluate(()=>{const d=window.__qa,posts=d.requests.filter(row=>row.method==='POST'&&row.body.episode===126),first=posts[4],second=posts[5],frames=first&&second?d.frames.filter(frame=>frame.active&&frame.episode==='126'&&frame.sessionId==='fixture-3'&&frame.at>first.at&&frame.at<second.at):[],samples=first&&second?d.samples.filter(sample=>sample.episode==='126'&&!sample.paused&&!sample.seeking&&sample.at>first.at+1000&&sample.at<second.at):[];return{posts:posts.length,framesBetweenFaults:frames.length,healthySpanMs:frames.length?frames.at(-1).at-frames[0].at:0,decodedAdvance:frames.length?frames.at(-1).time-frames[0].time:0,ratesBetweenFaults:[...new Set(samples.map(sample=>sample.rate))],secondFailure:second||null};});
   check('第一次新SID真实健康超过1秒后第二次独立故障也恢复',independent.posts===9&&independent.framesBetweenFaults>=20&&independent.healthySpanMs>=1000&&independent.decodedAdvance>.5,independent);
   check('同集重新连接后实际三倍速偏好始终保留',independent.ratesBetweenFaults.length===1&&independent.ratesBetweenFaults[0]===3,independent);
  }
 }else{
  const recovered=await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.dataset.episode==='127'&&v.currentTime>.4&&v.videoWidth>0&&!v.paused;},undefined,{timeout:25000}).then(()=>true).catch(()=>false);
  check('正常或故障片尾后自动进入127集并持续真实解码',recovered,await page.evaluate(()=>({posts:window.__qa.requests.filter(row=>row.method==='POST'),healthyForMs:window.__qa.failureEndedAt===null?null:performance.now()-window.__qa.failureEndedAt,error:document.querySelector('.player-error p')?.textContent||'',sample:window.__qa.samples.at(-1)})));
  if(scenario==='warm-promote-outage')check('自动接管仅消耗同一operation原有三次预算',await page.evaluate(()=>window.__qa.requests.filter(row=>row.method==='POST'&&row.body.episode===127).length===3));
 }
 check('渲染无异常且账号完全本地隔离',errors.length===0,{errors,scenario});if(checks.some(row=>!row.ok))process.exitCode=1;
}catch(error){check('连接故障最小复现执行',false,{message:error.message});process.exitCode=1;}
finally{const evidence=page?await page.evaluate(()=>({requests:window.__qa?.requests,hlsErrors:window.__qa?.hlsErrors,eosHeld:window.__qa?.eosHeld||0,frames:window.__qa?.frames,samples:window.__qa?.samples})).catch(()=>({})):{};await writeFile(path.join(folder,'result.json'),JSON.stringify({scenario,productionSourceModified:false,checks,http,finalSegment,...evidence},null,2));if(page)await page.screenshot({path:path.join(folder,'result.png')}).catch(()=>{});if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
`;
await writeFile(path.join(work,'driver.mjs'),driver);
const repeat=Number(process.argv.find(arg=>arg.startsWith('--repeat='))?.slice(9)||1);
if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw new Error('Repeat count must be 1..5');
const results=[],scenario=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)||'tail404-outage';
if(scenario==='tail404-outage')for(const [source,destination] of [['result.json','before.json'],['repeat-summary.json','before-repeat-summary.json']]){
 const base=path.join(work,scenario);try{await readFile(path.join(base,destination));}catch{try{await writeFile(path.join(base,destination),await readFile(path.join(base,source)));}catch{/* First clean workspace has no baseline evidence yet. */}}
}
for(let run=1;run<=repeat;run++){
 await import(pathToFileURL(path.join(work,'driver.mjs')).href+'?run='+run);
 const result=JSON.parse(await readFile(path.join(work,scenario,'result.json'),'utf8'));
 if(repeat>1)await writeFile(path.join(work,scenario,'run-'+run+'.json'),JSON.stringify(result,null,2));
 results.push({run,checks:result.checks,http404:result.http.filter(row=>row.status===404).length,hlsErrors:result.hlsErrors});
 if(repeat>1)await writeFile(path.join(work,scenario,'repeat-summary.json'),JSON.stringify({scenario,repeat,results},null,2));
}
const sourceHashesAfterRun=await hashSources(),sourceStable=sourceFiles.every(file=>sourceHashes[file]===sourceHashesAfterRun[file]);
await writeFile(path.join(work,scenario,'provenance.json'),JSON.stringify({scenario,repeat,bundleSHA256:createHash('sha256').update(await readFile(path.join(work,'fixture.js'))).digest('hex'),sourceHashes,sourceHashesAfterRun,sourceStable},null,2));
if(!sourceStable){console.log(JSON.stringify({name:'实际运行源码未发生中途漂移',ok:false}));process.exitCode=1;}
