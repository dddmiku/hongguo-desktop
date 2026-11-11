# 红果桌面国内签名与后续集播放修复

分析日期：2026-11-12。工具：现有 JADX 结果、Frida、unidbg、Capstone、FFmpeg、Electron / Playwright。

## 结果和范围

PC 原先使用番茄海外签名器调用国内手机播放入口，同一请求替换为正版手机最终签名后可获得轨道，替换为旧 PC 签名后返回空 HTTP 200。现已使用国内 SDK 的已注册分发接口生成完整安全头，并签署实际压缩字节。PC 自己的登录态、设备信息和新播放入口一并接通；真实播放器已验证原剧第 54、55、70 集的 1920×1080 解码。范围和授权见 [scope.md](scope.md)。

## Evidence

| E-id | source_ref | repro_command | content_hash |
|---|---|---|---|
| E-1 | 原版 7.4.3.32 `libmetasec_ml.so` | 本机 APK 原生库提取摘要 | SHA256 前缀 `c6831ab265a0`，4501136 字节 |
| E-2 | `_work/signature-recovery/replay-result.json` | `python -B _work/signature-recovery/replay_domestic.py` | n/a，私有内存中的同请求对照，仅记录脱敏结果 |
| E-3 | `_work/signature-recovery/pc-result.json` | `runtime/python/python.exe -B _work/signature-recovery/verify_pc.py` | n/a，三集真实下载及 FFmpeg 解码 |
| E-4 | `_work/domestic-playback-live/current/result.json` | `node tools/qa-domestic-playback-live.mjs` | n/a，原剧 54/55/70 集均 1920×1080 |
| E-5 | `_work/search-v2/current-ui/result.json` | `node tools/qa-search-v2-live.mjs` | n/a，真实建议、完整搜索及六季集数 |

测试中签名、请求体、SDK 授权元数据和账号材料仅在私有内存、受保护文件或进程通信中处理；报告记录类型、数量、状态与公开文件哈希。

## Findings

| F-id | severity | evidence_ids | confidence | location | status |
|---|---|---|---|---|---|
| F-1 | n/a_re | E-1,E-2 | 高 | 旧 `FqTrace` 与历史国内适配器 | 已修复，历史 `0x27d288` 实际为复制函数跳板，不能作为签名入口 |
| F-2 | n/a_re | E-2,E-3 | 高 | `DomesticSigner` | 已修复，初始化与 feature-hash 分发生成国内六类安全头 |
| F-3 | n/a_re | E-3,E-4 | 高 | `hongguo.py`、`desktop_account.py`、`Provider.from_runtime` | 已修复，压缩、MD5、签名字节一致，本机设备与登录态逐请求读取 |
| F-4 | n/a_re | E-4,E-5 | 高 | 搜索、播放备用地址和 HLS 会话 | 已修复并验收；本机失效会话恢复同集与用户暂停意图 |

国内环境回调 `268435470` 为 SDK 开关位，不能沿用海外版的当前时间返回值。国内 SDK client type 为 `0`；错误配置成 `1` 虽能初始化，却不能返回 feature-hash。公开元数据保留 SDK 的真实枚举设置，移除全部抓取身份字段。

## Path

P-1，path_type=callflow：PC 请求 → 自有随机端口网关 → 内容 SDK 压缩请求 → 国内签名线程 → JNI 初始化 `16777219` / `67108865` → manager `67108866` → feature-hash `33554438` → 官方 `/novel/player/multi_video_model/player/v1` → 轨道、备用 CDN、解码 → 本机 HLS → 原剧原集画面。对应 E-2～E-4 与 F-1～F-4。

## Timeline

1. 接回中断记录与尚未发布的 1.4.0 修改，保留既有搜索和播放恢复改动。
2. 确认原版 7.4.3.32，独立重现签名不兼容，核对原生库哈希和初始化 schema。
3. 纠正历史错误偏移，通过已注册 JNI feature-hash 接口生成 Argus、Gorgon、Helios、Khronos、Ladon、Medusa。
4. 同一手机请求替换为 PC 国内签名，返回三个模型，每个五条轨道，与手机签名结果一致。
5. 完整 PC 路径修复后，下载并解码第 54、55、70 集；随后通过真实渲染器 1080P 验收。
6. 补充 HLS 清空缓冲后的稳定进度记录，以超过两秒的实际位置重现并验证 503 重连。

## 验证及边界

源码阶段完整通过 311 项服务测试、169 项前端及主进程测试、21 项发布工具测试；真实 PC 三集播放和真实搜索六季核对均通过。HLS 503、过期会话与暂停意图使用受控本机网络回复，不能宣称覆盖所有公网故障。官网仍可能拒绝后续集；保持手机来源优先，不以其他集预览替代被拒集。安装、数据保留和公开资产验证以 [verification.md](../verification.md) 最终记录为准。
