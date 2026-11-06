import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','history-qa');await mkdir(out,{recursive:true});
const server=await createServer({configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:960}});
await context.addInitScript(()=>{
  const now=Date.now()/1000;
  const history=Array.from({length:120},(_,n)=>({series:{id:String(12345678+n),title:'历史剧 '+String(n+1).padStart(3,'0'),cover:'',intro:'剧情',totalEpisodes:10,tags:[],actors:[]},episode:n===119?7:2,position:n===119?35:10,duration:60,watchedAt:now-n*1800,uid:'fixture'}));
  const prefs={theme:'dark',quality:'1080p',rate:1,autoplay:true,volume:.8,cacheGB:4,closeToTray:true,bossKey:'CommandOrControl+Shift+B'};
  const hidden=new Set();
  const library=()=>({history:history.filter(i=>!hidden.has(i.series.id)).slice(0,50),historyTotal:120-hidden.size,favorites:[]});
  window.__historyQueries=[];
  window.hongguo={
    request:async route=>{
      if(route==='/account/session')return{loggedIn:true,uid:'fixture',nickname:'测试账号',avatar:'',mobile:''};
      if(route.startsWith('/catalog/series/')){const item=history.find(i=>route.endsWith(i.series.id));return{series:item.series,episodes:Array.from({length:10},(_,n)=>({index:n+1,vid:String(23456789+n),title:'第 '+(n+1)+' 集'}))};}
      if(route.startsWith('/catalog'))return{items:history.slice(0,30).map(i=>i.series),hasMore:false};return{};
    },
    getSettings:async()=>prefs,saveSettings:async()=>prefs,getLibrary:async()=>library(),
    getHistory:async(query={})=>{window.__historyQueries.push(query);let rows=history.filter(i=>!hidden.has(i.series.id));if(query.search)rows=rows.filter(i=>i.series.title.includes(query.search));if(query.period==='today'){const today=new Date();today.setHours(0,0,0,0);rows=rows.filter(i=>i.watchedAt>=today.getTime()/1000);}const start=Number(query.cursor)||0;return{items:rows.slice(start,start+50),total:rows.length,nextCursor:start+50<rows.length?String(start+50):null};},
    removeHistory:async id=>{hidden.add(id);return library();},syncLibrary:async()=>({library:library(),warnings:[]}),
    onLibrary:()=>()=>{},onSettings:()=>()=>{},onSession:()=>()=>{},onUpdate:()=>()=>{},onVisibility:()=>()=>{},onShutdown:()=>()=>{},window:async()=>{},
    toggleFavorite:async()=>library(),openExternal:async()=>{},exportDiagnostics:async()=>'',saveProgress:async()=>{}
  };
});
const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
function passed(name,detail){checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)));}
try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.waitForSelector('.series-card');
  await page.getByRole('button',{name:'观看历史',exact:true}).click();await page.waitForSelector('.history-card');
  if(await page.locator('.history-card').count()!==50)throw new Error('历史首屏不是50条');
  if(!(await page.locator('.history-overview').innerText()).includes('120'))throw new Error('总数没有显示全量');
  await page.getByRole('button',{name:'更早的观看记录'}).click();await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===100);
  await page.getByRole('button',{name:'更早的观看记录'}).click();await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===120);passed('超过100条的分页历史完整呈现',{items:120});
  await page.getByRole('button',{name:'历史剧 120',exact:true}).click();await page.waitForSelector('.detail-hero');
  if(!await page.getByRole('button',{name:'继续第 7 集'}).isVisible())throw new Error('recent50之外历史丢失进度');passed('较早历史保留第7集与本次记录');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByLabel('搜索观看历史').fill('120');await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===1);
  if(!await page.getByRole('button',{name:'历史剧 120',exact:true}).isVisible())throw new Error('搜索没有匹配真实标题');passed('历史搜索跨完整库');
  await page.getByRole('button',{name:'清除历史搜索'}).click();await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===50);
  await page.getByRole('button',{name:'近 7 天',exact:true}).click();await page.getByLabel('历史观看状态').selectOption('unfinished');await page.waitForTimeout(200);
  const query=await page.evaluate(()=>window.__historyQueries.at(-1));if(query.period!=='week'||query.status!=='unfinished')throw new Error('筛选契约错误');passed('时间与未看完筛选正确传入查询',query);
  await page.screenshot({path:path.join(out,'history-fixture.png')});
  await page.getByRole('button',{name:'移除 历史剧 001 的本地记录'}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.history-title')).some(node=>node.textContent==='历史剧 001'));passed('本机移除不在刷新后复活');
  await page.setViewportSize({width:960,height:740});await page.waitForTimeout(100);if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('窄窗历史界面溢出');passed('历史窄窗布局');
  if(errors.length)throw new Error(errors.join('\n'));
}catch(error){console.error(error.stack);checks.push({name:'历史验收',ok:false,error:error.message});process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await context.close();await browser.close();await server.close();}
