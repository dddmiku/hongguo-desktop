import {afterEach,describe,expect,it,vi} from 'vitest';
import type {MediaSession} from '../../shared/contracts';
import {MediaSessionLease} from './MediaSessionLease';

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
    const old=lease.read();expect((await lease.read()).id).toBe('renewed');
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
  it('活动会话过期后使用原集新租约，第二次连续失效不会无限重试',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST')return ready('renewed');
      if(!options)throw new Error('请求的资源不存在或参数不正确');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    expect((await lease.read()).id).toBe('renewed');
    await expect(lease.read()).rejects.toThrow('播放连接已失效，请重试当前集');
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
    lease.release();
  });
  it('替换会话请求遇到短暂网络错误时在有界预算内重试',async()=>{
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
    await expect(lease.read(24.5)).resolves.toMatchObject({id:'replacement'});
    expect(posts).toBe(2);
    expect(request).toHaveBeenCalledWith('/media/session',{method:'POST',body:{...body,start:24.5}});
    lease.release();
  });
  it('替换会话的短暂网络错误最多重试三次',async()=>{
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(path==='/media/session'&&options?.method==='POST')throw new TypeError('fetch failed');
      if(path==='/media/session/first'&&!options)throw new Error('播放会话已过期，请重新连接');
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    await expect(lease.read(24.5)).rejects.toThrow('播放连接暂时不可用，请重试当前集');
    expect(request.mock.calls.filter(([path,options])=>path==='/media/session'&&options?.method==='POST')).toHaveLength(3);
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
    await expect(lease.read(23.75)).resolves.toMatchObject({id:'replacement-1'});
    await expect(lease.read(29.25)).resolves.toMatchObject({id:'replacement-1'});
    await expect(lease.read(31.5)).resolves.toMatchObject({id:'replacement-2'});
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
    await expect(lease.read(23.75)).rejects.toThrow(sourceFailure);
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
    await expect(lease.read(23.75)).resolves.toMatchObject({id:'renewed',phase:'complete'});
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
    const reading=lease.read(23.75);
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
    const old=lease.read(23.75);
    await vi.advanceTimersByTimeAsync(150);
    expect((await lease.read(25)).id).toBe('renewed');
    complete(ready('first'));
    expect((await old).id).toBe('renewed');expect(lease.id).toBe('renewed');lease.release();
  });
  it('心跳等待期间本地任务失败也只重建一次，第二次失败给出可读错误',async()=>{
    vi.useFakeTimers();let firstReads=0;
    const request=vi.fn(async(path:string,options?:{method?:string})=>{
      if(options?.method==='POST')return ready('renewed');
      if(path==='/media/session/first'&&!options)return {...ready('first'),phase:firstReads++===0?'preparing':'error'};
      if(path==='/media/session/renewed'&&!options)return {...ready('renewed'),phase:'error'};
      return {};
    });
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('first')));
    const reading=lease.read(23.75);
    await vi.advanceTimersByTimeAsync(150);
    await expect(reading).resolves.toMatchObject({id:'renewed',phase:'complete'});
    await expect(lease.read(25)).rejects.toThrow('播放连接已失效，请重试当前集');
    expect(request.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
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
    await expect(lease.read(23.75)).rejects.toThrow(phase==='error'?'视频转换失败，请重试当前集':'播放会话已过期，请重新连接');
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
    await expect(lease.read()).rejects.toThrow(message);
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
