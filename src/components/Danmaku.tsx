import { memo, useEffect, useRef } from 'react';
import type { DanmakuPreferences } from '../../shared/danmaku-settings';
import { DanmakuEngine } from '../danmaku/engine';
import { DanmakuFeed, type DanmakuStatus } from '../danmaku/feed';
import { EmojiPainter } from '../danmaku/emoji-painter';

interface Props { seriesId: string; episode: number; vid: string; accountKey: string; isActive: boolean; getVideo: () => HTMLVideoElement | null; initialTime: number; metadataDuration: number; preferences: DanmakuPreferences; refreshToken: number; onStatus: (value: DanmakuStatus) => void; }
function Danmaku(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), latest = useRef(props); latest.current = props;
  const feed = useRef<DanmakuFeed | null>(null);
  const schedule = useRef<(() => void) | null>(null);
  useEffect(() => {
    const surface = canvas.current, context = surface?.getContext('2d'); if (!surface || !context) return;
    surface.setAttribute('aria-label', '手机弹幕'); surface.dataset.activeCount = '0';
    const family = '"Microsoft YaHei", "PingFang SC", sans-serif';
    const emoji = new EmojiPainter();
    const engine = new DanmakuEngine((text, size) => { context.font = `600 ${size}px ${family}`; return emoji.measure(context, text, size); });
    const source = new DanmakuFeed({ seriesId: props.seriesId, episode: props.episode, vid: props.vid },
      (route, options) => window.hongguo.request(route, options), page => { engine.merge(page.items); schedule.current?.(); }, value => latest.current.onStatus(value));
    feed.current = source;
    if (props.preferences.enabled && props.isActive) source.preload(props.getVideo()?.currentTime ?? props.initialTime, props.metadataDuration, props.getVideo()?.playbackRate || 1);
    let frame = 0, width = 0, height = 0, ratio = 1, lastCheck = -Infinity, lastFrame = -Infinity, label = '', lastDraw = '', enabled = props.preferences.enabled;
    let disposed=false, boundVideo: HTMLVideoElement | null=null, waiting:ReturnType<typeof setTimeout>|undefined;
    const events=['play','playing','pause','seeking','seeked','timeupdate','ratechange','loadeddata','canplay','progress','waiting'];
    const wake=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(draw);};
    schedule.current=wake;
    const resize = () => { const bounds = surface.getBoundingClientRect(); width = bounds.width; height = bounds.height; ratio = Math.min(2, devicePixelRatio || 1); surface.width = Math.round(width * ratio); surface.height = Math.round(height * ratio); lastDraw = '';wake(); };
    const draw = (now: number) => {
      frame=0;
      if (now - lastFrame < 16) { frame = requestAnimationFrame(draw); return; } lastFrame = now;
      const current = latest.current, video = current.getVideo(), prefs = current.preferences;
      if(video!==boundVideo){for(const name of events)boundVideo?.removeEventListener(name,wake);boundVideo=video;for(const name of events)boundVideo?.addEventListener(name,wake);}
      if (video && width > 0 && height > 0) {
        if (enabled !== prefs.enabled) { engine.seek(video.currentTime); enabled = prefs.enabled; }
        if (prefs.enabled && current.isActive && !document.hidden && now - lastCheck > 750) {
          const duration = current.metadataDuration || 0;
          source.preload(video.currentTime, duration, video.playbackRate);
          lastCheck = now;
        }
        const shown = engine.step({ time: video.currentTime, now, running: !video.paused && !video.ended && video.readyState >= 3 && !document.hidden && current.isActive,
          seeking: video.seeking, rate: video.playbackRate, width, height, preferences: prefs });
        const drawing = `${prefs.opacity}:${emoji.revision}:` + shown.map(item => `${item.id}:${item.text}:${item.x}:${item.y}:${item.fontSize}`).join('|');
        if (drawing !== lastDraw) {
          context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
          context.globalAlpha = prefs.opacity; context.fillStyle = '#fff'; context.strokeStyle = '#000d'; context.lineWidth = 2.5; context.lineJoin = 'round';
          let pictures = 0;
          for (const item of shown) { context.font = `600 ${item.fontSize}px ${family}`; pictures += emoji.paint(context, item.text, item.x, item.y, item.fontSize); }
          surface.dataset.emojiCount = String(pictures);
          lastDraw = drawing;
        }
        const nextLabel = shown.map(item => item.text).join('；');
        if (label !== nextLabel) { surface.setAttribute('aria-label', nextLabel ? '手机弹幕：' + nextLabel : '手机弹幕'); surface.dataset.activeCount = String(shown.length); label = nextLabel; }
      }
      if(current.isActive&&prefs.enabled&&!document.hidden){if(video&&!video.paused&&!video.ended){if(video.readyState>=3)wake();else{clearTimeout(waiting);waiting=setTimeout(wake,100);}}else if(!video){clearTimeout(waiting);waiting=setTimeout(wake,250);}}
    };
    const observer = new ResizeObserver(resize); observer.observe(surface); resize();
    document.addEventListener('visibilitychange',wake);wake();
    return () => { disposed=true;cancelAnimationFrame(frame);clearTimeout(waiting);for(const name of events)boundVideo?.removeEventListener(name,wake);document.removeEventListener('visibilitychange',wake);if(schedule.current===wake)schedule.current=null; observer.disconnect(); source.close(); engine.clear(); if (feed.current === source) feed.current = null; context.clearRect(0, 0, surface.width, surface.height); surface.setAttribute('aria-label', '手机弹幕'); surface.dataset.activeCount = '0'; };
  }, [props.seriesId, props.episode, props.vid, props.accountKey]);
  useEffect(() => { const video = props.getVideo(); if (props.refreshToken && video && props.preferences.enabled) feed.current?.refresh(video.currentTime, props.metadataDuration); }, [props.refreshToken]);
  useEffect(()=>{schedule.current?.();});
  return <canvas className="danmaku-canvas" ref={canvas} role="img" aria-label="手机弹幕" data-active-count="0" />;
}
export default memo(Danmaku);
