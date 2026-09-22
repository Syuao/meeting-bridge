# Meeting Bridge 0.6.2 · Mac 安装包

支持 Apple Silicon（M1/M2/M3/M4 等）Mac，macOS 13+，Google Chrome。Intel Mac 请使用仓库中的源码安装方式。

包内自带 Node.js、本机桥接依赖和已编译的声音采集程序；不需要安装 Node、npm、Python 或 Xcode。不包含 API 密钥和离线 Whisper 模型。公开 Release 免费下载，云转写和翻译由服务商另行计费。

## 安装

1. 解压整个 ZIP。更新前先在侧栏点击「停止」。
2. 双击 `Install.command`，在终端窗口按回车安装。安装只写入当前用户目录，无需管理员密码，不自动开启录音。
3. Chrome 地址栏输入 `chrome://extensions`，开启右上角「开发者模式」，点击「加载已解压的扩展程序」。
4. 在文件选择器按 `⇧⌘G`，粘贴 `~/Library/Application Support/MeetingBridge/extension`，选择该文件夹。请勿选择下载包中的临时目录。
5. 固定 Meeting Bridge 到工具栏，打开 ChatGPT、DeepSeek、千问或 Qwen 网页对话，在侧栏中绑定。
6. 在设置中填入自己的阿里云百炼 API 密钥，选择对应地域，测试连接。来源选择「系统声音→阿里云实时转写」，问题提取选「手动选句」。
7. 点击「开始监听」，按 macOS 提示授权系统声音录制。划选英文后会复制并追加草稿；由你发送。Qwen-MT 中文翻译共用百炼密钥，DeepSeek 为可选服务。

本机采集程序使用临时签名，安装包尚未获得 Apple Developer ID 签名或公证。macOS 可能阻止首次打开；请先确认下载来自项目的 GitHub Release，并根据系统提示决定是否允许。如果不希望允许未公证程序，可选择从源码构建。不要关闭系统整体安全保护。

## 更新与卸载

下载新包，停止监听，再运行安装脚本；回到 `chrome://extensions` 点击扩展卡片的「重新加载」。如之前从源码目录加载扩展，请继续更新原目录，或先导出历史，再改为加载上述固定目录。移除 Chrome 扩展会删除其本地历史。

安装器保留 API 配置与可选模型；采集程序内容相同则保留其签名及文件身份。首次从其他构建版本更新时仍可能需要重新授权。

卸载：先停止监听、导出需要保留的转写，然后在 Chrome 移除扩展；再删除以下本机文件（删除前可备份密钥）：

- `~/Library/Application Support/MeetingBridge`
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.meetingbridge.json`

## 数据与使用范围

云转写将系统输出音频发送给阿里云；开启翻译时，原文发送到选择的阿里云或 DeepSeek 服务。历史保存在 Chrome 本机，API 密钥保存在本机受限文件。安装包不包含作者的密钥、录音或历史。只采集系统输出，不采集麦克风；关闭侧栏不等于停止监听。请取得所需的会议参与者同意。

此包默认使用云转写；界面中的本地 Whisper 选项需要另外构建引擎和下载模型，详见仓库 README。网页结构变化可能影响草稿填入；请核对转写、翻译与目标草稿。

项目和反馈：https://github.com/Syuao/meeting-bridge

## English

Prebuilt preview for Apple Silicon Macs, macOS 13+, and Google Chrome. Unzip, run `Install.command`, then load `~/Library/Application Support/MeetingBridge/extension` via Chrome's developer mode. Node.js is bundled. Bring your own Alibaba Cloud API key; cloud usage is billed separately. The capture helper is ad-hoc signed and not Apple-notarized. Updates are manual. MIT license; third-party notices are included.
