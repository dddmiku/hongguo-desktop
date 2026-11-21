import { afterEach, describe, it, expect, vi } from 'vitest';
import { SeamlessSwitcher, type PlaybackTarget, type PreparedDeck } from './SeamlessSwitcher';
const target=(episode:number,start=0):PlaybackTarget=>({seriesId:'12345678',episode,quality:'1080p',start});
function fixture(){
  const events:string[]=[],requests:{index:number;target:PlaybackTarget;signal:AbortSignal;prewarm:boolean;resolve:(value:PreparedDeck)=>void;reject:(error:Error)=>void}[]=[];
  let painted!:()=>void;
  const controller=new SeamlessSwitcher({prepare:(index,wanted,signal,prewarm=false)=>new Promise<PreparedDeck>((resolve,reject)=>requests.push({index,target:wanted,signal,prewarm,resolve,reject})),present:(next,previous)=>events.push(`present:${next.target.episode}:was:${previous?.target.episode||0}`),afterPresent:()=>new Promise<void>(resolve=>{painted=resolve;})});
  const resolve=(n:number)=>{const r=requests[n];const deck={index:r.index,target:r.target,release:vi.fn<() => void | Promise<void>>(()=>{events.push(`release:${r.target.episode}`);})};r.resolve(deck);return deck;};
  return {controller,requests,events,resolve,paint:()=>painted()};
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
describe('解码后原子切集',()=>{
  it('新首帧准备之前不提交或释放当前画面，提交后等待绘制才释放旧槽',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();const old=f.resolve(0);await first;const second=f.controller.select(target(2));await tick();expect(f.controller.current).toBe(old);expect(old.release).not.toHaveBeenCalled();expect(f.events).toEqual(['present:1:was:0']);const next=f.resolve(1);await second;expect(f.controller.current).toBe(next);expect(old.release).not.toHaveBeenCalled();f.paint();await tick();expect(f.events).toEqual(['present:1:was:0','present:2:was:1','release:1']);});
  it('切集时复用进行中的完整预热，且不重新申请解码槽',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();f.resolve(0);await first;const warming=f.controller.warm(target(2));await tick();expect(f.requests[1].prewarm).toBe(true);expect(f.controller.current?.target.episode).toBe(1);const switching=f.controller.select(target(2),true);await tick();expect(f.requests).toHaveLength(2);expect(f.requests[1].prewarm).toBe(true);const warm=f.resolve(1);await expect(warming).resolves.toBe(warm);await expect(switching).resolves.toBe(warm);expect(f.controller.current).toBe(warm);f.paint();});
  it('快速连续切集取消过期准备，旧画面保持直到最后请求已解码',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();const old=f.resolve(0);await first;const stale=f.controller.select(target(2));await tick();const last=f.controller.select(target(3));await tick();expect(f.requests[1].signal.aborted).toBe(true);const discarded=f.resolve(1);await stale;await tick();expect(discarded.release).toHaveBeenCalledOnce();expect(f.controller.current).toBe(old);f.resolve(2);await last;expect(f.controller.current?.target.episode).toBe(3);expect(f.events).not.toContain('present:2:was:1');f.paint();});
  it('失败不会丢当前画面，原观看集数仍然可靠',async()=>{const f=fixture();const first=f.controller.select(target(8,30));await tick();const old=f.resolve(0);await first;const fail=f.controller.select(target(9));await tick();f.requests[1].reject(new Error('source unavailable'));await expect(fail).rejects.toThrow('source unavailable');expect(f.controller.current).toBe(old);expect(f.controller.current?.target.start).toBe(30);expect(old.release).not.toHaveBeenCalled();});
  it('已完成暖槽取消时会释放，关闭也释放活动槽',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();const old=f.resolve(0);await first;f.controller.warm(target(2));await tick();const warm=f.resolve(1);await tick();f.controller.cancelPending();expect(warm.release).toHaveBeenCalledOnce();await f.controller.close();expect(old.release).toHaveBeenCalledOnce();});
  it('一个后台槽，不预empt正在手动准备的集数',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();f.resolve(0);await first;const manual=f.controller.select(target(4));await tick();f.controller.warm(target(2));await tick();expect(f.requests).toHaveLength(2);f.resolve(1);await manual;f.paint();});
  it('播放源故障可以强制重建同一集零秒，不被相同目标短路',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();f.resolve(0);await first;const retry=f.controller.select(target(1),false,true);await tick();expect(f.requests).toHaveLength(2);f.resolve(1);await retry;expect(f.events).toContain('present:1:was:1');f.paint();});
  it('跨季同号首集使用另一槽预热并在原槽绘制后才释放',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();const old=f.resolve(0);await first;const next={...target(1),seriesId:'87654321'};const warm=f.controller.warm(next);await tick();expect(f.requests[1].index).toBe(1);const prepared=f.resolve(1);await warm;expect(f.controller.prepared(next)).toBe(true);await f.controller.select(next,true);expect(f.requests).toHaveLength(2);expect(f.controller.current).toBe(prepared);expect(old.release).not.toHaveBeenCalled();f.paint();await tick();expect(old.release).toHaveBeenCalledOnce();});
  it('等待首帧期间关闭自动播放或切换账号不会提交下季',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();const old=f.resolve(0);await first;let allowed=true;const next=f.controller.select({...target(1),seriesId:'87654321'},true,false,()=>allowed);await tick();allowed=false;const rejected=f.resolve(1);await expect(next).resolves.toBeNull();expect(f.controller.current).toBe(old);expect(rejected.release).toHaveBeenCalledOnce();expect(f.events).toEqual(['present:1:was:0','release:1']);});
  it('取消未完成暖槽后新请求等待旧槽清理，不并行占用第三个解码器',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();f.resolve(0);await first;const warm=f.controller.warm(target(2));await tick();const next=f.controller.select(target(3));await tick();expect(f.requests).toHaveLength(2);expect(f.requests[1].signal.aborted).toBe(true);const stale=f.resolve(1);await warm;await tick();expect(stale.release).toHaveBeenCalledOnce();expect(f.requests).toHaveLength(3);f.resolve(2);await next;f.paint();});
  it('迟到取消槽的异步释放完成之前不会启动替代解码',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();f.resolve(0);await first;const warm=f.controller.warm(target(2));await tick();const next=f.controller.select(target(3));const stale=f.resolve(1);let freed!:()=>void;stale.release=vi.fn(()=>new Promise<void>(resolve=>{freed=resolve;}));await tick();expect(f.requests).toHaveLength(2);expect(stale.release).toHaveBeenCalledOnce();freed();await warm;await tick();expect(f.requests).toHaveLength(3);f.resolve(2);await next;f.paint();});
  it('当前条件已经不允许提交时不会额外申请下一季槽',async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();const old=f.resolve(0);await first;await expect(f.controller.select({...target(1),seriesId:'87654321'},true,false,()=>false)).resolves.toBeNull();expect(f.requests).toHaveLength(1);expect(f.controller.current).toBe(old);});
});

describe('下一集预热的有界网络恢复',()=>{
  afterEach(()=>vi.useRealTimers());
  const playing=async()=>{const f=fixture();const first=f.controller.select(target(1));await tick();f.resolve(0);await first;return f;};
  it.each([
    new TypeError('Failed to fetch'),
    new DOMException('Request timed out','TimeoutError'),
    new Error("Error invoking remote method 'api:request': Error: fetch failed"),
    new Error("Error invoking remote method 'api:request': TimeoutError: The operation was aborted due to timeout"),
  ])('暂时网络错误 %s 在当前集继续播放时退避重试并保留暖槽',async error=>{
    vi.useFakeTimers();const f=await playing(),old=f.controller.current;
    const warming=f.controller.warm(target(2));await tick();f.requests[1].reject(error);
    await vi.advanceTimersByTimeAsync(999);expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);expect(f.requests).toHaveLength(3);
    expect(f.requests[2].signal).toBe(f.requests[1].signal);expect(f.requests[2].prewarm).toBe(true);
    const prepared=f.resolve(2);await expect(warming).resolves.toBe(prepared);
    expect(f.controller.current).toBe(old);expect(f.controller.prepared(target(2))).toBe(true);
    await f.controller.close();
  });
  it.each([
    new Error('这一集暂不可播放'),new Error('登录态已失效'),new Error('视频转码失败'),
    new TypeError('Cannot read properties of undefined'),new DOMException('network error','AbortError'),
  ])('稳定业务或取消错误 %s 不重复预热',async error=>{
    vi.useFakeTimers();const f=await playing(),warming=f.controller.warm(target(2));
    await tick();f.requests[1].reject(error);await expect(warming).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(60000);expect(f.requests).toHaveLength(2);
    await f.controller.close();
  });
  it('同目标重复预热共享预算，原请求加两次重试后停止',async()=>{
    vi.useFakeTimers();const f=await playing(),warming=f.controller.warm(target(2));
    await tick();const duplicate=f.controller.warm(target(2));f.requests[1].reject(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(1000);expect(f.requests).toHaveLength(3);
    const another=f.controller.warm(target(2));f.requests[2].reject(new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(2999);expect(f.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);expect(f.requests).toHaveLength(4);
    f.requests[3].reject(new DOMException('Timed out','TimeoutError'));
    await expect(Promise.all([warming,duplicate,another])).resolves.toEqual([null,null,null]);
    await vi.advanceTimersByTimeAsync(60000);expect(f.requests).toHaveLength(4);
    await f.controller.close();
  });
  it.each(['cancelPending','close'] as const)('退避期间 %s 立即终止后续预热',async action=>{
    vi.useFakeTimers();const f=await playing(),warming=f.controller.warm(target(2));
    await tick();f.requests[1].reject(new TypeError('fetch failed'));await vi.advanceTimersByTimeAsync(0);
    await f.controller[action]();await expect(warming).resolves.toBeNull();
    expect(f.requests[1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);expect(f.requests).toHaveLength(2);
    await f.controller.close();
  });
  it('改集取消旧退避，新的用户请求立即开始',async()=>{
    vi.useFakeTimers();const f=await playing(),warming=f.controller.warm(target(2));
    await tick();f.requests[1].reject(new TypeError('fetch failed'));await vi.advanceTimersByTimeAsync(0);
    const switching=f.controller.select(target(3));await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(3);expect(f.requests[2].target.episode).toBe(3);expect(f.requests[2].prewarm).toBe(false);
    f.resolve(2);await switching;f.paint();await expect(warming).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(60000);expect(f.requests).toHaveLength(3);await f.controller.close();
  });
  it('同目标用户选择接管退避中的 operation，不等待退避或重开预算',async()=>{
    vi.useFakeTimers();const f=await playing(),warming=f.controller.warm(target(2));
    await tick();f.requests[1].reject(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(1000);expect(f.requests).toHaveLength(3);
    f.requests[2].reject(new TypeError('fetch failed'));await vi.advanceTimersByTimeAsync(0);
    const switching=f.controller.select(target(2));const failed=expect(switching).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(0);expect(f.requests).toHaveLength(4);
    expect(f.requests[3].signal).toBe(f.requests[1].signal);
    f.requests[3].reject(new TypeError('fetch failed'));await failed;await expect(warming).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(60000);expect(f.requests).toHaveLength(4);await f.controller.close();
  });
  it('显式前台选择的网络错误按原语义立即失败，不做后台退避',async()=>{
    vi.useFakeTimers();const f=await playing(),switching=f.controller.select(target(2));
    await tick();f.requests[1].reject(new TypeError('fetch failed'));
    await expect(switching).rejects.toThrow('fetch failed');await vi.advanceTimersByTimeAsync(60000);
    expect(f.requests).toHaveLength(2);await f.controller.close();
  });
});
