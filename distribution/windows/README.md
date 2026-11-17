# Meeting Bridge · Windows + Edge

这是 Meeting Bridge 的 Windows x64 / Microsoft Edge 适配包。扩展界面、ChatGPT/DeepSeek/千问草稿填入、ShareCode 同步和云端转写协议与 Mac 版共用。

## 前置依赖

- Windows 10/11 x64
- Microsoft Edge（建议当前稳定版）
- Node.js 22+：`winget install OpenJS.NodeJS.LTS`
- FFmpeg（必须包含 WASAPI 输入）：`winget install Gyan.FFmpeg.Shared`

## 安装

1. 解压整个目录。
2. 右键 `install.ps1`，选择“使用 PowerShell 运行”，或在 PowerShell 执行：

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1
   ```

3. 打开 `edge://extensions`，开启“开发人员模式”，点击“加载解压缩的扩展”，选择：
   `%LOCALAPPDATA%\MeetingBridge\extension`
4. 打开 ChatGPT、DeepSeek 或千问，打开侧栏并绑定当前对话。
5. 在设置中选择云端转写服务并填入自己的 API Key。

## Windows 采集范围

Windows 版通过 FFmpeg WASAPI loopback 读取**默认系统输出设备的混合声音**，适合腾讯会议、视频播放和系统提示音一起转写。当前版本不按应用区分腾讯会议和其他程序，也不支持 Windows 本地 Whisper 路径；请使用阿里云或豆包云端实时转写。

每 200ms 发送一包 16kHz、16-bit、单声道 PCM。结束监听时会等待服务端尾部结果再关闭连接。浏览器扩展只负责界面和草稿，API Key 保存在本机桥接目录，不写入扩展源码。

## 卸载

先停止监听，在 `edge://extensions` 移除扩展，然后删除 `%LOCALAPPDATA%\MeetingBridge`。如需移除 Edge 原生消息注册，可执行：

```powershell
Remove-Item 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\local.meetingbridge' -Recurse -Force
```

本包无法在 macOS 上进行 WASAPI 实机验证；发布前应在目标 Windows 电脑上测试默认输出设备、Edge 原生消息连接和实际会议音频。

安装脚本会优先编译一个真正的 `launch-host.exe` 作为 Edge 原生消息宿主；如果当前 PowerShell 无法编译，则会回退到 `.cmd` 启动器。企业策略若启用了 `NativeHostsExecutablesLaunchDirectly`，请使用 Windows PowerShell 5.1 或安装 .NET 后重新运行安装脚本，确保生成 `.exe`。
