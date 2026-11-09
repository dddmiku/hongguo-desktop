import { ArrowRight, Bookmark, Check, ChevronLeft, ChevronRight, Film, Play, RefreshCw, Sparkles, TrendingUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Genre, HistoryItem, Series } from '../../shared/contracts';
import { readCatalog, writeCatalog } from '../catalog-cache';
import type { CatalogResult } from '../catalog-cache';
import { discoverySections } from '../discovery-sections';
import { message, Poster } from './ui';
import './Discovery.css';

export type DiscoveryDestination = 'browse' | 'rank' | 'recommend';
interface Props { items: Series[]; genre: Genre; history: HistoryItem[]; favorites: Set<string>; reload: number; onOpen: (series: Series, play?: boolean) => void; onFavorite: (series: Series) => void; onNavigate?: (page: DiscoveryDestination, genre?: Genre) => void; }
interface Board { items: Series[]; loading: boolean; error: string; }
const keyFor = (board: 'hot' | 'new', genre: Genre) => `/catalog/rank?board=${board}&genre=${genre}`;
const cachedBoard = (board: 'hot' | 'new', genre: Genre): Board => ({ items: readCatalog(keyFor(board, genre))?.items || [], loading: true, error: '' });

function PosterTile({ series, favorite, onOpen, onFavorite }: { series: Series; favorite: boolean; onOpen: () => void; onFavorite: () => void }) {
  return <article className="series-card discovery-poster-card" data-series-id={series.id}><button className="series-poster-button" onClick={onOpen} aria-label={`查看 ${series.title}`}><Poster cover={series.cover} title={series.title} /><span className="poster-label">{series.totalEpisodes > 0 ? `${series.totalEpisodes} 集` : '连载中'}</span><span className="poster-play"><Play size={25} fill="currentColor" /></span></button><div className="series-info"><button className="series-title" onClick={onOpen}>{series.title}</button><button className={`card-favorite ${favorite ? 'saved' : ''}`} onClick={onFavorite} aria-label={`${favorite ? '取消收藏' : '收藏'} ${series.title}`}>{favorite ? <Check size={15} /> : <Bookmark size={15} />}</button><p>{series.tags?.slice(0, 2).join(' · ') || series.actors?.slice(0, 2).join(' · ') || '打开看看故事'}</p></div></article>;
}

export function DiscoverySkeleton() {
  return <div className="discovery-content" aria-label="正在准备发现片单"><div className="discovery-hero skeleton" /><section className="discovery-section"><div className="discovery-heading-skeleton skeleton" /><div className="discovery-hot-list">{Array.from({ length: 6 }, (_, i) => <div className="discovery-hot-skeleton skeleton" key={i} />)}</div></section></div>;
}

export default function Discovery({ items, genre, history, favorites, reload, onOpen, onFavorite, onNavigate }: Props) {
  const [boards, setBoards] = useState(() => ({ genre, hot: cachedBoard('hot', genre), new: cachedBoard('new', genre) }));
  const current = boards.genre === genre ? boards : { genre, hot: cachedBoard('hot', genre), new: cachedBoard('new', genre) };
  const [retry, setRetry] = useState(0);
  const latestStrip = useRef<HTMLDivElement>(null);
  const [stripNavigation, setStripNavigation] = useState({ left: false, right: false });
  useEffect(() => {
    let cancelled = false;
    setBoards({ genre, hot: cachedBoard('hot', genre), new: cachedBoard('new', genre) });
    const timer = setTimeout(() => {
      for (const board of ['hot', 'new'] as const) {
        void window.hongguo.request<CatalogResult>(keyFor(board, genre), { timeout: 40000 }).then(data => {
          if (cancelled) return;
          if (data.items?.length) writeCatalog(keyFor(board, genre), data);
          setBoards(old => old.genre !== genre ? old : { ...old, [board]: { items: data.items?.length ? data.items : old[board].items, loading: false, error: data.warning || '' } });
        }).catch(error => {
          if (!cancelled) setBoards(old => old.genre !== genre ? old : { ...old, [board]: { ...old[board], loading: false, error: message(error) } });
        });
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [genre, reload, retry]);
  const sections = discoverySections(items, current.hot.items, current.new.items);
  useEffect(() => {
    const strip = latestStrip.current; if (!strip) return;
    const update = () => setStripNavigation({ left: strip.scrollLeft > 1, right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 });
    const observer = new ResizeObserver(update); observer.observe(strip);
    strip.addEventListener('scroll', update); update();
    return () => { observer.disconnect(); strip.removeEventListener('scroll', update); };
  }, [sections.latest.length, genre]);
  const hero = sections.hero, boardsPending = current.hot.loading || current.new.loading;
  const navigate = (page: DiscoveryDestination) => onNavigate?.(page, genre);
  return <div className="discovery-content">
    {history.length > 0 && <section className="discovery-continue" aria-label="接着看"><div className="discovery-continue-label"><Play size={15} /><h2>接着看</h2></div><div className="discovery-continue-items">{history.slice(0, 3).map(item => <button className="discovery-resume" key={item.series.id} onClick={() => onOpen(item.series, true)} aria-label={`继续观看 ${item.series.title}`}><Poster cover={item.series.cover} title={item.series.title} /><span><strong>{item.series.title}</strong><small>第 {item.episode} 集{item.position > 0 ? ` · ${Math.floor(item.position / 60)}:${String(Math.floor(item.position % 60)).padStart(2, '0')}` : ''}</small></span><Play size={13} fill="currentColor" /></button>)}</div></section>}
    {hero && <section className="discovery-hero" aria-label="精选主视觉" data-series-id={hero.id}>
      <div className="discovery-hero-atmosphere"><Poster cover={hero.cover} title={hero.title} priority /><div /></div>
      <div className="discovery-hero-copy"><span className="discovery-eyebrow"><Film size={14} />发现 · 精选故事</span><h2>{hero.title}</h2><p>{hero.intro || '下一段故事，就从这部开始。打开详情，看看每一集。'}</p><div className="discovery-hero-meta">{hero.tags?.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{hero.totalEpisodes > 0 && <span>{hero.totalEpisodes} 集</span>}</div><div className="discovery-hero-actions"><button className="btn primary" onClick={() => onOpen(hero, true)}><Play size={17} fill="currentColor" />立即播放</button><button className="discovery-detail" onClick={() => onOpen(hero)}>查看剧集<ArrowRight size={15} /></button><button className={`discovery-hero-favorite ${favorites.has(hero.id) ? 'saved' : ''}`} onClick={() => onFavorite(hero)} aria-label={`${favorites.has(hero.id) ? '取消收藏' : '收藏'} ${hero.title}`}>{favorites.has(hero.id) ? <Check size={18} /> : <Bookmark size={18} />}</button></div></div>
      <button className="discovery-hero-poster" onClick={() => onOpen(hero)} aria-label={`查看 ${hero.title}`}><Poster cover={hero.cover} title={hero.title} priority /><span><Play size={18} fill="currentColor" />进入故事</span></button>
      <span className="discovery-hero-caption">一部好剧，一段新故事</span>
    </section>}

    <section className="discovery-section discovery-hot-section" aria-label="热播片单">
      <div className="discovery-section-heading"><div><h2><TrendingUp size={18} />正在热播</h2><p>从热播片单里，选一个想追的故事</p></div>{onNavigate && <button className="discovery-more" onClick={() => navigate('rank')}>完整榜单<ArrowRight size={14} /></button>}</div>
      <div className="discovery-hot-list">{sections.hot.length ? sections.hot.map(series => <article className="discovery-hot-card" data-series-id={series.id} key={series.id}><button onClick={() => onOpen(series)} aria-label={`查看 ${series.title}`}><Poster cover={series.cover} title={series.title} /><span className="discovery-hot-copy"><strong>{series.title}</strong><small>{series.tags?.slice(0, 2).join(' · ') || '打开剧集详情'}</small><em>{series.totalEpisodes > 0 ? `${series.totalEpisodes} 集` : '连载中'}</em></span></button><button className={`discovery-hot-favorite ${favorites.has(series.id) ? 'saved' : ''}`} onClick={() => onFavorite(series)} aria-label={`${favorites.has(series.id) ? '取消收藏' : '收藏'} ${series.title}`}>{favorites.has(series.id) ? <Check size={14} /> : <Bookmark size={14} />}</button></article>) : current.hot.loading ? Array.from({ length: 6 }, (_, i) => <div className="discovery-hot-skeleton skeleton" key={i} />) : <div className="discovery-section-empty">热播片单暂时没有可展示的作品<button onClick={() => setRetry(value => value + 1)}>重新读取<RefreshCw size={12} /></button></div>}</div>
      {current.hot.error && <p className="discovery-board-warning">{sections.hot.length ? '已保留最近热播片单，' : ''}热播片单暂时未能更新。<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    </section>

    <section className="discovery-section discovery-latest-section" aria-label="新上架片单">
      <div className="discovery-section-heading"><div><h2><Sparkles size={18} />新上架</h2><p>新故事陆续登场，看看这一批</p></div><div className="discovery-strip-actions">{onNavigate && <button className="discovery-more" onClick={() => navigate('browse')}>探索片库<ArrowRight size={14} /></button>}{(stripNavigation.left || stripNavigation.right) && <><button className="discovery-strip-arrow" aria-label="向左浏览新上架" disabled={!stripNavigation.left} onClick={() => latestStrip.current?.scrollBy({ left: -450, behavior: 'smooth' })}><ChevronLeft size={16} /></button><button className="discovery-strip-arrow" aria-label="向右浏览新上架" disabled={!stripNavigation.right} onClick={() => latestStrip.current?.scrollBy({ left: 450, behavior: 'smooth' })}><ChevronRight size={16} /></button></>}</div></div>
      <div className="discovery-latest-strip" ref={latestStrip}>{sections.latest.length ? sections.latest.map(series => <PosterTile series={series} key={series.id} favorite={favorites.has(series.id)} onOpen={() => onOpen(series)} onFavorite={() => onFavorite(series)} />) : current.new.loading ? Array.from({ length: 6 }, (_, i) => <div className="discovery-new-skeleton" key={i}><div className="skeleton" /><span className="skeleton" /></div>) : <div className="discovery-section-empty">新上架片单暂时没有可展示的作品<button onClick={() => setRetry(value => value + 1)}>重新读取<RefreshCw size={12} /></button></div>}</div>
      {current.new.error && <p className="discovery-board-warning">{sections.latest.length ? '已保留最近新剧片单，' : ''}新上架片单暂时未能更新。<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    </section>

    <section className="discovery-section discovery-topic-section" aria-label="主题片单">
      <div className="discovery-section-heading"><div><h2>换个题材，换段心情</h2><p>把同一种故事放在一起，慢慢挑</p></div>{onNavigate && <button className="discovery-more" onClick={() => navigate('browse')}>更多题材<ArrowRight size={14} /></button>}</div>
      <div className="discovery-topics">{boardsPending && !sections.topics.length ? Array.from({ length: 3 }, (_, i) => <div className="discovery-topic-skeleton skeleton" key={i} />) : sections.topics.length ? sections.topics.map((topic, index) => <article className={`discovery-topic topic-tone-${index}`} key={topic.name}><div className="discovery-topic-heading"><span>主题片单</span><h3>{topic.name}</h3><small>{topic.items.length} 部故事</small></div><div className="discovery-topic-posters">{topic.items.map(series => <button data-series-id={series.id} onClick={() => onOpen(series)} key={series.id} aria-label={`查看 ${series.title}`}><Poster cover={series.cover} title={series.title} /><strong>{series.title}</strong></button>)}</div></article>) : <div className="discovery-topic-fallback">这批作品暂时没有可归组的主题。{onNavigate && <button onClick={() => navigate('browse')}>去片库挑选<ArrowRight size={14} /></button>}</div>}</div>
    </section>
    {sections.other.length > 0 && <section className="discovery-section discovery-other-section" aria-label="更多发现"><div className="discovery-section-heading"><div><h2>还有这些故事</h2></div>{onNavigate && <button className="discovery-more" onClick={() => navigate('recommend')}>看看推荐<ArrowRight size={14} /></button>}</div><div className="discovery-other-list">{sections.other.map(series => <button data-series-id={series.id} onClick={() => onOpen(series)} key={series.id} aria-label={`查看 ${series.title}`}><Poster cover={series.cover} title={series.title} /><span><strong>{series.title}</strong><small>{series.tags?.slice(0, 2).join(' · ') || '打开剧集详情'}</small></span><ArrowRight size={14} /></button>)}</div></section>}
    {onNavigate && <button className="discovery-library-link" onClick={() => navigate('browse')}><Film size={25} /><span><strong>按自己的口味找剧</strong><small>进入探索片库，按题材、设定和背景筛选</small></span><span className="discovery-library-action">探索片库<ArrowRight size={17} /></span></button>}
  </div>;
}
