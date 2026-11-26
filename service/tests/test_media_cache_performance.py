"""Completed-cache accounting must not stop an active HLS reader."""
from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import sys
import threading
import time
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "service"))
from media import MediaBusy, MediaManager, _Job, _Session, _OWNER


class MediaCachePerformanceTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / "_work/media-performance-tests" / uuid.uuid4().hex
        self.work.mkdir(parents=True)
        self.manager = MediaManager(None, self.work, ROOT / "runtime/ffmpeg.exe", "fixture-only")

    def tearDown(self):
        self.manager.close()
        self.assertEqual(self.work.parent.resolve(), (ROOT / "_work/media-performance-tests").resolve())
        shutil.rmtree(self.work)

    def completed(self, episode):
        key = hashlib.sha256(f"{_OWNER}:12345678:{episode}:1080p".encode()).hexdigest()
        folder = self.manager.root / (key + ".part")
        folder.mkdir()
        (folder / "owner").write_text(_OWNER)
        (folder / "init.mp4").write_bytes(b"fixture-init")
        (folder / "seg000000.m4s").write_bytes(b"fixture-segment")
        (folder / "index.m3u8").write_text("#EXTM3U\n#EXTINF:2,\nseg000000.m4s\n#EXT-X-ENDLIST\n")
        (folder / "complete.json").write_text(json.dumps({
            "owner": _OWNER, "seriesId": "12345678", "episode": episode,
            "quality": "1080p", "duration": 2,
        }))
        job = _Job(key, "12345678", episode, "1080p", folder, phase="ready")
        self.manager.jobs[key] = job
        self.manager._promote(job)
        identifier = uuid.uuid4().hex
        session = _Session(identifier, job)
        self.manager.sessions[identifier] = session
        job.refs.add(identifier)
        job.ready.set()
        job.done.set()
        return session

    def test_episode_completion_and_cancel_do_not_rescan_finished_cache_or_block_playback(self):
        for action in ("finished", "cancel"):
            with self.subTest(action=action):
                current = self.completed(1 if action == "finished" else 3)
                other = self.completed(2 if action == "finished" else 4)
                entered, release, finished = threading.Event(), threading.Event(), threading.Event()
                original = self.manager._size

                def blocked_size(directory):
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError("fixture directory gate was not released")
                    return original(directory)

                def finish():
                    try:
                        if action == "finished":
                            self.manager.pending += 1
                            future = Future()
                            future.set_result(None)
                            self.manager._finished(other.job, future)
                        else:
                            self.manager.cancel(other.id)
                    finally:
                        finished.set()

                with patch.object(self.manager, "_size", side_effect=blocked_size) as size:
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        pruning = pool.submit(finish)
                        deadline = time.monotonic() + 1
                        while not entered.is_set() and not finished.is_set() and time.monotonic() < deadline:
                            finished.wait(.005)
                        self.assertTrue(entered.is_set() or finished.is_set(), "completion never started")
                        reading = pool.submit(self.manager.read_file, current.id, "seg000000.m4s")
                        try:
                            self.assertEqual(reading.result(timeout=.3), b"fixture-segment")
                            self.assertEqual(size.call_count, 0, "completed cache must use recorded byte counts")
                        finally:
                            release.set()
                            pruning.result(timeout=2)

    def test_cache_status_scans_growing_jobs_without_holding_the_playback_lock(self):
        current = self.completed(1)
        key = hashlib.sha256(b"growing").hexdigest()
        directory = self.manager.root / (key + ".part")
        directory.mkdir()
        (directory / "segment.partial").write_bytes(b"growing")
        growing = _Job(key, "12345678", 2, "1080p", directory, phase="ready")
        self.manager.jobs[key] = growing
        entered, release = threading.Event(), threading.Event()
        original = self.manager._size

        def blocked_size(folder):
            if folder == directory:
                entered.set()
                if not release.wait(3):
                    raise AssertionError("fixture directory gate was not released")
            return original(folder)

        try:
            with patch.object(self.manager, "_size", side_effect=blocked_size):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    status = pool.submit(self.manager.cache_status)
                    self.assertTrue(entered.wait(1))
                    reading = pool.submit(self.manager.read_file, current.id, "seg000000.m4s")
                    try:
                        self.assertEqual(reading.result(timeout=.3), b"fixture-segment")
                    finally:
                        release.set()
                        first = status.result(timeout=2)
            (directory / "segment.partial").write_bytes(b"growing" * 100)
            second = self.manager.cache_status()
            self.assertEqual(second["bytes"] - first["bytes"], len(b"growing") * 99)
        finally:
            growing.phase = "cancelled"
            growing.done.set()

    def test_complete_size_is_recorded_at_promotion_and_reloaded_once(self):
        current = self.completed(1)
        expected = sum(path.stat().st_size for path in current.job.directory.iterdir())
        with patch.object(self.manager, "_size", side_effect=AssertionError("unexpected completed rescan")):
            self.assertEqual(self.manager.cache_status()["bytes"], expected)
            self.manager.cancel(current.id)
            self.assertEqual(self.manager.cache_status()["bytes"], expected)
        self.manager.close()
        self.manager = MediaManager(None, self.work, ROOT / "runtime/ffmpeg.exe", "fixture-only")
        with patch.object(self.manager, "_size", side_effect=AssertionError("unexpected completed rescan")):
            self.assertEqual(self.manager.cache_status()["bytes"], expected)

    def test_slow_unused_cache_removal_does_not_block_the_playing_episode(self):
        current = self.completed(1)
        unused = self.completed(2)
        self.manager.cancel(unused.id)
        entered, release = threading.Event(), threading.Event()
        original = self.manager._remove

        def slow_remove(directory):
            if directory == unused.job.directory:
                entered.set()
                if not release.wait(3):
                    raise AssertionError("cache removal gate was not released")
            original(directory)

        with patch.object(self.manager, "_remove", side_effect=slow_remove):
            with ThreadPoolExecutor(max_workers=2) as pool:
                clearing = pool.submit(self.manager.clear_cache)
                self.assertTrue(entered.wait(1))
                reading = pool.submit(self.manager.read_file, current.id, "seg000000.m4s")
                try:
                    self.assertEqual(reading.result(timeout=.3), b"fixture-segment")
                finally:
                    release.set()
                    clearing.result(timeout=2)
        self.assertTrue(current.job.directory.is_dir())
        self.assertFalse(unused.job.directory.exists())

    def test_new_session_cannot_claim_a_cache_entry_while_it_is_being_deleted(self):
        unused = self.completed(1)
        self.manager.cancel(unused.id)
        entered, release = threading.Event(), threading.Event()
        original = self.manager._remove

        def slow_remove(directory):
            entered.set()
            if not release.wait(3):
                raise AssertionError("cache removal gate was not released")
            original(directory)

        with patch.object(self.manager, "_remove", side_effect=slow_remove):
            with ThreadPoolExecutor(max_workers=2) as pool:
                clearing = pool.submit(self.manager.clear_cache)
                self.assertTrue(entered.wait(1))
                opening = pool.submit(self.manager.create, "12345678", 1, "1080p")
                try:
                    with self.assertRaises(MediaBusy):
                        opening.result(timeout=.3)
                finally:
                    release.set()
                    clearing.result(timeout=2)
        self.assertNotIn(unused.job.key, self.manager.jobs)

    def test_cleanup_failure_releases_maintenance_and_session_reservation(self):
        unused = self.completed(1)
        self.manager.cancel(unused.id)
        with patch.object(self.manager, "_remove", side_effect=PermissionError("fixture locked")):
            with self.assertRaises(PermissionError):
                self.manager.clear_cache()
        # A Windows sharing failure must not strand the entry in MEDIA_BUSY.
        claimed = self.manager.create("12345678", 1, "1080p")
        self.assertEqual(claimed["phase"], "complete")
        self.assertEqual(self.manager.read_file(claimed["id"], "seg000000.m4s"), b"fixture-segment")
        self.manager.cancel(claimed["id"])
        self.manager.clear_cache()
        self.assertFalse(unused.job.directory.exists())

    def test_pressure_cleanup_allows_reads_and_does_not_delete_active_files(self):
        current, unused = self.completed(1), self.completed(2)
        self.manager.cancel(unused.id)
        self.manager.limit = current.job.size_bytes
        entered, release = threading.Event(), threading.Event()
        original = self.manager._remove

        def slow_remove(directory):
            self.assertEqual(directory, unused.job.directory)
            entered.set()
            if not release.wait(3):
                raise AssertionError("pressure cleanup gate was not released")
            original(directory)

        with patch.object(self.manager, "_remove", side_effect=slow_remove):
            with ThreadPoolExecutor(max_workers=2) as pool:
                pruning = pool.submit(self.manager.cache_status)
                self.assertTrue(entered.wait(1))
                reading = pool.submit(self.manager.read_file, current.id, "seg000000.m4s")
                try:
                    self.assertEqual(reading.result(timeout=.3), b"fixture-segment")
                finally:
                    release.set()
                    status = pruning.result(timeout=2)
        self.assertEqual(status["bytes"], current.job.size_bytes)
        self.assertEqual(status["active"], 1)
        self.assertTrue(current.job.directory.is_dir())


if __name__ == "__main__":
    unittest.main()
