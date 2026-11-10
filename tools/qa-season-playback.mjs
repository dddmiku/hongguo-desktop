import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,readdir,writeFile,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

// This fixture imports the real Player and decoders. Its bridge contains only synthetic metadata.
const root=process.cwd(),work=path.join(root,'_work','season-playback-qa');
await mkdir(work,{recursive:true});
if(process.argv.includes('--live-only')){await liveSeason();process.exit(process.exitCode||0);}
for(const [kind,color] of [['current','blue'],['next','red']]){
  const folder=path.join(work,'media',kind);await mkdir(folder,{recursive:true});
  const result=spawnSync(path.join(root,'runtime','ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x180:r=20`,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','40','-c:a','aac','-b:a','64k','-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(folder,'seg%06d.m4s'),path.join(folder,'index.m3u8')],{encoding:'utf8',windowsHide:true,cwd:folder});
  if(result.status!==0)throw new Error('Synthetic HLS generation failed: '+String(result.stderr).slice(-500));
}
const fixture=String.raw`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Player from '../../src/components/Player';
import '../../src/styles.css';
const CURRENT='12345678',NEXT='87654321';
const series=(id,title,totalEpisodes)=>({id,title,totalEpisodes,cover:'',intro:'Synthetic local HLS fixture',tags:['fixture'],actors:['synthetic actor']});
const first={series:series(CURRENT,'测试第一季',3),episodes:[1,2,3].map(index=>({index,vid:String(11000000+index),title:'第'+index+'集',duration:12}))};
const second={series:series(NEXT,'测试第二季',2),episodes:[1,2].map(index=>({index,vid:String(22000000+index),title:'第'+index+'集',duration:12}))};
const params=new URLSearchParams(location.search),mode=params.get('mode')||'core',initialEpisode=Number(params.get('episode')||3);
const data={requests:[],progress:[],favorites:[],seriesEvents:[],favoriteRequests:[],callbacks:[],accountCommitted:'',workers:0,peakWorkers:0,lookupWaiting:false,failWaiting:false};
window.__qa=data;

const visibility=new Set(),library=new Set();let preferences,patchPreferences,changeAccount,closePlayer,failOnce=mode==='retry';
const found={seriesId:CURRENT,status:'found',season:1,nextSeason:2,next:second.series,source:'official',firstEpisode:1};
const noNext=sid=>({seriesId:sid,status:'none',season:sid===CURRENT?1:2,nextSeason:null,next:null,source:null,firstEpisode:null});
const sessions=new Map();let counter=0;
const getLibrary=()=>({history:data.progress,favorites:data.favorites});
window.hongguo={
  async request(route,options={}){
    data.requests.push({route,method:options.method||'GET',body:options.body?structuredClone(options.body):null,accountCommitted:data.accountCommitted,at:performance.now()});
    const season=/\/catalog\/series\/(\d+)\/next-season/.exec(route);
    if(season){if(season[1]!==CURRENT)return noNext(season[1]);if(mode==='ambiguous')return {...noNext(CURRENT),status:'ambiguous'};
      if(mode==='slow'){data.lookupWaiting=true;return await new Promise(resolve=>{data.releaseLookup=()=>{data.callbacks.push({type:'lookup-release',accountCommitted:data.accountCommitted,at:performance.now()});data.lookupWaiting=false;resolve(found);};});}return found;}
    if(route==='/catalog/series/'+NEXT)return second;
    if(route==='/media/session'&&options.method==='POST'){
      if(options.body.seriesId===NEXT&&failOnce){failOnce=false;data.failWaiting=true;await new Promise((_resolve,reject)=>{data.releaseFailure=()=>{data.failWaiting=false;reject(new Error('Synthetic next-season source failure'));};});}
      const id='fixture-'+(++counter),session={id,phase:'complete',duration:12,cached:true,quality:options.body.quality,url:location.origin+'/media/'+(options.body.seriesId===NEXT?'next':'current')+'/index.m3u8'};sessions.set(id,session);return session;}
    if(route.startsWith('/media/session/')){if(options.method==='DELETE'){sessions.delete(route.split('/').at(-1));return{};}return sessions.get(route.split('/').at(-1));}
    if(route.startsWith('/catalog/comments'))return{items:[{id:'33333333',text:'synthetic comment',nickname:'fixture',avatar:'',likes:0,time:'2026-11-09T00:00:00Z'}],total:1,cursor:0,hasMore:false};
    if(route.startsWith('/catalog/danmaku')){const query=new URLSearchParams(route.split('?')[1]),sid=query.get('seriesId'),episode=Number(query.get('episode'));return{seriesId:sid,vid:String((sid===NEXT?22000000:11000000)+episode),source:'mobile',start:0,end:12,items:[{id:'44444444',text:'fixture danmaku',time:.1}],hasMore:false};}
    throw new Error('Unexpected synthetic fixture route');
  },
  async getLibrary(){return getLibrary();},
  async saveProgress(value){data.progress.push(structuredClone(value));},
  async getSettings(){return preferences;},
  async saveSettings(value){patchPreferences(value);return preferences;},
  async toggleFavorite(value,desired){data.favoriteRequests.push(value.id);data.favorites=desired?[value]:[];for(const listener of library)listener(getLibrary());return getLibrary();},
  onLibrary(listener){library.add(listener);return()=>library.delete(listener);},
  onVisibility(listener){visibility.add(listener);return()=>visibility.delete(listener);},
  onShutdown(){return()=>{};},
  async window(){return false;}
};
function Fixture(){
  const [detail,setDetail]=useState(first),[account,setAccount]=useState('fixture-account'),[shown,setShown]=useState(true);
  const [settings,setSettings]=useState({theme:'dark',quality:'1080p',rate:3,autoplay:params.get('autoplay')!=='false',volume:.6,cacheGB:4,closeToTray:false,bossKey:'Ctrl+Shift+B',danmaku:{enabled:true,opacity:.8,fontSize:22,area:.5,density:'standard',blockedWords:[]}});
  preferences=settings;patchPreferences=patch=>setSettings(current=>({...current,...patch}));changeAccount=value=>{data.callbacks.push({type:'account-request',account:value,at:performance.now()});setAccount(value);};closePlayer=()=>setShown(false);
  useEffect(()=>{data.accountCommitted=account;data.callbacks.push({type:'account-committed',account,at:performance.now()});},[account]);
  Object.assign(data,{patch:patchPreferences,changeAccount,hide:()=>visibility.forEach(listener=>listener(false)),show:()=>visibility.forEach(listener=>listener(true)),close:closePlayer});
  return <div data-fixture-account={account} style={{height:'100vh',overflow:'auto',padding:'15px 28px'}}><h1 className="fixture-outer-title" style={{fontSize:15,marginBottom:10}}>{detail.series.title}</h1>{shown&&<Player key="stable-fixture-player" detail={detail} initialEpisode={initialEpisode} initialPosition={0} settings={settings} accountKey={account} onSettings={patchPreferences} onLibrary={()=>{}} onClose={closePlayer} onSeries={value=>{data.seriesEvents.push(value.series.id);setDetail(value);}}/>}</div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
const emojiDirectory=path.join(root,'src','danmaku','emoji-images'),emojiResources={};
for(const name of await readdir(emojiDirectory)){if(/^emoji_dr_\d+\.png$/.test(name))emojiResources['./emoji-images/'+name]='data:image/png;base64,'+(await readFile(path.join(emojiDirectory,name))).toString('base64');}
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'fixture-observation',setup(builder){
  builder.onLoad({filter:/emoji-painter\.ts$/},async(args)=>({contents:(await readFile(args.path,'utf8')).replace(/^const resources = .*$/m,'const resources: Record<string,string> = '+JSON.stringify(emojiResources)+';'),loader:'ts',resolveDir:path.dirname(args.path)}));
  builder.onLoad({filter:/HlsDeck\.ts$/},async(args)=>{let contents=await readFile(args.path,'utf8');contents=contents.replace('if (released) return; released = true;', 'if (released) return; released = true; (window as any).__qaDecoders?.active.delete(deck);');contents=contents.replace('this.decks.set(index, deck);','this.decks.set(index, deck); const observed=(window as any).__qaDecoders??((window as any).__qaDecoders={active:new Set(),peak:0});observed.active.add(deck);observed.peak=Math.max(observed.peak,observed.active.size);');return{contents,loader:'ts',resolveDir:path.dirname(args.path)};});
}}]});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script>window.__qaWorkers={active:0,peak:0};const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__qaWorkers.active++;window.__qaWorkers.peak=Math.max(window.__qaWorkers.peak,window.__qaWorkers.active);this.counted=true;}terminate(){if(this.counted){this.counted=false;window.__qaWorkers.active--;}return super.terminate();}};</script><script src="/fixture.js"></script></body></html>');
const server=createServer(async(req,res)=>{try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=name==='/'?'index.html':name.slice(1);if(file.includes('..')){res.writeHead(403);res.end();return;}const body=await readFile(path.join(work,file));res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const window=new BrowserWindow({width:1440,height:1080,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
let instance,page;const checks=[],errors=[];
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const active=()=>page.locator('video[data-active=true]');
const load=async(mode='core',episode=3,autoplay=true)=>{await page.goto(origin+`/?mode=${mode}&episode=${episode}&autoplay=${autoplay}`);await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]'),timeline=document.querySelector('input[aria-label="播放进度"]');return v&&v.readyState>=2&&v.videoWidth&&v.currentTime>0&&!v.paused&&!document.querySelector('.switch-status')&&timeline&&!timeline.disabled;},undefined,{timeout:30000});};
const end=async()=>{await active().evaluate(v=>{v.currentTime=v.duration-.15;void v.play();});};
const stays=async(name)=>{await page.waitForTimeout(1200);check(name,await active().evaluate(v=>v.dataset.seriesId==='12345678'),await page.evaluate(()=>({seriesEvents:window.__qa.seriesEvents,episode:document.querySelector('video[data-active=true]')?.dataset.episode})));};
try{
  instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_BACKGROUND:'1',HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await load('core',1);await active().evaluate(v=>v.pause());
  await page.waitForFunction(()=>window.__qa.requests.some(r=>r.route.includes('/next-season'))&&window.__qa.requests.some(r=>r.method==='POST'&&r.body?.seriesId==='87654321'),undefined,{timeout:10000});
  check('末三集已识别并准备下一季源',true);
  await page.getByLabel('播放第3集',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.dataset.episode==='3'&&!document.querySelector('.switch-status'),undefined,{timeout:15000});await active().evaluate(v=>v.pause());
  await page.locator('.next-season-card[data-season-status=ready]').waitFor({timeout:15000});
  check('最后一集第二槽已解码下一季首集',await page.locator('video[data-active=false]').evaluate(v=>v.dataset.seriesId==='87654321'&&v.readyState>=2&&v.videoWidth>0&&v.paused));
  await page.keyboard.press('m');await page.getByTitle('评论',{exact:true}).click();
  await page.evaluate(()=>{window.__qa.videoNodes=[...document.querySelectorAll('video')];window.__qa.samples=[];window.__qa.sampling=true;const canvas=document.createElement('canvas');canvas.width=16;canvas.height=9;const ctx=canvas.getContext('2d',{willReadFrequently:true});const sample=()=>{if(!window.__qa.sampling)return;const v=document.querySelector('video[data-active=true]');let rgb=null;if(v?.readyState>=2&&v.videoWidth){ctx.drawImage(v,0,0,16,9);const color=ctx.getImageData(8,4,1,1).data;rgb=[...color].slice(0,3);}window.__qa.samples.push({id:v?.dataset.seriesId,ready:v?.readyState,seeking:v?.seeking,time:v?.currentTime,at:performance.now(),rgb});requestAnimationFrame(sample);};sample();});
  let fullscreen=false;await page.locator('.video-stage').hover();await page.getByTitle('全屏（F）',{exact:true}).click();try{await page.waitForFunction(()=>!!document.fullscreenElement,undefined,{timeout:2500});fullscreen=true;}catch{}
  await end();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.dataset.seriesId==='87654321',undefined,{timeout:15000});await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.currentTime>.1,undefined,{timeout:10000});await active().evaluate(v=>v.pause());
  const state=await page.evaluate(()=>{window.__qa.sampling=false;const v=document.querySelector('video[data-active=true]');return{title:document.querySelector('.player-heading h2')?.textContent,outer:document.querySelector('.fixture-outer-title')?.textContent,unchanged:window.__qa.videoNodes.every((node,index)=>node===document.querySelectorAll('video')[index]),rate:v.playbackRate,muted:v.muted,volume:v.volume,fullscreen:!!document.fullscreenElement,decoders:window.__qaDecoders?.peak||0,invalidFrames:window.__qa.samples.filter(s=>!s.seeking&&(s.ready<2||!s.rgb)).length,redFrames:window.__qa.samples.filter(s=>s.id==='87654321'&&s.rgb?.[0]>200).length,history:window.__qa.progress};});
  await writeFile(path.join(work,'cross-season-frames.json'),JSON.stringify(await page.evaluate(()=>window.__qa.samples),null,2));await page.screenshot({path:path.join(work,'cross-season.png')});
  check('自然结束自动跨季且复用两个解码槽',state.title==='测试第二季'&&state.outer===state.title&&state.unchanged&&state.decoders===2&&state.invalidFrames===0&&state.redFrames>0,{title:state.title,unchanged:state.unchanged,decoders:state.decoders,invalidFrames:state.invalidFrames,redFrames:state.redFrames});
  check('倍速画质静音与弹幕保留',state.rate===3&&state.volume===.6&&state.muted&&await page.getByLabel('播放画质',{exact:true}).inputValue()==='1080p'&&await page.getByLabel('关闭弹幕',{exact:true}).getAttribute('aria-pressed')==='true');
  check('旧季和新季进度均按各自SID保存',state.history.some(r=>r.series.id==='12345678'&&r.episode===3&&r.position>11)&&state.history.some(r=>r.series.id==='87654321'&&r.episode===1&&r.position>0));
  check('全屏切季保留同一容器',!fullscreen||state.fullscreen,{entered:fullscreen,retained:state.fullscreen});if(state.fullscreen)await page.keyboard.press('Escape');
  await page.getByLabel('收藏',{exact:true}).click();await page.waitForFunction(()=>window.__qa.favoriteRequests.includes('87654321'));
  check('新季评论弹幕收藏均使用新SID',await page.evaluate(()=>window.__qa.requests.some(r=>r.route.startsWith('/catalog/comments')&&r.route.includes('seriesId=87654321'))&&window.__qa.requests.some(r=>r.route.startsWith('/catalog/danmaku')&&r.route.includes('seriesId=87654321'))&&window.__qa.favoriteRequests.at(-1)==='87654321'));
  if(!process.argv.includes('--quick')){
    await load('core',3,false);await active().evaluate(v=>v.pause());await page.locator('.next-season-card[data-season-status=ready]').waitFor({timeout:15000});await end();await stays('关闭自动播放停在季末');await page.getByTitle('下一季（J）',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.dataset.seriesId==='87654321',undefined,{timeout:15000});check('关闭自动播放仍可手动一键下一季',true);
    for(const action of ['pause','autoplay','hide','account','seek']){
      await load('slow',3,true);await page.waitForFunction(()=>window.__qa.lookupWaiting);await end();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.ended&&document.querySelector('video[data-active=true]')?.paused&&!!document.querySelector('button[title="暂停（空格）"]'),undefined,{timeout:15000});
      if(action==='pause')await page.getByTitle('暂停（空格）',{exact:true}).click();
      if(action==='autoplay')await page.evaluate(()=>window.__qa.patch({autoplay:false}));
      if(action==='hide')await page.evaluate(()=>window.__qa.hide());
      if(action==='account'){await page.evaluate(()=>window.__qa.changeAccount('replacement-fixture-account'));await page.waitForFunction(()=>document.querySelector('[data-fixture-account]')?.getAttribute('data-fixture-account')==='replacement-fixture-account'&&window.__qa.accountCommitted==='replacement-fixture-account');}
      if(action==='seek')await page.getByLabel('播放进度',{exact:true}).evaluate(input=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'2');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
      await page.evaluate(()=>window.__qa.releaseLookup());await stays('慢查季期间 '+action+' 阻止迟到自动跨季');
      if(action==='account'){const evidence=await page.evaluate(()=>({accountCommitted:window.__qa.accountCommitted,callbacks:window.__qa.callbacks,requests:window.__qa.requests.filter(r=>r.route.startsWith('/catalog/series/'))}));await writeFile(path.join(work,'account-transition.json'),JSON.stringify(evidence,null,2));check('旧账号迟到回复不读取下一季详情',await page.evaluate(()=>!window.__qa.requests.some(r=>r.route==='/catalog/series/87654321')),evidence);}
    }
    await load('retry',3,true);await page.waitForFunction(()=>window.__qa.failWaiting);await page.getByRole('button',{name:'播放下一季',exact:true}).click();await page.evaluate(()=>window.__qa.releaseFailure());await page.locator('.next-season-card[data-season-status=error]').waitFor({timeout:15000});await page.getByRole('button',{name:'重试下一季',exact:true}).click();await page.locator('.next-season-card[data-season-status=ready]').waitFor({timeout:15000});await page.getByRole('button',{name:'播放下一季',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.dataset.seriesId==='87654321',undefined,{timeout:15000});check('跨季实际解码失败后小卡重试可提交',true);
    await load('ambiguous',3,true);await end();await stays('歧义季关联不自动跳转');check('歧义关联未分配下一季媒体',await page.evaluate(()=>!window.__qa.requests.some(r=>r.method==='POST'&&r.body?.seriesId==='87654321')));
  }
  check('所有测试webContents全程强制静音',await instance.evaluate(({app,webContents})=>app.commandLine.hasSwitch('mute-audio')&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
  check('无渲染异常',errors.length===0,{errors});await page.screenshot({path:path.join(work,'final.png')});
}catch(error){checks.push({name:'season playback QA',ok:false,error:String(error.message)});console.error(String(error.stack));process.exitCode=1;if(page)await page.screenshot({path:path.join(work,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(work,'results.json'),JSON.stringify({checks,errors},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));}

/** Real metadata/media with an isolated existing account; progress IPC is observation-only. */
async function liveSeason(){
  const folder=path.join(work,'live'),profile=path.join(folder,'profile');await mkdir(profile,{recursive:true});
  for(const filename of ['desktop-device.json','account-session.dpapi'])await copyFile(path.join(root,'_work','fourth-episode','profile',filename),path.join(profile,filename));
  let app,page,stage='launch';const checks=[],errors=[];
  const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
  const current=()=>page.locator('video[data-active=true]');
  try{
    app=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:folder,TMP:folder},timeout:60000});page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.name));
    await app.evaluate(({ipcMain})=>{globalThis.__seasonLiveProgress=[];globalThis.__seasonLiveRequests=[];ipcMain.removeHandler('library:progress');ipcMain.handle('library:progress',(_event,value)=>{globalThis.__seasonLiveProgress.push({seriesId:value.series.id,episode:value.episode,position:value.position,duration:value.duration});});const original=ipcMain._invokeHandlers.get('api:request');ipcMain.removeHandler('api:request');ipcMain.handle('api:request',async(...args)=>{const route=args[1],result=await original(...args);if(route.includes('/next-season'))globalThis.__seasonLiveRequests.push({type:'season',seriesId:result?.seriesId,status:result?.status,nextSeriesId:result?.next?.id});if(route==='/media/session'&&args[2]?.method==='POST')globalThis.__seasonLiveRequests.push({type:'media',seriesId:args[2].body?.seriesId,episode:args[2].body?.episode,quality:args[2].body?.quality,phase:result?.phase});return result;});});
    await page.waitForSelector('.app-shell',{timeout:60000});stage='settings';
    await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:3,autoplay:true,volume:.6,danmaku:{enabled:false}}));await page.reload();await page.waitForSelector('.app-shell');
    const session=await page.evaluate(()=>window.hongguo.request('/account/session'));
    check('真实检查沿用隔离的既有账号',session.loggedIn===true);
    stage='detail';await page.getByLabel('搜索剧名、演员或关键词').fill('和离后我带女儿横扫魔域');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
    const card=page.locator('.series-card[data-series-id="7698294694886788121"]').first();await card.waitFor({timeout:90000});await card.locator('.series-poster-button').click();await page.waitForSelector('.detail-hero',{timeout:60000});
    for(let count=0;count<10;count++){if(await page.getByRole('dialog').getByRole('button',{name:'播放第 1000 集',exact:true}).count())break;const more=page.getByRole('button',{name:/显示更多集数/});if(!await more.count())throw new Error('Season tail unavailable');await more.click();}
    stage='first-frame';await page.getByRole('dialog').getByRole('button',{name:'播放第 1000 集',exact:true}).click();
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]'),slider=document.querySelector('input[aria-label="播放进度"]');return v&&v.dataset.seriesId==='7698294694886788121'&&v.dataset.episode==='1000'&&v.readyState>=2&&v.videoWidth>0&&!v.paused&&v.currentTime>0&&!document.querySelector('.switch-status')&&slider&&!slider.disabled;},undefined,{timeout:240000});
    await current().evaluate(v=>v.pause());check('真实第1季第1000集解码就绪',true,await current().evaluate(v=>({episode:v.dataset.episode,width:v.videoWidth,height:v.videoHeight,duration:v.duration})));
    stage='warm';await page.locator('.next-season-card[data-season-status=ready]').waitFor({timeout:240000});
    check('真实第2季首集已在第二槽解码',await page.locator('video[data-active=false]').evaluate(v=>v.dataset.seriesId==='7704261228037671998'&&v.dataset.episode==='1'&&v.readyState>=2&&v.videoWidth>0&&v.paused));
    await page.evaluate(()=>{window.__seasonLiveNodes=[...document.querySelectorAll('video')];});await page.keyboard.press('m');await page.locator('.video-stage').hover();await page.getByTitle('全屏（F）',{exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement,{},{timeout:10000});
    stage='transition';await current().evaluate(v=>{v.currentTime=v.duration-.25;void v.play();});
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.dataset.seriesId==='7704261228037671998'&&v.dataset.episode==='1'&&v.readyState>=2&&v.videoWidth>0&&!v.paused&&v.currentTime>.15;},undefined,{timeout:180000});await current().evaluate(v=>v.pause());
    const state=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');return{title:document.querySelector('.player-heading h2')?.textContent,episode:v.dataset.episode,width:v.videoWidth,height:v.videoHeight,rate:v.playbackRate,muted:v.muted,volume:v.volume,quality:document.querySelector('select[aria-label="播放画质"]')?.value,fullscreen:!!document.fullscreenElement,sameNodes:window.__seasonLiveNodes.every((node,index)=>node===document.querySelectorAll('video')[index])};});
    check('真实1000集季末自动衔接第2季首集',state.title==='和离后我带女儿横扫魔域第二季'&&state.episode==='1'&&state.width>0&&state.sameNodes,state);
    check('真实跨季保留全屏倍速画质静音',state.fullscreen&&state.rate===3&&state.quality==='1080p'&&state.volume===.6&&state.muted);
    const progress=await app.evaluate(()=>globalThis.__seasonLiveProgress);check('真实旧季与新季进度携带各自SID',progress.some(row=>row.seriesId==='7698294694886788121'&&row.episode===1000)&&progress.some(row=>row.seriesId==='7704261228037671998'&&row.episode===1));
    check('真实检查窗口全程强制静音',await app.evaluate(({app,webContents})=>app.commandLine.hasSwitch('mute-audio')&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
    await page.screenshot({path:path.join(folder,'after.png')});await writeFile(path.join(folder,'progress.json'),JSON.stringify(progress,null,2));
  }catch(error){checks.push({name:'真实跨季检查',ok:false,stage,errorType:error.name});console.log(JSON.stringify(checks.at(-1)));process.exitCode=1;if(page)await page.screenshot({path:path.join(folder,'failure.png')}).catch(()=>{});}
  finally{const requests=app?await app.evaluate(()=>globalThis.__seasonLiveRequests||[]).catch(()=>[]):[];await writeFile(path.join(folder,'result.json'),JSON.stringify({checks,errors,requests,progressMode:'observation-only; no cloud writes'},null,2));if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}}
}
