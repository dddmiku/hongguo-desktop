// Real Electron + local HLS audit. All account/catalog data is synthetic and profiles are isolated.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import path from 'node:path';
const root=process.cwd(), work=path.join(root,'_work','playback-audit');
const installed=process.argv.includes('--installed'),packaged=process.argv.includes('--packaged');
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)||'result';
const scenario=process.argv.find(arg=>arg.startsWith('--scenario='))?.slice(11)||'all';
const heldRate=Number(process.argv.find(arg=>arg.startsWith('--held-rate='))?.slice(12)||3);
const heldWarm=process.argv.includes('--held-delayed')?'delayed':'ready';
const heldPaused=process.argv.includes('--held-paused');
const heldCadence=Number(process.argv.find(arg=>arg.startsWith('--held-cadence='))?.slice(15)||60);
const heldSegmentDelay=Number(process.argv.find(arg=>arg.startsWith('--held-segment-delay='))?.slice(21)||0);
const heldLast=process.argv.includes('--held-last'),heldLateAbort=process.argv.includes('--held-late-abort');
const heldStaleEnded=process.argv.includes('--held-stale-ended');
const heldCrossings=Number(process.argv.find(arg=>arg.startsWith('--held-crossings='))?.slice(17)||1);
await mkdir(work,{recursive:true});
try{await access(path.join(work,'sample.m3u8'));}catch{
  execFileSync(path.join(root,'runtime','ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=20','-t','30','-c:v','libx264','-threads','2','-preset','ultrafast','-pix_fmt','yuv420p','-g','40','-an','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(work,'sample-%03d.ts'),path.join(work,'sample.m3u8')],{windowsHide:true,timeout:30000});
}
const server=createServer(async(req,res)=>{
  let file=(req.url||'').split('?')[0].slice(1);
  const episodePath=/^episode\/(\d+)\/(.+)$/.exec(file);
  if(episodePath){file=episodePath[2];if(heldSegmentDelay&&episodePath[1]==='2'&&/^sample-00[5-9]\.ts$/.test(file))await new Promise(resolve=>setTimeout(resolve,heldSegmentDelay));}
  if(!/^sample(?:-\d+\.ts|\.m3u8)$/.test(file)){res.writeHead(404).end();return;}
  try{const bytes=await readFile(path.join(work,file));res.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Type':file.endsWith('.ts')?'video/mp2t':'application/vnd.apple.mpegurl'}).end(bytes);}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const mediaUrl=`http://127.0.0.1:${server.address().port}/sample.m3u8`;
const checks=[],errors=[];let instance,page;
function check(name,ok,detail){checks.push({name,ok,...detail===undefined?{}:{detail}});console.log(JSON.stringify(checks.at(-1)));if(!ok)process.exitCode=1;}
const hover=()=>page.locator('.video-stage').hover({position:{x:25,y:60}});
const nativeState=()=>instance.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{bounds:w.getNormalBounds(),always:w.isAlwaysOnTop()};});
try{
  instance=await electron.launch({...(installed||packaged?{executablePath:process.env.HG_QA_EXECUTABLE||path.join(installed?process.env.ProgramFiles:root,installed?'hongguo-desktop':'release/win-unpacked','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile-'+(installed?'installed':packaged?'packaged':'source')),HG_TEST_BACKGROUND:'1',TEMP:work,TMP:work},timeout:60000});
  page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));
  await instance.evaluate(({ipcMain},{url,holdWarm,total})=>{
    const series={id:'9999999999999997701',title:'审计测试剧',cover:'',intro:'本地 HLS',totalEpisodes:total,tags:[],actors:[]};
    const detail={series,episodes:Array.from({length:total},(_,i)=>({index:i+1,vid:String(99997700+i),title:`第 ${i+1} 集`,duration:30}))};
    let count=0;const sessions=new Map();
    globalThis.__audit={creates:[],held:[],hold:false,holdQuality:null,holdEpisode:holdWarm?2:null,trace:[]};
    ipcMain.removeHandler('playback:diagnostics');
    ipcMain.handle('playback:diagnostics',(_e,snapshot)=>{globalThis.__audit.trace=snapshot?.events||[];});
    const fixture=async(route,options={})=>{
      if(route==='/account/session')return{loggedIn:false,uid:'',nickname:'',avatar:'',mobile:''};
      if(route===`/catalog/series/${series.id}`)return detail;
      if(route.endsWith('/next-season'))return{seriesId:series.id,status:'none'};
      if(route.endsWith('/seasons'))return{seriesId:series.id,status:'single',currentSeason:1,seasons:[],complete:true};
      if(route.startsWith('/catalog/comments'))return{items:[],total:0,cursor:0,hasMore:false};
      if(route.startsWith('/catalog/danmaku'))return{items:[],start:0,end:30,hasMore:false,seriesId:series.id,vid:detail.episodes[0].vid,source:'mobile'};
      if(route.startsWith('/catalog/filters'))return{groups:[]};
      if(route.startsWith('/catalog/'))return{items:[series],hasMore:false,cursor:null};
      if(route.startsWith('/media/session')){
        if(options.method==='DELETE')return{};
        if(route==='/media/session'){
          globalThis.__audit.creates.push({episode:options.body.episode,start:options.body.start||0,quality:options.body.quality});
          if(globalThis.__audit.hold&&(options.body.start||0)>0||globalThis.__audit.holdQuality===options.body.quality||globalThis.__audit.holdEpisode===options.body.episode)await new Promise(resolve=>globalThis.__audit.held.push(resolve));
          const s={id:'audit-'+ ++count,phase:'complete',url:url.replace('/sample.m3u8',`/episode/${options.body.episode}/sample.m3u8`),duration:30};sessions.set(s.id,s);return s;
        }
        return sessions.get(route.split('/').at(-1));
      }
      if(route==='/media/cache/settings')return{};
      throw new Error('Unexpected local fixture route');
    };
    for(const channel of ['api:request','media:request'])ipcMain.removeHandler(channel);
    ipcMain.handle('api:request',(_e,route,options)=>fixture(route,options));
    ipcMain.handle('media:request',async(_e,route,options)=>({ok:true,data:await fixture(route,options)}));
  },{url:mediaUrl,holdWarm:scenario==='held-seek'&&heldWarm==='delayed',total:scenario==='held-seek'&&heldLast?2:10});
  await page.waitForSelector('.app-shell');
  await page.evaluate(({rate,autoplay})=>window.hongguo.saveSettings({rate,quality:'1080p',autoplay,volume:0,danmaku:{enabled:false}}),{rate:scenario==='held-seek'?heldRate:1,autoplay:scenario==='held-seek'});
  await page.reload();await page.waitForSelector('.app-shell');
  if(scenario==='held-seek'&&heldLateAbort)await page.evaluate(()=>{
    const original=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(...args){
      const promise=original.apply(this,args);
      if(this.dataset.active==='false'){
        const video=this;
        promise.catch(()=>{});
        return new Promise((_resolve,reject)=>{
          const pending=window.__heldAborts??=new Map();
          pending.set(video,{video,capturedAt:performance.now(),stack:String(new Error().stack).split('\n').slice(2,5).map(line=>line.replace(/(?:https?|file):\/\/[^\s)]*\/([^/\s)]+:\d+:\d+)/g,'[bundle]/$1')),deliver:()=>reject(new DOMException('Controlled late priming abort','AbortError'))});
        });
      }
      return promise;
    };
  });
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:160,y:100,width:1100,height:760}));
  await page.getByLabel('搜索剧名、演员或关键词').fill('审计测试剧');
  await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  await page.locator('.series-poster-button').first().click();
  await page.getByRole('dialog').getByRole('button',{name:'播放第 1 集',exact:true}).click();
  await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.videoWidth>0&&!v.paused&&v.currentTime>.2;},undefined,{timeout:20000});
  check('真实本地 HLS 解码起播',true);
  if(scenario==='held-seek'){
    if(![1,3].includes(heldRate))throw new Error('held-rate must be 1 or 3');
    if(heldWarm==='ready')await page.waitForFunction(rate=>{const v=document.querySelector('video[data-active=false]');return v?.dataset.episode==='2'&&v.videoWidth>0&&v.paused&&v.buffered.length&&v.buffered.end(0)-v.currentTime>=Math.max(4,rate*3);},heldRate,{timeout:10000});
    await page.evaluate(()=>{
      const state=()=>{const v=document.querySelector('video[data-active=true]');return{at:performance.now(),episode:Number(v?.dataset.episode),time:v?.currentTime,paused:v?.paused,ended:v?.ended,seeking:v?.seeking,pending:!!document.querySelector('.switch-status')};};
      const d=window.__heldSeek={events:[],frames:[],samples:[],commits:[],calls:[],pressed:false};
      const append=(list,value)=>{list.push(value);if(list.length>1000)list.shift();};
      for(const name of ['pause','play']){
        const original=HTMLMediaElement.prototype[name];
        HTMLMediaElement.prototype[name]=function(...args){append(d.calls,{...state(),name,slot:this.dataset.active,videoEpisode:Number(this.dataset.episode),videoTime:this.currentTime,stack:String(new Error().stack).split('\n').slice(2,5).map(line=>line.replace(/(?:https?|file):\/\/[^\s)]*\/([^/\s)]+:\d+:\d+)/g,'[bundle]/$1'))});return original.apply(this,args);};
      }
      for(const v of document.querySelectorAll('video')){
        for(const name of ['seeking','seeked','pause','playing','ended','waiting','emptied'])v.addEventListener(name,()=>append(d.events,{...state(),name,slot:v.dataset.active,videoEpisode:Number(v.dataset.episode),videoTime:v.currentTime}));
        const frame=(_at,m)=>{if(v.dataset.active==='true')append(d.frames,{at:performance.now(),episode:Number(v.dataset.episode),time:m.mediaTime});v.requestVideoFrameCallback(frame);};v.requestVideoFrameCallback(frame);
      }
      for(const name of ['keydown','keyup'])document.addEventListener(name,e=>{if(e.key==='ArrowRight'){d.pressed=name==='keydown';append(d.events,{...state(),name,repeat:e.repeat,target:e.target.tagName,type:e.target.type});}},true);
      let previous=1;
      d.timer=setInterval(()=>{const s=state();append(d.samples,s);if(s.episode!==previous){append(d.commits,{...s,pressed:d.pressed});previous=s.episode;}},20);
    });
    if(heldPaused){await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.paused);}
    // Start near the end to isolate the repeated seek / automatic-commit overlap.
    await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=v.duration-6;});
    await page.waitForFunction(()=>!document.querySelector('video[data-active=true]')?.seeking);
    if(heldWarm==='delayed')await instance.evaluate(()=>{setTimeout(()=>{globalThis.__audit.holdEpisode=null;globalThis.__audit.held.splice(0).forEach(resolve=>resolve());},1000);});
    const began=Date.now();let afterCommit=0,committed=false,count=0;
    try{
      while(Date.now()-began<6000){
        await page.keyboard.down('ArrowRight');count++;
        const episode=Number(await page.locator('video[data-active=true]').getAttribute('data-episode'));
        if(episode>=heldCrossings+1){committed=true;afterCommit++;if(afterCommit>=3)break;}
        if(heldPaused&&count>=12)break;
        await page.waitForTimeout(heldCadence);
      }
    }finally{await page.keyboard.up('ArrowRight');}
    if(heldStaleEnded){
      await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v&&!v.seeking&&!v.ended&&v.readyState>=2;});
      const delivered=await page.locator('video[data-active=true]').evaluate(v=>{const state={episode:Number(v.dataset.episode),time:v.currentTime,ended:v.ended};v.dispatchEvent(new Event('ended'));return state;});
      check('末集播放途中回放旧槽迟到 ended 事件',delivered.episode===2&&!delivered.ended&&delivered.time<29,delivered);
    }
    if(heldLateAbort){
      await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return window.__heldAborts?.has(v)&&!v.seeking&&v.readyState>=2;},undefined,{timeout:5000});
      const delivered=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),pending=window.__heldAborts?.get(v);if(!pending)return null;pending.deliver();return{capturedAt:pending.capturedAt,deliveredAt:performance.now(),episode:Number(v.dataset.episode),time:v.currentTime,stack:pending.stack};});
      check('注入的准备期 play AbortError 在该槽成为活动槽后迟到',!!delivered,delivered);
    }
    const release=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');window.__heldSeek.releaseAt=performance.now();return{episode:Number(v.dataset.episode),time:v.currentTime,paused:v.paused,pending:!!document.querySelector('.switch-status')};});
    await page.waitForTimeout(400);
    const release400=await page.locator('video[data-active=true]').evaluate(v=>({episode:Number(v.dataset.episode),time:v.currentTime,paused:v.paused,ended:v.ended,pending:!!document.querySelector('.switch-status')}));
    await page.waitForTimeout(1100);
    const evidence=await page.evaluate(()=>{const d=window.__heldSeek,v=document.querySelector('video[data-active=true]');clearInterval(d.timer);const frames=d.frames.filter(f=>f.at>d.releaseAt+300);return{events:d.events,frames:d.frames,samples:d.samples,commits:d.commits,calls:d.calls,after:{episode:Number(v.dataset.episode),time:v.currentTime,paused:v.paused,ended:v.ended,pending:!!document.querySelector('.switch-status'),width:v.videoWidth},decodedFrames:frames.length,decodedAdvance:frames.length?frames.at(-1).time-frames[0].time:0,repeats:d.events.filter(e=>e.name==='keydown'&&e.repeat).length};});
    await writeFile(path.join(work,label+'-held-seek.json'),JSON.stringify({rate:heldRate,warm:heldWarm,heldPaused,heldLast,heldLateAbort,heldStaleEnded,heldCrossings,cadence:heldCadence,count,committed,afterCommit,release,release400,...evidence},null,2));
    if(heldPaused)check(`${heldRate}倍速手动暂停后长按快进仍保持原集暂停`,evidence.after.episode===1&&evidence.after.paused&&!evidence.after.pending,{release,after:evidence.after,repeats:evidence.repeats});
    else{
      check(`${heldRate}倍速/${heldWarm}长按右键跨过提交后仍有重复键盘事件`,committed&&afterCommit>=3&&evidence.repeats>=3,{count,afterCommit,commits:evidence.commits,repeats:evidence.repeats});
      check(`${heldRate}倍速/${heldWarm}松开快进后继续解码且没有残留暂停`,!evidence.after.paused&&!evidence.after.ended&&!evidence.after.pending&&evidence.decodedFrames>=4&&evidence.decodedAdvance>.3,{release,release400,after:evidence.after,decodedFrames:evidence.decodedFrames,decodedAdvance:evidence.decodedAdvance});
    }
  }
  if(scenario==='takeover'){
    await instance.evaluate(()=>{globalThis.__audit.holdEpisode=4;});
    await page.getByRole('button',{name:'播放第3集',exact:true}).click();
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.dataset.episode==='3'&&v.currentTime>.2&&!v.paused&&!document.querySelector('.switch-status');});
    await page.getByRole('checkbox',{name:'自动连播'}).click();await page.waitForFunction(()=>document.querySelector('.autoplay-switch input')?.checked);
    await page.locator('video[data-active=true]').evaluate(v=>{v.currentTime=v.duration-.15;});
    await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.ended&&document.querySelector('.switch-status')?.textContent.includes('4'),undefined,{timeout:5000});
    await page.getByRole('button',{name:'播放第4集',exact:true}).click();
    await instance.evaluate(()=>{globalThis.__audit.holdEpisode=null;globalThis.__audit.held.splice(0).forEach(resolve=>resolve());});
    await page.waitForTimeout(1500);
    const state=await page.locator('video[data-active=true]').evaluate(v=>({episode:v.dataset.episode,time:v.currentTime,paused:v.paused,pending:!!document.querySelector('.switch-status')}));
    check('自动切集等待时手动点同一集能接管并起播',state.episode==='4'&&state.time>.2&&!state.paused&&!state.pending,state);
  }
  if(scenario==='quality'){
    await instance.evaluate(()=>{globalThis.__audit.holdQuality='720p';globalThis.__audit.creates=[];});
    await page.locator('video[data-active=true]').evaluate(v=>window.__beforeQualityVideo=v);
    await hover();await page.getByLabel('播放画质',{exact:true}).selectOption('720p');
    await page.waitForFunction(()=>!!document.querySelector('.switch-status'));
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(async()=> (await window.hongguo.getSettings()).volume===.05);
    // Settings updates are asynchronous; allow the new effect to run before releasing transport.
    await page.waitForTimeout(200);
    await instance.evaluate(()=>{globalThis.__audit.holdQuality=null;globalThis.__audit.held.splice(0).forEach(resolve=>resolve());});
    await page.waitForTimeout(1500);
    const state=await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]');return{replaced:v!==window.__beforeQualityVideo,quality:document.querySelector('[aria-label="播放画质"]').value,playing:!v.paused,time:v.currentTime,volume:v.volume,pending:!!document.querySelector('.switch-status')};});
    check('换画质准备期间调音量不会取消并丢失画质切换',state.replaced&&state.quality==='720p'&&state.playing&&state.volume===.05&&!state.pending,state);
  }
  if(scenario==='all'||scenario==='pip'){
    const before=await nativeState();
    await hover();await page.getByTitle('画中画置顶小窗',{exact:true}).click();
    await page.waitForSelector('.player-pip');await hover();
    const controlBounds=await page.locator('.player-controls').evaluate(panel=>{
      const bounds=panel.getBoundingClientRect();
      return [...panel.querySelectorAll('button,select,input')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>{const r=e.getBoundingClientRect();return{label:e.getAttribute('title')||e.getAttribute('aria-label'),left:r.left,right:r.right,visible:r.left>=Math.max(0,bounds.left)-1&&r.right<=Math.min(innerWidth,bounds.right)+1&&r.top>=0&&r.bottom<=innerHeight};});
    });
    check('小窗可见控件均位于窗口内',controlBounds.every(c=>c.visible),controlBounds.filter(c=>!c.visible));
    await page.screenshot({path:path.join(work,label+'-pip.png')});
    await page.keyboard.press('Escape');await page.waitForTimeout(250);
    const after=await nativeState();
    check('Esc 退出小窗恢复窗口且解除置顶',!after.always&&after.bounds.width===before.bounds.width&&after.bounds.height===before.bounds.height,{before,after});
    check('从普通模式进入小窗后恢复普通模式',await page.locator('.player-theater').count()===0);
    // Recover the old implementation's stale PiP state so the following scenarios remain independent.
    await page.evaluate(()=>window.hongguo.window('exitpip'));
    if(await page.locator('.player-pip').count()){
      await page.locator('button[title="退出置顶小窗"]').evaluate(button=>button.click());
      await page.waitForTimeout(100);
    }
    if(await page.locator('.player-theater').count())await page.keyboard.press('t');
    await page.keyboard.press('t');await page.waitForSelector('.player-theater');
    await hover();await page.getByTitle('画中画置顶小窗',{exact:true}).click();await page.waitForSelector('.player-pip');
    await page.keyboard.press('t');await page.waitForTimeout(250);
    check('T 从小窗恢复进入前的剧场模式',!(await nativeState()).always&&await page.locator('.player-pip').count()===0&&await page.locator('.player-theater').count()===1);
    await page.evaluate(()=>window.hongguo.window('exitpip'));
  }
  if(scenario==='all'||scenario==='shortcuts'){
    if(await page.locator('.player-pip').count())await page.locator('button[title="退出置顶小窗"]').evaluate(button=>button.click());
    if(await page.locator('.player-theater').count())await page.keyboard.press('t');
    for(const key of ['n','j']){
      const from=Number(await page.locator('video[data-active=true]').getAttribute('data-episode'));
      await hover();await page.waitForSelector('.video-stage.controls-hidden');
      await page.evaluate(()=>{
        const stage=document.querySelector('.video-stage');window.__controlFlash=false;
        window.__controlWatcher?.disconnect();
        window.__controlWatcher=new MutationObserver(records=>{if(!stage.classList.contains('controls-hidden')||records.some(r=>!r.oldValue?.split(' ').includes('controls-hidden')))window.__controlFlash=true;});
        window.__controlWatcher.observe(stage,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
      });
      await page.keyboard.press(key);
      await page.waitForFunction(expected=>{const v=document.querySelector('video[data-active=true]');return Number(v?.dataset.episode)===expected&&v.videoWidth>0&&!v.paused&&v.currentTime>.3;},from+1,{timeout:10000});
      check(`${key.toUpperCase()} 切集真实解码且不弹控制栏`,await page.evaluate(()=>!window.__controlFlash));
    }
    if(!await page.getByRole('checkbox',{name:'自动连播'}).isChecked())await page.getByRole('checkbox',{name:'自动连播'}).click();
    await page.waitForFunction(()=>document.querySelector('.autoplay-switch input')?.checked);
    await page.getByRole('checkbox',{name:'自动连播'}).evaluate(input=>input.blur());
    await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.paused);
    const pausedEpisode=await page.locator('video[data-active=true]').getAttribute('data-episode');
    await page.keyboard.press(']');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.playbackRate===1.25);
    await page.keyboard.press('[');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.playbackRate===1);
    check('方括号倍速快捷键改变实际解码器倍速且保持暂停',await page.locator('video[data-active=true]').evaluate(v=>v.paused&&v.playbackRate===1));
    await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.volume===.05);
    await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.volume===0);
    await page.keyboard.press('m');await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.muted);
    await page.keyboard.press('m');await page.waitForFunction(()=>!document.querySelector('video[data-active=true]')?.muted);
    check('上下方向键与 M 改变实际音量/静音，暂停状态保持',await page.locator('video[data-active=true]').evaluate(v=>v.paused&&v.volume===0&&!v.muted));
    await page.keyboard.press('d');await page.waitForFunction(()=>document.querySelector('[aria-label="关闭弹幕"]')?.getAttribute('aria-pressed')==='true');
    await page.keyboard.press('d');await page.waitForFunction(()=>document.querySelector('[aria-label="开启弹幕"]')?.getAttribute('aria-pressed')==='false');
    check('D 弹幕开关可往返切换',true);
    await page.keyboard.press('9');await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.paused&&!v.seeking&&Math.abs(v.currentTime-27)<.2&&!document.querySelector('.switch-status');},undefined,{timeout:10000});
    await page.keyboard.press('0');await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.paused&&!v.seeking&&v.currentTime<.2&&!document.querySelector('.switch-status');},undefined,{timeout:10000});
    check('数字 9/0 定位到 90%/0% 并保持暂停',true);
    await hover();
    const tailSlider=page.getByLabel('播放进度',{exact:true}),tailBounds=await tailSlider.boundingBox();
    await tailSlider.click({position:{x:tailBounds.width-1,y:tailBounds.height/2}});
    await page.screenshot({path:path.join(work,label+'-seek.png')});
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=true]');return v?.paused&&!v.seeking&&v.currentTime>v.duration-.4&&!document.querySelector('.switch-status');},undefined,{timeout:10000});
    await page.waitForTimeout(850);
    check('手动暂停后定位片尾不会自动切集',await page.locator('video[data-active=true]').getAttribute('data-episode')===pausedEpisode&&await page.locator('video[data-active=true]').evaluate(v=>v.paused));
    await page.keyboard.press('Space');
    await page.waitForFunction(expected=>{const v=document.querySelector('video[data-active=true]');return Number(v?.dataset.episode)===expected&&!v.paused&&v.currentTime>.25;},Number(pausedEpisode)+1,{timeout:10000});
    check('片尾恢复播放后只自动切下一集一次',true);
  }
  if(scenario==='all'||scenario==='completion'){
    await page.evaluate(()=>window.hongguo.window('exitpip'));
    if(await page.locator('.player-pip').count())await page.locator('button[title="退出置顶小窗"]').evaluate(button=>button.click());
    if(await page.locator('.player-theater').count())await page.keyboard.press('t');
    if(await page.locator('video[data-active=true]').getAttribute('data-episode')!=='1'){
      await page.getByRole('button',{name:'播放第1集',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('video[data-active=true]')?.dataset.episode==='1');
    }
    if(!await page.getByRole('checkbox',{name:'自动连播'}).isChecked())await page.getByRole('checkbox',{name:'自动连播'}).click();
    await page.waitForFunction(()=>document.querySelector('.autoplay-switch input')?.checked);
    await page.waitForFunction(()=>{const v=document.querySelector('video[data-active=false]');return v?.dataset.episode==='2'&&v.videoWidth>0&&v.readyState>=2&&!document.querySelector('.switch-status');},undefined,{timeout:10000});
    await instance.evaluate(()=>{globalThis.__audit.hold=true;globalThis.__audit.creates=[];});
    await page.locator('video[data-active=true]').evaluate((v,delayedEnded)=>{
      window.__originalAuditVideo=v;
      v.addEventListener('ended',event=>{
        // A late ended delivery can overlap a replay/seek preparation. Hold only the new session.
        event.stopImmediatePropagation();
        Object.defineProperty(v,'seekable',{configurable:true,get:()=>({length:0})});
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
        if(delayedEnded)setTimeout(()=>v.dispatchEvent(new Event('ended')),100);
      },{once:true,capture:true});
      v.currentTime=v.duration-.15;void v.play();
    },process.argv.includes('--delayed-ended'));
    await page.waitForFunction(()=>window.__originalAuditVideo.ended,undefined,{timeout:5000});
    await page.waitForTimeout(900);
    const requests=await instance.evaluate(()=>globalThis.__audit.creates);
    const activeEpisode=await page.locator('video[data-active=true]').getAttribute('data-episode');
    check('片尾后准备快退时不被完成兜底抢成下一集',requests.some(r=>r.episode===1&&r.start>0)&&!requests.some(r=>r.episode!==1)&&activeEpisode==='1',{requests,activeEpisode});
    await instance.evaluate(()=>{globalThis.__audit.hold=false;globalThis.__audit.held.splice(0).forEach(resolve=>resolve());});
    await page.waitForTimeout(1800);
    const resumed=await page.locator('video[data-active=true]').evaluate(v=>({episode:v.dataset.episode,time:v.currentTime,paused:v.paused,ended:v.ended,pending:!!document.querySelector('.switch-status')}));
    check('快退准备完成后仍播放原集',resumed.episode==='1'&&resumed.time>=20&&!resumed.ended&&!resumed.paused,resumed);
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('app:flush'));
    await page.waitForTimeout(100);
    await writeFile(path.join(work,label+'-trace.json'),JSON.stringify(await instance.evaluate(()=>globalThis.__audit.trace),null,2));
  }
  check('无渲染异常',errors.length===0,errors);
  check('隔离后台实例保持静音',await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(w=>w.isAudioMuted())));
}catch(error){check('执行回归',false,{errorType:error.name,message:String(error.message).slice(0,300),state:page?await page.evaluate(()=>{const v=document.querySelector('video[data-active=true]'),input=document.querySelector('input[aria-label=播放进度]');return{episode:v?.dataset.episode,time:v?.currentTime,paused:v?.paused,ended:v?.ended,pending:!!document.querySelector('.switch-status'),slider:input?{value:input.value,max:input.max,disabled:input.disabled}:null,error:document.querySelector('.player-error p')?.textContent};}).catch(()=>null):null});}
finally{
  if(instance){
    await instance.evaluate(()=>globalThis.__audit?.held.splice(0).forEach(resolve=>resolve())).catch(()=>{});
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.webContents.send('app:flush')).catch(()=>{});
    if(page)await page.waitForTimeout(100).catch(()=>{});
    await writeFile(path.join(work,label+'-trace.json'),JSON.stringify(await instance.evaluate(()=>globalThis.__audit?.trace||[]).catch(()=>[]),null,2));
    await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});
  }
  await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(work,label+'.json'),JSON.stringify({checks,errors},null,2));
  if(checks.some(c=>!c.ok))process.exitCode=1;
}
