# 手机弹幕协议与桌面接入记录

2026-11-07，普通 APK 协议兼容分析（flavor=null）。用户授权为 PC 接入手机端弹幕；本轮只读取弹幕，没有发布评论内容。

## 已确认的协议

样本为官方 `com.phoenix.read` 7.4.3.32 / 74332；APK SHA-256 为 `9e2dc80856f088e2f1184a13d05b0912931e5ddb54559f8a35f71131e7b3c141`。单类分析产物保存在 `D:\hongguo-danmaku`，没有修改 APK。以下实现依据来自 `DanmakuRequestHelper`、`UgcCommentSourceEnum`、`UgcCommentChannelEnum`、`UgcCommentGroupTypeOutter` 和 KMP 业务参数序列化模型。

弹幕使用 `POST /novel/commentapi/comment/list/{vid}/v1/`，与普通评论列表同属评论服务，但业务字段不同：

| 字段 | 手机弹幕 |
|---|---|
| comment_source | 601 |
| server_channel | 1000 |
| group_id | 当前集的 video ID |
| group_type | 30（SeriesVideo） |
| comment_type | 20（Danmaku） |
| sort / count | 1 / 90 |
| business_param.book_id | 整部剧的 series ID |
| business_param.start_offset_time | 当前时间段起点，毫秒 |
| business_param.playlet_item_duration | 完整单集时长，毫秒；未知则为 0 |

响应为 `data.data_list`，每条普通弹幕从 `comment.common.content.text` 取文本，从 `comment.expand.offset_time` 取播放位置。`create_timestamp` 是发布时间，不能作为弹幕播放时间。`common_list_info.cursor` 包含时间窗口，`extra.next_query_danmaku_list_time` 是下一段起点。

## Evidence → Finding → Path

| 实际证据 | 结论 | 实现位置 |
|---|---|---|
| 官方枚举和请求构造字段为 601 / 1000 / 20 | 必须读取真正的弹幕业务，不能拿普通评论模拟 | `service/danmaku.py` |
| 真实首段返回 16 条，首条 offset_time=2925 | 界面按 2.925 秒出现，而非按请求时间滚动 | `src/danmaku/engine.ts` |
| 下一段返回起点 30000、终点 60000 与 18 条真实记录 | 读取按时间段推进，拖动跳到目标窗口 | `src/danmaku/feed.ts` |
| 真实视频暂停后 canvas 像素保持不变 | 暂停与缓冲时冻结，静止时不重复绘制 | `src/components/Danmaku.tsx` |
| 快速连续改字号和区域曾覆盖前一项修改 | 本机保存的待确认设置作为后续修改依据 | `src/components/Player.tsx` |

只向渲染进程返回弹幕 ID、普通文本和播放时间，丢弃用户身份、头像、请求跟踪与运营引导卡。文本通过 Canvas 绘制，不作为 HTML 执行。轨道按实测文字宽度和间隔分配；同轨速度一致，显示数量与缓存有上限。

## 验证范围

协议读取和 PC 真实解码播放分别验收。纯合同测试覆盖错误响应、普通评论、删除记录、无时间点记录、错集、账号变化、缓存刷新与去重；显示测试覆盖暂停、缓冲、倍速、拖动、限量和轨道间隔。真实 Electron 验收读取上游记录并检查文字像素、时间点、开关、显示设置和真全屏。

临时手机观察仅用于辅助定位，最终交付不依赖 Frida、模拟器或手机常驻。观察服务器及端口转发已撤销，没有清空或改写手机数据库。没有把不完整的运行时观察算作手机 UI 一一比对通过。

## 手机表情资源

官方 APK 的 `assets/emoji_config.json` 是配置版本 5、53 个标记。当前手机版下载的 Gecko `emoji` 资源集 `7699076530881740809` 使用配置版本 7，扩展到 60 个标记。`com.dragon.kmp.community.emoji.g0` 从 `data.json.datas` 读取名称，拼接 `images/emoji_dr_{id}.png`；`uy2.b` 将已知标记替换为宽度约为字号 1.4 倍的内嵌图片。

只读提取该资源集的配置和 60 张 PNG，共 353583 字节，逐文件摘要保存在 `src/danmaku/emoji-images/source.json`。未读取账号私有数据。PC 将真实图片与普通文字作为同一个测宽/绘制序列，不会把 `[送花]`、`[鼓掌]`、`[爽]` 绘成文字；未知标记仍保留原文。长文字按字素与表情单元截断，避免切断标记和复合 Unicode 表情。真实安装版验收同时检查图片绘制调用、实际像素、未出现文字标记、暂停冻结及全屏尺寸。
