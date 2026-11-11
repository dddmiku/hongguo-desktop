# 国内签名组件

`src/com/hongguo/sign/DomesticSigner.java` 是独立的 Windows JVM / unidbg 适配器。它在专用线程调用国内 SDK 已注册的 JNI 分发接口；不使用原生函数地址猜测，不连接模拟器，也不保存手机账户状态。

运行时包含 `sign/domestic-sign.jar`、经过校验的 unidbg 依赖包，以及 `capture/domestic/` 的原生库和公开 SDK 元数据。元数据移除了所有抓取设备、安装、会话及 fetched-device 字段；首次签名使用 PC 请求里的本机设备和安装标识完成初始化。

构建需 JDK 与已校验的本项目运行时：

```powershell
python tools/build-domestic-signer.py
```

账号和内容请求传递实际发送的字节，压缩发生在签名前。Java 服务只绑定随机本机端口，签名串通过私有 HTTP 返回调用方；控制台只有就绪端口，错误回复使用固定消息。解包临时文件和状态均放在本客户端数据目录，父进程退出时由 `OwnedSigner` 回收。

来源：`MetasecSign` 的 unidbg 环境适配原始实现来自此前维护工程，依据 fqnovel-unidbg 的 JNI 环境处理改编。国内 SDK 二进制取自本机正版 7.4.3.32；详细哈希、分发接口和实际请求对照见 [签名修复报告](../../docs/signature-repair/report.md)。
