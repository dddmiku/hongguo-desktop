import { useRef, useState } from 'react';
import { ArrowRight, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import type { Series } from '../../shared/contracts';
import { SeriesCard } from './Catalog';
import { Empty } from './ui';
import './Favorites.css';

interface Props {
  items: Series[];
  syncing: boolean;
  onSync: () => Promise<void>;
  onOpen: (series: Series) => void;
  onFavorite: (series: Series) => void;
  onDiscover: () => void;
}

const searchable = (value: string) => value.normalize('NFKC').toLowerCase();

export default function Favorites({ items, syncing, onSync, onOpen, onFavorite, onDiscover }: Props) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const query = searchable(value).trim();
  const visible = query ? items.filter(series =>
    searchable(series.title).includes(query) || series.actors?.some(actor => searchable(actor).includes(query))) : items;
  const clear = () => { setValue(''); input.current?.focus(); };

  return <div className="library-page favorites-page">
    <div className="page-heading">
      <div><h1>我的收藏</h1><p>登录后自动同步手机收藏。</p></div>
      <button className="btn secondary" onClick={() => void onSync()} disabled={syncing}>
        <RefreshCw size={16} className={syncing ? 'spin' : ''}/>{syncing ? '正在刷新…' : '刷新'}
      </button>
    </div>
    {(items.length > 0 || value.length > 0) && <div className="favorites-toolbar">
      <div className="history-search favorites-search">
        <Search size={17}/>
        <input ref={input} type="search" aria-label="搜索我的收藏" placeholder="搜索收藏的剧名或演员" maxLength={80}
          value={value} onChange={event => setValue(event.target.value)}/>
        {value && <button type="button" aria-label="清除收藏搜索" onClick={clear}><X size={15}/></button>}
      </div>
    </div>}
    <div className="library-summary">
      <span><ShieldCheck size={15}/>本机收藏 · 离线也可查看</span>
      <span role="status">{query ? '匹配 ' : ''}{visible.length} 部作品</span>
    </div>
    {visible.length > 0 ? <div className="series-grid">
      {visible.map(series => <SeriesCard key={series.id} series={series} favorite onOpen={() => onOpen(series)} onFavorite={() => onFavorite(series)}/>)}
    </div> : query ? <Empty title="没有匹配的收藏" text="换个剧名或演员试试。">
      <button className="btn secondary" onClick={clear}>查看全部收藏<ArrowRight size={16}/></button>
    </Empty> : <Empty title="还没有收藏" text="在片单或详情里点击收藏，就能在这里快速找到。">
      <button className="btn primary" onClick={onDiscover}>去发现好剧<ArrowRight size={16}/></button>
    </Empty>}
  </div>;
}
