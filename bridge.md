# DeepSeek 网页转写桥接

在使用 OpenAI 兼容提供商时，桥接可通过本地浏览器打开 DeepSeek 网页端，把附件转写为 Markdown，再交给 LightChat。使用 DeepSeek 官方 API 的用户可直接在 LightChat 中上传文件。

## 安装并启动

先安装 Node.js，然后在项目根目录运行：

```powershell
npm ci
npm run install-browsers
```

双击根目录的 `start_bridge.cmd`，或在 PowerShell 中运行：

```powershell
.\scripts\start_bridge.ps1
```

桥接会打开 DeepSeek 网页端。如果页面要求登录，请在打开的浏览器里登录。登录态默认保存在项目的 `.browser-profile/deepseek` 下。

## 在 LightChat 中启用

1. 在提供商设置里将「文件处理」设为「DeepSeek 网页转写桥接」。
2. 保持默认地址 `http://127.0.0.1:17888/transcribe`，然后点「测试」。
3. 如果填了系统提示词，测试时会同步到 DeepSeek 网页端。每次转写请求也会带上该提示词。

可以在启动时传入提示词：

```powershell
.\scripts\start_bridge.ps1 -SystemPrompt "请将附件转写为 Markdown，保留表格、公式和标题层级。"
```

遇到登录、验证码或上传控件变更时，请在桥接打开的浏览器中处理后重试。
