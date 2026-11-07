import type { DanmakuPage, NativeBridge } from '../../shared/contracts';

export interface DanmakuStatus { loading: boolean; loaded: number; error: string; }
/** Windowed mobile reads. Replies from closed players and old identities never reach the overlay. */
export class DanmakuFeed {
  private generation = 0;
  private closed = false;
  private windows = new Map<number, DanmakuPage>();
  private pending = new Map<number, number>();
  private retries = new Map<number, number>();
  private ids = new Set<string>();
  private error = '';
  constructor(private scope: { seriesId: string; episode: number; vid: string },
              private request: NativeBridge['request'], private receive: (page: DanmakuPage) => void,
              private status: (value: DanmakuStatus) => void) {}
  private report() { if (!this.closed) this.status({ loading: this.pending.size > 0, loaded: this.ids.size, error: this.error }); }
  ensure(position: number, duration: number, refresh = false) {
    if (this.closed || !Number.isFinite(position) || position < 0) return;
    const bucket = Math.floor(position / 30);
    if (this.windows.has(bucket) || this.pending.has(bucket) || Date.now() < (this.retries.get(bucket) ?? 0)) return;
    const generation = this.generation;
    this.pending.set(bucket, generation); this.report();
    const query = new URLSearchParams({ seriesId: this.scope.seriesId, episode: String(this.scope.episode),
      position: String(bucket * 30), duration: String(Number.isFinite(duration) ? Math.max(0, duration) : 0), refresh: String(refresh) });
    void this.request<DanmakuPage>('/catalog/danmaku?' + query).then(page => {
      if (this.closed || generation !== this.generation) return;
      if (page?.source !== 'mobile' || page.seriesId !== this.scope.seriesId || page.vid !== this.scope.vid || !Array.isArray(page.items) || !Number.isFinite(page.start) || !Number.isFinite(page.end) || page.end <= page.start) throw new Error('弹幕返回的剧集或时间段不正确');
      const safe = { ...page, items: page.items.slice(0, 500).filter(item => item && /^\d{8,24}$/.test(item.id) && typeof item.text === 'string' && Number.isFinite(item.time) && item.time >= page.start - 1 && item.time <= page.end + 1) };
      this.windows.set(bucket, safe);
      while (this.windows.size > 12) this.windows.delete(this.windows.keys().next().value!);
      for (const item of safe.items) this.ids.add(item.id);
      this.receive(safe); this.error = ''; this.retries.delete(bucket);
    }).catch(error => {
      if (!this.closed && generation === this.generation) { this.error = error instanceof Error ? error.message : '手机弹幕暂时无法加载'; this.retries.set(bucket, Date.now() + 15000); }
    }).finally(() => { if (this.pending.get(bucket) === generation) this.pending.delete(bucket); this.report(); });
  }
  refresh(position: number, duration: number) { this.generation++; this.windows.clear(); this.pending.clear(); this.retries.clear(); this.error = ''; this.ensure(position, duration, true); }
  close() { this.closed = true; this.generation++; this.pending.clear(); this.windows.clear(); this.ids.clear(); }
}
