// Native-window regression against the real main/preload IPC, in an isolated profile.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work','audit-pip-window');
const installed=process.argv.includes('--installed'),packaged=process.argv.includes('--packaged');
const mode=installed?'installed':packaged?'packaged':'source';
const executable=installed?(process.env.HG_QA_EXECUTABLE||path.join(process.env.ProgramFiles,'hongguo-desktop','红果桌面.exe')):path.join(root,'release','win-unpacked','红果桌面.exe');
await mkdir(out,{recursive:true});
const checks=[],errors=[];
let instance,page;
function check(name,ok,detail){checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)process.exitCode=1;}
const state=()=>instance.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0];return{bounds:w.getBounds(),work:screen.getDisplayMatching(w.getBounds()).workArea,always:w.isAlwaysOnTop(),minimum:w.getMinimumSize()};});
try{
  instance=await electron.launch({...(installed||packaged?{executablePath:executable,args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile-'+mode),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
  page=await instance.firstWindow();page.on('pageerror',e=>errors.push(e.name));
  await page.waitForSelector('.app-shell',{timeout:60000});
  const prior=await instance.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],area=screen.getDisplayMatching(w.getBounds()).workArea;w.setBounds({x:area.x+area.width-200,y:area.y+area.height-200,width:1000,height:700});return w.getNormalBounds();});
  await page.evaluate(()=>window.hongguo.window('pip'));
  let sample=await state(),b=sample.bounds,a=sample.work;
  check('partially offscreen parent enters fully visible mini window',b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height,{prior,...sample});
  const moved=await instance.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],a=screen.getDisplayMatching(w.getBounds()).workArea;w.setPosition(a.x+24,a.y+24);return w.getBounds();});
  await page.evaluate(()=>window.hongguo.window('pip'));sample=await state();
  check('duplicate enter retains user mini-window position',JSON.stringify(moved)===JSON.stringify(sample.bounds),{moved,after:sample.bounds});
  await page.evaluate(()=>window.hongguo.window('exitpip'));sample=await state();
  check('exit restores full-size minimum and clears topmost',sample.minimum[0]===940&&sample.minimum[1]===640&&!sample.always,sample);
  await instance.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.center();w.setAlwaysOnTop(true);});
  const before=await state();
  await page.evaluate(()=>window.hongguo.window('pip'));await page.evaluate(()=>window.hongguo.window('exitpip'));sample=await state();
  check('exit restores preexisting window state',sample.always===before.always&&JSON.stringify(sample.bounds)===JSON.stringify(before.bounds),{before,after:sample});
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false));
  await page.evaluate(()=>window.hongguo.window('pip'));
  await page.reload();await page.waitForSelector('.app-shell');sample=await state();
  check('reloading renderer restores normal native window',!sample.always&&sample.minimum[0]===940&&sample.bounds.width>=940,sample);
  await instance.evaluate(({screen})=>{globalThis.__auditDisplayMatching=screen.getDisplayMatching;screen.getDisplayMatching=b=>({...globalThis.__auditDisplayMatching(b),workArea:{x:0,y:0,width:800,height:500}});});
  await page.evaluate(()=>window.hongguo.window('pip'));await page.evaluate(()=>window.hongguo.window('exitpip'));sample=await state();
  check('simulated smaller work area also constrains restored minimum',sample.bounds.width<=800&&sample.bounds.height<=500&&sample.minimum[0]<=800&&sample.minimum[1]<=500,sample);
  await instance.evaluate(({screen})=>{screen.getDisplayMatching=globalThis.__auditDisplayMatching;delete globalThis.__auditDisplayMatching;});
  check('no renderer errors',errors.length===0,{errors});
  check('test stays hidden and muted',await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(w=>w.isAudioMuted())));
}catch(error){check('native window harness',false,{type:error.name,message:String(error.message).slice(0,160)});}
finally{
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  await writeFile(path.join(out,mode+'-result.json'),JSON.stringify({checks,errors},null,2));
}
