import { mobileEmojiIds } from '../../shared/mobile-emojis';

export type DanmakuPart = { kind: 'text'; text: string } | { kind: 'emoji'; text: string; id: string };
const emojiToken = /\[[A-Z\u4e00-\u9fa5]+\]/g;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

/** Only known official tokens become pictures. Ordinary brackets and unknown names stay intact. */
export function danmakuParts(text: string): DanmakuPart[] {
  const parts: DanmakuPart[] = []; let from = 0;
  for (const match of text.matchAll(emojiToken)) {
    const id = Object.hasOwn(mobileEmojiIds, match[0]) ? mobileEmojiIds[match[0]] : undefined;
    if (!id) continue;
    if (match.index! > from) parts.push({ kind: 'text', text: text.slice(from, match.index) });
    parts.push({ kind: 'emoji', text: match[0], id }); from = match.index! + match[0].length;
  }
  if (from < text.length) parts.push({ kind: 'text', text: text.slice(from) });
  return parts;
}

export function truncateDanmaku(text: string, limit = 70): string {
  const units = danmakuParts(text).flatMap(part => part.kind === 'emoji' ? [part.text] : [...segmenter.segment(part.text)].map(item => item.segment));
  return units.slice(0, limit).join('') + (units.length > limit ? '…' : '');
}

export const emojiSize = (fontSize: number) => fontSize * 1.4;
export function measureDanmaku(text: string, size: number, measureText: (text: string) => number): number {
  return danmakuParts(text).reduce((width, part) => width + (part.kind === 'emoji' ? emojiSize(size) : measureText(part.text)), 0);
}
