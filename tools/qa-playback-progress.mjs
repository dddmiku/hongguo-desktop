import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),baseline=process.argv.includes('--baseline');
const out=path.join(root,'_work','playback-progress-qa');await mkdir(out,{recursive:true});
const instance=await electron.launch({args:['.'],cwd:root,env:{...process.env,
  HG_TEST_DATA_DIR:path.join(root,'_work',baseline?'progress-before-data':'progress-after-data'),
  TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];let detail;
page.on('pageerror',error=>errors.push(error.message));
const check=(name,ok,info)=>{checks.push({name,ok,info});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
async function stage(name,milliseconds){await page.evaluate(name=>{window.__progressStage=name;},name);await page.waitForTimeout(milliseconds);}
try{
  await page.waitForSelector('.app-shell',{timeout:30000});
  await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:3,autoplay:false}));
  await page.reload();await page.waitForSelector('.app-shell');
  await page.evaluate(()=>window.hongguo.request('/media/cache/clear',{method:'POST'}));
  const query='人前小保姆';
  const result=await page.evaluate(query=>window.hongguo.request('/catalog/search?q='+encodeURIComponent(query)),query);
  const series=result.items.find(item=>item.title.includes('人前小保姆'));
  if(!series)throw new Error('公共测试剧未找到');
  detail=await page.evaluate(id=>window.hongguo.request('/catalog/series/'+id),series.id);
  console.log(JSON.stringify({publicTitle:series.title,episodes:detail.episodes.length,firstMetadataDuration:detail.episodes[0]?.duration}));
  await page.getByLabel('搜索剧名、演员或关键词').fill(query);await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  const card=page.locator('.series-card').filter({hasText:series.title}).first();await card.waitFor({timeout:90000});
  await card.locator('.series-poster-button').click();await page.waitForSelector('.detail-hero',{timeout:60000});
  await page.evaluate(()=>{
    window.__progressSamples=[];window.__progressStage='cold';window.__progressTimer=setInterval(()=>{
      const videos=[...document.querySelectorAll('video')],video=videos.find(element=>element.dataset.active==='true');
      const slider=document.querySelector('input[aria-label="播放进度"]');
      if(!video||video.readyState<2||!video.videoWidth||!slider||slider.disabled||document.querySelector('.player-status'))return;
      window.__progressSamples.push({at:performance.now(),stage:window.__progressStage,
        slot:videos.indexOf(video),episode:video.dataset.episode,current:video.currentTime,mediaDuration:video.duration,
        position:Number(slider.value),total:Number(slider.max),ratio:Number(slider.value)/Number(slider.max),
        text:document.querySelector('.player-time')?.textContent,rate:video.playbackRate,paused:video.paused,
        seeking:video.seeking,pending:!!document.querySelector('.switch-status')});
    },100);
  });
  const click=Date.now();await page.getByRole('dialog').locator('.episode-grid button').first().click();
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.currentTime>.2&&!v.paused;},undefined,{timeout:180000});
  console.log(JSON.stringify({firstPlayingMs:Date.now()-click}));
  await stage('cold',baseline?12000:4000);
  if(!baseline){
    const wanted=await page.locator('input[aria-label="播放进度"]').evaluate(slider=>Number(slider.max)*.8);
    await page.evaluate(()=>{window.__progressStage='future-seek';});
    await page.keyboard.press('8');
    await page.waitForFunction(target=>{const v=document.querySelector('video[data-active=true]');return v&&!v.paused&&Math.abs(v.currentTime-target)<5;},wanted,{timeout:120000});
    check('未来尚未生产的位置真实解码就绪',true,{wanted,actual:await page.locator('video[data-active=true]').evaluate(video=>video.currentTime)});
    await stage('after-future-seek',1000);
    await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.evaluate(()=>{window.__progressStage='quality-change';});
    const before=await page.locator('video[data-active=true]').evaluate(video=>video.currentTime);
    await page.getByLabel('播放画质').selectOption('720p');
    await page.waitForFunction(target=>{const v=document.querySelector('video[data-active=true]');return v&&!v.paused&&!document.querySelector('.switch-status')&&v.currentTime>=target-.5;},before,{timeout:120000});
    check('切换画质保持当前真实播放位置',true,{before,after:await page.locator('video[data-active=true]').evaluate(video=>video.currentTime)});
    await stage('after-quality-change',1500);
    await page.locator('.video-stage').hover({position:{x:20,y:20}});await page.evaluate(()=>{window.__progressStage='episode-change';});
    await page.getByTitle('下一集（J）').click();
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&v.dataset.episode==='2'&&v.currentTime>.2&&!v.paused;},undefined,{timeout:120000});
    await stage('cold-next-episode',5000);
    await page.keyboard.press('k');
    const paused=await page.locator('video[data-active=true]').evaluate(video=>({episode:Number(video.dataset.episode),position:video.currentTime,paused:video.paused}));
    await page.waitForFunction(async(value)=>{const library=await window.hongguo.getLibrary();const item=library.history.find(item=>item.series.id===value.sid);return item?.episode===value.episode&&Math.abs(item.position-value.position)<.2;},{sid:series.id,...paused},{timeout:10000});
    const saved=await page.evaluate(async sid=>(await window.hongguo.getLibrary()).history.find(item=>item.series.id===sid),series.id);
    check('真实暂停事件立即保存当前位置及完整时长',paused.paused&&saved.duration>20,{position:paused.position,savedPosition:saved.position,duration:saved.duration});
    await page.evaluate(()=>{window.__progressStage='cached-replay';});
    await page.getByRole('button',{name:'播放第1集',exact:true}).click();
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.dataset.episode==='1'&&v.currentTime>.2&&!v.paused;},undefined,{timeout:120000});
    await stage('cached-replay',1200);
  }
  const samples=await page.evaluate(()=>{clearInterval(window.__progressTimer);return window.__progressSamples;});
  await writeFile(path.join(out,baseline?'before-samples.json':'after-samples.json'),JSON.stringify({detail:detail.episodes.slice(0,3),samples},null,2));
  const cold=samples.filter(sample=>sample.stage==='cold'&&!sample.pending);
  const totals=[...new Set(cold.map(sample=>sample.total.toFixed(2)))];
  const regressions=[],jumps=[];
  for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i];
    if(a.stage!==b.stage||a.episode!==b.episode||a.slot!==b.slot||a.seeking||b.seeking||a.pending||b.pending)continue;
    if(b.current<a.current-.15||b.position<a.position-.15)regressions.push({a,b});
    if(b.current-a.current>(b.at-a.at)/1000*Math.max(a.rate,b.rate)+1)jumps.push({a,b});
  }
  check('冷缓存首次播放完整总时长稳定',cold.length>5&&totals.length===1&&cold[0].total>20,
    {samples:cold.length,totals,min:Math.min(...cold.map(s=>s.total)),max:Math.max(...cold.map(s=>s.total)),firstProducedExtent:cold[0].mediaDuration});
  if(!baseline){const first=samples.filter(sample=>sample.episode==='1');const totals=[...new Set(first.map(sample=>sample.total.toFixed(2)))];
    check('换画质与缓存重播仍用相同整集时间轴',totals.length===1,{totals,cachedSamples:first.filter(sample=>sample.stage==='cached-replay').length});}
  check('非用户跳转阶段时间与进度不倒退',regressions.length===0,{regressions:regressions.length});
  check('非用户跳转阶段不追直播边缘',jumps.length===0,{jumps:jumps.length});
  check('无渲染异常',errors.length===0,{errors});
  await page.screenshot({path:path.join(out,baseline?'before.png':'after.png')});
}catch(error){checks.push({name:'播放进度验收',ok:false,error:error.message});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(path.join(out,baseline?'before-result.json':'after-result.json'),JSON.stringify({checks,errors},null,2));
  await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
