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
  it('refreshes a realtime view every 15s and coalesces foreground requests within 15s',async()=>{
    const {sync,load}=setup();sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);await Promise.all([sync.request(),sync.request()]);
    await vi.advanceTimersByTimeAsync(14999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);
    await sync.request();expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('immediately refreshes when entering a realtime view with data older than 15s',async()=>{
    const {sync,load}=setup();await sync.request();await vi.advanceTimersByTimeAsync(20000);
    sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('keeps a fresh result until its 15s cooldown expires instead of rereading on navigation',async()=>{
    const {sync,load}=setup();await sync.request();await vi.advanceTimersByTimeAsync(10000);
    sync.setRealtime(true);await vi.advanceTimersByTimeAsync(4999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('shares pending cloud work when realtime mode changes and schedules the next 15s cycle',async()=>{
    const {sync,load}=setup();let release!:()=>void;
    load.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({library,warnings:[]});}));
    const pending=sync.request();await vi.advanceTimersByTimeAsync(0);sync.setRealtime(true);
    const joined=sync.request();await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(1);
    release();await Promise.all([pending,joined]);await vi.advanceTimersByTimeAsync(14999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('stops realtime polling while hidden, offline or logged out and refreshes on reconnect',async()=>{
    const {sync,load}=setup();sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);
    sync.setActive(false);await vi.advanceTimersByTimeAsync(60000);expect(load).toHaveBeenCalledTimes(1);
    sync.setOnline(false);sync.setActive(true);await vi.advanceTimersByTimeAsync(60000);expect(load).toHaveBeenCalledTimes(1);
    sync.setOnline(true);await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);
    sync.setAccount('local');await vi.advanceTimersByTimeAsync(60000);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('does not postpone the default timer on repeated unchanged visibility, network and view state',async()=>{
    const {sync,load}=setup();await sync.request();
    for(let n=0;n<3;n++){await vi.advanceTimersByTimeAsync(30000);sync.setActive(true);sync.setOnline(true);sync.setRealtime(false);}
    await vi.advanceTimersByTimeAsync(29999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('does not postpone a realtime timer on repeated unchanged visibility and view state',async()=>{
    const {sync,load}=setup();sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10000);sync.setActive(true);sync.setRealtime(true);sync.setOnline(true);
    await vi.advanceTimersByTimeAsync(4999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('restores the 120s background cadence and 60s cooldown after leaving a realtime view',async()=>{
    const {sync,load}=setup();sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);sync.setRealtime(false);
    await vi.advanceTimersByTimeAsync(15000);await sync.request();expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(104999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('preserves the 30s failure retry even when switching into a realtime view',async()=>{
    const {sync,load}=setup();load.mockResolvedValueOnce({library,warnings:['offline'],retry:true});
    await sync.request();await vi.advanceTimersByTimeAsync(20000);sync.setRealtime(true);
    await vi.advanceTimersByTimeAsync(9999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);expect(load).toHaveBeenCalledTimes(3);sync.dispose();
  });
  it('discards stale realtime sync across account changes without publishing the previous account',async()=>{
    const {sync,load,publish}=setup();let release!:()=>void;sync.setRealtime(true);
    load.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({library,warnings:[]});}));
    await vi.advanceTimersByTimeAsync(0);sync.setAccount('local');sync.setAccount('a');
    release();await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);sync.dispose();
  });
  it('resumes a realtime view without bypassing the fresh-result cooldown',async()=>{
    const {sync,load}=setup();sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);sync.setActive(false);await vi.advanceTimersByTimeAsync(5000);sync.setActive(true);
    await vi.advanceTimersByTimeAsync(4999);expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('backs off rejected realtime requests for 30s rather than retrying every 15s',async()=>{
    const {sync,load}=setup();load.mockRejectedValueOnce(new Error('offline'));
    sync.setRealtime(true);await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(29999);
    expect(load).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
  it('retains the default 60s cooldown for foreground requests outside a realtime view',async()=>{
    const {sync,load}=setup();await sync.request();await vi.advanceTimersByTimeAsync(59999);
    await sync.request();expect(load).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);
    await sync.request();expect(load).toHaveBeenCalledTimes(2);sync.dispose();
  });
});
