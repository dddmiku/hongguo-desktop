import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut, nativeTheme, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Store } from './store';
import { Supervisor } from './supervisor';
import { readLegacy } from './migration';
import { REPOSITORY } from '../shared/meta';
import type { HistoryItem, HistoryQuery, Library, PlaybackProgress, Series, Session, UpdateInfo, Settings } from '../shared/contracts';

app.setName('红果桌面');
if(process.env.HG_TEST_DATA_DIR)app.setPath('userData',process.env.HG_TEST_DATA_DIR);
const backgroundQA=!!process.env.HG_TEST_DATA_DIR&&process.env.HG_TEST_BACKGROUND==='1';
const startHidden=backgroundQA||process.argv.includes('--start-hidden');
let window:BrowserWindow, tray:Tray, store:Store, supervisor:Supervisor, quitting=false,currentUid='local';
let syncing:Promise<{library:Library;warnings:string[]}>|undefined;
const favoriteWrites=new Map<string,Promise<Library>>();
const favoriteRevisions=new Map<string,number>();
type RemoteHistoryPage={items:HistoryItem[];hasMore:boolean;nextCursor:string|null;complete:boolean;total:number;warning?:string};
let historyContinuation:{uid:string;cursor:string;failures:number}|null=null,historyTimer:ReturnType<typeof setTimeout>|undefined;
const emitLibrary=()=>{if(window&&!window.isDestroyed())window.webContents.send('library:changed',store.library(currentUid));};
async function continueHistory(){const state=historyContinuation;if(!state||state.uid!==currentUid||quitting)return;
  try{const page=await supervisor.request<RemoteHistoryPage>('/account/history?limit=100&cursor='+encodeURIComponent(state.cursor));if(historyContinuation!==state||state.uid!==currentUid)return;
    if(page.items.length){await store.merge(state.uid,page.items.map(item=>({...item,uid:state.uid})),null);emitLibrary();}
    if(page.warning&&page.nextCursor===state.cursor){state.failures++;if(state.failures<=3)historyTimer=setTimeout(continueHistory,30000);return;}
    if(page.hasMore&&page.nextCursor){state.cursor=page.nextCursor;state.failures=0;historyTimer=setTimeout(continueHistory,5000);}else historyContinuation=null;
  }catch{state.failures++;if(historyContinuation===state&&state.failures<=3)historyTimer=setTimeout(continueHistory,30000);}
}
const retries=new Map<string,{attempt:number;next:number}>();
const liveWrites=new Map<string,number>();
let pumping=false;
let firstCatalogShown=false,startupSyncTimer:ReturnType<typeof setTimeout>|undefined;
const startLibrarySync=()=>{clearTimeout(startupSyncTimer);if(currentUid==='local'||quitting)return;void syncLibrary().then(result=>{if(window&&!window.isDestroyed())window.webContents.send('library:changed',result.library);}).catch(()=>{});};
function windowIcon(){return nativeImage.createFromPath(path.join(app.getAppPath(),'assets','icon.png'));}
function setBossKey(settings:Settings){globalShortcut.unregisterAll();if(settings.bossKey){const ok=globalShortcut.register(settings.bossKey,()=>{if(window.isVisible()&&window.isFocused())window.hide();else{window.show();window.focus();}});if(!ok)throw new Error('老板键已被其他程序占用，请换一组快捷键');}}
function assertSender(event:Electron.IpcMainInvokeEvent){if(event.sender!==window.webContents)throw new Error('无效请求来源');}
const allowed=/^\/(health|catalog\/(home|search|rank|browse|filters|comments|danmaku|series\/\d+)|account\/(session|send-code|login|logout|history|favorites|progress|favorite|mfa\/(send|verify))|media\/(session(?:\/[a-zA-Z0-9_-]+)?|cache(?:\/(clear|settings))?))(\?[^\r\n#]*)?$/;
function handle(channel:string,run:(...args:any[])=>unknown){ipcMain.handle(channel,(event,...args)=>{assertSender(event);return run(...args);});}
async function refreshIdentity(){try{const s=await supervisor.request<Session>('/account/session');const uid=s.loggedIn?s.uid:'local';if(window&&!window.isDestroyed()){window.webContents.send('session:changed',s);if(uid!==currentUid){currentUid=uid;window.webContents.send('library:changed',store.library(currentUid));}}else currentUid=uid;return s;}catch{return null;}}
async function migrateLegacy(data:string){
  if(process.env.HG_TEST_DATA_DIR)return;
  const marker=path.join(data,'migration.json');try{await fs.access(marker);return;}catch{}
  const old=await readLegacy(path.join(app.getPath('appData'),'cn.guoban.desktop-companion'),path.join(process.env.LOCALAPPDATA||path.join(app.getPath('home'),'AppData','Local'),'cn.guoban.desktop-companion'));
  if(!old.source)return;
  let uid='local';if(old.session){const result=await supervisor.request<Session>('/account/import',{method:'POST',body:{session:old.session}});if(result.loggedIn)uid=result.uid;}
  const existing=store.library(uid);await store.merge(uid,[...existing.history,...old.library.history.map(i=>({...i,uid}))],[...existing.favorites,...old.library.favorites]);
  if(old.settings)await store.saveSettings(old.settings);
  if(window&&!window.isDestroyed())window.webContents.send('settings:changed',store.settings());
  await fs.writeFile(marker,JSON.stringify({version:1,at:new Date().toISOString(),history:old.library.history.length,favorites:old.library.favorites.length}),'utf8');
}
async function syncLibrary(){
  if(syncing)return syncing;
  syncing=(async()=>{
    await refreshIdentity(); const uid=currentUid,warnings:string[]=[];
    if(uid==='local')return {library:store.library(uid),warnings};
    clearTimeout(historyTimer);historyContinuation=null;
    const favoriteRevision=favoriteRevisions.get(uid)||0;
    const [h,f]=await Promise.allSettled([supervisor.request<RemoteHistoryPage>('/account/history?limit=100&refresh=true'),supervisor.request<{items:Series[]}>('/account/favorites')]);
    if(currentUid!==uid)return {library:store.library(currentUid),warnings:['账号已切换，已丢弃上次同步结果']};
    if(h.status==='rejected')warnings.push('云端历史暂时不可用，已保留本机记录');
    if(f.status==='rejected')warnings.push('云端收藏暂时不可用，已保留本机收藏');
    if(h.status==='fulfilled'&&h.value.warning)warnings.push(h.value.warning);
    if(h.status==='fulfilled'&&h.value.hasMore&&h.value.nextCursor){historyContinuation={uid,cursor:h.value.nextCursor,failures:0};historyTimer=setTimeout(continueHistory,5000);warnings.push('最近记录已同步，较早记录正在后台补齐');}
    const library=await store.merge(uid,h.status==='fulfilled'?h.value.items.map(i=>({...i,uid})):[],f.status==='fulfilled'&&(favoriteRevisions.get(uid)||0)===favoriteRevision?f.value.items:null);
    return currentUid===uid?{library,warnings}:{library:store.library(currentUid),warnings:['账号已切换，已保留当前账号记录']};
  })();
  try{return await syncing;}finally{syncing=undefined;}
}
async function pump(){
  if(pumping||quitting)return;pumping=true;
  try{for(const item of store.pending(currentUid)){
    const id=item.uid+':'+item.series.id,p=retries.get(id)||{attempt:0,next:0};
    if(item.uid!==currentUid||Date.now()<p.next)continue;
    const intent=liveWrites.get(id)===item.watchedAt?'active':'replay';liveWrites.delete(id);
    try{await supervisor.request('/account/progress',{method:'POST',body:{series:item.series,episode:item.episode,position:item.position,duration:item.duration,watchedAt:item.watchedAt,expectedUid:item.uid,intent}});await store.acknowledge(item);retries.delete(id);}
    catch{p.attempt++;p.next=Date.now()+Math.min(60000,5000*2**Math.min(p.attempt,4));retries.set(id,p);}
  }}finally{pumping=false;}
}
async function updateInfo():Promise<UpdateInfo>{
  const base=REPOSITORY+'/releases/latest/download/latest.json';
  for(const prefix of ['https://v4.gh-proxy.org/','https://gh-proxy.org/','']){
    try{const r=await fetch(prefix+base,{signal:AbortSignal.timeout(10000)});if(!r.ok)continue;const d=await r.json();const p=d.platforms?.['windows-x86_64'];const version=p?.version||d.version;const url=p?.url||'';if(!/^[0-9]+(\.[0-9]+){1,3}$/.test(version))continue;const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const n=(x[i]||0)-(y[i]||0);if(n)return n;}return 0;};return {available:compare(version,app.getVersion())>0,version,notes:d.notes||'',url,sha256:p?.sha256||d.sha256||''};}catch{}
  }throw new Error('暂时无法连接更新服务，请稍后重试');
}
let downloading=false;
async function downloadUpdate(info:UpdateInfo){
  if(downloading)throw new Error('正在下载，请稍候');
  if(!/^https:\/\/github\.com\/dddmiku\/hongguo-desktop\/releases\/download\/v[0-9.]+\/hongguo-[0-9.]+-setup\.exe$/.test(info.url)||! /^[a-fA-F0-9]{64}$/.test(info.sha256))throw new Error('更新信息不完整，请重新检查更新');
  const latest=await updateInfo();if(latest.url!==info.url||latest.sha256!==info.sha256||!latest.available)throw new Error('更新版本已变化，请重新检查更新');
  downloading=true;const folder=path.join(app.getPath('userData'),'updates');await fs.mkdir(folder,{recursive:true});const dest=path.join(folder,'hongguo-update.exe'),part=dest+'.part';
  const report=(data:unknown)=>{if(!window.isDestroyed())window.webContents.send('update:progress',data);};
  try{
    let success=false;
    for(const prefix of ['https://v4.gh-proxy.org/','https://gh-proxy.org/','']){
      try{const r=await fetch(prefix+info.url,{signal:AbortSignal.timeout(240000)});if(!r.ok||!r.body)continue;const total=Number(r.headers.get('content-length'))||0;if(total>300*1024*1024)throw new Error('安装包大小异常');let downloaded=0;const file=await fs.open(part,'w');const hash=createHash('sha256');try{for await(const chunk of r.body){downloaded+=chunk.length;if(downloaded>300*1024*1024)throw new Error('安装包大小异常');await file.write(chunk);hash.update(chunk);report({phase:'downloading',downloaded,total});}}finally{await file.close();}if(hash.digest('hex')!==info.sha256.toLowerCase()||(total&&downloaded!==total))throw new Error('安装包校验失败');await fs.rename(part,dest);success=true;break;}catch{await fs.rm(part,{force:true});}
    }if(!success)throw new Error('下载失败，请稍后重试');report({phase:'done',downloaded:1,total:1});
    const confirm=await dialog.showMessageBox(window,{type:'question',buttons:['安装并退出','稍后安装'],defaultId:0,title:'更新已准备好',message:'安装包已通过校验。安装时将退出红果桌面。'});
    if(confirm.response===0){const error=await shell.openPath(dest);if(error)throw new Error('无法启动安装程序');app.quit();}
  }catch(e){report({phase:'error',downloaded:0,total:0,error:(e as Error).message});throw e;}finally{downloading=false;await fs.rm(part,{force:true});}
}
async function boot(){
  const root=app.isPackaged?path.join(process.resourcesPath,'service'):path.join(app.getAppPath(),'service');
  const runtime=app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(app.getAppPath(),'runtime');
  const data=process.env.HG_TEST_DATA_DIR||app.getPath('userData');await fs.mkdir(data,{recursive:true});
  store=new Store(path.join(data,'library.json'));await store.load();supervisor=new Supervisor(root,runtime,data);
  window=new BrowserWindow({width:1440,height:960,minWidth:940,minHeight:640,show:!startHidden,frame:false,title:'红果桌面',backgroundColor:'#101014',icon:windowIcon(),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,...(backgroundQA?{backgroundThrottling:false,offscreen:true}:{})}});
  if(backgroundQA)window.webContents.setFrameRate(60);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(e)=>e.preventDefault());
  window.on('close',event=>{if(!quitting&&store.settings().closeToTray){event.preventDefault();window.hide();}});
  window.on('hide',()=>window.webContents.send('window:visibility',false));
  window.on('show',()=>window.webContents.send('window:visibility',true));
  window.on('minimize',()=>window.webContents.send('window:visibility',false));
  window.on('restore',()=>window.webContents.send('window:visibility',true));
  if(!backgroundQA){tray=new Tray(windowIcon());tray.setToolTip('红果桌面');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开红果桌面',click:()=>{window.show();window.focus();}},{type:'separator'},{label:'退出',click:()=>app.quit()}]));tray.on('double-click',()=>{window.show();window.focus();});}
  handle('api:request',async(route:string,options={})=>{if(typeof route!=='string'||!allowed.test(route)||route.length>3000)throw new Error('无效接口');if(JSON.stringify(options).length>100000)throw new Error('请求内容过大');const result=await supervisor.request(route,options);if(/^\/catalog\/(home|search|rank|browse)(\?|$)/.test(route)&&!firstCatalogShown){firstCatalogShown=true;startupSyncTimer=setTimeout(startLibrarySync,500);}if(route==='/account/login'||route==='/account/logout'||route==='/account/mfa/verify')await refreshIdentity();return result;});
  handle('settings:get',()=>store.settings());handle('settings:save',async(value:Partial<Settings>)=>{const old=store.settings();const settings=await store.saveSettings(value);if(value.bossKey!==undefined&&value.bossKey!==old.bossKey){try{setBossKey(settings);}catch(e){await store.saveSettings({bossKey:old.bossKey});try{setBossKey(old);}catch{}throw e;}}nativeTheme.themeSource=settings.theme;if(value.cacheGB!==undefined)await supervisor.request('/media/cache/settings',{method:'POST',body:{cacheGB:settings.cacheGB}}).catch(()=>{});return settings;});
  handle('library:get',()=>store.library(currentUid));handle('library:progress',async(value:PlaybackProgress)=>{const uid=currentUid;const item=await store.progress(uid,value);if(uid!=='local'){liveWrites.set(uid+':'+value.series.id,item.watchedAt);void pump();}});
  handle('history:query',(query:HistoryQuery={})=>store.historyPage(currentUid,query));
  handle('library:favorite',async(series:Series,desired?:boolean)=>{
    if(!series||typeof series.id!=='string'||!/^\d{8,24}$/.test(series.id)||desired!==undefined&&typeof desired!=='boolean')throw new Error('收藏参数不正确');
    const uid=currentUid,key=uid+':'+series.id;
    if(favoriteWrites.has(key))return favoriteWrites.get(key);
    favoriteRevisions.set(uid,(favoriteRevisions.get(uid)||0)+1);
    const action=(async()=>{
      const favorite=typeof desired==='boolean'?desired:!store.library(uid).favorites.some(item=>item.id===series.id);
      if(uid!=='local')await supervisor.request('/account/favorite',{method:'POST',body:{seriesId:series.id,favorite,expectedUid:uid}});
      if(currentUid!==uid)throw new Error('账号已切换，请在当前账号重新操作');
      await store.favorite(uid,series,favorite);emitLibrary();return store.library(uid);
    })();favoriteWrites.set(key,action);
    try{return await action;}finally{favoriteRevisions.set(uid,(favoriteRevisions.get(uid)||0)+1);if(favoriteWrites.get(key)===action)favoriteWrites.delete(key);}
  });
  handle('library:remove',(id:string)=>store.remove(currentUid,id));handle('library:sync',syncLibrary);
  handle('window:action',(action:string)=>{if(action==='minimize')window.minimize();else if(action==='maximize')window.isMaximized()?window.unmaximize():window.maximize();else if(action==='close')window.close();else if(action==='quit')app.quit();else if(action==='fullscreen')window.setFullScreen(!window.isFullScreen());else if(action==='exitfullscreen'){const fullscreen=window.isFullScreen();if(fullscreen)window.setFullScreen(false);return fullscreen;}});
  handle('external:open',async(url:string)=>{const u=new URL(url);if(u.protocol!=='https:'||!['github.com','gh-proxy.com'].includes(u.hostname))throw new Error('不支持的链接');await shell.openExternal(url);});
  handle('diagnostics:export',async()=>{const source=await supervisor.diagnostics();const choice=await dialog.showSaveDialog(window,{title:'导出诊断',defaultPath:'红果桌面-诊断.jsonl'});if(choice.canceled||!choice.filePath)return '';await fs.copyFile(source,choice.filePath);return choice.filePath;});
  handle('update:check',updateInfo);handle('update:download',downloadUpdate);
  nativeTheme.themeSource=store.settings().theme;if(!backgroundQA)try{setBossKey(store.settings());}catch{}
  await window.loadFile(path.join(app.getAppPath(),'dist','index.html'));
  void supervisor.start().then(async()=>{await migrateLegacy(data);const session=await refreshIdentity();if(session?.loggedIn){startupSyncTimer=setTimeout(startLibrarySync,firstCatalogShown?500:8000);}}).catch(()=>{});
  const timer=setInterval(()=>void pump(),5000);timer.unref();
}
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{if(window){window.show();window.focus();}});
  app.whenReady().then(boot).catch(async(error)=>{if(!startHidden)await dialog.showMessageBox({type:'error',message:'客户端启动失败',detail:String(error.message)});else console.error('客户端启动失败：',String(error.message));app.quit();});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;clearTimeout(startupSyncTimer);clearTimeout(historyTimer);globalShortcut.unregisterAll();
    const flushRenderer=new Promise<void>(resolve=>{if(!window||window.isDestroyed()){resolve();return;}const listener=(e:Electron.IpcMainEvent)=>{if(e.sender===window.webContents){clearTimeout(timer);ipcMain.removeListener('app:flushed',listener);resolve();}};const timer=setTimeout(()=>{ipcMain.removeListener('app:flushed',listener);resolve();},1500);ipcMain.on('app:flushed',listener);window.webContents.send('app:flush');});
    void flushRenderer.then(()=>store?.flush()).then(()=>supervisor?.stop()).finally(()=>{store?.close();app.quit();});
  });
  app.on('window-all-closed',()=>{if(!store?.settings().closeToTray)app.quit();});
}
