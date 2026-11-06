import { contextBridge, ipcRenderer } from 'electron';
import type { NativeBridge, UpdateTask } from '../shared/contracts';
const bridge:NativeBridge={
  request:(path,options)=>ipcRenderer.invoke('api:request',path,options),
  getSettings:()=>ipcRenderer.invoke('settings:get'),saveSettings:value=>ipcRenderer.invoke('settings:save',value),
  getLibrary:()=>ipcRenderer.invoke('library:get'),saveProgress:value=>ipcRenderer.invoke('library:progress',value),
  getHistory:query=>ipcRenderer.invoke('history:query',query),
  toggleFavorite:series=>ipcRenderer.invoke('library:favorite',series),removeHistory:id=>ipcRenderer.invoke('library:remove',id),syncLibrary:()=>ipcRenderer.invoke('library:sync'),
  window:action=>ipcRenderer.invoke('window:action',action),openExternal:url=>ipcRenderer.invoke('external:open',url),exportDiagnostics:()=>ipcRenderer.invoke('diagnostics:export'),
  checkUpdate:()=>ipcRenderer.invoke('update:check'),downloadUpdate:info=>ipcRenderer.invoke('update:download',info),
  onUpdate:callback=>{const listener=(_event:Electron.IpcRendererEvent,task:UpdateTask)=>callback(task);ipcRenderer.on('update:progress',listener);return()=>ipcRenderer.removeListener('update:progress',listener);},
  onVisibility:callback=>{const listener=(_event:Electron.IpcRendererEvent,visible:boolean)=>callback(visible);ipcRenderer.on('window:visibility',listener);return()=>ipcRenderer.removeListener('window:visibility',listener);},
  onShutdown:callback=>{const listener=()=>{void callback().finally(()=>ipcRenderer.send('app:flushed'));};ipcRenderer.on('app:flush',listener);return()=>ipcRenderer.removeListener('app:flush',listener);},
  onLibrary:callback=>{const listener=(_event:Electron.IpcRendererEvent,library:Parameters<typeof callback>[0])=>callback(library);ipcRenderer.on('library:changed',listener);return()=>ipcRenderer.removeListener('library:changed',listener);},
  onSettings:callback=>{const listener=(_event:Electron.IpcRendererEvent,settings:Parameters<typeof callback>[0])=>callback(settings);ipcRenderer.on('settings:changed',listener);return()=>ipcRenderer.removeListener('settings:changed',listener);},
  onSession:callback=>{const listener=(_event:Electron.IpcRendererEvent,session:Parameters<typeof callback>[0])=>callback(session);ipcRenderer.on('session:changed',listener);return()=>ipcRenderer.removeListener('session:changed',listener);}
};
contextBridge.exposeInMainWorld('hongguo',bridge);
