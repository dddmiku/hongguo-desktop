// Actual Player and HLS decoding across native window minimize/restore. Media is generated locally.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),work=path.join(root,'_work','player-visibility-qa'),media=path.join(work,'media');
await mkdir(media,{recursive:true});
const generated=spawnSync(path.join(root,'runtime','ffmpeg.exe'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=320x180:r=20',
  '-t','60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','40',
  '-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_type','fmp4',
  '-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(media,'seg%06d.m4s'),path.join(media,'index.m3u8'),
],{encoding:'utf8',windowsHide:true,cwd:media});
if(generated.status!==0)throw new Error('Local silent video generation failed');
const fixture=String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Player from '../../src/components/Player';
import '../../src/styles.css';
const detail={series:{id:'12345678',title:'本地最小化恢复测试',totalEpisodes:2,cover:'',intro:'',tags:[],actors:[]},episodes:[{index:1,vid:'11111111',title:'第一集',duration:60},{index:2,vid:'22222222',title:'第二集',duration:60}]};
const data=window.__qa={requests:[],progress:[],visibility:[],events:[],blocked:new URLSearchParams(location.search).has('blocked-start'),releases:[],waiting:0};
let counter=0,settings,update,active=true,activate;const sessions=new Map();
window.hongguo={
 async request(route,options={}){
  data.requests.push({route,method:options.method||'GET',episode:options.body?.episode});
  if(route.endsWith('/seasons'))return{seriesId:'12345678',status:'single',source:null,currentSeason:1,seasons:[]};
  if(route.endsWith('/next-season'))return{seriesId:'12345678',status:'none',season:1,nextSeason:null,next:null,source:null,firstEpisode:null};
  if(route==='/media/session'&&options.method==='POST'){
   if(data.blocked){data.blocked=false;data.waiting++;await new Promise(resolve=>data.releases.push(resolve));data.waiting--;}
   const session={id:'fixture-'+(++counter),phase:'complete',duration:60,cached:true,quality:options.body.quality,url:location.origin+'/media/index.m3u8'};sessions.set(session.id,session);return session;
  }
  if(route.startsWith('/media/session/')){const id=route.split('/').at(-1);if(options.method==='DELETE'){sessions.delete(id);return{};}return sessions.get(id);}
  if(route.startsWith('/catalog/danmaku'))return{seriesId:'12345678',vid:'11111111',source:'mobile',start:0,end:60,items:[],hasMore:false};
  if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
  throw new Error('Unexpected controlled test request');
 },
 async getLibrary(){return{history:[],favorites:[]};},async saveProgress(value){data.progress.push(structuredClone(value));},
 async getSettings(){return settings;},async saveSettings(patch){update(patch);return settings;},
 onLibrary(){return()=>{};},onShutdown(){return()=>{};},
 onVisibility(listener){return window.__qaVisibility.onVisibility(value=>{data.visibility.push(value);listener(value);});},
 async window(){return false;}
};
function Fixture(){
 const [preferences,setPreferences]=useState({theme:'dark',quality:'1080p',rate:1,autoplay:false,volume:0,cacheGB:4,closeToTray:false,bossKey:'Ctrl+Shift+B',danmaku:{enabled:false,opacity:.8,fontSize:22,area:.5,density:'standard',blockedWords:[]}});
 const [isActive,setActive]=useState(true);activate=value=>{active=value;setActive(value);};
 settings=preferences;update=value=>setPreferences(previous=>({...previous,...value}));
 data.setActive=activate;data.release=()=>{for(const resolve of data.releases.splice(0))resolve();};
 return <div className="app-shell"><main><div className="playback-page" hidden={!isActive}><Player detail={detail} initialEpisode={1} initialPosition={0} isActive={isActive} accountKey="local" settings={preferences} onSettings={update} onLibrary={()=>{}} onClose={()=>data.events.push('close')} /></div></main></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'fixture-emoji-resources',setup(builder){builder.onLoad({filter:/emoji-painter\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/^const resources = .*$/m,'const resources: Record<string,string> = {};'),loader:'ts',resolveDir:path.dirname(args.path)}));}}]});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'preload.cjs'),String.raw`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('__qaVisibility',{onVisibility(callback){const listener=(_event,value)=>callback(value);ipcRenderer.on('window:visibility',listener);return()=>ipcRenderer.removeListener('window:visibility',listener);}});`);
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');const path=require('path');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const window=new BrowserWindow({width:960,height:720,x:-32000,y:-32000,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});window.webContents.setAudioMuted(true);window.on('minimize',()=>window.webContents.send('window:visibility',false));window.on('restore',()=>window.webContents.send('window:visibility',true));window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';if(file.includes('..')){res.writeHead(403);res.end();return;}const body=await readFile(path.join(work,file));res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;let instance,page;const checks=[],errors=[];
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const current=()=>page.locator('video[data-active=true]');
const playing=async()=>page.waitForFunction(()=>{const video=document.querySelector('video[data-active=true]');return video?.videoWidth>0&&video.currentTime>.1&&!video.paused&&!document.querySelector('.player-error');},undefined,{timeout:15000});
const minimize=async()=>{await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());await page.waitForFunction(()=>window.__qa.visibility.at(-1)===false);};
const restore=async()=>{await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());await page.waitForFunction(()=>window.__qa.visibility.at(-1)===true);};
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});
 page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));await playing();
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 await page.evaluate(()=>{window.__qa.video=document.querySelector('video[data-active=true]');window.__qa.layout=document.querySelector('.player-page');});
 await minimize();await page.waitForFunction(()=>window.__qa.video.paused);const frozen=await current().evaluate(video=>video.currentTime);await page.waitForTimeout(450);
 check('真实最小化事件暂停当前视频并保存位置',await current().evaluate((video,at)=>video.paused&&Math.abs(video.currentTime-at)<.1,frozen)&&await page.evaluate(()=>window.__qa.progress.some(row=>row.position>0)));
 await restore();
 const resumed=await page.waitForFunction(at=>{const video=document.querySelector('video[data-active=true]');return video===window.__qa.video&&!video.paused&&video.currentTime>at;},frozen,{timeout:3000}).then(()=>true).catch(()=>false);
 check('恢复窗口直接续播同一解码器及位置，无需重进播放页',resumed);
 await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('暂停（空格）',{exact:true}).click();
 await page.waitForFunction(()=>window.__qa.video.paused);const paused=await current().evaluate(video=>video.currentTime);
 await minimize();await restore();await page.waitForTimeout(400);
 check('手动暂停后最小化再恢复仍保持暂停',await current().evaluate((video,at)=>video.paused&&Math.abs(video.currentTime-at)<.1,paused));
 await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('播放（空格）',{exact:true}).click();await playing();
 check('恢复后的播放按钮可以直接继续原视频',await page.evaluate(()=>document.querySelector('video[data-active=true]')===window.__qa.video));
 for(let i=0;i<2;i++){await minimize();await restore();await playing();}
 check('重复最小化恢复不会丢失播放意图',await page.evaluate(()=>document.querySelector('.player-page')===window.__qa.layout&&document.querySelector('video[data-active=true]')===window.__qa.video&&window.__qa.events.length===0));
 await page.evaluate(()=>window.__qa.setActive(false));await page.waitForFunction(()=>window.__qa.video.paused);await minimize();await restore();await page.waitForTimeout(300);
 check('其他页面恢复窗口不会播放隐藏视频',await page.evaluate(()=>window.__qa.video.paused));
 await page.evaluate(()=>window.__qa.setActive(true));await playing();
 check('返回播放页恢复原位置和原视频',await page.evaluate(()=>document.querySelector('video[data-active=true]')===window.__qa.video));
  await page.evaluate(()=>{window.__qa.nodes=[...document.querySelectorAll('video')];window.__qa.blocked=true;});
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByLabel('播放画质').selectOption('720p');
  await page.waitForFunction(()=>window.__qa.waiting>0);await minimize();await restore();await page.evaluate(()=>window.__qa.release());
  await playing();await page.waitForFunction(()=>!document.querySelector('.switch-status'));
  check('切画质等待中最小化恢复可取消旧请求并继续，无需重进',await page.evaluate(()=>window.__qa.nodes.every((node,index)=>node===document.querySelectorAll('video')[index])&&document.querySelector('[aria-label="播放画质"]').value==='720p'&&window.__qa.events.length===0));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('暂停（空格）',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.paused);
  await page.evaluate(()=>window.__qa.blocked=true);await page.getByLabel('播放画质').selectOption('1080p');await page.waitForFunction(()=>window.__qa.waiting>0);
  await minimize();await restore();await page.evaluate(()=>window.__qa.release());
  await page.waitForFunction(()=>{const video=document.querySelector('video[data-active=true]');return video?.videoWidth>0&&video.paused&&!document.querySelector('.switch-status')&&!document.querySelector('.player-error');});
  check('暂停时切画质并最小化恢复仍保持暂停',await current().evaluate(video=>video.paused));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('播放（空格）',{exact:true}).click();await playing();
  check('取消中的画质请求不会阻塞恢复后的播放按钮',true);
  await page.goto(origin+'/?blocked-start');await page.waitForFunction(()=>window.__qa.waiting>0);
  await minimize();await restore();await page.evaluate(()=>window.__qa.release());await playing();
  check('首次准备中最小化恢复会重新准备原集并正常起播',await current().evaluate(video=>video.dataset.episode==='1'&&video.videoWidth>0&&!video.paused)&&await page.evaluate(()=>window.__qa.events.length===0));
 check('所有测试窗口静音且无渲染异常',errors.length===0&&await instance.evaluate(({app,webContents})=>app.commandLine.hasSwitch('mute-audio')&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'窗口播放恢复验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({ok:checks.length>0&&checks.every(item=>item.ok),passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,checks,errors,fixture:'real Player/HLS, native minimize/restore, isolated local-only bridge and silent generated video'},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));}
