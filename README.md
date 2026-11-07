# 红果桌面

一个从源码构建的 Windows 短剧客户端。界面采用独立设计：顶部导航、全宽内容、按需打开的右侧片库抽屉、真实海报主视觉与炭黑莓红主题，并提供完整的浅色与系统主题。

新客户端由 **Electron + React + TypeScript** 和独立 Python 内容服务组成。它不运行旧客户端的 EXE 或 `server.py`，也不再修改旧应用的内嵌前端。

## 安装与使用

Windows PC 的源码、下载、更新和反馈在本仓库独立维护。Android TV / 电视盒子请使用 [hongguo-tv](https://github.com/dddmiku/hongguo-tv)。旧混合仓库自 **2026 年 11 月 7 日**起停止维护，详见 [停止维护与迁移说明](docs/legacy-retirement.md)。

在 [GitHub Releases](https://github.com/dddmiku/hongguo-desktop/releases) 下载最新 `hongguo-*-setup.exe`，按向导安装。安装包自带播放所需运行时，无需另装 Python、Java 或 FFmpeg。

常用功能：

- 发现、推荐、排行榜与片库探索，支持真人短剧、漫剧和 AI 剧筛选。
- 搜索、剧集详情、选集播放、画质和倍速切换、自动连播及后续剧集预取。
- 本地观看记录与收藏；登录后读取并同步账号数据。
- 观看历史完整保存到 SQLite，按真实时间分组，可搜索、筛选及分页，不按固定条数淘汰。
- 评论、窗口与托盘操作、老板键、缓存限额和清理、诊断导出与更新检查。
- 手机端真实弹幕随剧集进度显示；支持 D 开关、字号、透明度、区域、密度和本机屏蔽词。
- 播放中进入账号、设置或片库会保留当前剧集，暂停后可以从“返回播放”继续；最小化会暂停并停止后台预取。

1.2.2 根据实际显卡解码能力选择播放路径：支持流畅硬解的 HEVC 与兼容 H.264 原视频直接封装，不额外重编码；不满足条件时自动采用 H.264 兼容转码。最多一个视频转换任务并行，输入解码与软件编码都限为两线程，后台槽只准备下一集的少量数据。8GB 内存与八代 i5 是优化目标，实际体验仍取决于显卡解码能力、驱动、片源及同时运行的应用，当前验收机不是八代 i5。

题材、评论和可选画质以实际片源及上游接口为准。无网络时可查看本机记录；首次播放与在线同步仍需要联网。

### 旧版用户

新客户端的初代正式版本是 **1.0.0**，与旧客户端的 1.9.x 版本序列独立。旧版从原更新入口获取 **1.9.15 兼容桥**，安装后运行红果桌面 **1.2.2**；兼容桥的编号仅供旧更新器比较，不是新应用版本。

在旧客户端点击“检查更新”即可按提示迁移。旧版会缓存更新结果；若刚检查过仍显示旧结果，请从托盘完全退出客户端后重新打开再检查。新客户端安装后，更新入口自动使用本仓库。

新安装包与界面的版本一致，运行时 ZIP 另行固定版本和摘要。新客户端使用独立应用 ID 和安装目录，首次启动只读导入旧历史、收藏和可用登录会话，已有账号与记录在后续覆盖升级时保留。

导入不会把旧历史加入待上传队列，也不会重写云端进度。已核验的旧 SQLite 历史表没有秒级位置，导入后从对应集的开头继续；旧 WebView 的画质、倍速和自动连播偏好采用只读 LevelDB 解析导入，无法验证的数据保留新版默认值。详见 [迁移说明](docs/migration.md)。

## 从源码构建

环境：Windows x64、Node.js 22 或更新版本、Python 3.11 或更新版本。

```powershell
git clone https://github.com/dddmiku/hongguo-desktop.git
cd hongguo-desktop
npm ci
python tools/bootstrap-runtime.py
npm run build
npm start
```

`bootstrap-runtime.py` 从 `runtime-manifest.json` 指定的本项目 Release 下载 `runtime-win-x64.zip`，优先尝试国内加速源，按完整 SHA-256 校验后安全解压到 `runtime/`。下载与展开产物都位于项目 `_work/`，不使用系统临时目录。运行时包含第三方许可证。

检查已安装运行时，或生成安装包：

```powershell
python tools/bootstrap-runtime.py --check
npm run package
```

安装包输出到 `release/`。发布源码不跟踪便携运行时；运行时 ZIP 和固定摘要使普通克隆环境可以取得与该源码版本配套的依赖。`tools/prepare_runtime.py` 是维护者在本机整理发行运行时的工具，普通开发者无需旧客户端目录，只使用 bootstrap。

## 验证

```powershell
npm run typecheck
npm test
python -m pip install -r service/requirements.txt httpx2
python -m unittest discover -s service/tests -v
```

自动测试使用隔离文件、合成 SQLite 和接口替身，覆盖本地持久化、迁移、服务生命周期、接口契约与媒体任务管理。它们不发送真实短信，不登录真实账号，不向云端写入进度。

开发验收包含实际 Electron 客户端与真实片单、播放、切集、主题和本地库操作。**真实短信登录和 MFA 验证仍需要实际账号测试，不能由自动测试或现有会话恢复代替。** 最新截图可见 [界面截图目录](docs/screenshots/)。

GitHub Actions 在 Windows 上运行类型检查、前端/主进程测试和 Python 服务测试。手动触发工作流并勾选安装包构建后，下载运行时、构建 NSIS 安装包并作为 Actions artifact 保存；工作流不会自动公开发布 Release。

## 版本迭代

从 1.0.0 开始，新客户端遵循 SemVer 的 `主版本.次版本.修订版本`：

- **主版本（major）**：破坏兼容性，或明确的重大产品代际变化。
- **次版本（minor）**：保持兼容的新增功能。
- **修订版本（patch）**：修复缺陷、性能与外观优化，保持现有功能和数据兼容。

一般修复与优化按修订版本递增，新增功能按次版本递增。没有破坏兼容或明确产品代际变化时，不随意跳主版本。旧版的 1.9.10 兼容桥不参与新客户端的版本递增。

## 目录与依赖

```text
electron/            桌面主进程、受限 preload bridge、本地存储、服务监督与迁移
src/                 React 界面、播放器与主题
shared/              跨层 TypeScript 数据契约
service/             独立 Python 网关、内容适配与媒体服务
service/vendor/      已使用的第三方协议/解密实现
runtime/             经清单校验的便携运行时，不纳入源码 Git
runtime-manifest.json 配套运行时的 URL、版本与 SHA-256
tools/               构建与运行时准备工具
docs/                架构、迁移及真实客户端截图
```

内容适配层复用了现有协议 SDK 和签名依赖；界面、Electron 外壳、服务网关、媒体任务和本地存储均在新仓库中维护。第三方依赖包括 Python、JRE、FFmpeg、PyAV 与签名组件，其许可证随运行时保留；这些依赖不是本项目原创代码。更详细的边界见 [架构说明](docs/architecture.md)。
