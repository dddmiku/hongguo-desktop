import { useEffect, useRef } from 'react';
import type { DanmakuPreferences } from '../../shared/danmaku-settings';
import { DanmakuEngine } from '../danmaku/engine';
import { DanmakuFeed, type DanmakuStatus } from '../danmaku/feed';
import { EmojiPainter } from '../danmaku/emoji-painter';

interface Props { seriesId: string; episode: number; vid: string; accountKey: string; getVideo: () => HTMLVideoElement | null; initialTime: number; metadataDuration: number; preferences: DanmakuPreferences; refreshToken: number; onStatus: (value: DanmakuStatus) => void; }
export default function Danmaku(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), latest = useRef(props); latest.current = props;
  const feed = useRef<DanmakuFeed | null>(null);
  useEffect(() => {
    const surface = canvas.current, context = surface?.getContext('2d'); if (!surface || !context) return;
    surface.setAttribute('aria-label', '手机弹幕'); surface.dataset.activeCount = '0';
    const family = '"Microsoft YaHei", "PingFang SC", sans-serif';
    const emoji = new EmojiPainter();
    const engine = new DanmakuEngine((text, size) => { context.font = `600 ${size}px ${family}`; return emoji.measure(context, text, size); });
    const source = new DanmakuFeed({ seriesId: props.seriesId, episode: props.episode, vid: props.vid },
      (route, options) => window.hongguo.request(route, options), page => engine.merge(page.items), value => latest.current.onStatus(value));
    feed.current = source;
    if (props.preferences.enabled) source.preload(props.getVideo()?.currentTime ?? props.initialTime, props.metadataDuration, props.getVideo()?.playbackRate || 1);
    let frame = 0, width = 0, height = 0, ratio = 1, lastCheck = -Infinity, lastFrame = -Infinity, label = '', lastDraw = '', enabled = props.preferences.enabled;
    const resize = () => { const bounds = surface.getBoundingClientRect(); width = bounds.width; height = bounds.height; ratio = Math.min(2, devicePixelRatio || 1); surface.width = Math.round(width * ratio); surface.height = Math.round(height * ratio); lastDraw = ''; };
    const observer = new ResizeObserver(resize); observer.observe(surface); resize();
    const draw = (now: number) => {
      if (now - lastFrame < 16) { frame = requestAnimationFrame(draw); return; } lastFrame = now;
      const current = latest.current, video = current.getVideo(), prefs = current.preferences;
      if (video && width > 0 && height > 0) {
        if (enabled !== prefs.enabled) { engine.seek(video.currentTime); enabled = prefs.enabled; }
        if (prefs.enabled && now - lastCheck > 750) {
          const duration = current.metadataDuration || 0;
          source.preload(video.currentTime, duration, video.playbackRate);
          lastCheck = now;
        }
        const shown = engine.step({ time: video.currentTime, now, running: !video.paused && !video.ended && video.readyState >= 3 && !document.hidden,
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
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); source.close(); engine.clear(); if (feed.current === source) feed.current = null; context.clearRect(0, 0, surface.width, surface.height); surface.setAttribute('aria-label', '手机弹幕'); surface.dataset.activeCount = '0'; };
  }, [props.seriesId, props.episode, props.vid, props.accountKey]);
  useEffect(() => { const video = props.getVideo(); if (props.refreshToken && video && props.preferences.enabled) feed.current?.refresh(video.currentTime, props.metadataDuration); }, [props.refreshToken]);
  return <canvas className="danmaku-canvas" ref={canvas} role="img" aria-label="手机弹幕" data-active-count="0" />;
}
