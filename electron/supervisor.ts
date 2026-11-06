import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { APP_VERSION } from '../shared/meta';

type SupervisorOptions = { startupTimeoutMs?: number; shutdownTimeoutMs?: number; killTimeoutMs?: number };

export class Supervisor {
  private child?: ChildProcessWithoutNullStreams;
  private port = 0;
  private token = randomBytes(32).toString('hex');
  private ready?: Promise<void>;
  private teardown?: Promise<void>;
  private stopTask?: Promise<void>;
  private closing = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
  private generation = 0;
  private stopping = false;
  private logLines: string[] = [];
  private startupTimeoutMs: number;
  private shutdownTimeoutMs: number;
  private killTimeoutMs: number;

  constructor(private root: string, private runtime: string, private data: string, options: SupervisorOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 65000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
    this.killTimeoutMs = options.killTimeoutMs ?? 5000;
  }

  private log(event: string) {
    this.logLines.push(JSON.stringify({ at: new Date().toISOString(), event }));
    this.logLines = this.logLines.slice(-300);
  }

  private exited(child: ChildProcessWithoutNullStreams) {
    return child.exitCode !== null || child.signalCode !== null;
  }

  async start(): Promise<void> {
    if (this.stopping) throw new Error('客户端正在退出');
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    const attempt = this.launch(generation);
    this.ready = attempt;
    try { await attempt; }
    catch (error) { if (this.ready === attempt) this.ready = undefined; throw error; }
  }

  private async launch(generation: number): Promise<void> {
    // 失败的 ready 可以重试，但旧进程的退出必须先得到确认。
    if (this.child && this.exited(this.child)) { this.child = undefined; this.teardown = undefined; }
    await this.teardown;
    if (this.stopping) throw new Error('客户端正在退出');
    if (this.child) await this.closeChild(this.child);
    return new Promise<void>((resolve, reject) => {
      const worker = spawn(path.join(this.runtime, 'python', 'python.exe'), ['-I', '-B', path.join(this.root, 'gateway.py')], {
        windowsHide: true,
        env: { ...process.env, HG_API_TOKEN: this.token, HG_DATA_DIR: this.data,
          HG_RUNTIME_DIR: this.runtime, HG_APP_VERSION: APP_VERSION, HG_VERSION: APP_VERSION, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = worker;
      let buffer = '', settled = false;
      const current = () => this.child === worker && this.generation === generation;
      const fail = (message: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (current()) this.port = 0;
        this.teardown = this.closeChild(worker);
        void this.teardown.catch(() => this.log('service_cleanup_failed'));
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('内容服务启动超时，请在设置里导出诊断后重试'), this.startupTimeoutMs);
      worker.stdout.on('data', (chunk: Buffer) => {
        if (settled || !current() || this.stopping) return;
        buffer += chunk.toString();
        if (buffer.length > 65536) buffer = buffer.slice(-8192);
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const data = JSON.parse(line);
            if (data.type === 'ready' && Number.isInteger(data.port) && data.port > 0 && data.port < 65536) {
              this.port = data.port; clearTimeout(timer); settled = true;
              this.log('service_ready'); resolve(); return;
            }
          } catch { /* 只解析协议行，不把潜在账号诊断文本存入日志。 */ }
        }
      });
      worker.stderr.on('data', () => this.log('service_diagnostic'));
      worker.on('error', () => fail('无法启动内容服务，运行时文件可能缺失'));
      worker.on('exit', (code) => {
        this.log('service_exit_' + code); clearTimeout(timer);
        if (current()) {
          this.port = 0; this.child = undefined;
          // 只有对应世代的退出能作废 ready，旧回调不能触及新实例。
          if (settled) this.ready = undefined;
        }
        if (!settled) {
          settled = true;
          reject(new Error(this.stopping ? '客户端正在退出' : '内容服务启动失败，请查看诊断'));
        }
      });
    });
  }

  private closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const previous = this.closing.get(child);
    if (previous) return previous;
    if (this.exited(child) || !child.pid) return Promise.resolve();
    const task = new Promise<void>((resolve, reject) => {
      let done = false;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (done) return;
        done = true; clearTimeout(graceTimer); clearTimeout(hardTimer);
        child.removeListener('exit', onExit); child.removeListener('close', onExit);
        if (!error && this.child === child) this.child = undefined;
        error ? reject(error) : resolve();
      };
      const onExit = () => finish();
      child.once('exit', onExit); child.once('close', onExit);
      const graceTimer = setTimeout(() => {
        if (this.exited(child)) { finish(); return; }
        this.log('service_force_stop');
        // 仅终止我们创建且尚未退出的 PID 树，不按进程名处理其它实例。
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => this.log('service_force_stop_failed'));
        } catch { this.log('service_force_stop_failed'); }
        hardTimer = setTimeout(() => {
          if (this.exited(child)) finish();
          else finish(new Error('旧内容服务尚未退出，已阻止重复启动，请退出客户端后重试'));
        }, this.killTimeoutMs);
      }, this.shutdownTimeoutMs);
      try { child.stdin.end(); } catch { this.log('service_stdin_close_failed'); }
      if (this.exited(child)) finish();
    });
    this.closing.set(child, task);
    return task;
  }

  async request<T>(route: string, options: { method?: string; body?: unknown; timeout?: number } = {}): Promise<T> {
    if (this.stopping) throw new Error('客户端正在退出');
    await this.start();
    if (this.stopping) throw new Error('客户端正在退出');
    const response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: options.method || 'GET', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(Math.min(options.timeout || 45000, 180000)),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.detail?.message ||
      (typeof data.detail === 'string' ? data.detail : '请求失败，请重试'));
    return data as T;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopping = true; this.port = 0;
    this.stopTask = (async () => {
      if (this.child) { this.teardown = this.closeChild(this.child); await this.teardown; }
      else if (this.teardown) await this.teardown;
    })();
    return this.stopTask;
  }

  async diagnostics() {
    const file = path.join(this.data, 'diagnostics.jsonl');
    await fs.writeFile(file, this.logLines.join('\n'), 'utf8'); return file;
  }
}
