import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, Pause, SkipForward, Volume2, VolumeX, Maximize, Minimize, MessageSquare, RotateCcw, ChevronLeft, ChevronRight, X, Heart, Monitor } from 'lucide-react';
import type { CommentsPage, Episode, MediaSession, SeriesDetail, Settings } from '../../shared/contracts';
import { SeamlessSwitcher, type PlaybackTarget } from '../playback/SeamlessSwitcher';
import { HlsDeckLoader, type VideoDeck } from '../playback/HlsDeck';
import './Player.css';
type Props = { detail: SeriesDetail; initialEpisode: number; initialPosition?: number; settings: Settings; onClose: () => void; onSettings: (patch: Partial<Settings>) => void; onLibrary: () => void };
const time = (n: number) => Number.isFinite(n) && n >= 0 ? `${Math.floor(n / 60).toString().padStart(2, '0')}:${Math.floor(n % 60).toString().padStart(2, '0')}` : '00:00';
const rates = [.75, 1, 1.25, 1.5, 2, 2.5, 3];
const commentTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); };
const nextPaint = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 180); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
export default function Player({ detail, initialEpisode, initialPosition = 0, settings, onClose, onSettings, onLibrary }: Props) {
  const videos = useRef<(HTMLVideoElement | null)[]>([null, null]), playbackLayout = useRef<HTMLDivElement>(null);
  const switcher = useRef<SeamlessSwitcher<VideoDeck> | null>(null), fullscreenBusy = useRef(false), clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefetch = useRef(new Map<string, string>()), closed = useRef(false), visible = useRef(true), shouldPlay = useRef(true), automaticSwitch = useRef(false), lastSaved = useRef(0), mounted = useRef(false);
  const latest = useRef({ detail, settings, onSettings, onLibrary, onClose }); latest.current = { detail, settings, onSettings, onLibrary, onClose };
  const mutedRef = useRef(false), requested = useRef<PlaybackTarget | null>(null);
  const [active, setActive] = useState(0), [episode, setEpisode] = useState(initialEpisode), [pendingEpisode, setPendingEpisode] = useState<number | null>(null), [phase, setPhase] = useState('准备播放'), [error, setError] = useState('');
  const [playing, setPlaying] = useState(false), [chrome, setChrome] = useState(true), [position, setPosition] = useState(initialPosition), [duration, setDuration] = useState(0), [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false), [comments, setComments] = useState(false), [theater, setTheater] = useState(false), [favorite, setFavorite] = useState(false), [notice, setNotice] = useState(''), [fullscreen, setFullscreen] = useState(false);
  mutedRef.current = muted;
  const current = () => switcher.current?.current ?? null;
  const video = { get current() { return current()?.video ?? null; } };
  const episodeMeta = detail.episodes.find(item => item.index === episode);
  const nextEpisode = () => requested.current?.episode ?? current()?.target.episode ?? episode;
  const saveDeck = useCallback(async (deck: VideoDeck | null) => {
    const element = deck?.video; if (!deck || !element || !Number.isFinite(element.currentTime) || element.currentTime <= 0) return;
    try { await window.hongguo.saveProgress({ series: latest.current.detail.series, episode: deck.target.episode, position: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : 0 }); latest.current.onLibrary(); }
    catch { if (mounted.current) setNotice('记录暂未保存，请检查可用磁盘空间'); }
  }, []);
  const save = useCallback(() => saveDeck(current()), [saveDeck]);
  const hide = useCallback(() => { clearTimeout(hideTimer.current); setChrome(true); hideTimer.current = setTimeout(() => { if (current()?.video && !current()?.video.paused) setChrome(false); }, 2500); }, []);
  const applySound = (deck: VideoDeck) => { const s = latest.current.settings; deck.video.playbackRate = s.rate; deck.video.volume = s.volume; deck.video.muted = mutedRef.current; };
  const target = (index: number, start = 0): PlaybackTarget => ({ seriesId: latest.current.detail.series.id, episode: index, quality: latest.current.settings.quality, start });
  const scheduleNext = useCallback((deck: VideoDeck) => {
    const next = latest.current.detail.episodes.find(item => item.index === deck.target.episode + 1);
    if (next) switcher.current?.warm(target(next.index));
  }, []);
  const selectEpisode = useCallback(async (index: number, automatic = false, start = 0, keepPaused = false, force = false) => {
    if (!latest.current.detail.episodes.some(item => item.index === index) || closed.current) return;
    const next = target(index, start),displayed=current();
    if(!force&&displayed?.target.episode===index&&displayed.target.quality===next.quality&&Math.abs(displayed.target.start-start)<.1){hide();return;}
    requested.current = next; automaticSwitch.current = automatic;
    shouldPlay.current = keepPaused ? !current()?.video.paused : true;
    if (current()) { void saveDeck(current()); current()?.video.pause(); }
    setPendingEpisode(index); setError(''); if (!current()) setPhase('准备播放'); if (!automatic) hide();
    try {
      const committed = await switcher.current?.select(next, automatic, force);
      if (!committed || closed.current) return;
      requested.current = null; setPendingEpisode(null); scheduleNext(committed);
    } catch (failure) {
      if (closed.current || requested.current !== next) return;
      setPendingEpisode(null); setPhase(''); setError((failure as Error).message || '视频准备失败，请重试'); setChrome(true);
    }
  }, [hide, saveDeck, scheduleNext]);
  useEffect(() => {
    mounted.current = true; closed.current = false;
    const elements = videos.current.filter((element): element is HTMLVideoElement => !!element);
    const loader = new HlsDeckLoader(elements, window.hongguo, (deck, message) => {
      if (current() === deck && mounted.current) { setError(message); setChrome(true); shouldPlay.current = false; }
    });
    const controller = new SeamlessSwitcher<VideoDeck>({
      prepare: (index, wanted, signal) => loader.prepare(index, wanted, signal),
      present: (deck, previous, automatic) => {
        deck.video.dataset.active = 'true'; deck.video.dataset.episode=String(deck.target.episode);deck.video.style.zIndex = '1'; deck.video.style.visibility = 'visible';
        if (previous) { previous.video.muted = true; previous.video.pause(); previous.video.dataset.active = 'false'; previous.video.style.zIndex = '0'; }
        applySound(deck); setActive(deck.index); setEpisode(deck.target.episode); setPosition(deck.video.currentTime); setDuration(Number.isFinite(deck.video.duration) ? deck.video.duration : 0); setBuffered(0); setPhase(''); setError('');
        if (automatic) setChrome(false); else hide();
        if (visible.current && shouldPlay.current && !closed.current) void deck.video.play().catch(() => { if (current() === deck) { setPhase('点击开始播放'); setChrome(true); } });
        else { deck.video.pause(); setPlaying(false); }
      },
      afterPresent: nextPaint,
    });
    switcher.current = controller; void selectEpisode(initialEpisode, false, initialPosition);
    void window.hongguo.getLibrary().then(lib => { if (mounted.current) setFavorite(lib.favorites.some(series => series.id === detail.series.id)); });
    return () => { mounted.current = false; closed.current = true; clearTimeout(clickTimer.current); clearTimeout(hideTimer.current); void saveDeck(controller.current); void controller.close(); for (const id of prefetch.current.values()) if (id !== 'pending') void window.hongguo.request(`/media/session/${id}`, { method: 'DELETE' }).catch(() => {}); prefetch.current.clear(); };
  }, [detail.series.id, initialEpisode, initialPosition, hide, selectEpisode, saveDeck]);
  useEffect(() => {
    const deck = current(); if (!deck) return;
    if (deck.target.quality !== settings.quality) { switcher.current?.cancelPending(); void selectEpisode(deck.target.episode, false, deck.video.currentTime, true); }
    else applySound(deck);
  }, [settings.rate, settings.volume, settings.quality, muted, selectEpisode]);
  useEffect(() => {
    const refresh = () => {
      const deck = current(); if (!deck) return; scheduleNext(deck);
      const wanted = `${deck.target.episode + 2}:${latest.current.settings.quality}`;
      for (const [key, id] of prefetch.current) if (key !== wanted) { prefetch.current.delete(key); if (id !== 'pending') void window.hongguo.request(`/media/session/${id}`, { method: 'DELETE' }).catch(() => {}); }
      const second = latest.current.detail.episodes.find(item => item.index === deck.target.episode + 2);
      if (!second || prefetch.current.has(wanted)) return;
      prefetch.current.set(wanted, 'pending');
      void window.hongguo.request<MediaSession>('/media/session', { method: 'POST', body: { seriesId: deck.target.seriesId, episode: second.index, quality: latest.current.settings.quality, prefetch: true } }).then(session => {
        if (closed.current || !prefetch.current.has(wanted)) void window.hongguo.request(`/media/session/${session.id}`, { method: 'DELETE' }).catch(() => {});
        else prefetch.current.set(wanted, session.id);
      }).catch(() => prefetch.current.delete(wanted));
    };
    refresh(); const timer = setInterval(refresh, 12000); return () => clearInterval(timer);
  }, [episode, settings.quality, scheduleNext]);
  const toggleFullscreen = useCallback(async () => {
    const layout = playbackLayout.current; if (!layout || fullscreenBusy.current) return; fullscreenBusy.current = true;
    try { if (document.fullscreenElement === layout) await document.exitFullscreen(); else await layout.requestFullscreen(); hide(); }
    catch { setNotice('无法进入全屏，请重试'); } finally { fullscreenBusy.current = false; }
  }, [hide]);
  useEffect(() => { const layout = playbackLayout.current; const changed = () => { setFullscreen(document.fullscreenElement === layout); hide(); }; document.addEventListener('fullscreenchange', changed); return () => { document.removeEventListener('fullscreenchange', changed); if (document.fullscreenElement === layout) void document.exitFullscreen().catch(() => {}); }; }, [hide]);
  const toggle = useCallback(() => {
    const deck = current(); if (!deck || error) return;
    shouldPlay.current = deck.video.paused; if (shouldPlay.current && visible.current) { applySound(deck); void deck.video.play().catch(() => {}); } else deck.video.pause(); hide();
  }, [error, hide]);
  useEffect(() => window.hongguo.onVisibility(value => { visible.current = value; if (!value) { shouldPlay.current = false; void save(); current()?.video.pause(); } }), [save]);
  useEffect(() => window.hongguo.onShutdown(save), [save]);
  const seekBy = useCallback((amount: number) => { const element = current()?.video; if (element && Number.isFinite(element.duration)) element.currentTime = Math.min(Math.max(0, element.currentTime + amount), element.duration); hide(); }, [hide]);
  const close = useCallback(() => { if (closed.current) return; closed.current = true; shouldPlay.current = false; void save(); current()?.video.pause(); if (document.fullscreenElement === playbackLayout.current) void document.exitFullscreen().catch(() => {}).finally(() => latest.current.onClose()); else latest.current.onClose(); }, [save]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement && ['text', 'search', 'password', 'email', 'tel', 'number'].includes(event.target.type) || event.target instanceof HTMLElement && event.target.isContentEditable) return;
      const k = event.key.toLowerCase(); if (![' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f', 'j', 'n', '[', ']', 'escape', 't'].includes(k) && !/^\d$/.test(k)) return; event.preventDefault();
      if (k === ' ' || k === 'k') toggle(); else if (k === 'arrowleft') seekBy(-5); else if (k === 'arrowright') seekBy(5); else if (k === 'arrowup' || k === 'arrowdown') latest.current.onSettings({ volume: Math.max(0, Math.min(1, latest.current.settings.volume + (k === 'arrowup' ? .05 : -.05))) });
      else if (k === 'm') setMuted(value => !value); else if (k === 'f') void toggleFullscreen(); else if (k === 't') setTheater(value => !value); else if (k === 'j' || k === 'n') void selectEpisode(nextEpisode() + 1);
      else if (k === 'escape') { if (document.fullscreenElement === playbackLayout.current) void document.exitFullscreen().catch(() => {}); else void window.hongguo.window('exitfullscreen').then(was => { if (!was) close(); }); }
      else if (k === '[' || k === ']') latest.current.onSettings({ rate: rates[Math.max(0, Math.min(rates.length - 1, rates.indexOf(latest.current.settings.rate) + (k === ']' ? 1 : -1)))] });
      else if (/^\d$/.test(k)) { const element = current()?.video; if (element && Number.isFinite(element.duration)) element.currentTime = element.duration * Number(k) / 10; } hide();
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [toggle, seekBy, selectEpisode, hide, close, toggleFullscreen, episode]);
  const onTime = (index: number) => { const deck = current(); if (!deck || deck.index !== index) return; const element = deck.video; setPosition(element.currentTime); setDuration(Number.isFinite(element.duration) ? element.duration : 0); if (element.buffered.length) setBuffered(element.buffered.end(element.buffered.length - 1)); if (Date.now() - lastSaved.current > 10000) { lastSaved.current = Date.now(); void saveDeck(deck); } };
  const ended = (index: number) => { const deck = current(); if (!deck || deck.index !== index) return; void saveDeck(deck); if (latest.current.settings.autoplay && latest.current.detail.episodes.some(item => item.index === deck.target.episode + 1)) void selectEpisode(deck.target.episode + 1, true); else { shouldPlay.current = false; setPlaying(false); setChrome(true); setPhase('本集播放完毕'); } };
  return <div className={`player-page ${theater?'player-theater':''}`}>
    <div className="player-heading"><button className="btn" onClick={close}><ArrowLeft size={17}/> 返回</button><div><h2>{detail.series.title}</h2><span>第 {episode} 集 · 共 {detail.episodes.length} 集</span>{pendingEpisode&&<small className="switch-status">正在准备第 {pendingEpisode} 集，保留当前画面</small>}</div><button className={`icon-button ${favorite?'active':''}`} title={favorite?'取消收藏':'收藏'} onClick={()=>void window.hongguo.toggleFavorite(detail.series).then(lib=>{setFavorite(lib.favorites.some(s=>s.id===detail.series.id));onLibrary();}).catch(e=>setNotice(e.message))}><Heart size={20} fill={favorite?'currentColor':'none'}/></button></div>
    <div className="playback-layout" ref={playbackLayout}><div className={`video-stage ${chrome?'':'controls-hidden'}`} onMouseMove={hide} onMouseLeave={()=>{if(playing)setChrome(false);}}>
      <div className="fullscreen-toolbar"><div><strong>{detail.series.title}</strong><span>第 {episode} 集</span></div><button className="icon-button" title="退出全屏（Esc）" onClick={()=>void toggleFullscreen()}><Minimize size={20}/></button></div>
      {[0,1].map(index=><video key={index} ref={element=>{videos.current[index]=element;}} className="decoder-video" data-active={active===index?'true':'false'} data-episode={active===index?episode:undefined} playsInline
        onClick={()=>{if(current()?.index!==index)return;clearTimeout(clickTimer.current);clickTimer.current=setTimeout(toggle,220);}} onDoubleClick={()=>{if(current()?.index!==index)return;clearTimeout(clickTimer.current);void toggleFullscreen();}}
        onTimeUpdate={()=>onTime(index)} onDurationChange={()=>onTime(index)} onProgress={()=>onTime(index)} onPlaying={()=>{if(current()?.index!==index)return;setPlaying(true);setPhase('');if(automaticSwitch.current){automaticSwitch.current=false;setChrome(false);}else hide();}}
        onPause={()=>{const deck=current();if(deck?.index!==index)return;setPlaying(false);const naturallyEnding=latest.current.settings.autoplay&&Number.isFinite(deck.video.duration)&&deck.video.currentTime>=deck.video.duration-.08;if(!naturallyEnding&&!automaticSwitch.current&&!requested.current)setChrome(true);}} onWaiting={()=>{if(current()?.index===index&&!requested.current)setPhase('缓冲中');}} onEnded={()=>ended(index)}/>)}
      {phase&&!error&&!current()&&<div className="player-status"><div className={playing?'':'spinner'}/><span>{phase}</span>{phase==='点击开始播放'&&<button className="btn primary" onClick={toggle}><Play size={18}/>播放</button>}</div>}
      {error&&<div className={`player-error ${current()?"switch-error":""}`}><RotateCcw size={28}/><h3>暂时无法播放</h3><p>{error}</p><button className="btn primary" onClick={()=>{const wanted=requested.current??current()?.target??target(initialEpisode,initialPosition);void selectEpisode(wanted.episode,false,wanted.start,false,true);}}>重试当前集</button></div>}
      <div className="player-controls" onClick={e=>{const target=e.target as HTMLElement;if(target.closest('button'))target.closest('button')?.blur();hide();}}>
        <div className="timeline"><div className="buffer-bar" style={{width:`${duration?buffered/duration*100:0}%`}}/><input aria-label="播放进度" type="range" min="0" max={duration||1} step=".1" value={position} onChange={e=>{if(video.current)video.current.currentTime=Number(e.target.value);setPosition(Number(e.target.value));hide();}} style={{background:`linear-gradient(to right,var(--brand) ${duration?position/duration*100:0}%,transparent 0)`}}/></div>
        <div className="controls-row"><button className="icon-button" title={playing?'暂停（空格）':'播放（空格）'} onClick={toggle}>{playing?<Pause size={23}/>:<Play size={23}/>}</button><button className="icon-button" title="下一集（J）" disabled={nextEpisode()>=detail.episodes.length} onClick={()=>selectEpisode(nextEpisode()+1)}><SkipForward size={22}/></button><span className="player-time">{time(position)} <span>/ {time(duration)}</span></span><div className="controls-spacer"/><button className="icon-button" title="静音（M）" onClick={()=>setMuted(m=>!m)}>{muted?<VolumeX size={20}/>:<Volume2 size={20}/>}</button><input className="volume-slider" aria-label="音量" type="range" min="0" max="1" step=".05" value={muted?0:settings.volume} onChange={e=>{setMuted(false);onSettings({volume:Number(e.target.value)});}}/><select aria-label="播放倍速" value={settings.rate} onChange={e=>{onSettings({rate:Number(e.target.value)});e.currentTarget.blur();hide();}}>{rates.map(r=><option key={r} value={r}>{r}×</option>)}</select><select aria-label="播放画质" value={settings.quality} onChange={e=>{onSettings({quality:e.target.value});e.currentTarget.blur();hide();}}>{['auto','1080p','720p','540p','480p'].map(q=><option key={q} value={q}>{q==='auto'?'自动':q}</option>)}</select><button className={`icon-button ${comments?'active':''}`} title="评论" onClick={()=>setComments(v=>!v)}><MessageSquare size={20}/></button><button className="icon-button" title="剧场模式（T）" onClick={()=>setTheater(t=>!t)}><Monitor size={20}/></button><button className="icon-button" title={fullscreen?'退出全屏（F）':'全屏（F）'} aria-pressed={fullscreen} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize size={20}/>:<Maximize size={20}/>}</button></div>
      </div></div>{comments&&<Comments seriesId={detail.series.id} episode={episode} onClose={()=>setComments(false)}/>}</div>
    {notice&&<div className="player-notice" role="status">{notice}<button onClick={()=>setNotice('')}><X size={15}/></button></div>}
    <div className="episode-heading"><div><h3>选集</h3><span>{episodeMeta?.title||`第 ${episode} 集`}</span></div><div className="episode-actions"><label className="autoplay-switch"><input type="checkbox" checked={settings.autoplay} onChange={e=>onSettings({autoplay:e.target.checked})}/> 自动连播</label><button className="icon-button" aria-label="上一集" disabled={nextEpisode()<=1} onClick={()=>selectEpisode(nextEpisode()-1)}><ChevronLeft size={20}/></button><button className="icon-button" aria-label="下一集" disabled={nextEpisode()>=detail.episodes.length} onClick={()=>selectEpisode(nextEpisode()+1)}><ChevronRight size={20}/></button></div></div>
    <div className="episode-grid">{detail.episodes.map((e:Episode)=><button key={e.index} className={episode===e.index?'selected':''} aria-label={`播放第${e.index}集`} aria-current={episode===e.index?'true':undefined} onClick={()=>selectEpisode(e.index)}>{e.index}{episode===e.index&&<span className="playing-bars">▥</span>}</button>)}</div><p className="player-description">{detail.series.intro}</p>
  </div>;
}
function Comments({seriesId,episode,onClose}:{seriesId:string;episode:number;onClose:()=>void}){
  const [page,setPage]=useState<CommentsPage>({items:[],total:0,cursor:0,hasMore:false}),[busy,setBusy]=useState(true),[error,setError]=useState('');const generation=useRef(0);
  const load=useCallback(async(cursor=0)=>{const gen=generation.current;setBusy(true);setError('');try{const d=await window.hongguo.request<CommentsPage>(`/catalog/comments?seriesId=${seriesId}&episode=${episode}&cursor=${cursor}`);if(generation.current!==gen)return;setPage(p=>({...d,items:cursor?[...p.items,...d.items.filter(i=>!p.items.some(x=>x.id===i.id))]:d.items}));}catch(e){if(generation.current===gen)setError((e as Error).message);}finally{if(generation.current===gen)setBusy(false);}},[seriesId,episode]);
  useEffect(()=>{generation.current++;setPage({items:[],total:0,cursor:0,hasMore:false});void load();return()=>{generation.current++;};},[load]);
  return <aside className="comments-panel"><div className="comments-header"><h3>第 {episode} 集评论 <span>{page.total}</span></h3><button className="icon-button" aria-label="关闭评论" onClick={onClose}><X size={18}/></button></div><div className="comments-list">{page.items.map(c=><article className="comment" key={c.id}>{c.avatar?<img src={c.avatar} alt="" loading="lazy"/>:<div className="comment-avatar">{c.nickname.slice(0,1)||'观'}</div>}<div><strong>{c.nickname}</strong><p>{c.text}</p><small>{commentTime(c.time)} · {c.likes} 赞</small></div></article>)}{!busy&&!error&&!page.items.length&&<div className="empty-state"><MessageSquare size={30}/><p>这集还没有评论</p></div>}{error&&<div className="comment-error"><p>{error}</p><button className="btn" onClick={()=>void load(page.cursor)}>重试</button></div>}{busy&&<div className="loading-state"><span className="spinner"/>加载评论</div>}{!busy&&page.hasMore&&<button className="btn" onClick={()=>void load(page.cursor)}>加载更多</button>}</div></aside>;
}
