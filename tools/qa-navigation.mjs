import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','navigation-qa');await mkdir(out,{recursive:true});
const server=await createServer({configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});await server.listen();
const port=server.httpServer.address().port,browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:960}});
await context.addInitScript(()=>{
  const series=Array.from({length:30},(_,n)=>({id:String(12345678+n),title:`测试片单 ${n+1}`,cover:'',intro:'',totalEpisodes:20,tags:['剧情'],actors:[]}));
  const prefs={theme:'dark',quality:'1080p',rate:1,autoplay:true,volume:.8,cacheGB:4,closeToTray:true,bossKey:'CommandOrControl+Shift+B'};
  const library={history:[{series:series[0],episode:2,position:10,duration:60,watchedAt:Date.now()/1000,uid:'local'}],favorites:[series[1]]};
  window.__calls=[];
  window.hongguo={
    request:async route=>{window.__calls.push(route);if(route.startsWith('/catalog')){await new Promise(r=>setTimeout(r,1200));return{items:series,hasMore:false};}if(route==='/account/session')return{loggedIn:false,uid:'',nickname:'',avatar:'',mobile:''};if(route==='/health')return{ok:true,version:'fixture',signer:true};if(route==='/media/cache')return{bytes:0,limit:4*1024**3,entries:0,active:0};return{};},
    getSettings:async()=>prefs,saveSettings:async value=>Object.assign(prefs,value),getLibrary:async()=>library,getHistory:async()=>({items:library.history,total:library.history.length,nextCursor:null}),
    toggleFavorite:async()=>library,removeHistory:async()=>library,syncLibrary:async()=>({library,warnings:[]}),
    onLibrary:()=>()=>{},onSettings:()=>()=>{},onSession:()=>()=>{},onUpdate:()=>()=>{},onVisibility:()=>()=>{},onShutdown:()=>()=>{},window:async()=>{},
    openExternal:async()=>{},exportDiagnostics:async()=>'',checkUpdate:async()=>({available:false,version:'fixture'}),saveProgress:async()=>{}
  };
});
const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
function passed(name,detail){checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)));}
try{
  await page.goto(`http://127.0.0.1:${port}`);await page.waitForSelector('.series-card');
  await page.locator('.content-scroll').evaluate(node=>node.scrollTop=650);await page.waitForTimeout(100);
  const previous=await page.locator('.content-scroll').evaluate(node=>node.scrollTop);
  await page.getByRole('button',{name:'观看历史',exact:true}).click();await page.waitForSelector('.history-card');passed('历史一键入口');
  const start=Date.now();await page.getByRole('button',{name:'发现',exact:true}).click();await page.waitForSelector('.series-card',{timeout:500});
  const restored=await page.locator('.content-scroll').evaluate(node=>node.scrollTop);if(Math.abs(previous-restored)>2)throw new Error(`返回片单丢失滚动位置：${previous}/${restored}`);passed('缓存导航立即展示且恢复位置',{ms:Date.now()-start,scrollTop:restored});
  await page.getByRole('button',{name:'我的收藏',exact:true}).click();await page.waitForSelector('.series-card');passed('收藏一键入口');
  await page.getByRole('button',{name:'登录账号',exact:true}).click();await page.waitForSelector('.phone-input');
  const phone=page.getByLabel('手机号',{exact:true});await phone.fill('13800000000');await page.screenshot({path:path.join(out,'account-fixture.png')});
  const geometry=await page.locator('.phone-input').evaluate(node=>{const prefix=node.querySelector('span').getBoundingClientRect(),input=node.querySelector('input').getBoundingClientRect();return{prefixRight:prefix.right,inputLeft:input.left,inputWidth:input.width};});if(geometry.inputLeft<geometry.prefixRight||geometry.inputWidth<100)throw new Error('手机号输入框与区号重叠');passed('账号入口及区号布局',geometry);
  await page.getByRole('button',{name:'发现',exact:true}).click();await page.waitForSelector('.series-card');
  await page.locator('.content-scroll').evaluate(node=>node.scrollTop=0);await page.locator('.catalog-page').click({position:{x:20,y:20}});
  await page.locator('.catalog-page').evaluate(node=>node.requestFullscreen());await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.keyboard.press('Control+k');if(await page.getByLabel('搜索剧名、演员或关键词').evaluate(node=>document.activeElement===node))throw new Error('全屏中快捷搜索聚焦了容器外');passed('全屏搜索快捷键守卫');await page.evaluate(()=>document.exitFullscreen());
  await page.reload();const restart=Date.now();await page.waitForSelector('.series-card',{timeout:650});passed('公开片单重启缓存',{ms:Date.now()-restart});
  await page.setViewportSize({width:960,height:740});await page.waitForTimeout(150);const width=await page.evaluate(()=>document.documentElement.scrollWidth);if(width>960)throw new Error('窄窗口横向溢出');passed('960px入口布局无溢出');
  if(errors.length)throw new Error(errors.join('\n'));
}catch(error){checks.push({name:'界面验收',ok:false,error:error.message});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await context.close();await browser.close();await server.close();}
