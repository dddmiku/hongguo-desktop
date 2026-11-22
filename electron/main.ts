import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut, nativeTheme, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store } from './store';
import { Supervisor } from './supervisor';
import { LibrarySyncController,type SyncContext } from './library-sync';
import {PlaybackDiagnostics} from './playback-diagnostics';
import {PlaybackTrace} from '../src/playback/PlaybackTrace';
import {sanitizePlaybackTraceSnapshot,type PlaybackTraceSnapshot} from '../shared/playback-diagnostics';
import {normalizeMediaRequestFailure,type MediaRequestResult} from '../shared/media-request';
import { readLegacy } from './migration';
import { readUpdateInfo, UpdateInstaller } from './updater';
import type { HistoryItem, HistoryQuery, Library, PlaybackProgress, Series, Session, Settings } from '../shared/contracts';

app.setName('红果桌面');
if(process.env.HG_TEST_DATA_DIR)app.setPath('userData',process.env.HG_TEST_DATA_DIR);
const backgroundQA=!!process.env.HG_TEST_DATA_DIR&&process.env.HG_TEST_BACKGROUND==='1';
const startHidden=backgroundQA||process.argv.includes('--start-hidden');
let window:BrowserWindow, tray:Tray, store:Store, supervisor:Supervisor, quitting=false,currentUid='local';
let identityRevision = 0;
let librarySync:LibrarySyncController;
let playbackDiagnostics:PlaybackDiagnostics;
const bootStartedAtMs=Date.now();let rendererContextGeneration=0;
const savePlaybackSnapshot=(snapshot:PlaybackTraceSnapshot,observer:'renderer'|'main')=>{
  const safe=sanitizePlaybackTraceSnapshot(snapshot);
  if(!safe||!playbackDiagnostics)return Promise.resolve(false);
  const receivedAtMs=Date.now();
  return playbackDiagnostics.appendSnapshot({v:1,events:safe.events.map(event=>({...event,observer,receivedAtMs,bootStartedAtMs,contextGeneration:observer==='renderer'?rendererContextGeneration:0}))});
};
const favoriteWrites=new Map<string,Promise<Library>>();
const favoriteRevisions=new Map<string,number>();
type RemoteHistoryPage={items:HistoryItem[];hasMore:boolean;nextCursor:string|null;complete:boolean;total:number;warning?:string};
let historyContinuation:{uid:string;cursor:string;failures:number;busy:boolean;isCurrent:()=>boolean}|null=null,historyTimer:ReturnType<typeof setTimeout>|undefined;
let historyBackfillComplete=false;
const emitLibrary=()=>{if(window&&!window.isDestroyed())window.webContents.send('library:changed',store.library(currentUid));};
function resumeHistory(){if(historyContinuation&&!historyContinuation.busy&&librarySync.available&&!historyTimer)historyTimer=setTimeout(continueHistory,5000);}
async function continueHistory(){historyTimer=undefined;const state=historyContinuation;if(!state||state.busy||!state.isCurrent()||!librarySync.available||quitting)return;state.busy=true;
  try{const page=await supervisor.request<RemoteHistoryPage>('/account/history?limit=100&expectedUid='+encodeURIComponent(state.uid)+'&cursor='+encodeURIComponent(state.cursor));if(historyContinuation!==state||!state.isCurrent())return;
    if(page.items.length){await store.merge(state.uid,page.items,null);if(state.isCurrent())emitLibrary();}
    if(historyContinuation!==state||!state.isCurrent())return;
    if(page.warning&&page.nextCursor===state.cursor){state.failures++;if(state.failures<=3&&librarySync.available)historyTimer=setTimeout(continueHistory,30000);return;}
    if(page.hasMore&&page.nextCursor){state.cursor=page.nextCursor;state.failures=0;resumeHistory();}else{historyBackfillComplete=page.complete&&!page.warning;historyContinuation=null;}
  }catch{state.failures++;if(historyContinuation===state&&state.isCurrent()&&state.failures<=3&&librarySync.available)historyTimer=setTimeout(continueHistory,30000);}
  finally{state.busy=false;if(historyContinuation===state&&state.isCurrent()&&state.failures===0)resumeHistory();}
}
const retries=new Map<string,{attempt:number;next:number}>();
const liveWrites=new Map<string,number>();
let pumping=false;
let firstCatalogShown=false,startupSyncTimer:ReturnType<typeof setTimeout>|undefined;
const startLibrarySync=()=>{clearTimeout(startupSyncTimer);if(currentUid==='local'||quitting)return;resumeHistory();void librarySync.request().catch(()=>{});};
function windowIcon(){return nativeImage.createFromPath(path.join(app.getAppPath(),'assets','icon.png'));}
function setBossKey(settings:Settings){globalShortcut.unregisterAll();if(settings.bossKey){const ok=globalShortcut.register(settings.bossKey,()=>{if(window.isVisible()&&window.isFocused())window.hide();else{window.show();window.focus();}});if(!ok)throw new Error('老板键已被其他程序占用，请换一组快捷键');}}
function assertSender(event:Electron.IpcMainInvokeEvent){if(event.sender!==window.webContents)throw new Error('无效请求来源');}
const allowed=/^\/(health|catalog\/(home|search(?:\/suggestions)?|rank|browse|filters|comments|danmaku|series\/\d+(?:\/(next-season|seasons))?)|account\/(session|send-code|login|logout|history|favorites|progress|favorite|mfa\/(send|verify)|qr(?:\/[a-f0-9]{32})?)|media\/(session(?:\/[a-zA-Z0-9_-]+)?|cache(?:\/(clear|settings))?))(\?[^\r\n#]*)?$/;
function handle(channel:string,run:(...args:any[])=>unknown){ipcMain.handle(channel,(event,...args)=>{assertSender(event);return run(...args);});}
async function refreshIdentity(){try{const s=await supervisor.request<Session>('/account/session');const uid=s.loggedIn?s.uid:'local';if(uid!==currentUid){currentUid=uid;identityRevision++;clearTimeout(historyTimer);historyTimer=undefined;historyContinuation=null;historyBackfillComplete=false;librarySync.setAccount(uid);emitLibrary();}if(window&&!window.isDestroyed())window.webContents.send('session:changed',s);return s;}catch{return null;}}
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
async function loadLibrary({uid,background,isCurrent}:SyncContext){
    await refreshIdentity(); const warnings:string[]=[];
    if(!isCurrent())return {library:store.library(currentUid),warnings};
    if(uid==='local')return {library:store.library(uid),warnings};
    if(!background){clearTimeout(historyTimer);historyTimer=undefined;historyContinuation=null;historyBackfillComplete=false;}
    const favoriteRevision=favoriteRevisions.get(uid)||0;
    const expectedUid=encodeURIComponent(uid);
    const [h,f]=await Promise.allSettled([
      supervisor.request<RemoteHistoryPage>('/account/history?limit=100&refresh=true&expectedUid='+expectedUid),
      supervisor.request<{items:Series[]}>('/account/favorites?expectedUid='+expectedUid),
    ]);
    if(!isCurrent())return {library:store.library(currentUid),warnings:['账号已切换，已丢弃上次同步结果']};
    if(h.status==='rejected')warnings.push('云端历史暂时不可用，已保留本机记录');
    if(f.status==='rejected')warnings.push('云端收藏暂时不可用，已保留本机收藏');
    if(h.status==='fulfilled'&&h.value.warning)warnings.push(h.value.warning);
    if(h.status==='fulfilled'&&!historyBackfillComplete&&!historyContinuation){
      if(h.value.hasMore&&h.value.nextCursor){historyContinuation={uid,cursor:h.value.nextCursor,failures:0,busy:false,isCurrent};warnings.push('最近记录已同步，较早记录正在后台补齐');}
      else historyBackfillComplete=h.value.complete&&!h.value.warning;
    }
    if(historyContinuation&&historyContinuation.failures>3)historyContinuation.failures=0;
    resumeHistory();
    const library=await store.merge(uid,h.status==='fulfilled'?h.value.items:[],f.status==='fulfilled'&&(favoriteRevisions.get(uid)||0)===favoriteRevision?f.value.items:null);
    return isCurrent()?{library,warnings,retry:h.status==='rejected'||f.status==='rejected'||!!(h.status==='fulfilled'&&h.value.warning)}:{library:store.library(currentUid),warnings:['账号已切换，已保留当前账号记录']};
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
async function boot(){
  const root=app.isPackaged?path.join(process.resourcesPath,'service'):path.join(app.getAppPath(),'service');
  const runtime=app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(app.getAppPath(),'runtime');
  const data=process.env.HG_TEST_DATA_DIR||app.getPath('userData');await fs.mkdir(data,{recursive:true});
  store=new Store(path.join(data,'library.json'));await store.load();
  playbackDiagnostics=new PlaybackDiagnostics(data);
  const backendTrace=new PlaybackTrace({sink:snapshot=>savePlaybackSnapshot(snapshot,'main').then(()=>{})});
  supervisor=new Supervisor(root,runtime,data,{diagnostic:event=>backendTrace.record({...event,observer:'main'})});
  librarySync=new LibrarySyncController({load:loadLibrary,library:()=>store.library(currentUid),publish:()=>emitLibrary()});
  window=new BrowserWindow({width:1440,height:960,minWidth:940,minHeight:640,show:!startHidden,frame:false,title:'红果桌面',backgroundColor:'#101014',icon:windowIcon(),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,...(backgroundQA?{backgroundThrottling:false,offscreen:true}:{})}});
  window.webContents.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)rendererContextGeneration++;});
  if(backgroundQA)window.webContents.setFrameRate(60);
  librarySync.setActive(backgroundQA||window.isVisible());
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(e)=>e.preventDefault());
  window.on('close',event=>{if(!quitting&&store.settings().closeToTray){event.preventDefault();window.hide();}});
  const visibility=(visible:boolean)=>{librarySync.setActive(visible);if(!visible){clearTimeout(historyTimer);historyTimer=undefined;}else startLibrarySync();window.webContents.send('window:visibility',visible);};
  window.on('hide',()=>visibility(false));window.on('show',()=>visibility(true));
  window.on('minimize',()=>visibility(false));window.on('restore',()=>visibility(true));
  window.on('focus',startLibrarySync);
  if(!backgroundQA){tray=new Tray(windowIcon());tray.setToolTip('红果桌面');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开红果桌面',click:()=>{window.show();window.focus();}},{type:'separator'},{label:'退出',click:()=>app.quit()}]));tray.on('double-click',()=>{window.show();window.focus();});}
  handle('api:request',async(route:string,options={})=>{if(typeof route!=='string'||!allowed.test(route)||route.length>3000)throw new Error('无效接口');if(JSON.stringify(options).length>100000)throw new Error('请求内容过大');const result=await supervisor.request(route,options);if(/^\/catalog\/(home|search|rank|browse)(\?|$)/.test(route)&&!firstCatalogShown){firstCatalogShown=true;startupSyncTimer=setTimeout(startLibrarySync,500);}if(route==='/account/login'||route==='/account/logout'||route==='/account/mfa/verify'||(/^\/account\/qr\/[a-f0-9]{32}$/.test(route)&&(result as {status?:string})?.status==='confirmed')){await refreshIdentity();startLibrarySync();}return result;});
  handle('settings:get',()=>store.settings());handle('settings:save',async(value:Partial<Settings>)=>{const old=store.settings();const settings=await store.saveSettings(value);if(value.bossKey!==undefined&&value.bossKey!==old.bossKey){try{setBossKey(settings);}catch(e){await store.saveSettings({bossKey:old.bossKey});try{setBossKey(old);}catch{}throw e;}}nativeTheme.themeSource=settings.theme;if(value.cacheGB!==undefined)await supervisor.request('/media/cache/settings',{method:'POST',body:{cacheGB:settings.cacheGB}}).catch(()=>{});return settings;});
  handle('library:get',()=>store.library(currentUid));
  handle('media:request',async(route:string,options:Record<string,unknown>={}):Promise<MediaRequestResult<unknown>>=>{
    try{
      if(typeof route!=='string'||!/^\/media\/session(?:\/[A-Za-z0-9_-]{1,128})?$/.test(route)||
        !options||typeof options!=='object'||Array.isArray(options)||
        options.method!==undefined&&(typeof options.method!=='string'||!['GET','POST','DELETE'].includes(options.method))||
        options.timeout!==undefined&&(typeof options.timeout!=='number'||!Number.isSafeInteger(options.timeout)||options.timeout<=0||options.timeout>180000)||
        JSON.stringify(options).length>100000)throw new Error('无效媒体接口参数');
      return {ok:true,data:await supervisor.request(route,options)};
    }catch(error){return {ok:false,error:normalizeMediaRequestFailure(error)};}
  });
  handle('playback:diagnostics',snapshot=>savePlaybackSnapshot(snapshot,'renderer').then(()=>{}));
  handle('library:view',(active:boolean)=>{if(typeof active!=='boolean')throw new Error('无效片库可见状态');librarySync.setRealtime(active);});
  handle('library:progress',async(value:PlaybackProgress)=>{
    const uid=currentUid;
    if(value.expectedUid!==undefined&&value.expectedUid!==uid)throw new Error('账号已切换，已跳过旧播放记录');
    const item=await store.progress(uid,value);
    if(uid!=='local'){liveWrites.set(uid+':'+value.series.id,item.watchedAt);void pump();}
  });
  handle('history:query',(query:HistoryQuery={})=>store.historyPage(currentUid,query));
  handle('library:favorite',async(series:Series,desired?:boolean)=>{
    if(!series||typeof series.id!=='string'||!/^\d{8,24}$/.test(series.id)||desired!==undefined&&typeof desired!=='boolean')throw new Error('收藏参数不正确');
    const uid=currentUid,revision=identityRevision,key=revision+':'+series.id;
    if(favoriteWrites.has(key))return favoriteWrites.get(key);
    favoriteRevisions.set(uid,(favoriteRevisions.get(uid)||0)+1);
    const action=(async()=>{
      const favorite=typeof desired==='boolean'?desired:!store.library(uid).favorites.some(item=>item.id===series.id);
      if(uid!=='local')await supervisor.request('/account/favorite',{method:'POST',body:{seriesId:series.id,favorite,expectedUid:uid}});
      if(identityRevision!==revision)throw new Error('账号已切换，请在当前账号重新操作');
      await store.favorite(uid,series,favorite);
      if(identityRevision!==revision)throw new Error('账号已切换，请在当前账号重新操作');
      emitLibrary();return store.library(uid);
    })();favoriteWrites.set(key,action);
    try{return await action;}finally{favoriteRevisions.set(uid,(favoriteRevisions.get(uid)||0)+1);if(favoriteWrites.get(key)===action)favoriteWrites.delete(key);}
  });
  handle('library:remove',async(id:string)=>{
    const revision=identityRevision;
    const result=await store.remove(currentUid,id);
    if(identityRevision!==revision)throw new Error('账号已切换，已保留当前账号记录');
    return result;
  });
  handle('library:sync',(options:{background?:boolean}={})=>{if(!options||typeof options!=='object'||options.background!==undefined&&typeof options.background!=='boolean')throw new Error('同步参数不正确');return librarySync.request(!options.background);});
  handle('library:online',(online:boolean)=>{if(typeof online!=='boolean')throw new Error('网络状态不正确');librarySync.setOnline(online);if(online)resumeHistory();else{clearTimeout(historyTimer);historyTimer=undefined;}});
  handle('window:action',(action:string)=>{if(action==='minimize')window.minimize();else if(action==='maximize')window.isMaximized()?window.unmaximize():window.maximize();else if(action==='close')window.close();else if(action==='quit')app.quit();else if(action==='fullscreen')window.setFullScreen(!window.isFullScreen());else if(action==='exitfullscreen'){const fullscreen=window.isFullScreen();if(fullscreen)window.setFullScreen(false);return fullscreen;}});
  handle('external:open',async(url:string)=>{const u=new URL(url);if(u.protocol!=='https:'||!['github.com','gh-proxy.com'].includes(u.hostname))throw new Error('不支持的链接');await shell.openExternal(url);});
  handle('diagnostics:export',async()=>{const source=await supervisor.diagnostics();const choice=await dialog.showSaveDialog(window,{title:'导出诊断',defaultPath:'红果桌面-诊断.jsonl'});if(choice.canceled||!choice.filePath)return '';const events=[...(await playbackDiagnostics.read()),...(await playbackDiagnostics.readLatestFailure())];await fs.writeFile(choice.filePath,(await fs.readFile(source,'utf8'))+'\n'+events.map(event=>JSON.stringify(event)).join('\n'),'utf8');return choice.filePath;});
  const updater = new UpdateInstaller(path.join(data, 'updates'), app.getVersion(), task => {
    if (!window.isDestroyed()) window.webContents.send('update:progress', task);
  }, async file => {
    if (window.isDestroyed()) return;
    const confirm = await dialog.showMessageBox(window, { type: 'question', buttons: ['安装并退出', '稍后安装'],
      defaultId: 0, cancelId: 1, title: '更新已准备好', message: '安装包已通过校验。安装时将退出红果桌面。' });
    if (confirm.response === 0 && !quitting) {
      const error = await shell.openPath(file);
      if (error) throw new Error('无法启动安装程序');
      app.quit();
    }
  });
  handle('update:check', () => readUpdateInfo(app.getVersion()));
  handle('update:download', info => updater.download(info));
  nativeTheme.themeSource=store.settings().theme;if(!backgroundQA)try{setBossKey(store.settings());}catch{}
  await window.loadFile(path.join(app.getAppPath(),'dist','index.html'));
  void supervisor.start().then(async()=>{await migrateLegacy(data);const session=await refreshIdentity();if(session?.loggedIn){startupSyncTimer=setTimeout(startLibrarySync,firstCatalogShown?500:8000);}}).catch(()=>{});
  const timer=setInterval(()=>void pump(),5000);timer.unref();
}
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{if(window){window.show();window.focus();}});
  app.whenReady().then(boot).catch(async(error)=>{if(!startHidden)await dialog.showMessageBox({type:'error',message:'客户端启动失败',detail:String(error.message)});else console.error('客户端启动失败：',String(error.message));app.quit();});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;librarySync?.dispose();clearTimeout(startupSyncTimer);clearTimeout(historyTimer);globalShortcut.unregisterAll();
    const flushRenderer=new Promise<void>(resolve=>{if(!window||window.isDestroyed()){resolve();return;}const listener=(e:Electron.IpcMainEvent)=>{if(e.sender===window.webContents){clearTimeout(timer);ipcMain.removeListener('app:flushed',listener);resolve();}};const timer=setTimeout(()=>{ipcMain.removeListener('app:flushed',listener);resolve();},1500);ipcMain.on('app:flushed',listener);window.webContents.send('app:flush');});
    void flushRenderer.then(()=>store?.flush()).catch(()=>{}).then(()=>supervisor?.stop()).catch(()=>{}).then(()=>playbackDiagnostics?.flush()).catch(()=>{}).finally(()=>{
      try{store?.close();}finally{app.quit();}
    }).catch(()=>{});
  });
  app.on('window-all-closed',()=>{if(!store?.settings().closeToTray)app.quit();});
}
