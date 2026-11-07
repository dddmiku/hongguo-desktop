import type { DanmakuItem } from '../../shared/contracts';
import type { DanmakuPreferences } from '../../shared/danmaku-settings';
import { truncateDanmaku } from './rich-text';

export interface DanmakuFrame { id: string; text: string; x: number; y: number; width: number; fontSize: number; lane: number; }
interface Flight { item: DanmakuItem; text: string; width: number; lane: number; born: number; speed: number; }
interface Step { time: number; now: number; running: boolean; seeking: boolean; rate: number; width: number; height: number; preferences: DanmakuPreferences; }
const lowerBound = (rows: DanmakuItem[], time: number) => {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
};

/** Media time admits comments; a pausable clock keeps their text readable at any playback rate. */
export class DanmakuEngine {
  private data = new Map<string, DanmakuItem>();
  private rows: DanmakuItem[] = [];
  private consumed = new Set<string>();
  private flights: Flight[] = [];
  private waiting: DanmakuItem[] = [];
  private nextAdmission = 0;
  private cursor = 0;
  private clock = 0;
  private previousTime: number | undefined;
  private previousNow: number | undefined;
  private previousLayout = '';
  private previousRunning = false;
  private lastDisplayedTime: number | undefined;
  constructor(private measure: (text: string, size: number) => number) {}
  get count() { return this.data.size; }
  merge(items: DanmakuItem[]) {
    for (const item of items) if (item && /^\d{8,24}$/.test(item.id) && typeof item.text === 'string' && item.text.trim() && Number.isFinite(item.time) && item.time >= 0 && item.time <= 86400) this.data.set(item.id, { ...item, text: item.text.slice(0, 160) });
    this.rows = [...this.data.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    if (this.rows.length > 3000) { this.rows = this.rows.slice(-3000); this.data = new Map(this.rows.map(item => [item.id, item])); }
    this.cursor = lowerBound(this.rows, (this.previousTime ?? 0) - 3);
  }
  seek(time: number) {
    this.flights = []; this.waiting = []; this.nextAdmission = this.clock; this.consumed.clear(); this.cursor = lowerBound(this.rows, time - .15); this.previousTime = time;
  }
  clear() { this.data.clear(); this.rows = []; this.consumed.clear(); this.flights = []; this.waiting = []; this.nextAdmission = 0; this.cursor = 0; this.clock = 0; this.previousLayout = ''; this.previousTime = undefined; this.previousNow = undefined; this.lastDisplayedTime = undefined; }
  step(frame: Step): DanmakuFrame[] {
    const { time, now, running, seeking, rate, width, height, preferences: prefs } = frame;
    if (!Number.isFinite(time) || width < 1 || height < 1) return [];
    const elapsed = this.previousNow === undefined ? 0 : Math.max(0, (now - this.previousNow) / 1000);
    const jumped = this.previousTime !== undefined && (time < this.previousTime - .25 || time - this.previousTime > Math.max(1, elapsed * Math.max(1, rate) + .75));
    if (seeking || jumped || running && !this.previousRunning && this.lastDisplayedTime !== undefined && Math.abs(time - this.lastDisplayedTime) > .75) this.seek(time);
    if (running && !seeking) this.clock += Math.min(.25, elapsed);
    this.previousNow = now; this.previousTime = time;
    this.previousRunning = running;
    if (running && !seeking) this.lastDisplayedTime = time;
    const fontSize = prefs.fontSize * Math.max(.8, Math.min(1.4, width / 1280));
    const lineHeight = Math.ceil(fontSize * 1.5), top = Math.max(16, fontSize);
    const lanes = Math.max(1, Math.min(prefs.density === 'sparse' ? 4 : 10, Math.floor((Math.min(height - 85, height * prefs.area) - top) / lineHeight)));
    const layout = `${Math.round(width)}:${fontSize}:${lanes}`;
    if (layout !== this.previousLayout) { this.flights = []; this.previousLayout = layout; }
    if (!prefs.enabled) { this.flights = []; this.waiting = []; this.cursor = lowerBound(this.rows, time); return []; }
    const x = (flight: Flight) => width - (this.clock - flight.born) * flight.speed;
    this.flights = this.flights.filter(flight => flight.lane < lanes && x(flight) + flight.width > -20 && !prefs.blockedWords.some(word => flight.item.text.includes(word)));
    if (running && !seeking) {
      const capacity = prefs.density === 'sparse' ? 12 : prefs.density === 'dense' ? 50 : 30;
      while (this.cursor < this.rows.length && this.rows[this.cursor].time <= time) {
        const item = this.rows[this.cursor++];
        if (this.consumed.has(item.id)) continue;
        this.consumed.add(item.id);
        if (item.time < time - 3 || prefs.blockedWords.some(word => item.text.includes(word))) continue;
        this.waiting.push(item);
      }
      this.waiting = this.waiting.filter(item => item.time >= time - 8 && !prefs.blockedWords.some(word => item.text.includes(word))).slice(0, 120);
      const interval = prefs.density === 'sparse' ? .45 : prefs.density === 'dense' ? .1 : .2;
      if (this.waiting.length && this.clock >= this.nextAdmission && this.flights.length < capacity) {
        const item = this.waiting[0];
        const text = truncateDanmaku(item.text);
        const itemWidth = this.measure(text, fontSize), speed = Math.max(70, width / 9);
        let lane = -1;
        for (let candidate = 0; candidate < lanes; candidate++) {
          const last = this.flights.filter(flight => flight.lane === candidate).at(-1);
          if (!last || x(last) + last.width + 28 < width) { lane = candidate; break; }
        }
        if (lane >= 0) {
          this.waiting.shift();
          this.flights.push({ item, text, width: itemWidth, lane, born: this.clock, speed });
          this.nextAdmission = this.clock + interval;
        }
      }
    }
    return this.flights.map(flight => ({ id: flight.item.id, text: flight.text, x: x(flight), y: top + (flight.lane + 1) * lineHeight, width: flight.width, fontSize, lane: flight.lane }));
  }
}
