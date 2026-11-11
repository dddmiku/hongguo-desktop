import { ArrowRight, Bookmark, Check, ChevronDown, ChevronUp, Film, Grid2X2, Play, RefreshCw, Search, SlidersHorizontal, TrendingUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Genre, HistoryItem, Series } from '../../shared/contracts';
import { Empty, Failure, Poster, message } from './ui';
import { readCatalog, writeCatalog } from '../catalog-cache';
import type { CatalogFilterGroup, CatalogResult } from '../catalog-cache';
import { catalogGroups, catalogRoute, categoryKeys, categorySelected, readCatalogSelection, saveCatalogSelection } from '../catalog-filters';
import type { CatalogPage, CatalogSelection } from '../catalog-filters';
import Discovery, { DiscoverySkeleton } from './Discovery';
import type { DiscoveryDestination } from './Discovery';
import './Catalog.css';

export type { CatalogPage } from '../catalog-filters';
interface Props { page: CatalogPage; query: string; genre: Genre; accountKey: string; favorites: Series[]; history: HistoryItem[]; onOpen: (series: Series, play?: boolean) => void; onFavorite: (series: Series) => void; onGenre: (genre: Genre) => void; onReady?: () => void; onNavigate?: (page: DiscoveryDestination, genre?: Genre) => void; }
const genres: { id: Genre; title: string }[] = [{ id: 'short_play', title: '真人短剧' }, { id: 'comic_series', title: '漫剧' }, { id: 'ai_series', title: 'AI 剧' }];
const titles = { discover: '发现好剧', recommend: '为你推荐', rank: '热播排行榜', browse: '探索片库', search: '搜索结果' };
const subtitles = { discover: '热门剧集与新故事，找到下一部想看的剧。', recommend: '来自红果推荐流，刷新看看更多故事。', rank: '按热度或更新时间，看看大家正在追什么。', browse: '按题材和排序筛选，轻松找到想看的作品。', search: '搜索剧名、演员或关键词。' };

export function SeriesCard({ series, index, favorite, onOpen, onFavorite }: { series: Series; index?: number; favorite: boolean; onOpen: () => void; onFavorite: () => void }) {
  return <article className="series-card" data-series-id={series.id}><button className="series-poster-button" onClick={onOpen} aria-label={`查看 ${series.title}`}><Poster cover={series.cover} title={series.title} />{index !== undefined && <span className={`rank-number rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>}<span className="poster-label">{series.totalEpisodes ? `${series.totalEpisodes} 集` : '连载中'}</span><span className="poster-play"><Play size={27} fill="currentColor" /></span></button><div className="series-info"><button className="series-title" onClick={onOpen}>{series.title}</button><button className={`card-favorite ${favorite ? 'saved' : ''}`} onClick={onFavorite} aria-label={`${favorite ? '取消收藏' : '收藏'} ${series.title}`}>{favorite ? <Check size={16} /> : <Bookmark size={16} />}</button><p>{series.tags?.slice(0, 2).join(' · ') || series.actors?.slice(0, 2).join(' · ') || '红果短剧'}</p></div></article>;
}

export default function Catalog({ page, query, genre, accountKey, favorites, history, onOpen, onFavorite, onGenre, onReady, onNavigate }: Props) {
  const preferenceKey = `${page}:${genre}`;
  const [selection, setSelection] = useState(() => ({ scope: preferenceKey, value: readCatalogSelection(preferenceKey) }));
  const selected = selection.scope === preferenceKey ? selection.value : readCatalogSelection(preferenceKey);
  const changeSelection = (patch: Partial<CatalogSelection>) => { const value = { ...selected, ...patch }; saveCatalogSelection(preferenceKey, value); setSelection({ scope: preferenceKey, value }); };
  const [reload, setReload] = useState(0), [filterReload, setFilterReload] = useState(0);
  const path = catalogRoute(page, query, genre, selected), cacheKey = path + (page === 'recommend' ? `#account=${accountKey}` : '');
  const initial = readCatalog(cacheKey);
  const [items, setItems] = useState<Series[]>(initial?.items || []), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [cursor, setCursor] = useState(''), [hasMore, setHasMore] = useState(false), [moreLoading, setMoreLoading] = useState(false);
  const [filterState, setFilterState] = useState<{ genre: Genre; groups: CatalogFilterGroup[] }>(() => ({ genre, groups: catalogGroups(initial?.filters || readCatalog(`/catalog/filters?genre=${genre}`)?.filters) }));
  const groups = filterState.genre === genre ? filterState.groups : catalogGroups(readCatalog(`/catalog/filters?genre=${genre}`)?.filters);
  const [filterLoading, setFilterLoading] = useState(false), [filterError, setFilterError] = useState('');
  const generation = useRef(0), scope = useRef(''), force = useRef(false), ready = useRef(onReady);
  ready.current = onReady;
  const [cached, setCached] = useState(!!initial), [updating, setUpdating] = useState(false), [slow, setSlow] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const showCategories = page === 'browse', filtered = showCategories && categorySelected(selected);
  useEffect(() => {
    if (!showCategories) return;
    const key = `/catalog/filters?genre=${genre}`, known = readCatalog(key);
    let cancelled = false;
    if (known?.filters) setFilterState({ genre, groups: catalogGroups(known.filters) });
    setFilterLoading(!known?.filters); setFilterError('');
    void window.hongguo.request<CatalogResult>(key).then(data => {
      if (cancelled) return;
      setFilterState({ genre, groups: catalogGroups(data.filters) }); writeCatalog(key, data);
    }).catch(error => { if (!cancelled) setFilterError(message(error)); }).finally(() => { if (!cancelled) setFilterLoading(false); });
    return () => { cancelled = true; };
  }, [genre, showCategories, filterReload]);
  useEffect(() => {
    const id = ++generation.current;
    const known = readCatalog(cacheKey), forced = force.current; force.current = false;
    let poll: ReturnType<typeof setTimeout> | undefined, polls = 0, first = true;
    const apply = (data: CatalogResult, retained = false) => { const keep = page === 'discover' && !data.items?.length && !!readCatalog(cacheKey)?.items.length; if (!keep) { setItems(data.items || []); setCursor(data.cursor || ''); setHasMore(!!data.hasMore); } setCached(keep || retained || !!data.cached); setUpdating(!!data.updating); if (data.filters) { setFilterState({ genre, groups: catalogGroups(data.filters) }); setFilterError(''); } };
    if (scope.current !== cacheKey) { if (known) apply(known, true); else { setItems([]); setCursor(''); setHasMore(false); setCached(false); } }
    scope.current = cacheKey;
    setLoading(true); setSlow(false); setError(''); setMoreError(false); setMoreLoading(false);
    if (known) requestAnimationFrame(() => ready.current?.());
    const slowTimer = setTimeout(() => { if (id === generation.current) setSlow(true); }, 6000);
    const request = async (refresh = false) => {
      try {
        const data = await window.hongguo.request<CatalogResult>(path + (refresh && (page === 'discover' || page === 'recommend' || page === 'search') ? '&refresh=true' : ''));
        if (id !== generation.current) return;
        apply(data); writeCatalog(cacheKey, data); setError(data.warning || '');
        if (first) { first = false; requestAnimationFrame(() => ready.current?.()); }
        if (data.updating && polls++ < 10) poll = setTimeout(() => void request(), 1500);
        else setUpdating(false);
      } catch (e) { if (id === generation.current) { setError(message(e)); setUpdating(false); } }
      finally { if (id === generation.current) { setLoading(false); setSlow(false); clearTimeout(slowTimer); if (first) { first = false; requestAnimationFrame(() => ready.current?.()); } } }
    };
    void request(forced);
    return () => { generation.current++; clearTimeout(slowTimer); clearTimeout(poll); };
  }, [path, cacheKey, page, reload]);
  const refresh = () => { force.current = true; setReload(v => v + 1); };
  const loadMore = async () => {
    if (moreLoading || !hasMore) return;
    const id = generation.current; setMoreLoading(true);
    try {
      const data = await window.hongguo.request<CatalogResult>(`${path}&cursor=${encodeURIComponent(cursor)}`);
      if (id === generation.current) { setItems(current => { const items = [...current, ...data.items.filter(item => !current.some(s => s.id === item.id))]; writeCatalog(cacheKey, { ...data, filters: data.filters || { groups }, items }); return items; }); setHasMore(!!data.hasMore); setCursor(data.cursor || ''); setError(data.warning || ''); setMoreError(false); }
    } catch (e) { if (id === generation.current) { setError(message(e)); setMoreError(true); } }
    finally { if (id === generation.current) setMoreLoading(false); }
  };
  // A cached page must already have its full height when the parent's layout effect restores scrolling.
  const visibleItems = scope.current === cacheKey ? items : initial?.items || [];
  const ids = new Set(favorites.map(s => s.id)), hero = visibleItems[0];
  const filterBar = page !== 'search' && <div className="catalog-filter"><div className="genre-tabs" role="tablist" aria-label="作品类型">{genres.map(g => <button key={g.id} role="tab" aria-selected={genre === g.id} className={genre === g.id ? 'active' : ''} onClick={() => onGenre(g.id)}>{g.title}</button>)}</div>{page === 'rank' && <div className="chips">{[{ id: 'hot', title: '热播榜' }, { id: 'new', title: '新剧榜' }].map(b => <button className={`chip ${selected.board === b.id ? 'active' : ''}`} key={b.id} onClick={() => changeSelection({ board: b.id })}>{b.title}</button>)}</div>}{(page === 'browse' || filtered) && <div className="chips catalog-sorts" role="group" aria-label="片单排序">{[{ id: 'hot_score', name: '热门' }, { id: 'online_time', name: '最新' }, { id: 'hot_collect', name: '收藏最多' }].map(option => <button key={option.id} className={`chip ${selected.sort === option.id ? 'active' : ''}`} aria-pressed={selected.sort === option.id} onClick={() => changeSelection({ sort: option.id })}>{option.name}</button>)}</div>}</div>;
  const activeFilters = groups.flatMap(group => { const key = categoryKeys[group.type], option = group.items.find(item => item.id === selected[key]); return option ? [{ key, name: option.name }] : []; });
  const categoryPanel = showCategories && <section className={`category-shelf ${selected.expanded ? 'expanded' : ''}`} aria-label="剧集分类"><div className="category-shelf-heading"><span><SlidersHorizontal size={16} />按分类找剧</span><button className="category-expand" aria-expanded={selected.expanded} aria-controls="catalog-categories" onClick={() => changeSelection({ expanded: !selected.expanded })}>{selected.expanded ? '收起分类' : '全部分类'}{selected.expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button></div><div id="catalog-categories">{groups.filter(group => selected.expanded || group.type === 'category_dim_theme').map(group => { const key = categoryKeys[group.type]; return <div className={`category-row category-${key}`} key={group.type} role="group" aria-label={group.name}><span className="category-row-label">{group.name}</span><div className="category-options"><button className={!selected[key] ? 'active' : ''} aria-pressed={!selected[key]} onClick={() => changeSelection({ [key]: '' })}>全部</button>{group.items.map(option => <button key={option.id} className={selected[key] === option.id ? 'active' : ''} aria-pressed={selected[key] === option.id} onClick={() => changeSelection({ [key]: option.id })}>{option.name}</button>)}</div></div>; })}</div>{!groups.length && <div className="category-loading" role="status">{filterLoading ? '正在读取剧集分类…' : filterError ? '分类暂时未能加载' : '当前类型暂未提供分类'}</div>}{filterError && <div className="category-error"><span>{groups.length ? '已保留最近分类。' : ''}{filterError}</span><button onClick={() => setFilterReload(value => value + 1)}>重试<RefreshCw size={13} /></button></div>}{filtered && <div className="category-selection" aria-label="已选分类"><span>已选</span>{activeFilters.map(option => <button key={option.key} onClick={() => changeSelection({ [option.key]: '' })} aria-label={`移除${option.name}筛选`}>{option.name}<X size={12} /></button>)}<button className="category-reset" onClick={() => changeSelection({ theme: '', setting: '', background: '' })}>重置筛选</button></div>}</section>;
  return <div className={`catalog-page ${page === 'discover' ? 'discovery-page' : ''}`}><div className="page-heading"><div><h1>{page === 'search' ? `“${query}” 的搜索结果` : titles[page]}</h1><p>{page === 'search' && !loading && !error ? `找到 ${visibleItems.length} 部作品` : subtitles[page]}</p></div><div className="catalog-refresh"><span className="catalog-status" role="status">{visibleItems.length ? loading || updating ? '片单已显示，正在更新' : cached ? '已显示最近片单' : '' : slow ? '首次连接较慢，正在准备片单…' : ''}</span><button className="btn subtle refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading || updating ? 'spin' : ''} />{page === 'recommend' ? '换一批' : '刷新'}</button></div></div>
    {filterBar}{categoryPanel}
    {loading && !visibleItems.length ? page === 'discover' ? <DiscoverySkeleton /> : <>{page === 'recommend' && <div className="hero-skeleton skeleton" />}<div className="series-grid">{Array.from({ length: 12 }, (_, i) => <div className="card-skeleton" key={i}><div className="skeleton" /><span className="skeleton" /><small className="skeleton" /></div>)}</div></> : error && !visibleItems.length ? <Failure text={error} retry={refresh} /> : !visibleItems.length ? <Empty title={page === 'search' ? '没有找到相关作品' : '暂时没有片单'} text={page === 'search' ? '试试完整剧名，或换一个关键词。' : '稍后刷新，看看有没有新故事。'} /> : <>
      {page === 'discover' ? <Discovery items={visibleItems} genre={genre} history={history} favorites={ids} reload={reload} onOpen={onOpen} onFavorite={onFavorite} onNavigate={onNavigate} /> : <>
      {page === 'recommend' && !filtered && hero && <>
        <div className="feature-layout"><section className="hero feature-main"><div className="feature-backdrop"><Poster cover={hero.cover} title={hero.title} priority /><div /></div><div className="hero-copy"><span className="hero-kicker"><Film size={15} />{page === 'recommend' ? '为你挑选' : '现在值得看'}</span><h2>{hero.title}</h2><p>{hero.intro || '打开剧集详情，选择想看的那一集。'}</p><div className="hero-tags">{hero.tags?.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{hero.totalEpisodes > 0 && <span>{hero.totalEpisodes} 集</span>}</div><div className="hero-actions"><button className="btn primary" onClick={() => onOpen(hero, true)}><Play size={18} fill="currentColor" />立即播放</button><button className="feature-detail" onClick={() => onOpen(hero)}>剧集详情<ArrowRight size={16} /></button></div></div></section>
          {visibleItems.length > 1 && <aside className="feature-picks"><div className="feature-picks-label">也值得一看</div>{visibleItems.slice(1, 3).map(s => <button className="feature-secondary" key={s.id} onClick={() => onOpen(s)} aria-label={`查看 ${s.title}`}><Poster cover={s.cover} title={s.title} /><span className="feature-secondary-shade" /><span className="feature-secondary-info"><strong>{s.title}</strong><small>{s.tags?.slice(0, 2).join(' · ') || `${s.totalEpisodes} 集`}</small></span><span className="feature-secondary-play"><Play size={18} fill="currentColor" /></span></button>)}</aside>}
        </div>
        {history.length > 0 && <section className="continue-section"><div className="continue-title"><h3>接着看</h3><span>从上次停下的地方继续</span></div><div className="continue-strip">{history.slice(0, 3).map(item => <button key={item.series.id} className="continue-card" onClick={() => onOpen(item.series, true)} aria-label={`继续观看 ${item.series.title}`}><Poster cover={item.series.cover} title={item.series.title} /><span><strong>{item.series.title}</strong><small>第 {item.episode} 集{item.position > 0 ? ` · ${Math.floor(item.position / 60)}:${String(Math.floor(item.position % 60)).padStart(2, '0')}` : ''}</small></span><Play size={16} fill="currentColor" /></button>)}</div></section>}
      </>}

      <div className="section-heading"><h2>{page === 'rank' ? <><TrendingUp size={21} />正在热播</> : page === 'search' ? <><Search size={21} />相关作品</> : <><Grid2X2 size={20} />{filtered ? activeFilters.map(option => option.name).join(' · ') || '分类作品' : page === 'browse' ? '全部作品' : '值得追的故事'}</>}</h2><span>{visibleItems.length} 部作品{hasMore ? ' · 可继续浏览' : ''}</span></div>
      <div className="series-grid">{visibleItems.map((s, i) => <SeriesCard key={s.id} series={s} index={page === 'rank' ? i : undefined} favorite={ids.has(s.id)} onOpen={() => onOpen(s)} onFavorite={() => onFavorite(s)} />)}</div>
      </>}
      {error && <div className="catalog-warning" role="status"><span>{visibleItems.length ? '已保留片单。' : ''}{error}</span><button className="btn subtle" onClick={moreError ? loadMore : refresh} disabled={loading || moreLoading}>重试<RefreshCw size={14} /></button></div>}{hasMore && page !== 'discover' && <div className="load-more"><button className="btn secondary" disabled={moreLoading || loading} onClick={loadMore}>{moreLoading ? '正在加载…' : '加载更多故事'}<ArrowRight size={16} /></button></div>}
    </>}
  </div>;
}
