import { AlertCircle, Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

export function Loading({ text = '正在加载…' }: { text?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={24} /><span>{text}</span></div>;
}
export function Empty({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit"><span /></div><h3>{title}</h3>{text && <p>{text}</p>}{children}</div>;
}
export function Failure({ text, retry }: { text: string; retry: () => void }) {
  return <div className="error-state" role="alert"><AlertCircle size={22} /><div><h3>暂时没有加载成功</h3><p>{text}</p></div><button className="btn secondary" onClick={retry}><RefreshCw size={16} />重新加载</button></div>;
}
export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <button className={`switch ${checked ? 'checked' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span>{checked && <Check size={11} />}</span></button>;
}
export function Dialog({ children, title, onClose, wide = false, drawer = false }: { children: ReactNode; title: string; onClose: () => void; wide?: boolean; drawer?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const items = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, [onClose]);
  return <div className={`dialog-layer ${drawer ? 'drawer-layer' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`dialog ${wide ? 'wide' : ''} ${drawer ? 'drawer' : ''}`} ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}><button className="icon-button dialog-close" onClick={onClose} aria-label="关闭"><X size={20} /></button>{children}</div></div>;
}

export function Poster({ cover, title, className = '', priority = false }: { cover: string; title: string; className?: string; priority?: boolean }) {
  const [failedCover, setFailedCover] = useState('');
  return cover && failedCover !== cover ? <img className={`poster ${className}`} src={cover} alt={title} loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : 'auto'} decoding="async" onError={() => setFailedCover(cover)} /> : <div className={`poster poster-placeholder ${className}`} aria-label={title}>{title.slice(0, 1)}</div>;
}
