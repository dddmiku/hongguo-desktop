import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {LibrarySyncController,type SyncResult} from './library-sync';
const library={history:[],favorites:[]};
describe('automatic library synchronization',()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1700000000000);});
  afterEach(()=>vi.useRealTimers());
  const setup=()=>{
    const load=vi.fn(async():Promise<SyncResult>=>({library,warnings:[]})),publish=vi.fn();
    const sync=new LibrarySyncController({load,publish,library:()=>library});
    sync.setAccount('a');sync.setActive(true);return {sync,load,publish};
  };
  it('coalesces foreground triggers, observes a cooldown and refreshes periodically',async()=>{
    const {sync,load}=setup();await sync.request();await Promise.all([sync.request(),sync.request()]);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120000);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('does no polling while hidden, offline or logged out; reconnect refreshes without waiting',async()=>{
    const {sync,load}=setup();await sync.request();sync.setActive(false);await vi.advanceTimersByTimeAsync(240000);expect(load).toHaveBeenCalledTimes(1);
    sync.setOnline(false);sync.setActive(true);await vi.advanceTimersByTimeAsync(240000);expect(load).toHaveBeenCalledTimes(1);
    sync.setOnline(true);await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);
    sync.setAccount('local');await vi.advanceTimersByTimeAsync(240000);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('retries a partial cloud failure after 30s and keeps the local library',async()=>{
    const {sync,load}=setup();load.mockResolvedValueOnce({library,warnings:['offline'],retry:true});
    expect((await sync.request()).library).toBe(library);await vi.advanceTimersByTimeAsync(29999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('manual refresh bypasses freshness but shares an in-flight request',async()=>{
    const {sync,load}=setup();await sync.request();let release!:()=>void;
    load.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({library,warnings:[]});}));
    const first=sync.request(true),second=sync.request(true);await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);
    release();await Promise.all([first,second]);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('discards stale sync across logout/login even if the same uid returns',async()=>{
    const {sync,load,publish}=setup();let release!:()=>void;
    load.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({library,warnings:[]});}));
    const pending=sync.request();await vi.advanceTimersByTimeAsync(0);
    sync.setAccount('local');sync.setAccount('a');release();await pending;expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);expect(publish).toHaveBeenCalledTimes(1);sync.dispose();
  });
});
