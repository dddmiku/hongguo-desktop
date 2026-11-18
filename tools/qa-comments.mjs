// Exercise the real Comments component with controlled pages and delayed episode replies.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),work=path.join(root,'_work/comments-qa');await mkdir(work,{recursive:true});
const fixture=String.raw`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import Player,{Comments} from '../../src/components/Player';import '../../src/styles.css';
const accountMode=new URLSearchParams(location.search).get('mode')==='account';
const nextCursor=JSON.stringify({offset:2,context:'synthetic + / ='});
const data=window.__qa={requests:[],cursorMatched:false,firstFailure:!accountMode,pageFailure:true,blocked:null,blockedAccount:accountMode?'old-account':null,pending:[],account:'old-account'};
let updateEpisode,updateAccount;data.setEpisode=value=>updateEpisode(value);data.setAccount=value=>{data.account=value;updateAccount(value);};data.release=()=>{for(const resolve of data.pending.splice(0))resolve();};
const row=(id,text)=>({id:String(id),text,nickname:'测试观众',avatar:'',likes:3,time:'2026-11-18T01:00:00Z'});
window.hongguo={async request(route){
 if(!route.startsWith('/catalog/comments')){
  if(route==='/media/session')return await new Promise(()=>{});
  if(route.endsWith('/next-season'))return{seriesId:'12345678',status:'none',next:null,firstEpisode:null};
  if(route.includes('/seasons'))return{seriesId:'12345678',status:'complete',seasons:[]};
  if(route.startsWith('/catalog/danmaku'))return{seriesId:'12345678',vid:'23456789',source:'mobile',start:0,end:10,items:[],hasMore:false};
  throw new Error('Unexpected synthetic fixture route');
 }
 const params=new URLSearchParams(route.split('?')[1]),episode=Number(params.get('episode')),cursor=params.get('cursor'),account=data.account;
 const isNext=cursor===nextCursor;data.cursorMatched=isNext;data.requests.push({episode,firstPage:cursor==='0',opaqueMatched:isNext,account});
 if(data.blocked===episode){data.blocked=null;await new Promise(resolve=>data.pending.push(resolve));}
 if(accountMode){if(data.blockedAccount===account){data.blockedAccount=null;await new Promise(resolve=>data.pending.push(resolve));}return{items:[row(account==='old-account'?20:21,account==='old-account'?'旧账号评论':'新账号评论')],total:1,cursor:0,hasMore:false};}
 if(episode===1&&cursor==='0'&&data.firstFailure){data.firstFailure=false;throw new Error("Error invoking remote method 'api:request': Error: 评论暂时无法加载，请稍后重试");}
 if(episode===1&&isNext&&data.pageFailure)throw new Error("Error invoking remote method 'api:request': Error: 后续评论暂未加载，请重试");
 if(episode===1&&isNext)return{items:[row(2,'首批第二条评论'),row(3,'翻页新增评论')],total:3,cursor:3,hasMore:false};
 if(episode===1)return{items:[row(1,'首批第一条评论'),row(2,'首批第二条评论')],total:3,cursor:nextCursor,hasMore:true};
 return{items:[row(10+episode,'第'+episode+'集独立评论')],total:1,cursor:0,hasMore:false};
},async getLibrary(){return{history:[],favorites:[]};},async saveProgress(){},onLibrary(){return()=>{};},onVisibility(){return()=>{};},onShutdown(){return()=>{};},async window(){return false;}};
const detail={series:{id:'12345678',title:'评论账号隔离验收',cover:'',intro:'',totalEpisodes:1,tags:[],actors:[]},episodes:[{index:1,vid:'23456789',title:'第一集',duration:10}]};
const settings={theme:'dark',quality:'1080p',rate:1,autoplay:false,volume:0,cacheGB:4,closeToTray:false,bossKey:'Ctrl+Shift+B',danmaku:{enabled:false,opacity:.8,fontSize:22,area:.5,density:'standard',blockedWords:[]}};
function Fixture(){const[episode,setEpisode]=useState(1),[account,setAccount]=useState('old-account');updateEpisode=setEpisode;updateAccount=setAccount;return<div style={{height:'100vh',padding:20}}>{accountMode?<Player detail={detail} initialEpisode={1} accountKey={account} settings={settings} onSettings={()=>{}} onLibrary={()=>{}} onClose={()=>{}}/>:<Comments seriesId="12345678" episode={episode} onClose={()=>{}}/>}</div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'test-component-export',setup(builder){
 builder.onLoad({filter:/[\\/]Player\.tsx$/},async args=>({contents:(await readFile(args.path,'utf8'))+'\nexport {Comments};\n',loader:'tsx',resolveDir:path.dirname(args.path)}));
 builder.onLoad({filter:/emoji-painter\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/^const resources = .*$/m,'const resources: Record<string,string> = {};'),loader:'ts',resolveDir:path.dirname(args.path)}));
}}]});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const{app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.whenReady().then(()=>{const window=new BrowserWindow({width:1000,height:800,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Outside fixture');res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(await readFile(path.join(work,file)));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
let instance,page;const checks=[],errors=[];
const check=(name,ok)=>{checks.push({name,ok});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const count=expected=>page.waitForFunction(expected=>document.querySelectorAll('.comment').length===expected,expected,{timeout:4000});
const more=()=>page.getByRole('button',{name:'加载更多',exact:true});
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});
 page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));await page.waitForSelector('.comment-error',{timeout:10000});
 check('评论失败只显示中文原因并提供重试',await page.locator('.comment-error p').textContent()==='评论暂时无法加载，请稍后重试'&&await page.getByRole('button',{name:'重试',exact:true}).count()===1);
 await page.getByRole('button',{name:'重试',exact:true}).click();await count(2);
 check('重试返回的正文和评论总数实际显示',await page.locator('.comment p').allTextContents().then(values=>values.join('|')==='首批第一条评论|首批第二条评论')&&await page.locator('.comments-header h3 span').textContent()==='3'&&await page.locator('.comment-error').count()===0);
 await more().click();await page.waitForSelector('.comment-error');
 check('JSON及特殊字符游标完整透传且翻页失败保留评论',await page.evaluate(()=>window.__qa.cursorMatched)&&await page.locator('.comment').count()===2&&await page.locator('.comment-error p').textContent()==='后续评论暂未加载，请重试'&&await more().count()===0);
 await page.evaluate(()=>window.__qa.pageFailure=false);await page.getByRole('button',{name:'重试',exact:true}).click();await count(3);
 check('翻页重试完整沿用opaque游标并合并去重正文',await page.evaluate(()=>window.__qa.requests.at(-1).opaqueMatched)&&await page.locator('.comment p').allTextContents().then(values=>values.join('|')==='首批第一条评论|首批第二条评论|翻页新增评论')&&await page.locator('.comment-error').count()===0&&await more().count()===0);
 await page.evaluate(()=>{window.__qa.blocked=2;window.__qa.setEpisode(2);});await page.waitForFunction(()=>window.__qa.pending.length===1);
 check('切集等待中清空上一集评论',await page.locator('.comment').count()===0&&await page.locator('.loading-state').count()===1);
 await page.evaluate(()=>window.__qa.setEpisode(3));await count(1);await page.evaluate(()=>window.__qa.release());await page.waitForTimeout(150);
 check('旧集迟到回复不能覆盖新集评论',await page.locator('.comments-header h3').textContent().then(text=>text.includes('第 3 集评论'))&&await page.locator('.comment p').textContent()==='第3集独立评论'&&await page.locator('.comment').count()===1);
 await page.goto(origin+'/?mode=account');await page.waitForSelector('.player-page');await page.getByTitle('评论',{exact:true}).click();await page.waitForFunction(()=>window.__qa.pending.length===1);
 await page.evaluate(()=>window.__qa.setAccount('new-account'));await count(1);
 check('真实Player切换账号后重新读取当前集评论',await page.locator('.comment p').textContent()==='新账号评论'&&await page.evaluate(()=>window.__qa.requests.some(item=>item.account==='new-account'&&item.firstPage)));
 await page.evaluate(()=>window.__qa.release());await page.waitForTimeout(150);
 check('旧账号迟到评论不能覆盖新账号正文',await page.locator('.comment').count()===1&&await page.locator('.comment p').textContent()==='新账号评论');
 check('验收窗口隔离隐藏静音且无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'评论界面验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({ok:checks.length>0&&checks.every(item=>item.ok),passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,checks,errors,fixture:'real Comments React source with a test-only named export; hidden silent Electron'},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));}
