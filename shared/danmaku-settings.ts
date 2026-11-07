export interface DanmakuPreferences {
  enabled: boolean;
  opacity: number;
  fontSize: 18 | 22 | 26;
  area: .25 | .5 | 1;
  density: 'sparse' | 'standard' | 'dense';
  blockedWords: string[];
}
export const defaultDanmaku: DanmakuPreferences = {
  enabled: true, opacity: .8, fontSize: 22, area: .5, density: 'standard', blockedWords: [],
};
export function danmakuPreferences(value?: Partial<DanmakuPreferences>): DanmakuPreferences {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : defaultDanmaku.enabled,
    opacity: typeof value?.opacity === 'number' && Number.isFinite(value.opacity) ? Math.max(.25, Math.min(1, value.opacity)) : defaultDanmaku.opacity,
    fontSize: [18, 22, 26].includes(value?.fontSize ?? 0) ? value!.fontSize! : defaultDanmaku.fontSize,
    area: [.25, .5, 1].includes(value?.area ?? 0) ? value!.area! : defaultDanmaku.area,
    density: ['sparse', 'standard', 'dense'].includes(value?.density ?? '') ? value!.density! : defaultDanmaku.density,
    blockedWords: Array.isArray(value?.blockedWords) ? [...new Set(value.blockedWords.filter(word => typeof word === 'string').map(word => word.trim().slice(0, 30)).filter(Boolean))].slice(0, 30) : [],
  };
}
