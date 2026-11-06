"""独立的本机媒体任务、HLS 分发和有界缓存。"""
from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

from fastapi import Body, HTTPException, Query, Request
from fastapi.responses import Response

_FILE = re.compile(r"(?:index\.m3u8|init\.mp4|seg[0-9]{6}\.m4s)")
_KEY = re.compile(r"[0-9a-f]{64}(?:\.part)?")
_OWNER = "hongguo-media-v1"
_QUALITIES = {"auto", "1080p", "720p", "540p", "480p", "360p"}


class MediaBusy(RuntimeError):
    pass


class MediaCancelled(RuntimeError):
    pass


@dataclass
class _Job:
    key: str
    series_id: str
    episode: int
    quality: str
    directory: Path
    duration: float = 0.0
    phase: str = "preparing"
    error: str = ""
    cached: bool = False
    accessed: float = field(default_factory=time.time)
    refs: set = field(default_factory=set)
    stop: threading.Event = field(default_factory=threading.Event)
    ready: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    process: object = None
    future: object = None


@dataclass
class _Session:
    id: str
    job: _Job
    cancelled: bool = False
    accessed: float = field(default_factory=time.time)


class MediaManager:
    """一个源只处理一次；会话是引用，取消一个会话不会打断其它引用。"""

    def __init__(self, provider, data_dir, ffmpeg_path, token, *,
                 max_workers=4, max_pending=16, cache_bytes=4 * 1024**3):
        self.provider = provider
        self.root = Path(data_dir).resolve() / "media-cache"
        self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise ValueError("媒体缓存目录不能是符号链接")
        self.ffmpeg_path = str(Path(ffmpeg_path).resolve())
        self.token = str(token)
        if not self.token:
            raise ValueError("媒体访问凭据不能为空")
        self.guard = threading.RLock()
        self.jobs = {}
        self.sessions = {}
        self.closed = False
        self.pending = 0
        self.max_pending = max(1, int(max_pending))
        self.limit = max(1, int(cache_bytes))
        try:
            settings = json.loads((self.root / "settings.json").read_text(encoding="utf-8"))
            limit = int(settings.get("limit", self.limit)) if isinstance(settings, dict) else self.limit
            if 0 < limit <= 64 * 1024**3:
                self.limit = limit
        except (OSError, ValueError, TypeError):
            pass
        self.pool = ThreadPoolExecutor(max_workers=max(1, min(4, int(max_workers))),
                                       thread_name_prefix="hongguo-media")
        self._load_cache()

    def _owned(self, path):
        return (path.parent == self.root and bool(_KEY.fullmatch(path.name))
                and not path.is_symlink() and path.is_dir())

    def _remove(self, path):
        # 只触及新客户端的专用缓存、固定哈希目录；不扫描用户视频目录。
        if self._owned(path):
            shutil.rmtree(path)

    def _load_cache(self):
        for path in self.root.iterdir():
            if not self._owned(path):
                continue
            if path.name.endswith(".part"):
                self._remove(path)
                continue
            try:
                metadata = json.loads((path / "complete.json").read_text(encoding="utf-8"))
                if not isinstance(metadata, dict) or metadata.get("owner") != _OWNER:
                    continue
                if not all((path / name).is_file() for name in
                           ("index.m3u8", "init.mp4", "seg000000.m4s")):
                    self._remove(path)
                    continue
                job = _Job(path.name, metadata["seriesId"], int(metadata["episode"]),
                           metadata["quality"], path, phase="complete", cached=True,
                           accessed=(path / "complete.json").stat().st_mtime)
                job.duration = float(metadata.get("duration") or 0)
                if not job.duration:
                    text = (path / "index.m3u8").read_text(encoding="utf-8")
                    if "#EXT-X-ENDLIST" in text:
                        job.duration = sum(float(value) for value in re.findall(r"^#EXTINF:([0-9.]+),", text, re.MULTILINE))
                job.ready.set()
                job.done.set()
                self.jobs[job.key] = job
            except (OSError, ValueError, TypeError, KeyError):
                continue
        self._prune()

    @staticmethod
    def _identity(series_id, episode, quality, start):
        sid = str(series_id)
        if not re.fullmatch(r"[0-9]{8,24}", sid):
            raise ValueError("剧集标识不合法")
        if isinstance(episode, bool) or int(episode) != float(episode) or not 1 <= int(episode) <= 100000:
            raise ValueError("集号不合法")
        quality = str(quality or "auto").lower()
        if quality not in _QUALITIES:
            raise ValueError("清晰度不合法")
        if not math.isfinite(float(start)) or float(start) < 0:
            raise ValueError("播放位置不合法")
        return sid, int(episode), quality

    def create(self, series_id, episode, quality="auto", start=0,
               prefetch=False, base_url=""):
        sid, episode, quality = self._identity(series_id, episode, quality, start)
        # 从零处理整集，拖动/回看由 HLS 客户端完成，起播位置不拆出第二份缓存。
        key = hashlib.sha256(f"{_OWNER}:{sid}:{episode}:{quality}".encode()).hexdigest()
        with self.guard:
            if self.closed:
                raise MediaBusy("媒体服务已关闭")
            self._expire_sessions()
            if len(self.sessions) >= 256:
                raise MediaBusy("打开的播放会话过多")
            job = self.jobs.get(key)
            if job is not None and job.phase in ("error", "cancelled"):
                if not job.done.is_set():
                    raise MediaBusy("上一任务正在结束，请稍后重试")
                job = None
            if job is None:
                if self.pending >= self.max_pending:
                    raise MediaBusy("媒体队列已满，请稍后重试")
                job = _Job(key, sid, episode, quality, self.root / (key + ".part"))
                self.jobs[key] = job
                self.pending += 1
                job.future = self.pool.submit(self._run, job)
                job.future.add_done_callback(lambda future, task=job: self._finished(task, future))
            else:
                job.cached = True
            identifier = uuid.uuid4().hex
            session = _Session(identifier, job)
            self.sessions[identifier] = session
            job.refs.add(identifier)
            job.accessed = time.time()
            return self._view(session, base_url)

    def _expire_sessions(self):
        now = time.time()
        for identifier, session in list(self.sessions.items()):
            # 客户端异常退出而未 DELETE 的引用也能回收；播放/清单/轮询都会续租。
            if now - session.accessed > 900:
                self._release(session)
                self.sessions.pop(identifier, None)
            elif session.cancelled and now - session.accessed > 60:
                self.sessions.pop(identifier, None)

    def _view(self, session, base_url=""):
        job = session.job
        out = {"id": session.id,
               "url": (base_url.rstrip("/") + f"/media/session/{session.id}/index.m3u8"
                       + "?token=" + quote(self.token, safe="")),
               "phase": "cancelled" if session.cancelled else job.phase,
               "cached": job.cached, "quality": job.quality}
        if job.error and not session.cancelled:
            out["error"] = job.error
        if job.duration > 0:
            out["duration"] = job.duration
        return out

    def get(self, identifier, base_url=""):
        with self.guard:
            session = self.sessions.get(identifier)
            if session is None:
                raise KeyError(identifier)
            session.accessed = session.job.accessed = time.time()
            return self._view(session, base_url)

    def _release(self, session):
        if session.cancelled:
            return
        session.cancelled = True
        session.accessed = time.time()
        job = session.job
        job.refs.discard(session.id)
        if not job.refs and job.done.is_set() and job.phase in ("error", "cancelled"):
            if self.jobs.get(job.key) is job:
                self.jobs.pop(job.key)
        if not job.refs and job.phase not in ("complete", "error", "cancelled"):
            job.stop.set()
            job.phase = "cancelled"
            job.ready.set()
            if job.future is not None:
                job.future.cancel()
            if job.process is not None:
                self._terminate(job.process)

    def cancel(self, identifier):
        with self.guard:
            session = self.sessions.get(identifier)
            if session is None:
                raise KeyError(identifier)
            self._release(session)
            self._prune()
            return self._view(session)

    @staticmethod
    def _terminate(process):
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            except OSError:
                pass

    def _command(self, source, directory):
        return [self.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-i", source.as_posix(), "-map", "0:v:0", "-map", "0:a?",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-threads", "2",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-force_key_frames", "expr:gte(t,n_forced*2)", "-sc_threshold", "0",
                "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "event",
                "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
                "-hls_segment_filename", (directory / "seg%06d.m4s").as_posix(),
                "-hls_flags", "independent_segments+temp_file", (directory / "index.m3u8").as_posix()]

    def _run(self, job):
        source = None
        try:
            if job.stop.is_set():
                raise MediaCancelled()
            source = Path(self.provider.source(job.series_id, job.episode, job.quality,
                                                cancelled=job.stop.is_set))
            if job.stop.is_set():
                raise MediaCancelled()
            if not source.is_file():
                raise FileNotFoundError("视频源不存在")
            # 整集源已落盘，读容器头即可知道真实总时长；不等待HLS完整编码。
            job.duration = self._source_duration(source, job)
            job.directory.mkdir(exist_ok=False)
            (job.directory / "owner").write_text(_OWNER, encoding="ascii")
            with (job.directory / "encode.log").open("wb") as errors:
                process = subprocess.Popen(self._command(source, job.directory),
                                           cwd=job.directory,
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=errors,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                with self.guard:
                    job.process = process
                while process.poll() is None:
                    if job.stop.wait(0.05):
                        self._terminate(process)
                        raise MediaCancelled()
                    self._mark_ready(job)
                if job.stop.is_set():
                    raise MediaCancelled()
                if process.returncode != 0:
                    raise RuntimeError("视频转码失败")
            manifest = job.directory / "index.m3u8"
            text = manifest.read_text(encoding="utf-8")
            if "#EXT-X-ENDLIST" not in text or not self._mark_ready(job):
                raise RuntimeError("没有生成完整的视频片段")
            manifest.write_text(text.replace("#EXT-X-PLAYLIST-TYPE:EVENT",
                                             "#EXT-X-PLAYLIST-TYPE:VOD"), encoding="utf-8")
            if not job.duration:
                job.duration = sum(float(value) for value in re.findall(r"^#EXTINF:([0-9.]+),", text, re.MULTILINE))
            metadata = {"owner": _OWNER, "seriesId": job.series_id,
                        "episode": job.episode, "quality": job.quality, "duration": job.duration}
            (job.directory / "complete.json").write_text(json.dumps(metadata), encoding="utf-8")
            self._promote(job)
        except Exception as error:
            with self.guard:
                job.phase = "cancelled" if job.stop.is_set() or isinstance(error, MediaCancelled) else "error"
                # 不把 CDN 凭据、绝对路径或供应商响应内容返回给界面。
                if job.phase == "error":
                    job.error = f"视频准备失败（{type(error).__name__}），请重试"
            if job.process is not None:
                self._terminate(job.process)
            if job.directory.name.endswith(".part"):
                self._remove(job.directory)
        finally:
            if job.process is not None:
                self._terminate(job.process)
            if source is not None:
                release = getattr(self.provider, "release_source", None)
                if callable(release):
                    try:
                        release(source)
                    except Exception:
                        pass
            job.ready.set()

    def _source_duration(self, source, job):
        try:
            import av
            with av.open(str(source)) as container:
                values = [float(container.duration or 0) / av.time_base]
                values.extend(float(stream.duration * stream.time_base) for stream in container.streams
                              if stream.duration and stream.time_base)
                duration = max(values, default=0)
                if math.isfinite(duration) and 0 < duration <= 86400:
                    return duration
        except Exception:
            pass
        # 部分容器没有duration；SDK剧集元数据是独立的可信来源。
        detail = getattr(self.provider, "detail", None)
        if callable(detail):
            try:
                episode = next(item for item in detail(job.series_id)["episodes"] if item["index"] == job.episode)
                duration = float(episode.get("duration") or 0)
                if math.isfinite(duration) and 0 < duration <= 86400:
                    return duration
            except Exception:
                pass
        return 0.0  # 未知时不拿当前片段长度冒充整集时长。

    def _promote(self, job):
        """Windows 扫描/读句柄短暂未分享DELETE时，保留完整产物等待其释放。"""
        destination = self.root / job.key
        deadline = time.monotonic() + 1.0
        while True:
            with self.guard:
                if job.stop.is_set():
                    raise MediaCancelled()
                try:
                    job.directory.rename(destination)
                except PermissionError as error:
                    # 仅重试 Windows 共享/锁冲突，DACL拒绝(5)等权限错误仍立即失败。
                    if getattr(error, "winerror", None) not in (32, 33) or time.monotonic() >= deadline:
                        raise
                else:
                    job.directory = destination
                    job.phase = "complete"
                    job.accessed = time.time()
                    return
            # 等待期间不占管理锁，manifest可继续读取，取消可以立即生效。
            if job.stop.wait(min(0.05, max(0, deadline - time.monotonic()))):
                raise MediaCancelled()

    def _mark_ready(self, job):
        with self.guard:
            exists = all((job.directory / name).is_file() for name in
                         ("index.m3u8", "init.mp4", "seg000000.m4s"))
            if exists and not job.stop.is_set():
                if job.phase == "preparing":
                    job.phase = "ready"
                job.ready.set()
            return exists

    def _finished(self, job, future):
        with self.guard:
            self.pending -= 1
            if future.cancelled():
                job.phase = "cancelled"
                job.ready.set()
            job.done.set()
            if job.phase in ("error", "cancelled") and not job.refs and self.jobs.get(job.key) is job:
                self.jobs.pop(job.key)
            self._prune()

    @staticmethod
    def _size(directory):
        try:
            return sum(path.stat().st_size for path in directory.iterdir()
                       if path.is_file() and not path.is_symlink())
        except OSError:
            return 0

    def _prune(self, clear=False):
        with self.guard:
            self._expire_sessions()
            jobs = [job for job in self.jobs.values() if job.phase == "complete"]
            total = sum(self._size(job.directory) for job in jobs)
            for job in sorted(jobs, key=lambda item: item.accessed):
                if not clear and total <= self.limit:
                    break
                if job.refs:
                    continue
                size = self._size(job.directory)
                self._remove(job.directory)
                if self.jobs.get(job.key) is job:
                    self.jobs.pop(job.key)
                total -= size

    def cache_status(self):
        with self.guard:
            self._prune()
            jobs = [job for job in self.jobs.values()
                    if job.phase in ("preparing", "ready", "complete")]
            return {"bytes": sum(self._size(job.directory) for job in jobs),
                    "limit": self.limit,
                    "entries": sum(job.phase == "complete" for job in jobs),
                    "active": sum(bool(job.refs) for job in jobs)}

    def clear_cache(self):
        self._prune(clear=True)
        return self.cache_status()

    def set_cache_gb(self, cache_gb):
        value = float(cache_gb)
        if not math.isfinite(value) or not 0.25 <= value <= 64:
            raise ValueError("缓存容量应为 0.25–64 GB")
        with self.guard:
            self.limit = int(value * 1024**3)
            target = self.root / "settings.json"
            pending = self.root / "settings.json.part"
            pending.write_text(json.dumps({"limit": self.limit}), encoding="utf-8")
            pending.replace(target)
            return self.cache_status()

    def read_file(self, identifier, filename, wait_seconds=15):
        if not _FILE.fullmatch(filename):
            raise HTTPException(404, "媒体文件不存在")
        deadline = time.monotonic() + wait_seconds
        while True:
            with self.guard:
                session = self.sessions.get(identifier)
                if session is None or session.cancelled:
                    raise HTTPException(404, "播放会话已结束")
                job = session.job
                session.accessed = job.accessed = time.time()
                if job.phase in ("error", "cancelled"):
                    raise HTTPException(410, job.error or "播放任务已取消")
                path = job.directory / filename
                if not path.is_symlink() and path.is_file():
                    data = path.read_bytes()
                    if filename == "index.m3u8":
                        return self._manifest(data.decode("utf-8")).encode("utf-8")
                    return data
                if job.phase == "complete":
                    raise HTTPException(404, "媒体片段不存在")
            if time.monotonic() >= deadline:
                raise HTTPException(503, "视频仍在准备", headers={"Retry-After": "1"})
            job.ready.wait(min(0.1, max(0, deadline - time.monotonic())))
            if job.ready.is_set():
                time.sleep(0.05)

    def _manifest(self, text):
        suffix = "?token=" + quote(self.token, safe="")

        def uri(match):
            name = match.group(1)
            if not _FILE.fullmatch(name) or name == "index.m3u8":
                raise HTTPException(500, "媒体索引格式不正确")
            return 'URI="' + name + suffix + '"'

        lines = []
        for line in text.splitlines():
            if line and not line.startswith("#"):
                if not _FILE.fullmatch(line) or line == "index.m3u8":
                    raise HTTPException(500, "媒体索引格式不正确")
                line += suffix
            else:
                line = re.sub(r'URI="([^"]+)"', uri, line)
            lines.append(line)
        return "\n".join(lines) + "\n"

    def close(self):
        with self.guard:
            if self.closed:
                return
            self.closed = True
            for session in list(self.sessions.values()):
                self._release(session)
        self.pool.shutdown(wait=True, cancel_futures=True)
        self._prune()


def mount_media(app, manager):
    @app.post("/media/session")
    def create_session(request: Request, body: dict = Body(...)):
        try:
            return manager.create(body.get("seriesId"), body.get("episode"),
                                  body.get("quality", "auto"), body.get("start", 0),
                                  bool(body.get("prefetch", False)), str(request.base_url))
        except (ValueError, TypeError, OverflowError) as error:
            raise HTTPException(400, str(error)) from None
        except MediaBusy as error:
            raise HTTPException(429, str(error), headers={"Retry-After": "1"}) from None

    @app.get("/media/session/{identifier}")
    def get_session(identifier: str, request: Request):
        try:
            return manager.get(identifier, str(request.base_url))
        except KeyError:
            raise HTTPException(404, "播放会话不存在") from None

    @app.delete("/media/session/{identifier}")
    def cancel_session(identifier: str):
        try:
            return manager.cancel(identifier)
        except KeyError:
            raise HTTPException(404, "播放会话不存在") from None

    @app.get("/media/session/{identifier}/{filename:path}")
    def media_file(identifier: str, filename: str, token: str = Query("")):
        if not secrets.compare_digest(str(token), manager.token):
            raise HTTPException(401, "媒体访问凭据不正确")
        data = manager.read_file(identifier, filename)
        mime = "application/vnd.apple.mpegurl" if filename.endswith(".m3u8") else "video/mp4"
        return Response(data, media_type=mime, headers={"Cache-Control": "no-store"})

    @app.get("/media/cache")
    def cache_status():
        return manager.cache_status()

    @app.post("/media/cache/clear")
    def clear_cache():
        return manager.clear_cache()

    @app.post("/media/cache/settings")
    def cache_settings(body: dict = Body(...)):
        try:
            return manager.set_cache_gb(body.get("cacheGB"))
        except (ValueError, TypeError, OverflowError) as error:
            raise HTTPException(400, str(error)) from None

    return manager
