import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { DanmakuPreferences } from '../../shared/danmaku-settings';
import type { DanmakuStatus } from '../danmaku/feed';
import './Danmaku.css';
interface Props { preferences: DanmakuPreferences; status: DanmakuStatus; onChange: (value: Partial<DanmakuPreferences>) => void; onClose: () => void; onRefresh: () => void; onInteraction: () => void; }
export default function DanmakuPanel({ preferences: value, status, onChange, onClose, onRefresh, onInteraction }: Props) {
  const root = useRef<HTMLDivElement>(null), [words, setWords] = useState(value.blockedWords.join('，'));
  useEffect(() => { const close = (event: PointerEvent) => { if (event.target instanceof Element && !root.current?.contains(event.target) && !event.target.closest('.danmaku-settings-button')) onClose(); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [onClose]);
  return <div className="danmaku-panel" ref={root} role="dialog" aria-label="弹幕设置" onMouseMove={onInteraction} onClick={onInteraction} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header><div><strong>弹幕设置</strong><small>来自手机版的真实弹幕</small></div><button type="button" className="icon-button" aria-label="关闭弹幕设置" onClick={onClose}><X size={17}/></button></header>
    <label className="danmaku-setting"><span>不透明度 <small>{Math.round(value.opacity * 100)}%</small></span><input aria-label="弹幕不透明度" type="range" min=".25" max="1" step=".05" value={value.opacity} onChange={event => onChange({ opacity: Number(event.target.value) })}/></label>
    <label className="danmaku-setting"><span>字号</span><select aria-label="弹幕字号" value={value.fontSize} onChange={event => onChange({ fontSize: Number(event.target.value) as DanmakuPreferences['fontSize'] })}><option value="18">小</option><option value="22">适中</option><option value="26">大</option></select></label>
    <label className="danmaku-setting"><span>显示区域</span><select aria-label="弹幕显示区域" value={value.area} onChange={event => onChange({ area: Number(event.target.value) as DanmakuPreferences['area'] })}><option value=".25">顶部四分之一</option><option value=".5">顶部一半</option><option value="1">整个画面</option></select></label>
    <label className="danmaku-setting"><span>密度</span><select aria-label="弹幕密度" value={value.density} onChange={event => onChange({ density: event.target.value as DanmakuPreferences['density'] })}><option value="sparse">稀疏</option><option value="standard">适中</option><option value="dense">密集</option></select></label>
    <label className="danmaku-words"><span>屏蔽关键词</span><input aria-label="弹幕屏蔽关键词" placeholder="用逗号分隔，只影响此设备" maxLength={1000} value={words} onChange={event => setWords(event.target.value)}/><button type="button" onClick={() => onChange({ blockedWords: words.split(/[,，\n]/) })}>保存屏蔽词</button></label>
    <footer><span role="status">{status.error ? status.error : status.loading ? '正在同步手机弹幕…' : status.loaded ? `已同步 ${status.loaded} 条弹幕` : '本集暂未加载弹幕'}</span><button type="button" disabled={!value.enabled || status.loading} onClick={onRefresh}><RefreshCw size={14}/>{status.error ? '重试' : '刷新'}</button></footer>
  </div>;
}
