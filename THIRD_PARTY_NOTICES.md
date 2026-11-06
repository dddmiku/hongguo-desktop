# 第三方依赖与协议适配

应用源码使用 Electron、React、TypeScript、Vite、hls.js、lucide-react、FastAPI、requests、PyAV 与 PyCryptodome；各依赖许可由相应软件包和运行时 notices 保留。

`service/vendor` 保留本地维护分支已有的协议 SDK 字段与纯文件算法，来源和删减范围见该目录 README。新客户端的窗口、IPC、UI、播放器、缓存、同步策略与服务生命周期由新项目实现。

独立 `runtime-win-x64.zip` 与安装包带有 Python/JRE 的原 LICENSE、NOTICE 和 legal 目录，以及 `licenses/runtime-notices`、`media-notices`、`media-build-recipe` 与 `media-sources.json`。PyAV 链接的媒体库与独立 FFmpeg 可执行文件分别保留来源，不能混用版本号。

独立 FFmpeg 来自 imageio-ffmpeg 0.6.0 的 Windows wheel，版本为 `7.1-essentials_build-www.gyan.dev`，启用 GPL 和 version3。相关许可证、对应 FFmpeg 7.1 源码与构建方来源索引见 `runtime/licenses/ffmpeg-7.1/`。
