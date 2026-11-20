import { ArrowLeft, ArrowRight, Bookmark, Check, ChevronRight, Clock3, Compass, Heart, Layers3, LoaderCircle, Maximize2, Minus, Play, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, Trophy, UserRound, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Genre, HistoryItem, Library, Series, SeriesDetail, Session, Settings as Preferences } from '../shared/contracts';
import Catalog from './components/Catalog';
import type { CatalogPage } from './components/Catalog';
import Account from './components/Account';
import Settings from './components/Settings';
import History from './components/History';
import Favorites from './components/Favorites';
import { continueWatching, continueWatchingLabel, detailPlaybackLabel, historyPlaybackTarget } from './history-query';
import { Dialog, Empty, Failure, Loading, Poster, message } from './components/ui';
import { clearPrivateCatalogs } from './catalog-cache';
import {mediaPreload} from './playback/MediaPreload';
import PlaybackPlaceholder from './components/PlaybackPlaceholder';
import SeasonOverview from './components/SeasonOverview';
import SearchBox from './components/SearchBox';
import brandIcon from '../assets/brand.png';
const loadPlayer=()=>import('./components/Player');
const Player = lazy(loadPlayer);

type Page = CatalogPage | 'favorites' | 'history' | 'account' | 'settings';
const defaults: Preferences = { theme: 'dark', quality: 'auto', rate: 1, autoplay: true, volume: .8, cacheGB: 4, closeToTray: true, bossKey: 'Ctrl+Shift+B' };
const emptyLibrary: Library = { history: [], favorites: [] };
const nav = [{ id: 'discover', title: '发现', icon: Compass }, { id: 'recommend', title: '为你推荐', icon: Sparkles }, { id: 'rank', title: '排行榜', icon: Trophy }, { id: 'browse', title: '探索片库', icon: Layers3 }];

export default function App() {
  const [page, setPage] = useState<Page>('discover'), [genre, setGenre] = useState<Genre>('short_play');
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<Preferences>(defaults), [library, setLibrary] = useState<Library>(emptyLibrary);
  const [booting, setBooting] = useState(true), [bootError, setBootError] = useState(''), [syncing, setSyncing] = useState(false), [toast, setToast] = useState('');
  const [detail, setDetail] = useState<SeriesDetail | null>(null), [detailId, setDetailId] = useState(''), [detailError, setDetailError] = useState(''), [episodeLimit, setEpisodeLimit] = useState(120);
  const [play, setPlay] = useState<{ key:number;detail: SeriesDetail; episode: number; position?: number } | null>(null), [selectedHistory, setSelectedHistory] = useState<HistoryItem | undefined>();
  const playbackSequence=useRef(0);
  const [playVisible, setPlayVisible] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const preloadTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [session, setSession] = useState<Session | null>(null);
  const account = useRef({ key: 'local' });
  const sessionRevision = useRef(0);
  const requests = useRef(0), toggling = useRef(new Set<string>()), latestSettings = useRef(settings), scroll = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const retryDetail = useRef<() => void>(undefined);
  const scrollPositions = useRef(new Map<string, number>()), restoringScroll = useRef(false);
  const contentKey = play && playVisible ? `player:${play.detail.series.id}` : `${page}:${page === 'search' ? query : ''}:${genre}`;
  const notify = useCallback((text: string) => setToast(text), []);
  const refreshLibrary = useCallback(async () => {
    const identity = account.current;
    const current = await window.hongguo.getLibrary();
    if (identity === account.current) setLibrary(current);
  }, []);
  const applySession = useCallback((value: Session) => {
    const key = value.loggedIn ? value.uid || 'local' : 'local';
    setSession(value);
    if (key === account.current.key) return;
    account.current = { key };
    requests.current++;
    retryDetail.current = undefined;
    clearTimeout(preloadTimer.current);
    toggling.current.clear();
    clearPrivateCatalogs();
    mediaPreload(window.hongguo).clear();
    setLibrary(emptyLibrary);
    setSelectedHistory(undefined);
    setDetailId('');
    setDetail(null);
    setDetailError('');
    setDrawer(false);
    setPlay(null);
    setPlayVisible(false);
    setSyncing(false);
    void refreshLibrary().catch(error => notify(message(error)));
  }, [notify, refreshLibrary]);
  const refreshSession = useCallback(async () => {
    const revision = ++sessionRevision.current;
    try {
      const current = await window.hongguo.request<Session>('/account/session');
      if (revision === sessionRevision.current) applySession(current);
    } catch { /* Offline libraries remain usable without an account request. */ }
  }, [applySession]);
  useEffect(()=>window.hongguo?.onLibrary(setLibrary),[]);
  useEffect(()=>window.hongguo?.onSettings(setSettings),[]);
  useEffect(() => window.hongguo?.onSession(value => {
    sessionRevision.current++;
    applySession(value);
  }), [applySession]);
  useEffect(()=>setHistoryRevision(value=>value+1),[library]);
  useEffect(() => { if (window.hongguo) void refreshSession(); }, [refreshSession]);
  useEffect(() => () => { clearTimeout(preloadTimer.current); if (window.hongguo) mediaPreload(window.hongguo).clear(); }, []);
  useEffect(()=>{
    const online=()=>{void window.hongguo?.setOnline?.(navigator.onLine).catch(()=>{});};
    online();window.addEventListener('online',online);window.addEventListener('offline',online);
    return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',online);};
  },[]);
  useEffect(()=>{
    if(session?.loggedIn&&(drawer||!playVisible&&(page==='history'||page==='favorites')))void window.hongguo.syncLibrary({background:true}).catch(()=>{});
  },[drawer,page,playVisible,session?.loggedIn,session?.uid]);
  const boot = useCallback(async () => {
    setBooting(true); setBootError('');
    const identity = account.current;
    try { const [preferences, local] = await Promise.all([window.hongguo.getSettings(), window.hongguo.getLibrary()]); setSettings(preferences); latestSettings.current = preferences; if (identity === account.current) setLibrary(local); }
    catch (e) { setBootError(message(e)); }
    finally { setBooting(false); }
  }, []);
  useEffect(() => { if (!window.hongguo) { setBooting(false); setBootError('桌面连接未就绪，请从红果桌面应用启动客户端。'); return; } void boot(); }, [boot]);
  useEffect(() => { latestSettings.current = settings; const system = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = settings.theme === 'system' ? system.matches ? 'dark' : 'light' : settings.theme; }; apply(); system.addEventListener('change', apply); return () => system.removeEventListener('change', apply); }, [settings.theme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); }, [toast]);
  const restoreScroll = useCallback((settled=false) => { if (!scroll.current) return; restoringScroll.current = true; scroll.current.scrollTop = scrollPositions.current.get(contentKey) || 0; const waitingForCatalog=!playVisible&&['discover','recommend','rank','browse','search'].includes(page);if(settled||!waitingForCatalog)requestAnimationFrame(() => { restoringScroll.current = false; }); }, [contentKey,page,playVisible]);
  const catalogReady=useCallback(()=>{restoreScroll(true);if(session?.loggedIn)void window.hongguo.syncLibrary({background:true}).catch(()=>{});},[restoreScroll,session?.loggedIn,session?.uid]);
  useLayoutEffect(()=>restoreScroll(), [restoreScroll]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !document.fullscreenElement && search.current?.getClientRects().length) { e.preventDefault(); search.current.focus(); search.current.select(); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);
  const saveSettings = useCallback(async (patch: Partial<Preferences>) => { const saved = await window.hongguo.saveSettings(patch); latestSettings.current = saved; setSettings(saved); }, []);
  const playerLibrary = useCallback(() => { void refreshLibrary().catch(e => notify(message(e))); }, [refreshLibrary, notify]);
  const playerSeries = useCallback((value:SeriesDetail)=>setPlay(previous=>previous?{...previous,detail:value}:previous),[]);
  const playerSettings = useCallback((patch: Partial<Preferences>) => { void saveSettings(patch).catch(e => notify(message(e))); }, [saveSettings, notify]);
  const closePlayer = useCallback(() => { setPlay(null); setPlayVisible(false); void refreshLibrary().catch(e => notify(message(e))); }, [refreshLibrary, notify]);
  const sync = useCallback(async () => {
    if (syncing) return;
    const identity = account.current;
    setSyncing(true);
    try {
      const result = await window.hongguo.syncLibrary();
      if (identity !== account.current) return;
      setLibrary(result.library);
      notify(result.warnings.length ? result.warnings.join('；') : '观看历史与收藏已同步');
    } catch (error) {
      if (identity === account.current) notify(`同步未完成：${message(error)}，本地记录仍可查看`);
    } finally {
      if (identity === account.current) setSyncing(false);
    }
  }, [notify, syncing]);
  const afterLogin = useCallback(async () => {
    await refreshSession();
    const identity = account.current;
    const result = await window.hongguo.syncLibrary();
    if (identity !== account.current) return;
    setLibrary(result.library);
    notify(result.warnings.length ? result.warnings.join('；') : '观看历史与收藏已同步');
  }, [notify, refreshSession]);
  const favorite = async (series: Series) => {
    const identity = account.current;
    if (toggling.current.has(series.id)) return;
    toggling.current.add(series.id);
    try {
      const current = await window.hongguo.toggleFavorite(series);
      if (identity === account.current) setLibrary(current);
    } catch (error) {
      if (identity === account.current) notify(message(error));
    } finally {
      if (identity === account.current) toggling.current.delete(series.id);
    }
  };
  const removeHistory = async (id: string) => {
    const identity = account.current;
    const current = await window.hongguo.removeHistory(id);
    if (identity === account.current) setLibrary(current);
  };
  const closeDetail = useCallback((preservePrepared=false) => {clearTimeout(preloadTimer.current);if(!preservePrepared)mediaPreload(window.hongguo).clear();requests.current++; setDetailId(''); setDetail(null); setDetailError(''); }, []);
  const prepareEpisode=(value:SeriesDetail,index:number,position=0)=>{mediaPreload(window.hongguo).prepare({seriesId:value.series.id,episode:index,quality:latestSettings.current.quality,start:position,duration:value.episodes.find(item=>item.index===index)?.duration});};
  const openDetail = async (series: Series, autoplay = false, progress?: HistoryItem) => {
    void loadPlayer().catch(()=>{});
    clearTimeout(preloadTimer.current);mediaPreload(window.hongguo).clear();
    setDrawer(false);
    const remembered = progress || library.history.find(item=>item.series.id===series.id); setSelectedHistory(remembered);
    const id = ++requests.current; setDetailId(series.id); setDetail(null); setDetailError(''); setEpisodeLimit(120);
    retryDetail.current = () => void openDetail(series, autoplay, remembered);
    try {
      const result = await window.hongguo.request<SeriesDetail>(`/catalog/series/${encodeURIComponent(series.id)}`);
      if (id !== requests.current) return;
      const target = historyPlaybackTarget(result.episodes, remembered);
      if (autoplay && target) {
        prepareEpisode(result, target.episode, target.position);
        setPlay({key: ++playbackSequence.current, detail: result, episode: target.episode, position: target.position});
        setPlayVisible(true);
        setDetailId('');
      } else {
        setDetail(result);
        if (target) preloadTimer.current = setTimeout(() => {
          if (requests.current === id) prepareEpisode(result, target.episode, target.position);
        }, 250);
      }
    }
    catch (e) { if (id === requests.current) setDetailError(message(e)); }
  };
  const start = (value: SeriesDetail, episode: number, position?: number) => {prepareEpisode(value,episode,position); closeDetail(true); setPlay({ key:++playbackSequence.current,detail: value, episode, position }); setPlayVisible(true); };
  const go = (next: Page) => { setPage(next); setPlayVisible(false); setDrawer(false); closeDetail(); };
  const catalogNavigate=(next:'browse'|'rank'|'recommend',nextGenre?:Genre)=>{if(nextGenre)setGenre(nextGenre);go(next);};
  const returnPlayer = () => { closeDetail(); setDrawer(false); setPlayVisible(true); };
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const recent = continueWatching(library.history);
  const currentHistory = detail ? selectedHistory?.series.id===detail.series.id?selectedHistory:library.history.find(item => item.series.id === detail.series.id) : undefined;
  const detailTarget = detail && historyPlaybackTarget(detail.episodes, currentHistory);
  const isFavorite = detail ? library.favorites.some(item => item.id === detail.series.id) : false;
  const playerView = play && <div className="playback-page" hidden={!playVisible}><Suspense fallback={<PlaybackPlaceholder series={play.detail.series}/>}><Player key={play.key} detail={play.detail} initialEpisode={play.episode} initialPosition={play.position} isActive={playVisible} settings={settings} accountKey={session?.uid || 'local'} onClose={closePlayer} onSettings={playerSettings} onLibrary={playerLibrary} onSeries={playerSeries} /></Suspense></div>;
  return <div className="app-shell app-topnav">
    <main className="app-main"><header className="app-header">
      <button className="top-brand" onClick={() => go('discover')} aria-label="红果桌面首页"><img className="brand-icon" src={brandIcon} alt=""/><strong>红果<span>桌面</span></strong></button>
      <nav className="top-nav" aria-label="主导航">{nav.map(item => <button key={item.id} aria-label={item.title} aria-current={page === item.id && !playVisible ? 'page' : undefined} className={page === item.id && !playVisible ? 'active' : ''} onClick={() => go(item.id as Page)}><item.icon size={18} /><span>{item.title}</span></button>)}</nav>
      <div className="header-drag-space" />
      <SearchBox inputRef={search} onSearch={value=>{setQuery(value);go('search');}} onSelect={series=>void openDetail(series)}/>
      <div className="header-tools"><button className={`header-shortcut icon-button ${page === 'history' && !play ? 'active' : ''}`} title="观看历史" aria-label="观看历史" onClick={() => go('history')}><Clock3 size={19} /></button><button className={`header-shortcut icon-button ${page === 'favorites' && !play ? 'active' : ''}`} title="我的收藏" aria-label="我的收藏" onClick={() => go('favorites')}><Heart size={19} /></button><button className={`my-library-button ${drawer ? 'active' : ''}`} aria-label="我的片库" aria-expanded={drawer} onClick={() => setDrawer(value => !value)}><Bookmark size={19} /><span>我的片库</span>{library.history.length > 0 && <i />}</button><button className={`header-account icon-button ${page === 'account' ? 'active' : ''} ${session?.loggedIn ? 'signed-in' : ''}`} aria-label={session?.loggedIn ? '我的账号' : '登录账号'} title={session?.loggedIn ? `${session.nickname || '已登录'} · 账号与同步` : '登录红果账号'} onClick={() => go('account')}><UserRound size={19} />{session?.loggedIn && <i />}</button><button className={`header-settings icon-button ${page === 'settings' ? 'active' : ''}`} onClick={() => go('settings')} aria-label="设置" title="设置"><Settings2 size={19} /></button></div>
      <div className="window-buttons"><button aria-label="最小化窗口" onClick={() => void window.hongguo?.window('minimize')}><Minus size={17} /></button><button aria-label="最大化或还原窗口" onClick={() => void window.hongguo?.window('maximize')}><Maximize2 size={14} /></button><button className="window-close" aria-label="关闭窗口" onClick={() => void window.hongguo?.window('close')}><X size={19} /></button></div>
    </header>
      {play && !playVisible && <div className="playback-resume-bar"><button aria-label="返回播放" onClick={returnPlayer}><Play size={16}/><span><strong>返回播放</strong><small>{play.detail.series.title}</small></span><ArrowRight size={16}/></button><span>播放已暂停 · 进度保留</span><button className="icon-button" aria-label="结束播放" title="结束播放" onClick={closePlayer}><X size={16}/></button></div>}
      <div className="content-scroll" ref={scroll} onScroll={e => { if (!restoringScroll.current) scrollPositions.current.set(contentKey, e.currentTarget.scrollTop); }}>{booting ? <Loading text="正在打开你的片库…" /> : bootError ? <Failure text={bootError} retry={boot} /> : !playVisible && (['discover', 'recommend', 'rank', 'browse', 'search'].includes(page) ? <Catalog page={page as CatalogPage} query={query} genre={genre} onGenre={setGenre} favorites={library.favorites} history={recent} accountKey={session?.uid || 'local'} onReady={catalogReady} onOpen={(series, immediate, progress) => void openDetail(series, immediate, progress)} onFavorite={series => void favorite(series)} onNavigate={catalogNavigate} /> : page === 'account' ? <Account onLibrary={afterLogin} notify={notify} /> : page === 'settings' ? <Settings settings={settings} onChange={saveSettings} notify={notify} /> : page === 'history' ? <History key={session?.uid || 'local'} onOpen={(series, immediate, progress)=>void openDetail(series, immediate, progress)} onRemove={removeHistory} onSync={sync} syncing={syncing} revision={historyRevision} notify={notify}/> : <Favorites key={session?.uid || 'local'} items={library.favorites} syncing={syncing} onSync={sync} onOpen={series=>void openDetail(series)} onFavorite={series=>void favorite(series)} onDiscover={()=>go('discover')}/>)}{!booting && !bootError && playerView}</div>
    </main>
    {drawer && <Dialog drawer title="我的片库" onClose={closeDrawer}><div className="drawer-heading"><span className="drawer-kicker">自己的片库</span><h2>我的片库</h2><p>继续观看，或者找回收藏的故事。</p></div><div className="drawer-shortcuts"><button aria-label="观看历史" onClick={() => go('history')}><Clock3 size={22} /><span><strong>观看历史</strong><small>{library.historyTotal ?? library.history.length} 部作品</small></span><ChevronRight size={16} /></button><button aria-label="我的收藏" onClick={() => go('favorites')}><Bookmark size={22} /><span><strong>我的收藏</strong><small>{library.favorites.length} 部作品</small></span><ChevronRight size={16} /></button></div><div className="drawer-section-title"><h3>接着看</h3>{library.history.length > 0 && <button aria-label="观看历史" onClick={() => go('history')}>查看全部<ArrowRight size={14} /></button>}</div>{recent.length ? <div className="drawer-history">{recent.map(item => <button key={item.series.id} onClick={() => void openDetail(item.series, true, item)} aria-label={`继续观看 ${item.series.title}`}><Poster cover={item.series.cover} title={item.series.title} /><span><strong>{item.series.title}</strong><small>{continueWatchingLabel(item)}</small></span><Play size={17} fill="currentColor" /></button>)}</div> : <Empty title={library.history.length ? '暂无可续看的剧集' : '还没有观看记录'} text={library.history.length ? '看完的剧仍保留在观看历史中。' : '看过的剧会自动保存在这里。'} />}<div className="drawer-footer"><button aria-label="我的账号" onClick={() => go('account')}><span className="drawer-account-icon"><UserRound size={21} /></span><span><strong>{session?.loggedIn ? session.nickname || '我的账号' : '登录账号'}</strong><small>{session?.loggedIn ? '已登录 · 账号与同步' : '登录后同步手机记录'}</small></span><ChevronRight size={16} /></button><button aria-label="设置" onClick={() => go('settings')}><Settings2 size={21} /><span>设置</span><ChevronRight size={16} /></button><p><ShieldCheck size={13} />本机记录 · 离线也可查看</p></div></Dialog>}
    {detailId && <Dialog title={detail?.series.title || '剧集详情'} onClose={closeDetail} wide>{!detail && !detailError ? <Loading text="正在加载剧集详情…" /> : detailError ? <Failure text={detailError} retry={() => retryDetail.current?.()} /> : detail && <><div className="detail-hero"><div className="detail-poster"><Poster cover={detail.series.cover} title={detail.series.title} /></div><div className="detail-copy"><span className="eyebrow">剧集详情</span><h2>{detail.series.title}</h2><div className="detail-meta"><span>{detail.episodes.length || detail.series.totalEpisodes} 集</span>{detail.series.score && <strong>{detail.series.score}</strong>}{detail.series.tags?.map(tag => <span key={tag}>{tag}</span>)}</div><p>{detail.series.intro || '暂无剧情简介。'}</p>{detail.series.actors?.length > 0 && <p className="detail-cast">主演：{detail.series.actors.join('、')}</p>}<div className="detail-actions"><button className="btn primary" disabled={!detailTarget} onClick={() => detailTarget && start(detail, detailTarget.episode, detailTarget.position)}><Play size={18} fill="currentColor" />{detailTarget ? detailPlaybackLabel(detailTarget) : '立即播放'}</button><button className={`btn secondary ${isFavorite ? 'favorite-saved' : ''}`} onClick={() => void favorite(detail.series)}>{isFavorite ? <Check size={17} /> : <Bookmark size={17} />}{isFavorite ? '已收藏' : '收藏'}</button></div></div></div><SeasonOverview key={detail.series.id} series={detail.series} onSelect={series=>void openDetail(series)}/><div className="detail-episodes"><div className="section-heading"><h3>选集播放</h3><span>{detail.episodes.length} 集</span></div>{detail.episodes.length ? <><div className="episode-grid">{detail.episodes.slice(0, episodeLimit).map(ep => <button key={ep.index} className={currentHistory?.episode === ep.index ? 'watched' : ''} onClick={() => start(detail, ep.index)} aria-label={`播放第 ${ep.index} 集`}>{String(ep.index).padStart(2, '0')}{currentHistory?.episode === ep.index && <Play size={10} />}</button>)}</div>{episodeLimit < detail.episodes.length && <button className="btn subtle episodes-more" onClick={() => setEpisodeLimit(n => n + 120)}>显示更多集数<ArrowRight size={15} /></button>}</> : <Empty title="暂时没有可播放的剧集" text="稍后再来查看这部作品。" />}</div></>}</Dialog>}
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>;
}
