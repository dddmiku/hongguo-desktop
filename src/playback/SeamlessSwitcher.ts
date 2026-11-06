export interface PlaybackTarget { seriesId: string; episode: number; quality: string; start: number; duration?: number; }
export interface PreparedDeck { index: number; target: PlaybackTarget; release(): void | Promise<void>; }
export interface DeckAdapter<T extends PreparedDeck> {
  prepare(index: number, target: PlaybackTarget, signal: AbortSignal): Promise<T>;
  present(next: T, previous: T | null, automatic: boolean): void;
  afterPresent(): Promise<void>;
}
const same = (a: PlaybackTarget, b: PlaybackTarget) => a.seriesId === b.seriesId && a.episode === b.episode && a.quality === b.quality && Math.abs(a.start - b.start) < .1;
type Operation<T> = { target: PlaybackTarget; warm: boolean; abort: AbortController; promise: Promise<T>; deck?: T };

/** Keep the displayed deck alive until the replacement has a decoded frame. */
export class SeamlessSwitcher<T extends PreparedDeck> {
  current: T | null = null;
  private pending: Operation<T> | null = null;
  private disposed = false;
  private available: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
  constructor(private adapter: DeckAdapter<T>) {}
  private operation(target: PlaybackTarget, warm: boolean): Operation<T> {
    if (this.pending && same(this.pending.target, target)) { if (!warm) this.pending.warm = false; return this.pending; }
    this.cancelPending();
    const index = this.current ? 1 - this.current.index : 0;
    const abort = new AbortController();
    const op: Operation<T> = { target, warm, abort, promise: undefined as unknown as Promise<T> };
    this.pending = op;
    op.promise = this.available[index].then(() => {
      if (abort.signal.aborted || this.disposed) throw new DOMException('Cancelled', 'AbortError');
      return this.adapter.prepare(index, target, abort.signal);
    }).then(deck => {
      if (abort.signal.aborted || this.disposed || this.pending !== op) { void deck.release(); throw new DOMException('Cancelled', 'AbortError'); }
      op.deck = deck;
      return deck;
    });
    // Warm preparation is allowed to fail without producing an unhandled rejection.
    void op.promise.catch(() => { if(this.pending===op&&op.warm&&!op.abort.signal.aborted)this.pending=null; });
    return op;
  }
  async select(target: PlaybackTarget, automatic = false, force = false): Promise<T | null> {
    if (this.disposed) return null;
    if (!force && this.current && same(this.current.target, target)) return this.current;
    const op = this.operation(target, false);
    try {
      const deck = await op.promise;
      if (this.disposed || this.pending !== op || op.abort.signal.aborted) return null;
      const previous = this.current;
      this.current = deck;
      this.pending = null;
      this.adapter.present(deck, previous, automatic);
      if (previous) this.available[previous.index] = this.adapter.afterPresent().then(() => previous.release()).then(() => {});
      return deck;
    } catch (error) {
      if (this.disposed || this.pending !== op || op.abort.signal.aborted) return null;
      this.pending = null;
      throw error;
    }
  }
  warm(target: PlaybackTarget) {
    if (this.disposed || !this.current || this.pending && !this.pending.warm || same(this.current.target, target)) return;
    this.operation(target, true);
  }
  cancelPending() { const op=this.pending;this.pending=null;op?.abort.abort();if(op?.deck)void op.deck.release(); }
  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending?.abort.abort();
    const pending = this.pending;
    this.pending = null;
    if (pending) await pending.promise.then(deck => deck.release()).catch(() => {});
    const current = this.current; this.current = null;
    if (current) await current.release();
    await Promise.allSettled(this.available);
  }
}
