param(
  [string]$SystemPrompt = "",
  [int]$Port = 17888,
  [string]$ChatUrl = "https://chat.deepseek.com/",
  [string]$ProfileDir = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
if (-not $ProfileDir) {
  $ProfileDir = Join-Path $ProjectRoot ".browser-profile\deepseek"
}

$LocalNodeModules = Join-Path $ProjectRoot "node_modules"
$CodexRuntimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$CodexNodeModules = Join-Path $CodexRuntimeRoot "node\node_modules"
$CodexNode = Join-Path $CodexRuntimeRoot "node\bin\node.exe"

if (Test-Path (Join-Path $LocalNodeModules "playwright")) {
  $env:NODE_PATH = $LocalNodeModules
} elseif (Test-Path (Join-Path $CodexNodeModules "playwright")) {
  $env:NODE_PATH = $CodexNodeModules
}

$NodeExe = if (Test-Path $CodexNode) { $CodexNode } else { "node" }

$env:DEEPSEEK_BRIDGE_PORT = [string]$Port
$env:DEEPSEEK_CHAT_URL = $ChatUrl
$env:DEEPSEEK_PROFILE_DIR = $ProfileDir
if ($SystemPrompt) {
  $env:DEEPSEEK_SYSTEM_PROMPT = $SystemPrompt
}

Write-Host "Starting lightchat DeepSeek bridge on http://127.0.0.1:$Port"
Write-Host "DeepSeek page: $ChatUrl"
Write-Host "Browser profile: $ProfileDir"
Write-Host "Keep this window open while lightchat uses file transcription."
Write-Host "If Playwright is missing, run: npm ci"
Write-Host ""

& $NodeExe (Join-Path $ProjectRoot "bridge\deepseek_bridge.js")
