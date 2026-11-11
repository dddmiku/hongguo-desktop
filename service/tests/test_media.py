"""媒体状态机回归及真实 HEVC→H.264 HLS 验证，测试文件只写工作区。"""
import json
import shutil
import subprocess
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from media import MediaBusy, MediaManager, mount_media

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "runtime" / "ffmpeg.exe"


def wait_for(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("media task timed out")
        time.sleep(0.01)


class Provider:
    def __init__(self, source, hold=False, delay=0, gate_size=0):
        self.path = source
        self.release = threading.Event()
        if not hold:
            self.release.set()
        self.started = threading.Event()
        self.all_started = threading.Event()
        self.gate_size = gate_size
        self.calls = 0
        self.released = 0
        self.active = 0
        self.peak = 0
        self.guard = threading.Lock()
        self.delay = delay

    def source(self, sid, episode, quality, cancelled):
        with self.guard:
            self.calls += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
            if self.gate_size and self.active >= self.gate_size:
                self.all_started.set()
        self.started.set()
        try:
            while not self.release.wait(0.01):
                if cancelled():
                    raise RuntimeError("cancelled source")
            if self.delay:
                time.sleep(self.delay)
            return self.path
        finally:
            with self.guard:
                self.active -= 1

    def release_source(self, path):
        with self.guard:
            self.released += 1


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / "_work" / "media-tests" / uuid.uuid4().hex
        self.work.mkdir(parents=True, exist_ok=False)
        self.source = self.work / "source.mp4"
        self.source.write_bytes(b"owned test source")
        self.encoder = self.work / "encoder.py"
        self.encoder.write_text(
            "import sys,time\nfrom pathlib import Path\n"
            "d=Path(sys.argv[1])\n"
            "(d/'init.mp4').write_bytes(b'init')\n"
            "(d/'seg000000.m4s').write_bytes(b'segment'*100)\n"
            "(d/'index.m3u8').write_text('#EXTM3U\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n"
            "#EXT-X-MAP:URI=\"init.mp4\"\\n#EXTINF:2,\\nseg000000.m4s\\n#EXT-X-ENDLIST\\n')\n"
            "time.sleep(.04)\n", encoding="utf-8")
        self.managers = []

    def manager(self, provider=None, real=False, subdir="", **kwargs):
        provider = provider or Provider(self.source)
        manager = MediaManager(provider, self.work / subdir, FFMPEG, "test-secret", **kwargs)
        if not real:
            manager._command = lambda source, directory: [sys.executable, str(self.encoder), str(directory)]
        self.managers.append(manager)
        return manager

    def tearDown(self):
        for manager in self.managers:
            manager.close()
        expected = (ROOT / "_work" / "media-tests").resolve()
        self.assertEqual(self.work.resolve().parent, expected)
        shutil.rmtree(self.work)

    def test_cancel_stops_source_and_releases_active_reference(self):
        provider = Provider(self.source, hold=True)
        manager = self.manager(provider)
        session = manager.create("12345678", 1)
        self.assertTrue(provider.started.wait(2))
        manager.cancel(session["id"])
        wait_for(lambda: manager.pending == 0)
        self.assertEqual(manager.get(session["id"])["phase"], "cancelled")
        self.assertEqual(manager.cache_status()["active"], 0)
        self.assertFalse(list(manager.root.glob("*.part")))

    def test_permission_failure_preserves_fixed_business_reason_without_raw_source_details(self):
        from provider import ProviderError
        class RestrictedSource(Provider):
            def source(self, sid, episode, quality, cancelled):
                raise ProviderError("MEDIA_ACCESS_RESTRICTED", "synthetic-upstream-context", 403)
        manager = self.manager(RestrictedSource(self.source))
        session = manager.create("12345678", 54)
        wait_for(lambda: manager.pending == 0)
        result = manager.get(session["id"])
        self.assertEqual(result["phase"], "error")
        self.assertIn("未开放这集的播放权限", result["error"])
        self.assertNotIn("synthetic-upstream-context", result["error"])
        self.assertNotIn("ProviderError", result["error"])

    def test_same_source_deduplicates_and_one_cancel_does_not_stop_other(self):
        provider = Provider(self.source, hold=True)
        manager = self.manager(provider)
        first = manager.create("12345678", 1, prefetch=True)
        second = manager.create("12345678", 1, start=20)
        self.assertTrue(provider.started.wait(2))
        manager.cancel(first["id"])
        provider.release.set()
        wait_for(lambda: manager.get(second["id"])["phase"] == "complete")
        wait_for(lambda: manager.pending == 0)
        self.assertEqual(provider.calls, 1)
        self.assertEqual(provider.released, 1)
        self.assertTrue(manager.get(second["id"])["cached"])
        third = manager.create("12345678", 1)
        self.assertEqual(third["phase"], "complete")
        self.assertEqual(provider.calls, 1)

    def test_cancel_terminates_own_running_encoder(self):
        manager = self.manager()
        manager._command = lambda source, directory: [sys.executable, "-c", "import time;time.sleep(60)"]
        session = manager.create("12345678", 1)
        job = manager.sessions[session["id"]].job
        wait_for(lambda: job.process is not None)
        process = job.process
        manager.cancel(session["id"])
        wait_for(lambda: manager.pending == 0)
        self.assertIsNotNone(process.poll())
        self.assertEqual(manager.get(session["id"])["phase"], "cancelled")
        self.assertFalse(job.directory.exists())
        self.assertEqual(manager.provider.released, 1)

    def test_failed_jobs_are_released_and_can_retry(self):
        provider = Provider(self.work / "missing.mp4")
        manager = self.manager(provider)
        session = manager.create("12345678", 1)
        wait_for(lambda: manager.pending == 0)
        self.assertEqual(manager.get(session["id"])["phase"], "error")
        manager.cancel(session["id"])
        self.assertEqual(len(manager.jobs), 0)
        provider.path = self.source
        retry = manager.create("12345678", 1)
        wait_for(lambda: manager.pending == 0)
        self.assertEqual(manager.get(retry["id"])["phase"], "complete")

    def test_complete_episode_duration_is_exposed_before_encoding_finishes(self):
        provider = Provider(self.source)
        provider.detail = lambda sid: {"episodes": [{"index": 1, "duration": 179}]}
        manager = self.manager(provider)
        self.encoder.write_text(self.encoder.read_text(encoding="utf-8").replace("time.sleep(.04)", "time.sleep(60)"), encoding="utf-8")
        session = manager.create("12345678", 1)
        job = manager.sessions[session["id"]].job
        wait_for(lambda: manager.get(session["id"])["phase"] == "ready")
        state = manager.get(session["id"])
        self.assertEqual(state["duration"], 179)
        self.assertFalse(job.done.is_set())
        self.assertIn(b"#EXTINF:2,", manager.read_file(session["id"], "index.m3u8"))
        manager.cancel(session["id"])
        self.assertTrue(job.done.wait(2))

    def test_windows_directory_sharing_handle_retries_only_promotion(self):
        manager = self.manager()
        blocked, errors, attempts = {}, [], []
        original_ready, original_rename = manager._mark_ready, Path.rename
        kernel = None
        if sys.platform == "win32":
            import ctypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                          ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
            kernel.CreateFileW.restype = ctypes.c_void_p
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle.restype = ctypes.c_int

        def ready(job):
            result = original_ready(job)
            if result and not blocked:
                blocked["path"] = job.directory
                if kernel is not None:
                    # 真正的Windows目录句柄：READ/WRITE共享，但不允许DELETE/rename。
                    handle = kernel.CreateFileW(str(job.directory), 1, 3, None, 3, 0x02000000, None)
                    self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
                    blocked["handle"] = handle
            return result

        def rename(path, target):
            if path == blocked.get("path"):
                attempts.append(path)
                try:
                    if kernel is None and not errors:
                        error = PermissionError(13, "fixture sharing violation", str(path))
                        error.winerror = 32
                        raise error
                    return original_rename(path, target)
                except PermissionError as error:
                    errors.append(error)
                    if kernel is not None and "handle" in blocked:
                        kernel.CloseHandle(blocked.pop("handle"))
                    raise
            return original_rename(path, target)

        manager._mark_ready = ready
        try:
            with patch.object(Path, "rename", rename):
                session = manager.create("12345678", 1)
                job = manager.sessions[session["id"]].job
                self.assertTrue(job.done.wait(8))
            self.assertEqual(manager.get(session["id"])["phase"], "complete")
            self.assertEqual(len(errors), 1)
            self.assertIn(errors[0].winerror, (32, 33))
            self.assertEqual(Path(errors[0].filename), blocked["path"])
            self.assertGreaterEqual(len(attempts), 2)
            self.assertTrue(job.directory.joinpath("init.mp4").is_file())
            self.assertEqual(manager.provider.calls, 1)
        finally:
            if kernel is not None and "handle" in blocked:
                kernel.CloseHandle(blocked.pop("handle"))

    def test_promotion_does_not_retry_real_permission_denied(self):
        manager = self.manager()
        original_rename = Path.rename
        attempts = []

        def rename(path, target):
            if path.name.endswith(".part"):
                attempts.append(path)
                error = PermissionError(13, "fixture access denied", str(path))
                error.winerror = 5
                raise error
            return original_rename(path, target)

        with patch.object(Path, "rename", rename):
            session = manager.create("12345678", 1)
            self.assertTrue(manager.sessions[session["id"]].job.done.wait(8))
        self.assertEqual(manager.get(session["id"])["phase"], "error")
        self.assertEqual(len(attempts), 1)

    def test_promotion_retry_is_cancelled_without_waiting_full_budget(self):
        manager = self.manager()
        original_rename = Path.rename
        sharing = threading.Event()

        def rename(path, target):
            if path.name.endswith(".part"):
                sharing.set()
                error = PermissionError(13, "fixture sharing violation", str(path))
                error.winerror = 32
                raise error
            return original_rename(path, target)

        with patch.object(Path, "rename", rename):
            session = manager.create("12345678", 1)
            job = manager.sessions[session["id"]].job
            self.assertTrue(sharing.wait(5))
            manager.cancel(session["id"])
            self.assertTrue(job.done.wait(1))
        self.assertEqual(manager.get(session["id"])["phase"], "cancelled")

    def test_persistent_sharing_conflict_has_bounded_retry_budget(self):
        manager = self.manager()
        original_rename = Path.rename
        attempts = []

        def rename(path, target):
            if path.name.endswith(".part"):
                attempts.append(time.monotonic())
                error = PermissionError(13, "fixture persistent sharing violation", str(path))
                error.winerror = 32
                raise error
            return original_rename(path, target)

        with patch.object(Path, "rename", rename):
            session = manager.create("12345678", 1)
            job = manager.sessions[session["id"]].job
            self.assertTrue(job.done.wait(3), "sharing retries did not stop")
        self.assertEqual(manager.get(session["id"])["phase"], "error")
        self.assertGreater(len(attempts), 1)
        self.assertLess(attempts[-1] - attempts[0], 1.5)
        self.assertFalse(job.directory.exists())

    def test_workers_and_queue_are_bounded(self):
        # 明确等首批4个worker同时进入source后再放行；不用sleep制造竞争窗口。
        provider = Provider(self.source, hold=True, gate_size=4)
        manager = self.manager(provider)
        sessions = [manager.create("12345678", episode) for episode in range(1, 13)]
        jobs = [manager.sessions[item["id"]].job for item in sessions]
        try:
            self.assertTrue(provider.all_started.wait(5), "first four workers did not start")
        finally:
            provider.release.set()
        deadline = time.monotonic() + 20
        for job in jobs:
            self.assertTrue(job.done.wait(max(0, deadline - time.monotonic())),
                            f"worker did not finish: {job.phase} / {job.error}")
        self.assertEqual(provider.peak, 4)
        self.assertLessEqual(provider.peak, 4)
        states = [manager.get(item["id"]) for item in sessions]
        self.assertTrue(all(state["phase"] == "complete" for state in states), states)
        held = Provider(self.source, hold=True)
        # 两个manager的cache互不共享，第二个启动清扫不会接触第一个的产物。
        bounded = self.manager(held, subdir="bounded", max_workers=1, max_pending=2)
        first = bounded.create("87654321", 1)
        bounded.create("87654321", 2)
        with self.assertRaises(MediaBusy):
            bounded.create("87654321", 3)
        self.assertTrue(bounded.create("87654321", 1)["cached"])
        bounded.cancel(first["id"])
        held.release.set()

    def test_cache_clear_and_lru_keep_active_files(self):
        manager = self.manager(cache_bytes=1)
        first = manager.create("12345678", 1)
        second = manager.create("12345678", 2)
        wait_for(lambda: manager.pending == 0)
        self.assertEqual(manager.clear_cache()["entries"], 2)
        manager.cancel(first["id"])
        self.assertEqual(manager.cache_status()["entries"], 1)
        self.assertIn(b"#EXTM3U", manager.read_file(second["id"], "index.m3u8"))
        manager.cancel(second["id"])
        self.assertEqual(manager.cache_status()["bytes"], 0)

    def test_expired_session_reopens_complete_cached_job_without_redownloading(self):
        provider = Provider(self.source)
        manager = self.manager(provider)
        first = manager.create("12345678", 54)
        wait_for(lambda: manager.pending == 0)
        original = manager.sessions[first["id"]].job
        with manager.guard:
            manager.sessions[first["id"]].accessed = time.time() - 901
            manager._expire_sessions()
        self.assertNotIn(first["id"], manager.sessions)
        app = FastAPI()
        mount_media(app, manager)
        with TestClient(app) as client:
            response = client.get("/media/session/" + first["id"])
            self.assertEqual(response.status_code, 404)
            detail = response.json()["detail"]["error"]
            self.assertEqual(detail["code"], "MEDIA_SESSION_EXPIRED")
            self.assertNotIn(first["id"], detail["message"])
        second = manager.create("12345678", 54, start=12.5)
        self.assertEqual(second["phase"], "complete")
        self.assertTrue(second["cached"])
        self.assertIs(manager.sessions[second["id"]].job, original)
        self.assertEqual(provider.calls, 1)
        self.assertIn(b"#EXTM3U", manager.read_file(second["id"], "index.m3u8"))

    def test_routes_enforce_token_and_reject_path_traversal(self):
        manager = self.manager()
        app = FastAPI()
        mount_media(app, manager)
        with TestClient(app) as client:
            response = client.post("/media/session", json={"seriesId": "12345678", "episode": 1})
            self.assertEqual(response.status_code, 200)
            session = response.json()
            wait_for(lambda: manager.pending == 0)
            prefix = "/media/session/" + session["id"]
            self.assertEqual(client.get(prefix + "/index.m3u8").status_code, 401)
            manifest = client.get(prefix + "/index.m3u8?token=test-secret")
            self.assertEqual(manifest.status_code, 200)
            self.assertIn('URI="init.mp4?token=test-secret"', manifest.text)
            self.assertIn("seg000000.m4s?token=test-secret", manifest.text)
            self.assertEqual(client.get(prefix + "/seg000000.m4s?token=test-secret").status_code, 200)
            for name in ("..%2F..%2Fsource.mp4", "folder/source.mp4", "complete.json"):
                self.assertEqual(client.get(prefix + "/" + name + "?token=test-secret").status_code, 404)

    def test_startup_cleans_only_own_partial_and_reloads_completed_cache(self):
        manager = self.manager()
        session = manager.create("12345678", 1)
        wait_for(lambda: manager.pending == 0)
        manager.cancel(session["id"])
        manager.close()
        own_partial = manager.root / ("a" * 64 + ".part")
        own_partial.mkdir()
        (own_partial / "part").write_text("owned")
        foreign = manager.root / "user-files"
        foreign.mkdir()
        (foreign / "note.txt").write_text("keep")
        restored = self.manager()
        self.assertFalse(own_partial.exists())
        self.assertTrue((foreign / "note.txt").exists())
        self.assertEqual(restored.create("12345678", 1)["phase"], "complete")
        self.assertEqual(restored.provider.calls, 0)

    @unittest.skipUnless(FFMPEG.is_file(), "run tools/prepare_runtime.py for real codec validation")
    def test_real_hevc_to_h264_hls_and_first_segment_decode(self):
        create = subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
                                 "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24",
                                 "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                                 "-t", "6", "-c:v", "libx265", "-preset", "ultrafast",
                                 "-x265-params", "pools=1:frame-threads=1", "-c:a", "aac",
                                 str(self.source)], capture_output=True, timeout=30,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(create.returncode, 0, create.stderr.decode(errors="replace")[-2000:])
        manager = self.manager(real=True)
        session = manager.create("12345678", 1, "1080p")
        wait_for(lambda: manager.pending == 0, seconds=30)
        state = manager.get(session["id"])
        self.assertEqual(state["phase"], "complete", state)
        manifest = manager.read_file(session["id"], "index.m3u8").decode()
        self.assertIn("#EXT-X-ENDLIST", manifest)
        self.assertIn("#EXT-X-PLAYLIST-TYPE:VOD", manifest)
        first = self.work / "first-fragment.mp4"
        first.write_bytes(manager.read_file(session["id"], "init.mp4")
                          + manager.read_file(session["id"], "seg000000.m4s"))
        decode = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(first),
                                 "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
                                capture_output=True, timeout=20,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(decode.returncode, 0, decode.stderr.decode(errors="replace")[-2000:])
        self.assertIn(b"h264", decode.stderr)
        self.assertIn(b"aac", decode.stderr)


if __name__ == "__main__":
    unittest.main()
