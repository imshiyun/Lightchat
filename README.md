# LightChat

lightchat 是一个本地单页 AI 对话工具，支持多对话、多模型提供商、流式输出、Markdown、公式、表格和 Mermaid。使用 DeepSeek 官方 Flash 接口时，还可以联网搜索、阅读链接、识别图片和上传文档。

## 项目结构

```text
lightchat/
  lightchat.html              # 浏览器入口
  lightchat.cmd               # Windows 启动入口
  start_bridge.cmd            # 可选的 DeepSeek 网页转写桥接启动入口
  scripts/
    attachment_media.js       # 本地图片及缩略图
    chat_storage.js           # IndexedDB 存储
    context_memory.js         # 长对话摘要
    deepseek_api.js           # DeepSeek 官方 API
    deepseek_history.js       # DeepSeek ZIP 导入
    start_bridge.ps1          # 桥接服务的 PowerShell 启动脚本
  bridge/
    deepseek_bridge.js        # Playwright 桥接服务
  docs/
    bridge.md                 # 桥接安装与配置
  package.json                # 桥接依赖与命令
  package-lock.json           # npm 依赖锁定
```

## 基础使用

双击 `lightchat.cmd`，或直接用浏览器打开 `lightchat.html`。

模型配置、会话和图片保存在当前浏览器的 IndexedDB，外观设置保存在 `localStorage`。首次打开新版会迁移旧版对话和模型配置。发送消息时，所用的对话上下文和附件会交给当前提供商。

点击侧栏「外观设置」可修改显示名称和头像。空白对话按本地时间显示问候，头像显示在自己的消息旁。这两项只用于界面显示，不会加入发给模型的请求。

点击聊天页左上角的按钮可收起或展开侧栏，桌面端会记住设置。手机端可点击遮罩或侧栏右上角关闭。删除某条对话时，点击该对话右侧的「×」并确认。

## 使用 DeepSeek 官方 API

1. 打开右上角设置，点击「DeepSeek 官方」，填入 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key 并保存。预设地址为 `https://api.deepseek.com`，模型为 `deepseek-flash`。
2. 输入框上方打开「联网搜索」后，模型可按需搜索网页和读取链接。再打开「深度思考」可进行多步检索。要展开思考过程，可同时打开「显示思考」。有检索结果时，可在回复下展开「网页来源」。
3. 点击「＋」、粘贴图片或拖入文件。发送后，JPEG、PNG、GIF 和 WebP 走视觉识别。PDF、Word 和 PowerPoint 使用富布局解析，保留可识别的图表。Excel、纯文本和支持的电子书也可上传。BMP 和 TIFF 以文档方式解析。

上传成功后，会话会保存文件 ID，刷新页面后仍可用原提供商追问。官方附件在上传 30 天后到期，届时需重新添加。上传失败时，输入和待发送附件会保留，同一次发送中已经上传成功的附件可在重试时复用。按「停止」会结束本地等待，DeepSeek 可能继续完成已提交文档的解析。在本地清空会话不会从 API 账户删除文件。

旧的官方 `deepseek-chat` 和 `deepseek-reasoner` 配置会切换为 `deepseek-flash`，并使用各自对应的思考模式。其他提供商仍可沿用原有兼容接口。官方功能的计费和文件限制见 [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[联网工具](https://api-docs.deepseek.com/guides/web_tools/) 和 [文件 API](https://api-docs.deepseek.com/guides/files_api/)。

## 导入历史和查看图片

- 点击侧栏「⇪」，选择 DeepSeek 网页端的 `deepseek_data-*.zip`（格式第 3 版）或 LightChat 的 JSON 备份。ZIP 保留导出时选中的消息分支。两种格式都会追加新对话，并跳过已存在的会话编号或内容完全相同的副本。遇到同一编号的会话时，以浏览器里已有的版本为准。
- 导入 JSON 时会补充缺少的模型配置。已有模型配置和外观优先保留。站点上还没有保存外观时，可从备份恢复外观。
- 选择、粘贴或拖入受支持的图片后，输入框上方显示缩略图。发出的消息里也会显示缩略图，点击可以查看原图。导出包内的原图同样可以查看。普通文档和缺少原件的图片会保留文件名、大小等附件信息。
- 原图与缩略图保存在当前浏览器的 IndexedDB。刷新页面后可继续查看。导入 ZIP 时，附件不会被上传到 DeepSeek。用官方 Flash 接着提问时，会按需上传导入历史里有原件且受官方视觉接口支持的图片。LightChat JSON 备份只保留本地图片引用。
- 导入支持单卷 ZIP32 的 STORE 和 DEFLATE 压缩。对话逐条写入 IndexedDB，整包校验成功后才加入列表。若失败，已有会话会保留。可导入的总量取决于浏览器给这个站点分配的空间。
- 初次打开会话时显示最近 40 条消息，点「查看更早的消息」可继续加载。公式和图表按需加载，流式回复结束后再排版 Markdown。

## 长对话

在输入框上方打开「压缩上下文」，为当前对话启用较早消息的滚动摘要。历史文本估算达到约 24,000 tokens 并且有可归纳的旧消息时，下一次发送会额外调用当前模型，把较早的消息归纳为摘要，把摘要和近期原文用于回复。摘要调用按提供商规则计费。完整历史仍保存在本地，关掉开关后会恢复发送原历史。特别长的旧内容会先节选，附件原件也不随摘要重复发送，重要细节可从历史中查看或重新提供给模型。

## 可选桥接

使用 OpenAI 兼容提供商时，可以通过桥接把 DeepSeek 网页端转写的附件交给该提供商。安装和启动方式见[桥接使用说明](docs/bridge.md)。

## 静态部署

用静态 Web 服务器部署时，发布 `lightchat.html`（可改名为 `index.html`）和它引用的脚本。保留 `scripts/` 路径。

## 本机数据

Git 会忽略桥接浏览器的登录目录、依赖、日志和默认命名的聊天备份。LightChat JSON 备份会包含对话和提供商配置，其中可能存有 API Key。分享项目时请使用 Git 跟踪的源码文件。
