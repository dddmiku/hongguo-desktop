// Real packaged-app regression: seek-to-tail during an automatic switch must still cut to the next episode.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work/tail-autoswitch');
await mkdir(out,{recursive:true});
const media=await readFile(path.join(out,'clip.m3u8'));
const clips=Object.fromEntries(await Promise.all(['clip-000.ts'].map(async name=>[name,await readFile(path.join(out,name))])));
const server=createServer((req,res)=>{
  const name=(req.url||'').split('?')[0].slice(1);
  if(name==='clip.m3u8'){res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Access-Control-Allow-Origin':'*'}).end(media);return;}
  if(clips[name]){res.writeHead(200,{'Content-Type':'video/mp2t','Access-Control-Allow-Origin':'*'}).end(clips[name]);return;}
  res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const mediaUrl=`http://127.0.0.1:${server.address().port}/clip.m3u8`;
const packaged=process.argv.includes('--packaged');
const executable=process.env.HG_QA_PACKAGED_PATH||path.join(root,'release/win-unpacked/红果桌面.exe');
const resultName=packaged?'packaged':'source';
const checks=[],errors=[];
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));};
let instance,page;
try{
  instance=await electron.launch({...((!packaged)?{args:['.'],cwd:root}:{executablePath:executable,args:[]}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile-'+resultName),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
  page=await instance.firstWindow();
  page.on('pageerror',error=>errors.push(error.name));
  await instance.evaluate(({ipcMain},url)=>{
    let session=0;
    const series={id:'9999999999999999993',title:'尾段自动切集演示',cover:'',intro:'本地回归画面',totalEpisodes:3,tags:[],actors:[]};
    const episodes=Array.from({length:3},(_,index)=>({index:index+1,vid:'9999999999999999994',title:`第 ${index+1} 集`,duration:3}));
    ipcMain.removeHandler('api:request');
    const fixtureRequest=(route,options={})=>{
      if(route==='/account/session')return{loggedIn:false,uid:'',nickname:'',avatar:'',mobile:''};
      if(route==='/catalog/series/'+series.id)return{series,episodes};
      if(route.includes('/seasons'))return{seriesId:series.id,status:'single',currentSeason:1,seasons:[],complete:true};
      if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
      if(route.startsWith('/catalog/danmaku'))return{items:[],start:0,end:3,hasMore:false,seriesId:series.id,vid:episodes[0].vid,source:'mobile'};
      if(route.startsWith('/catalog/'))return{items:[series],hasMore:false,cursor:null};
      if(route.startsWith('/media/session'))return options.method==='DELETE'?{}:{id:route==='/media/session'?'tail-'+ ++session:route.split('/').at(-1),phase:'complete',url,duration:3};
      if(route==='/media/cache/settings')return{};
      throw new Error('未预期的回归请求 '+route);
    };
    ipcMain.handle('api:request',(_event,route,options)=>fixtureRequest(route,options));
    ipcMain.removeHandler('media:request');
    ipcMain.handle('media:request',(_event,route,options)=>({ok:true,data:fixtureRequest(route,options)}));
  },mediaUrl);
  await page.waitForSelector('.app-shell');
  await page.evaluate(()=>window.hongguo.saveSettings({autoplay:true,rate:3,volume:0,danmaku:{enabled:false},quality:'1080p'}));
  await page.reload();
  await page.waitForSelector('.app-shell');
  const search=page.getByLabel('搜索剧名、演员或关键词');
  await search.fill('尾段自动切集演示');await search.press('Enter');
  await page.locator('.series-card .series-poster-button').first().click();
  await page.getByRole('dialog').getByRole('button',{name:'播放第 1 集',exact:true}).click();
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.videoWidth>0&&!v.paused&&v.currentTime>.2;},undefined,{timeout:30000});
  check('第1集真实解码播放',true);
  // Reproduce the real user gesture: repeated ArrowRight from a playing stream keeps seeking toward the tail.
  for(let round=0;round<6;round++){
    const before=await page.locator('video[data-active=true]').evaluate(v=>({t:v.currentTime,d:v.duration,paused:v.paused,seeking:v.seeking}));
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&!v.seeking;},undefined,{timeout:10000}).catch(()=>{});
    const after=await page.locator('video[data-active=true]').evaluate(v=>({t:v.currentTime,d:v.duration,paused:v.paused,ended:v.ended,seeking:v.seeking}));
    console.log(JSON.stringify({round,before,after}));
    if(after.ended||after.paused)break;
    await page.waitForTimeout(120);
  }
  // The real contract: the switcher must present episode 2 without any user recovery.
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.dataset.episode==='2'&&!v.paused;},undefined,{timeout:15000});
  const final=await page.locator('video[data-active=true]').evaluate(v=>({episode:v.dataset.episode,t:v.currentTime,paused:v.paused,videoWidth:v.videoWidth}));
  check('快进到片尾后无需人工干预即自动切到第2集',final.episode==='2'&&!final.paused&&final.videoWidth>0,final);
  check('无渲染异常',errors.length===0,{errors});
}catch(error){
  checks.push({name:'harness',ok:false,error:error.name,message:String(error.message).slice(0,300)});
  console.error(error.name+': '+String(error.message).slice(0,300));process.exitCode=1;
  if(page)await page.screenshot({path:path.join(out,'failure-'+resultName+'.png')}).catch(()=>{});
}finally{
  await writeFile(path.join(out,`result-${resultName}.json`),JSON.stringify({checks,errors},null,2));
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  await new Promise(resolve=>server.close(resolve));
}


