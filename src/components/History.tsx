import { ArrowRight, CheckCheck, ChevronDown, Clock3, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HistoryItem, HistoryPage, HistoryQuery, Series } from '../../shared/contracts';
import { episodeFinished, groupHistory, isHistoryFinished, nextHistory, normalizeHistoryQuery, positionLabel, resumeHistory } from '../history-query';
import { Empty, Failure, Loading, Poster, message } from './ui';
import './History.css';

interface Props {
  onOpen: (series: Series, autoplay?: boolean, progress?: HistoryItem) => void;
  onRemove: (id: string) => Promise<void>;
  onSync: () => Promise<void>;
  syncing: boolean;
  revision: number;
  notify: (text: string) => void;
}
export default function History({ onOpen, onRemove, onSync, syncing, revision, notify }: Props) {
  const [search, setSearch] = useState(''), [keyword, setKeyword] = useState(''), [period, setPeriod] = useState<HistoryQuery['period']>('all'), [status, setStatus] = useState<HistoryQuery['status']>('all');
  const [items, setItems] = useState<HistoryItem[]>([]), [total, setTotal] = useState(0), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [moreLoading, setMoreLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0), [removing, setRemoving] = useState('');
  const generation = useRef(0), scope = useRef(''), mutation = useRef(false);
  const loadedCount=useRef(50);
  const [windowStart, setWindowStart] = useState(0);
  const [failedMore, setFailedMore] = useState(false);
  const query = normalizeHistoryQuery({ search: keyword, period, status });
  useEffect(() => { const timer = setTimeout(() => setKeyword(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (mutation.current) { mutation.current = false; return; }
    const id = ++generation.current, key = JSON.stringify(query); setLoading(true); setError(''); setMoreLoading(false);setFailedMore(false);
    const changed=scope.current!==key,count=changed?50:Math.max(50,loadedCount.current);
    if (changed) { loadedCount.current=50;setItems([]); setCursor(null); setTotal(0);setWindowStart(0); } scope.current = key;
    void (async()=>{
      let page=await window.hongguo.getHistory({...query,limit:Math.min(100,count)}),rows=page.items;
      while(rows.length<count&&page.nextCursor&&id===generation.current){page=await window.hongguo.getHistory({...query,cursor:page.nextCursor,limit:Math.min(100,count-rows.length)});rows=nextHistory(rows,page.items);}
      return {...page,items:rows};
    })().then(page => {
      if (id === generation.current) { loadedCount.current=page.items.length;setItems(page.items); setTotal(page.total); setCursor(page.nextCursor);setWindowStart(current=>Math.min(current,Math.max(0,page.items.length-1))); }
    }).catch(error => { if (id === generation.current) setError(message(error)); }).finally(() => { if (id === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [keyword, period, status, revision, retry]);
  const more = async () => {
    if (!cursor || moreLoading || loading) return;
    const id = generation.current; setMoreLoading(true); setError('');
    try {
      const page: HistoryPage = await window.hongguo.getHistory({ ...query, cursor });
      if (id !== generation.current) return;
      setItems(current => { const combined=nextHistory(current, page.items);loadedCount.current=combined.length;setWindowStart(Math.max(0,combined.length-300));return combined; }); setTotal(page.total); setCursor(page.nextCursor);
    } catch(error) { if (id === generation.current) {setError(message(error));setFailedMore(true);} }
    finally { if (id === generation.current) setMoreLoading(false); }
  };
  const remove = async (id: string) => {
    if (removing) return; setRemoving(id); mutation.current=true;
    try { await onRemove(id); setItems(current => current.filter(item => item.series.id !== id)); setTotal(value => Math.max(0, value - 1)); notify('已移除此设备的记录，手机记录不受影响'); }
    catch(error) { mutation.current=false;notify(message(error)); }
    finally { setRemoving(''); }
  };
  const filtered = !!keyword || period !== 'all' || status !== 'all';
  return <div className="history-page library-page">
    <div className="page-heading"><div><h1>观看历史</h1><p>按真正的观看时间，找回上次看到的地方。登录后自动同步手机记录。</p></div><button className="btn secondary" onClick={()=>void onSync()} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''}/>{syncing ? '正在刷新…' : '刷新'}</button></div>
    <div className="history-toolbar">
      <label className="history-search"><Search size={17}/><input aria-label="搜索观看历史" placeholder="搜索看过的剧名" maxLength={80} value={search} onChange={event=>setSearch(event.target.value)}/>{search&&<button aria-label="清除历史搜索" onClick={()=>setSearch('')}><X size={15}/></button>}</label>
      <div className="history-period" aria-label="历史时间范围">{[{id:'all',label:'全部'},{id:'today',label:'今天'},{id:'week',label:'近 7 天'},{id:'month',label:'近 30 天'}].map(option=><button key={option.id} className={period===option.id?'selected':''} aria-pressed={period===option.id} onClick={()=>setPeriod(option.id as HistoryQuery['period'])}>{option.label}</button>)}</div>
      <select aria-label="历史观看状态" className="field compact" value={status} onChange={event=>setStatus(event.target.value as HistoryQuery['status'])}><option value="all">全部状态</option><option value="unfinished">未看完</option><option value="finished">已看完</option></select>
    </div>
    <div className="history-overview"><span><ShieldCheck size={14}/>本机记录 · 离线可浏览</span><span>{loading&&!items.length?'读取历史…':(filtered?'匹配 ':'')+total.toLocaleString()+' 部作品'}{loading&&items.length>0&&<LoaderCircle size={13} className="spin"/>}</span></div>
    {loading&&!items.length?<Loading text="正在读取观看记录…"/>:error&&!items.length?<Failure text={error} retry={()=>setRetry(value=>value+1)}/>:!items.length?<Empty title={filtered?'没有符合条件的观看记录':'这里会保留你的追剧足迹'} text={filtered?'换个关键词或调整时间范围，继续找找。':'看过的作品按真实观看时间保留，不会因为超过一百条而被删除。'}>{filtered&&<button className="btn secondary" onClick={()=>{setSearch('');setKeyword('');setPeriod('all');setStatus('all');}}>查看全部历史<ArrowRight size={15}/></button>}</Empty>:<>
      {windowStart>0&&<div className="history-window-note"><span>正在浏览较早的记录</span><button className="btn subtle" onClick={()=>{loadedCount.current=50;setItems([]);setWindowStart(0);setRetry(value=>value+1);}}>回到最近记录<ArrowRight size={14}/></button></div>}
      <div className="history-groups">{groupHistory(items.slice(windowStart,windowStart+300)).map(group=><section className="history-day" key={group.key}><h2><Clock3 size={15}/>{group.label}<span>{group.items.length} 部</span></h2><div className="history-list">{group.items.map(item=>{
        const finished=isHistoryFinished(item),complete=episodeFinished(item);
        return <article className="history-card" key={item.series.id}>
          <button className="history-poster" onClick={()=>onOpen(item.series,true,resumeHistory(item))} aria-label={'继续观看 '+item.series.title}><Poster cover={item.series.cover} title={item.series.title}/><span><Play size={20} fill="currentColor"/></span></button>
          <div className="history-info"><button className="history-title" onClick={()=>onOpen(item.series,false,item)}>{item.series.title}</button><p>{finished?<span className="history-complete"><CheckCheck size={13}/>已看完全集</span>:<>第 {item.episode} 集{item.series.totalEpisodes>0?' / 共 '+item.series.totalEpisodes+' 集':''}<span className="history-position"> · {complete?'本集已看完':item.position>0?'看到 '+positionLabel(item.position):'播放位置待继续'}</span></>}</p>{item.duration>0&&<div className="history-progress" aria-label={'本集观看进度 '+Math.min(100,Math.round(item.position/item.duration*100))+'%'}><span style={{width:Math.min(100,item.position/item.duration*100)+'%'}}/></div>}</div>
          <div className="history-actions"><button className="btn secondary" onClick={()=>onOpen(item.series,true,resumeHistory(item))}><Play size={15} fill="currentColor"/>{complete&&!finished?'观看下一集':'继续观看'}</button><button className="icon-button muted" title="只移除本机记录，手机记录不受影响" aria-label={'移除 '+item.series.title+' 的本地记录'} disabled={!!removing} onClick={()=>void remove(item.series.id)}>{removing===item.series.id?<LoaderCircle size={17} className="spin"/>:<Trash2 size={17}/>}</button></div>
        </article>;
      })}</div></section>)}</div>
      {error&&<div className="history-load-error" role="alert"><p>已保留当前记录。{error}</p><button className="btn subtle" onClick={()=>{if(failedMore)void more();else setRetry(value=>value+1);}}>重试</button></div>}
      {cursor?<div className="load-more"><button className="btn secondary" disabled={loading||moreLoading} onClick={()=>void more()}>{moreLoading?<LoaderCircle className="spin" size={16}/>:<ChevronDown size={16}/>}更早的观看记录</button><small>已展示 {items.length.toLocaleString()} / {total.toLocaleString()} 部</small></div>:<p className="history-end">{filtered?'已展示全部匹配记录':'没有更早的观看记录了'}</p>}
    </>}
  </div>;
}
