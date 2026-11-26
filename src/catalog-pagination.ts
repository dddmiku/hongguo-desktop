export interface MergePage<T> { items:T[]; hasMore:boolean; cursor:string; }
/** Merge a resumed page with the prefix already on screen, preferring the reload's fresh cursor. */
export function mergeContinuation<T extends {id:string}>(prefix:T[], page:MergePage<T>):MergePage<T> {
  const ids = new Set(prefix.map(item => item.id));
  return { items: [...prefix, ...page.items.filter(item => !ids.has(item.id))], hasMore: !!page.hasMore, cursor: page.cursor || '' };
}
/** Only a live first page may hand out its continuation; cached prefixes cannot resume. */
export function resumableCursor(cached:boolean|undefined, cursor:string|undefined) {
  return cached ? '' : cursor || '';
}
// ipcRenderer.invoke only transports Error.message, so the provider's exact,
// fixed continuation-expired texts distinguish this recoverable case.
const EXPIRED_TEXTS = ['搜索结果已更新，请刷新后继续', '榜单已更新，请刷新后继续', '片单已更新，请刷新后继续浏览'];
export function isExpiredCursor(error:unknown) {
  const value = error as {code?:unknown; message?:unknown} | null;
  if (!value) return false;
  if (value.code === 'CURSOR_EXPIRED') return true;
  const text = String(value.message || '');
  return text.includes('CURSOR_EXPIRED') || EXPIRED_TEXTS.some(label => text.includes(label));
}
