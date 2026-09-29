# Codex CN 扩展同步脚本：编译产物 → 运行时目录
# 用法：在 d:\codex-cn-oss 目录下运行 PowerShell: .\sync-extension.ps1

$ErrorActionPreference = 'Stop'

$srcRoot = 'd:\codex-cn-oss\extensions\codex-cn'
$dstRoot = 'D:\VSCode-win32-x64\resources\app\extensions\codex-cn'

Write-Host '=== Codex CN 扩展同步 ===' -ForegroundColor Cyan

# 1. 清理目标目录（保留 node_modules 和 media）
Write-Host '[1/6] 清理目标目录...' -ForegroundColor Yellow
Get-ChildItem $dstRoot | Where-Object { $_.Name -notin @('node_modules', 'media') } | Remove-Item -Recurse -Force

# 2. 创建目录结构
Write-Host '[2/6] 创建目录结构...' -ForegroundColor Yellow
New-Item -ItemType Directory -Path "$dstRoot\out" -Force | Out-Null
New-Item -ItemType Directory -Path "$dstRoot\dist" -Force | Out-Null

# 3. 同步编译产物（out/*.js + *.js.map）
Write-Host '[3/6] 同步编译产物...' -ForegroundColor Yellow
$jsFiles = Get-ChildItem "$srcRoot\out\*.js"
$mapFiles = Get-ChildItem "$srcRoot\out\*.js.map" -ErrorAction SilentlyContinue
Copy-Item -Path "$srcRoot\out\*.js" -Destination "$dstRoot\out" -Force
if ($mapFiles) { Copy-Item -Path "$srcRoot\out\*.js.map" -Destination "$dstRoot\out" -Force }
Write-Host "  out/: $($jsFiles.Count) js + $($mapFiles.Count) map" -ForegroundColor Green

# 4. 同步 webview 资源（dist/webview.js + webview.css）
Write-Host '[4/6] 同步 webview 资源...' -ForegroundColor Yellow
Copy-Item -Path "$srcRoot\dist\webview.js" -Destination "$dstRoot\dist" -Force
Copy-Item -Path "$srcRoot\dist\webview.css" -Destination "$dstRoot\dist" -Force
Write-Host "  dist/: webview.js ($([math]::Round((Get-Item "$dstRoot\dist\webview.js").Length/1KB))KB), webview.css ($([math]::Round((Get-Item "$dstRoot\dist\webview.css").Length/1KB))KB)" -ForegroundColor Green

# 5. 同步 vendored 资源（vendor/superpowers：内置技能 md + LICENSE）
Write-Host '[5/6] 同步 vendored 技能...' -ForegroundColor Yellow
if (Test-Path "$srcRoot\vendor") {
  Copy-Item -Path "$srcRoot\vendor" -Destination $dstRoot -Recurse -Force
  $vendorFiles = Get-ChildItem "$dstRoot\vendor" -Recurse -File
  Write-Host "  vendor/: $($vendorFiles.Count) files ($([math]::Round(($vendorFiles | Measure-Object Length -Sum).Sum/1KB))KB)" -ForegroundColor Green
} else {
  Write-Host '  vendor/ 源目录不存在，跳过' -ForegroundColor Red
}

# 6. 同步 package.json、媒体资源和规则库
Write-Host '[6/6] 同步 package.json 和媒体资源...' -ForegroundColor Yellow
Copy-Item -Path "$srcRoot\package.json" -Destination $dstRoot -Force
if (Test-Path "$srcRoot\error-patterns.json") {
  Copy-Item -Path "$srcRoot\error-patterns.json" -Destination $dstRoot -Force
  Write-Host '  error-patterns.json 已同步' -ForegroundColor Green
}
if (Test-Path "$srcRoot\media") {
  Copy-Item -Path "$srcRoot\media" -Destination $dstRoot -Recurse -Force
  Write-Host "  media/: $((Get-ChildItem "$dstRoot\media" -Recurse -File).Count) files" -ForegroundColor Green
}

# 验证关键文件
$critical = @(
  "$dstRoot\out\extension.js",
  "$dstRoot\out\runAgent.js",
  "$dstRoot\dist\webview.js",
  "$dstRoot\dist\webview.css",
  "$dstRoot\vendor\superpowers\skills\brainstorming\SKILL.md",
  "$dstRoot\vendor\superpowers\skills\using-superpowers\SKILL.md",
  "$dstRoot\package.json"
)
$missing = $critical | Where-Object { -not (Test-Path $_) }
if ($missing) {
  Write-Host "`n[ERROR] 关键文件缺失:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "`n=== 同步完成 ===" -ForegroundColor Green
Write-Host "关键文件验证通过: $($critical.Count) 个" -ForegroundColor Green
Write-Host "`n重启 Codex CN 使更改生效" -ForegroundColor Cyan
