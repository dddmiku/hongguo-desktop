// Real React input/dropdown events in an isolated, hidden Electron window; all replies are controlled.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),work=path.join(root,'_work/search-suggestions-qa');await mkdir(work,{recursive:true});
const fixture=String.raw`
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import SearchBox from '../../src/components/SearchBox';
import '../../src/styles.css';
const data=window.__qa={requests:[],submissions:[],selected:[],blocked:new Set(),pending:[],error:false};
const make=(query,index)=>({id:String(12345678+index),title:query+'故事'+(index+1),cover:'',intro:'',totalEpisodes:21+index,tags:['爱情','年代'],actors:[]});
data.release=query=>{for(const item of [...data.pending])if(item.query===query){data.pending.splice(data.pending.indexOf(item),1);item.resolve();}};
window.hongguo={async request(route,options){const query=new URLSearchParams(route.split('?')[1]).get('query');data.requests.push({query,timeout:options.timeout,at:performance.now()});if(data.blocked.has(query)){data.blocked.delete(query);await new Promise(resolve=>data.pending.push({query,resolve}));}if(query==='错误'&&data.error)throw new Error("Error invoking remote method 'api:request': Error: 搜索暂时不可用，请重试。");return{items:query==='空空'?[]:Array.from({length:10},(_,index)=>make(query,index))};}};
function Fixture(){const input=useRef(null),[detail,setDetail]=useState(''),[page,setPage]=useState('发现');useEffect(()=>{const key=event=>{if(event.ctrlKey&&event.key.toLowerCase()==='k'){event.preventDefault();input.current.focus();input.current.select();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[]);return <div className="app-shell app-topnav"><main className="app-main"><header className="app-header"><button className="outside" onClick={()=>setPage('发现')}>其他入口</button><div className="header-drag-space"/><SearchBox inputRef={input} onSearch={query=>{data.submissions.push(query);setPage('搜索结果');}} onSelect={series=>{data.selected.push(series.id);setDetail(series.title);}}/></header><section className="fixture-content"><h1>{page}</h1><div className="fixture-player">保留的播放页</div>{detail&&<div role="dialog"><h2>{detail}</h2></div>}</section></main></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
// App remains real; only its lazy media component is an observed marker so this test starts no network playback.
const appFixture=String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';import App from '../../src/App';import '../../src/styles.css';
const first={id:'22345678',title:'本地保留播放',cover:'',intro:'本地入口验证',totalEpisodes:8,tags:['爱情'],actors:[]},second={...first,id:'22345679',title:'搜索找到的新故事',totalEpisodes:12};
const data=window.__qa={requests:[],mounts:0,progress:[]};let settings={theme:'dark',quality:'auto',rate:1,autoplay:false,volume:0,cacheGB:4,closeToTray:false,bossKey:'Ctrl+Shift+B',danmaku:{enabled:false}};
const detail=series=>({series,episodes:Array.from({length:series.totalEpisodes},(_,index)=>({index:index+1,vid:String(32345678+index),title:'第一集',duration:60}))});
window.hongguo={async request(route,options={}){data.requests.push(route);if(route==='/account/session')return{loggedIn:false,uid:'local',nickname:'',avatar:'',mobile:''};if(route.startsWith('/catalog/search/suggestions'))return{items:[second]};if(route.startsWith('/catalog/series/')&&route.includes('/seasons'))return{seriesId:route.split('/')[3],status:'single',source:null,currentSeason:1,seasons:[]};if(route.startsWith('/catalog/series/'))return detail(route.endsWith(second.id)?second:first);if(route==='/media/session')return{id:'fixture-prepared',phase:'complete',duration:60,cached:true,url:'#'};if(route.startsWith('/media/session/'))return{};if(route.startsWith('/catalog/'))return{items:route.startsWith('/catalog/search?')?[second]:[first],hasMore:false,cursor:''};throw new Error('Unexpected App test request');},async getSettings(){return settings;},async saveSettings(patch){settings={...settings,...patch};return settings;},async getLibrary(){return{history:[],favorites:[]};},async saveProgress(value){data.progress.push(value);},async setOnline(){},onLibrary(){return()=>{};},onSettings(){return()=>{};},onSession(){return()=>{};},onVisibility(){return()=>{};},onShutdown(){return()=>{};},async window(){return false;}};
createRoot(document.getElementById('root')).render(<App/>);
`;
await writeFile(path.join(work,'app-fixture.jsx'),appFixture);
await build({entryPoints:[path.join(work,'app-fixture.jsx')],outfile:path.join(work,'app-fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'observe-App-media-mount',setup(builder){builder.onLoad({filter:/src[\\/]components[\\/]Player\.tsx$/},args=>({contents:String.raw`import React,{useEffect,useRef} from 'react';export default function Player(props){const id=useRef(null);if(id.current===null)id.current=++window.__qa.mounts;return <div className="player-page app-media-marker" data-instance={id.current} data-active={String(props.isActive)}><h2>{props.detail.series.title}</h2></div>;}`,loader:'tsx',resolveDir:path.dirname(args.path)}));}}]});
await writeFile(path.join(work,'app.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app-fixture.css"></head><body><div id="root"></div><script src="/app-fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.whenReady().then(()=>{const window=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Outside fixture');res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(await readFile(path.join(work,file)));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[];
const check=(name,ok,details)=>{checks.push({name,ok,...(details?{details}:{})});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const input=()=>page.getByLabel('搜索剧名、演员或关键词');
const rows=()=>page.getByRole('option');
const ready=async query=>{await page.waitForFunction(query=>document.querySelector('.search-suggestions')?.dataset.query===query&&document.querySelectorAll('.search-suggestion').length===8,query,{timeout:4000});};
const load=async()=>{await page.goto(origin);await page.waitForSelector('.live-search-box');await page.evaluate(()=>window.__qa.player=document.querySelector('.fixture-player'));};
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));
 await load();await input().fill('红');await page.waitForTimeout(380);
 check('单个汉字尚未查询，不发送模糊半词请求',await page.evaluate(()=>window.__qa.requests.length===0));
 await input().fill('红果');await page.waitForTimeout(100);
 check('输入防抖期间显示加载且未发立即查询',await page.locator('.search-suggestions-status').textContent().then(text=>text.includes('正在找'))&&await page.evaluate(()=>window.__qa.requests.length===0));
 await ready('红果');
 check('实时建议最多八条并显示标题集数标签',await rows().count()===8&&await rows().first().innerText().then(text=>text.includes('红果故事1')&&text.includes('全 21 集')&&text.includes('爱情')));
 check('只更新下拉，不自动切换完整搜索页面',await page.locator('.fixture-content h1').textContent()==='发现'&&await page.evaluate(()=>window.__qa.submissions.length===0));
 await page.locator('.outside').click();await page.waitForTimeout(150);
 check('输入失焦立刻收起建议',await page.locator('.search-suggestions').count()===0);
 await input().click();await ready('红果');await rows().nth(2).click();
 check('点击建议不被blur抢先失效且直接打开对应详情',await page.getByRole('dialog').textContent().then(text=>text.includes('红果故事3'))&&await page.evaluate(()=>window.__qa.selected.length===1&&window.__qa.selected[0]==='12345680'&&window.__qa.submissions.length===0));
 check('选择建议保留播放页实例并收起下拉',await page.evaluate(()=>document.querySelector('.fixture-player')===window.__qa.player)&&await page.locator('.search-suggestions').count()===0);
 await input().fill('春风');await ready('春风');await input().press('ArrowDown');await input().press('ArrowDown');await input().press('ArrowUp');
 check('方向键更新可访问选中项',await rows().first().getAttribute('aria-selected')==='true'&&await input().getAttribute('aria-activedescendant')===await rows().first().getAttribute('id'));
 await input().press('Enter');
 check('Enter打开键盘选中的作品详情',await page.getByRole('dialog').textContent().then(text=>text.includes('春风故事1'))&&await page.evaluate(()=>window.__qa.submissions.length===0));
 await input().fill('夏雨');await ready('夏雨');await input().press('Escape');await page.waitForTimeout(350);
 check('Escape关闭建议，迟到回调和普通重渲染不重开',await page.locator('.search-suggestions').count()===0&&await input().getAttribute('aria-expanded')==='false');
 await input().fill('秋露');await ready('秋露');await input().press('Enter');
 check('未选择建议时Enter提交完整搜索',await page.evaluate(()=>window.__qa.submissions.at(-1)==='秋露')&&await page.locator('.fixture-content h1').textContent()==='搜索结果');
 await input().fill('冬雪');await ready('冬雪');await page.getByRole('button',{name:'查看全部搜索结果',exact:true}).click();
 check('下拉底部可显式查看全部搜索结果',await page.evaluate(()=>window.__qa.submissions.at(-1)==='冬雪')&&await page.locator('.search-suggestions').count()===0);
 await page.keyboard.press('Control+k');
 check('Ctrl K保留搜索聚焦与全选快捷键',await input().evaluate(node=>document.activeElement===node&&node.selectionStart===0&&node.selectionEnd===node.value.length));
 await page.getByLabel('清除搜索关键词').click();await page.waitForTimeout(380);
 check('清除后搜索为空且聚焦，不显示旧建议',await input().inputValue()===''&&await input().evaluate(node=>document.activeElement===node)&&await page.locator('.search-suggestions').count()===0);

 await load();await input().focus();await input().evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''})));await input().fill('h');await page.waitForTimeout(380);await input().press('Enter');
 check('IME组合中的半字与确认Enter不查询也不提交',await page.evaluate(()=>window.__qa.requests.length===0&&window.__qa.submissions.length===0));
 await input().fill('红果');await input().evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'红果'})));await ready('红果');
 check('IME确认完整中文后才查询建议',await page.evaluate(()=>window.__qa.requests.length===1&&window.__qa.requests[0].query==='红果'));
 await input().fill('红果 ');await ready('红果');await page.waitForTimeout(400);
 check('关键词尾部空白变化不会取消后卡在加载',await page.locator('.search-suggestions-status').count()===0&&await rows().count()===8);

 await load();await page.evaluate(()=>window.__qa.blocked.add('旧词'));await input().fill('旧词');await page.waitForFunction(()=>window.__qa.pending.some(item=>item.query==='旧词'));
 await input().fill('新词');await ready('新词');await page.evaluate(()=>window.__qa.release('旧词'));await page.waitForTimeout(200);
 check('旧关键词响应不能覆盖新关键词结果',await rows().first().innerText().then(text=>text.includes('新词故事1')&&!text.includes('旧词')));
 await page.evaluate(()=>window.__qa.blocked.add('迟到'));await input().fill('迟到');await page.waitForFunction(()=>window.__qa.pending.some(item=>item.query==='迟到'));await page.locator('.outside').click();await page.evaluate(()=>window.__qa.release('迟到'));await page.waitForTimeout(200);
 check('失焦后的晚响应不能重新打开下拉',await page.locator('.search-suggestions').count()===0);
 await input().fill('空空');await page.waitForFunction(()=>document.querySelector('.search-suggestions-status')?.textContent.includes('暂时没有匹配'));
 check('没有匹配结果时给出可继续搜索的空态',await rows().count()===0&&await page.getByRole('button',{name:'查看全部搜索结果',exact:true}).count()===1);
 await page.evaluate(()=>window.__qa.error=true);await input().fill('错误');await page.waitForFunction(()=>document.querySelector('.search-suggestions-error')?.textContent.includes('搜索暂时不可用'));
 check('业务错误提示去除IPC前缀并保留重试入口',!(await page.locator('.search-suggestions-error').innerText()).includes('Error invoking remote method'));
 await page.evaluate(()=>window.__qa.error=false);await page.getByRole('button',{name:'重试',exact:true}).click();await ready('错误');
 check('点击重试不丢失焦点并能够加载结果',await input().evaluate(node=>document.activeElement===node)&&await rows().count()===8);
 await page.screenshot({path:path.join(work,'search-suggestions.png')});
  await page.goto(origin+'/app.html');await page.locator('.discovery-hero-actions').getByRole('button',{name:'立即播放',exact:true}).click();await page.waitForSelector('.app-media-marker');
  await page.evaluate(()=>window.__qa.player=document.querySelector('.app-media-marker'));
  await input().fill('搜索');await page.getByRole('option',{name:'查看 搜索找到的新故事',exact:true}).waitFor({timeout:4000});await page.getByRole('option',{name:'查看 搜索找到的新故事',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.detail-copy h2')?.textContent==='搜索找到的新故事');
  check('实际App建议回调打开对应详情并保留原播放状态',await page.evaluate(()=>document.querySelector('.app-media-marker')===window.__qa.player&&window.__qa.player.dataset.active==='true'&&window.__qa.mounts===1&&!window.__qa.requests.some(route=>route.startsWith('/catalog/search?'))));
  await page.getByRole('dialog').getByLabel('关闭',{exact:true}).click();await page.keyboard.press('Control+k');
  check('实际App原Ctrl K快捷键仍聚焦独立搜索组件',await input().evaluate(node=>document.activeElement===node&&node.selectionStart===0&&node.selectionEnd===node.value.length));
  await input().fill('完整搜索');await input().press('Enter');await page.getByRole('heading',{name:'“完整搜索” 的搜索结果',exact:true}).waitFor({timeout:4000});
  check('实际App提交进入完整搜索页并提供返回原播放入口',await page.evaluate(()=>window.__qa.requests.includes('/catalog/search?q='+encodeURIComponent('完整搜索'))&&document.querySelector('.app-media-marker')===window.__qa.player&&window.__qa.player.dataset.active==='false'&&window.__qa.mounts===1)&&await page.getByRole('button',{name:'返回播放',exact:true}).count()===1);
  await page.keyboard.press('Control+k');await input().fill('搜索');await page.getByRole('option',{name:'查看 搜索找到的新故事',exact:true}).waitFor({timeout:4000});await page.screenshot({path:path.join(work,'search-suggestions-app.png')});
 check('独立测试窗口隐藏静音，无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'实时搜索下拉验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({ok:checks.length>0&&checks.every(item=>item.ok),passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,checks,errors,fixture:'real SearchBox React input/dropdown; hidden silent Electron with local controlled bridge'},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));}
