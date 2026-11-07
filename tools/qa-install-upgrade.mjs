// Real running-app upgrade QA. Account identities stay in memory; reports contain booleans/counts only.
import {_electron as electron} from '@playwright/test';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const root=process.cwd(),out=path.join(root,'_work','install-upgrade-qa');await mkdir(out,{recursive:true});
const expected=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const minimumHistory=Number(process.env.HG_EXPECT_MIN_HISTORY||0);
const installer=path.join(root,'release',`hongguo-${expected}-setup.exe`);
const installRoot=await realpath(path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop'));
const executable=path.join(installRoot,'红果桌面.exe');
const env={...process.env,TEMP:out,TMP:out};
delete env.HG_TEST_DATA_DIR;
const exec=promisify(execFile),checks=[];
let instance,before,after,finished=false;
function check(name,ok,detail){checks.push({name,ok,...detail?{detail}:{}});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);}
async function processes(){
  const script='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $r=[IO.Path]::GetFullPath($env:HG_INSTALL_QA_ROOT).TrimEnd("\\")+"\\"; @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($r,[StringComparison]::OrdinalIgnoreCase)} | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress';
  const result=await exec(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...env,HG_INSTALL_QA_ROOT:installRoot},timeout:15000});
  const rows=result.stdout.trim()?JSON.parse(result.stdout):[];return Array.isArray(rows)?rows:[rows];
}
function counts(rows){return{electron:rows.filter(row=>path.basename(row.ExecutablePath)==='红果桌面.exe').length,
  python:rows.filter(row=>path.basename(row.ExecutablePath).toLowerCase()==='python.exe').length,
  java:rows.filter(row=>path.basename(row.ExecutablePath).toLowerCase()==='java.exe').length};}
async function open(){const app=await electron.launch({executablePath:executable,args:[],env,timeout:60000});
  const page=await app.firstWindow();await page.waitForSelector('.app-shell',{timeout:30000});
  await page.evaluate(()=>window.hongguo.request('/health'));return app;}
async function snapshot(app,minimum=0){
  const page=await app.firstWindow();
  const profile=await app.evaluate(({app})=>app.getPath('userData'));
  const session=await page.evaluate(()=>window.hongguo.request('/account/session'));
  const uid=session.loggedIn?session.uid:'local';
  const db=new DatabaseSync(path.join(profile,'history.sqlite3'),{readOnly:true});
  let total,all;
  try{db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=5000;');total=Number(db.prepare('SELECT COUNT(*) n FROM history WHERE uid=?').get(uid).n);
    all=Number(db.prepare('SELECT COUNT(*) n FROM history').get().n);}finally{db.close();}
  await page.waitForFunction(async(expected)=>{const lib=await window.hongguo.getLibrary();return (lib.historyTotal??lib.history.length)>=expected;},Math.max(total,minimum),{timeout:120000,polling:5000});
  const values=await page.evaluate(async()=>({settings:await window.hongguo.getSettings(),library:await window.hongguo.getLibrary(),health:await window.hongguo.request('/health')}));
  const json=JSON.parse(await readFile(path.join(profile,'library.json'),'utf8'));
  return{uid,loggedIn:session.loggedIn,settings:values.settings,history:total,allHistory:all,
    libraryTotal:values.library.historyTotal??values.library.history.length,recent:values.library.history.length,
    favorites:values.library.favorites.length,outbox:Object.keys(json.outbox||{}).length,
    version:values.health.version,healthy:values.health.ok,schema:json.schema};
}
async function quit(app){if(!app)return;await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}

try{
  check('最终安装包存在',(await stat(installer)).size>0);
  if((await processes()).length){await exec(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'build','close-installation-processes.ps1'),'-InstallDir',installRoot],
    {env,windowsHide:true,timeout:20000});}
  check('验收前没有占用的已安装实例',(await processes()).length===0);
  instance=await open();before=await snapshot(instance);
  const oldProcesses=await processes(),oldCounts=counts(oldProcesses);
  check('运行中旧客户端与独立签名服务已确认',before.healthy&&oldCounts.electron>0&&oldCounts.python>0&&oldCounts.java>0,
    {version:before.version,processes:oldCounts,loggedIn:before.loggedIn,history:before.history,favorites:before.favorites});
  console.log('Executing running-app silent upgrade');
  const task=spawn(installer,['/S'],{env,windowsHide:true,stdio:'ignore'});
  const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{task.kill();reject(new Error('安装未在180秒内结束'));},180000);
    task.once('error',error=>{clearTimeout(timeout);reject(error);});task.once('exit',code=>{clearTimeout(timeout);resolve(code);});});
  check('运行中覆盖安装返回0，无error2',code===0,{exitCode:code});
  const remaining=await processes();const live=new Set(remaining.map(row=>row.ProcessId));
  check('旧Electron/Python/Java全部关闭',oldProcesses.every(row=>!live.has(row.ProcessId)),{oldProcesses:oldCounts});
  await quit(instance);instance=undefined;
  instance=await open();after=await snapshot(instance,minimumHistory);
  check('新版健康且版本正确',after.healthy&&after.version===expected,{version:after.version});
  const sameIdentity=before.uid===after.uid&&before.loggedIn===after.loggedIn;
  check('账号身份保留',sameIdentity,{sameIdentity,loggedIn:after.loggedIn});
  check('完整历史、收藏及偏好保留',after.history>=before.history&&after.allHistory>=before.allHistory&&
    after.favorites>=before.favorites&&Object.entries(before.settings).every(([key,value])=>JSON.stringify(after.settings[key])===JSON.stringify(value)),
    {historyBefore:before.history,historyAfter:after.history,libraryTotal:after.libraryTotal,recent:after.recent,favoritesBefore:before.favorites,favoritesAfter:after.favorites,
      schema:after.schema,quality:after.settings.quality,rate:after.settings.rate});
  await quit(instance);instance=undefined;
  const qa=await exec(process.execPath,[path.join(root,'tools','qa-installed.mjs')],{cwd:root,env,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  console.log(qa.stdout.trim());check('qa-installed完整验收通过',true);
  finished=true;
}catch(error){checks.push({name:'升级验收中断',ok:false,error:error.message});console.error(error.message);process.exitCode=1;}
finally{
  await quit(instance);
  await writeFile(path.join(out,'result.json'),JSON.stringify({version:expected,success:finished,checks},null,2));
  // Return the actual installed app to the user, without automation/debug arguments.
  if((await processes()).length===0){const app=spawn(executable,[],{env,detached:true,stdio:'ignore',windowsHide:false});app.unref();}
}
