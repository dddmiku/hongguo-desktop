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
  it('准备错误和断网保持业务错误，不能把任何失败当成租约过期重试',async()=>{
    const request=vi.fn(async()=>{throw new Error('内容服务连接超时');});
    const lease=new MediaSessionLease({request},body,new AbortController().signal);
    await lease.open(Promise.resolve(ready('normal')));
    await expect(lease.read()).rejects.toThrow('内容服务连接超时');
    expect(request).toHaveBeenCalledOnce();lease.release();
  });
});
