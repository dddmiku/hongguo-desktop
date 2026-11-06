import {_electron as electron} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','installed-sync-diagnosis');await mkdir(out,{recursive:true});
const install=path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop'),executable=path.join(install,'红果桌面.exe');
const env={...process.env,TEMP:out,TMP:out};delete env.HG_TEST_DATA_DIR;
await promisify(execFile)(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'build','close-installation-processes.ps1'),'-InstallDir',install],{env,windowsHide:true,timeout:20000});
const instance=await electron.launch({executablePath:executable,args:[],env,timeout:60000}),page=await instance.firstWindow();
const result={waitSeconds:55};const start=Date.now();
await instance.evaluate(()=>{const original=globalThis.fetch;globalThis.__progressTrace=[];globalThis.fetch=async(...args)=>{if(!String(args[0]).includes('/account/progress'))return original(...args);const trace={at:Date.now(),stage:'request'};globalThis.__progressTrace.push(trace);try{const response=await original(...args);const value=await response.clone().json().catch(()=>({}));Object.assign(trace,{stage:'response',status:response.status,synced:value.synced,skipped:value.skipped,errorCode:value.error?.code,elapsed:(Date.now()-trace.at)/1000});return response;}catch(error){Object.assign(trace,{stage:'error',errorType:error.name,elapsed:(Date.now()-trace.at)/1000});throw error;}};});
try{
  await page.waitForSelector('.app-shell',{timeout:20000});
  try{result.health=await page.evaluate(()=>window.hongguo.request('/health'));}catch(error){result.healthError=error.message;}
  result.elapsed=(Date.now()-start)/1000;
  const state=await page.evaluate(async()=>{const session=await window.hongguo.request('/account/session'),library=await window.hongguo.getLibrary();return{loggedIn:session.loggedIn,identityAligned:library.history.length?library.history[0].uid===session.uid:null,total:library.historyTotal??library.history.length};}).catch(error=>({error:error.message}));
  Object.assign(result,state);
  const data=await instance.evaluate(({app})=>app.getPath('userData'));
  const pending=()=>readFile(path.join(data,'library.json'),'utf8').then(raw=>Object.keys(JSON.parse(raw).outbox||{}).length);
  result.pendingBefore=await pending();await page.waitForTimeout(55000);result.pendingAfter=await pending();result.progressTrace=await instance.evaluate(()=>globalThis.__progressTrace);
  console.log(JSON.stringify(result));await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
}catch(error){result.error=error.message;console.log(JSON.stringify(result));await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));process.exitCode=1;}
finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
