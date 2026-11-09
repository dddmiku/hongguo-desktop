import type { NativeBridge, QrLoginState, Session } from '../../shared/contracts';

export interface QrLoginView {
  id: string;
  status: 'idle' | 'loading' | QrLoginState['status'];
  expiresAt: number;
  pollAfter: number;
  message: string;
  imageDataUrl?: string;
  error?: { code: string; message: string };
}

interface Options {
  request: NativeBridge['request'];
  onState: (state: QrLoginView) => void;
  onConfirmed: (session: Session) => void | Promise<void>;
}

const terminal = new Set(['confirmed', 'expired', 'cancelled', 'failed']);
const active = new Set(['waiting', 'scanned', 'verifying']);
const idPattern = /^[a-f0-9]{32}$/;
const pollDelay = 1500, retryDelay = 2000, maxRetries = 3;

export function isQrImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 * 1024
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Lifecycle-owned login polling; only a public image and opaque local ID reach React. */
export class QrLoginController {
  private generation = 0;
  private closed = false;
  private visible = true;
  private id = '';
  private retries = 0;
  private completed = false;
  private pendingCreate: Promise<void> | null = null;
  private pendingPoll: { generation: number; promise: Promise<void> } | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  private retired = new Set<string>();
  private state: QrLoginView = { id: '', status: 'idle', expiresAt: 0, pollAfter: 1.5, message: '使用红果短剧 App 扫码登录' };

  constructor(private options: Options) {}

  private current(generation: number) { return !this.closed && generation === this.generation; }

  private emit(state: QrLoginView) {
    this.state = state;
    if (!this.closed) this.options.onState({ ...state });
  }

  private clearTimers() {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.pollTimer = this.expiryTimer = null;
    for (const [timer, resolve] of this.delays) { clearTimeout(timer); resolve(); }
    this.delays.clear();
  }

  private wait(delay: number) {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.delays.delete(timer); resolve(); }, delay);
      this.delays.set(timer, resolve);
    });
  }

  private retire(id: string) {
    if (!idPattern.test(id) || this.retired.has(id)) return;
    this.retired.add(id);
    if (this.retired.size > 32) this.retired.delete(this.retired.values().next().value!);
    const remove = async (attempt: number): Promise<void> => {
      try { await this.options.request(`/account/qr/${id}`, { method: 'DELETE', timeout: 10000 }); }
      catch { if (attempt < 2) setTimeout(() => { void remove(attempt + 1); }, 1000); }
    };
    void remove(0);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pendingCreate && this.state.status === 'loading') return this.pendingCreate;
    const generation = ++this.generation;
    this.clearTimers(); this.retire(this.id); this.id = ''; this.retries = 0; this.completed = false;
    this.emit({ id: '', status: 'loading', expiresAt: 0, pollAfter: 1.5, message: '正在生成登录二维码…' });
    const pending = (async () => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const data = await this.options.request<QrLoginState>('/account/qr', { method: 'POST', timeout: 35000 });
          if (!this.current(generation)) { if (data && typeof data.id === 'string') this.retire(data.id); return; }
          if (!data || !idPattern.test(data.id)) { this.fail('官网没有返回有效二维码，请刷新重试'); return; }
          this.id = data.id;
          this.apply(data, generation);
          this.schedule(generation);
          return;
        } catch {
          if (!this.current(generation)) return;
          if (attempt === maxRetries) { this.fail('暂时无法生成二维码，请稍后刷新重试'); return; }
          this.emit({ ...this.state, message: '网络暂时中断，正在重试…' });
          await this.wait(retryDelay);
          if (!this.current(generation)) return;
        }
      }
    })();
    this.pendingCreate = pending;
    void pending.finally(() => { if (this.pendingCreate === pending) this.pendingCreate = null; });
    return pending;
  }

  private fail(message: string, code = 'QR_LOGIN_FAILED') {
    this.clearTimers(); this.retire(this.id);
    this.emit({ ...this.state, imageDataUrl: undefined, status: 'failed', message, error: { code, message } });
  }

  private expired(expiresAt = this.state.expiresAt) {
    this.clearTimers(); this.retire(this.id);
    this.emit({ ...this.state, id: this.id, expiresAt, imageDataUrl: undefined, status: 'expired', message: '二维码已过期，请刷新后重新扫码' });
  }

  private checkExpiry() {
    if (active.has(this.state.status) && this.state.expiresAt > 0 && Date.now() >= this.state.expiresAt * 1000) {
      this.expired(); return true;
    }
    return false;
  }

  private armExpiry(generation: number) {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    if (!active.has(this.state.status) || this.state.expiresAt <= 0) return;
    const delay = Math.max(0, this.state.expiresAt * 1000 - Date.now());
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; if (this.current(generation)) this.checkExpiry(); }, delay);
  }

  private apply(data: QrLoginState, generation: number) {
    if (!this.current(generation) || terminal.has(this.state.status)) return;
    if (data.id !== this.id || (!active.has(data.status) && !terminal.has(data.status))) {
      this.fail('扫码登录状态已改变，请刷新二维码'); return;
    }
    if (data.status === 'confirmed') {
      const session = data.session;
      if (!session || session.loggedIn !== true || typeof session.uid !== 'string' || !session.uid) {
        this.fail('手机已确认，但账号数据暂未连接成功，请重试'); return;
      }
      this.clearTimers();
      this.emit({ id: this.id, status: 'confirmed', expiresAt: Number(data.expiresAt) || 0,
        pollAfter: 1.5, message: '扫码登录成功，已连接手机历史与收藏' });
      if (!this.completed) {
        this.completed = true;
        const clean: Session = { loggedIn: true, uid: session.uid, nickname: typeof session.nickname === 'string' ? session.nickname : '',
          avatar: typeof session.avatar === 'string' ? session.avatar : '', mobile: typeof session.mobile === 'string' ? session.mobile : '' };
        try { void Promise.resolve(this.options.onConfirmed(clean)).catch(() => {}); } catch { /* Account owns library feedback. */ }
      }
      return;
    }
    const expiresAt = Number(data.expiresAt);
    if (active.has(data.status) && (!Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt * 1000 > Date.now() + 600000)) {
      this.fail('二维码有效期异常，请刷新重试'); return;
    }
    if (active.has(data.status) && expiresAt * 1000 <= Date.now()) { this.expired(expiresAt); return; }
    const image = data.imageDataUrl === undefined ? this.state.imageDataUrl : data.imageDataUrl;
    if (active.has(data.status) && !isQrImage(image)) { this.fail('二维码图片暂时无法显示，请刷新重试'); return; }
    const serverMessage = typeof data.message === 'string' && data.message.length <= 300 ? data.message : '请刷新二维码重试';
    const next: QrLoginView = { id: this.id, status: data.status, expiresAt: expiresAt || 0,
      pollAfter: Math.max(1.5, Math.min(5, Number(data.pollAfter) || 1.5)), message: serverMessage,
      imageDataUrl: terminal.has(data.status) ? undefined : image };
    if (data.error && typeof data.error.code === 'string') next.error = { code: data.error.code, message: serverMessage };
    this.emit(next);
    if (terminal.has(data.status)) { this.clearTimers(); this.retire(this.id); }
    else if (!this.checkExpiry()) this.armExpiry(generation);
  }

  private schedule(generation: number, delay?: number) {
    if (!this.current(generation) || !this.visible || !this.id || !active.has(this.state.status) || this.checkExpiry()) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll(generation); }, delay ?? Math.max(pollDelay, this.state.pollAfter * 1000));
  }

  private poll(generation: number): Promise<void> {
    if (!this.current(generation) || !this.visible || !active.has(this.state.status) || this.checkExpiry()) return Promise.resolve();
    if (this.pendingPoll?.generation === generation) return this.pendingPoll.promise;
    const id = this.id;
    const pending = (async () => {
      let nextDelay: number | undefined;
      try {
        const data = await this.options.request<QrLoginState>(`/account/qr/${id}`, { timeout: 90000 });
        if (!this.current(generation) || terminal.has(this.state.status)) return;
        this.retries = 0; this.apply(data, generation);
      } catch {
        if (!this.current(generation) || terminal.has(this.state.status)) return;
        if (++this.retries > maxRetries) this.fail('扫码连接暂时不可用，请刷新二维码重试');
        else { this.emit({ ...this.state, message: '网络暂时中断，正在重试…' }); nextDelay = retryDelay; }
      } finally {
        if (this.pendingPoll?.generation === generation) this.pendingPoll = null;
        this.schedule(generation, nextDelay);
      }
    })();
    this.pendingPoll = { generation, promise: pending };
    return pending;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.closed || this.checkExpiry()) return;
    if (!visible) { if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null; }
    else if (this.id && active.has(this.state.status)) void this.poll(this.generation);
  }

  cancel() {
    if (this.closed) return;
    ++this.generation; this.clearTimers(); this.retire(this.id); this.id = '';
    this.emit({ id: '', status: 'cancelled', expiresAt: 0, pollAfter: 1.5, message: '已取消扫码登录，刷新二维码即可重试' });
  }

  close() {
    if (this.closed) return;
    this.cancel(); this.closed = true;
  }
}
