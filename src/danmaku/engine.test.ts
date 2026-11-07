import { describe, it, expect } from 'vitest';
import { DanmakuEngine } from './engine';
import { defaultDanmaku, danmakuPreferences } from '../../shared/danmaku-settings';
const item = (id: number, time: number, text = '同步手机弹幕') => ({ id: String(12345678 + id), time, text });
const frame = (time: number, now: number, patch = {}) => ({ time, now, running: true, seeking: false, rate: 1, width: 1280, height: 720, preferences: defaultDanmaku, ...patch });
const engine = () => new DanmakuEngine((text, size) => [...text].length * size);
describe('真实媒体时间驱动的弹幕', () => {
  it('毫秒归一后的弹幕只在对应视频时间出现', () => {
    const e = engine(); e.merge([item(0, 2.925)]);
    expect(e.step(frame(2.8, 0))).toHaveLength(0);
    expect(e.step(frame(2.93, 130))[0].id).toBe('12345678');
  });
  it('暂停与缓冲冻结位置，恢复后不会按暂停的墙钟时间跳跃', () => {
    const e = engine(); e.merge([item(0, 1)]); e.step(frame(1, 0));
    const before = e.step(frame(1.2, 200));
    expect(e.step(frame(1.2, 3200, { running: false }))).toEqual(before);
    const after = e.step(frame(1.3, 3300));
    expect(before[0].x - after[0].x).toBeCloseTo(1280 / 9 * .1);
  });
  it('拖到未来清空旧画面，回看可重新看到对应时间的同一条弹幕', () => {
    const e = engine(); e.merge([item(0, 1), item(1, 40)]); e.step(frame(1, 0));
    expect(e.step(frame(35, 100, { seeking: true }))).toHaveLength(0);
    expect(e.step(frame(40, 5100))[0].id).toBe('12345679');
    e.step(frame(0, 5200, { seeking: true }));
    expect(e.step(frame(1, 6200))[0].id).toBe('12345678');
  });
  it('三倍速按场景时间出现但不把文字移动速度提高到三倍', () => {
    const e = engine(); e.merge([item(0, 3)]); e.step(frame(0, 0, { rate: 3 }));
    const first = e.step(frame(3, 1000, { rate: 3 }));
    const second = e.step(frame(3.6, 1200, { rate: 3 }));
    expect(first[0].x - second[0].x).toBeCloseTo(1280 / 9 * .2);
  });
  it('同轨文字在整个移动过程保持间隔，密集数据仍有界', () => {
    const e = engine(); e.merge(Array.from({ length: 120 }, (_, id) => item(id, id * .1)));
    for (let n = 0; n < 200; n++) {
      const shown = e.step(frame(n * .1, n * 100));
      expect(shown.length).toBeLessThan(50);
      for (let a = 0; a < shown.length; a++) for (let b = a + 1; b < shown.length; b++) if (shown[a].lane === shown[b].lane) {
        const [left, right] = [shown[a], shown[b]].sort((x, y) => x.x - y.x);
        expect(left.x + left.width + 27).toBeLessThan(right.x);
      }
    }
  });
  it('重复请求去重，关闭和屏蔽词不会显示不需要的内容', () => {
    const e = engine(); e.merge([item(0, 1), item(0, 1), item(1, 1, '屏蔽广告')]);
    expect(e.count).toBe(2);
    expect(e.step(frame(1, 0, { preferences: { ...defaultDanmaku, blockedWords: ['广告'] } }))).toHaveLength(1);
    expect(e.step(frame(1, 100, { preferences: { ...defaultDanmaku, enabled: false } }))).toHaveLength(0);
  });
  it('销毁播放器清空时间、数据和正在显示的文字', () => {
    const e = engine(); e.merge([item(0, 1)]); e.step(frame(1, 0)); e.clear();
    expect(e.count).toBe(0); expect(e.step(frame(2, 1000))).toEqual([]);
  });
  it('窗口不可见期间视频仍推进时，恢复后不会把旧弹幕带到新场景', () => {
    const e = engine(); e.merge([item(0, 1), item(1, 11)]); e.step(frame(1, 0));
    e.step(frame(10, 9000, { running: false }));
    const shown = e.step(frame(11, 10000));
    expect(shown.map(value => value.id)).toEqual(['12345679']);
  });
  it('旧设置和错误数值回退到可用默认值，不保留异常关键词数组', () => {
    expect(danmakuPreferences()).toEqual(defaultDanmaku);
    expect(danmakuPreferences({ opacity: NaN, blockedWords: [' ', '测试', '测试'] }).blockedWords).toEqual(['测试']);
    expect(danmakuPreferences({ opacity: .01 }).opacity).toBe(.25);
  });
  it('同一时间点的一批弹幕连续排队出现，不因每帧预算直接丢失', () => {
    const e = engine(); e.merge(Array.from({ length: 12 }, (_, id) => item(id, 1, '短弹幕' + id)));
    const seen = new Set<string>(), born: number[] = [];
    for (let n = 0; n < 360; n++) {
      for (const shown of e.step(frame(n / 60, n * 1000 / 60))) if (!seen.has(shown.id)) { seen.add(shown.id); born.push(n / 60); }
    }
    expect(seen.size).toBe(12); expect(born.at(-1)! - born[0]).toBeGreaterThan(2);
    expect(born.every((at, i) => !i || at - born[i - 1] >= .19)).toBe(true);
  });
  it('合并下一时间段保留正在滚动的弹幕，不清空整个画面', () => {
    const e = engine(); e.merge([item(1, 29)]); e.step(frame(29, 0));
    e.merge([item(2, 30)]); const next = e.step(frame(30, 1000));
    expect(next.map(item => item.id)).toContain('12345679');
    expect(e.step(frame(30.2,1200)).map(item=>item.id)).toEqual(['12345679','12345680']);
  });
  it('稀疏密度持续补位，不在达到数量上限后整批等待离场', () => {
    const e=engine();e.merge(Array.from({length:600},(_,id)=>item(id,id*.1,'连续弹幕内容'+id%5)));
    const preferences={...defaultDanmaku,fontSize:18,density:'sparse' as const};
    let empty=0,longest=0;
    for(let n=0;n<60*30;n++){
      const shown=e.step(frame(n*1.5/60,n*1000/60,{rate:1.5,preferences}));
      expect(shown.length).toBeLessThanOrEqual(12);
      if(n<60*8)continue;
      const middle=shown.some(item=>item.x<1280*.65&&item.x+item.width>1280*.35);
      empty=middle?0:empty+1;longest=Math.max(longest,empty);
    }
    expect(longest/60).toBeLessThan(.5);
  });
});
