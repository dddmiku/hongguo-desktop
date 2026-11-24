# 左右方向键定位与控制栏验收

## 1.5.10 快进片尾自动切集修复

2026-11-25 用户反馈：快进到片尾后偶发不自动切下一集，需要快退一步才恢复。根因是自动切集提交后的短暂提交窗口内到达的 ended 事件被丢弃，且 PlaybackEnd 恢复判定要求播放态，元素 ended 后必然暂停，两者叠加导致完成判定永远不成立。

修复：finishEpisode 允许本集切换中的完成通过提交窗口；PlaybackEnd 对已封口且已 ended 的片尾不再要求播放态，拖动定位中（seeking）仍不触发。

验证：npx vitest run 394 项通过（含 PlaybackEnd ended-paused 与 seeking 保护新回归）；python tools/run-service-tests.py 385 项通过；npx tsc --noEmit 通过；真实打包版与安装版 tools/qa-tail-autoswitch.mjs 通过（快进到片尾后无需人工干预切到第 2 集）；安装版 qa-window-fullscreen --focus-only 6 项通过；1.5.10 覆盖安装后账号、设备字节、历史 1659、收藏 7、设置全部保留，安装文件与包内哈希一致。

## 1.5.9 鼠标残留焦点补充

2026-11-25 在原安装版 1.5.8 复现：鼠标点击进度条后输入框保留焦点，接着按右方向键只移动 0.1 秒，并命中 `:focus-visible` 的 2px 白色轮廓。

进度条现在在 pointerup/pointercancel 时释放焦点，不影响拖动过程。键盘主动聚焦仍保留原生微调；进度条焦点改为拇指光晕，按钮、音量及其它控件的键盘行为不变。

专项反馈命令：`node tools/qa-window-fullscreen.mjs --focus-only`。它核对真实视频定位、鼠标点击后 5 秒快进、Shift 1 秒快进、拖动后快进、键盘精调和音量滑块，不以自然播放推进或简单 DOM 变化判定成功。

验证日期：2026-11-19；应用版本：1.4.7；Windows 10 x64。

## 原因与修复

左右方向键原先会在定位函数和键盘处理末尾显示控制栏；定位引发的 `playing` 事件、重新准备解码器后的 `present` 也会再次显示控制栏。

键盘相对定位现在传入 `revealControls=false` 并提前结束快捷键处理。该选择会传递到异步解码器准备和提交阶段；恢复播放事件仅安排自动收起控制栏。内部准备产生的暂停事件不会误唤起控制栏，手动暂停仍正常显示。鼠标拖动、换画质和手动切集继续沿用原交互。

## 验证结果

- 原安装版 1.4.6：`node tools/qa-window-fullscreen.mjs --installed` 在“右键快进五秒时底部控制栏未弹出”处失败，复现原问题。原结果保存在 `_work/window-fullscreen/baseline-result.json`。
- `npm test`：194 项测试通过；`npm run build` 与类型检查通过。
- `node tools/qa-window-fullscreen.mjs`：源码构建的 32 项交互检查通过。
- `node tools/qa-window-fullscreen.mjs --packaged`：打包程序 32 项通过。
- `node tools/qa-window-fullscreen.mjs --installed`：覆盖安装后的程序 32 项通过，零渲染异常。
- `node tools/qa-season-playback.mjs`：20 项通过，覆盖自然结束、跨季、暂停、账号隔离与迟到回复。
- `python tools/bootstrap-runtime.py --check`：固定运行时清单校验通过。
- `npm run package`：成功生成 Windows x64 NSIS 安装包。

播放器检查使用真实 Electron、原 Player 组件和本地 HLS 媒体，隔离档案不操作真实收藏或云端进度。覆盖普通模式、窗口全屏、系统全屏，左右五秒定位、重复按键、不可直接定位时切换解码器、暂停定位、原生滑块微调和鼠标定位。按键断言要求实际发生 `seeking/seeked` 且位置对应目标，不能以自然播放推进替代定位成功；控制栏观察保留旧 class 值，以捕获显示后立即隐藏的闪现。截图已检视，结果和截图位于 `_work/window-fullscreen/`。

## 本机覆盖安装

`node tools/qa-install-upgrade.mjs` 的 9 项检查通过：安装返回 0，服务版本为 1.4.7，Windows 产品版本为 1.4.7.0。安装后的 `app.asar` 与打包目录 SHA-256 一致。升级前后登录身份、历史和收藏数量、播放偏好核对一致，已有待同步进度保留重试。结果位于 `_work/install-upgrade-qa/result.json`。

安装包：`release/hongguo-1.4.7-setup.exe`，248378088 字节；覆盖安装，无需卸载旧版。

SHA-256：`443fbf51519bcbeffb51353d3a274b97fea4614db480de0033198a1068e6e32f`。
