import {afterEach,describe,expect,it,vi} from 'vitest';
import {MediaPreload} from './MediaPreload';
import type {MediaSession} from '../../shared/contracts';
const target={seriesId:'12345678',episode:1,quality:'1080p',start:0};
const session={id:'first-session',phase:'preparing',url:'/video'} as MediaSession;
const tick=async()=>{for(let n=0;n<5;n++)await Promise.resolve();};
afterEach(()=>vi.useRealTimers());
describe('first-episode source preparation',()=>{
  it('hands the in-flight request to playback without allocating a second media session',async()=>{const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>true);warm.prepare(target);warm.prepare({...target});const pending=warm.claim(target)!;expect(await pending).toBe(session);expect(request).toHaveBeenCalledOnce();expect(warm.claim(target)).toBeNull();warm.clear();expect(request).toHaveBeenCalledOnce();});
  it('closing details releases an unused ready lease',async()=>{const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);warm.prepare(target);await tick();warm.clear();expect(request.mock.calls.map(call=>call[0])).toEqual(['/media/session','/media/session/first-session']);});
  it('closing while POST is pending still releases the late session once',async()=>{let resolve!:(value:MediaSession)=>void;const request=vi.fn((route:string)=>route==='/media/session'?new Promise<MediaSession>(done=>{resolve=done;}):Promise.resolve(session));const warm=new MediaPreload({request},async()=>false);warm.prepare(target);await tick();warm.clear();resolve(session);await tick();expect(request.mock.calls.filter(call=>call[0].startsWith('/media/session/'))).toHaveLength(1);});
  it('a different episode or quality cannot take the first prepared source',async()=>{const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);warm.prepare(target);expect(warm.claim({...target,episode:2})).toBeNull();expect(warm.claim({...target,quality:'720p'})).toBeNull();await tick();warm.clear();});
  it('an unused preparation expires instead of keeping downloads and processes alive',async()=>{vi.useFakeTimers();const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);warm.prepare(target);await tick();await vi.advanceTimersByTimeAsync(30000);expect(request).toHaveBeenCalledTimes(2);expect(warm.claim(target)).toBeNull();});
  it('retiring a previous player cannot cancel the next detail page preparation',async()=>{
    const oldPlayer={},details={},request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);
    warm.prepare(target,details);await tick();
    warm.clear(oldPlayer);
    const pending=warm.claim(target);expect(pending).not.toBeNull();expect(await pending).toBe(session);
    expect(request).toHaveBeenCalledOnce();
  });
  it('owner cleanup still releases its own unused next-season source',async()=>{
    const owner={},request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);
    warm.prepare(target,owner);await tick();warm.clear(owner);
    expect(warm.claim(target)).toBeNull();expect(request).toHaveBeenCalledTimes(2);
  });
  it('the same whole-episode preparation can transfer owners without another POST',async()=>{
    const oldPlayer={},details={},request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);
    warm.prepare(target,oldPlayer);await tick();warm.prepare(target,details);warm.clear(oldPlayer);
    const pending=warm.claim(target);expect(pending).not.toBeNull();expect(await pending).toBe(session);
    expect(request).toHaveBeenCalledOnce();
  });
  it('restarting at zero takes the prepared full episode instead of cancelling and recreating its job',async()=>{
    const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);
    warm.prepare({...target,start:23.75});await tick();warm.prepare({...target,start:0});
    const pending=warm.claim(target);expect(pending).not.toBeNull();expect(await pending).toBe(session);
    expect(request).toHaveBeenCalledOnce();
  });
  it('a prepared full episode can be claimed at a different requested seek position',async()=>{
    const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);
    warm.prepare({...target,start:23.75});await tick();
    const pending=warm.claim(target);expect(pending).not.toBeNull();expect(await pending).toBe(session);
    expect(request).toHaveBeenCalledOnce();
  });
  it('retiring a previous player also preserves the next owner POST while it is still in flight',async()=>{
    const oldPlayer={},details={};let resolve!:(value:MediaSession)=>void;
    const request=vi.fn((_route:string)=>new Promise<MediaSession>(done=>{resolve=done;})),warm=new MediaPreload({request},async()=>false);
    warm.prepare(target,details);await tick();warm.clear(oldPlayer);
    const pending=warm.claim(target);expect(pending).not.toBeNull();resolve(session);
    expect(await pending).toBe(session);expect(request).toHaveBeenCalledOnce();
  });
  it('account/navigation global cleanup still releases an owned unused preparation',async()=>{
    const request=vi.fn(async(_route:string)=>session),warm=new MediaPreload({request},async()=>false);
    warm.prepare(target,{});await tick();warm.clear();expect(warm.claim(target)).toBeNull();expect(request).toHaveBeenCalledTimes(2);
  });
});
