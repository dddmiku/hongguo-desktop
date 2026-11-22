// Real Supervisor.fetch -> Main -> preload -> structured-clone -> renderer error recovery.
// All HTTP is fixture-local; no production profile, credentials, playback or cloud writes.
import {quietElectron as electron} from './quiet-electron.mjs';
import {build} from 'esbuild';
import {cp,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const root=path.resolve(process.cwd()),out=path.join(root,'_work','media-request-ipc-qa');
const fixture=path.join(out,'fixture'),profile=path.join(fixture,'profile'),owner=path.join(fixture,'qa-owner.json');
const checks=[],errors=[];
await mkdir(out,{recursive:true});
if(path.relative(out,fixture)!=='fixture')throw new Error('QA fixture escapes its workspace');
const previous=await lstat(fixture).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(previous){
  const resolved=await realpath(fixture),resolvedOut=await realpath(out),marker=await lstat(owner).catch(()=>null);
  if(previous.isSymbolicLink()||path.dirname(resolved)!==resolvedOut||!marker?.isFile()||marker.isSymbolicLink()||marker.size>256)throw new Error('QA fixture is not a verified owned directory');
  if(JSON.parse(await readFile(owner,'utf8')).kind!=='media-request-ipc-qa')throw new Error('QA owner marker mismatch');
  await rm(resolved,{recursive:true,force:true});
}
await mkdir(fixture,{recursive:true});
await writeFile(owner,JSON.stringify({kind:'media-request-ipc-qa'}));
await cp(path.join(root,'dist'),path.join(fixture,'dist'),{recursive:true});
await cp(path.join(root,'assets'),path.join(fixture,'assets'),{recursive:true});
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
await writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'media-request-ipc-qa',version,main:'main.cjs'}));
await writeFile(path.join(fixture,'foreign.html'),'<!doctype html><meta charset="utf-8"><title>Isolated sender fixture</title>');
const supervisorPath=path.join(root,'electron','supervisor.ts');
const wrapper=[
  "import {createServer} from 'node:http';",
  'import {Supervisor as ActualSupervisor} from '+JSON.stringify(supervisorPath)+';',
  "export class Supervisor extends ActualSupervisor {",
  "constructor(...args){super(...args);this.fixtureServer=undefined;this.fixtureReady=undefined;globalThis.__mediaIpcQa={mediaInvocations:0,mediaRequests:0,progressWrites:0,nonLoopback:0,onlyLocal:true};}",
  "async request(route,options){if(route.startsWith('/media/session'))globalThis.__mediaIpcQa.mediaInvocations++;return super.request(route,options);}",
  "async start(){if(this.fixtureReady)return this.fixtureReady;this.fixtureReady=(async()=>{",
  "this.fixtureServer=createServer(async(request,response)=>{",
  "const state=globalThis.__mediaIpcQa;const route=request.url||'';if(request.socket.remoteAddress!=='127.0.0.1')state.nonLoopback++;",
  "if(route.startsWith('/media/'))state.mediaRequests++;if(route==='/account/progress')state.progressWrites++;",
  "let body='';for await(const chunk of request)body+=chunk.toString();let decoded;try{decoded=JSON.parse(body);}catch{}",
  "const json=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};",
  "if(route==='/account/session')return json(200,{loggedIn:false,uid:'local',nickname:'',avatar:'',mobile:''});",
  "if(route.startsWith('/catalog/'))return json(200,{items:[],hasMore:false,cursor:''});",
  "if(route==='/health')return json(200,{ok:true,signer:true});",
  "if(route==='/media/session/test-503')return json(503,{error:{code:'TEST_HTTP_503',message:'Temporary failure https://fixture.invalid/path?token=IPC_RAW_FIELD_MUST_NOT_PERSIST Bearer IPC_RAW_FIELD_MUST_NOT_PERSIST'}});",
  "if(route==='/media/session/test-403')return json(403,{error:{code:'TEST_DENIED',message:'Denied'}});",
  "if(route==='/media/session/quoted-503')return json(503,{error:{code:'TEST_HTTP_503',message:'Temporary failure '+JSON.stringify({Cookie:'qa_session=IPC_COOKIE_MUST_NOT_PERSIST',Authorization:'Bearer IPC_AUTH_MUST_NOT_PERSIST',api_key:'IPC_KEY_MUST_NOT_PERSIST'})}});",
  "if(route==='/media/session/html-200'||route==='/media/session/html-503'){response.writeHead(route.endsWith('503')?503:200,{'Content-Type':'text/html'});return response.end('<html>IPC_RAW_FIELD_MUST_NOT_PERSIST</html>');}",
  "if(route==='/media/session'&&request.method==='POST')return json(200,{id:'qa_post',phase:'ready',episode:decoded?.episode});",
  "if(route==='/media/session/valid'&&request.method==='DELETE')return json(200,{released:true});",
  "if(route.startsWith('/media/session/'))return json(200,{id:'qa_valid',phase:'ready'});",
  "return json(200,{});});",
  "await new Promise((resolve,reject)=>{this.fixtureServer.once('error',reject);this.fixtureServer.listen(0,'127.0.0.1',resolve);});",
  "this.port=this.fixtureServer.address().port;this.token='offline-fixture-only';})();return this.fixtureReady;}",
  "async stop(){if(!this.fixtureServer)return;this.fixtureServer.closeAllConnections();await new Promise(resolve=>this.fixtureServer.close(resolve));this.fixtureServer=undefined;}",
  "}",
].join(String.fromCharCode(10));
const plugin={name:'isolated-real-supervisor',setup(builder){
  builder.onResolve({filter:/^\.\/supervisor$/},()=>({path:'local-fixture',namespace:'media-ipc-fixture'}));
  builder.onLoad({filter:/.*/,namespace:'media-ipc-fixture'},()=>({contents:wrapper,loader:'ts',resolveDir:root}));
}};
await build({entryPoints:[path.join(root,'electron','main.ts')],outfile:path.join(fixture,'main.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron'],plugins:[plugin]});
await build({entryPoints:[path.join(root,'electron','preload.ts')],outfile:path.join(fixture,'preload.cjs'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['electron']});
await build({entryPoints:[path.join(root,'shared','media-request.ts')],outfile:path.join(fixture,'media-browser.js'),bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'MediaRequestQa'});
const exec=promisify(execFile),powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const production=async()=>{const result=await exec(powershell,['-NoProfile','-NonInteractive','-Command','ConvertTo-Json -InputObject @(34216,38628 | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }) -Compress'],{windowsHide:true});return JSON.parse(result.stdout.trim());};
const before=await production();
let instance,page,originalHandler,stage='launch';
function check(name,ok,detail={}){checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)process.exitCode=1;}
const count=()=>instance.evaluate(()=>globalThis.__mediaIpcQa.mediaRequests);
const invocations=()=>instance.evaluate(()=>globalThis.__mediaIpcQa.mediaInvocations);
try{
  instance=await electron.launch({args:[fixture],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:profile,HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:30000});
  stage='page-ready';page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));await page.waitForSelector('.app-shell',{timeout:15000});
  stage='inject-helper';
  stage='inject-cdp';const cdp=await instance.context().newCDPSession(page);await cdp.send('Page.setBypassCSP',{enabled:true});
  // CSP bypass must precede navigation. Reload only this isolated empty fixture.
  await page.reload();await page.waitForSelector('.app-shell',{timeout:15000});
  stage='inject-script';
  await page.addScriptTag({path:path.join(fixture,'media-browser.js')});
  stage='checks';
  const metadata=await instance.evaluate(({app,BrowserWindow,webContents})=>({data:app.getPath('userData'),hidden:BrowserWindow.getAllWindows().every(window=>!window.isVisible()),muted:webContents.getAllWebContents().every(contents=>contents.isAudioMuted()),localFixture:!!globalThis.__mediaIpcQa}));
  check('真实隔离 main/preload/Supervisor 已连接且隐藏静音',path.resolve(metadata.data)===path.resolve(profile)&&metadata.hidden&&metadata.muted&&metadata.localFixture&&await page.evaluate(()=>typeof window.hongguo.mediaRequestResult==='function'),{isolatedProfile:true,realSupervisor:true});
  const failure=async route=>page.evaluate(async route=>{
    const api=globalThis.MediaRequestQa,wire=await window.hongguo.mediaRequestResult(route),cloned=JSON.parse(JSON.stringify(wire));
    let rich;try{api.unwrapMediaRequestResult(cloned);}catch(error){rich=error;}
    return {wireFailure:wire.ok===false,plain:!!cloned.error&&Object.getPrototypeOf(cloned.error)===Object.prototype,rich:rich instanceof api.MediaRequestError&&rich instanceof Error,kind:rich?.kind,status:rich?.status,retryable:rich?.retryable,code:rich?.code,helperRetry:api.isRetryableMediaRequestError(rich),safeMessage:typeof rich?.message==='string'&&rich.message.length<=400&&!/IPC_(?:RAW_FIELD|COOKIE|AUTH|KEY)_MUST_NOT_PERSIST/.test(rich.message)&&!rich.message.includes('fixture.invalid'),onlySchema:Object.keys(cloned.error||{}).every(key=>['kind','code','message','status','retryable'].includes(key))};
  },route);
  const temporary=await failure('/media/session/test-503');
  check('HTTP503 属性经真实 IPC 与 JSON clone 后恢复 RichError',temporary.wireFailure&&temporary.plain&&temporary.rich&&temporary.kind==='http'&&temporary.status===503&&temporary.retryable===true&&temporary.helperRetry===true&&temporary.code==='TEST_HTTP_503'&&temporary.safeMessage&&temporary.onlySchema,{status:503,retryable:true,richRecovered:true,messageSanitized:temporary.safeMessage});
  const denied=await failure('/media/session/test-403');
  check('HTTP403 真实 IPC 保留拒绝状态且禁止自动重连',denied.wireFailure&&denied.rich&&denied.status===403&&denied.retryable===false&&denied.helperRetry===false&&denied.code==='TEST_DENIED',{status:403,retryable:false});
  const quoted=await failure('/media/session/quoted-503');
  check('quoted Cookie header 与 key 经真实 IPC 脱敏',quoted.wireFailure&&quoted.rich&&quoted.status===503&&quoted.safeMessage&&quoted.onlySchema,{status:503,messageSanitized:quoted.safeMessage});
  const htmlSuccess=await failure('/media/session/html-200');
  check('非 JSON HTTP200 是不可重试的协议错误',htmlSuccess.wireFailure&&htmlSuccess.rich&&htmlSuccess.status===200&&htmlSuccess.kind==='protocol'&&htmlSuccess.retryable===false&&htmlSuccess.safeMessage,{status:200,protocolFailure:true,retryable:false});
  const htmlTemporary=await failure('/media/session/html-503');
  check('非 JSON HTTP503 仍保留暂态 HTTP 重试语义',htmlTemporary.wireFailure&&htmlTemporary.rich&&htmlTemporary.status===503&&htmlTemporary.kind==='http'&&htmlTemporary.retryable===true&&htmlTemporary.helperRetry===true&&htmlTemporary.safeMessage,{status:503,httpFailure:true,retryable:true});
  const legal=await page.evaluate(async()=>{const api=globalThis.MediaRequestQa;const read=await api.requestMedia(window.hongguo,'/media/session/valid',{method:'GET',timeout:5000});const post=await api.requestMedia(window.hongguo,'/media/session',{method:'POST',body:{episode:126},timeout:5000});const released=await api.requestMedia(window.hongguo,'/media/session/valid',{method:'DELETE',timeout:5000});return read.id==='qa_valid'&&post.id==='qa_post'&&post.episode===126&&released.released===true;});
  check('合法 GET POST DELETE 路径与参数通过真实传输',legal,{methods:3,successEnvelope:true});
  const invalidRoutes=['/account/progress','/media/cache','/media/session/../account','/media/session/valid?extra=1','/media/session/'+ 'a'.repeat(129),'/media/session/%2e%2e','/media/session/非ASCII','/media/session/valid#fragment'];
  const routeBefore=await count();
  const invalidRouteResults=await page.evaluate(async routes=>Promise.all(routes.map(async route=>{const result=await window.hongguo.mediaRequestResult(route);return result.ok===false&&result.error.retryable===false;})),invalidRoutes);
  check('非法媒体路径由 Main 拒绝且不触达 HTTP',invalidRouteResults.every(Boolean)&&await count()===routeBefore,{cases:invalidRoutes.length,rejected:invalidRouteResults.filter(Boolean).length,noHttp:true});
  const optionBefore=await count(),invocationBefore=await invocations();
  const invalidOptionResults=await page.evaluate(async()=>{const cases=[null,[],{method:'PATCH'},{method:['GET']},{method:null},{timeout:0},{timeout:-1},{timeout:180001},{timeout:NaN},{timeout:Infinity},{timeout:0.5},{body:'x'.repeat(100001)}];const results=[];for(const options of cases){const result=await window.hongguo.mediaRequestResult('/media/session/valid',options);results.push(result.ok===false&&result.error.retryable===false);}return results;});
  const optionAfter=await count(),invocationAfter=await invocations();
  check('非法方法 timeout 与超限内容由 Main 拒绝且不进入 Supervisor',invalidOptionResults.every(Boolean)&&optionAfter===optionBefore&&invocationAfter===invocationBefore,{cases:invalidOptionResults.length,rejected:invalidOptionResults.filter(Boolean).length,httpRequests:optionAfter-optionBefore,supervisorInvocations:invocationAfter-invocationBefore});
  // The handler replacement affects only this throwaway process, never product source.
  await instance.evaluate(({ipcMain})=>{globalThis.__mediaIpcQaOriginal=ipcMain._invokeHandlers.get('media:request');if(typeof globalThis.__mediaIpcQaOriginal!=='function')throw new Error('Fixture handler unavailable');});
  originalHandler=true;
  await instance.evaluate(({ipcMain})=>{ipcMain.removeHandler('media:request');ipcMain.handle('media:request',()=>({ok:false,error:{kind:'http',code:'TEST_POLICY',message:'Fixture explicit retry prohibition',status:503,retryable:false}}));});
  const policy=await page.evaluate(async()=>{const api=globalThis.MediaRequestQa,wire=await window.hongguo.mediaRequestResult('/media/session/valid'),cloned=JSON.parse(JSON.stringify(wire));try{api.unwrapMediaRequestResult(cloned);return false;}catch(error){return error instanceof api.MediaRequestError&&error.status===503&&error.retryable===false&&api.isRetryableMediaRequestError(error)===false;}});
  check('wire 明确 retryable false 经 JSON clone 后不能被503覆盖',policy,{status:503,retryProhibitionPreserved:policy});
  const malformed=[null,{ok:true},{ok:'true',data:{}},{ok:false,error:{}},{ok:false,error:{kind:'http',code:'BAD CODE',message:'bad',status:503,retryable:true}},{ok:false,error:{kind:'http',code:'TEST',message:'bad',status:700,retryable:true}}];
  let rejected=0;
  for(const wire of malformed){
    await instance.evaluate(({ipcMain},value)=>{ipcMain.removeHandler('media:request');ipcMain.handle('media:request',()=>value);},wire);
    const ok=await page.evaluate(async()=>{const api=globalThis.MediaRequestQa;try{await api.requestMedia(window.hongguo,'/media/session/valid');return false;}catch(error){return error instanceof api.MediaRequestError&&error.kind==='protocol'&&error.code==='MEDIA_RESPONSE_INVALID'&&error.retryable===false;}});
    if(ok)rejected++;
  }
  await instance.evaluate(({ipcMain})=>{ipcMain.removeHandler('media:request');ipcMain.handle('media:request',globalThis.__mediaIpcQaOriginal);delete globalThis.__mediaIpcQaOriginal;});originalHandler=false;
  check('malformed envelope 经真实 IPC 后由 renderer 统一拒绝',rejected===malformed.length,{cases:malformed.length,rejected});
  const restore=await page.evaluate(async()=>{const result=await window.hongguo.mediaRequestResult('/media/session/valid');return result.ok===true&&result.data.id==='qa_valid';});
  check('临时 malformed 测试后真实 handler 已恢复',restore,{restored:true});
  const senderBefore=await count();
  const senderRejected=await instance.evaluate(async({BrowserWindow},files)=>{const foreign=new BrowserWindow({show:false,webPreferences:{preload:files.preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});foreign.webContents.setAudioMuted(true);try{await foreign.loadFile(files.html);return await foreign.webContents.executeJavaScript("(async()=>{try{await window.hongguo.mediaRequestResult('/media/session/valid');return false;}catch{return true;}})()");}finally{foreign.destroy();}},{preload:path.join(fixture,'preload.cjs'),html:path.join(fixture,'foreign.html')});
  check('非主 renderer 真实 IPC sender 被拒绝且没有 HTTP',senderRejected&&await count()===senderBefore,{senderRejected:true,noHttp:true});
  const requests=await instance.evaluate(()=>globalThis.__mediaIpcQa);
  check('所有 fixture HTTP 为 loopback 且无进度写入',requests.onlyLocal&&requests.nonLoopback===0&&requests.progressWrites===0,{nonLoopback:requests.nonLoopback,progressWrites:requests.progressWrites,mediaRequests:requests.mediaRequests});
  check('隔离媒体 IPC E2E 无页面异常',errors.length===0,{pageErrors:errors.length});
}catch(error){const flags=Object.fromEntries(['CSP','Security','newCDPSession','addScriptTag','not supported','not a function','undefined','Target closed','Execution context','disconnected','Content Security Policy'].map(word=>[word,String(error?.message).includes(word)]));checks.push({name:'隔离 media IPC E2E 失败',ok:false,errorType:error?.name||'Error',stage,flags});console.error(JSON.stringify({stage,flags}));process.exitCode=1;}
finally{
  if(instance){if(originalHandler)await instance.evaluate(({ipcMain})=>{ipcMain.removeHandler('media:request');ipcMain.handle('media:request',globalThis.__mediaIpcQaOriginal);delete globalThis.__mediaIpcQaOriginal;}).catch(()=>{});await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  const after=await production(),productionUnchanged=before.length===2&&before.every(pid=>after.includes(pid));
  checks.push({name:'生产应用与服务进程保持存活',ok:productionUnchanged,detail:{beforeCount:before.length,afterCount:after.length}});
  if(!productionUnchanged)process.exitCode=1;
  await writeFile(path.join(out,'result.json'),JSON.stringify({checks,pageErrorCount:errors.length,productionUnchanged,isolatedProfile:true,realSupervisor:true,realNetwork:false,loopbackFixture:true},null,2));
}
