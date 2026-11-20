// Exercise the real Catalog component against controlled series-ranking pages.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),work=path.join(root,'_work','series-pagination-qa');
await mkdir(work,{recursive:true});
const fixture=String.raw`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Catalog from '../../src/components/Catalog';import '../../src/styles.css';
localStorage.removeItem('hongguo:catalog-selection-v1');localStorage.removeItem('hongguo:public-catalog-v1');localStorage.removeItem('hongguo:public-catalog-v2');
const state=window.__qa={requests:[],completed:[],pending:[],block:null,fail:null};
state.release=()=>{for(const resolve of state.pending.splice(0))resolve();};
const token=(board,page)=>board+'-p'+page+'+/= &?';
const rows=(board,start,end)=>Array.from({length:end-start},(_,index)=>({id:String((board==='recommend'?12345678:22345678)+start+index),title:board+' '+(start+index),cover:'',intro:'',totalEpisodes:20,tags:['第2季'],actors:[]}));
window.hongguo={async request(route){
 const params=new URLSearchParams(route.split('?')[1]),board=params.get('board'),genre=params.get('genre'),cursor=params.get('cursor')||'',request={route,board,genre,cursor,refresh:params.get('refresh')};
 state.requests.push(request);
 if(state.block?.board===board&&state.block.cursor===cursor){state.block=null;await new Promise(resolve=>state.pending.push(resolve));}
 if(state.fail?.board===board&&state.fail.cursor===cursor){state.fail=null;throw new Error("Error invoking remote method 'api:request': Error: 后续榜单暂未加载，请重试");}
 let result;
 if(genre!=='series')result={items:[],hasMore:false,cursor:''};
 else if(!cursor)result={items:rows(board,0,10),hasMore:true,cursor:token(board,1)};
 else if(cursor===token(board,1))result={items:rows(board,8,18),hasMore:true,cursor:token(board,2)};
 else if(cursor===token(board,2))result={items:rows(board,18,23),hasMore:false,cursor:''};
 else throw new Error('榜单游标串用');
 state.completed.push(request);return result;
}};
function Fixture(){const [genre,setGenre]=useState('short_play');return <div className="app-shell"><main className="app-main"><div className="content-scroll"><Catalog page="rank" query="" genre={genre} accountKey="local" favorites={[]} history={[]} onOpen={()=>{}} onFavorite={()=>{}} onGenre={setGenre}/></div></main></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(path.join(work,'fixture.jsx'),fixture);
await build({entryPoints:[path.join(work,'fixture.jsx')],outfile:path.join(work,'fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
await writeFile(path.join(work,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
await writeFile(path.join(work,'main.cjs'),String.raw`const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.HG_TEST_DATA_DIR);app.whenReady().then(()=>{const window=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});window.webContents.setAudioMuted(true);window.loadURL(process.env.HG_QA_ORIGIN);});app.on('window-all-closed',()=>app.quit());`);
const server=createServer(async(req,res)=>{try{const file=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';if(file.includes('..'))throw new Error('Outside fixture');res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(await readFile(path.join(work,file)));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port,checks=[],errors=[];let instance,page;
const check=(name,ok)=>{checks.push({name,ok});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const count=expected=>page.waitForFunction(expected=>document.querySelectorAll('.catalog-page .series-card').length===expected,expected,{timeout:5000});
const more=()=>page.getByRole('button',{name:'加载更多故事',exact:true});
const boardButton=label=>page.getByRole('group',{name:'排行榜类型'}).getByRole('button',{name:label,exact:true});
const token=(board,index)=>board+'-p'+index+'+/= &?';
const rowsMatch=(board,length)=>page.locator('.catalog-page .series-card').evaluateAll((nodes,{board,length})=>nodes.length===length&&nodes.every((node,index)=>node.dataset.seriesId===String((board==='recommend'?12345678:22345678)+index)),{board,length});
const ranksMatch=async length=>{const ranks=await page.locator('.catalog-page .rank-number').allTextContents();return ranks.length===length&&ranks.every((rank,index)=>rank===String(index+1).padStart(2,'0'));};
try{
 const env={...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_QA_ORIGIN:origin,TEMP:work,TMP:work};delete env.ELECTRON_RUN_AS_NODE;
 instance=await electron.launch({args:[path.join(work,'main.cjs')],cwd:root,env,timeout:60000});page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));
 await page.getByRole('tab',{name:'系列剧',exact:true}).click();await count(10);
 check('推荐榜首批十部作品和加载更多实际显示',await boardButton('推荐榜').getAttribute('aria-pressed')==='true'&&await rowsMatch('recommend',10)&&await more().count()===1);
 await page.evaluate(cursor=>window.__qa.fail={board:'recommend',cursor},token('recommend',1));
 await more().click();await page.waitForSelector('.catalog-warning');
 check('第二页失败保留首屏作品并提供重试',await rowsMatch('recommend',10)&&await page.locator('.catalog-warning').getByRole('button',{name:'重试',exact:true}).count()===1);
 await page.locator('.catalog-warning').getByRole('button',{name:'重试',exact:true}).click();await count(18);
 check('重试第二页成功并按ID去掉跨页重复作品',await rowsMatch('recommend',18)&&await page.locator('.catalog-warning').count()===0);
 check('包含特殊字符的游标完整编码并仍使用推荐榜',await page.evaluate(cursor=>{const request=window.__qa.requests.at(-1);return request.cursor===cursor&&request.board==='recommend'&&request.genre==='series'&&request.route.includes('cursor='+encodeURIComponent(cursor));},token('recommend',1)));
 check('合并第二页后名次按去重后的真实顺序连续',await ranksMatch(18));
 await more().click();await count(23);
 check('推荐榜加载到最后一页后收起分页且完整连续',await rowsMatch('recommend',23)&&await ranksMatch(23)&&await more().count()===0);
 await boardButton('新季榜').click();await count(10);
 check('新季榜独立加载首批十部且未混入推荐榜',await rowsMatch('new',10)&&await more().count()===1);
 await more().click();await count(18);
 check('新季榜第二页使用独立游标并去除跨页重复',await rowsMatch('new',18)&&await ranksMatch(18)&&await page.evaluate(cursor=>window.__qa.requests.at(-1).cursor===cursor,token('new',1)));
 await more().click();await count(23);
 check('新季榜末页收起分页且名次连续到23',await rowsMatch('new',23)&&await ranksMatch(23)&&await more().count()===0);
 await page.evaluate(()=>window.__qa.block={board:'new',cursor:''});
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>window.__qa.pending.length===1);
 check('刷新榜单带refresh参数且等待期间保留完整片单',await rowsMatch('new',23)&&await page.evaluate(()=>{const request=window.__qa.requests.at(-1);return request.board==='new'&&request.cursor===''&&request.refresh==='true';}));
 await page.evaluate(()=>window.__qa.release());await count(10);
 check('刷新完成重置到首屏并恢复对应分页入口',await rowsMatch('new',10)&&await ranksMatch(10)&&await more().count()===1);
 await page.evaluate(cursor=>window.__qa.block={board:'new',cursor},token('new',1));
 await more().click();await page.waitForFunction(()=>window.__qa.pending.length===1);
 await boardButton('推荐榜').click();await count(10);
 const completed=await page.evaluate(()=>window.__qa.completed.length);
 await page.evaluate(()=>window.__qa.release());await page.waitForFunction(completed=>window.__qa.completed.length>completed,completed);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 check('跨榜后迟到的新季榜分页不能覆盖或混入推荐榜',await rowsMatch('recommend',10)&&await boardButton('推荐榜').getAttribute('aria-pressed')==='true'&&await more().isEnabled());
 await more().click();await count(18);
 check('跨榜后继续加载仍使用当前推荐榜游标',await rowsMatch('recommend',18)&&await page.evaluate(cursor=>window.__qa.requests.at(-1).cursor===cursor,token('recommend',1)));
 check('所有后续页请求均携带所属榜单的游标',await page.evaluate(()=>window.__qa.requests.filter(request=>request.cursor).every(request=>request.cursor.startsWith(request.board+'-p')&&request.refresh===null)));
 check('验收窗口隐藏静音且运行中无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'系列排行榜分页验收',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{
 await writeFile(path.join(work,'result.json'),JSON.stringify({ok:checks.length>0&&checks.every(item=>item.ok),passed:checks.filter(item=>item.ok).length,failed:checks.filter(item=>!item.ok).length,checks,errors,fixture:'real Catalog React component; controlled independent ranking pages, retries, refresh and delayed responses; hidden silent Electron'},null,2));
 if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
 await new Promise(resolve=>server.close(resolve));
}
