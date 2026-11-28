# 暂停预缓冲修复验证

日期：2026-11-28。版本：1.5.13，本地候选安装包；本轮没有安装或公开发布。

## 复现与原因

使用真实 Electron Main/preload、Player、hls.js 和本地生成的 120 秒 HLS，记录实际分片请求、`video.buffered`、进度条与解码帧。测试使用隔离、静音、隐藏的访客档案，不读取正式账号。

旧版 1× 暂停后缓冲停在约 20 秒；3× 停在约 26 秒。暂停后 4 秒和 7 秒的数据相同，进度条与实际缓冲一致。恢复播放后媒体时间、解码帧和分片请求继续增长。

根因是活动槽的前向缓冲目标为 18/24 秒、上限 30 秒。暂停使播放位置固定，hls.js 达到预算后停止预读。这不是 UI 假死，也不是后端暂停了整集下载：后端先取得完整源文件，再生成本地 HLS。

基线证据：`_work/paused-buffer/baseline-source-1x.json`、`baseline-source-3x.json`。两次旧版回归均返回非零，捕获到暂停后缓冲未达到预期。

## 改动

前台手动暂停时给当前槽约 60 秒媒体时间的前向预算。短集可以缓到结尾，长集仍有界预读。hls.js 按分片加载，因此 2 秒分片样例可能缓至约 62 秒；`maxBufferSize` 不是内存硬上限。

`Player.applyBuffer` 统一处理暂停/播放、画质提交、倍速设置及窗口恢复。状态依据用户播放意图，而不是准备首帧或窗口隐藏产生的临时 `video.paused`。没有改动播放恢复看门狗、后端取源或签名。

恢复播放时回到原预算；下一集暖槽保留原预算；隐藏及离开播放页仍停止加载。缓存到片尾不能解除暂停或触发自动切集。

## 已完成验证

- `npm run verify`：类型检查与 408 项测试通过。
- `python -B -m unittest discover -s tools -p test_publish.py`：21 项通过。
- `node tools/qa-player-visibility.mjs`：12 项真实窗口最小化/恢复检查通过。
- `node tools/qa-playback-audit.mjs --label=paused-buffer-regression`：17 项播放、快捷键、小窗和片尾检查通过。
- `node tools/qa-playback-audit.mjs --scenario=held-seek --held-paused --label=paused-buffer-held-regression`：4 项通过；暂停后连续快进仍保持原集暂停。
- `tools/qa-paused-buffer.mjs`：源码 63 项、打包客户端 26 项通过。涵盖 1×/3×、达到原预算后再暂停、暂停时双向变速/换画质、隐藏停止请求/返回续缓、51 秒短片缓存到结尾及恢复正常预算。
- 51 秒打包样例缓至 51.0 秒、进度条 100%，仍保持原集、原位置和暂停状态；120 秒样例缓至约 62 秒，恢复后有持续真实解码与时间推进。
- 真实匿名在线暂停补测：8 项通过。直接从首页真实剧集进入，无 IPC 替身；1080×1920、65.37 秒、3×起播，暂停在 0.3855 秒，缓存从 24.22 秒增至 61.65 秒。继续暂停 1.2 秒，播放位置不动且不切集；恢复后 1.4 秒推进 4.08 秒、增加 47 帧。脚本已整理为 `tools/qa-paused-buffer-online.mjs`。
- `npm run package` 成功，包内产品版本为 1.5.13.0。

结果文件位于 `_work/paused-buffer/fixed-*.json`、`_work/paused-buffer/online-pause-result.json`、`_work/player-visibility-qa/result.json` 和 `_work/playback-audit/paused-buffer-*.json`。

## 未完成项与既有问题

既有真实匿名在线验收 `qa-release-playback-smoke.mjs --version=1.5.13`：包内 Python、native、签名组件和健康版本检查通过，但等待搜索“人前小保姆”的候选卡片超时，尚未进入播放。此脚本没有通过，在线自然连播未在本轮完成验收；上述独立首页取源/暂停/恢复补测已通过。无渲染异常，正式客户端进程全部保留。超时证据位于 `_work/release-playback-smoke/unpacked/result.json`。

`bootstrap-runtime.py --check` 报 `sign/domestic-sign.jar` 摘要不一致。现有 JAR 与正式安装 1.5.12、1.5.13 包内文件完全一致，属于 1.4.0 bootstrap 清单尚未同步后续签名修复的既有问题。本轮未改运行时、未重写清单，也未通过重新下载覆盖现有签名组件；不声称该检查通过。

## 本地产物

`release/hongguo-1.5.13-setup.exe`：267727828 字节。

SHA-256：`24856d2dd823fe406685ca991d0b4945f4380850fcd948dc961aa07a91567de9`。

校验文件：`release/hongguo-1.5.13-SHA256.txt`。沿用原包身份与保留数据的安装器设置；本轮未进行正式覆盖安装，因此不声称已实测本轮升级后的账号、历史、收藏和设置。
