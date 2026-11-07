# 1.2.2 播放性能

优化目标为 8GB 内存与八代 i5 等普通电脑。验收机为 i5-14600KF、RTX 5060、32GB 内存；限到四个逻辑处理器的测试仅约束计算并发，不能当作八代 i5 实机结果。显卡硬解能力由当前渲染器检测，未按 CPU 名称猜测。

## 同一视频的转换测量

2026-11-07，53.03 秒、1920×1080、30fps、HEVC Main/yuv420p 原视频。以下是 FFmpeg 子进程自身的峰值工作集，不是整个客户端内存。

| 路径 | 转换耗时 | CPU 时间 | FFmpeg 峰值内存 | 首片段 |
| --- | ---: | ---: | ---: | ---: |
| 原流程：自动解码线程、两线程 H.264 编码 | 10.256 秒 | 32.391 秒 | 467.8 MB | 0.727 秒 |
| 兼容流程：输入与编码均限制两线程 | 10.059 秒 | 31.125 秒 | 315.6 MB | 0.581 秒 |
| 保留原视频，仅封装 | 0.111 秒 | 0.062 秒 | 17.9 MB | 0.069 秒 |

硬解不可用时仍需转码，不能将封装结果套用于所有电脑。兼容路径保留既有画质参数；当多个视频待准备时只同时运行一个转换进程，避免多份解码/编码内存叠加。

同一视频限制到四个逻辑处理器后：原流程 14.941 秒/349.1MB，限制线程的兼容流程 14.329 秒/315.4MB，生产封装路径 0.127 秒/17.8MB。功耗、IPC、显卡及实际内存没有被改成八代 i5 机器。

实验还比较了 NVIDIA/Intel 硬件重编码与低延迟软件编码，但最终采用符合能力条件的原视频封装；兼容路径保留原编码参数。硬件重编码不是本次发行的必要依赖。

## 可复现验收

```powershell
runtime/python/python.exe -I -B tools/bench-media.py --source '本机一集视频.mp4' --label baseline
runtime/python/python.exe -I -B tools/bench-media.py --cases baseline,compatible,original --cores 4 --label four-cores
node tools/qa-playback-performance.mjs
node tools/qa-playback-performance.mjs --compatible
node tools/qa-danmaku-density.mjs
```

`bench-media.py` 只读复制给定本机视频，在 `_work/performance/media` 覆盖固定测试产物，不读取账号或视频下载凭据。当前 FFmpeg 生产命令与封装决策用于对比。

播放性能验收运行独立未登录档案，并在隐藏的离屏窗口里验证真实解码。强制不支持省电硬解时确实回到 H.264 转码；正常能力下实际使用 HEVC 原视频封装。活动缓冲有界，切到账号页后视频时间保持不变、弹幕重绘次数不增加。离屏窗口的 GPU/共享内存与普通屏幕窗口不同，进程 RSS 相加也不是用户任务管理器中的专用内存，不用它推导“整个客户端只有 18MB”。

本次没有对八代 i5 真机作流畅度或总内存承诺；实际驱动、片源和同时运行的程序仍决定体验。完整验证记录在 `verification.md`。
