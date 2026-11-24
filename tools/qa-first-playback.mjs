// Real cold entry through the catalog/detail/player. No retry may count as a pass.
// Account material stays in an owned, disposable profile; records contain no URLs or credentials.
import {quietElectron as electron} from './quiet-electron.mjs';
import {copyFile,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=fileURLToPath(new URL('..',import.meta.url));
const installed=process.argv.includes('--installed'),packaged=process.argv.includes('--packaged'),diagnoseRetry=process.argv.includes('--diagnose-retry');
const fixtures=[
  {key:'brew-3d',query:'我在古代造酒',title:'我在古代造酒竟成了国师3D版',episode:1},
  {key:'fortune',query:'无敌财神',title:'无敌财神！我觉醒了唯一隐藏职业',episode:54},
  {key:'fairy-175',query:'我家仙妻不太正经第四季',title:'我家仙妻不太正经第四季',episode:175},
  {key:'brew-128',query:'我在古代造酒',title:'我在古代造酒竟成了国师3D版',episode:128},
];
const selected=process.argv.includes('--all')?fixtures:process.argv.includes('--pair')?[fixtures[0],fixtures[2]]:[fixtures.find(f=>f.key===process.argv.find(a=>a.startsWith('--fixture='))?.split('=')[1])||fixtures[0]];
const out=path.join(root,'_work','first-playback',installed?'installed':packaged?'packaged':'source');
const profile=path.join(out,'profile'),owner=path.join(profile,'qa-owner.json');
const ownerKind='first-playback-qa';
await mkdir(out,{recursive:true});
async function clearProfile(){
  const info=await lstat(profile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!info)return;
  const [resolved,resolvedOut,marker]=await Promise.all([realpath(profile),realpath(out),lstat(owner).catch(()=>null)]);
  if(info.isSymbolicLink()||!info.isDirectory()||path.dirname(resolved)!==resolvedOut||path.basename(resolved)!=='profile'||!marker?.isFile()||marker.isSymbolicLink()||marker.size>256)throw new Error('Unverified QA profile');
  if(JSON.parse(await readFile(owner,'utf8')).kind!==ownerKind)throw new Error('QA owner mismatch');
  await rm(resolved,{recursive:true,force:true});
}
await clearProfile();
await mkdir(profile,{recursive:true});
await writeFile(owner,JSON.stringify({kind:ownerKind}));
for(const name of ['account-session.dpapi','desktop-device.json','web-session.dpapi']){
  const source=path.join(process.env.APPDATA,'红果桌面',name);
  if(existsSync(source))await copyFile(source,path.join(profile,name));
}
const executable=packaged?path.join(root,'release','win-unpacked','红果桌面.exe'):[process.env.HG_QA_EXECUTABLE,path.join(process.env.ProgramFiles,'hongguo-desktop','红果桌面.exe'),path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe')].find(p=>p&&existsSync(p));
let instance,page,stage='launch';
const checks=[],outcomes=[],pageErrors=[],resources=[];
const state=expectedSeries=>page.evaluate(expectedSeries=>{
  const v=document.querySelector('video[data-active=true]'),text=document.querySelector('.player-error p')?.textContent||'';
  return {error:!!text,resourceNotFound:text.includes('请求的资源不存在或参数不正确'),seriesMatches:v?.dataset.seriesId===expectedSeries,time:v?.currentTime||0,width:v?.videoWidth||0,height:v?.videoHeight||0,paused:v?.paused??true,ready:v?.readyState||0,episode:Number(v?.dataset.episode)||0};
},expectedSeries);
async function waitPlayback(episode,series){
  await page.waitForFunction(({episode,series})=>{
    const v=document.querySelector('video[data-active=true]');
    return !!document.querySelector('.player-error')||!!v&&v.dataset.seriesId===series&&Number(v.dataset.episode)===episode&&v.videoWidth>0&&v.currentTime>1&&!v.paused;
  },{episode,series},{timeout:90000});
  const first=await state(series);
  if(first.error)return {...first,decodedAdvance:0,frameCount:0};
  const frames=await page.locator('video[data-active=true]').evaluate(v=>new Promise(resolve=>{
    let frames=0,firstTime;
    const timer=setTimeout(()=>resolve({frames,advance:0}),2500);
    const sample=(_now,metadata)=>{
      frames++;firstTime??=metadata.mediaTime;
      if(metadata.mediaTime-firstTime>=.5){clearTimeout(timer);resolve({frames,advance:metadata.mediaTime-firstTime});}
      else v.requestVideoFrameCallback(sample);
    };
    v.requestVideoFrameCallback(sample);
  }));
  return {...await state(series),decodedAdvance:frames.advance,frameCount:frames.frames};
}
try{
  instance=await electron.launch({...(installed||packaged?{executablePath:executable,args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
  page=await instance.firstWindow();
  stage='shell';
  page.on('pageerror',error=>pageErrors.push(error.name));
  page.on('response',response=>{
    const pathname=new URL(response.url()).pathname;
    if(/^\/media\/session\//.test(pathname))resources.push({kind:pathname.endsWith('.m3u8')?'manifest':pathname.endsWith('init.mp4')?'init':'segment',status:response.status()});
  });
  await page.waitForSelector('.app-shell',{timeout:60000});
  await page.evaluate(()=>window.hongguo.saveSettings({quality:'1080p',rate:1,volume:0,autoplay:false,danmaku:{enabled:false}}));
  await instance.evaluate(({ipcMain})=>{
    globalThis.__firstPlaybackIpc=[];
    const aliases=new Map();
    const alias=id=>{if(!id)return undefined;if(!aliases.has(id))aliases.set(id,aliases.size+1);return aliases.get(id);};
    for(const channel of ['api:request','media:request']){
      const original=ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel,async(event,route,options)=>{
        if(!String(route).startsWith('/media/session'))return original(event,route,options);
        const started=Date.now(),method=options?.method||'GET';
        const record={channel,method,kind:route==='/media/session'?'create':'session',episode:options?.body?.episode,start:options?.body?.start,forceNew:!!options?.body?.forceNew,leaseSequence:route==='/media/session'?undefined:alias(route.split('/').at(-1))};
        try{
          const result=await original(event,route,options);
          const data=channel==='media:request'?result.data:result;
          Object.assign(record,{ok:channel==='media:request'?result.ok:true,phase:data?.phase,status:result.error?.status,code:result.error?.code,durationMs:Date.now()-started,...(data?.id?{leaseSequence:alias(data.id)}:{})});
          globalThis.__firstPlaybackIpc.push(record);return result;
        }catch(error){globalThis.__firstPlaybackIpc.push({...record,ok:false,errorType:error.name,durationMs:Date.now()-started});throw error;}
      });
    }
  });
  for(const fixture of selected){
    stage='search';
    const search=page.getByLabel('搜索剧名、演员或关键词');
    await search.fill(fixture.query);await search.press('Enter');
    const card=page.locator('.series-card').filter({hasText:fixture.title}).first();
    await card.waitFor({timeout:60000});const expectedSeries=await card.getAttribute('data-series-id');
    await card.locator('.series-poster-button').click();
    stage='detail';
    const dialog=page.getByRole('dialog');
    if(fixture.episode>120){const more=dialog.getByRole('button',{name:'显示更多集数'});await more.click({timeout:60000});}
    if(process.argv.includes('--warm-details'))await page.waitForTimeout(500);
    await dialog.getByRole('button',{name:`播放第 ${fixture.episode} 集`,exact:true}).click({timeout:90000});
    stage='decode';
    const since=Date.now(),initial=await waitPlayback(fixture.episode,expectedSeries);
    const ok=!initial.error&&initial.seriesMatches&&initial.episode===fixture.episode&&initial.frameCount>=2&&initial.decodedAdvance>=.5;
    const outcome={fixture:fixture.key,episode:fixture.episode,initial,firstPlaybackMs:Date.now()-since};
    outcomes.push(outcome);checks.push({name:`${fixture.key}: first entry without retry`,ok,resourceNotFound:initial.resourceNotFound});
    console.log(JSON.stringify(checks.at(-1)));
    await page.screenshot({path:path.join(out,fixture.key+'-first.png')});
    if(!ok){
      process.exitCode=1;
      if(diagnoseRetry&&initial.error){
        await page.waitForTimeout(2500);
        await page.getByRole('button',{name:'重试当前集',exact:true}).click();
        outcome.afterSingleManualRetry=await waitPlayback(fixture.episode,expectedSeries);
        console.log(JSON.stringify({fixture:fixture.key,manualRetryDecoded:outcome.afterSingleManualRetry.decodedAdvance>=.5}));
        await page.screenshot({path:path.join(out,fixture.key+'-retry.png')});
      }
      break;
    }
    await page.locator('video[data-active=true]').evaluate(v=>v.pause());
  }
  checks.push({name:'isolated hidden silent app',ok:await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(w=>w.isAudioMuted()))});
  checks.push({name:'no page exceptions',ok:pageErrors.length===0});
  if(checks.some(c=>!c.ok))process.exitCode=1;
}catch(error){checks.push({name:'first playback harness',ok:false,errorType:error.name,stage});if(page)await page.screenshot({path:path.join(out,'harness-failure.png')}).catch(()=>{});console.error('First playback QA failed at '+stage+'; inspect result.json');process.exitCode=1;}
finally{
  const requests=instance?await instance.evaluate(()=>globalThis.__firstPlaybackIpc||[]).catch(()=>[]):[];
  const version=instance?await instance.evaluate(({app})=>app.getVersion()).catch(()=>null):null;
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  await writeFile(path.join(out,'result.json'),JSON.stringify({version,installed,packaged,isolatedProfile:true,manualRetryAllowedOnlyForDiagnosis:diagnoseRetry,checks,outcomes,requests,resources,pageErrorCount:pageErrors.length},null,2));
  await clearProfile();
}
