// Exercise the actual Player/HLS against local video; no accounts or remote media.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),work=path.join(root,'_work/playback-stall-qa'),media=path.join(work,'media');
await mkdir(media,{recursive:true});
const generated=spawnSync(path.join(root,'runtime/ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=20','-t','60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','40','-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(media,'seg%06d.m4s'),path.join(media,'index.m3u8')],{cwd:media,windowsHide:true,encoding:'utf8'});
if(generated.status!==0)throw new Error('Local silent fixture generation failed');
await writeFile(path.join(work,'fixture.jsx'),String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Hls from 'hls.js';
import Player from '../../src/components/Player';
import '../../src/styles.css';
const data=window.__qa={requests:[],engines:[],hlsErrors:[],active:true,failedId:'',recoverCalls:0,hlsError:Hls.Events.ERROR,networkError:Hls.ErrorTypes.NETWORK_ERROR};
const attach=Hls.prototype.attachMedia;Hls.prototype.attachMedia=function(video){this.on(Hls.Events.ERROR,(_event,error)=>data.hlsErrors.push({episode:video.dataset.episode,fatal:error.fatal,type:error.type,details:error.details}));data.engines.push({engine:this,video});return attach.call(this,video);};
const detail={series:{id:'12345678',title:'本地播放停滞恢复验证',totalEpisodes:2,cover:'',intro:'',tags:[],actors:[]},episodes:[1,2].map(index=>({index,vid:'1234567'+index,title:'第'+index+'集',duration:60}))};
let counter=0;const sessions=new Map();
window.hongguo={
 async request(route,options={}){
  data.requests.push({route,method:options.method||'GET',body:options.body});
  if(route.endsWith('/seasons'))return{seriesId:'12345678',status:'single',currentSeason:1,seasons:[]};
  if(route.endsWith('/next-season'))return{seriesId:'12345678',status:'none',season:1,nextSeason:null,next:null,source:null,firstEpisode:null};
  if(route==='/media/session'&&options.method==='POST'){
   const id='fixture-'+(++counter),session={id,phase:'complete',duration:60,videoCodec:'h264',url:location.origin+'/media/'+id+'/index.m3u8'};sessions.set(id,session);data.activeSessionId=id;return session;
  }
  if(route.startsWith('/media/session/')){const id=route.split('/').at(-1);if(options.method==='DELETE'){sessions.delete(id);return{};}const session=sessions.get(id);return data.failedId===id?{...session,phase:'error',error:'本地测试中的转码中断'}:session;}
  if(route.startsWith('/catalog/danmaku'))return{seriesId:'12345678',vid:'12345671',source:'mobile',start:0,end:60,items:[],hasMore:false};
  if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
  throw new Error('Unexpected local test request');
 },
 async getLibrary(){return{history:[],favorites:[]};},async saveProgress(){},
 onLibrary(){return()=>{};},onShutdown(){return()=>{};},onVisibility(listener){data.visibility=listener;return()=>{};},async window(){return false;}
};
function Fixture(){
 const [settings,update]=useState({theme:'dark',quality:'1080p',rate:1,autoplay:false,volume:0,cacheGB:4,danmaku:{enabled:false}}),[active,setActive]=useState(true);
 data.setActive=setActive;data.setRate=rate=>update(previous=>({...previous,rate}));
 return <Player detail={detail} initialEpisode={1} settings={settings} isActive={active} accountKey="local" onSettings={patch=>update(previous=>({...previous,...patch}))} onClose={()=>{}} onLibrary={()=>{}}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'local-emoji',setup(builder){builder.onLoad({filter:/emoji-painter\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/^const resources = .*$/m,'const resources: Record<string,string> = {};'),loader:'ts',resolveDir:path.dirname(args.path)}));}}]});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);

const server=createServer(async(req,res)=>{try{
 const uri=new URL(req.url,'http://localhost');let file=decodeURIComponent(uri.pathname).slice(1)||'index.html';
 if(file.includes('..'))throw new Error('Invalid local fixture path');
 const match=file.match(/^media\/(fixture-\d+)\/(.+)$/);
 if(match)file='media/'+match[2];
 const body=await readFile(path.join(work,file));res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[];
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const playing=()=>page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.currentTime>.2&&!v.paused&&v.videoWidth>0;},undefined,{timeout:15000});
const reset=async()=>{await page.goto(origin);await playing();};
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));await playing();
 const pauseAt=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');v.pause();return v.currentTime;});
 const resumed=await page.waitForFunction(at=>{const v=document.querySelector('video[data-active=true]');return !v.paused&&v.currentTime>at+.2;},pauseAt,{timeout:4000}).then(()=>true).catch(()=>false);
 check('无用户暂停意图时，意外暂停自动恢复真实画面和时间轴',resumed,{pauseAt});
 await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('video[data-active=true]').paused);const manual=await page.evaluate(()=>document.querySelector('video[data-active=true]').currentTime);await page.waitForTimeout(2200);
 check('用户手动暂停保持暂停',await page.evaluate(at=>{const v=document.querySelector('video[data-active=true]');return v.paused&&Math.abs(v.currentTime-at)<.05;},manual));
 await page.keyboard.press('k');await playing();await page.evaluate(()=>window.__qa.visibility(false));await page.waitForTimeout(2200);
 check('隐藏窗口不被恢复检测唤醒',await page.evaluate(()=>document.querySelector('video[data-active=true]').paused));
 await page.evaluate(()=>window.__qa.visibility(true));await playing();
 await page.waitForTimeout(300);
 const ratePosts=await page.evaluate(()=>window.__qa.requests.filter(row=>row.method==='POST').length);
 await page.evaluate(()=>window.__qa.setRate(3));await page.waitForTimeout(1700);
 check('三倍速正常播放不会触发媒体重连',await page.evaluate(count=>document.querySelector('video[data-active=true]').playbackRate===3&&window.__qa.requests.filter(row=>row.method==='POST').length===count,ratePosts));
 await reset();
 await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');const h=window.__qa.engines.find(row=>row.video===v).engine;h.stopLoad();const stop=h.stopLoad.bind(h);const start=h.startLoad.bind(h);h.startLoad=(...args)=>{window.__qa.startCalls=(window.__qa.startCalls||0)+1;return start(...args);};window.__qa.held=()=>stop();});
 await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v.readyState<3&&!v.paused;},undefined,{timeout:20000});
 const drained=await page.evaluate(()=>document.querySelector('video[data-active=true]').currentTime);
 const refilled=await page.waitForFunction(at=>document.querySelector('video[data-active=true]').currentTime>at+.2,drained,{timeout:8500}).then(()=>true).catch(()=>false);
 check('HLS 无致命报错且缓冲耗尽时自动重新加载',refilled,{drained});
 await reset();
 const decoderFrozen=await page.evaluate(()=>{
  const v=document.querySelector('video[data-active=true]'),h=window.__qa.engines.find(row=>row.video===v).engine,at=v.currentTime;
  const play=v.play.bind(v),pause=v.pause.bind(v),recover=h.recoverMediaError.bind(h);pause();
  Object.defineProperty(v,'paused',{configurable:true,get:()=>false});v.play=async()=>{};
  h.recoverMediaError=()=>{window.__qa.recoverCalls++;delete v.paused;v.play=play;recover();};
  return at;
 });
 const decoderRecovered=await page.waitForFunction(at=>document.querySelector('video[data-active=true]').currentTime>at+.2,decoderFrozen,{timeout:9000}).then(()=>true).catch(()=>false);
 check('有缓冲但时间冻结时重建解码器并实际续播',decoderRecovered&&await page.evaluate(()=>window.__qa.recoverCalls===1),{decoderFrozen});
 await reset();
 const networkFrozen=await page.evaluate(()=>{
  const v=document.querySelector('video[data-active=true]'),h=window.__qa.engines.find(row=>row.video===v).engine;
  const at=v.currentTime,loads=h.loadSource.bind(h);window.__qa.sourceLoads=0;h.loadSource=(...args)=>{window.__qa.sourceLoads++;return loads(...args);};
  v.pause();Object.defineProperty(v,'paused',{configurable:true,get:()=>false});v.play=async()=>{};h.recoverMediaError=()=>{};h.startLoad=()=>{};
 window.__qa.activeEngine=h;
 window.__qa.postsBefore=window.__qa.requests.filter(row=>row.route==='/media/session'&&row.method==='POST'&&row.body.episode===1).length;
  return at;
 });
 await page.waitForTimeout(9700);
 await page.evaluate(()=>window.__qa.activeEngine.trigger(window.__qa.hlsError,{fatal:true,type:window.__qa.networkError}));
 const reconnected=await page.waitForFunction(at=>{
  const posts=window.__qa.requests.filter(row=>row.route==='/media/session'&&row.method==='POST'&&row.body.episode===1);
  return posts.length===window.__qa.postsBefore+1&&posts.at(-1).body.start>=at-.1&&window.__qa.sourceLoads===1;
 },networkFrozen,{timeout:9000}).then(()=>true).catch(()=>false);
 check('停滞与 fatal 网络错误并发时只建一个会话且从原进度续接',reconnected,{networkFrozen,posts:await page.evaluate(()=>window.__qa.requests.filter(row=>row.route==='/media/session'&&row.method==='POST'&&row.body.episode===1).length),sourceLoads:await page.evaluate(()=>window.__qa.sourceLoads)});
 check('测试静音隐藏且无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(w=>w.isAudioMuted())));
}catch(error){checks.push({name:'播放停滞恢复验收',ok:false,error:error.message});console.error(error.message);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({checks,errors},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
