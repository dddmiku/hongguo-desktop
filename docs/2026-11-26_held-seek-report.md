# 长按快进跨集暂停：复现与修复

日期：2026-11-26。基线为正式安装的 1.5.11，以及此前尚未安装的 1.5.12 候选包；修复并入同一未发布的 1.5.12。

## 现场证据与结论边界

只读正式诊断的闭合白名单字段，发现 01:14:32 自动提交第 151 集，33 秒发生 seek，35 秒同一解码任务暂停且有 27.66 秒缓冲；36 秒 manual-play 后同一任务恢复。期间没有手动暂停、窗口隐藏、终端错误或重新连接记录。只读历史库确认当次 151 集也是全剧末集。该记录能确认症状，但未记录各个播放意图守卫和原生事件队列，不能单独证明唯一原因。

普通长按场景中，1.5.11 在部分 100/200ms 按键间隔下正常跨集；未宣称自然操作每次都会复现原现场。通过真实 Electron、真实 HLS、合成片单和隔离档案建立以下稳定回归。

## 已确认的三处问题

1. **片尾重复定位饿死收尾。** `seekTo` 钳到 `duration - .05`，而可定位范围排除了最后 `.1` 秒，导致完整缓存仍被当成需要重建。35ms 连续 repeat 时，旧候选持续留在第一集准备，松键才跨集。现在统一安全边界，已经到达尾部的重复快进不再重新定位、重置完成计时或创建会话。并不声称此数值覆盖所有容器与元数据时长差。
2. **准备回调越过生命周期暂停活动视频。** 首帧准备完成或解码槽复用后，迟到的 `play()` 拒绝、rVFC 或 rAF 回调仍可调用 `pause()`。三个单元回归在修复前均红；真实播放器受控延迟 AbortError 后，新集在松键 400ms 时仍暂停，约 1.5 秒才被恢复机制拉起。现在这些回调必须仍属于未完成、未取消且拥有该槽的准备任务，才可暂停视频。
3. **迟到结束事件误结束当前集。** 旧 `onEnded` 只核对固定 DOM 槽号，没有核对新媒体的真实 `ended/seeking`。回放迟到事件时，末集播放到约 15 秒、实际 `ended=false`，仍被判为整季结束，1500ms 后完全没有新帧，必须重新播放。现在仅在当前视频真实结束且不在定位时处理结束事件。这个回归是受控事件时序回放，不能当作已捕获原现场的原生事件队列。

## 验证方式

`tools/qa-playback-audit.mjs --scenario=held-seek` 连续调用 Playwright `keyboard.down`，保持真实 repeat 状态跨过提交边界，再 `keyup`。记录两槽媒体事件、暂停/播放调用、活动集、请求和真实 rVFC 帧，松键后检查暂停状态、时间推进和帧推进，不能只靠集号或画面尺寸判通过。

最终包 9 组长按场景、45 项断言全部通过；连同原完整播放、画质与手动接管场景合计 12 组、70 项断言。覆盖 1×/3×、35ms 高频输入、已预热/延迟准备、末集、连续跨两集、手动暂停、迟到准备回调及迟到结束事件。所有内容和账号数据为合成值；实际播放器、主进程与 preload 保持真实。测试实例静音且隐藏，未复用正式账号或档案。

核心复跑命令：

```powershell
npm run verify
node tools/qa-playback-audit.mjs --packaged --scenario=held-seek --held-rate=3 --held-cadence=35 --label=held-final-3-ready
node tools/qa-playback-audit.mjs --packaged --scenario=held-seek --held-rate=3 --held-cadence=100 --held-late-abort --label=held-final-late-abort
node tools/qa-playback-audit.mjs --packaged --scenario=held-seek --held-rate=3 --held-cadence=100 --held-last --held-stale-ended --label=held-final-stale-ended
node tools/qa-playback-audit.mjs --packaged --scenario=held-seek --held-rate=3 --held-cadence=35 --held-crossings=2 --label=held-final-two-crossings
```

旧版红灯证据：`_work/playback-audit/held-packaged-3-ready-held-seek.json`、`held-packaged-late-abort.json`、`held-packaged-stale-ended.json`。最终结果及产物校验由 `_work/pc-audit/test-summary.json` 与 `artifact-manifest.json` 汇总。

## 数据与交付

最终验收包为 `release/hongguo-1.5.12-fixed-setup.exe`，SHA-256 为 `ca6e294c1c5344281d9e310bc05963308b17f1a8c2d992a134f2ceab44485b27`。验收时旧同名安装器被占用，因此改用单独文件名。发布准备时安装器已退出，已将相同字节复制为正式文件 `release/hongguo-1.5.12-setup.exe`，版本仍是 1.5.12，两者摘要一致。已从新 EXE 中直接校验应用与媒体服务内容，确认与被测程序一致。

使用原应用标识和数据目录，安装包保留覆盖安装配置；本轮没有覆盖安装，也没有修改正式历史、收藏、账号或设置。正式数据只读核对记录在 `profile-before.json` / `profile-after.json`。仅核对保留原有历史键、收藏键、设置与受保护文件哈希，不能把此检查夸大为每一条播放进度字段的完整比对。

新增的生命周期和片尾事件回归已进入本地验收脚本。后续再现异常时，应继续按原始诊断区分用户主动暂停、播放任务切换和真实媒体结束，不能一律强制自动播放，否则会破坏手动暂停。
