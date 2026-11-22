import path from 'node:path';
import {appendFile,lstat,mkdir,open,rename,writeFile} from 'node:fs/promises';
import {PLAYBACK_TRACE_CAPACITY,sanitizePlaybackDiagnosticEvent,sanitizePlaybackTraceSnapshot,type PlaybackDiagnosticEvent} from '../shared/playback-diagnostics';

export const PLAYBACK_DIAGNOSTIC_MAX_BYTES = 256 * 1024;
export const PLAYBACK_DIAGNOSTIC_MAX_EVENTS = 500;
export interface PlaybackDiagnosticsOptions { maxBytes?:number;maxEvents?:number;maxQueued?:number; }

const ceiling=(value:number|undefined,fallback:number,minimum=1)=>
  typeof value==='number'&&Number.isFinite(value)?Math.max(minimum,Math.min(fallback,Math.floor(value))):fallback;
const failureActions=new Set(['error','failed','fatal','failed-before-ready']);
const isFailure=(event:PlaybackDiagnosticEvent|undefined)=>!!event&&failureActions.has(event.action);

/**
 * Fixed-name, bounded private event log. Inputs and persisted lines are both
 * projected through the shared schema; raw errors and wire bodies never enter it.
 * Every I/O failure is contained here, so diagnostics cannot reject playback work.
 */
export class PlaybackDiagnostics {
  readonly file:string;
  readonly failureFile:string;
  private readonly maxBytes:number;
  private readonly maxEvents:number;
  private readonly maxQueued:number;
  private queue:Promise<void>=Promise.resolve();
  private pending=0;
  private latestPendingFailure:{events:PlaybackDiagnosticEvent[];includeRecent:boolean}|undefined;
  private failureTask:Promise<boolean>|undefined;
  private initialized=false;
  private bytes=0;
  private count=0;
  constructor(dataDirectory:string,options:PlaybackDiagnosticsOptions={}) {
    this.file=path.join(path.resolve(dataDirectory),'playback-diagnostics.jsonl');
    this.failureFile=path.join(path.resolve(dataDirectory),'playback-diagnostics.last-error.jsonl');
    this.maxBytes=ceiling(options.maxBytes,PLAYBACK_DIAGNOSTIC_MAX_BYTES,1024);
    this.maxEvents=ceiling(options.maxEvents,PLAYBACK_DIAGNOSTIC_MAX_EVENTS);
    this.maxQueued=ceiling(options.maxQueued,PLAYBACK_DIAGNOSTIC_MAX_EVENTS);
  }

  append(value:unknown):Promise<boolean>{
    try{
      const event=sanitizePlaybackDiagnosticEvent(value);
      return event?(isFailure(event)?this.reserveFailure([event],true):this.enqueue([event])):Promise.resolve(false);
    }catch{return Promise.resolve(false);}
  }

  appendSnapshot(value:unknown):Promise<boolean>{
    try{
      const snapshot=sanitizePlaybackTraceSnapshot(value);
      return snapshot?.events.length?(isFailure(snapshot.events.at(-1))?this.reserveFailure(snapshot.events,false):this.enqueue(snapshot.events)):Promise.resolve(false);
    }catch{return Promise.resolve(false);}
  }

  private enqueue(events:PlaybackDiagnosticEvent[]):Promise<boolean>{
    // Bound retained event objects as well as the filesystem. Reject a burst
    // instead of allowing a slow disk to accumulate an unbounded Promise chain.
    if(this.pending+events.length>this.maxQueued)return Promise.resolve(false);
    const lines=events.map(event=>JSON.stringify(event)+'\n');
    if(lines.some(line=>Buffer.byteLength(line)>this.maxBytes))return Promise.resolve(false);
    this.pending+=events.length;
    const task=this.queue.then(async()=>{
      try{
        await this.initialize();
        for(const line of lines)await this.writeLine(line);
        return true;
      }catch{
        // Retry initialization on a later event after an unavailable directory,
        // file sharing conflict, disk-full or interrupted append has recovered.
        this.initialized=false;
        return false;
      }finally{this.pending-=events.length;}
    });
    this.queue=task.then(()=>undefined,()=>undefined);
    return task;
  }

  private reserveFailure(events:PlaybackDiagnosticEvent[],includeRecent:boolean):Promise<boolean>{
    // The normal ledger can be full precisely when a decoder fails. Keep one
    // reserved latest-failure snapshot independently of its 500-event budget.
    // Bursts overwrite this slot and share one Promise, not a resolver list or
    // an additional queue link per failure. An in-flight write may finish, then
    // the latest pending context replaces it before this shared task settles.
    this.latestPendingFailure={events:this.fit(events,PLAYBACK_TRACE_CAPACITY),includeRecent};
    if(this.failureTask)return this.failureTask;
    const task=this.queue.then(async()=>{
      let accepted=false;
      try{
        await mkdir(path.dirname(this.failureFile),{recursive:true});
        while(this.latestPendingFailure){
          const next=this.latestPendingFailure;this.latestPendingFailure=undefined;
          try{
            const context=next.includeRecent?[...await this.readRecent(),...next.events]:next.events;
            await this.writeFailure(context);accepted=true;
          }catch{accepted=false;/* Fault diagnostics must never interrupt playback. */}
        }
        return accepted;
      }catch{this.latestPendingFailure=undefined;return false;}
      finally{this.failureTask=undefined;}
    });
    this.failureTask=task;
    // Insert only this shared task as a barrier. Normal events submitted later
    // wait behind it, so all file I/O remains serialized on the same queue.
    this.queue=task.then(()=>undefined,()=>undefined);
    return task;
  }

  private async regularFile(file:string):Promise<boolean>{
    try{
      const info=await lstat(file);
      if(info.isSymbolicLink()||!info.isFile()||info.nlink>1)throw new Error('Unsafe diagnostic file type');
      return true;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
      throw error;
    }
  }

  private fit(events:PlaybackDiagnosticEvent[],maxEvents=this.maxEvents):PlaybackDiagnosticEvent[]{
    const accepted:PlaybackDiagnosticEvent[]=[];let bytes=0;
    for(let index=events.length-1;index>=0&&accepted.length<maxEvents;index--){
      const event=events[index],size=Buffer.byteLength(JSON.stringify(event)+'\n');
      if(bytes+size>this.maxBytes)break;
      accepted.push(event);bytes+=size;
    }
    return accepted.reverse();
  }

  private async readFileEvents(file:string,maxEvents=this.maxEvents):Promise<{events:PlaybackDiagnosticEvent[];text:string;size:number}|null>{
    if(!await this.regularFile(file))return null;
    const handle=await open(file,'r');
    try{
      const info=await handle.stat(),length=Math.min(info.size,this.maxBytes);
      const buffer=Buffer.alloc(length),offset=info.size-length;
      const {bytesRead}=await handle.read(buffer,0,length,offset);
      let text=buffer.subarray(0,bytesRead).toString('utf8');
      // A bounded tail read can start inside an old JSON record. Never parse or
      // return that partial first line, including oversized hostile strings.
      if(offset>0){const firstNewline=text.indexOf('\n');text=firstNewline<0?'':text.slice(firstNewline+1);}
      const events:PlaybackDiagnosticEvent[]=[];
      for(const line of text.split('\n')){
        if(!line||Buffer.byteLength(line)>this.maxBytes)continue;
        try{const event=sanitizePlaybackDiagnosticEvent(JSON.parse(line));if(event)events.push(event);}catch{/* Invalid persisted lines are not exported. */}
      }
      return {events:this.fit(events,maxEvents),text,size:info.size};
    }finally{await handle.close();}
  }

  private async normalizeFile(file:string):Promise<{bytes:number;count:number}>{
    const current=await this.readFileEvents(file);
    if(!current)return {bytes:0,count:0};
    const text=current.events.map(event=>JSON.stringify(event)+'\n').join('');
    // Also bound/sanitize an old malformed file at startup. This only touches
    // the two owned diagnostic slots, never account, history or media files.
    if(current.size!==Buffer.byteLength(text)||current.text!==text){
      await this.regularFile(file);
      await writeFile(file,text,{encoding:'utf8',mode:0o600});
    }
    return {bytes:Buffer.byteLength(text),count:current.events.length};
  }

  private async initialize():Promise<void>{
    if(this.initialized)return;
    await mkdir(path.dirname(this.file),{recursive:true});
    await this.normalizeFile(this.file+'.bak');
    const current=await this.normalizeFile(this.file);
    this.bytes=current.bytes;this.count=current.count;this.initialized=true;
  }

  private async writeLine(line:string):Promise<void>{
    const size=Buffer.byteLength(line);
    await this.regularFile(this.file);
    if(this.bytes+size>this.maxBytes||this.count>=this.maxEvents){
      await this.regularFile(this.file+'.bak');
      await rename(this.file,this.file+'.bak');
      this.bytes=0;this.count=0;
    }
    await appendFile(this.file,line,{encoding:'utf8',mode:0o600});
    this.bytes+=size;this.count++;
  }

  private async readRecent():Promise<PlaybackDiagnosticEvent[]>{
    const backup=await this.readFileEvents(this.file+'.bak');
    const current=await this.readFileEvents(this.file);
    return this.fit([...(backup?.events||[]),...(current?.events||[])]);
  }

  private async writeFailure(events:PlaybackDiagnosticEvent[]):Promise<void>{
    const safe=events.map(sanitizePlaybackDiagnosticEvent).filter((event):event is PlaybackDiagnosticEvent=>event!==null);
    const bounded=this.fit(safe,PLAYBACK_TRACE_CAPACITY);
    if(!isFailure(bounded.at(-1)))return;
    await this.regularFile(this.failureFile);
    await writeFile(this.failureFile,bounded.map(event=>JSON.stringify(event)+'\n').join(''),{encoding:'utf8',mode:0o600});
  }

  async flush():Promise<void>{
    let observed:Promise<void>;
    do{observed=this.queue;await observed;}while(observed!==this.queue);
  }

  async read():Promise<PlaybackDiagnosticEvent[]>{
    try{
      await this.flush();
      return await this.readRecent();
    }catch{return [];}
  }

  async readLatestFailure():Promise<PlaybackDiagnosticEvent[]>{
    try{
      await this.flush();
      const failure=await this.readFileEvents(this.failureFile,PLAYBACK_TRACE_CAPACITY);
      if(!failure)return [];
      return isFailure(failure.events.at(-1))?failure.events:[];
    }catch{return [];}
  }
}
