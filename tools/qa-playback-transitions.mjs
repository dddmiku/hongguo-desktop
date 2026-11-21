// Account-free regression against the real Player and HLS decoders.
// Measures decoded frames and sustained playback, not just the selected episode label.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root=process.cwd(),work=path.join(root,'_work','playback-transitions-qa');
await mkdir(work,{recursive:true});
for(const duration of [6,24]){
 const folder=path.join(work,String(duration));await mkdir(folder,{recursive:true});
 const result=spawnSync(path.join(root,'runtime','ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(duration),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','25','-c:a','aac','-hls_time','1','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(folder,'seg%03d.m4s'),path.join(folder,'index.m3u8')],{cwd:folder,windowsHide:true,encoding:'utf8'});
 if(result.status!==0)throw new Error('Local transition fixture generation failed');
}
await writeFile(path.join(work,'fixture.jsx'),String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Hls from 'hls.js';
import Player from '../../src/components/Player';
import '../../src/styles.css';
const query=new URLSearchParams(location.search),duration=Number(query.get('duration')||24),rate=Number(query.get('rate')||1);
const data=window.__qa={requests:[],engines:[],events:[],frames:[],samples:[],record:false,transient:query.has('transient')};
const attach=Hls.prototype.attachMedia;Hls.prototype.attachMedia=function(video){data.engines.push({engine:this,video});return attach.call(this,video);};
const detail={series:{id:'12345678',title:'Local transition QA',totalEpisodes:8,cover:'',intro:'',tags:[],actors:[]},episodes:Array.from({length:8},(_,i)=>({index:i+1,vid:String(12345671+i),title:'Episode '+(i+1),duration}))};
let counter=0;const sessions=new Map();
window.hongguo={
 async request(route,options={}){
  data.requests.push({route,method:options.method||'GET',body:options.body});
  if(route.endsWith('/seasons'))return{seriesId:'12345678',status:'single',currentSeason:1,seasons:[]};
  if(route.endsWith('/next-season'))return{seriesId:'12345678',status:'none',season:1,nextSeason:null,next:null,source:null,firstEpisode:null};
  if(route==='/media/session'&&options.method==='POST'){if(data.transient&&options.body.episode===2){data.transient=false;throw new TypeError('Failed to fetch');}const id=String(++counter),session={id,phase:'complete',duration,videoCodec:'h264',url:location.origin+'/media/'+duration+'/'+options.body.episode+'/'+id+'/index.m3u8'};sessions.set(id,session);return session;}
  if(route.startsWith('/media/session/')){const id=route.split('/').at(-1);if(options.method==='DELETE'){sessions.delete(id);return{};}return sessions.get(id);}
  if(route.startsWith('/catalog/danmaku'))return{seriesId:'12345678',vid:'12345671',source:'mobile',start:0,end:duration,items:[],hasMore:false};
  if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
  throw new Error('Unexpected local transition route');
 },
 async getLibrary(){return{history:[],favorites:[]};},async saveProgress(){},onLibrary(){return()=>{};},onShutdown(){return()=>{};},onVisibility(){return()=>{};},async window(){return false;}
};
function Fixture(){const [settings,update]=useState({theme:'dark',quality:'1080p',rate,autoplay:true,volume:0,cacheGB:4,danmaku:{enabled:false}});return <Player detail={detail} initialEpisode={1} settings={settings} isActive={true} accountKey='local' onSettings={patch=>update(old=>({...old,...patch}))} onClose={()=>{}} onLibrary={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
const observed=new WeakSet();
function observe(){
 for(const video of document.querySelectorAll('video'))if(!observed.has(video)){
  observed.add(video);for(const name of ['waiting','playing','pause','ended','stalled','seeking','seeked'])video.addEventListener(name,()=>{if(data.record)data.events.push({at:performance.now(),name,active:video.dataset.active,episode:video.dataset.episode,time:video.currentTime});});
  const frame=(_now,metadata)=>{if(data.record&&video.dataset.active==='true')data.frames.push({at:performance.now(),episode:video.dataset.episode,time:metadata.mediaTime});video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
 }
 if(data.record){const video=document.querySelector('video[data-active=true]');data.samples.push({at:performance.now(),episode:video?.dataset.episode,time:video?.currentTime,ready:video?.readyState,width:video?.videoWidth,status:document.querySelector('.player-recovery-status')?.textContent||'',pending:!!document.querySelector('.switch-status')});}
 requestAnimationFrame(observe);
}requestAnimationFrame(observe);
`);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'local-emoji',setup(builder){builder.onLoad({filter:/emoji-painter\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/^const resources = .*$/m,'const resources: Record<string,string> = {};'),loader:'ts',resolveDir:path.dirname(args.path)}));}}]});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
let gate=null;const held=[];
const release=()=>{gate=null;for(const resolve of held.splice(0))resolve();};
const server=createServer(async(req,res)=>{try{
 let file=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Invalid fixture path');
 const match=file.match(/^media\/(6|24)\/(\d+)\/\d+\/(.+)$/);
 if(match){if(Number(match[2])===gate&&/^seg00[2-9]/.test(match[3]))await new Promise(resolve=>held.push(resolve));file=match[1]+'/'+match[3];}
 const body=await readFile(path.join(work,file));res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[],measurements=[];
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const ready=async(episode=1)=>page.waitForFunction(episode=>{const v=document.querySelector('video[data-active=true]');return v?.dataset.episode===String(episode)&&v.currentTime>.15&&!v.paused&&v.videoWidth>0;},episode,{timeout:15000});
const warm=async(seconds)=>page.waitForFunction(seconds=>{const v=document.querySelector('video[data-active=false]');return v?.videoWidth>0&&v.paused&&v.buffered.length&&v.buffered.end(0)-v.currentTime>=seconds;},seconds,{timeout:10000});
const transition=async(name,from,slow=false)=>{
 await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');v.currentTime=v.duration-.8;});
 await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.readyState>=2&&!v.seeking;});
 await page.evaluate(()=>{const d=window.__qa;d.events=[];d.frames=[];d.samples=[];d.record=true;});
 if(slow){
  await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.ended,undefined,{timeout:4000});await page.waitForTimeout(900);
  check(name+' 保留旧画面直到下一集缓存可用',await page.evaluate(from=>{const v=document.querySelector('video[data-active=true]');return v.dataset.episode===String(from)&&v.readyState>=2&&v.videoWidth>0;},from));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.waitForTimeout(250);
  check(name+' 鼠标移动能唤出可操作控制栏',await page.locator('.player-controls').evaluate(el=>{const s=getComputedStyle(el),button=el.querySelector('button'),rect=button.getBoundingClientRect();return Number(s.opacity)>.9&&s.pointerEvents!=='none'&&button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}));
  await page.getByTitle('静音（M）',{exact:true}).click();
  check(name+' 等待时鼠标点击静音生效',await page.locator('video[data-active=true]').evaluate(v=>v.muted));
  await page.getByTitle('全屏（F）',{exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.locator('.video-stage').hover({position:{x:30,y:30}});await page.waitForTimeout(250);
  check(name+' 全屏等待时仍能唤出控制栏',await page.locator('.player-controls').evaluate(el=>Number(getComputedStyle(el).opacity)>.9&&getComputedStyle(el).pointerEvents!=='none'));
  await page.screenshot({path:path.join(work,'waiting-fullscreen-controls.png')});
  await page.locator('.fullscreen-toolbar button').click();await page.waitForFunction(()=>!document.fullscreenElement);release();
 }
 await ready(from+1);await page.waitForTimeout(1200);
 const result=await page.evaluate(({name,from})=>{const d=window.__qa;d.record=false;const sample=d.samples.find(s=>s.episode===String(from+1)),frame=d.frames.find(s=>s.episode===String(from+1)),ended=d.events.find(s=>s.name==='ended'&&s.episode===String(from));return{name,from,to:from+1,presentToFrameMs:sample&&frame?frame.at-sample.at:null,endedToFrameMs:ended&&frame?frame.at-ended.at:null,newFrames:d.frames.filter(s=>s.episode===String(from+1)).length,invalid:d.samples.filter(s=>s.ready<2||!s.width).length,bufferingSamples:d.samples.filter(s=>s.status).length,events:d.events,frames:d.frames,samples:d.samples};},{name,from});
 measurements.push(result);check(name+' 新集持续解码且无空画面/缓冲提示',result.newFrames>10&&result.invalid===0&&result.bufferingSamples===0,{presentToFrameMs:result.presentToFrameMs,endedToFrameMs:result.endedToFrameMs,newFrames:result.newFrames,invalid:result.invalid,bufferingSamples:result.bufferingSamples});
};
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 for(const rate of [1,3]){await page.goto(origin+'/?rate='+rate);await ready();for(let from=1;from<=3;from++){await warm(Math.max(4,rate*3));await transition(rate+'倍速自动切集 '+from,from);}}
 await page.goto(origin+'/?rate=3&transient');await ready();await warm(9);
 check('一次临时网络错误后本集播放期间重新完成预热',await page.evaluate(()=>window.__qa.requests.filter(r=>r.method==='POST'&&r.body?.episode===2).length===2&&document.querySelector('video[data-active=true]').dataset.episode==='1'));
 await transition('临时网络恢复后自动切集',1);
 check('临时网络恢复后片尾复用预热会话',await page.evaluate(()=>window.__qa.requests.filter(r=>r.method==='POST'&&r.body?.episode===2).length===2));
 gate=2;await page.goto(origin+'/?rate=3');await ready();await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=false]');return v?.videoWidth>0&&v.buffered.length&&v.buffered.end(0)>1;});await transition('三倍速慢线路预热',1,true);
 release();await page.goto(origin+'/?rate=3&duration=6');await ready();await transition('三倍速短集已完整缓存',1);
 await instance.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.hide();});
 check('测试结束窗口隐藏静音，无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(w=>w.isAudioMuted())));
}catch(error){checks.push({name:'自动切集性能验收',ok:false,error:error.message});console.error(error.message);process.exitCode=1;}
finally{release();await writeFile(path.join(work,'result.json'),JSON.stringify({checks,errors,measurements},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
