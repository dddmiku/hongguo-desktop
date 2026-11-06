import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Supervisor } from './supervisor';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

class Child extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { end: vi.fn() };
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor(readonly pid: number | undefined) { super(); }
  announce(port: number) { this.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'ready', port }) + '\n')); }
  exit(code = 0) { this.exitCode = code; this.emit('exit', code); this.emit('close', code); }
}

describe('内容服务进程监督', () => {
  const workers: Child[] = [], killers: Child[] = [];
  const supervisor = () => new Supervisor('service', 'runtime', 'data', {
    startupTimeoutMs: 100, shutdownTimeoutMs: 50, killTimeoutMs: 50,
  });
  const turn = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  beforeEach(() => {
    vi.useFakeTimers(); workers.length = 0; killers.length = 0;
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation((command: string) => {
      const child = new Child(1000 + workers.length + killers.length);
      (command === 'taskkill' ? killers : workers).push(child);
      return child;
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('启动超时先关旧stdin，旧进程退出前不会重复启动', async () => {
    const service = supervisor();
    const first = service.start().catch(error => error.message);
    await turn(); await vi.advanceTimersByTimeAsync(100);
    expect(await first).toContain('启动超时');
    expect(workers[0].stdin.end).toHaveBeenCalledTimes(1);
    const second = service.start(); await turn();
    expect(workers).toHaveLength(1);
    workers[0].exit(); await turn();
    expect(workers).toHaveLength(2);
    workers[1].announce(54002); await second;
    await service.request('/health');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:54002/health', expect.any(Object));
    const stop = service.stop(); workers[1].exit(); await stop;
  });

  it('旧进程迟到的ready和exit不会污染新端口或ready', async () => {
    const service = supervisor();
    const first = service.start().catch(() => {}); await turn();
    await vi.advanceTimersByTimeAsync(100); await first;
    const second = service.start(); workers[0].exit(); await turn();
    workers[1].announce(54002); await second;
    workers[0].announce(54001); workers[0].emit('exit', 1);
    await service.request('/health');
    expect(workers).toHaveLength(2);
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:54002/health', expect.any(Object));
    const stop = service.stop(); workers[1].exit(); await stop;
  });

  it('启动错误消费失败promise，旧child退出后可重试', async () => {
    const service = supervisor();
    const first = service.start().catch(error => error.message); await turn();
    workers[0].emit('error', new Error('fixture spawn error')); workers[0].exit(-2);
    expect(await first).toContain('无法启动');
    const second = service.start(); await turn(); workers[1].announce(55002); await second;
    expect(workers).toHaveLength(2);
    const stop = service.stop(); workers[1].exit(); await stop;
  });

  it('到期只终止自有PID树，收到旧child退出才启动新实例', async () => {
    const service = supervisor();
    const first = service.start().catch(() => {}); await turn();
    await vi.advanceTimersByTimeAsync(100); await first;
    const second = service.start(); await turn(); await vi.advanceTimersByTimeAsync(50);
    expect(killers).toHaveLength(1);
    expect(mocks.spawn).toHaveBeenCalledWith('taskkill', ['/PID', '1000', '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killers[0].exit(); await turn(); expect(workers).toHaveLength(1);
    workers[0].exit(); await turn(); workers[1].announce(54002); await second;
    const stop = service.stop(); workers[1].exit(); await stop;
  });

  it('强制终止也未确认退出时阻止并发新服务', async () => {
    const service = supervisor();
    const first = service.start().catch(() => {}); await turn();
    await vi.advanceTimersByTimeAsync(100); await first;
    const retry = service.start().catch(error => error.message); await turn();
    await vi.advanceTimersByTimeAsync(100);
    expect(await retry).toContain('阻止重复启动'); expect(workers).toHaveLength(1);
    workers[0].exit();
    const recovered = service.start(); await turn(); workers[1].announce(54002); await recovered;
    const stop = service.stop(); workers[1].exit(); await stop;
  });

  it('stop幂等并等待清理，停止后不再启动', async () => {
    const service = supervisor();
    const ready = service.start(); await turn(); workers[0].announce(54001); await ready;
    const first = service.stop(), second = service.stop();
    expect(first).toBe(second); expect(workers[0].stdin.end).toHaveBeenCalledTimes(1);
    workers[0].exit(); await first;
    await expect(service.request('/health')).rejects.toThrow('正在退出'); expect(workers).toHaveLength(1);
  });

  it('spawn在分配PID前失败也能恢复，不发送taskkill', async () => {
    const failed = new Child(undefined);
    mocks.spawn.mockImplementationOnce(() => { workers.push(failed); return failed; });
    const service = supervisor();
    const first = service.start().catch(error => error.message); await turn();
    failed.emit('error', new Error('fixture missing runtime'));
    expect(await first).toContain('无法启动');
    const retry = service.start(); await turn(); workers[1].announce(55002); await retry;
    expect(killers).toHaveLength(0);
    const stop = service.stop(); workers[1].exit(); await stop;
  });

  it('ready之前退出也清理pending启动，不等待65秒定时器', async () => {
    const service = supervisor();
    const ready = service.start().catch(error => error.message); await turn();
    const stop = service.stop(); workers[0].exit(); await stop;
    expect(await ready).toContain('正在退出');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('并发请求只启动一个服务', async () => {
    const service = supervisor();
    const reads = Promise.all([service.request('/health'), service.request('/account/session')]);
    await turn(); expect(workers).toHaveLength(1);
    workers[0].announce(55001); await reads;
    expect(fetch).toHaveBeenCalledTimes(2);
    const stop = service.stop(); workers[0].exit(); await stop;
  });
});
