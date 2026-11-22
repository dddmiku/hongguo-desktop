export interface PlaybackTarget { seriesId: string; episode: number; quality: string; start: number; duration?: number; compatible?: boolean; }
import {isRetryableMediaRequestError} from '../../shared/media-request';
export interface PreparedDeck { index: number; target: PlaybackTarget; release(): void | Promise<void>; }
export interface DeckAdapter<T extends PreparedDeck> {
  prepare(index: number, target: PlaybackTarget, signal: AbortSignal, prewarm?:boolean): Promise<T>;
  present(next: T, previous: T | null, automatic: boolean): void;
  afterPresent(): Promise<void>;
}
const same = (a: PlaybackTarget, b: PlaybackTarget) => a.seriesId === b.seriesId && a.episode === b.episode && a.quality === b.quality && !!a.compatible === !!b.compatible && Math.abs(a.start - b.start) < .1;
const aborted=()=>new DOMException('Cancelled','AbortError');
const transientWarmFailure=(error:unknown)=>error instanceof Error&&error.name!=='AbortError'&&!/(?:^|:\s*)AbortError\b/.test(error.message)&&
  isRetryableMediaRequestError(error);
type Operation<T> = { index:number;target: PlaybackTarget; warm: boolean; retryWarm:boolean; prewarm:boolean; abort: AbortController; promise: Promise<T>; deck?: T; retryNow?:()=>void };

/** Keep the displayed deck alive until the replacement has a decoded frame. */
export class SeamlessSwitcher<T extends PreparedDeck> {
  current: T | null = null;
  private pending: Operation<T> | null = null;
  private disposed = false;
  private available: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
  private releases=new WeakMap<T,Promise<void>>();
  constructor(private adapter: DeckAdapter<T>) {}
  private release(deck:T){let promise=this.releases.get(deck);if(!promise){try{promise=Promise.resolve(deck.release()).then(()=>{}).catch(()=>{});}catch{promise=Promise.resolve();}this.releases.set(deck,promise);}return promise;}
  private retryDelay(op:Operation<T>,delay:number){
    return new Promise<void>((resolve,reject)=>{
      const finish=(error?:Error)=>{
        clearTimeout(timer);op.abort.signal.removeEventListener('abort',cancel);
        if(op.retryNow===wake)op.retryNow=undefined;
        error?reject(error):resolve();
      };
      const wake=()=>finish(),cancel=()=>finish(aborted());
      const timer=setTimeout(wake,delay);op.retryNow=wake;
      op.abort.signal.addEventListener('abort',cancel,{once:true});
      if(op.abort.signal.aborted)cancel();
    });
  }
  private prepare(op:Operation<T>,attempt=0):Promise<T>{
    if(op.abort.signal.aborted||this.disposed||this.pending!==op)return Promise.reject(aborted());
    const retry=(error:unknown):Promise<T>=>{
      // Automatic presentation inherits this warm operation's remaining budget,
      // not a fresh budget. A manual takeover retains immediate-error semantics.
      if(!op.retryWarm||attempt>=2||op.abort.signal.aborted||this.disposed||this.pending!==op||!transientWarmFailure(error))return Promise.reject(error);
      return this.retryDelay(op,attempt===0?1000:3000).then(()=>this.prepare(op,attempt+1));
    };
    try{return this.adapter.prepare(op.index,op.target,op.abort.signal,op.prewarm).catch(retry);}
    catch(error){return retry(error);}
  }
  private operation(target: PlaybackTarget, warm: boolean, automatic=false): Operation<T> {
    if (this.pending && same(this.pending.target, target)) {
      if(!warm){this.pending.warm=false;if(!automatic){this.pending.retryWarm=false;this.pending.retryNow?.();}}
      return this.pending;
    }
    this.cancelPending();
    const index = this.current ? 1 - this.current.index : 0;
    const abort = new AbortController();
    const op: Operation<T> = { index,target, warm, retryWarm:warm, prewarm:warm, abort, promise: undefined as unknown as Promise<T> };
    this.pending = op;
    op.promise = this.available[index].then(() => this.prepare(op)).then(deck => {
      if (abort.signal.aborted || this.disposed || this.pending !== op) { return this.release(deck).then(()=>{throw new DOMException('Cancelled', 'AbortError');}); }
      op.deck = deck;
      return deck;
    });
    // Warm preparation is allowed to fail without producing an unhandled rejection.
    void op.promise.catch(() => { if(this.pending===op&&op.warm&&!op.abort.signal.aborted)this.pending=null; });
    return op;
  }
  async select(target: PlaybackTarget, automatic = false, force = false,allowPresent:()=>boolean=()=>true): Promise<T | null> {
    if (this.disposed||!allowPresent()) return null;
    if (!force && this.current && same(this.current.target, target)) return this.current;
    const op = this.operation(target, false, automatic);
    try {
      const deck = await op.promise;
      if (this.disposed || this.pending !== op || op.abort.signal.aborted) return null;
      if(!allowPresent()){this.cancelPending();return null;}
      const previous = this.current;
      this.current = deck;
      this.pending = null;
      this.adapter.present(deck, previous, automatic);
      if (previous) this.available[previous.index] = this.adapter.afterPresent().then(() => this.release(previous)).then(() => {});
      return deck;
    } catch (error) {
      if (this.disposed || this.pending !== op || op.abort.signal.aborted) return null;
      this.pending = null;
      throw error;
    }
  }
  warm(target: PlaybackTarget) {
    if (this.disposed || !this.current || this.pending && !this.pending.warm || same(this.current.target, target)) return Promise.resolve(null);
    const op=this.operation(target, true);
    return op.promise.then(deck=>this.pending===op&&!op.abort.signal.aborted?deck:null).catch(()=>null);
  }
  prepared(target:PlaybackTarget){return !!this.pending?.warm&&!!this.pending.deck&&same(this.pending.target,target);}
  cancelPending() { const op=this.pending;this.pending=null;if(!op)return;op.abort.abort();if(op.deck)void this.release(op.deck);this.available[op.index]=Promise.allSettled([this.available[op.index],op.promise.then(deck=>this.release(deck))]).then(()=>{}); }
  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending?.abort.abort();
    const pending = this.pending;
    this.pending = null;
    if (pending) await pending.promise.then(deck => this.release(deck)).catch(() => {});
    const current = this.current; this.current = null;
    if (current) await this.release(current);
    await Promise.allSettled(this.available);
  }
}
