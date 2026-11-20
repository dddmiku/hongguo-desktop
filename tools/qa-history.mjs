import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','history-qa');await mkdir(out,{recursive:true});
const observePlayback = {
  name: 'observe-history-playback-target', enforce: 'pre',
  transform(_source, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/components/Player.tsx')) return null;
    return 'import React from "react"; export default function Player({initialEpisode,initialPosition,onClose}) { return React.createElement("button",{type:"button",className:"history-qa-player","data-episode":initialEpisode,"data-position":initialPosition,onClick:onClose},"结束验收播放"); }';
  },
};
const server=await createServer({configFile:path.join(root,'vite.config.ts'),plugins:[observePlayback],server:{host:'127.0.0.1',port:0}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:960}});
await context.addInitScript(()=>{
  const now=Date.now()/1000;
  const history=Array.from({length:120},(_,n)=>({series:{id:String(12345678+n),title:'历史剧 '+String(n+1).padStart(3,'0'),cover:'',intro:'剧情',totalEpisodes:10,tags:[],actors:[]},episode:n===119?7:2,position:n===119?35:10,duration:60,watchedAt:now-n*1800,uid:'fixture'}));
  Object.assign(history[0], { episode: 10, position: 60 });
  history[1].position = 60;
  history[2].position = 10.5;
  history[1].series.actors = ['演员 Ada'];
  history[2].series.actors = ['演员 李小红'];
  const prefs={theme:'dark',quality:'1080p',rate:1,autoplay:true,volume:.8,cacheGB:4,closeToTray:true,bossKey:'CommandOrControl+Shift+B'};
  const hidden=new Set();
  const library=()=>({history:history.filter(i=>!hidden.has(i.series.id)).slice(0,50),historyTotal:120-hidden.size,favorites:[history[1].series,history[2].series]});
  let account='fixture';
  const accountListeners = new Set();
  const session = () => ({loggedIn:true,uid:account,nickname:account,avatar:'',mobile:''});
  window.__switchFixtureAccount=()=>{account='other-fixture';for(const fn of accountListeners) fn(session());};
  window.__startDetailWait=false;
  window.__historyQueries=[];
  window.__mediaRequests=[];
  window.hongguo={
    request:async (route, options)=>{
      if(route==='/account/session')return session();
      if(route.startsWith('/catalog/series/') && route.includes('/seasons'))return{status:'single',currentSeason:1,seasons:[]};
      if(route.startsWith('/catalog/series/')){if(window.__startDetailWait)await new Promise(resolve=>window.__finishDetail=resolve);const item=history.find(i=>route.endsWith(i.series.id));return{series:item.series,episodes:Array.from({length:10},(_,n)=>({index:n+1,vid:String(23456789+n),title:'第 '+(n+1)+' 集'})).filter(ep=>item!==history[1]||ep.index!==3)};}
      if(route==='/media/session'){window.__mediaRequests.push(options.body);return{id:'fixture-'+window.__mediaRequests.length,url:'#',phase:'ready'};}
      if(route.startsWith('/catalog'))return{items:history.slice(0,30).map(i=>i.series),hasMore:false};return{};
    },
    getSettings:async()=>prefs,saveSettings:async()=>prefs,getLibrary:async()=>library(),
    getHistory:async(query={})=>{window.__historyQueries.push(query);let rows=history.filter(i=>!hidden.has(i.series.id));if(query.search)rows=rows.filter(i=>i.series.title.includes(query.search));if(query.period==='today'){const today=new Date();today.setHours(0,0,0,0);rows=rows.filter(i=>i.watchedAt>=today.getTime()/1000);}const start=Number(query.cursor)||0;return{items:rows.slice(start,start+50),total:rows.length,nextCursor:start+50<rows.length?String(start+50):null};},
    removeHistory:async id=>{if(window.__startRemovalWait)await new Promise(resolve=>window.__finishRemoval=resolve);hidden.add(id);return library();},syncLibrary:async()=>({library:library(),warnings:[]}),
    onLibrary:()=>()=>{},onSettings:()=>()=>{},onSession:fn=>{accountListeners.add(fn);return()=>accountListeners.delete(fn);},onUpdate:()=>()=>{},onVisibility:()=>()=>{},onShutdown:()=>()=>{},window:async()=>{},
    toggleFavorite:async()=>library(),openExternal:async()=>{},exportDiagnostics:async()=>'',saveProgress:async()=>{}
  };
});
const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
function passed(name,detail){checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)));}
try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.waitForSelector('.series-card');
  const playback = page.locator('.history-qa-player');
  const verifyPlayback = async (episode, position) => {
    await expect(playback).toHaveAttribute('data-episode', String(episode));
    await expect(playback).toHaveAttribute('data-position', String(position));
    await expect.poll(()=>page.evaluate(()=>window.__mediaRequests.at(-1))).toMatchObject({episode,start:position});
    await playback.click();
  };
  const continuation = page.getByRole('region',{name:'接着看'});
  const wanted = ['历史剧 002','历史剧 003','历史剧 004'].map(title=>'继续观看 '+title);
  const labels = locator=>locator.getByRole('button',{name:/继续观看/}).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));
  await expect.poll(()=>labels(continuation)).toEqual(wanted);
  await continuation.getByRole('button',{name:wanted[0]}).click();await verifyPlayback(4,0);
  await page.getByRole('button',{name:'为你推荐',exact:true}).click();
  await expect.poll(()=>labels(page.locator('.continue-strip'))).toEqual(wanted);
  await page.getByRole('button',{name:'我的片库',exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'我的片库'});
  await expect.poll(()=>labels(drawer)).toEqual(wanted);
  await drawer.getByRole('button',{name:wanted[1]}).click();await verifyPlayback(2,10.5);
  passed('三处接着看均排除已看完全剧，按实际集数续播和预加载');

  await page.getByRole('button',{name:'我的收藏',exact:true}).click();
  const favorites=page.locator('.favorites-page'),favoriteInput=page.getByRole('searchbox',{name:'搜索我的收藏'});
  await expect(favorites.locator('.series-card')).toHaveCount(2);
  await context.setOffline(true);
  await favoriteInput.fill('  ＡＤａ  ');
  await expect(favorites.locator('.series-card')).toHaveCount(1);
  await expect(favorites.locator('.series-title')).toHaveText('历史剧 002');
  await favoriteInput.fill('003');
  await expect(favorites.locator('.series-title')).toHaveText('历史剧 003');
  await favoriteInput.fill('无结果');
  await expect(favorites.getByText('没有匹配的收藏')).toBeVisible();
  await favorites.getByRole('button',{name:'查看全部收藏'}).click();
  await expect(favoriteInput).toBeFocused();
  await expect(favorites.locator('.series-card')).toHaveCount(2);
  await context.setOffline(false);
  passed('收藏离线搜索支持剧名、演员和清除空态');

  await page.getByRole('button',{name:'观看历史',exact:true}).click();await page.waitForSelector('.history-card');
  if(await page.locator('.history-card').count()!==50)throw new Error('历史首屏不是50条');
  if(!(await page.locator('.history-overview').innerText()).includes('120'))throw new Error('总数没有显示全量');
  await expect(page.getByRole('button',{name:'历史剧 001',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'历史剧 002',exact:true}).click();
  await page.locator('.detail-actions').getByRole('button',{name:'播放第 4 集',exact:true}).click();await verifyPlayback(4,0);
  passed('历史保留已看完剧，详情按钮按可播列表跳过缺集');
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
  await page.evaluate(()=>{window.__startRemovalWait=true;});
  await page.getByRole('button',{name:'移除 历史剧 002 的本地记录'}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.__finishRemoval)).toBe('function');
  await page.getByLabel('搜索观看历史').fill('003');
  await expect(page.locator('.history-overview')).toContainText('匹配 1 部作品');
  await expect(page.getByRole('button',{name:'历史剧 003',exact:true})).toBeVisible();
  await page.evaluate(()=>window.__finishRemoval());
  await expect(page.getByRole('button',{name:'移除 历史剧 003 的本地记录'})).toBeEnabled();
  await expect(page.locator('.history-overview')).toContainText('匹配 1 部作品');
  passed('历史删除进行中切换筛选，仍可查询且匹配数正确');

  await page.getByRole('button',{name:'红果桌面首页',exact:true}).click();
  await page.evaluate(()=>{window.__startDetailWait=true;});
  await continuation.getByRole('button',{name:'继续观看 历史剧 003'}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.__finishDetail)).toBe('function');
  await expect(page.getByRole('dialog',{name:'剧集详情'})).toBeVisible();
  await page.evaluate(()=>{window.__switchFixtureAccount();window.__finishDetail();});
  await expect(page.getByRole('dialog',{name:'剧集详情'})).toHaveCount(0);
  await expect(playback).toHaveCount(0);
  passed('账号切换丢弃在途的旧续看请求');

  if(errors.length)throw new Error(errors.join('\n'));
}catch(error){console.error(error.stack);checks.push({name:'历史验收',ok:false,error:error.message});process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await context.close();await browser.close();await server.close();}
