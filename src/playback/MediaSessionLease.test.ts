import {afterEach,describe,expect,it,vi} from 'vitest';
import type {MediaSession} from '../../shared/contracts';
import {MediaSessionLease,MediaSessionNeedsRecoveryError} from './MediaSessionLease';
// Explicit caller-owned renewal; read itself must never perform POST policy.
const readRecovering=(lease:MediaSessionLease,position?:number)=>lease.read(position).catch(error=>{
  if(error instanceof MediaSessionNeedsRecoveryError)return lease.reconnect(position);
  throw error;
});

describe('replacement transaction visibility and scoped cancellation',()=>{
  it('a cancelled operation late finally cannot clear or overwrite the next active transaction',async()=>{
    let firstComplete!:(value:MediaSession)=>void,secondComplete!:(value:MediaSession)=>void,posts=0;
    const firstPost=new Promise<MediaSession>(resolve=>{firstComplete=resolve;}),secondPost=new Promise<MediaSession>(resolve=>{secondComplete=resolve;});
    const request=vi.fn(async(_path:string,options?:{method?:string})=>{if(options?.method==='POST')return ++posts===1?firstPost:secondPost;return {};});
    const lease=new MediaSessionLease({request},body,new AbortController().signal);await lease.open(Promise.resolve(ready('committed')));
    const first=lease.reconnect(24.5),firstObserved=expect(first).rejects.toMatchObject({name:'AbortError'});lease.cancelReconnect();
    const second=lease.reconnect(25);firstComplete(ready('cancelled-candidate'));await firstObserved;
    expect(lease.id).toBe('committed');const coalesced=lease.reconnect(25.5);await Promise.resolve();expect(posts).toBe(2);
    secondComplete(ready('accepted-candidate'));await expect(second).resolves.toMatchObject({id:'accepted-candidate'});await expect(coalesced).resolves.toMatchObject({id:'accepted-candidate'});
    expect(lease.id).toBe('accepted-candidate');
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session/cancelled-candidate'&&options?.method==='DELETE')).toHaveLength(1);
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session/committed'&&options?.method==='DELETE')).toHaveLength(1);
    lease.release();expect(request.mock.calls.filter(([path,options])=>path==='/media/session/accepted-candidate'&&options?.method==='DELETE')).toHaveLength(1);
  });
  it.each(['expired','cancelled','error'] as const)('read %s signals recovery using only GET, never a hidden replacement or disposal',async state=>{
    const request=vi.fn(async(_path:string,options?:{method?:string})=>{
      if(options)return {};
      if(state==='expired')throw new Error('播放会话已过期，请重新连接');
      return {...ready('committed'),phase:state,error:'source failed'};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);await lease.open(Promise.resolve(ready('committed')));
    try{
      await expect(lease.read(24.5)).rejects.toBeInstanceOf(MediaSessionNeedsRecoveryError);
      expect(request.mock.calls).toEqual([['/media/session/committed']]);expect(lease.id).toBe('committed');
    }finally{lease.release();}
  });
  it('keeps the committed old ID visible until a replacement is actually ready',async()=>{
    vi.useFakeTimers();
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return {...ready('candidate'),phase:'preparing'};
      if(!options&&path==='/media/session/candidate')return ready('candidate');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);await lease.open(Promise.resolve(ready('committed')));
    try{
      const changing=lease.reconnect(24.5);await vi.advanceTimersByTimeAsync(0);const visibleWhilePreparing=lease.id;
      await vi.advanceTimersByTimeAsync(150);await expect(changing).resolves.toMatchObject({id:'candidate',phase:'complete'});
      expect(visibleWhilePreparing).toBe('committed');expect(lease.id).toBe('candidate');
    }finally{lease.release();}
  });
  it('never hands an uncommitted preparing replacement to a late heartbeat of the old ID',async()=>{
    vi.useFakeTimers();let completeOld!:(value:MediaSession)=>void;
    const oldRead=new Promise<MediaSession>(resolve=>{completeOld=resolve;});
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return {...ready('candidate'),phase:'preparing'};
      if(!options&&path==='/media/session/committed')return oldRead;
      if(!options&&path==='/media/session/candidate')return ready('candidate');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);await lease.open(Promise.resolve(ready('committed')));
    try{
      const heartbeat=lease.read(24.5),changing=lease.reconnect(24.5);await vi.advanceTimersByTimeAsync(0);
      completeOld(ready('committed'));const observed=await heartbeat;await vi.advanceTimersByTimeAsync(150);await changing;
      expect(observed).toMatchObject({id:'committed',phase:'complete'});
    }finally{lease.release();}
  });
  it('a scoped cancel after POST validation but before commit cannot delete the old lease or deliver the new one',async()=>{
    const request=vi.fn(async(_path:string,options?:{method?:string})=>options?.method==='POST'?ready('candidate'):{});
    const lease=new MediaSessionLease({request},body,new AbortController().signal);await lease.open(Promise.resolve(ready('committed')));
    const changing=lease.reconnect(24.5);const observed=changing.then(value=>({value}),error=>({error}));
    await Promise.resolve();lease.cancelReconnect();const outcome=await observed;
    try{
      expect(outcome).toHaveProperty('error');expect(lease.id).toBe('committed');
      expect(request.mock.calls.filter(([path,options])=>path==='/media/session/candidate'&&options?.method==='DELETE')).toHaveLength(1);
      expect(request.mock.calls.filter(([path,options])=>path==='/media/session/committed'&&options?.method==='DELETE')).toHaveLength(0);
    }finally{lease.release();}
  });
  it('disposes a late scoped-cancel POST exactly once and preserves an identical committed ID',async()=>{
    for(const replacementId of ['candidate','committed']){
      let complete!:(value:MediaSession)=>void;const pending=new Promise<MediaSession>(resolve=>{complete=resolve;});
      const request=vi.fn(async(_path:string,options?:{method?:string})=>options?.method==='POST'?pending:{});
      const lease=new MediaSessionLease({request},body,new AbortController().signal);await lease.open(Promise.resolve(ready('committed')));
      const changing=lease.reconnect(24.5);const observed=expect(changing).rejects.toMatchObject({name:'AbortError'});
      lease.cancelReconnect();complete(ready(replacementId));await observed;
      expect(lease.id).toBe('committed');
      expect(request.mock.calls.filter(([path,options])=>path==='/media/session/committed'&&options?.method==='DELETE')).toHaveLength(0);
      expect(request.mock.calls.filter(([path,options])=>path==='/media/session/candidate'&&options?.method==='DELETE')).toHaveLength(replacementId==='candidate'?1:0);
      lease.release();
      expect(request.mock.calls.filter(([path,options])=>path==='/media/session/committed'&&options?.method==='DELETE')).toHaveLength(1);
    }
  });
});

afterEach(()=>vi.useRealTimers());
const body={seriesId:'12345678',episode:54,quality:'1080p',start:12.5};
const ready=(id:string):MediaSession=>({id,phase:'complete',url:'/media/session/'+id+'/index.m3u8'});

describe('播放会话续租和过期恢复',()=>{
  it('旧租约的晚到心跳不能覆盖已建立的新会话',async()=>{
    let late!:(value:MediaSession)=>void;
    const pending=new Promise<MediaSession>(resolve=>late=resolve);let reads=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return ready('renewed');
      if(!options&&path==='/media/session/first'){
        if(reads++===0)return pending;
        throw new Error('播放会话已过期，请重新连接');
      }
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    const old=readRecovering(lease,);expect((await readRecovering(lease,)).id).toBe('renewed');
    late(ready('first'));expect((await old).id).toBe('renewed');expect(lease.id).toBe('renewed');lease.release();
  });
  it('已取消的预热会话重新建立可播放租约，不能直接交给解码器',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>options?.method==='POST'?ready('new'):{});
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await expect(lease.open(Promise.resolve({...ready('cancelled'),phase:'cancelled'}))).resolves.toMatchObject({id:'new',phase:'complete'});
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);lease.release();
  });
  it('预热会话已经过期时释放旧租约并只重建一次原剧原集',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST')return ready('renewed');
      if(path==='/media/session/expired'&&!options)throw new Error("Error invoking remote method 'api:request': Error: 播放会话已过期，请重新连接");
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    const result=await lease.open(Promise.resolve({...ready('expired'),phase:'preparing'}));
    expect(result.id).toBe('renewed');
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toEqual([['/media/session',{method:'POST',body}]]);
    expect(request.mock.calls.some(([path,options])=>path==='/media/session/expired'&&options?.method==='DELETE')).toBe(true);
    lease.release();
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session/renewed'&&options?.method==='DELETE')).toHaveLength(1);
  });
  it('租约每次只重建一份原集资源，不再私自耗尽解码恢复协调器的预算',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST')return ready('renewed');
      if(!options)throw new Error('请求的资源不存在或参数不正确');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    expect((await readRecovering(lease,)).id).toBe('renewed');
    await expect(readRecovering(lease,)).resolves.toMatchObject({id:'renewed'});
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(2);
    lease.release();
  });
  it('短暂网络错误转交协调器，失败不能删除旧租约或在租约内部嵌套重试',async()=>{
    let posts=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST'){
        posts++;if(posts===1)throw new TypeError('fetch failed');return ready('replacement');
      }
      if(path==='/media/session/first'&&!options)throw new Error('播放会话已过期，请重新连接');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    await expect(readRecovering(lease,24.5)).rejects.toThrow('播放连接暂时不可用');
    expect(posts).toBe(1);expect(lease.id).toBe('first');
    expect(request.mock.calls.some(([path,options])=>path==='/media/session/first'&&options?.method==='DELETE')).toBe(false);
    await expect(lease.reconnect(24.5)).resolves.toMatchObject({id:'replacement'});
    expect(posts).toBe(2);
    expect(request).toHaveBeenCalledWith('/media/session',{method:'POST',body:{...body,start:24.5}});
    lease.release();
  });
  it('一次网络恢复失败只交付一次错误，不私自执行三次快速POST',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST')throw new TypeError('fetch failed');
      if(path==='/media/session/first'&&!options)throw new Error('播放会话已过期，请重新连接');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    await expect(readRecovering(lease,24.5)).rejects.toThrow('播放连接暂时不可用，请重试当前集');
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session'&&options?.method==='POST')).toHaveLength(1);
    lease.release();
  });
  it('已续租并通过健康心跳后遇到独立失效，仍可恢复原集进度',async()=>{
    const posts:string[]=[],replacementReads=new Map<string,number>();
    const request=vi.fn(async(path:string,options?:{method?:string;body?:unknown})=>{
      if(path==='/media/session'&&options?.method==='POST'){
        const id=posts.length===0?'first':'replacement-'+posts.length;posts.push(id);return ready(id);
      }
      if(path==='/media/session/first'&&!options)return {...ready('first'),phase:'cancelled'};
      if(path==='/media/session/replacement-1'&&!options){
        const count=replacementReads.get(path)||0;replacementReads.set(path,count+1);
        if(count===0)return ready('replacement-1');
        throw new Error('播放会话已过期，请重新连接');
      }
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open();
    await expect(readRecovering(lease,23.75)).resolves.toMatchObject({id:'replacement-1'});
    await expect(readRecovering(lease,29.25)).resolves.toMatchObject({id:'replacement-1'});
    await expect(readRecovering(lease,31.5)).resolves.toMatchObject({id:'replacement-2'});
    expect(posts).toEqual(['first','replacement-1','replacement-2']);
    expect(request).toHaveBeenCalledWith('/media/session',{method:'POST',body:{...body,start:31.5}});
    lease.release();
  });
  it('旧任务失败后重试原集，新任务再失败时保留具体线路错误',async()=>{
    let posts=0;const sourceFailure='各播放线路暂时连接失败，请重试当前集';
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST'){
        posts++;return posts===1?ready('first'):{...ready('retry'),phase:'error',error:sourceFailure};
      }
      if(path==='/media/session/first'&&!options)return {...ready('first'),phase:'error',error:'旧播放任务已结束'};
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open();
    await expect(readRecovering(lease,23.75)).rejects.toThrow(sourceFailure);
    expect(posts).toBe(2);
    lease.release();
  });
  it.each(['error','cancelled'] as const)('同一活动会话变为 %s 后按真实播放进度重建原集',async phase=>{
    const request=vi.fn(async(path:string,options?:{method?:string;body?:unknown})=>{
      if(path==='/media/session'&&options?.method==='POST')return ready('renewed');
      if(path==='/media/session/first'&&!options)return {...ready('first'),phase,error:'视频转换失败，请重试当前集'};
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    await expect(readRecovering(lease,23.75)).resolves.toMatchObject({id:'renewed',phase:'complete'});
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toEqual([
      ['/media/session',{method:'POST',body:{...body,start:23.75}}],
    ]);
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session/first'&&options?.method==='DELETE')).toHaveLength(1);
    lease.release();
  });
  it('心跳返回准备中会话时等待可播放状态，不能交付仍在准备的会话',async()=>{
    vi.useFakeTimers();let reads=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>!options
      ? {...ready('first'),phase:reads++===0?'preparing':'complete'}
      : {});
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    const reading=readRecovering(lease,23.75);
    await vi.advanceTimersByTimeAsync(150);
    await expect(reading).resolves.toMatchObject({id:'first',phase:'complete'});
    expect(request.mock.calls.filter(([,options])=>!options)).toHaveLength(2);
    lease.release();
  });
  it('心跳轮询的晚到结果不能恢复已被替换的旧会话',async()=>{
    vi.useFakeTimers();let reads=0;let complete!:(value:MediaSession)=>void;
    const pending=new Promise<MediaSession>(resolve=>complete=resolve);
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return ready('renewed');
      if(path==='/media/session/first'&&!options){
        if(reads++===0)return {...ready('first'),phase:'preparing'};
        if(reads===2)return pending;
        throw new Error('播放会话已过期，请重新连接');
      }
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    const old=readRecovering(lease,23.75);
    await vi.advanceTimersByTimeAsync(150);
    expect((await readRecovering(lease,25)).id).toBe('renewed');
    complete(ready('first'));
    expect((await old).id).toBe('renewed');expect(lease.id).toBe('renewed');lease.release();
  });
  it('连续任务失效每次交给同一恢复协调器，不被旧renewed布尔锁永久截断',async()=>{
    vi.useFakeTimers();let firstReads=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return ready('renewed');
      if(path==='/media/session/first'&&!options)return {...ready('first'),phase:firstReads++===0?'preparing':'error'};
      if(path==='/media/session/renewed'&&!options)return {...ready('renewed'),phase:'error'};
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    const reading=readRecovering(lease,23.75);
    await vi.advanceTimersByTimeAsync(150);
    await expect(reading).resolves.toMatchObject({id:'renewed',phase:'complete'});
    await expect(readRecovering(lease,25)).resolves.toMatchObject({id:'renewed'});
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(2);
    lease.release();
  });
  it.each(['error','cancelled'] as const)('重建的会话再次返回 %s 时停止恢复并报告失败',async phase=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return {...ready('renewed'),phase,error:'视频转换失败，请重试当前集'};
      if(!options)return {...ready('first'),phase:'error'};
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    await expect(readRecovering(lease,23.75)).rejects.toThrow(phase==='error'?'视频转换失败，请重试当前集':'播放会话已过期，请重新连接');
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
    lease.release();
  });
  it('取消正在返回的新会话后立即释放，不能交付已经关闭的播放器',async()=>{
    let complete!:(value:MediaSession)=>void;
    const pending=new Promise<MediaSession>(resolve=>complete=resolve);
    const request=vi.fn((path:string,options?:{method?:string})=>options?.method==='POST'?pending:Promise.resolve({}));
    const controller=new AbortController();
    const lease=new MediaSessionLease({request},body,controller.signal);
    const opening=lease.open();const error=expect(opening).rejects.toMatchObject({name:'AbortError'});
    await Promise.resolve();controller.abort();lease.release();complete(ready('late'));
    await error;
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session/late'&&options?.method==='DELETE')).toHaveLength(1);
  });
  it.each(['内容服务连接超时','账号已切换，请重新播放当前集','登录态已失效，请重新登录后播放'])('请求失败 %s 保持业务错误，不自动重建租约',async message=>{
    const request=vi.fn(async()=>{throw new Error(message);});
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('normal')));
    await expect(readRecovering(lease,)).rejects.toThrow(message);
    expect(request).toHaveBeenCalledOnce();lease.release();
  });
  it('首次准备失败保持原业务错误，不能自动重试被拒绝的播放请求',async()=>{
    const request=vi.fn(async()=>({}));
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await expect(lease.open(Promise.resolve({...ready('denied'),phase:'error',error:'官网暂未开放这集的播放权限，已保留当前进度'})))
      .rejects.toThrow('官网暂未开放这集的播放权限，已保留当前进度');
    expect(request).not.toHaveBeenCalled();lease.release();
  });
});
