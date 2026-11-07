import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, Pause, SkipForward, Volume2, VolumeX, Maximize, Minimize, MessageSquare, RotateCcw, ChevronLeft, ChevronRight, X, Heart, Monitor, SlidersHorizontal } from 'lucide-react';
import type { CommentsPage, Episode, MediaSession, SeriesDetail, Settings } from '../../shared/contracts';
import { SeamlessSwitcher, type PlaybackTarget } from '../playback/SeamlessSwitcher';
import { HlsDeckLoader, type VideoDeck } from '../playback/HlsDeck';
import {availablePosition,knownDuration} from '../playback/timeline';
import { danmakuPreferences, type DanmakuPreferences } from '../../shared/danmaku-settings';
import type { DanmakuStatus } from '../danmaku/feed';
import Danmaku from './Danmaku';
import DanmakuPanel from './DanmakuPanel';
import './Player.css';
type Props = { detail: SeriesDetail; initialEpisode: number; initialPosition?: number; settings: Settings; accountKey?: string; onClose: () => void; onSettings: (patch: Partial<Settings>) => void; onLibrary: () => void };
const time = (n: number) => Number.isFinite(n) && n >= 0 ? `${Math.floor(n / 60).toString().padStart(2, '0')}:${Math.floor(n % 60).toString().padStart(2, '0')}` : '00:00';
const rates = [.75, 1, 1.25, 1.5, 2, 2.5, 3];
const commentTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); };
const nextPaint = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 180); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
export default function Player({ detail, initialEpisode, initialPosition = 0, settings, accountKey = 'local', onClose, onSettings, onLibrary }: Props) {
  const videos = useRef<(HTMLVideoElement | null)[]>([null, null]), playbackLayout = useRef<HTMLDivElement>(null);
  const switcher = useRef<SeamlessSwitcher<VideoDeck> | null>(null), fullscreenBusy = useRef(false), clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefetch = useRef(new Map<string, string>()), closed = useRef(false), visible = useRef(true), shouldPlay = useRef(true), automaticSwitch = useRef(false), lastSaved = useRef(0), mounted = useRef(false);
  const latest = useRef({ detail, settings, onSettings, onLibrary, onClose }); latest.current = { detail, settings, onSettings, onLibrary, onClose };
  const mutedRef = useRef(false), requested = useRef<PlaybackTarget | null>(null);
  const episodeDurations=useRef(new Map<string,number>());
  const theaterScroll=useRef(0),theaterRef=useRef(false);
  const danmakuPanelRef = useRef(false);
  const pendingDanmaku = useRef<DanmakuPreferences | null>(null);
  const [active, setActive] = useState(0), [episode, setEpisode] = useState(initialEpisode), [pendingEpisode, setPendingEpisode] = useState<number | null>(null), [phase, setPhase] = useState('准备播放'), [error, setError] = useState('');
  const [playing, setPlaying] = useState(false), [chrome, setChrome] = useState(true), [position, setPosition] = useState(initialPosition), [duration, setDuration] = useState(0), [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false), [comments, setComments] = useState(false), [theater, setTheater] = useState(false), [favorite, setFavorite] = useState(false), [notice, setNotice] = useState(''), [fullscreen, setFullscreen] = useState(false);
  const [pendingPosition,setPendingPosition]=useState<number|null>(null);
  const [danmakuPanel, setDanmakuPanel] = useState(false), [danmakuRefresh, setDanmakuRefresh] = useState(0);
  const [danmakuStatus, setDanmakuStatus] = useState<DanmakuStatus>({ loading: false, loaded: 0, error: '' });
  const [danmakuSettings, setDanmakuSettings] = useState(() => danmakuPreferences(settings.danmaku));
  useEffect(() => { const saved = danmakuPreferences(settings.danmaku); if (pendingDanmaku.current && JSON.stringify(saved) !== JSON.stringify(pendingDanmaku.current)) return; pendingDanmaku.current = null; setDanmakuSettings(saved); }, [settings.danmaku]);
  mutedRef.current = muted;
  const current = () => switcher.current?.current ?? null;
  const video = { get current() { return current()?.video ?? null; } };
  const episodeMeta = detail.episodes.find(item => item.index === episode);
  const nextEpisode = () => requested.current?.episode ?? current()?.target.episode ?? episode;
  const saveDeck = useCallback(async (deck: VideoDeck | null) => {
    const element = deck?.video; if (!deck || !element || !Number.isFinite(element.currentTime) || element.currentTime <= 0) return;
    try { await window.hongguo.saveProgress({ series: latest.current.detail.series, episode: deck.target.episode, position: element.currentTime, duration: knownDuration(deck.duration) }); latest.current.onLibrary(); }
    catch { if (mounted.current) setNotice('记录暂未保存，请检查可用磁盘空间'); }
  }, []);
  const save = useCallback(() => saveDeck(current()), [saveDeck]);
  const hide = useCallback(() => { clearTimeout(hideTimer.current); setChrome(true); if (danmakuPanelRef.current) return; hideTimer.current = setTimeout(() => { if (current()?.video && !current()?.video.paused && !danmakuPanelRef.current) setChrome(false); }, 2500); }, []);
  const activeVideo = useCallback(() => switcher.current?.current?.video ?? null, []);
  const updateDanmaku = useCallback((patch: Partial<DanmakuPreferences>) => { const next = danmakuPreferences({ ...(pendingDanmaku.current ?? danmakuPreferences(latest.current.settings.danmaku)), ...patch }); pendingDanmaku.current = next; setDanmakuSettings(next); latest.current.onSettings({ danmaku: next }); hide(); }, [hide]);
  const closeDanmakuPanel = useCallback(() => { danmakuPanelRef.current = false; setDanmakuPanel(false); hide(); }, [hide]);
  const toggleDanmakuPanel = useCallback(() => { danmakuPanelRef.current = !danmakuPanelRef.current; setDanmakuPanel(danmakuPanelRef.current); hide(); }, [hide]);
  const toggleTheater=useCallback(()=>{const scroll=playbackLayout.current?.closest('.content-scroll') as HTMLElement|null;const next=!theaterRef.current;if(next)theaterScroll.current=scroll?.scrollTop||0;theaterRef.current=next;setTheater(next);requestAnimationFrame(()=>{if(scroll)scroll.scrollTop=next?0:theaterScroll.current;});hide();},[hide]);
  const applySound = (deck: VideoDeck) => { const s = latest.current.settings; deck.video.playbackRate = s.rate; deck.video.volume = s.volume; deck.video.muted = mutedRef.current; };
  const target = (index: number, start = 0): PlaybackTarget => ({ seriesId: latest.current.detail.series.id, episode: index, quality: latest.current.settings.quality, start,
    duration:episodeDurations.current.get(`${latest.current.detail.series.id}:${index}`)||knownDuration(latest.current.detail.episodes.find(item=>item.index===index)?.duration) });
  const scheduleNext = useCallback((deck: VideoDeck) => {
    const next = latest.current.detail.episodes.find(item => item.index === deck.target.episode + 1);
    if (next) switcher.current?.warm(target(next.index));
  }, []);
  const selectEpisode = useCallback(async (index: number, automatic = false, start = 0, keepPaused = false, force = false) => {
    if (!latest.current.detail.episodes.some(item => item.index === index) || closed.current) return;
    const next = target(index, start),displayed=current();
    if(!force&&displayed?.target.episode===index&&displayed.target.quality===next.quality&&Math.abs(displayed.target.start-start)<.1){hide();return;}
    requested.current = next; automaticSwitch.current = automatic;
    setPendingPosition(displayed?.target.episode===index&&Math.abs(start-displayed.video.currentTime)>.15?start:null);
    shouldPlay.current = keepPaused ? !current()?.video.paused : true;
    if (current()) { void saveDeck(current()); current()?.video.pause(); }
    setPendingEpisode(index); setError(''); if (!current()) setPhase('准备播放'); if (!automatic) hide();
    try {
      const committed = await switcher.current?.select(next, automatic, force);
      if (!committed || closed.current) return;
      requested.current = null; setPendingEpisode(null);setPendingPosition(null); scheduleNext(committed);
    } catch (failure) {
      if (closed.current || requested.current !== next) return;
      setPendingEpisode(null);setPendingPosition(null); setPhase(''); setError((failure as Error).message || '视频准备失败，请重试'); setChrome(true);
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
        const full=episodeDurations.current.get(`${deck.target.seriesId}:${deck.target.episode}`)||knownDuration(deck.duration);
        if(full){episodeDurations.current.set(`${deck.target.seriesId}:${deck.target.episode}`,full);deck.duration=full;}
        applySound(deck); setActive(deck.index); setEpisode(deck.target.episode); setPosition(deck.video.currentTime); setDuration(full); setBuffered(0); setPhase(''); setError('');
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
  const seekTo=useCallback((value:number)=>{const deck=current();if(!deck||!knownDuration(deck.duration))return;
    const destination=Math.min(Math.max(0,value),Math.max(0,deck.duration-.05));
    if(availablePosition(destination,deck.video.seekable)){setPendingPosition(null);deck.video.currentTime=destination;setPosition(destination);}
    else void selectEpisode(deck.target.episode,false,destination,true,true);
    hide();
  },[hide,selectEpisode]);
  const seekBy = useCallback((amount: number) => { const deck=current();if(deck)seekTo(deck.video.currentTime+amount); }, [seekTo]);
  const close = useCallback(() => { if (closed.current) return; closed.current = true; shouldPlay.current = false; void save(); current()?.video.pause(); if (document.fullscreenElement === playbackLayout.current) void document.exitFullscreen().catch(() => {}).finally(() => latest.current.onClose()); else latest.current.onClose(); }, [save]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const field = event.target instanceof HTMLInputElement ? event.target : null;
      if (event.ctrlKey || event.altKey || event.metaKey || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || field && field.type !== 'range' || event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (field?.type === 'range' && /^(Arrow|Home|End|Page)/.test(event.key)) return;
      const k = event.key.toLowerCase(); if (![' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f', 'j', 'n', '[', ']', 'escape', 't', 'd'].includes(k) && !/^\d$/.test(k)) return; event.preventDefault();
      if (k === 'escape' && danmakuPanelRef.current) { closeDanmakuPanel(); return; }
      if (k === ' ' || k === 'k') toggle(); else if (k === 'arrowleft') seekBy(-5); else if (k === 'arrowright') seekBy(5); else if (k === 'arrowup' || k === 'arrowdown') latest.current.onSettings({ volume: Math.max(0, Math.min(1, latest.current.settings.volume + (k === 'arrowup' ? .05 : -.05))) });
      else if (k === 'm') setMuted(value => !value); else if (k === 'f') void toggleFullscreen(); else if (k === 't') toggleTheater(); else if (k === 'j' || k === 'n') void selectEpisode(nextEpisode() + 1);
      else if (k === 'd') updateDanmaku({ enabled: !(pendingDanmaku.current ?? danmakuPreferences(latest.current.settings.danmaku)).enabled });
      else if (k === 'escape') { if (document.fullscreenElement === playbackLayout.current) void document.exitFullscreen().catch(() => {}); else void window.hongguo.window('exitfullscreen').then(was => { if (!was) close(); }); }
      else if (k === '[' || k === ']') latest.current.onSettings({ rate: rates[Math.max(0, Math.min(rates.length - 1, rates.indexOf(latest.current.settings.rate) + (k === ']' ? 1 : -1)))] });
      else if (/^\d$/.test(k)) { const deck=current();if(deck)seekTo(deck.duration*Number(k)/10); } hide();
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [toggle, seekBy, seekTo, selectEpisode, hide, close, toggleFullscreen, toggleTheater, updateDanmaku, closeDanmakuPanel, episode]);
  const onTime = (index: number) => { const deck = current(); if (!deck || deck.index !== index) return; const element = deck.video;
    const full=episodeDurations.current.get(`${deck.target.seriesId}:${deck.target.episode}`)||knownDuration(deck.duration);if(full)episodeDurations.current.set(`${deck.target.seriesId}:${deck.target.episode}`,full);deck.duration=full;
    setPosition(element.currentTime); setDuration(full); if (element.buffered.length) setBuffered(element.buffered.end(element.buffered.length - 1)); if (Date.now() - lastSaved.current > 10000) { lastSaved.current = Date.now(); void saveDeck(deck); } };
  const ended = (index: number) => { const deck = current(); if (!deck || deck.index !== index) return; void saveDeck(deck); if (latest.current.settings.autoplay && latest.current.detail.episodes.some(item => item.index === deck.target.episode + 1)) void selectEpisode(deck.target.episode + 1, true); else { shouldPlay.current = false; setPlaying(false); setChrome(true); setPhase('本集播放完毕'); } };
  return <div className={`player-page ${theater?'player-theater':''}`}>
    <div className="player-heading"><button className="btn" onClick={close}><ArrowLeft size={17}/> 返回</button><div><h2>{detail.series.title}</h2><span>第 {episode} 集 · 共 {detail.episodes.length} 集</span>{pendingEpisode&&<small className="switch-status">{pendingPosition!==null?`正在定位到 ${time(pendingPosition)}`:`正在准备第 ${pendingEpisode} 集，保留当前画面`}</small>}</div><button className={`icon-button ${favorite?'active':''}`} title={favorite?'取消收藏':'收藏'} onClick={()=>void window.hongguo.toggleFavorite(detail.series).then(lib=>{setFavorite(lib.favorites.some(s=>s.id===detail.series.id));onLibrary();}).catch(e=>setNotice(e.message))}><Heart size={20} fill={favorite?'currentColor':'none'}/></button></div>
    <div className="playback-layout" ref={playbackLayout}><div className={`video-stage ${chrome?'':'controls-hidden'}`} onMouseMove={hide} onMouseLeave={()=>{if(playing&&!danmakuPanelRef.current)setChrome(false);}}>
      <div className="fullscreen-toolbar"><div><strong>{detail.series.title}</strong><span>第 {episode} 集</span></div><button className="icon-button" title="退出全屏（Esc）" onClick={()=>void toggleFullscreen()}><Minimize size={20}/></button></div>
      {[0,1].map(index=><video key={index} ref={element=>{videos.current[index]=element;}} className="decoder-video" data-active={active===index?'true':'false'} data-episode={active===index?episode:undefined} playsInline
        onClick={()=>{if(current()?.index!==index)return;clearTimeout(clickTimer.current);clickTimer.current=setTimeout(toggle,220);}} onDoubleClick={()=>{if(current()?.index!==index)return;clearTimeout(clickTimer.current);void toggleFullscreen();}}
        onTimeUpdate={()=>onTime(index)} onDurationChange={()=>onTime(index)} onProgress={()=>onTime(index)} onPlaying={()=>{if(current()?.index!==index)return;setPlaying(true);setPhase('');if(automaticSwitch.current){automaticSwitch.current=false;setChrome(false);}else hide();}}
      onPause={()=>{const deck=current();if(deck?.index!==index)return;setPlaying(false);const naturallyEnding=latest.current.settings.autoplay&&deck.video.ended;if(!naturallyEnding&&!automaticSwitch.current&&!requested.current){setChrome(true);void saveDeck(deck);}}} onWaiting={()=>{if(current()?.index===index&&!requested.current)setPhase('缓冲中');}} onEnded={()=>ended(index)}/>)}
      {episodeMeta && <Danmaku seriesId={detail.series.id} episode={episode} vid={episodeMeta.vid} accountKey={accountKey} getVideo={activeVideo} initialTime={episode === initialEpisode ? initialPosition : 0} metadataDuration={duration || episodeMeta.duration || 0} preferences={danmakuSettings} refreshToken={danmakuRefresh} onStatus={setDanmakuStatus}/>}
      {phase&&!error&&!current()&&<div className="player-status"><div className={playing?'':'spinner'}/><span>{phase}</span>{phase==='点击开始播放'&&<button className="btn primary" onClick={toggle}><Play size={18}/>播放</button>}</div>}
      {error&&<div className={`player-error ${current()?"switch-error":""}`}><RotateCcw size={28}/><h3>暂时无法播放</h3><p>{error}</p><button className="btn primary" onClick={()=>{const wanted=requested.current??current()?.target??target(initialEpisode,initialPosition);void selectEpisode(wanted.episode,false,wanted.start,false,true);}}>重试当前集</button></div>}
      <div className="player-controls" onClick={e=>{const target=e.target as HTMLElement;if(target.closest('button'))target.closest('button')?.blur();hide();}}>
        {danmakuPanel && <DanmakuPanel preferences={danmakuSettings} status={danmakuStatus} onChange={updateDanmaku} onClose={closeDanmakuPanel} onRefresh={() => setDanmakuRefresh(value => value + 1)} onInteraction={hide}/>}
        <div className="timeline"><div className="buffer-bar" style={{width:`${duration?Math.min(100,buffered/duration*100):0}%`}}/><input aria-label="播放进度" type="range" min="0" max={duration||1} step=".1" disabled={!duration} title={duration?'拖动选择播放位置':'正在确认完整时长'} value={duration?Math.min(duration,pendingPosition??position):0} onChange={e=>seekTo(Number(e.target.value))} style={{background:`linear-gradient(to right,var(--brand) ${duration?Math.min(100,(pendingPosition??position)/duration*100):0}%,transparent 0)`}}/></div>
        <div className="controls-row">
          <button className="icon-button" title={playing?'暂停（空格）':'播放（空格）'} onClick={toggle}>{playing?<Pause size={23}/>:<Play size={23}/>}</button>
          <button className="icon-button" title="下一集（J）" disabled={nextEpisode()>=detail.episodes.length} onClick={()=>selectEpisode(nextEpisode()+1)}><SkipForward size={22}/></button>
          <span className="player-time">{time(pendingPosition??position)} <span>/ {duration?time(duration):'时长待确认'}</span></span><div className="controls-spacer"/>
          <div className="danmaku-actions"><button className={`icon-button danmaku-toggle ${danmakuSettings.enabled?'active':''}`} title={danmakuSettings.enabled?'关闭弹幕（D）':'开启弹幕（D）'} aria-label={danmakuSettings.enabled?'关闭弹幕':'开启弹幕'} aria-pressed={danmakuSettings.enabled} onClick={() => updateDanmaku({ enabled: !danmakuSettings.enabled })}>弹</button><button className={`icon-button danmaku-settings-button ${danmakuPanel?'active':''}`} title="弹幕设置" aria-label="弹幕设置" aria-expanded={danmakuPanel} onClick={toggleDanmakuPanel}><SlidersHorizontal size={15}/></button></div>
          <button className="icon-button" title="静音（M）" onClick={()=>setMuted(m=>!m)}>{muted?<VolumeX size={20}/>:<Volume2 size={20}/>}</button>
          <input className="volume-slider" aria-label="音量" type="range" min="0" max="1" step=".05" value={muted?0:settings.volume} onChange={e=>{setMuted(false);onSettings({volume:Number(e.target.value)});}}/>
          <select aria-label="播放倍速" value={settings.rate} onChange={e=>{onSettings({rate:Number(e.target.value)});e.currentTarget.blur();hide();}}>{rates.map(r=><option key={r} value={r}>{r}×</option>)}</select>
          <select aria-label="播放画质" value={settings.quality} onChange={e=>{onSettings({quality:e.target.value});e.currentTarget.blur();hide();}}>{['auto','1080p','720p','540p','480p'].map(q=><option key={q} value={q}>{q==='auto'?'自动':q}</option>)}</select>
          <button className={`icon-button ${comments?'active':''}`} title="评论" onClick={()=>setComments(v=>!v)}><MessageSquare size={20}/></button>
          <button className={theater?'icon-button active':'icon-button'} title={theater?'退出剧场模式（T）':'剧场模式（T）'} aria-pressed={theater} onClick={toggleTheater}><Monitor size={20}/></button>
          <button className="icon-button" title={fullscreen?'退出全屏（F）':'全屏（F）'} aria-pressed={fullscreen} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize size={20}/>:<Maximize size={20}/>}</button>
        </div>
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
