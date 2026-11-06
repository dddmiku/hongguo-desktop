# 协议适配来源

这些文件从本机已维护的红果协议 SDK 提取，仅复用 HTTP 字段、数据解析与文件解密算法。新客户端的 API、播放器、缓存、进程生命周期和账号同步策略由新工程独立实现。

- hongguo.py、safeguards.py：hongguo-desktop-maintain/src/backend 的内容协议叶模块。
- desktop_account.py：hongguo-desktop-maintain/patches/account 的验证码、MFA 与账号协议字段。
- unwrap_spade.py、mp4_samples.py、decrypt.py：已安装后端 frida/ 目录的纯文件算法；已删除命令行入口、内存采集、真值密钥样例与打印。

已移除旧应用服务入口、设备旋转、模拟器账号回退、旧 APPDATA 搜索、退出账号备份、后台历史守护与自动历史推送。未复制任何用户账号、Cookie、Token、抓包或内容密钥。

`device-bundled.json` 来自原维护分支已经发布的匿名设备档案，仅保留设备注册 ID、机型与版本字段。它不含任何登录态或账号凭据。新客户端的用户登录态和 MFA 上下文均由 `provider.SessionVault` 覆盖 SDK 读写接口后使用 Windows DPAPI 加密保存。
