import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {link,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PlaybackDiagnostics,PLAYBACK_DIAGNOSTIC_MAX_BYTES,PLAYBACK_DIAGNOSTIC_MAX_EVENTS} from './playback-diagnostics';

const event=(sequence:number)=>({v:1,type:'playback_event',sequence,elapsedMs:sequence*250,stage:'recovery',action:'recover',reason:'timeout',deckSlot:0,episode:126,leaseGeneration:2,currentTime:59.13,duration:59.187,bufferedAhead:.18,readyState:4,paused:false,ended:false,sealed:true});
let work:string;
beforeEach(async()=>{
  const root=path.resolve('_work','playback-diagnostic-tests');await mkdir(root,{recursive:true});
  work=await mkdtemp(path.join(root,'case-'));
});
afterEach(async()=>{
  const expected=path.resolve('_work','playback-diagnostic-tests');
  if(path.dirname(path.resolve(work))!==expected)throw new Error('Test cleanup escapes the workspace');
  await rm(work,{recursive:true,force:true});
});

describe('bounded playback diagnostic sink',()=>{
  it('round-trips approved occurrence and correlation scope numbers through disk reads',async()=>{
    const sink=new PlaybackDiagnostics(work),scoped={...event(1),occurredAtMs:1800000000000,bootStartedAtMs:1799999990000,traceGeneration:2,contextGeneration:3};
    expect(await sink.append(scoped)).toBe(true);expect((await sink.read())[0]).toEqual(scoped);
  });
  it('writes only the shared event schema and strips every unknown input field',async()=>{
    const sink=new PlaybackDiagnostics(work);
    expect(await sink.append({...event(1),url:'https://example.invalid/',query:'unsafe-field',headers:{Authorization:'unsafe-field'},uid:'unsafe-field',sessionId:'unsafe-field',message:'unsafe-field',stack:'unsafe-field',error:{message:'unsafe-field'}})).toBe(true);
    const records=await sink.read();expect(records).toHaveLength(1);
    expect(records[0]).toEqual(event(1));
    const raw=await readFile(sink.file,'utf8');expect(raw).not.toContain('unsafe-field');expect(raw).not.toContain('example.invalid');
  });
  it('rejects malformed versions, mandatory counters and unapproved stage/action strings',async()=>{
    const sink=new PlaybackDiagnostics(work);
    for(const value of [null,[],{}, {...event(1),v:2},{...event(1),type:'other_event'},{...event(1),sequence:-1},{...event(1),elapsedMs:NaN},{...event(1),stage:'arbitrary-stage'},{...event(1),action:'x'.repeat(65)}])expect(await sink.append(value)).toBe(false);
    expect(await sink.read()).toEqual([]);await expect(stat(sink.file)).rejects.toThrow();
  });
  it('projects invalid optional reasons, numbers and booleans out of the stored event',async()=>{
    const sink=new PlaybackDiagnostics(work);
    expect(await sink.append({...event(1),reason:'arbitrary-reason',currentTime:Infinity,paused:'false',httpStatus:999})).toBe(true);
    const [record]=await sink.read();
    expect(record).not.toHaveProperty('reason');expect(record).not.toHaveProperty('currentTime');
    expect(record).not.toHaveProperty('paused');expect(record).not.toHaveProperty('httpStatus');
    expect(record.sequence).toBe(1);expect(record.type).toBe('playback_event');
  });
  it('serializes concurrent events without losing their submission order',async()=>{
    const sink=new PlaybackDiagnostics(work);
    expect((await Promise.all(Array.from({length:40},(_,index)=>sink.append(event(index+1))))).every(Boolean)).toBe(true);
    await sink.flush();expect((await sink.read()).map(value=>value.sequence)).toEqual(Array.from({length:40},(_,index)=>index+1));
  });
  it('rotates after the line ceiling using exactly one fixed backup slot',async()=>{
    const sink=new PlaybackDiagnostics(work,{maxEvents:3});
    for(let sequence=1;sequence<=8;sequence++)expect(await sink.append(event(sequence))).toBe(true);
    expect((await readFile(sink.file,'utf8')).trim().split('\n')).toHaveLength(2);
    const backup=(await readFile(sink.file+'.bak','utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(backup.map(value=>value.sequence)).toEqual([4,5,6]);
    expect((await sink.read()).map(value=>value.sequence)).toEqual([6,7,8]);
  });
  it('keeps current and backup files below the byte ceiling',async()=>{
    const sink=new PlaybackDiagnostics(work,{maxBytes:1024,maxEvents:500});
    for(let sequence=1;sequence<=20;sequence++)expect(await sink.append(event(sequence))).toBe(true);
    expect((await stat(sink.file)).size).toBeLessThanOrEqual(1024);
    expect((await stat(sink.file+'.bak')).size).toBeLessThanOrEqual(1024);
    expect((await sink.read()).at(-1)?.sequence).toBe(20);
  });
  it('restores line accounting after a process restart before appending',async()=>{
    const first=new PlaybackDiagnostics(work,{maxEvents:3});
    await first.append(event(1));await first.append(event(2));
    const restarted=new PlaybackDiagnostics(work,{maxEvents:3});await restarted.append(event(3));await restarted.append(event(4));
    expect((await readFile(restarted.file,'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await restarted.read()).map(value=>value.sequence)).toEqual([2,3,4]);
  });
  it('revalidates persisted lines and limits reads of corrupt oversized files',async()=>{
    const sink=new PlaybackDiagnostics(work,{maxBytes:1024});
    await writeFile(sink.file,'x'.repeat(10000)+'\n'+JSON.stringify({...event(1),message:'unsafe-field',url:'https://example.invalid/'})+'\ninvalid-json\n'+JSON.stringify(event(2))+'\n');
    const records=await sink.read();expect(records.map(value=>value.sequence)).toEqual([1,2]);
    expect(JSON.stringify(records)).not.toContain('unsafe-field');
    expect(await sink.append(event(3))).toBe(true);
    expect((await stat(sink.file)).size).toBeLessThanOrEqual(1024);
    expect((await readFile(sink.file,'utf8'))).not.toContain('unsafe-field');
  });
  it('bounds pending events and reports backpressure without throwing',async()=>{
    const sink=new PlaybackDiagnostics(work,{maxQueued:2});
    const accepted=await Promise.all(Array.from({length:20},(_,index)=>sink.append(event(index+1))));
    expect(accepted.filter(Boolean)).toHaveLength(2);expect((await sink.read()).map(value=>value.sequence)).toEqual([1,2]);
  });
  it('swallows write failure and can recover on a later event',async()=>{
    const directory=path.join(work,'blocked');await writeFile(directory,'a file, not a directory');
    const sink=new PlaybackDiagnostics(directory);
    expect(await sink.append(event(1))).toBe(false);await expect(sink.flush()).resolves.toBeUndefined();expect(await sink.read()).toEqual([]);
    await rm(directory);await mkdir(directory);expect(await sink.append(event(2))).toBe(true);expect((await sink.read())[0].sequence).toBe(2);
  });
  it('accepts a bounded sanitized snapshot as one ordered batch',async()=>{
    const sink=new PlaybackDiagnostics(work);
    expect(await sink.appendSnapshot({v:1,events:[event(1),event(2)],message:'unsafe-field'})).toBe(true);
    expect((await sink.read()).map(value=>value.sequence)).toEqual([1,2]);
  });
  it('never follows a hardlinked diagnostic filename into another profile file',async()=>{
    const protectedFile=path.join(work,'protected-profile-file.json');await writeFile(protectedFile,'do not modify this file');
    const sink=new PlaybackDiagnostics(work);await link(protectedFile,sink.file);
    expect(await sink.append(event(1))).toBe(false);expect(await sink.read()).toEqual([]);
    expect(await readFile(protectedFile,'utf8')).toBe('do not modify this file');
  });
  it('exposes hard production caps and never lets options raise them',async()=>{
    expect(PLAYBACK_DIAGNOSTIC_MAX_BYTES).toBe(256*1024);expect(PLAYBACK_DIAGNOSTIC_MAX_EVENTS).toBe(500);
    const sink=new PlaybackDiagnostics(work,{maxBytes:10**9,maxEvents:10**9});
    for(let sequence=1;sequence<=502;sequence++)expect(await sink.append(event(sequence))).toBe(true);
    expect((await readFile(sink.file,'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await stat(sink.file+'.bak')).size).toBeLessThanOrEqual(PLAYBACK_DIAGNOSTIC_MAX_BYTES);
    expect((await sink.read()).length).toBeLessThanOrEqual(PLAYBACK_DIAGNOSTIC_MAX_EVENTS);
  });
});

describe('latest playback failure preservation',()=>{
  const failure=(sequence:number,action='fatal')=>({...event(sequence),action,reason:'recovery-budget'});
  const failureFile=()=>path.join(work,'playback-diagnostics.last-error.jsonl');
  it('keeps the failed trigger chain when normal snapshots rotate the live log',async()=>{
    const sink=new PlaybackDiagnostics(work,{maxEvents:3});
    const failed=[event(1),event(2),failure(3)];
    expect(await sink.appendSnapshot({v:1,events:failed})).toBe(true);
    const original=await readFile(failureFile(),'utf8');
    expect(await sink.appendSnapshot({v:1,events:[...failed,{...event(4),action:'progress'}]})).toBe(true);
    for(let sequence=5;sequence<=15;sequence++)expect(await sink.appendSnapshot({v:1,events:[{...event(sequence),action:'progress'}]})).toBe(true);
    expect(await readFile(failureFile(),'utf8')).toBe(original);
    expect((await sink.readLatestFailure()).map(value=>value.sequence)).toEqual([1,2,3]);
    expect((await sink.read()).some(value=>value.sequence===3)).toBe(false);
  });
  it('overwrites only one fixed slot on subsequent failures and never creates timestamp backups',async()=>{
    const sink=new PlaybackDiagnostics(work);
    await sink.appendSnapshot({v:1,events:[event(1),failure(2,'error')]});
    await sink.appendSnapshot({v:1,events:[event(3),failure(4,'failed')]});
    await sink.appendSnapshot({v:1,events:[event(5),failure(6,'failed-before-ready')]});
    expect((await sink.readLatestFailure()).map(value=>value.sequence)).toEqual([5,6]);
    expect((await readdir(work)).filter(name=>name.startsWith('playback-diagnostics.last-error'))).toEqual(['playback-diagnostics.last-error.jsonl']);
  });
  it('captures preceding safe events for a single fatal event',async()=>{
    const sink=new PlaybackDiagnostics(work);
    await sink.append(event(1));await sink.append(event(2));expect(await sink.append(failure(3))).toBe(true);
    expect((await sink.readLatestFailure()).map(value=>value.sequence)).toEqual([1,2,3]);
    await sink.append(event(4));expect((await sink.readLatestFailure()).at(-1)?.sequence).toBe(3);
  });
  it('bounds the latest failure to 200 sanitized events and the configured byte limit',async()=>{
    const sink=new PlaybackDiagnostics(work);
    const events=Array.from({length:250},(_,index)=>event(index+1));events[249]=failure(250);
    expect(await sink.appendSnapshot({v:1,events})).toBe(true);
    const stored=await sink.readLatestFailure();expect(stored).toHaveLength(200);
    expect(stored[0].sequence).toBe(51);expect(stored.at(-1)?.sequence).toBe(250);
    expect((await stat(failureFile())).size).toBeLessThanOrEqual(PLAYBACK_DIAGNOSTIC_MAX_BYTES);
    const compact=new PlaybackDiagnostics(work,{maxBytes:1024});
    await compact.appendSnapshot({v:1,events:[event(251),event(252),event(253),event(254),failure(255)]});
    expect((await stat(failureFile())).size).toBeLessThanOrEqual(1024);
    expect((await compact.readLatestFailure()).at(-1)?.sequence).toBe(255);
  });
  it('never stores unknown failure strings and safely reads a corrupt oversized slot',async()=>{
    const sink=new PlaybackDiagnostics(work,{maxBytes:1024});
    await writeFile(failureFile(),'x'.repeat(10000)+'\n'+JSON.stringify({...event(1),message:'unsafe-field',url:'https://example.invalid/'})+'\nnot-json\n'+JSON.stringify(failure(2))+'\n');
    const safe=await sink.readLatestFailure();expect(safe.map(value=>value.sequence)).toEqual([1,2]);
    expect(JSON.stringify(safe)).not.toContain('unsafe-field');expect(JSON.stringify(safe)).not.toContain('example.invalid');
    await sink.appendSnapshot({v:1,events:[{...event(3),headers:{Authorization:'unsafe-field'}},{...failure(4),message:'unsafe-field',stack:'unsafe-field'}]});
    expect(await readFile(failureFile(),'utf8')).not.toContain('unsafe-field');
  });
  it('does not follow a hardlinked fault slot and lets later normal writes continue',async()=>{
    const sink=new PlaybackDiagnostics(work),protectedFile=path.join(work,'protected-fault-file.json');
    await writeFile(protectedFile,'do not modify this file');await link(protectedFile,failureFile());
    expect(await sink.appendSnapshot({v:1,events:[failure(1)]})).toBe(false);
    expect(await sink.appendSnapshot({v:1,events:[event(2)]})).toBe(true);
    expect(await sink.readLatestFailure()).toEqual([]);expect(await readFile(protectedFile,'utf8')).toBe('do not modify this file');
  });
  it('contains fault-slot write failure on the shared queue and recovers without interrupting later events',async()=>{
    const sink=new PlaybackDiagnostics(work);await mkdir(failureFile());
    expect(await sink.appendSnapshot({v:1,events:[failure(1)]})).toBe(false);
    expect(await sink.appendSnapshot({v:1,events:[event(2)]})).toBe(true);await expect(sink.flush()).resolves.toBeUndefined();
    const blocked=path.resolve(failureFile());if(path.dirname(blocked)!==path.resolve(work))throw new Error('Fixture cleanup escapes its case directory');
    await rm(blocked,{recursive:true});expect(await sink.appendSnapshot({v:1,events:[event(3),failure(4)]})).toBe(true);
    expect((await sink.readLatestFailure()).map(value=>value.sequence)).toEqual([3,4]);
  });
  it('reserves the unique fault snapshot even while two normal 200-event batches occupy the queue',async()=>{
    const sink=new PlaybackDiagnostics(work);
    const batch=(from:number)=>Array.from({length:200},(_,index)=>event(from+index));
    const first=sink.appendSnapshot({v:1,events:batch(1)}),second=sink.appendSnapshot({v:1,events:batch(201)});
    const failed=batch(401);failed[199]=failure(600);
    const fault=sink.appendSnapshot({v:1,events:failed});
    const accepted=await Promise.all([first,second,fault]);expect(accepted[2]).toBe(true);expect((await sink.readLatestFailure())).toHaveLength(200);
    expect((await sink.readLatestFailure()).at(-1)?.sequence).toBe(600);
  });
  it('coalesces 1000 later faults into one pending slot and one shared promise, with the newest context retained',async()=>{
    const sink=new PlaybackDiagnostics(work);
    const batch=(from:number)=>Array.from({length:200},(_,index)=>event(from+index));
    const normal=[sink.appendSnapshot({v:1,events:batch(1)}),sink.appendSnapshot({v:1,events:batch(201)})];
    const promises:Promise<boolean>[]=[];
    for(let index=0;index<1000;index++)promises.push(sink.appendSnapshot({v:1,events:[event(1000+index*2),failure(1001+index*2)]}));
    const latest=batch(5001);latest[199]=failure(5200);promises.push(sink.appendSnapshot({v:1,events:latest}));
    const distinctPromises=new Set(promises).size;await sink.flush();expect(distinctPromises).toBe(1);expect(await promises.at(-1)).toBe(true);
    expect((await sink.readLatestFailure())).toHaveLength(200);expect((await sink.readLatestFailure()).at(-1)?.sequence).toBe(5200);
    expect((await readdir(work)).filter(name=>name.startsWith('playback-diagnostics.last-error'))).toEqual(['playback-diagnostics.last-error.jsonl']);
    await Promise.all(normal);
  });
});
