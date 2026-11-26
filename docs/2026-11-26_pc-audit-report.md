# PC 客户端源码审计与实测

日期：2026-11-26。基线：1.5.11 / `153f60c`；修复目标：1.5.12。

## 范围与方法

本轮按用户要求检查 PC 客户端源码并实测，覆盖目录/搜索、Electron 原生窗口、播放器、HLS 会话、缓存清理与服务启动。TV 不在本轮改动范围内。

测试档案位于项目 `_work/`。播放使用静音 Electron 与真实 HLS；受控接口只替换内容和账号数据，不替换播放器。另有真实 Python/Java 服务与真实匿名上游播放检查。没有复制用户登录态到新测试档案，没有修改或删除正式历史、收藏和设置。

所有结论区分源码推断、受控复现和真实上游检查。现有测试基线通过并不等于功能没有问题：旧版前端 394 项、服务 390 项全部通过，本轮新增的真实交互仍复现了下列缺陷。

## 已确认问题与修复

| 编号 | 用户可见问题 / 影响 | 复现证据 | 根因与修复路径 |
|---|---|---|---|
| F01 | 排行榜从漫剧切回系列剧不响应；默认系列剧直接点真人短剧也可能不更新 | `qa-rank-tabs.mjs --installed` 两次退出 1；选中项和 SID 不变，新增请求为空 | `Catalog.tsx` 使用 ref 存选中分类。改为独立 React state，让不改变父级 genre 的点击也触发渲染和请求 |
| F02 | 搜索在途时换号，旧账号结果迟到后显示在新账号页面 | `qa-catalog-audit.mjs --installed` 退出 1；受控 A→B 后没有 B 搜索，释放 A 后显示 A 的作品 | 搜索缓存和 effect 缺账号维度。与推荐一样将 accountKey 纳入 key，换号触发请求世代变更 |
| F03 | 在片尾快退时，被完成兜底或迟到 ended 抢占，跳到下一集 | `qa-playback-audit.mjs --installed --scenario=completion --delayed-ended`；同集定位准备被取消，释放后活动集变为第 2 集 | `PlaybackEnd` 的 ended 分支绕过 enabled；`finishEpisode` 放过同剧同集在途请求。先核对 enabled/seeking，所有在途选集/定位均优先于旧结束事件 |
| F04 | 进度条短时间重复发送相同目标，准备后画面留在旧位置 | 真实鼠标在暂停进度条末端产生相邻 seek；trace 为 prepare→ready→release，没有 commit | 多个选择共用一个准备任务，较早调用失效时取消了新调用。`SeamlessSwitcher.select` 增加调用世代，只有最新选择可提交、取消或报告错误；较早调用返回取消结果 |
| F05 | 小窗 Esc/T 只改剧场布局，窗口仍为 480×270 且置顶；退出也丢失原剧场模式 | `qa-playback-audit.mjs --installed --scenario=pip` 退出 1；原生 bounds/topmost 不恢复 | 缺少统一 PiP 生命周期。串行进入/退出 IPC，保存进入前剧场模式，Esc/T/按钮/离页/卸载恢复原生与 React 状态 |
| F06 | 父窗口越界时，小窗完全出屏；重复进入重置拖动位置，退出丢掉原置顶状态 | `qa-pip-window.mjs --installed`；2560×1400 工作区出现 x=2880,y=1630 的小窗 | 新增 `PipWindow` 管理快照，依据所在显示器工作区限制位置。重载恢复窗口；模拟 800×500 工作区补测发现 minimumSize 也需随恢复尺寸限制 |
| F07 | 清理旧缓存时，当前集读 HLS 和创建新会话被一起阻塞 | `test_media_cache_performance.py` 新增两项在旧逻辑下均超过 300ms；删除由门控暂停，活动分片已在本地 | 原 `_prune` 在全局 guard 内递归删目录。改为独立维护锁、guard 内标记 evicting、锁外删除；同集回收中返回可重试 MEDIA_BUSY，其他集继续读取 |
| F08 | 自动切集正在准备时，手动点击同一个目标集，两个选择都失效，停在旧集末尾 | `qa-playback-audit --installed --scenario=takeover`：旧集 ended/paused，手动选第 4 集未提交；另有成功准备后的 caller-specific allow 守卫单元红灯 | 与 F04 共用同一个底层缺陷。最新选择拥有共享准备任务，旧自动选择失效不能取消手动接管 |

补丁交互检查还专门覆盖了“换画质未提交时调音量”。最终实现让 `select` 自行替换不同目标，去掉 settings effect 的预先取消；不再额外增加 Player 层的同目标早返回。这样重复定位、手动接管与调音量都遵守同一底层选择世代规则。

### 长按快进补充

继续排查用户反馈后，另修复三条路径：片尾定位安全边界不一致导致高频快进反复创建会话；准备阶段的迟到回调仍能暂停已提交的解码槽；迟到 ended 未核对当前视频真实结束状态，导致末集提前停止。详细红绿证据和原现场推断边界见 [长按快进专项报告](2026-11-26_held-seek-report.md)。最终包新增 9 组长按场景、45 项断言，另与本表既有播放场景合计 12 组、70 项播放断言通过。

### 更正前轮根因说明

`SeamlessSwitcher.select()` 没有等待 `afterPresent()`；后者仅延迟旧槽释放。因此之前“180ms 提交窗口导致 requested 一直不清空”的解释没有代码依据。本轮依据真实结束事件、在途定位、最终活动集和 trace 定位 F03，不沿用旧推测。

## 验收脚本自身问题

- `qa-rank-tabs` 原来只打印 `ok:false`，仍退出 0；现失败返回非零，并同时检查选中项、SID 和真实 IPC 参数。
- 搜索换号用不同账号、关键词、SID，避免同一标题造成假通过。
- `qa-media-request-ipc` 硬编码了历史进程 PID 及“必须恰好两个进程”的断言；改为按安装目录快照实际进程并核对已有 PID。
- `qa-release-playback-smoke` 写死 1.5.7；改为读取当前源码版本或显式 `--version`，仍严格核对 EXE 产品版本。
- 小窗暂停检查原来直接调用 video.pause，随后条件写反而无法恢复；改用 K 切换真实用户意图并核对退出后仍暂停，再用 K 恢复。

## 可重跑命令

最终结果：类型检查、构建与 NSIS 打包通过；前端 406 项、服务 397 项、发布合同 21 项通过。下表合计 236 项场景断言全部通过（不是 231 个互不重叠的用户旅程）。服务及发布合同沿用本轮此前结果，长按补丁未修改这两部分。

| 验证 | 断言数 | 验证载体 |
|---|---:|---|
| 排行榜分类及请求 | 10 | 最终打包程序 |
| 搜索换号与关键词隔离 | 7 | 最终打包程序 |
| 原生小窗位置与恢复 | 8 | 最终打包程序；小工作区为受控模拟 |
| 播放竞态、小窗和扩展快捷键 | 17 | 最终打包程序 + 本地 HLS |
| 换画质期间调音量 | 4 | 最终打包程序 + 门控准备 |
| 自动切集转手动接管 | 4 | 最终打包程序 + 门控准备 |
| 长按快进、连续跨集及迟到回调 | 45 | 最终打包程序 + 本地 HLS，含两类受控竞态 |
| 分页令牌过期自动续页 | 5 | 最终打包程序；排行榜与探索片库各一条真实 IPC 链路 |
| 窗口/系统全屏、焦点和快捷键 | 60 | 最终打包程序 + 本地 HLS |
| 跨季与迟到请求 | 20 | 最终源码 + 本地 HLS |
| 隐藏、最小化、恢复 | 12 | 最终源码 + 原生窗口事件 |
| 连续切集、断续网络与慢线路 | 16 | 最终源码；9 次逐帧交接均无空画面 |
| 真实 Main/preload/Supervisor IPC | 16 | 真实通信链路 + 本地 HTTP fixture |
| 真实匿名上游播放 | 12 | 最终打包程序 + 真实内容服务/签名器/媒体 |

真实上游最终复测首帧约 4.097 秒，输出 1080×1920；第一集稳定窗口测得媒体/墙钟时间约 2.9997，第二集约 2.9995。第 1 集自然结束后进入第 2 集，后者持续解码超过 3.2 秒，零渲染/终端播放错误。没有复制正式登录态，云端进度写入为 0。

单元/合同测试在 `npm run verify`、服务测试及发布测试命令输出中计数；场景汇总在 `_work/pc-audit/test-summary.json`，对应证据位置见下文。

在仓库根目录执行；真实上游检查需要网络，本地合成 HLS 检查可独立于上游运行。

```powershell
npm run verify
python -B tools/run-service-tests.py
python -B -m unittest discover -s tools -p test_publish.py
npm run package
node tools/qa-rank-tabs.mjs --packaged
node tools/qa-catalog-audit.mjs --packaged
node tools/qa-pip-window.mjs --packaged
node tools/qa-playback-audit.mjs --packaged --delayed-ended --label=packaged-final
node tools/qa-playback-audit.mjs --packaged --scenario=quality --label=packaged-quality
node tools/qa-playback-audit.mjs --packaged --scenario=takeover --label=packaged-takeover
node tools/qa-window-fullscreen.mjs --packaged
node tools/qa-season-playback.mjs
node tools/qa-player-visibility.mjs
node tools/qa-playback-transitions.mjs
node tools/qa-media-request-ipc.mjs
node tools/qa-release-playback-smoke.mjs --exe="C:\Users\dddmiku\Desktop\codex\hongguo-desktop\release\win-unpacked\红果桌面.exe"
```

## 播放与快捷键覆盖

真实本地 HLS 检查：首次起播、1×/3× 连续切集、暂停后片尾定位、恢复后自动切集、迟到 ended、重复定位、下一季准备与取消、慢线路保留当前画面、临时网络故障恢复、短集完成、最小化/隐藏/恢复、画质切换与取消。

快捷键检查：←/→ 5 秒、Shift+←/→ 1 秒、N/J 切下一集且不闪控制栏、K/空格暂停恢复、[ / ] 对应真实 playbackRate、↑/↓ 对应真实 volume、M 对应 muted、D 对应弹幕启用状态、0/9 对应真实位置、T 窗口全屏、F 系统全屏、Esc 分层退出、? 帮助、Ctrl+K 与输入焦点隔离。鼠标进度条释放焦点、Tab 聚焦精调、按钮空格操作也单独验证。

截图：`_work/playback-audit/source-final-pip.png` 为隔离测试小窗。窗口有真实视频，控制项位置已核对在 viewport 内；它不是产品宣传截图。

## 证据位置与边界

- 基线/修复后：`_work/rank-tabs/`、`_work/catalog-isolation-audit/`、`_work/playback-audit/`、`_work/audit-pip-window/`。
- 缓存行为测试：`service/tests/test_media_cache_performance.py`、`service/tests/test_media.py`。
- 真实服务启动：`_work/backend-audit/gateway-smoke.json`，随包 Python + Java signer，0.666 秒 ready、授权健康检查 200、无凭据 401、stdin EOF 后 gateway 与自有 Java 均退出、stderr 0。
- 真实上游播放：`_work/release-playback-smoke/unpacked/result.json`；不复制账号，检查实际显示解码帧、3× 媒体时间推进、至少一次自然切集与零云端进度写入。
- 正式数据只读核对：`_work/pc-audit/profile-before.json` / `profile-after.json`，仅存键哈希、文件哈希、计数和布尔值，不记录凭据或账号原文。

本轮环境为 Windows 10；Win11 25H2/26H2、实体多显示器热插拔、不同显卡、真实短信/MFA 登录未覆盖。多屏坐标通过纯函数测试和模拟工作区的真实窗口检查，不能写成实体多屏实测。不能保证未来上游变化或所有剧集永不失败。

## 本地交付

- 最终验收包：`release/hongguo-1.5.12-fixed-setup.exe`，267725034 字节。验收时旧同名安装器被占用，因此另存修复包；发布准备时安装器已退出，已将相同字节复制为正式发行文件 `release/hongguo-1.5.12-setup.exe`，两者 SHA-256 一致。应用内更新仍使用正式文件名。
- SHA-256：`3cd1c0c3250136c3cf81c422478aaebee3b04fc9c399035112234a87880d5e27`。
- 校验文件：`release/hongguo-1.5.12-SHA256.txt`。
- 从安装包直接提取并流式校验 `resources/app.asar` 和 `resources/service/media.py`，与最终被测解包程序逐字节哈希一致。
- 打包后服务源码与工作区源码 SHA-256 一致，关键产物清单见 `_work/pc-audit/artifact-manifest.json`。
- 此报告记录修复验收完成时的快照；验收时没有覆盖安装、推送或公开发布，本机安装为 1.5.11。用户随后授权发布，公开状态以独立 PC 仓库的 `v1.5.12` Release 为准。发布操作不覆盖安装本机应用。
- 正式数据只读核对：历史 1677→1677，收藏 7，全部旧历史键和收藏仍在，设置与受保护账号/设备文件哈希一致。

旧会话曾落盘的 `_work/hg_session.b64` / `_work/hg_device.b64` 仅核对存在，没有读取或复制；本轮删除尝试被自动审批以 `blocked by policy` 拒绝，未以其它工具绕过，尚未清除。先前已输出的会话凭据应作废；正式账号文件未做注销、替换或删除。
