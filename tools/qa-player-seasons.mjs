// Exercise the real playback page and HLS decoders in an isolated, silent Electron window.
// Public series metadata is representative; all media and bridge responses are local fixtures.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),work=path.join(root,'_work','player-seasons-qa');
await mkdir(work,{recursive:true});
const first='7698294694886788121',second='7704261228037671998',third='8800000000000000003';
for(const [kind,color] of [['first','blue'],['second','red'],['third','green']]){
  const folder=path.join(work,'media',kind);await mkdir(folder,{recursive:true});
  const generated=spawnSync(path.join(root,'runtime','ffmpeg.exe'),[
    '-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x180:r=20`,
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','24','-c:v','libx264',
    '-preset','ultrafast','-pix_fmt','yuv420p','-g','40','-c:a','aac','-b:a','64k',
    '-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_type','fmp4',
    '-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(folder,'seg%06d.m4s'),
    path.join(folder,'index.m3u8')
  ],{encoding:'utf8',windowsHide:true,cwd:folder});
  if(generated.status!==0)throw new Error('Local HLS generation failed: '+String(generated.stderr).slice(-400));
}

const fixture=String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Player from '../../src/components/Player';
import '../../src/styles.css';
const FIRST='7698294694886788121',SECOND='7704261228037671998',THIRD='8800000000000000003';
const make=(id,title,totalEpisodes,length,base)=>({series:{id,title,totalEpisodes,cover:'',intro:'本地跨季播放验收',tags:['fixture'],actors:[]},episodes:Array.from({length},(_,i)=>({index:i+1,vid:String(base+i+1),title:'第'+(i+1)+'集',duration:24}))});
const details=new Map([
 [FIRST,make(FIRST,'和离后我带女儿横扫魔域',1000,6,11000000)],
 [SECOND,make(SECOND,'和离后我带女儿横扫魔域第二季',521,5,22000000)],
 [THIRD,make(THIRD,'纯合成第三季（竞态专用）',4,4,33000000)]
]);
const mode=new URLSearchParams(location.search).get('mode')||'normal';
const data=window.__qa={requests:[],progress:[],seriesEvents:[],favorites:[],detailsWaiting:{},mediaWaiting:{},blockedDetails:new Set(),blockedMedia:new Set(),detailReleases:[],mediaReleases:[]};
const visibility=new Set(),library=new Set(),sessions=new Map();let settings,patch,changeAccount,setActive,close,currentAccount='fixture-account',counter=0;
const block=async(sid,kind)=>{const blocked=data[kind==='detail'?'blockedDetails':'blockedMedia'];if(!blocked.has(sid))return;blocked.delete(sid);const waiting=data[kind==='detail'?'detailsWaiting':'mediaWaiting'];waiting[sid]=(waiting[sid]||0)+1;await new Promise(resolve=>data[kind==='detail'?'detailReleases':'mediaReleases'].push({sid,resolve}));waiting[sid]--;};
Object.assign(data,{
 armDetail:sid=>data.blockedDetails.add(sid),armMedia:sid=>data.blockedMedia.add(sid),
 releaseDetail:sid=>{const pending=data.detailReleases.find(x=>x.sid===sid);if(pending){data.detailReleases.splice(data.detailReleases.indexOf(pending),1);pending.resolve();}},
 releaseMedia:sid=>{const pending=data.mediaReleases.find(x=>x.sid===sid);if(pending){data.mediaReleases.splice(data.mediaReleases.indexOf(pending),1);pending.resolve();}},
 hide:()=>visibility.forEach(listener=>listener(false)),show:()=>visibility.forEach(listener=>listener(true))
});
const getLibrary=()=>({history:data.progress,favorites:data.favorites});
window.hongguo={
 async request(route,options={}){
  data.requests.push({route,method:options.method||'GET',body:options.body?structuredClone(options.body):null});
  const overview=/^\/catalog\/series\/(\d+)\/seasons/.exec(route);
  if(overview){if(mode==='overview-error'&&!route.includes('refresh=true'))throw new Error('Synthetic overview unavailable');return{seriesId:overview[1],status:'found',source:'official',currentSeason:[FIRST,SECOND,THIRD].indexOf(overview[1])+1,seasons:[FIRST,SECOND,THIRD].map((sid,i)=>({season:i+1,series:details.get(sid).series}))};}
  const next=/^\/catalog\/series\/(\d+)\/next-season/.exec(route);
  if(next)return{seriesId:next[1],status:'none',season:1,nextSeason:null,next:null,source:null,firstEpisode:null};
  const detail=/^\/catalog\/series\/(\d+)$/.exec(route);
  if(detail){await block(detail[1],'detail');return details.get(detail[1]);}
  if(route==='/media/session'&&options.method==='POST'){
   await block(options.body.seriesId,'media');const id='local-'+(++counter);
   const kind=options.body.seriesId===FIRST?'first':options.body.seriesId===SECOND?'second':'third';
   const session={id,phase:'complete',duration:24,cached:true,quality:options.body.quality,url:location.origin+'/media/'+kind+'/index.m3u8'};sessions.set(id,session);return session;
  }
  if(route.startsWith('/media/session/')){const id=route.split('/').at(-1);if(options.method==='DELETE'){sessions.delete(id);return{};}return sessions.get(id);}
  if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
  if(route.startsWith('/catalog/danmaku')){const query=new URLSearchParams(route.split('?')[1]);return{seriesId:query.get('seriesId'),vid:'44444444',source:'mobile',start:0,end:24,items:[],hasMore:false};}
  throw new Error('Unexpected local fixture route');
 },
 async getLibrary(){return getLibrary();},async saveProgress(value){data.progress.push({...structuredClone(value),account:currentAccount});},
 async getSettings(){return settings;},async saveSettings(value){patch(value);return settings;},
 async toggleFavorite(value,desired){data.favorites=desired?[value]:[];for(const listener of library)listener(getLibrary());return getLibrary();},
 onLibrary(listener){library.add(listener);return()=>library.delete(listener);},onVisibility(listener){visibility.add(listener);return()=>visibility.delete(listener);},
 onShutdown(){return()=>{};},async window(){return false;}
};
function Fixture(){
 const [detail,setDetail]=useState(details.get(FIRST)),[account,setAccount]=useState(currentAccount),[active,activate]=useState(true),[shown,setShown]=useState(true);
 const [preferences,update]=useState({theme:'dark',quality:'1080p',rate:1.5,autoplay:false,volume:.6,cacheGB:4,closeToTray:false,bossKey:'Ctrl+Shift+B',danmaku:{enabled:false,opacity:.8,fontSize:22,area:.5,density:'standard',blockedWords:[]}});
 settings=preferences;patch=value=>update(old=>({...old,...value}));changeAccount=value=>{currentAccount=value;setAccount(value);};setActive=activate;close=()=>setShown(false);
 Object.assign(data,{patch,changeAccount,setActive,close});
 return <main className="content-scroll" style={{height:'100vh',overflow:'auto',padding:'15px 28px'}}><h1 className="fixture-outer-title" style={{fontSize:15}}>{detail.series.title}</h1>{shown&&<Player key="stable-player" detail={detail} initialEpisode={4} initialPosition={0} isActive={active} settings={preferences} accountKey={account} onSettings={patch} onLibrary={()=>{}} onClose={close} onSeries={value=>{data.seriesEvents.push(value.series.id);setDetail(value);}}/>}</main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
const emojiResources={},emojiDirectory=path.join(root,'src','danmaku','emoji-images');
for(const name of await readdir(emojiDirectory))if(/^emoji_dr_\d+\.png$/.test(name))emojiResources['./emoji-images/'+name]='data:image/png;base64,'+(await readFile(path.join(emojiDirectory,name))).toString('base64');
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'observe-real-decoder-lifecycle',setup(builder){
 builder.onLoad({filter:/emoji-painter\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/^const resources = .*$/m,'const resources: Record<string,string> = '+JSON.stringify(emojiResources)+';'),loader:'ts',resolveDir:path.dirname(args.path)}));
 builder.onLoad({filter:/HlsDeck\.ts$/},async args=>{let contents=await readFile(args.path,'utf8');contents=contents.replace('if (released) return; released = true;','if (released) return; released = true; (window as any).__qaDecoders?.active.delete(deck);');contents=contents.replace('this.decks.set(index, deck);','this.decks.set(index, deck);const observed=(window as any).__qaDecoders??((window as any).__qaDecoders={active:new Set(),peak:0});observed.active.add(deck);observed.peak=Math.max(observed.peak,observed.active.size);');return{contents,loader:'ts',resolveDir:path.dirname(args.path)};});
}}]});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const window=new BrowserWindow({width:1440,height:1080,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
const server=createServer(async(req,res)=>{try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=name==='/'?'index.html':name.slice(1);if(file.includes('..')){res.writeHead(403);res.end();return;}const body=await readFile(path.join(work,file));res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.m4s')||file.endsWith('.mp4')?'video/mp4':file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[];
const check=(name,ok,detail={})=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const current=()=>page.locator('video[data-active=true]');
const overview=()=>page.locator('.player-page .season-overview');
const card=season=>overview().locator('.season-overview-card').nth(season-1);
const committed=async(sid,episode)=>{await page.waitForFunction(({sid,episode})=>{const v=document.querySelector('video[data-active=true]');return v?.dataset.seriesId===sid&&v.dataset.episode===String(episode)&&v.readyState>=2&&v.videoWidth>0&&v.currentTime>.1&&!v.paused&&!document.querySelector('.switch-status')&&!document.querySelector('.player-status')&&!document.querySelector('.player-error');},{sid,episode},{timeout:30000});};
const load=async(mode='normal')=>{await page.goto(origin+'/?mode='+mode);await committed(first,4);};
const waiting=async(sid,kind='detail')=>page.waitForFunction(({sid,kind})=>window.__qa[kind==='detail'?'detailsWaiting':'mediaWaiting'][sid]>0,{sid,kind},{timeout:10000});
const arm=async(sid,kind='detail')=>page.evaluate(({sid,kind})=>window.__qa[kind==='detail'?'armDetail':'armMedia'](sid),{sid,kind});
const release=async(sid,kind='detail')=>page.evaluate(({sid,kind})=>window.__qa[kind==='detail'?'releaseDetail':'releaseMedia'](sid),{sid,kind});
const state=()=>page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');return{sid:v?.dataset.seriesId,episode:v?.dataset.episode,time:v?.currentTime,width:v?.videoWidth,ready:v?.readyState,paused:v?.paused,title:document.querySelector('.player-heading h2')?.textContent,outer:document.querySelector('.fixture-outer-title')?.textContent,events:window.__qa.seriesEvents};});
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_BACKGROUND:'1',HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});
 page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 await load();
 await overview().waitFor({timeout:process.argv.includes('--red-only')?3000:10000}).catch(()=>{});
 check('播放页选集下面显示全部季概览',await overview().count()===1&&await page.evaluate(()=>{const grid=document.querySelector('.player-page .episode-grid'),seasons=document.querySelector('.player-page .season-overview'),intro=document.querySelector('.player-description');return !!grid&&!!seasons&&!!intro&&!!(grid.compareDocumentPosition(seasons)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(seasons.compareDocumentPosition(intro)&Node.DOCUMENT_POSITION_FOLLOWING)&&!document.querySelector('.detail-hero');}));
 await card(3).waitFor({timeout:10000});
 const values=await overview().locator('.season-overview-card').evaluateAll(nodes=>nodes.map(node=>({title:node.querySelector('strong')?.textContent,count:node.querySelector('em')?.textContent,label:node.getAttribute('aria-label'),selected:node.classList.contains('selected'),current:node.getAttribute('aria-current')})));
 check('每季标题与总集数齐全，当前季高亮',values.length===3&&values[0].count?.startsWith('1000 集')&&values[1].count?.startsWith('521 集')&&values[2].count?.startsWith('4 集')&&values.every(v=>v.title&&/^播放第 /.test(v.label||''))&&values[0].selected&&values[0].current==='true'&&!values[1].selected&&!values[2].selected,values);
 if(!process.argv.includes('--red-only')){
  await page.evaluate(()=>{window.__qa.nodes=[...document.querySelectorAll('video')];window.__qa.layout=document.querySelector('.playback-layout');});
  await page.keyboard.press('m');await arm(second);await card(2).click();await waiting(second);
  check('目标详情待返回时当前视频仍有已解码画面',await current().evaluate(v=>v.dataset.seriesId==='7698294694886788121'&&v.videoWidth>0&&v.readyState>=2));
  await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('全屏（F）',{exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement,undefined,{timeout:5000});
  await release(second);await committed(second,1);
  const after=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),canvas=document.createElement('canvas');canvas.width=16;canvas.height=9;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(v,0,0,16,9);return{sid:v.dataset.seriesId,episode:v.dataset.episode,time:v.currentTime,width:v.videoWidth,rate:v.playbackRate,muted:v.muted,volume:v.volume,fullscreen:document.fullscreenElement===window.__qa.layout,nodesSame:window.__qa.nodes.length===2&&window.__qa.nodes.every((node,index)=>node===document.querySelectorAll('video')[index]),peak:window.__qaDecoders?.peak,rgb:[...ctx.getImageData(8,4,1,1).data].slice(0,3),quality:document.querySelector('[aria-label="播放画质"]')?.value,title:document.querySelector('.player-heading h2')?.textContent,outer:document.querySelector('.fixture-outer-title')?.textContent};});
  check('点击其他季提交第一集，已解码真实红色视频',after.sid===second&&after.episode==='1'&&after.width===320&&after.time>.1&&after.rgb[0]>200&&after.title==='和离后我带女儿横扫魔域第二季'&&after.outer===after.title,after);
  check('切季保留同一全屏容器、双视频 DOM 与最多两解码槽',after.fullscreen&&after.nodesSame&&after.peak===2,{fullscreen:after.fullscreen,nodesSame:after.nodesSame,peak:after.peak});
  check('手动切季保留倍速静音音量画质',after.rate===1.5&&after.muted&&after.volume===.6&&after.quality==='1080p');
  await page.keyboard.press('Escape');await card(2).waitFor({timeout:10000});check('提交后当前季高亮跟随第二季',await card(2).getAttribute('aria-current')==='true'&&await card(1).getAttribute('aria-current')===null);
  await page.waitForTimeout(250);await card(1).click();await committed(first,1);
  check('反向点击第一季从第一集开始且继续播放',true,await state());
  check('反向切季后当前季高亮恢复第一季',await card(1).getAttribute('aria-current')==='true'&&await card(2).getAttribute('aria-current')===null);
  const history=await page.evaluate(()=>window.__qa.progress.map(row=>({sid:row.series.id,episode:row.episode,position:row.position,account:row.account})));
  check('旧季与新季分别保存对应 SID 和集数的历史',history.some(row=>row.sid===first&&row.episode===4&&row.position>0)&&history.some(row=>row.sid===second&&row.episode===1&&row.position>0),history);
  await page.screenshot({path:path.join(work,'player-seasons.png')});

  await load();await arm(second);await card(2).click();await waiting(second);await card(3).click();await committed(third,1);await release(second);await page.waitForTimeout(1000);
  check('快速点击第二季再第三季，迟到第二季不覆盖最后选择',(await state()).sid===third&&await page.evaluate(()=>window.__qa.seriesEvents.length===1&&window.__qa.seriesEvents[0]==='8800000000000000003'),await state());
  await load();await arm(second,'media');await card(2).click();await waiting(second,'media');await card(3).click();await release(second,'media');await committed(third,1);await page.waitForTimeout(500);
  check('媒体准备途中快速改选第三季，只提交最后选择',(await state()).sid===third&&await page.evaluate(()=>window.__qa.seriesEvents.length===1&&window.__qa.seriesEvents[0]==='8800000000000000003'),await state());
  await load();await arm(second);await card(2).click();await waiting(second);await card(1).click();await release(second);await page.waitForTimeout(1000);
  check('点击当前季可取消已发出的其他季请求',(await state()).sid===first&&await page.evaluate(()=>window.__qa.seriesEvents.length===0),await state());
  await load();await arm(second,'media');await card(2).click();await waiting(second,'media');await card(1).click();await release(second,'media');await page.waitForTimeout(1000);
  check('媒体准备途中改选当前季可取消切换并继续原视频',(await state()).sid===first&&!(await state()).paused&&await page.evaluate(()=>window.__qa.seriesEvents.length===0),await state());
  await load();await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('暂停（空格）',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.paused);
  await arm(second,'media');await card(2).click();await waiting(second,'media');await card(1).click();await release(second,'media');await page.waitForTimeout(1000);
  check('原本暂停时取消其他季媒体准备，当前季仍保持暂停',(await state()).sid===first&&(await state()).paused&&await page.evaluate(()=>window.__qa.seriesEvents.length===0&&!document.querySelector('.switch-status')),await state());
  await load();await arm(second,'media');await card(2).click();await waiting(second,'media');await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.getByTitle('暂停（空格）',{exact:true}).click({timeout:2500});await release(second,'media');await page.waitForTimeout(1000);
  check('原本播放时准备其他季，暂停按钮取消请求且迟到后保持暂停',(await state()).sid===first&&(await state()).paused&&await page.evaluate(()=>window.__qa.seriesEvents.length===0&&!document.querySelector('.switch-status')),await state());
  await load();await arm(second);await card(2).click();await waiting(second);await page.getByLabel('播放第2集',{exact:true}).click();await committed(first,2);await release(second);await page.waitForTimeout(1000);
  check('手动选集使之前的跨季详情响应失效',(await state()).sid===first&&(await state()).episode==='2'&&await page.evaluate(()=>window.__qa.seriesEvents.length===0),await state());

  for(const phase of ['detail','media'])for(const action of ['hide','account','inactive','close']){
   await load();await arm(second,phase);await card(2).click();await waiting(second,phase);
   if(action==='hide')await page.evaluate(()=>window.__qa.hide());
   if(action==='account')await page.evaluate(()=>window.__qa.changeAccount('replacement-fixture-account'));
   if(action==='inactive')await page.evaluate(()=>window.__qa.setActive(false));
   if(action==='close')await page.getByRole('button',{name:'返回',exact:true}).click();
   await page.waitForTimeout(150);await release(second,phase);await page.waitForTimeout(800);
   const observed=await state(),events=await page.evaluate(()=>window.__qa.seriesEvents);
   check(phase+' 迟到响应在 '+action+' 后不会切季',events.length===0&&(action==='close'?await page.locator('.player-page').count()===0:observed.sid===first),{...observed,events});
   if(action==='hide'||action==='inactive'){
    await page.evaluate(action=>action==='hide'?window.__qa.show():window.__qa.setActive(true),action);await page.waitForTimeout(600);
    check(phase+' 恢复 '+action+' 后也不提交失效切季',(await state()).sid===first&&await page.evaluate(()=>window.__qa.seriesEvents.length===0),await state());
   }
  }
  await load('overview-error');await overview().locator('.season-overview-error').waitFor({timeout:10000});const before=await current().evaluate(v=>v.currentTime);await page.waitForTimeout(650);
  check('概览加载失败仅显示局部提示，视频持续真实播放',await current().evaluate((v,before)=>v.readyState>=2&&v.videoWidth>0&&v.currentTime>before&&!v.paused,before)&&await page.locator('.player-error').count()===0);
  await overview().getByRole('button',{name:'重试',exact:true}).click();await card(3).waitFor({timeout:10000});await card(2).click();await committed(second,1);
  check('概览重试成功后可正常直接切季',true,await state());
 }
 check('所有测试窗口全程强制静音',await instance.evaluate(({app,webContents})=>app.commandLine.hasSwitch('mute-audio')&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
 check('无渲染异常',errors.length===0,{errors});
}catch(error){checks.push({name:'播放页手动跨季 QA',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{
 await writeFile(path.join(work,'result.json'),JSON.stringify({ok:checks.length>0&&checks.every(item=>item.ok),passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,checks,errors,fixture:'real Player and real HLS decoders; synthetic bridge and generated media'},null,2));
 if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
 await new Promise(resolve=>server.close(resolve));
}
