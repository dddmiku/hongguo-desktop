"""The compatible path stays playable; hardware-capable playback preserves the encoded video."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "service"))
from media import MediaManager

FFMPEG = ROOT / "runtime/ffmpeg.exe"


class Provider:
    def __init__(self, source): self.path = source
    def source(self, *args, **kwargs): return self.path
    def release_source(self, path): pass


class MediaPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / "_work/media-performance-tests" / uuid.uuid4().hex
        self.root.mkdir(parents=True)
        self.manager = None

    def tearDown(self):
        if self.manager: self.manager.close()
        shutil.rmtree(self.root)

    def manager_for(self, source):
        self.manager = MediaManager(Provider(source), self.root, FFMPEG, "performance-test")
        return self.manager

    def test_software_fallback_caps_both_decoder_and_encoder_threads(self):
        manager = self.manager_for(self.root / "source.mp4")
        command = manager._command(self.root / "source.mp4", self.root)
        decoder = command[:command.index("-i")]
        self.assertIn("-threads", decoder)
        self.assertEqual(decoder[decoder.index("-threads") + 1], "2")
        self.assertEqual(command.count("-threads"), 2)
        self.assertIn("libx264", command)

    def test_prefetch_does_not_allocate_a_second_ffmpeg_while_first_is_running(self):
        source=self.root/'source.mp4';source.write_bytes(b'controlled source')
        manager=self.manager_for(source)
        manager._command=lambda source,directory:[sys.executable,'-c','import time;time.sleep(30)']
        first=manager.create('12345678',1);job=manager.sessions[first['id']].job
        deadline=time.monotonic()+3
        while job.process is None and time.monotonic()<deadline:time.sleep(.01)
        self.assertIsNotNone(job.process)
        second=manager.create('12345678',2);next_job=manager.sessions[second['id']].job
        deadline=time.monotonic()+3
        while not (next_job.directory/'owner').is_file() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue((next_job.directory/'owner').is_file())
        time.sleep(.1)
        self.assertIsNone(next_job.process,'后台下一集也分配了独立 FFmpeg 编码资源')
        manager.cancel(first['id'])
        deadline=time.monotonic()+3
        while next_job.process is None and time.monotonic()<deadline:time.sleep(.01)
        self.assertIsNotNone(next_job.process)
        manager.cancel(second['id'])

    @unittest.skipUnless(FFMPEG.is_file(), "Bundled FFmpeg required")
    def test_supported_hevc_uses_remux_with_matching_real_video_and_audio(self):
        source = self.root / "source.mp4"
        created = subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
                                  "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24",
                                  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                                  "-t", "5", "-c:v", "libx265", "-preset", "ultrafast",
                                  "-x265-params", "pools=1:frame-threads=1", "-c:a", "aac", str(source)],
                                 capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(created.returncode, 0)
        manager = self.manager_for(source)
        session = manager.create("12345678", 1, "1080p", accept_hevc=True)
        deadline = time.monotonic() + 20
        while manager.pending and time.monotonic() < deadline: time.sleep(.02)
        state = manager.get(session["id"])
        self.assertEqual(state["phase"], "complete", state)
        self.assertEqual(state["delivery"], "remux")
        self.assertEqual(state["videoCodec"], "hevc")
        first = self.root / "first.mp4"
        first.write_bytes(manager.read_file(session["id"], "init.mp4") + manager.read_file(session["id"], "seg000000.m4s"))
        decoded = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(first), "-map", "0:v:0", "-map", "0:a:0",
                                  "-f", "null", "-"], capture_output=True, timeout=20,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors="replace")[-1000:])
        self.assertIn(b"hevc", decoded.stderr)
        self.assertIn(b"aac", decoded.stderr)
        compatible = manager.create("12345678", 1, "1080p")
        self.assertNotEqual(manager.sessions[session["id"]].job.key, manager.sessions[compatible["id"]].job.key)


if __name__ == "__main__": unittest.main()
