"""Measure the production FFmpeg command on a local video; never reads an account or CDN URL."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "service"))
from media import MediaManager


class ProcessMemory(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]


def measure(command, folder, cores):
    folder.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    with (folder / "ffmpeg.log").open("wb") as log:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        kernel, psapi = ctypes.WinDLL("kernel32", use_last_error=True), ctypes.WinDLL("psapi", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        kernel.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_size_t]
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemory), wintypes.DWORD]
        handle = kernel.OpenProcess(0x0400 | 0x0010 | 0x0200, False, child.pid)
        if not handle:
            child.terminate()
            raise RuntimeError("Cannot measure FFmpeg process")
        if cores and not kernel.SetProcessAffinityMask(handle, (1 << cores) - 1):
            child.terminate()
            raise RuntimeError("Cannot constrain benchmark CPU affinity")
        peak = cpu = first = 0
        try:
            while True:
                memory = ProcessMemory(); memory.cb = ctypes.sizeof(memory)
                if psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                    peak = max(peak, memory.PeakWorkingSetSize, memory.WorkingSetSize)
                creation, exit_time, system, user = (wintypes.FILETIME() for _ in range(4))
                if kernel.GetProcessTimes(handle, *(ctypes.byref(x) for x in (creation, exit_time, system, user))):
                    cpu = ((system.dwHighDateTime << 32) + system.dwLowDateTime
                           + (user.dwHighDateTime << 32) + user.dwLowDateTime) / 10000000
                if not first and (folder / "seg000000.m4s").is_file():
                    first = time.perf_counter() - started
                if child.poll() is not None: break
                if time.perf_counter() - started > 120:
                    child.kill(); child.wait(); raise TimeoutError("FFmpeg benchmark timeout")
                time.sleep(.02)
        finally:
            kernel.CloseHandle(handle)
    return {"exitCode": child.returncode, "wallSeconds": round(time.perf_counter() - started, 3),
            "cpuSeconds": round(cpu, 3), "peakMemoryMB": round(peak / 1048576, 1),
            "firstSegmentSeconds": round(first, 3), "logicalCoresLimit": cores or None,
            "outputBytes": sum(p.stat().st_size for p in folder.glob("*.m4s"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--label", default="baseline")
    parser.add_argument("--cases", default="baseline,compatible,original")
    parser.add_argument("--cores", type=int, default=0)
    args = parser.parse_args()
    root = ROOT / "_work/performance/media"
    root.mkdir(parents=True, exist_ok=True)
    source = root / "source.mp4"
    if args.source: shutil.copyfile(args.source.resolve(), source)
    if not source.is_file(): raise RuntimeError("Specify --source for the first run")
    import av
    with av.open(str(source)) as container:
        video = container.streams.video[0]
        profile = {"codec": video.codec_context.name, "width": video.width, "height": video.height,
                   "fps": float(video.average_rate or 0), "duration": container.duration / av.time_base}
    manager = MediaManager(None, root / "manager", ROOT / "runtime/ffmpeg.exe", "benchmark-only")
    results = []
    try:
        for name in args.cases.split(","):
            folder = root / name
            command = manager._command(source, folder)
            if name == "original":
                from types import SimpleNamespace
                command = manager._delivery_command(source, SimpleNamespace(directory=folder, accept_hevc=True))
            if name == "baseline":
                i=command.index("-i");command[command.index("-threads"):i]=[]
            if name == "remux":
                start = command.index("-c:v"); end = command.index("-hls_time")
                command[start:end] = ["-c:v", "copy", "-tag:v", "hvc1", "-c:a", "copy"]
            if name not in ("current", "baseline", "original", "compatible"):
                command[command.index("-i"):command.index("-i")] = ["-threads", "2", "-filter_threads", "1"]
            if name == "low-delay":
                command[command.index("-crf"):command.index("-crf")] = ["-tune", "zerolatency"]
            if name == "short-lookahead":
                command[command.index("-crf"):command.index("-crf")] = ["-x264-params", "rc-lookahead=8:sync-lookahead=0"]
            if name in ("nvenc", "qsv"):
                start = command.index("-c:v"); end = command.index("-pix_fmt")
                replacement = ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "vbr", "-cq", "22", "-b:v", "0", "-bf", "0"] if name == "nvenc" else ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "22", "-look_ahead", "0", "-async_depth", "2", "-bf", "0"]
                command[start:end] = replacement
            result = {"case": name, **measure(command, folder, args.cores)}
            results.append(result)
            print(json.dumps(result), flush=True)
    finally: manager.close()
    (root / (args.label + ".json")).write_text(json.dumps({"source": profile, "results": results}, indent=2), encoding="utf-8")
    return 0 if results and results[0]["exitCode"] == 0 else 1


if __name__ == "__main__": sys.exit(main())
