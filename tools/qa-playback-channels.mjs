// Actual HLS decoding and player-owned session recovery against a local, silent fixture.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),work=path.join(root,'_work/playback-channel-qa'),media=path.join(work,'media');
await mkdir(media,{recursive:true});
const generated=spawnSync(path.join(root,'runtime/ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=green:s=320x180:r=20',
  '-t','60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','40','-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod',
  '-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(media,'seg%06d.m4s'),path.join(media,'index.m3u8')],
  {cwd:media,windowsHide:true,encoding:'utf8'});
if(generated.status!==0)throw new Error('Local playback fixture generation failed');
const fixture=String.raw`
import {HlsDeckLoader} from '../../src/playback/HlsDeck';
import {mediaPreload} from '../../src/playback/MediaPreload';
const interval=window.setInterval.bind(window);window.setInterval=(callback,ms,...args)=>interval(callback,ms===60000?200:ms,...args);
const data=window.__qa={requests:[],fatal:[],counter:0,prepared:0,expired:new Set(),initialExpired:false,playWanted:true};
const sessions=new Map(),video=document.querySelector('video');
const bridge={async request(route,options){
  data.requests.push({route,method:options?.method||'GET',body:options?.body});
  if(route==='/media/session'){
    const id='session-'+(++data.counter);const session={id,phase:data.initialExpired&&data.counter===1?'preparing':'complete',duration:60,url:location.origin+'/media/index.m3u8?lease='+id};
    sessions.set(id,session);if(data.initialExpired&&data.counter===1)data.expired.add(id);return session;
  }
  const id=route.split('/').at(-1);
  if(options?.method==='DELETE'){sessions.delete(id);return{};}
  if(data.expired.has(id)||!sessions.has(id))throw new Error("Error invoking remote method 'api:request': Error: 播放会话已过期，请重新连接");
  return sessions.get(id);
}};
const controller=new AbortController(),target={seriesId:'12345678',episode:54,quality:'1080p',start:0,compatible:true};
const loader=new HlsDeckLoader([video],bridge,(_deck,message)=>data.fatal.push(message),()=>{},()=>data.playWanted);
data.start=async(preheated=false)=>{
  data.initialExpired=preheated;
  if(preheated){mediaPreload(bridge).prepare(target);await Promise.resolve();await Promise.resolve();}
  data.deck=await loader.prepare(0,target,controller.signal);data.prepared++;video.muted=true;video.volume=0;await video.play();return data.deck.sessionId;
};
data.expire=()=>data.expired.add(data.deck.sessionId);
data.close=()=>{controller.abort();data.deck?.release();mediaPreload(bridge).clear();};
`;
await writeFile(path.join(work,'fixture.ts'),fixture);
await build({entryPoints:[path.join(work,'fixture.ts')],outfile:path.join(work,'fixture.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent'});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body><video muted playsinline width="320" height="180"></video><script src="fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
let failedLease='';
const server=createServer(async(req,res)=>{try{const address=new URL(req.url,'http://localhost');const file=decodeURIComponent(address.pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('invalid');if(file.endsWith('.m3u8')&&address.searchParams.get('lease')===failedLease){res.writeHead(503);res.end('temporarily unavailable');return;}const data=await readFile(path.join(work,file));res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.js')?'application/javascript':'text/html');res.end(data);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[];
const check=(name,ok,details)=>{checks.push({name,ok,...(details?{details}:{})});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const decoded=()=>page.waitForFunction(()=>{const video=document.querySelector('video');return video.videoWidth>0&&video.currentTime>.2&&!video.paused;},undefined,{timeout:15000});
try{
  instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});
  page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));
  await page.waitForFunction(()=>!!window.__qa?.start);await page.evaluate(()=>window.__qa.start(true));await decoded();
  const cold=await page.evaluate(()=>({id:window.__qa.deck.sessionId,posts:window.__qa.requests.filter(row=>row.method==='POST'),fatal:window.__qa.fatal.length}));
  check('过期预热租约自动重建后真实解码原剧第54集',cold.id==='session-2'&&cold.posts.length===2&&cold.posts.every(row=>row.body.seriesId==='12345678'&&row.body.episode===54)&&cold.fatal===0);
  check('旧预热租约只释放一次',await page.evaluate(()=>window.__qa.requests.filter(row=>row.route==='/media/session/session-1'&&row.method==='DELETE').length===1));
  await page.evaluate(()=>window.__qa.close());await page.reload();await page.waitForFunction(()=>!!window.__qa?.start);await page.evaluate(()=>window.__qa.start(false));await decoded();
  const before=await page.evaluate(()=>{window.__qa.video=document.querySelector('video');return window.__qa.video.currentTime;});
  await page.evaluate(()=>window.__qa.expire());
  await page.waitForFunction(()=>window.__qa.deck.sessionId==='session-2',undefined,{timeout:8000});await decoded();
  check('活动租约失效后同解码槽恢复原集与实际位置',await page.evaluate(position=>document.querySelector('video')===window.__qa.video&&window.__qa.video.currentTime>=position&&window.__qa.requests.filter(row=>row.method==='POST').length===2,before));
  check('会话重连没有向播放器上报资源不存在',await page.evaluate(()=>window.__qa.fatal.length===0));
  await page.screenshot({path:path.join(work,'recovered.png')});
  await page.evaluate(()=>window.__qa.close());await page.waitForTimeout(250);
  check('释放播放器后新旧租约各删除一次且无迟到播放',await page.evaluate(()=>['session-1','session-2'].every(id=>window.__qa.requests.filter(row=>row.route==='/media/session/'+id&&row.method==='DELETE').length===1)&&document.querySelector('video').paused));
  await page.reload();await page.waitForFunction(()=>!!window.__qa?.start);await page.evaluate(()=>window.__qa.start(false));await decoded();
  await page.evaluate(()=>{document.querySelector('video').currentTime=2;});
  await page.waitForFunction(()=>document.querySelector('video').currentTime>2.1&&!document.querySelector('video').paused);
  const beforeNetwork=await page.evaluate(()=>document.querySelector('video').currentTime);failedLease='session-1';
  await page.evaluate(()=>{const deck=window.__qa.deck;deck.hls.config.manifestLoadPolicy.default.errorRetry.maxNumRetry=0;deck.hls.loadSource(location.origin+'/media/index.m3u8?lease='+deck.sessionId);});
  await page.waitForFunction(()=>window.__qa.deck.sessionId==='session-2',undefined,{timeout:10000});await decoded();
  await page.waitForFunction(position=>document.querySelector('video').currentTime>=position-.04,beforeNetwork);
  const networkState=await page.evaluate(()=>({position:document.querySelector('video').currentTime,start:window.__qa.requests.filter(row=>row.method==='POST')[1]?.body.start,posts:window.__qa.requests.filter(row=>row.method==='POST').length,fatal:window.__qa.fatal.length}));
  check('实际503网络响应自动重连一次并继续原集位置',networkState.position>=beforeNetwork-.04&&networkState.start>=beforeNetwork-.04&&networkState.posts===2&&networkState.fatal===0,{before:beforeNetwork,...networkState});
  await page.evaluate(()=>window.__qa.close());failedLease='';
  await page.reload();await page.waitForFunction(()=>!!window.__qa?.start);await page.evaluate(()=>window.__qa.start(false));await decoded();
  await page.evaluate(()=>{window.__qa.playWanted=false;document.querySelector('video').pause();});failedLease='session-1';
  await page.evaluate(()=>{const deck=window.__qa.deck;deck.hls.config.manifestLoadPolicy.default.errorRetry.maxNumRetry=0;deck.hls.loadSource(location.origin+'/media/index.m3u8?lease='+deck.sessionId);});
  await page.waitForFunction(()=>window.__qa.deck.sessionId==='session-2'&&document.querySelector('video').readyState>=2,undefined,{timeout:10000});await page.waitForTimeout(200);
  check('手动暂停期间网络重连不改变暂停意图',await page.evaluate(()=>document.querySelector('video').paused&&window.__qa.fatal.length===0));
  await page.evaluate(()=>window.__qa.close());failedLease='';
  check('测试全程隐藏静音且无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'播放连接续租解码验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({checks,errors},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));}
