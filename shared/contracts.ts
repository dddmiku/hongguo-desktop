export type Genre = 'short_play' | 'comic_series' | 'ai_series';
export interface Series { id: string; title: string; cover: string; intro: string; totalEpisodes: number; tags: string[]; actors: string[]; score?: string; }
export interface Episode { index: number; vid: string; title: string; duration?: number; }
export interface SeriesDetail { series: Series; episodes: Episode[]; }
export interface HistoryItem { series: Series; episode: number; position: number; duration: number; watchedAt: number; uid: string; }
export interface Settings { theme: 'dark' | 'light' | 'system'; quality: string; rate: number; autoplay: boolean; volume: number; cacheGB: number; closeToTray: boolean; bossKey: string; }
export interface Library { history: HistoryItem[]; favorites: Series[]; }
export interface Session { loggedIn: boolean; uid: string; nickname: string; avatar: string; mobile: string; }
export interface Comment { id: string; text: string; nickname: string; avatar: string; likes: number; time: string; }
export interface CommentsPage { items: Comment[]; total: number; cursor: number; hasMore: boolean; }
export interface MediaSession { id: string; url: string; phase: 'preparing' | 'ready' | 'complete' | 'error' | 'cancelled'; error?: string; cached?: boolean; quality?: string; }
export interface CacheStatus { bytes: number; limit: number; entries: number; active: number; }
export interface Health { ok: boolean; version: string; signer: boolean; error?: string; }
export interface PlaybackProgress { series: Series; episode: number; position: number; duration: number; }
export interface UpdateInfo { available: boolean; version: string; notes: string; url: string; sha256: string; }
export interface UpdateTask { phase: string; downloaded: number; total: number; error?: string; }
export interface NativeBridge {
  request<T>(path: string, options?: { method?: string; body?: unknown; timeout?: number }): Promise<T>;
  getSettings(): Promise<Settings>; saveSettings(value: Partial<Settings>): Promise<Settings>;
  getLibrary(): Promise<Library>; saveProgress(value: PlaybackProgress): Promise<void>;
  toggleFavorite(series: Series): Promise<Library>; removeHistory(id: string): Promise<Library>;
  syncLibrary(): Promise<{ library: Library; warnings: string[] }>;
  window(action: 'minimize' | 'maximize' | 'close' | 'quit' | 'fullscreen' | 'exitfullscreen'): Promise<void | boolean>;
  openExternal(url: string): Promise<void>; exportDiagnostics(): Promise<string>;
  checkUpdate(): Promise<UpdateInfo>; downloadUpdate(info: UpdateInfo): Promise<void>;
  onUpdate(callback: (task: UpdateTask) => void): () => void;
  onVisibility(callback: (visible: boolean) => void): () => void;
  onShutdown(callback: () => Promise<void>): () => void;
  onLibrary(callback: (library: Library) => void): () => void;
  onSettings(callback: (settings: Settings) => void): () => void;
}
declare global { interface Window { hongguo: NativeBridge; } }
