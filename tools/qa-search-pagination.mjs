// Real Catalog UI with controlled complete-search pages, errors and late responses.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),work=path.join(root,'_work/search-pagination-qa');await mkdir(work,{recursive:true});
const fixture=String.raw`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Catalog from '../../src/components/Catalog';import '../../src/styles.css';
const data=window.__qa={requests:[],fail:true,block:'none',pending:[],warning:false};
let update;data.setQuery=value=>update(value);data.release=()=>{for(const resolve of data.pending.splice(0))resolve();};
const rows=(query,start,end)=>Array.from({length:end-start},(_,index)=>({id:String((query==='新词'?22345678:12345678)+index+start),title:query+' '+(start+index),cover:'',intro:'',totalEpisodes:20,tags:['爱情'],actors:[]}));
window.hongguo={async request(route){const params=new URLSearchParams(route.split('?')[1]),query=params.get('q'),cursor=params.get('cursor')||'';data.requests.push({route,query,cursor,refresh:params.get('refresh')});if(data.block===cursor){data.block='none';await new Promise(resolve=>data.pending.push(resolve));}if(cursor==='p2'&&data.fail)throw new Error("Error invoking remote method 'api:request': Error: 后续结果暂未加载，请重试");if(query==='新词')return{items:rows(query,0,4),hasMore:false,cursor:''};if(cursor==='p1+/=')return{items:rows(query,20,50),hasMore:true,cursor:'p2',...(data.warning?{warning:'部分搜索结果暂未补齐，可刷新重新查询'}:{})};if(cursor==='p2')return{items:rows(query,50,60),hasMore:false,cursor:''};return{items:rows(query,0,30),hasMore:true,cursor:'p1+/='};}};
function Fixture(){const [query,setQuery]=useState('春风 & 夏雨');update=setQuery;return <div className="app-shell"><main className="app-main"><div className="content-scroll"><Catalog page="search" query={query} genre="short_play" accountKey="local" favorites={[]} history={[]} onOpen={()=>{}} onFavorite={()=>{}} onGenre={()=>{}}/></div></main></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.whenReady().then(()=>{const window=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Outside fixture');res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(await readFile(path.join(work,file)));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let instance,page;const checks=[],errors=[];
const check=(name,ok)=>{checks.push({name,ok});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const count=async expected=>page.waitForFunction(expected=>document.querySelectorAll('.series-card').length===expected,expected,{timeout:4000});
const more=()=>page.getByRole('button',{name:'加载更多故事',exact:true});
try{
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work},timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));await count(30);
 check('完整搜索首批和加载更多入口实际显示',await more().count()===1&&await page.evaluate(()=>window.__qa.requests[0].query==='春风 & 夏雨'));
 await more().click();await count(50);
 check('正确编码后续游标并合并超过四十部去重结果',await page.evaluate(()=>window.__qa.requests.at(-1).cursor==='p1+/='&&new Set([...document.querySelectorAll('.series-card')].map(node=>node.dataset.seriesId)).size===50));
 await more().click();await page.waitForSelector('.catalog-warning');
 check('后续页失败保留当前五十部作品并提供重试',await page.locator('.series-card').count()===50&&await page.locator('.catalog-warning').getByRole('button',{name:'重试',exact:true}).count()===1);
 await page.evaluate(()=>window.__qa.fail=false);await page.locator('.catalog-warning').getByRole('button',{name:'重试',exact:true}).click();await count(60);
 check('重试成功补齐后清除旧错误并收起加载更多',await page.locator('.catalog-warning').count()===0&&await more().count()===0);
 await page.evaluate(()=>window.__qa.block='');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>window.__qa.pending.length===1);
 check('刷新完整搜索带refresh参数并保留当前列表直到响应',await page.evaluate(()=>window.__qa.requests.at(-1).refresh==='true')&&await page.locator('.series-card').count()===60);
 await page.evaluate(()=>window.__qa.release());await count(30);await page.evaluate(()=>window.__qa.warning=true);await more().click();await count(50);
 check('后续页返回未补齐提示时实际显示提示',await page.locator('.catalog-warning').textContent().then(text=>text.includes('部分搜索结果暂未补齐')));
 await page.evaluate(()=>{window.__qa.warning=false;window.__qa.block='p2';});await more().click();await page.waitForFunction(()=>window.__qa.pending.length===1);await page.evaluate(()=>window.__qa.setQuery('新词'));await count(4);await page.evaluate(()=>window.__qa.release());await page.waitForTimeout(150);
 check('换关键词后旧分页响应不能混入新搜索结果',await page.locator('.series-card').count()===4&&await page.locator('.series-card').evaluateAll(nodes=>nodes.every(node=>node.querySelector('.series-title').textContent.startsWith('新词'))));
 check('分页窗口独立隐藏静音且无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'完整搜索分页验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({ok:checks.length>0&&checks.every(item=>item.ok),passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,checks,errors,fixture:'real Catalog React pagination; hidden silent Electron and local controlled search pages'},null,2));if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await new Promise(resolve=>server.close(resolve));}
