import {useEffect,useRef,useState} from 'react';
import {Layers3,RefreshCw,Check,ChevronRight,LoaderCircle} from 'lucide-react';
import type {NativeBridge,SeasonOverview as Overview,Series} from '../../shared/contracts';
import {message,Poster} from './ui';
import './SeasonOverview.css';

export async function requestSeasonOverview(bridge:Pick<NativeBridge,'request'>,seriesId:string,refresh=false){
  const result=await bridge.request<Overview>(`/catalog/series/${seriesId}/seasons${refresh?'?refresh=true':''}`,{timeout:90000});
  if(!result||result.seriesId!==seriesId)throw new Error('季信息与当前剧集不一致，请重试');
  return result;
}

export default function SeasonOverview({series,onSelect,action='view',pendingId='',disabled=false}:{series:Series;onSelect:(series:Series)=>void;action?:'view'|'play';pendingId?:string;disabled?:boolean}){
  const [overview,setOverview]=useState<Overview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const generation=useRef(0),alive=useRef(true);
  const load=async(refresh=false)=>{const id=++generation.current;setLoading(true);setError('');
    try{const result=await requestSeasonOverview(window.hongguo,series.id,refresh);if(alive.current&&generation.current===id)setOverview(result);}
    catch(failure){if(alive.current&&generation.current===id)setError(message(failure));}
    finally{if(alive.current&&generation.current===id)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;setOverview(null);void load();return()=>{alive.current=false;generation.current++;};},[series.id]);
  const incomplete=overview?.complete===false;
  const showCards=overview&&(overview.status==='found'||incomplete&&overview.status==='single');
  if(!loading&&!error&&overview?.status==='single'&&!incomplete)return null;
  return <section className={`season-overview ${action==='play'?'player-season-overview':''}`} aria-label="全部季概览"><div className="season-overview-heading"><div><Layers3 size={18}/><h3>全部季</h3></div><span>{showCards?`${incomplete?'已找到 ':''}${overview.seasons.length} 季 · ${action==='play'?'点击切换，从第一集开始':'按顺序观看'}`:loading?'正在查找同系列作品…':''}</span><button className="btn subtle season-overview-refresh" aria-label="刷新季信息" disabled={loading} onClick={()=>void load(true)}><RefreshCw size={14} className={loading?'spin':''}/>{loading?'刷新中…':'刷新'}</button></div>
    {incomplete&&<p className="season-overview-hint season-overview-warning" role="status">{overview.warning?.trim()||'部分季暂未补齐，可刷新重试。'}</p>}
    {error&&<div className="season-overview-error" role="status"><span>{showCards?'刷新暂未完成，已保留当前季列表。':'季信息暂未加载，当前剧集可以正常播放。'}</span><button className="btn subtle" disabled={loading} onClick={()=>void load(true)}><RefreshCw size={14}/>重试</button></div>}
    {showCards?<div className="season-overview-grid">{overview.seasons.map(item=><button key={item.series.id} className={`season-overview-card ${item.series.id===series.id?'selected':''}`} disabled={disabled} aria-busy={pendingId===item.series.id} aria-current={item.series.id===series.id?'true':undefined} aria-label={`${action==='play'?'播放':'查看'}第 ${item.season} 季：${item.series.title}，共 ${item.series.totalEpisodes} 集`} onClick={()=>{if(item.series.id!==series.id||pendingId)onSelect(item.series);}}><Poster cover={item.series.cover} title={item.series.title}/><span><small>第 {item.season} 季 {item.series.id===series.id&&<Check size={12}/>}</small><strong>{item.series.title}</strong><em>{item.series.totalEpisodes} 集{item.series.id===series.id&&action==='play'?' · 当前播放':''}{pendingId===item.series.id?' · 正在准备…':''}</em></span>{pendingId===item.series.id?<LoaderCircle size={15} className="spin"/>:<ChevronRight size={15}/>}</button>)}</div>:!error&&(overview?.status==='ambiguous'?<p className="season-overview-hint">同系列存在不同版本，暂未自动合并季信息。</p>:<div className="season-overview-loading" role="status"><span className="spinner"/>查找全部季及集数…</div>)}
  </section>;
}
