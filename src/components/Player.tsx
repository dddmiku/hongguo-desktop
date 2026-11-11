import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, Pause, SkipForward, Volume2, VolumeX, Maximize, Minimize, MessageSquare, RotateCcw, ChevronLeft, ChevronRight, X, Heart, Monitor, SlidersHorizontal, LoaderCircle } from 'lucide-react';
import type { CommentsPage, Episode, Series, SeriesDetail, Settings } from '../../shared/contracts';
import { SeamlessSwitcher, type PlaybackTarget } from '../playback/SeamlessSwitcher';
import { HlsDeckLoader, type VideoDeck } from '../playback/HlsDeck';
import {availablePosition,knownDuration} from '../playback/timeline';
import {PlaybackEnd} from '../playback/PlaybackEnd';
import {SeasonContinuation,type SeasonDestination} from '../playback/SeasonContinuation';
import {mediaPreload} from '../playback/MediaPreload';
import { danmakuPreferences, type DanmakuPreferences } from '../../shared/danmaku-settings';
import type { DanmakuStatus } from '../danmaku/feed';
import Danmaku from './Danmaku';
import DanmakuPanel from './DanmakuPanel';
import SeasonOverview from './SeasonOverview';
import './Player.css';
type Props = { detail: SeriesDetail; initialEpisode: number; initialPosition?: number; isActive?: boolean; settings: Settings; accountKey?: string; onClose: () => void; onSettings: (patch: Partial<Settings>) => void; onLibrary: () => void;onSeries?:(detail:SeriesDetail)=>void };
type SeasonState={source:string;phase:'idle'|'looking'|'identified'|'preparing'|'ready'|'none'|'ambiguous'|'error';destination:SeasonDestination|null;error:string};
const emptySeason=(source:string):SeasonState=>({source,phase:'idle',destination:null,error:''});
const time = (n: number) => Number.isFinite(n) && n >= 0 ? `${Math.floor(n / 60).toString().padStart(2, '0')}:${Math.floor(n % 60).toString().padStart(2, '0')}` : '00:00';
const rates = [.75, 1, 1.25, 1.5, 2, 2.5, 3];
const commentTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); };
const nextPaint = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 180); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
export default function Player({ detail:initialDetail, initialEpisode, initialPosition = 0, isActive = true, settings, accountKey = 'local', onClose, onSettings, onLibrary,onSeries }: Props) {
  const starting=useRef({detail:initialDetail,episode:initialEpisode,position:initialPosition}).current;
  const [detail,setDetail]=useState(starting.detail);
  const videos = useRef<(HTMLVideoElement | null)[]>([null, null]), playbackLayout = useRef<HTMLDivElement>(null);
  const switcher = useRef<SeamlessSwitcher<VideoDeck> | null>(null), fullscreenBusy = useRef(false), clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closed = useRef(false), visible = useRef(isActive), shouldPlay = useRef(true), automaticSwitch = useRef(false), lastSaved = useRef(0), mounted = useRef(false);
  const windowVisible=useRef(true),compatible=useRef(false),interruptedTarget=useRef<PlaybackTarget|null>(null);
  const latest = useRef({ detail, settings, onSettings, onLibrary, onClose, isActive,onSeries,accountKey }); latest.current = { detail, settings, onSettings, onLibrary, onClose, isActive,onSeries,accountKey };
  const mutedRef = useRef(false), requested = useRef<PlaybackTarget | null>(null),retryTarget=useRef<PlaybackTarget|null>(null);
  const episodeDurations=useRef(new Map<string,number>());
  const theaterScroll=useRef(0),theaterRef=useRef(false);
  const danmakuPanelRef = useRef(false);
  const pendingDanmaku = useRef<DanmakuPreferences | null>(null);
  const favoritePending=useRef(false);
  const completion=useRef(new PlaybackEnd());
  const continuation=useRef<SeasonContinuation|null>(null);if(!continuation.current)continuation.current=new SeasonContinuation(window.hongguo);
  const seasonGeneration=useRef(0),seasonTransition=useRef<{deck:VideoDeck;automatic:boolean}|null>(null);
  const seasonPick=useRef<{id:number;seriesId:string;resumeOriginal:boolean}|null>(null),seasonPickSequence=useRef(0);
  const [pickingSeason,setPickingSeason]=useState('');
  const metadata=useRef(new Map<string,SeriesDetail>([[starting.detail.series.id,starting.detail]])),deckAccounts=useRef(new WeakMap<VideoDeck,string>());
  const [seasonInfo,setSeasonInfo]=useState(()=>emptySeason(starting.detail.series.id)),[continuing,setContinuing]=useState(false);
  const seasonRef=useRef(seasonInfo);seasonRef.current=seasonInfo;
  const [favoriteBusy,setFavoriteBusy]=useState(false);
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
  const nextEpisode = () => requested.current?.seriesId===latest.current.detail.series.id?requested.current.episode:current()?.target.episode??episode;
  const rememberDetail=useCallback((value:SeriesDetail)=>{const map=metadata.current;map.delete(value.series.id);map.set(value.series.id,value);for(const sid of map.keys()){if(map.size<=3)break;if(sid!==current()?.target.seriesId&&sid!==value.series.id)map.delete(sid);}},[]);
  const updateSeason=useCallback((value:SeasonState)=>{seasonRef.current=value;setSeasonInfo(value);},[]);
  const resetSeason=useCallback((source:string)=>{seasonGeneration.current++;continuation.current?.reset();mediaPreload(window.hongguo).clear();seasonTransition.current=null;setContinuing(false);updateSeason(emptySeason(source));},[updateSeason]);
  const isLast=(deck:VideoDeck)=>{const data=metadata.current.get(deck.target.seriesId);return !!data&&deck.target.episode===Math.max(...data.episodes.map(item=>item.index));};
  const nearEnd=(deck:VideoDeck)=>{const rows=metadata.current.get(deck.target.seriesId)?.episodes||[];return rows.filter(item=>item.index>=deck.target.episode).length<=3;};
  const saveDeck = useCallback(async (deck: VideoDeck | null) => {
    const element = deck?.video; if (!deck || !element || !Number.isFinite(element.currentTime) || element.currentTime <= 0) return;
    const series=metadata.current.get(deck.target.seriesId)?.series;
    if(!series||deckAccounts.current.get(deck)!==latest.current.accountKey)return;
    try { await window.hongguo.saveProgress({ series, episode: deck.target.episode, position: element.currentTime, duration: knownDuration(deck.duration) }); latest.current.onLibrary(); }
    catch { if (mounted.current) setNotice('记录暂未保存，请检查可用磁盘空间'); }
  }, []);
  const save = useCallback(() => saveDeck(current()), [saveDeck]);
  const cancelSeasonPick=useCallback(()=>{if(!seasonPick.current)return;seasonPick.current=null;seasonPickSequence.current++;setPickingSeason('');switcher.current?.cancelPending();requested.current=null;setPendingEpisode(null);setPendingPosition(null);},[]);
  const hide = useCallback(() => { clearTimeout(hideTimer.current); setChrome(true); if (danmakuPanelRef.current) return; hideTimer.current = setTimeout(() => { if (current()?.video && !current()?.video.paused && !danmakuPanelRef.current) setChrome(false); }, 2500); }, []);
  const activeVideo = useCallback(() => switcher.current?.current?.video ?? null, []);
  const updateDanmaku = useCallback((patch: Partial<DanmakuPreferences>) => { const next = danmakuPreferences({ ...(pendingDanmaku.current ?? danmakuPreferences(latest.current.settings.danmaku)), ...patch }); pendingDanmaku.current = next; setDanmakuSettings(next); latest.current.onSettings({ danmaku: next }); hide(); }, [hide]);
  const closeDanmakuPanel = useCallback(() => { danmakuPanelRef.current = false; setDanmakuPanel(false); hide(); }, [hide]);
  const toggleDanmakuPanel = useCallback(() => { danmakuPanelRef.current = !danmakuPanelRef.current; setDanmakuPanel(danmakuPanelRef.current); hide(); }, [hide]);
  useEffect(()=>{const sid=detail.series.id,account=accountKey;let active=true;setFavorite(false);const apply=(lib:Awaited<ReturnType<typeof window.hongguo.getLibrary>>)=>{if(active&&latest.current.accountKey===account&&latest.current.detail.series.id===sid)setFavorite(lib.favorites.some(series=>series.id===sid));};const release=window.hongguo.onLibrary(apply);void window.hongguo.getLibrary().then(apply).catch(()=>{});return()=>{active=false;release();};},[detail.series.id,accountKey]);
  useEffect(()=>{
    if(!notice||favoriteBusy)return;
    const duration=notice==='已加入收藏'||notice==='已取消收藏'?3000:6000;
    const timer=setTimeout(()=>setNotice(current=>current===notice?'':current),duration);
    return()=>clearTimeout(timer);
  },[notice,favoriteBusy]);
  const changeFavorite=async()=>{
    if(favoritePending.current)return;
    favoritePending.current=true;setFavoriteBusy(true);setNotice('正在确认并同步收藏…');
    const desired=!favorite;
    const source=detail.series.id,account=accountKey;
    try{const lib=await window.hongguo.toggleFavorite(detail.series,desired);if(!mounted.current||latest.current.detail.series.id!==source||latest.current.accountKey!==account)return;setFavorite(lib.favorites.some(series=>series.id===source));onLibrary();setNotice(desired?'已加入收藏':'已取消收藏');}
    catch(error){if(mounted.current)setNotice((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}
    finally{favoritePending.current=false;if(mounted.current)setFavoriteBusy(false);}
  };
  const toggleTheater=useCallback(()=>{const scroll=playbackLayout.current?.closest('.content-scroll') as HTMLElement|null;const next=!theaterRef.current;if(next)theaterScroll.current=scroll?.scrollTop||0;theaterRef.current=next;setTheater(next);requestAnimationFrame(()=>{if(scroll)scroll.scrollTop=next?0:theaterScroll.current;});hide();},[hide]);
  const applySound = (deck: VideoDeck) => { const s = latest.current.settings; deck.video.playbackRate = s.rate; deck.video.volume = s.volume; deck.video.muted = mutedRef.current; };
  const targetFor=(data:SeriesDetail,index:number,start=0):PlaybackTarget=>({seriesId:data.series.id,episode:index,quality:latest.current.settings.quality,start,compatible:compatible.current,duration:episodeDurations.current.get(`${data.series.id}:${index}`)||knownDuration(data.episodes.find(item=>item.index===index)?.duration)});
  const target = (index: number, start = 0): PlaybackTarget => targetFor(latest.current.detail,index,start);
  const prepareSeason=useCallback((destination:SeasonDestination)=>{
    const data=destination.detail,source=destination.result.seriesId,deck=current();
    if(!data||!deck||deck.target.seriesId!==source||!visible.current||!latest.current.isActive||closed.current||!nearEnd(deck))return;
    const wanted=targetFor(data,destination.result.firstEpisode!);
    if(!isLast(deck)){mediaPreload(window.hongguo).prepare(wanted);return;}
    if(switcher.current?.prepared(wanted)){updateSeason({...seasonRef.current,phase:'ready',error:''});return;}
    const generation=seasonGeneration.current,account=latest.current.accountKey;
    updateSeason({...seasonRef.current,phase:'preparing',error:''});
    void switcher.current?.warm(wanted).then(prepared=>{
      if(!mounted.current||closed.current||generation!==seasonGeneration.current||account!==latest.current.accountKey||latest.current.detail.series.id!==source)return;
      if(prepared&&switcher.current?.prepared(wanted)){if(prepared.target.compatible)compatible.current=true;updateSeason({...seasonRef.current,phase:'ready',error:''});}
      else if(visible.current&&!requested.current&&current()&&isLast(current()!)&&wanted.quality===latest.current.settings.quality)updateSeason({...seasonRef.current,phase:'error',error:'下一季准备暂未完成，请重试'});
    });
  },[updateSeason]);
  const lookupSeason=useCallback(async(refresh=false):Promise<SeasonDestination|null>=>{
    const source=latest.current.detail.series.id,generation=seasonGeneration.current,account=latest.current.accountKey;
    if(!refresh&&seasonRef.current.source===source&&seasonRef.current.destination?.detail)return seasonRef.current.destination;
    updateSeason({source,phase:'looking',destination:null,error:''});
    try{const destination=await continuation.current!.resolve(source,refresh);
      if(!mounted.current||closed.current||generation!==seasonGeneration.current||account!==latest.current.accountKey||latest.current.detail.series.id!==source)return null;
      if(!destination.detail){updateSeason({source,phase:destination.result.status==='ambiguous'?'ambiguous':'none',destination:null,error:''});return null;}
      rememberDetail(destination.detail);updateSeason({source,phase:'identified',destination,error:''});prepareSeason(destination);return destination;
    }catch(failure){if(mounted.current&&!closed.current&&generation===seasonGeneration.current&&account===latest.current.accountKey&&latest.current.detail.series.id===source&&(failure as Error).name!=='AbortError')updateSeason({source,phase:'error',destination:null,error:(failure as Error).message||'下一季查询暂时失败，请重试'});return null;}
  },[updateSeason,rememberDetail,prepareSeason]);
  const scheduleNext = useCallback((deck: VideoDeck) => {
    if (!latest.current.isActive || !visible.current||deck.target.seriesId!==latest.current.detail.series.id) return;
    const next = latest.current.detail.episodes.find(item => item.index === deck.target.episode + 1);
    if (next) switcher.current?.warm(target(next.index));
    if(nearEnd(deck)){const destination=seasonRef.current.destination;if(destination?.detail)prepareSeason(destination);else if(seasonRef.current.phase==='idle')void lookupSeason();}
  }, [lookupSeason,prepareSeason]);
  const selectMedia=useCallback(async(data:SeriesDetail,index:number,automatic=false,start=0,keepPaused=false,force=false,allow:()=>boolean=()=>true)=>{

    if(!data.episodes.some(item=>item.index===index)||closed.current||!allow())return;
    const next=targetFor(data,index,start),displayed=current(),account=latest.current.accountKey;
    if(!force&&displayed?.target.seriesId===next.seriesId&&displayed.target.episode===index&&displayed.target.quality===next.quality&&Math.abs(displayed.target.start-start)<.1){hide();return;}
    rememberDetail(data);
    requested.current = next;retryTarget.current=null; automaticSwitch.current = automatic;
    setPendingPosition(displayed?.target.seriesId===next.seriesId&&displayed.target.episode===index&&Math.abs(start-displayed.video.currentTime)>.15?start:null);
    // Hidden windows pause the decoder without changing the user's play/pause choice.
    if(!automatic&&!keepPaused)shouldPlay.current=true;
    if (current()) { void saveDeck(current()); current()?.video.pause(); }
    setPendingEpisode(index); setError(''); if (!current()) setPhase('准备播放'); if (!automatic) hide();
    try {
      const valid=()=>!closed.current&&mounted.current&&requested.current===next&&latest.current.accountKey===account&&allow()&&(!automatic||visible.current&&latest.current.isActive&&latest.current.settings.autoplay&&shouldPlay.current&&current()===displayed);
      const committed = await switcher.current?.select(next, automatic, force,valid);

      if (!committed || closed.current){if(requested.current===next){requested.current=null;setPendingEpisode(null);setPendingPosition(null);}return;}
      requested.current = null; setPendingEpisode(null);setPendingPosition(null); scheduleNext(committed);
    } catch (failure) {
      if (closed.current || requested.current !== next) return;
      retryTarget.current=next;requested.current=null;setPendingEpisode(null);setPendingPosition(null); setPhase(''); setError((failure as Error).message || '视频准备失败，请重试'); setChrome(true);
    }
  }, [hide, saveDeck, scheduleNext,rememberDetail]);
  const selectEpisode=useCallback((index:number,automatic=false,start=0,keepPaused=false,force=false)=>{if(!automatic){cancelSeasonPick();seasonTransition.current=null;setContinuing(false);}return selectMedia(latest.current.detail,index,automatic,start,keepPaused,force);},[selectMedia,cancelSeasonPick]);
  const selectSeason=useCallback(async(series:Series)=>{
    const original=current();if(!original||closed.current||!visible.current||!latest.current.isActive)return;
    if(seasonPick.current?.seriesId===series.id)return;
    const resumeOriginal=seasonPick.current?.resumeOriginal??!original.video.paused;
    cancelSeasonPick();seasonTransition.current=null;setContinuing(false);
    if(series.id===original.target.seriesId){shouldPlay.current=resumeOriginal;if(resumeOriginal){applySound(original);void original.video.play().catch(()=>{});}hide();return;}
    switcher.current?.cancelPending();requested.current=null;setPendingEpisode(null);setPendingPosition(null);retryTarget.current=null;setError('');
    const intent={id:++seasonPickSequence.current,seriesId:series.id,resumeOriginal},account=latest.current.accountKey;
    seasonPick.current=intent;setPickingSeason(series.id);
    const valid=()=>mounted.current&&!closed.current&&visible.current&&latest.current.isActive&&seasonPick.current===intent&&account===latest.current.accountKey&&current()===original;
    try{
      const destination=metadata.current.get(series.id)??await window.hongguo.request<SeriesDetail>(`/catalog/series/${series.id}`,{timeout:60000});
      if(!valid())return;
      const first=Math.min(...destination.episodes.map(item=>item.index));
      if(destination.series.id!==series.id||!Number.isInteger(first)||first<1)throw new Error('这一季暂时没有可播放的剧集');
      await selectMedia(destination,first,false,0,false,false,valid);
    }catch(failure){if(valid())setNotice((failure as Error).message||'这一季暂时未能加载，请重试');}
    finally{if(seasonPick.current===intent){seasonPick.current=null;setPickingSeason('');}}
  },[cancelSeasonPick,selectMedia,hide]);
  const continueSeason=useCallback(async(automatic=false,original=current())=>{
    if(!original||!isLast(original)||closed.current||!visible.current||requested.current||seasonPick.current)return;
    const source=original.target.seriesId,generation=seasonGeneration.current,account=latest.current.accountKey;
    const baseValid=()=>mounted.current&&!closed.current&&visible.current&&latest.current.isActive&&generation===seasonGeneration.current&&account===latest.current.accountKey&&current()===original&&latest.current.detail.series.id===source&&(!automatic||latest.current.settings.autoplay&&shouldPlay.current);
    if(!baseValid())return;
    const transition={deck:original,automatic};seasonTransition.current=transition;setContinuing(true);if(!automatic)shouldPlay.current=true;
    const valid=()=>baseValid()&&seasonTransition.current===transition;
    void saveDeck(original);original.video.pause();setPlaying(false);setPhase('正在衔接下一季');
    try{const destination=await lookupSeason();if(!valid()||seasonTransition.current!==transition)return;
      if(destination?.detail)await selectMedia(destination.detail,destination.result.firstEpisode!,automatic,0,false,false,valid);
      else{shouldPlay.current=false;setPhase('本季播放完毕');setChrome(true);}
    }finally{if(seasonTransition.current===transition){seasonTransition.current=null;setContinuing(false);if(current()===original&&!requested.current){setPhase('本季播放完毕');setChrome(true);}}}
  },[lookupSeason,selectMedia,saveDeck]);
  const advance=useCallback(()=>{if(requested.current&&requested.current.seriesId!==latest.current.detail.series.id)return;const next=nextEpisode()+1;if(latest.current.detail.episodes.some(item=>item.index===next))void selectEpisode(next);else if(current()&&isLast(current()!))void continueSeason(false);},[selectEpisode,continueSeason]);
  const suspendPlayback=useCallback(()=>{
    const deck=current();
    if(!deck&&requested.current)interruptedTarget.current={...requested.current};
    cancelSeasonPick();seasonTransition.current=null;setContinuing(false);
    void saveDeck(deck);deck?.video.pause();deck?.hls?.stopLoad();
    switcher.current?.cancelPending();mediaPreload(window.hongguo).clear();
    requested.current=null;setPendingEpisode(null);setPendingPosition(null);automaticSwitch.current=false;
    clearTimeout(hideTimer.current);
  },[cancelSeasonPick,saveDeck]);
  const resumePlayback=useCallback(()=>{
    if(!visible.current||closed.current)return;
    const deck=current();
    if(deck){
      interruptedTarget.current=null;
      if(deck.target.quality!==latest.current.settings.quality){void selectEpisode(deck.target.episode,false,deck.video.currentTime,true);return;}
      applySound(deck);deck.hls?.startLoad(deck.video.currentTime);scheduleNext(deck);
      if(shouldPlay.current)void deck.video.play().catch(()=>{if(current()===deck){setPhase('点击开始播放');setChrome(true);}});
      else deck.video.pause();
    }else if(mounted.current&&!requested.current){
      const wanted=interruptedTarget.current;interruptedTarget.current=null;
      const data=wanted?metadata.current.get(wanted.seriesId):latest.current.detail;
      if(data)void selectMedia(data,wanted?.episode??initialEpisode,false,wanted?.start??initialPosition,true);
    }
  },[scheduleNext,selectEpisode,selectMedia,initialEpisode,initialPosition]);
  useEffect(() => {

    mounted.current = true; closed.current = false;
    const elements = videos.current.filter((element): element is HTMLVideoElement => !!element);
    const loader = new HlsDeckLoader(elements, window.hongguo, (deck, message) => {
      if(current()===deck&&deck.target.compatible&&!compatible.current){compatible.current=true;void selectEpisode(deck.target.episode,false,deck.video.currentTime,true,true);return;}
      if (current() === deck && mounted.current) { setError(message); setChrome(true); shouldPlay.current = false; }
    },(wanted,message)=>{if(mounted.current&&!current()&&requested.current?.episode===wanted.episode)setPhase(message);},
      deck=>current()===deck&&visible.current&&shouldPlay.current);
    const controller = new SeamlessSwitcher<VideoDeck>({
      prepare: async(index, wanted, signal) => {const account=latest.current.accountKey;const deck=await loader.prepare(index,wanted,signal);if(account!==latest.current.accountKey){await deck.release();throw new DOMException('Account changed','AbortError');}deckAccounts.current.set(deck,account);deck.video.dataset.seriesId=wanted.seriesId;deck.video.dataset.episode=String(wanted.episode);return deck;},
      present: (deck, previous, automatic) => {

        const destination=metadata.current.get(deck.target.seriesId);
        if(destination&&latest.current.detail.series.id!==deck.target.seriesId){resetSeason(deck.target.seriesId);latest.current={...latest.current,detail:destination};setDetail(destination);setDanmakuStatus({loading:false,loaded:0,error:''});latest.current.onSeries?.(destination);}
        completion.current.reset();
        if(deck.target.compatible)compatible.current=true;
        if(deck.hls){Object.assign(deck.hls.config,{maxBufferLength:18,maxMaxBufferLength:30,maxBufferSize:12*1024*1024,backBufferLength:8});if(visible.current)deck.hls.startLoad(deck.video.currentTime);}
        deck.video.dataset.active = 'true'; deck.video.dataset.seriesId=deck.target.seriesId;deck.video.dataset.episode=String(deck.target.episode);deck.video.style.zIndex = '1'; deck.video.style.visibility = 'visible';
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
    switcher.current = controller; void selectEpisode(starting.episode, false, starting.position);
    return () => { mounted.current = false; closed.current = true;seasonPick.current=null;continuation.current?.reset();seasonGeneration.current++;mediaPreload(window.hongguo).clear(); clearTimeout(clickTimer.current); clearTimeout(hideTimer.current); void saveDeck(controller.current); void controller.close(); };
  }, [starting, hide, selectEpisode, saveDeck,resetSeason]);
  const lastAccount=useRef(accountKey);
  useEffect(()=>{if(lastAccount.current===accountKey)return;lastAccount.current=accountKey;cancelSeasonPick();resetSeason(latest.current.detail.series.id);switcher.current?.cancelPending();requested.current=null;interruptedTarget.current=null;setPendingEpisode(null);setPendingPosition(null);shouldPlay.current=false;current()?.video.pause();completion.current.reset();},[accountKey,resetSeason,cancelSeasonPick]);
  useEffect(() => {
    const deck = current(); if (!deck) return;
    if(!isActive)return;
    if (deck.target.quality !== settings.quality) { switcher.current?.cancelPending(); void selectEpisode(deck.target.episode, false, deck.video.currentTime, true); }
    else applySound(deck);
  }, [settings.rate, settings.volume, settings.quality, muted, selectEpisode, isActive]);
  useEffect(()=>{if(!settings.autoplay&&seasonTransition.current?.automatic){shouldPlay.current=false;switcher.current?.cancelPending();requested.current=null;setPendingEpisode(null);setPendingPosition(null);setChrome(true);}},[settings.autoplay]);
  useEffect(() => {
    visible.current=isActive&&windowVisible.current;
    if(!isActive)suspendPlayback();else resumePlayback();
  },[isActive,suspendPlayback,resumePlayback]);
  const toggleFullscreen = useCallback(async () => {
    const layout = playbackLayout.current; if (!layout || fullscreenBusy.current) return; fullscreenBusy.current = true;
    try { if (document.fullscreenElement === layout) await document.exitFullscreen(); else await layout.requestFullscreen(); hide(); }
    catch { setNotice('无法进入全屏，请重试'); } finally { fullscreenBusy.current = false; }
  }, [hide]);
  useEffect(() => { const layout = playbackLayout.current; const changed = () => { setFullscreen(document.fullscreenElement === layout); hide(); }; document.addEventListener('fullscreenchange', changed); return () => { document.removeEventListener('fullscreenchange', changed); if (document.fullscreenElement === layout) void document.exitFullscreen().catch(() => {}); }; }, [hide]);
  const toggle = useCallback(() => {
    const pending=!!(seasonPick.current||requested.current||seasonTransition.current);
    const nextPlay=pending?!shouldPlay.current:!!current()?.video.paused;
    cancelSeasonPick();
    const deck = current(); if (!deck || error) return;
    shouldPlay.current = nextPlay; if (shouldPlay.current && visible.current) {deckAccounts.current.set(deck,latest.current.accountKey);completion.current.reset(); applySound(deck);if(!requested.current&&!seasonTransition.current)void deck.video.play().catch(() => {});scheduleNext(deck); } else deck.video.pause();setPlaying(shouldPlay.current&&!deck.video.paused); hide();
  }, [error, hide,scheduleNext,cancelSeasonPick]);
  useEffect(() => window.hongguo.onVisibility(value => {
    windowVisible.current=value;visible.current=value&&latest.current.isActive;
    if(!value)suspendPlayback();else resumePlayback();
  }),[suspendPlayback,resumePlayback]);
  useEffect(() => window.hongguo.onShutdown(save), [save]);
  const seekTo=useCallback((value:number)=>{const deck=current();if(!deck||!knownDuration(deck.duration))return;
    cancelSeasonPick();
    if(seasonTransition.current){seasonTransition.current=null;setContinuing(false);if(automaticSwitch.current){switcher.current?.cancelPending();requested.current=null;setPendingEpisode(null);setPendingPosition(null);}automaticSwitch.current=false;}
    completion.current.reset();
    const destination=Math.min(Math.max(0,value),Math.max(0,deck.duration-.05));
    if(availablePosition(destination,deck.video.seekable)){setPendingPosition(null);deck.video.currentTime=destination;setPosition(destination);}
    else void selectEpisode(deck.target.episode,false,destination,true,true);
    hide();
  },[hide,selectEpisode,cancelSeasonPick]);
  const seekBy = useCallback((amount: number) => { const deck=current();if(deck)seekTo(deck.video.currentTime+amount); }, [seekTo]);
  const close = useCallback(() => { if (closed.current) return; closed.current = true; shouldPlay.current = false;continuation.current?.reset();seasonGeneration.current++;mediaPreload(window.hongguo).clear();switcher.current?.cancelPending(); void save(); current()?.video.pause(); if (document.fullscreenElement === playbackLayout.current) void document.exitFullscreen().catch(() => {}).finally(() => latest.current.onClose()); else latest.current.onClose(); }, [save]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if(!latest.current.isActive)return;
      const field = event.target instanceof HTMLInputElement ? event.target : null;
      if (event.ctrlKey || event.altKey || event.metaKey || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || field && field.type !== 'range' || event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (field?.type === 'range' && /^(Arrow|Home|End|Page)/.test(event.key)) return;
      const k = event.key.toLowerCase(); if (![' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f', 'j', 'n', '[', ']', 'escape', 't', 'd'].includes(k) && !/^\d$/.test(k)) return; event.preventDefault();
      if (k === 'escape' && danmakuPanelRef.current) { closeDanmakuPanel(); return; }
      if (k === ' ' || k === 'k') toggle(); else if (k === 'arrowleft') seekBy(-5); else if (k === 'arrowright') seekBy(5); else if (k === 'arrowup' || k === 'arrowdown') latest.current.onSettings({ volume: Math.max(0, Math.min(1, latest.current.settings.volume + (k === 'arrowup' ? .05 : -.05))) });
      else if (k === 'm') setMuted(value => !value); else if (k === 'f') void toggleFullscreen(); else if (k === 't') toggleTheater(); else if (k === 'j' || k === 'n') advance();
      else if (k === 'd') updateDanmaku({ enabled: !(pendingDanmaku.current ?? danmakuPreferences(latest.current.settings.danmaku)).enabled });
      else if (k === 'escape') { if (document.fullscreenElement === playbackLayout.current) void document.exitFullscreen().catch(() => {}); else void window.hongguo.window('exitfullscreen').then(was => { if (!was) close(); }); }
      else if (k === '[' || k === ']') latest.current.onSettings({ rate: rates[Math.max(0, Math.min(rates.length - 1, rates.indexOf(latest.current.settings.rate) + (k === ']' ? 1 : -1)))] });
      else if (/^\d$/.test(k)) { const deck=current();if(deck)seekTo(deck.duration*Number(k)/10); } hide();
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [toggle, seekBy, seekTo, advance, hide, close, toggleFullscreen, toggleTheater, updateDanmaku, closeDanmakuPanel, episode]);
  const onTime = (index: number) => { const deck = current(); if (!deck || deck.index !== index) return; const element = deck.video;
    const full=episodeDurations.current.get(`${deck.target.seriesId}:${deck.target.episode}`)||knownDuration(deck.duration);if(full)episodeDurations.current.set(`${deck.target.seriesId}:${deck.target.episode}`,full);deck.duration=full;
    setPosition(element.currentTime); setDuration(full); if (element.buffered.length) setBuffered(element.buffered.end(element.buffered.length - 1)); if (Date.now() - lastSaved.current > 10000) { lastSaved.current = Date.now(); void saveDeck(deck); } };
  const finishEpisode=useCallback((deck:VideoDeck)=>{
    if(current()!==deck||requested.current||seasonPick.current||closed.current||!visible.current||!shouldPlay.current||deckAccounts.current.get(deck)!==latest.current.accountKey||!completion.current.claim(deck.sessionId))return;
    void saveDeck(deck);
    if(latest.current.settings.autoplay&&latest.current.detail.episodes.some(item=>item.index===deck.target.episode+1))void selectEpisode(deck.target.episode+1,true);
    else if(latest.current.settings.autoplay&&isLast(deck))void continueSeason(true,deck);
    else{shouldPlay.current=false;deck.video.pause();setPlaying(false);setChrome(true);setPhase('本集播放完毕');}
  },[selectEpisode,saveDeck,continueSeason]);
  useEffect(()=>{
    if(!isActive)return;
    const timer=setInterval(()=>{
      const deck=current();if(!deck)return;const element=deck.video;
      const end=Number.isFinite(element.duration)?element.duration:deck.duration;
      const ready=completion.current.inspect({id:deck.sessionId,time:element.currentTime,duration:end,
        bufferedEnd:element.buffered.length?element.buffered.end(element.buffered.length-1):0,sealed:deck.sealed,ended:element.ended,
        playing:shouldPlay.current&&!element.paused,seeking:element.seeking,enabled:visible.current&&!closed.current&&!requested.current&&!error,now:performance.now()});
      if(ready)finishEpisode(deck);
    },200);
    return()=>clearInterval(timer);
  },[isActive,finishEpisode,error]);
  const ended = (index: number) => { const deck=current();if(deck?.index===index)finishEpisode(deck); };
  const atSeasonEnd=nextEpisode()===Math.max(...detail.episodes.map(item=>item.index));
  const canAdvance=detail.episodes.some(item=>item.index===nextEpisode()+1)||atSeasonEnd&&!['none','ambiguous'].includes(seasonInfo.phase);
  const playIntent=playing||(continuing||!!pickingSeason)&&shouldPlay.current;
  const retrySeason=()=>{if(seasonRef.current.destination?.detail){setError('');retryTarget.current=null;prepareSeason(seasonRef.current.destination);}else void lookupSeason(true);};
  return <div className={`player-page ${theater?'player-theater':''}`}>
    <div className="player-heading"><button className="btn" onClick={close}><ArrowLeft size={17}/> 返回</button><div><h2>{detail.series.title}</h2><span>第 {episode} 集 · 共 {detail.episodes.length} 集</span>{pendingEpisode&&<small className="switch-status">{pendingPosition!==null?`正在定位到 ${time(pendingPosition)}`:`正在准备第 ${pendingEpisode} 集，保留当前画面`}</small>}</div><button className={`icon-button player-favorite ${favorite?'active':''}`} title={favoriteBusy?'正在同步收藏':favorite?'取消收藏':'收藏'} aria-label={favoriteBusy?'正在同步收藏':favorite?'取消收藏':'收藏'} aria-pressed={favorite} disabled={favoriteBusy} onClick={()=>void changeFavorite()}>{favoriteBusy?<LoaderCircle className="spin" size={20}/>:<Heart size={20} fill={favorite?'currentColor':'none'}/>}</button></div>
    <div className="playback-layout" ref={playbackLayout}><div className={`video-stage ${chrome?'':'controls-hidden'}`} onMouseMove={hide} onMouseLeave={()=>{if(playing&&!danmakuPanelRef.current)setChrome(false);}}>
      {!current()&&!error&&<div className="player-startup-cover" aria-hidden="true">{detail.series.cover&&<img src={detail.series.cover} alt=""/>}<div/></div>}
      <div className="fullscreen-toolbar"><div><strong>{detail.series.title}</strong><span>第 {episode} 集</span></div><button className="icon-button" title="退出全屏（Esc）" onClick={()=>void toggleFullscreen()}><Minimize size={20}/></button></div>
      {[0,1].map(index=><video key={index} ref={element=>{videos.current[index]=element;}} className="decoder-video" data-active={active===index?'true':'false'} data-series-id={active===index?detail.series.id:undefined} data-episode={active===index?episode:undefined} playsInline
        onClick={()=>{if(current()?.index!==index)return;clearTimeout(clickTimer.current);clickTimer.current=setTimeout(toggle,220);}} onDoubleClick={()=>{if(current()?.index!==index)return;clearTimeout(clickTimer.current);void toggleFullscreen();}}
        onTimeUpdate={()=>onTime(index)} onDurationChange={()=>onTime(index)} onProgress={()=>onTime(index)} onPlaying={()=>{if(current()?.index!==index)return;setPlaying(true);setPhase('');if(automaticSwitch.current){automaticSwitch.current=false;setChrome(false);}else hide();}}
      onPause={()=>{const deck=current();if(deck?.index!==index)return;setPlaying(false);const naturallyEnding=latest.current.settings.autoplay&&deck.video.ended;if(!naturallyEnding&&!automaticSwitch.current&&!requested.current){setChrome(true);void saveDeck(deck);}}} onWaiting={()=>{if(current()?.index===index&&!requested.current)setPhase('缓冲中');}} onEnded={()=>ended(index)}/>)}
      {episodeMeta && <Danmaku key={`${detail.series.id}:${episode}:${accountKey}`} seriesId={detail.series.id} episode={episode} vid={episodeMeta.vid} accountKey={accountKey} isActive={isActive} getVideo={activeVideo} initialTime={detail.series.id===starting.detail.series.id&&episode===starting.episode?starting.position:0} metadataDuration={duration || episodeMeta.duration || 0} preferences={danmakuSettings} refreshToken={danmakuRefresh} onStatus={setDanmakuStatus}/>}
      {notice&&<div className="player-notice player-feedback" role="status">{favoriteBusy&&<LoaderCircle className="spin" size={17}/>}<span>{notice}</span><button aria-label="关闭播放提示" onClick={()=>setNotice('')}><X size={15}/></button></div>}
      {phase&&!error&&!current()&&<div className="player-status"><div className={playing?'':'spinner'}/><span>{phase}</span>{phase==='点击开始播放'&&<button className="btn primary" onClick={toggle}><Play size={18}/>播放</button>}</div>}
      {error&&<div className={`player-error ${current()?"switch-error":""}`}><RotateCcw size={28}/><h3>暂时无法播放</h3><p>{error}</p><button className="btn primary" onClick={()=>{const wanted=retryTarget.current??requested.current??current()?.target??target(starting.episode,starting.position),data=metadata.current.get(wanted.seriesId);if(data)void selectMedia(data,wanted.episode,false,wanted.start,false,true);}}>重试当前集</button></div>}
      <div className="player-controls" onClick={e=>{const target=e.target as HTMLElement;if(target.closest('button'))target.closest('button')?.blur();hide();}}>
        {danmakuPanel && <DanmakuPanel preferences={danmakuSettings} status={danmakuStatus} onChange={updateDanmaku} onClose={closeDanmakuPanel} onRefresh={() => setDanmakuRefresh(value => value + 1)} onInteraction={hide}/>}
        <div className="timeline"><div className="buffer-bar" style={{width:`${duration?Math.min(100,buffered/duration*100):0}%`}}/><input aria-label="播放进度" type="range" min="0" max={duration||1} step=".1" disabled={!duration} title={duration?'拖动选择播放位置':'正在确认完整时长'} value={duration?Math.min(duration,pendingPosition??position):0} onChange={e=>seekTo(Number(e.target.value))} style={{background:`linear-gradient(to right,var(--brand) ${duration?Math.min(100,(pendingPosition??position)/duration*100):0}%,transparent 0)`}}/></div>
        <div className="controls-row">
          <button className="icon-button" title={playIntent?'暂停（空格）':'播放（空格）'} onClick={toggle}>{playIntent?<Pause size={23}/>:<Play size={23}/>}</button>
          <button className="icon-button" title={atSeasonEnd?'下一季（J）':'下一集（J）'} disabled={!canAdvance||continuing} onClick={advance}><SkipForward size={22}/></button>
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

    {seasonInfo.source===detail.series.id&&seasonInfo.phase!=='idle'&&<aside className="next-season-card" data-season-status={seasonInfo.phase} aria-live="polite"><div><small>{seasonInfo.destination?.detail?`第 ${seasonInfo.destination.result.nextSeason} 季 · 共 ${seasonInfo.destination.detail.series.totalEpisodes||seasonInfo.destination.detail.episodes.length} 集`:'下一季'}</small><strong>{seasonInfo.destination?.detail?.series.title||(seasonInfo.phase==='ambiguous'?'季关联暂不明确':seasonInfo.phase==='none'?'暂无已确认的下一季':'正在查找下一季')}</strong><span>{seasonInfo.error||(seasonInfo.phase==='ready'?'首集已准备好，季末自动衔接':seasonInfo.phase==='identified'?'已确认下一季，季末预热首集':seasonInfo.phase==='preparing'?'正在准备下一季首集':seasonInfo.phase==='looking'?'正在确认官方季关联':seasonInfo.phase==='ambiguous'?'存在多个候选，已暂停自动跨季':'本季结束后将停止播放')}</span></div>{['looking','preparing'].includes(seasonInfo.phase)&&<LoaderCircle className="spin" size={18}/>}<div className="next-season-actions">{seasonInfo.phase==='error'&&<button className="btn" onClick={retrySeason}>重试下一季</button>}{seasonInfo.destination?.detail&&atSeasonEnd&&<button className="btn primary" disabled={continuing} onClick={()=>void continueSeason(false)}>{continuing?'正在衔接':'播放下一季'}</button>}</div></aside>}
    <div className="episode-heading"><div><h3>选集</h3><span>{episodeMeta?.title||`第 ${episode} 集`}</span></div><div className="episode-actions"><label className="autoplay-switch"><input type="checkbox" checked={settings.autoplay} onChange={e=>onSettings({autoplay:e.target.checked})}/> 自动连播</label><button className="icon-button" aria-label="上一集" disabled={nextEpisode()<=1||continuing} onClick={()=>selectEpisode(nextEpisode()-1)}><ChevronLeft size={20}/></button><button className="icon-button" aria-label={atSeasonEnd?'下一季':'下一集'} disabled={!canAdvance||continuing} onClick={advance}><ChevronRight size={20}/></button></div></div>
    <EpisodeGrid episodes={detail.episodes} episode={episode} onSelect={selectEpisode}/>
    <SeasonOverview series={detail.series} action="play" pendingId={pickingSeason} disabled={!current()} onSelect={series=>void selectSeason(series)}/>
    <p className="player-description">{detail.series.intro}</p>
  </div>;
}
const EpisodeGrid=memo(function EpisodeGrid({episodes,episode,onSelect}:{episodes:Episode[];episode:number;onSelect:(episode:number)=>void|Promise<void>}){
  return <div className="episode-grid">{episodes.map(e=><button key={e.index} className={episode===e.index?'selected':''} aria-label={`播放第${e.index}集`} aria-current={episode===e.index?'true':undefined} onClick={()=>void onSelect(e.index)}>{e.index}{episode===e.index&&<span className="playing-bars">▥</span>}</button>)}</div>;
});
function Comments({seriesId,episode,onClose}:{seriesId:string;episode:number;onClose:()=>void}){
  const [page,setPage]=useState<CommentsPage>({items:[],total:0,cursor:0,hasMore:false}),[busy,setBusy]=useState(true),[error,setError]=useState('');const generation=useRef(0);
  const load=useCallback(async(cursor=0)=>{const gen=generation.current;setBusy(true);setError('');try{const d=await window.hongguo.request<CommentsPage>(`/catalog/comments?seriesId=${seriesId}&episode=${episode}&cursor=${cursor}`);if(generation.current!==gen)return;setPage(p=>({...d,items:cursor?[...p.items,...d.items.filter(i=>!p.items.some(x=>x.id===i.id))]:d.items}));}catch(e){if(generation.current===gen)setError((e as Error).message);}finally{if(generation.current===gen)setBusy(false);}},[seriesId,episode]);
  useEffect(()=>{generation.current++;setPage({items:[],total:0,cursor:0,hasMore:false});void load();return()=>{generation.current++;};},[load]);
  return <aside className="comments-panel"><div className="comments-header"><h3>第 {episode} 集评论 <span>{page.total}</span></h3><button className="icon-button" aria-label="关闭评论" onClick={onClose}><X size={18}/></button></div><div className="comments-list">{page.items.map(c=><article className="comment" key={c.id}>{c.avatar?<img src={c.avatar} alt="" loading="lazy"/>:<div className="comment-avatar">{c.nickname.slice(0,1)||'观'}</div>}<div><strong>{c.nickname}</strong><p>{c.text}</p><small>{commentTime(c.time)} · {c.likes} 赞</small></div></article>)}{!busy&&!error&&!page.items.length&&<div className="empty-state"><MessageSquare size={30}/><p>这集还没有评论</p></div>}{error&&<div className="comment-error"><p>{error}</p><button className="btn" onClick={()=>void load(page.cursor)}>重试</button></div>}{busy&&<div className="loading-state"><span className="spinner"/>加载评论</div>}{!busy&&page.hasMore&&<button className="btn" onClick={()=>void load(page.cursor)}>加载更多</button>}</div></aside>;
}
