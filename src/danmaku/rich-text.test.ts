import { describe, it, expect } from 'vitest';
import { danmakuParts, measureDanmaku, truncateDanmaku } from './rich-text';

describe('mobile emoji in danmaku', () => {
  it('parses genuine flower, applause, admiration and latest gecko expressions', () => {
    expect(danmakuParts('好看[爽][送花][鼓掌][爱慕][马上有福]').filter(part => part.kind === 'emoji').map(part => part.id)).toEqual(['50', '53', '51', '6', '54']);
  });
  it('leaves non-emoji brackets and unknown tokens as text', () => {
    expect(danmakuParts('第[2]集 [不存在的表情] <script> [ok]')).toEqual([{ kind: 'text', text: '第[2]集 [不存在的表情] <script> [ok]' }]);
  });
  it('measures images rather than the width of their bracket labels', () => {
    const measure = (text: string) => text.length * 10;
    expect(measureDanmaku('好[送花][鼓掌]看', 20, measure)).toBe(76);
  });
  it('never truncates half an emoji token or half a grapheme', () => {
    expect(truncateDanmaku('a'.repeat(69) + '[送花]后面')).toBe('a'.repeat(69) + '[送花]…');
    expect(truncateDanmaku('👍🏽👍🏽[爽]', 2)).toBe('👍🏽👍🏽…');
  });
});
