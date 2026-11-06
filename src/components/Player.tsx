import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { ArrowLeft, Play, Pause, SkipForward, Volume2, VolumeX, Maximize, MessageSquare, RotateCcw, ChevronLeft, ChevronRight, X, Heart, Monitor } from 'lucide-react';
import type { CommentsPage, Episode, MediaSession, SeriesDetail, Settings } from '../../shared/contracts';
import './Player.css';

type Props={detail:SeriesDetail;initialEpisode:number;initialPosition?:number;settings:Settings;onClose:()=>void;onSettings:(patch:Partial<Settings>)=>void;onLibrary:()=>void};
const time=(n:number)=>{if(!Number.isFinite(n)||n<0)return '00:00';return `${Math.floor(n/60).toString().padStart(2,'0')}:${Math.floor(n%60).toString().padStart(2,'0')}`;};
const rates=[.75,1,1.25,1.5,2,2.5,3];
const commentTime=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);};
export default function Player({detail,initialEpisode,initialPosition=0,settings,onClose,onSettings,onLibrary}:Props){
  const video=useRef<HTMLVideoElement>(null),hls=useRef<Hls|null>(null),currentSession=useRef(''),prefetch=useRef(new Map<number,string>()),hideTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [episode,setEpisode]=useState(initialEpisode),[retry,setRetry]=useState(0),[phase,setPhase]=useState('准备播放'),[error,setError]=useState(''),[playing,setPlaying]=useState(false),[chrome,setChrome]=useState(true),[position,setPosition]=useState(initialPosition),[duration,setDuration]=useState(0),[buffered,setBuffered]=useState(0),[muted,setMuted]=useState(false),[comments,setComments]=useState(false),[theater,setTheater]=useState(false),[favorite,setFavorite]=useState(false),[notice,setNotice]=useState('');
  const activeEpisode=useRef(episode),loadedEpisode=useRef(episode),autoTransition=useRef(false),activeSettings=useRef(settings),resume=useRef(initialPosition),lastSaved=useRef(0),manualClose=useRef(false),visible=useRef(true),pendingPlay=useRef(false),preloadGeneration=useRef(0);
  activeEpisode.current=episode;activeSettings.current=settings;
  const episodeMeta=detail.episodes.find(e=>e.index===episode);
  const save=useCallback(async()=>{const v=video.current;if(!v||!Number.isFinite(v.currentTime)||v.currentTime<=0)return;try{await window.hongguo.saveProgress({series:detail.series,episode:loadedEpisode.current,position:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:0});onLibrary();}catch{setNotice('记录暂未保存，请检查可用磁盘空间');}},[detail.series,onLibrary]);
  const restore=()=>{const v=video.current;if(!v||!pendingPlay.current||!visible.current||manualClose.current)return;
    if(resume.current>0){const complete=hls.current?.levels[hls.current.currentLevel]?.details?.live===false;if(!Number.isFinite(v.duration)||(!complete&&v.duration<resume.current+1)){setPhase('正在恢复观看位置');return;}v.currentTime=Math.min(resume.current,Math.max(0,v.duration-1));resume.current=0;}
    v.playbackRate=activeSettings.current.rate;v.volume=activeSettings.current.volume;pendingPlay.current=false;void v.play().catch(()=>{setPhase('点击开始播放');setChrome(true);});};
  const hide=useCallback(()=>{clearTimeout(hideTimer.current);setChrome(true);hideTimer.current=setTimeout(()=>{if(video.current&&!video.current.paused)setChrome(false);},2500);},[]);
  const selectEpisode=useCallback((index:number,automatic=false)=>{if(!detail.episodes.some(e=>e.index===index))return;save();autoTransition.current=automatic;resume.current=0;if(!automatic)hide();setEpisode(index);},[detail.episodes,save,hide]);
  useEffect(()=>{void window.hongguo.getLibrary().then(lib=>setFavorite(lib.favorites.some(s=>s.id===detail.series.id)));},[detail.series.id]);
  useEffect(()=>{
    let cancelled=false,localSession='';setError('');setPhase('准备播放');setPlaying(false);setPosition(resume.current);setDuration(0);setBuffered(0);
    const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
    async function open(){
      try{
        let session=await window.hongguo.request<MediaSession>('/media/session',{method:'POST',body:{seriesId:detail.series.id,episode,quality:settings.quality,start:resume.current}});
        localSession=session.id;if(cancelled){void window.hongguo.request(`/media/session/${session.id}`,{method:'DELETE'});return;}currentSession.current=session.id;
        const deadline=Date.now()+120000;
        while(session.phase==='preparing'){
          if(cancelled)return;if(Date.now()>deadline)throw new Error('准备时间较长，请重试当前集');await wait(500);session=await window.hongguo.request<MediaSession>(`/media/session/${session.id}`);setPhase(session.cached?'加载已缓存视频':'正在准备视频');
        }
        if(cancelled)return;if(session.phase==='error'||session.phase==='cancelled')throw new Error(session.error||'播放准备失败，请重试');
        const v=video.current;if(!v)return;loadedEpisode.current=episode;
        hls.current?.destroy();
        const seek=()=>{pendingPlay.current=true;restore();};
        if(Hls.isSupported()){
          const engine=new Hls({enableWorker:true,maxBufferLength:45,maxMaxBufferLength:120,backBufferLength:45,manifestLoadingMaxRetry:8,fragLoadingMaxRetry:8,manifestLoadingRetryDelay:800,fragLoadingRetryDelay:800});hls.current=engine;
          engine.on(Hls.Events.MANIFEST_PARSED,seek);engine.on(Hls.Events.LEVEL_UPDATED,restore);
          engine.on(Hls.Events.ERROR,(_event,data)=>{if(cancelled||!data.fatal)return;if(data.type===Hls.ErrorTypes.MEDIA_ERROR)engine.recoverMediaError();else{setError('网络或片源中断，重试可从当前进度继续');setPhase('播放中断');resume.current=v.currentTime;setChrome(true);}});
          engine.loadSource(session.url);engine.attachMedia(v);
        }else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=session.url;v.addEventListener('loadedmetadata',seek,{once:true});}else throw new Error('当前设备不支持视频播放');
      }catch(e){if(!cancelled){setError((e as Error).message);setPhase('无法播放');setChrome(true);}}
    }
    void open();
    return()=>{cancelled=true;save();hls.current?.destroy();hls.current=null;if(localSession)void window.hongguo.request(`/media/session/${localSession}`,{method:'DELETE'}).catch(()=>{});};
  },[detail.series.id,episode,settings.quality,retry]);
  useEffect(()=>{const v=video.current;if(v){v.playbackRate=settings.rate;v.volume=settings.volume;}},[settings.rate,settings.volume]);
  useEffect(()=>{
    const generation=preloadGeneration.current;
    const refresh=()=>{for(const [index,id]of prefetch.current){if(index<episode||(index===episode&&loadedEpisode.current===episode)||index>episode+2){prefetch.current.delete(index);if(id!=='pending')void window.hongguo.request(`/media/session/${id}`,{method:'DELETE'}).catch(()=>{});}}
      for(const e of detail.episodes.filter(e=>e.index>episode&&e.index<=episode+2))if(!prefetch.current.has(e.index)){prefetch.current.set(e.index,'pending');void window.hongguo.request<MediaSession>('/media/session',{method:'POST',body:{seriesId:detail.series.id,episode:e.index,quality:settings.quality,prefetch:true}}).then(s=>{if(preloadGeneration.current!==generation||manualClose.current||!prefetch.current.has(e.index))void window.hongguo.request(`/media/session/${s.id}`,{method:'DELETE'}).catch(()=>{});else prefetch.current.set(e.index,s.id);}).catch(()=>prefetch.current.delete(e.index));}};
    const timer=setInterval(refresh,12000);if(playing)refresh();return()=>clearInterval(timer);
  },[episode,playing,settings.quality,detail.series.id,detail.episodes]);
  useEffect(()=>{preloadGeneration.current++;for(const id of prefetch.current.values())if(id!=='pending')void window.hongguo.request(`/media/session/${id}`,{method:'DELETE'}).catch(()=>{});prefetch.current.clear();},[settings.quality]);
  useEffect(()=>()=>{clearTimeout(hideTimer.current);for(const id of prefetch.current.values())if(id!=='pending')void window.hongguo.request(`/media/session/${id}`,{method:'DELETE'}).catch(()=>{});video.current?.pause();},[]);
  const toggle=useCallback(()=>{const v=video.current;if(!v||error)return;if(pendingPlay.current){restore();hide();return;}v.paused?void v.play().catch(()=>{}):v.pause();hide();},[error,hide]);
  useEffect(()=>window.hongguo.onVisibility(value=>{visible.current=value;if(!value){void save();video.current?.pause();}}),[save]);
  useEffect(()=>window.hongguo.onShutdown(save),[save]);
  const seekBy=useCallback((amount:number)=>{const v=video.current;if(v&&Number.isFinite(v.duration))v.currentTime=Math.min(Math.max(0,v.currentTime+amount),v.duration);hide();},[hide]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{if(e.ctrlKey||e.altKey||e.metaKey||(e.target instanceof HTMLInputElement&&['text','search','password','email','tel','number'].includes(e.target.type))||e.target instanceof HTMLTextAreaElement||e.target instanceof HTMLSelectElement||(e.target instanceof HTMLElement&&e.target.isContentEditable))return;const k=e.key.toLowerCase();if(![' ','k','arrowleft','arrowright','arrowup','arrowdown','m','f','j','n','[',']','escape','t'].includes(k)&&!/^\d$/.test(k))return;e.preventDefault();
      if(k===' '||k==='k')toggle();else if(k==='arrowleft')seekBy(-5);else if(k==='arrowright')seekBy(5);else if(k==='arrowup'||k==='arrowdown')onSettings({volume:Math.max(0,Math.min(1,activeSettings.current.volume+(k==='arrowup'?.05:-.05)))});else if(k==='m')setMuted(m=>!m);else if(k==='f')void window.hongguo.window('fullscreen');else if(k==='t')setTheater(t=>!t);else if(k==='j'||k==='n')selectEpisode(activeEpisode.current+1);else if(k==='escape'){void window.hongguo.window('exitfullscreen').then(was=>{if(!was)close();});}else if(k==='['||k===']'){const i=rates.indexOf(activeSettings.current.rate);onSettings({rate:rates[Math.max(0,Math.min(rates.length-1,i+(k===']'?1:-1)))]});}else if(/^\d$/.test(k)&&video.current&&Number.isFinite(video.current.duration))video.current.currentTime=video.current.duration*Number(k)/10;hide();};
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[toggle,seekBy,selectEpisode,hide,onSettings]);
  const close=()=>{if(manualClose.current)return;manualClose.current=true;save();video.current?.pause();onClose();};
  const ended=()=>{save();if(activeSettings.current.autoplay&&episode<detail.episodes.length)selectEpisode(episode+1,true);else{setPlaying(false);setChrome(true);setPhase('本集播放完毕');}};
  const onTime=()=>{const v=video.current;if(!v)return;setPosition(v.currentTime);setDuration(Number.isFinite(v.duration)?v.duration:0);if(v.buffered.length)setBuffered(v.buffered.end(v.buffered.length-1));if(Date.now()-lastSaved.current>10000){lastSaved.current=Date.now();save();}};
  return <div className={`player-page ${theater?'player-theater':''}`}>
    <div className="player-heading"><button className="btn" onClick={close}><ArrowLeft size={17}/> 返回</button><div><h2>{detail.series.title}</h2><span>第 {episode} 集 · 共 {detail.episodes.length} 集</span></div><button className={`icon-button ${favorite?'active':''}`} title={favorite?'取消收藏':'收藏'} onClick={()=>void window.hongguo.toggleFavorite(detail.series).then(lib=>{setFavorite(lib.favorites.some(s=>s.id===detail.series.id));onLibrary();}).catch(e=>setNotice(e.message))}><Heart size={20} fill={favorite?'currentColor':'none'}/></button></div>
    <div className="playback-layout"><div className={`video-stage ${chrome?'':'controls-hidden'}`} onMouseMove={hide} onMouseLeave={()=>{if(playing)setChrome(false);}}>
      <video ref={video} muted={muted} playsInline onClick={toggle} onTimeUpdate={onTime} onLoadedMetadata={restore} onDurationChange={()=>{onTime();restore();}} onProgress={onTime} onPlaying={()=>{setPlaying(true);setPhase('');if(autoTransition.current){autoTransition.current=false;setChrome(false);}else hide();}} onPause={()=>{setPlaying(false);void save();if(!autoTransition.current)setChrome(true);}} onWaiting={()=>setPhase('缓冲中')} onEnded={ended}/>
      {phase&&!error&&<div className="player-status"><div className={playing?'':'spinner'}/><span>{phase}</span>{phase==='点击开始播放'&&<button className="btn primary" onClick={toggle}><Play size={18}/>播放</button>}</div>}
      {error&&<div className="player-error"><RotateCcw size={28}/><h3>暂时无法播放</h3><p>{error}</p><button className="btn primary" onClick={()=>{resume.current=position;setRetry(n=>n+1);}}>重试当前集</button></div>}
      <div className="player-controls" onClick={e=>{const target=e.target as HTMLElement;if(target.closest('button'))target.closest('button')?.blur();hide();}}>
        <div className="timeline"><div className="buffer-bar" style={{width:`${duration?buffered/duration*100:0}%`}}/><input aria-label="播放进度" type="range" min="0" max={duration||1} step=".1" value={position} onChange={e=>{if(video.current)video.current.currentTime=Number(e.target.value);setPosition(Number(e.target.value));hide();}} style={{background:`linear-gradient(to right,var(--brand) ${duration?position/duration*100:0}%,transparent 0)`}}/></div>
        <div className="controls-row"><button className="icon-button" title={playing?'暂停（空格）':'播放（空格）'} onClick={toggle}>{playing?<Pause size={23}/>:<Play size={23}/>}</button><button className="icon-button" title="下一集（J）" disabled={episode>=detail.episodes.length} onClick={()=>selectEpisode(episode+1)}><SkipForward size={22}/></button><span className="player-time">{time(position)} <span>/ {time(duration)}</span></span><div className="controls-spacer"/><button className="icon-button" title="静音（M）" onClick={()=>setMuted(m=>!m)}>{muted?<VolumeX size={20}/>:<Volume2 size={20}/>}</button><input className="volume-slider" aria-label="音量" type="range" min="0" max="1" step=".05" value={muted?0:settings.volume} onChange={e=>{setMuted(false);onSettings({volume:Number(e.target.value)});}}/><select aria-label="播放倍速" value={settings.rate} onChange={e=>{onSettings({rate:Number(e.target.value)});e.currentTarget.blur();hide();}}>{rates.map(r=><option key={r} value={r}>{r}×</option>)}</select><select aria-label="播放画质" value={settings.quality} onChange={e=>{resume.current=position;onSettings({quality:e.target.value});e.currentTarget.blur();hide();}}>{['auto','1080p','720p','540p','480p'].map(q=><option key={q} value={q}>{q==='auto'?'自动':q}</option>)}</select><button className={`icon-button ${comments?'active':''}`} title="评论" onClick={()=>setComments(v=>!v)}><MessageSquare size={20}/></button><button className="icon-button" title="剧场模式（T）" onClick={()=>setTheater(t=>!t)}><Monitor size={20}/></button><button className="icon-button" title="全屏（F）" onClick={()=>void window.hongguo.window('fullscreen')}><Maximize size={20}/></button></div>
      </div></div>{comments&&<Comments seriesId={detail.series.id} episode={episode} onClose={()=>setComments(false)}/>}</div>
    {notice&&<div className="player-notice" role="status">{notice}<button onClick={()=>setNotice('')}><X size={15}/></button></div>}
    <div className="episode-heading"><div><h3>选集</h3><span>{episodeMeta?.title||`第 ${episode} 集`}</span></div><div className="episode-actions"><label className="autoplay-switch"><input type="checkbox" checked={settings.autoplay} onChange={e=>onSettings({autoplay:e.target.checked})}/> 自动连播</label><button className="icon-button" aria-label="上一集" disabled={episode<=1} onClick={()=>selectEpisode(episode-1)}><ChevronLeft size={20}/></button><button className="icon-button" aria-label="下一集" disabled={episode>=detail.episodes.length} onClick={()=>selectEpisode(episode+1)}><ChevronRight size={20}/></button></div></div>
    <div className="episode-grid">{detail.episodes.map((e:Episode)=><button key={e.index} className={episode===e.index?'selected':''} aria-label={`播放第${e.index}集`} aria-current={episode===e.index?'true':undefined} onClick={()=>selectEpisode(e.index)}>{e.index}{episode===e.index&&<span className="playing-bars">▥</span>}</button>)}</div><p className="player-description">{detail.series.intro}</p>
  </div>;
}
function Comments({seriesId,episode,onClose}:{seriesId:string;episode:number;onClose:()=>void}){
  const [page,setPage]=useState<CommentsPage>({items:[],total:0,cursor:0,hasMore:false}),[busy,setBusy]=useState(true),[error,setError]=useState('');const generation=useRef(0);
  const load=useCallback(async(cursor=0)=>{const gen=generation.current;setBusy(true);setError('');try{const d=await window.hongguo.request<CommentsPage>(`/catalog/comments?seriesId=${seriesId}&episode=${episode}&cursor=${cursor}`);if(generation.current!==gen)return;setPage(p=>({...d,items:cursor?[...p.items,...d.items.filter(i=>!p.items.some(x=>x.id===i.id))]:d.items}));}catch(e){if(generation.current===gen)setError((e as Error).message);}finally{if(generation.current===gen)setBusy(false);}},[seriesId,episode]);
  useEffect(()=>{generation.current++;setPage({items:[],total:0,cursor:0,hasMore:false});void load();return()=>{generation.current++;};},[load]);
  return <aside className="comments-panel"><div className="comments-header"><h3>第 {episode} 集评论 <span>{page.total}</span></h3><button className="icon-button" aria-label="关闭评论" onClick={onClose}><X size={18}/></button></div><div className="comments-list">{page.items.map(c=><article className="comment" key={c.id}>{c.avatar?<img src={c.avatar} alt="" loading="lazy"/>:<div className="comment-avatar">{c.nickname.slice(0,1)||'观'}</div>}<div><strong>{c.nickname}</strong><p>{c.text}</p><small>{commentTime(c.time)} · {c.likes} 赞</small></div></article>)}{!busy&&!error&&!page.items.length&&<div className="empty-state"><MessageSquare size={30}/><p>这集还没有评论</p></div>}{error&&<div className="comment-error"><p>{error}</p><button className="btn" onClick={()=>void load(page.cursor)}>重试</button></div>}{busy&&<div className="loading-state"><span className="spinner"/>加载评论</div>}{!busy&&page.hasMore&&<button className="btn" onClick={()=>void load(page.cursor)}>加载更多</button>}</div></aside>;
}
