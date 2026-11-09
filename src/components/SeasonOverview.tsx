import {useEffect,useRef,useState} from 'react';
import {Layers3,RefreshCw,Check,ChevronRight} from 'lucide-react';
import type {SeasonOverview as Overview,Series} from '../../shared/contracts';
import {message,Poster} from './ui';
import './SeasonOverview.css';

export default function SeasonOverview({series,onSelect}:{series:Series;onSelect:(series:Series)=>void}){
  const [overview,setOverview]=useState<Overview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const generation=useRef(0),alive=useRef(true);
  const load=async(refresh=false)=>{const id=++generation.current;setLoading(true);setError('');
    try{const result=await window.hongguo.request<Overview>(`/catalog/series/${series.id}/seasons${refresh?'?refresh=true':''}`,{timeout:90000});if(alive.current&&generation.current===id&&result.seriesId===series.id)setOverview(result);}
    catch(failure){if(alive.current&&generation.current===id)setError(message(failure));}
    finally{if(alive.current&&generation.current===id)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;setOverview(null);void load();return()=>{alive.current=false;generation.current++;};},[series.id]);
  if(!loading&&!error&&overview?.status==='single')return null;
  return <section className="season-overview" aria-label="全部季概览"><div className="season-overview-heading"><div><Layers3 size={18}/><h3>全部季</h3></div><span>{overview?.status==='found'?`${overview.seasons.length} 季 · 按顺序观看`:loading?'正在查找同系列作品…':''}</span></div>
    {error?<div className="season-overview-error" role="status"><span>季信息暂未加载，当前剧集可以正常播放。</span><button className="btn subtle" onClick={()=>void load(true)}><RefreshCw size={14}/>重试</button></div>:overview?.status==='ambiguous'?<p className="season-overview-hint">同系列存在不同版本，暂未自动合并季信息。</p>:overview?.status==='found'?<div className="season-overview-grid">{overview.seasons.map(item=><button key={item.series.id} className={`season-overview-card ${item.series.id===series.id?'selected':''}`} aria-current={item.series.id===series.id?'true':undefined} aria-label={`查看第 ${item.season} 季：${item.series.title}，共 ${item.series.totalEpisodes} 集`} onClick={()=>{if(item.series.id!==series.id)onSelect(item.series);}}><Poster cover={item.series.cover} title={item.series.title}/><span><small>第 {item.season} 季 {item.series.id===series.id&&<Check size={12}/>}</small><strong>{item.series.title}</strong><em>{item.series.totalEpisodes} 集</em></span><ChevronRight size={15}/></button>)}</div>:<div className="season-overview-loading" role="status"><span className="spinner"/>查找全部季及集数…</div>}
  </section>;
}
