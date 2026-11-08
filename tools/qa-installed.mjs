import {quietElectron as electron} from './quiet-electron.mjs';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=process.cwd(),out=path.join(root,'_work','installed-qa');await mkdir(out,{recursive:true});
const expectedVersion=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const executable=path.join(process.env.LOCALAPPDATA,'Programs','hongguo-desktop','红果桌面.exe');
const instance=await electron.launch({executablePath:executable,args:[],env:{...process.env},timeout:60000});
const page=await instance.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.waitForSelector('.app-shell',{timeout:20000});
  const health=await page.evaluate(()=>window.hongguo.request('/health'));
  if(health.version!==expectedVersion||!health.ok)throw new Error('已安装程序版本或服务异常');
  const expectedSettings=await page.evaluate(()=>window.hongguo.getSettings());
  await page.waitForFunction(async expected=>{const [library,settings,session]=await Promise.all([window.hongguo.getLibrary(),window.hongguo.getSettings(),window.hongguo.request('/account/session')]);return (!session.loggedIn||library.history.length===0||library.history[0].uid===session.uid)&&settings.rate===expected.rate&&settings.quality===expected.quality;},expectedSettings,{timeout:90000});
  const details=await page.evaluate(async()=>{const [settings,library,session,health]=await Promise.all([window.hongguo.getSettings(),window.hongguo.getLibrary(),window.hongguo.request('/account/session'),window.hongguo.request('/health')]);return {version:health.version,history:library.historyTotal??library.history.length,recent:library.history.length,favorites:library.favorites.length,loggedIn:session.loggedIn,quality:settings.quality,rate:settings.rate,autoplay:settings.autoplay};});
  if(details.quality!==expectedSettings.quality||details.rate!==expectedSettings.rate)throw new Error('用户播放偏好未正确保留');
  await page.waitForSelector('.series-card',{timeout:90000});
  await page.screenshot({path:path.join(out,'installed-home.png')});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.waitForSelector('.settings-page');await page.screenshot({path:path.join(out,'installed-settings.png')});
  if(errors.length)throw new Error('渲染错误：'+errors.join(','));
  const data=await instance.evaluate(({app})=>app.getPath('userData'));
  const state=JSON.parse(await readFile(path.join(data,'library.json'),'utf8'));
  details.outbox=Object.keys(state.outbox||{}).length;
  if(details.outbox!==0)console.log('有真实待上报进度，保留重试队列：'+details.outbox);
  console.log(JSON.stringify(details));await writeFile(path.join(out,'result.json'),JSON.stringify(details,null,2));
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
