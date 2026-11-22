// Real main/preload/IPC/sink with an isolated offline Supervisor. No production profile is opened.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {cp,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const root=path.resolve(process.cwd()),out=path.join(root,'_work','playback-diagnostics-qa');
const fixture=path.join(out,'fixture'),profile=path.join(fixture,'profile'),owner=path.join(fixture,'qa-owner.json');
const exportFile=path.join(out,'export.jsonl'),checks=[],errors=[];
await mkdir(out,{recursive:true});
if(path.relative(out,fixture)!=='fixture')throw new Error('QA fixture escapes its workspace');
const previous=await lstat(fixture).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(previous){
  const resolved=await realpath(fixture),resolvedOut=await realpath(out),marker=await lstat(owner).catch(()=>null);
  if(previous.isSymbolicLink()||path.dirname(resolved)!==resolvedOut||!marker?.isFile()||marker.isSymbolicLink()||marker.size>256)throw new Error('QA fixture is not a verified owned directory');
  if(JSON.parse(await readFile(owner,'utf8')).kind!=='playback-diagnostics-qa')throw new Error('QA owner marker mismatch');
  await rm(resolved,{recursive:true,force:true});
}
await mkdir(fixture,{recursive:true});
await writeFile(owner,JSON.stringify({kind:'playback-diagnostics-qa'}));
await cp(path.join(root,'dist'),path.join(fixture,'dist'),{recursive:true});
await cp(path.join(root,'assets'),path.join(fixture,'assets'),{recursive:true});
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
await writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'playback-diagnostics-qa',version,main:'main.cjs'}));
const mock=[
  "import fs from 'node:fs/promises';import path from 'node:path';",
  "export class Supervisor {",
  "constructor(_root,_runtime,data){this.data=data;globalThis.__diagnosticsQa={mediaRequests:0,progressWrites:0};}",
  "async start(){} async stop(){}",
  "async diagnostics(){const file=path.join(this.data,'service-fixture.jsonl');await fs.writeFile(file,JSON.stringify({kind:'service_fixture',ok:true})+String.fromCharCode(10),'utf8');return file;}",
  "async request(route){",
  "if(route==='/account/session')return{loggedIn:false,uid:'local',nickname:'',avatar:'',mobile:''};",
  "if(route==='/account/progress'){globalThis.__diagnosticsQa.progressWrites++;throw new Error('Unexpected progress write');}",
  "if(route.startsWith('/media/')){globalThis.__diagnosticsQa.mediaRequests++;throw new Error('Unexpected media request');}",
  "if(route.startsWith('/catalog/'))return{items:[],hasMore:false,cursor:''};",
  "if(route==='/health')return{ok:true,signer:true};return{};}",
  "}",
].join(String.fromCharCode(10));
const plugin={name:'isolated-diagnostics-supervisor',setup(builder){
  builder.onResolve({filter:/^\.\/supervisor$/},()=>({path:'offline',namespace:'diagnostics-fixture'}));
  builder.onLoad({filter:/.*/,namespace:'diagnostics-fixture'},()=>({contents:mock,loader:'ts'}));
}};
await build({entryPoints:[path.join(root,'electron','main.ts')],outfile:path.join(fixture,'main.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],plugins:[plugin]});
await build({entryPoints:[path.join(root,'electron','preload.ts')],outfile:path.join(fixture,'preload.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron']});
const exec=promisify(execFile),powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const production=async()=>{const result=await exec(powershell,['-NoProfile','-NonInteractive','-Command','ConvertTo-Json -InputObject @(34216,38628 | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }) -Compress'],{windowsHide:true});return JSON.parse(result.stdout.trim());};
const before=await production();
let instance,page;
function check(name,ok,detail={}){checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);}
const rows=text=>text.split(String.fromCharCode(10)).map(line=>line.trim()).filter(Boolean).map(line=>JSON.parse(line));
const allowed=new Set(['v','type','sequence','elapsedMs','stage','action','reason','observer','receivedAtMs','occurredAtMs','traceGeneration','bootStartedAtMs','contextGeneration','deckSlot','episode','jobGeneration','leaseGeneration','intentGeneration','httpStatus','attempt','currentTime','duration','bufferedAhead','sourceDuration','bufferedEnd','decodedTime','decodedFrameAgeMs','volume','muted','transportPending','reconnecting','readyState','networkState','mediaErrorCode','playbackRate','active','paused','ended','seeking','sealed','prewarm']);
const event=(sequence,action)=>({v:1,type:'playback_event',sequence,elapsedMs:sequence,occurredAtMs:1700000000000+sequence,traceGeneration:7,bootStartedAtMs:1,contextGeneration:999,stage:'recovery',action,reason:action==='error'?'transport-failed':'healthy',deckSlot:0,episode:126,jobGeneration:1,leaseGeneration:1,httpStatus:503,currentTime:59,paused:false,ended:false,sealed:false});
try{
  instance=await electron.launch({args:[fixture],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:30000});
  page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));await page.waitForSelector('.app-shell',{timeout:15000});
  const metadata=await instance.evaluate(({app,BrowserWindow,webContents})=>({data:app.getPath('userData'),hidden:BrowserWindow.getAllWindows().every(window=>!window.isVisible()),muted:webContents.getAllWebContents().every(contents=>contents.isAudioMuted()),offlineSupervisor:!!globalThis.__diagnosticsQa}));
  check('真实隔离 main/preload 已连接且测试隐藏静音',path.resolve(metadata.data)===path.resolve(profile)&&metadata.hidden&&metadata.muted&&metadata.offlineSupervisor&&await page.evaluate(()=>typeof window.hongguo.recordPlaybackDiagnostics==='function'),{schemaVersion:1,offlineSupervisor:true});
  // The reserved failure slot need not duplicate its snapshot into a full normal ledger.
  await page.evaluate(value=>window.hongguo.recordPlaybackDiagnostics(value),{v:1,events:[event(100,'playing')]});
  const marker='TRACE_RAW_FIELD_MUST_NOT_PERSIST';
  const fault={v:1,events:[event(101,'reconnect'),{...event(102,'error'),observer:'main',receivedAtMs:1,token:marker,sessionId:marker,uid:marker,headers:{Authorization:marker},message:marker,url:'https://fixture.invalid/?token='+marker}],token:marker};
  await page.evaluate(value=>window.hongguo.recordPlaybackDiagnostics(value),fault);
  const recentPath=path.join(profile,'playback-diagnostics.jsonl'),failurePath=path.join(profile,'playback-diagnostics.last-error.jsonl');
  const failureBefore=await readFile(failurePath,'utf8'),recentBefore=await readFile(recentPath,'utf8'),failureRows=rows(failureBefore);
  check('故障 snapshot 经真实 IPC 落到固定 last-error 槽',failureRows.length===2&&failureRows.at(-1).action==='error',{events:failureRows.length});
  check('raw extra 字段没有落盘',!recentBefore.includes(marker)&&!failureBefore.includes(marker)&&failureRows.every(row=>Object.keys(row).every(key=>allowed.has(key))),{projected:true});
  check('observer 与 receivedAtMs 由主进程强制生成',failureRows.every(row=>row.observer==='renderer'&&typeof row.receivedAtMs==='number'&&row.receivedAtMs>1),{observerForced:true,timeGenerated:true});
  check('renderer 发生时间与 trace 世代保留，启动与上下文世代由 Main 生成',failureRows.every(row=>row.occurredAtMs===1700000000000+row.sequence&&row.traceGeneration===7&&typeof row.bootStartedAtMs==='number'&&row.bootStartedAtMs>1&&typeof row.contextGeneration==='number'&&row.contextGeneration!==999)&&failureRows.every(row=>row.bootStartedAtMs===failureRows[0].bootStartedAtMs&&row.contextGeneration===failureRows[0].contextGeneration),{occurrencePreserved:true,traceGenerationPreserved:true,bootGenerated:true,contextGenerated:true});
  await page.evaluate(value=>window.hongguo.recordPlaybackDiagnostics(value),{v:1,events:[event(102,'error'),event(103,'recovered')]});
  const failureAfter=await readFile(failurePath,'utf8'),recentAfter=await readFile(recentPath,'utf8');
  check('正常恢复 snapshot 不能覆盖最后故障槽',failureAfter===failureBefore&&rows(recentAfter).at(-1).action==='recovered',{failurePreserved:true});
  await page.evaluate(value=>window.hongguo.recordPlaybackDiagnostics(value),{v:1,events:[{...event(104,'error'),stage:'https://fixture.invalid/?token='+marker}]});
  check('非法 required enum 不写入诊断',await readFile(recentPath,'utf8')===recentAfter&&await readFile(failurePath,'utf8')===failureBefore,{rejected:true});
  await instance.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportFile);
  const exported=await page.evaluate(()=>window.hongguo.exportDiagnostics());
  const exportedText=await readFile(exportFile,'utf8'),exportedRows=rows(exportedText),exportedEvents=exportedRows.filter(row=>row.type==='playback_event');
  check('诊断导出包括 recent 与 lastFailure，保存对话框隔离',path.resolve(exported)===path.resolve(exportFile)&&exportedEvents.length===rows(recentAfter).length+failureRows.length&&exportedRows.some(row=>row.kind==='service_fixture')&&exportedEvents.some(row=>row.action==='error')&&exportedEvents.some(row=>row.action==='recovered')&&!exportedText.includes(marker),{events:exportedEvents.length,hasRecent:true,hasFailure:true});
  const requests=await instance.evaluate(()=>globalThis.__diagnosticsQa);
  check('没有媒体请求、真实账号或进度写入',requests.mediaRequests===0&&requests.progressWrites===0,{mediaRequests:requests.mediaRequests,progressWrites:requests.progressWrites});
  check('隔离 E2E 无页面异常',errors.length===0,{pageErrors:errors.length});
}catch(error){checks.push({name:'隔离 diagnostics E2E 失败',ok:false,errorType:error?.name||'Error'});console.error('diagnostics E2E failed; inspect boolean checks');process.exitCode=1;}
finally{
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  const after=await production(),productionUnchanged=before.length===2&&before.every(pid=>after.includes(pid));
  checks.push({name:'生产应用与服务进程保持存活',ok:productionUnchanged,detail:{beforeCount:before.length,afterCount:after.length}});
  if(!productionUnchanged)process.exitCode=1;
  await writeFile(path.join(out,'result.json'),JSON.stringify({checks,pageErrorCount:errors.length,productionUnchanged,isolatedProfile:true,realNetwork:false},null,2));
}
