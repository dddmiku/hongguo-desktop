import { ArrowRight, Bookmark, Check, Film, Grid2X2, Play, RefreshCw, Search, TrendingUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Genre, HistoryItem, Series } from '../../shared/contracts';
import { Empty, Failure, Poster, message } from './ui';
import { readCatalog, writeCatalog } from '../catalog-cache';
import type { CatalogResult, CatalogFilters } from '../catalog-cache';

export type CatalogPage = 'discover' | 'recommend' | 'rank' | 'browse' | 'search';
interface Props { page: CatalogPage; query: string; genre: Genre; accountKey: string; favorites: Series[]; history: HistoryItem[]; onOpen: (series: Series, play?: boolean) => void; onFavorite: (series: Series) => void; onGenre: (genre: Genre) => void; onReady?: () => void; }
const genres: { id: Genre; title: string }[] = [{ id: 'short_play', title: '真人短剧' }, { id: 'comic_series', title: '漫剧' }, { id: 'ai_series', title: 'AI 剧' }];
const titles = { discover: '发现好剧', recommend: '为你推荐', rank: '热播排行榜', browse: '探索片库', search: '搜索结果' };
const subtitles = { discover: '热门剧集与新故事，找到下一部想看的剧。', recommend: '来自红果推荐流，刷新看看更多故事。', rank: '按热度或更新时间，看看大家正在追什么。', browse: '按题材和排序筛选，轻松找到想看的作品。', search: '搜索剧名、演员或关键词。' };
interface FilterOption { id: string; name: string; }
const preferences = new Map<string, { board: string; sort: string; theme: string }>();
function route(page: CatalogPage, query: string, genre: Genre, board: string, sort: string, theme: string) {
  if (page === 'search') return `/catalog/search?q=${encodeURIComponent(query)}`;
  if (page === 'rank') return `/catalog/rank?board=${board}&genre=${genre}`;
  if (page === 'browse') return `/catalog/browse?genre=${genre}&sort=${sort}&theme=${encodeURIComponent(theme)}`;
  return `/catalog/home?genre=${genre}&mode=${page === 'recommend' ? 'recommend' : 'discover'}`;
}

export function SeriesCard({ series, index, favorite, onOpen, onFavorite }: { series: Series; index?: number; favorite: boolean; onOpen: () => void; onFavorite: () => void }) {
  return <article className="series-card"><button className="series-poster-button" onClick={onOpen} aria-label={`查看 ${series.title}`}><Poster cover={series.cover} title={series.title} />{index !== undefined && <span className={`rank-number rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>}<span className="poster-label">{series.totalEpisodes ? `${series.totalEpisodes} 集` : '连载中'}</span><span className="poster-play"><Play size={27} fill="currentColor" /></span></button><div className="series-info"><button className="series-title" onClick={onOpen}>{series.title}</button><button className={`card-favorite ${favorite ? 'saved' : ''}`} onClick={onFavorite} aria-label={`${favorite ? '取消收藏' : '收藏'} ${series.title}`}>{favorite ? <Check size={16} /> : <Bookmark size={16} />}</button><p>{series.tags?.slice(0, 2).join(' · ') || series.actors?.slice(0, 2).join(' · ') || '红果短剧'}</p></div></article>;
}

export default function Catalog({ page, query, genre, accountKey, favorites, history, onOpen, onFavorite, onGenre, onReady }: Props) {
  const saved = preferences.get(`${page}:${genre}`);
  const [reload, setReload] = useState(0), [board, setBoard] = useState(saved?.board || 'hot'), [sort, setSort] = useState(saved?.sort || 'hot_score'), [theme, setTheme] = useState(saved?.theme || '');
  const path = route(page, query, genre, board, sort, theme), cacheKey = path + (page === 'recommend' ? `#account=${accountKey}` : '');
  const initial = readCatalog(cacheKey);
  const [items, setItems] = useState<Series[]>(initial?.items || []), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [cursor, setCursor] = useState(''), [hasMore, setHasMore] = useState(false), [moreLoading, setMoreLoading] = useState(false);
  const [themes, setThemes] = useState<FilterOption[]>([]);
  const generation = useRef(0), scope = useRef(''), force = useRef(false), ready = useRef(onReady);
  ready.current = onReady;
  const [cached, setCached] = useState(!!initial), [updating, setUpdating] = useState(false), [slow, setSlow] = useState(false);
  const [moreError, setMoreError] = useState(false);
  useEffect(() => { preferences.set(`${page}:${genre}`, { board, sort, theme }); }, [page, genre, board, sort, theme]);
  useEffect(() => {
    const id = ++generation.current;
    const known = readCatalog(cacheKey), forced = force.current; force.current = false;
    let poll: ReturnType<typeof setTimeout> | undefined, polls = 0, first = true;
    const apply = (data: CatalogResult, retained = false) => { setItems(data.items || []); setCursor(data.cursor || ''); setHasMore(!!data.hasMore); setCached(retained || !!data.cached); setUpdating(!!data.updating); if (data.filters) setThemes(Array.isArray(data.filters) ? data.filters.find(f => f.type === 'category_dim_theme')?.items || [] : data.filters.themeOptions || (data.filters.themes || []).map(name => ({ id: name, name }))); };
    if (scope.current !== cacheKey) { if (known) apply(known, true); else { setItems([]); setCursor(''); setHasMore(false); setCached(false); } }
    scope.current = cacheKey;
    setLoading(true); setSlow(false); setError(''); setMoreError(false); setMoreLoading(false);
    if (known) requestAnimationFrame(() => ready.current?.());
    const slowTimer = setTimeout(() => { if (id === generation.current) setSlow(true); }, 6000);
    const request = async (refresh = false) => {
      try {
        const data = await window.hongguo.request<CatalogResult>(path + (refresh && (page === 'discover' || page === 'recommend') ? '&refresh=true' : ''));
        if (id !== generation.current) return;
        apply(data); writeCatalog(cacheKey, data); setError(data.warning || '');
        if (first) { first = false; requestAnimationFrame(() => ready.current?.()); }
        if (data.updating && polls++ < 10) poll = setTimeout(() => void request(), 1500);
        else setUpdating(false);
      } catch (e) { if (id === generation.current) { setError(message(e)); setUpdating(false); } }
      finally { if (id === generation.current) { setLoading(false); setSlow(false); clearTimeout(slowTimer); } }
    };
    void request(forced);
    return () => { generation.current++; clearTimeout(slowTimer); clearTimeout(poll); };
  }, [path, cacheKey, page, reload]);
  const refresh = () => { force.current = true; setReload(v => v + 1); };
  const loadMore = async () => {
    if (moreLoading || !hasMore) return;
    const id = generation.current; setMoreLoading(true);
    try {
      const data = await window.hongguo.request<{ items: Series[]; hasMore: boolean; cursor?: string }>(`/catalog/home?genre=${genre}&mode=${page === 'recommend' ? 'recommend' : 'discover'}&cursor=${encodeURIComponent(cursor)}`);
      if (id === generation.current) { setItems(current => { const items = [...current, ...data.items.filter(item => !current.some(s => s.id === item.id))]; writeCatalog(cacheKey, { ...data, items }); return items; }); setHasMore(data.hasMore); setCursor(data.cursor || ''); }
    } catch (e) { if (id === generation.current) { setError(message(e)); setMoreError(true); } }
    finally { if (id === generation.current) setMoreLoading(false); }
  };
  const ids = new Set(favorites.map(s => s.id)), hero = items[0];
  const filterBar = page !== 'search' && <div className="catalog-filter"><div className="genre-tabs" role="tablist" aria-label="作品类型">{genres.map(g => <button key={g.id} role="tab" aria-selected={genre === g.id} className={genre === g.id ? 'active' : ''} onClick={() => { onGenre(g.id); setTheme(''); }}>{g.title}</button>)}</div>{page === 'rank' && <div className="chips">{[{ id: 'hot', title: '热播榜' }, { id: 'new', title: '新剧榜' }].map(b => <button className={`chip ${board === b.id ? 'active' : ''}`} key={b.id} onClick={() => setBoard(b.id)}>{b.title}</button>)}</div>}{page === 'browse' && <div className="chips"><button className={`chip ${sort === 'hot_score' ? 'active' : ''}`} onClick={() => setSort('hot_score')}>热门</button><button className={`chip ${sort === 'online_time' ? 'active' : ''}`} onClick={() => setSort('online_time')}>最新</button>{themes.length > 0 && <select className="field compact" aria-label="题材" value={theme} onChange={e => setTheme(e.target.value)}><option value="">全部题材</option>{themes.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select>}</div>}</div>;
  return <div className="catalog-page"><div className="page-heading"><div><h1>{page === 'search' ? `“${query}” 的搜索结果` : titles[page]}</h1><p>{page === 'search' && !loading && !error ? `找到 ${items.length} 部作品` : subtitles[page]}</p></div><div className="catalog-refresh"><span className="catalog-status" role="status">{items.length ? loading || updating ? '片单已显示，正在更新' : cached ? '已显示最近片单' : '' : slow ? '首次连接较慢，正在准备片单…' : ''}</span><button className="btn subtle refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading || updating ? 'spin' : ''} />{page === 'recommend' ? '换一批' : '刷新'}</button></div></div>
    {(page !== 'discover' && page !== 'recommend' || !items.length) && filterBar}
    {loading && !items.length ? <>{(page === 'discover' || page === 'recommend') && <div className="hero-skeleton skeleton" />}<div className="series-grid">{Array.from({ length: 12 }, (_, i) => <div className="card-skeleton" key={i}><div className="skeleton" /><span className="skeleton" /><small className="skeleton" /></div>)}</div></> : error && !items.length ? <Failure text={error} retry={refresh} /> : !items.length ? <Empty title={page === 'search' ? '没有找到相关作品' : '暂时没有片单'} text={page === 'search' ? '试试完整剧名，或换一个关键词。' : '稍后刷新，看看有没有新故事。'} /> : <>
      {(page === 'discover' || page === 'recommend') && hero && <>
        <div className="feature-layout"><section className="hero feature-main"><div className="feature-backdrop"><Poster cover={hero.cover} title={hero.title} priority /><div /></div><div className="hero-copy"><span className="hero-kicker"><Film size={15} />{page === 'recommend' ? '为你挑选' : '现在值得看'}</span><h2>{hero.title}</h2><p>{hero.intro || '打开剧集详情，选择想看的那一集。'}</p><div className="hero-tags">{hero.tags?.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{hero.totalEpisodes > 0 && <span>{hero.totalEpisodes} 集</span>}</div><div className="hero-actions"><button className="btn primary" onClick={() => onOpen(hero, true)}><Play size={18} fill="currentColor" />立即播放</button><button className="feature-detail" onClick={() => onOpen(hero)}>剧集详情<ArrowRight size={16} /></button></div></div></section>
          {items.length > 1 && <aside className="feature-picks"><div className="feature-picks-label">也值得一看</div>{items.slice(1, 3).map(s => <button className="feature-secondary" key={s.id} onClick={() => onOpen(s)} aria-label={`查看 ${s.title}`}><Poster cover={s.cover} title={s.title} /><span className="feature-secondary-shade" /><span className="feature-secondary-info"><strong>{s.title}</strong><small>{s.tags?.slice(0, 2).join(' · ') || `${s.totalEpisodes} 集`}</small></span><span className="feature-secondary-play"><Play size={18} fill="currentColor" /></span></button>)}</aside>}
        </div>
        <div className="discovery-toolbar">{filterBar}<span className="discovery-count">{page === 'recommend' ? '推荐内容持续更新' : '选择一种，看看更多故事'}</span></div>
        {history.length > 0 && <section className="continue-section"><div className="continue-title"><h3>接着看</h3><span>从上次停下的地方继续</span></div><div className="continue-strip">{history.slice(0, 3).map(item => <button key={item.series.id} className="continue-card" onClick={() => onOpen(item.series, true)} aria-label={`继续观看 ${item.series.title}`}><Poster cover={item.series.cover} title={item.series.title} /><span><strong>{item.series.title}</strong><small>第 {item.episode} 集{item.position > 0 ? ` · ${Math.floor(item.position / 60)}:${String(Math.floor(item.position % 60)).padStart(2, '0')}` : ''}</small></span><Play size={16} fill="currentColor" /></button>)}</div></section>}
      </>}

      <div className="section-heading"><h2>{page === 'rank' ? <><TrendingUp size={21} />正在热播</> : page === 'search' ? <><Search size={21} />相关作品</> : <><Grid2X2 size={20} />{page === 'browse' ? '全部作品' : '值得追的故事'}</>}</h2><span>{items.length} 部作品</span></div>
      <div className="series-grid">{items.map((s, i) => <SeriesCard key={s.id} series={s} index={page === 'rank' ? i : undefined} favorite={ids.has(s.id)} onOpen={() => onOpen(s)} onFavorite={() => onFavorite(s)} />)}</div>
      {error && <div className="catalog-warning" role="status"><span>{items.length ? '已保留片单。' : ''}{error}</span><button className="btn subtle" onClick={moreError ? loadMore : refresh} disabled={loading || moreLoading}>重试<RefreshCw size={14} /></button></div>}{hasMore && <div className="load-more"><button className="btn secondary" disabled={moreLoading || loading} onClick={loadMore}>{moreLoading ? '正在加载…' : '加载更多故事'}<ArrowRight size={16} /></button></div>}
    </>}
  </div>;
}
