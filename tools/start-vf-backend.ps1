# ============================================================================
# tools/start-vf-backend.ps1 —— 只起 VideoForge **后端**，不开 GUI 窗口
#
# ★ 为什么不用 VideoForgeService.exe：
#   它是 GUI 壳（日志："Opening pywebview window"），
#   **窗口一关整个服务就退出**（日志末行："窗口已关闭，退出"）。
#   而 openVideoForge 只需要后端的 `/api/studio/*`（Blender 渲染）。
#
# ★ 怎么做：
#   直接跑打包好的 `_internal\backend\main.py`（它的 __main__ 就是纯 uvicorn），
#   用系统 Python，sys.path 指到打包的依赖目录。
#   端口由 VIDEOFORGE_PORT 固定（8765/8798），Blender 由 VIDEOFORGE_BLENDER 指定。
#
# ★ 路径全部走环境变量 / 标准目录（2026-11-16 开源时整理）：
#   VIDEOFORGE_SIDECAR_DIR  sidecar 目录（含 _internal）
#   VIDEOFORGE_PYTHON       Python 可执行文件
#   VIDEOFORGE_BLENDER      Blender 可执行文件
# ============================================================================
param(
  [int]$Port = 8798
)

$HomeDir = $env:USERPROFILE
if (-not $HomeDir) { $HomeDir = $HOME }

# ── sidecar 目录：环境变量优先，否则按**同级目录**推导
$sd = $env:VIDEOFORGE_SIDECAR_DIR
if (-not $sd) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $candidates = @(
    (Join-Path $repoRoot "..\VideoForge-dsh\deepseek-harness-master\apps\desktop\resources\videoforge-sidecar"),
    (Join-Path $repoRoot "..\VideoForge-dsh\deepseek-harness-master\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\win-unpacked\resources\videoforge-sidecar")
  )
  foreach ($c in $candidates) {
    if ((Test-Path (Join-Path $c "_internal\backend\main.py"))) { $sd = $c; break }
  }
}
if (-not $sd) { Write-Host "✗ 找不到 sidecar 目录（用 VIDEOFORGE_SIDECAR_DIR 指定，或把 VideoForge 仓库放在同级目录）"; exit 1 }

# ── Python：环境变量优先，否则在 PATH 里找
$py = $env:VIDEOFORGE_PYTHON
if (-not $py) {
  foreach ($c in @("python", "python3", "py")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
  }
}
if (-not $py) { Write-Host "✗ 找不到 Python（可用 VIDEOFORGE_PYTHON 指定）"; exit 1 }

$backend = Join-Path $sd "_internal\backend"
if (-not (Test-Path $backend)) { Write-Host "✗ 找不到后端目录: $backend"; exit 1 }

$env:VIDEOFORGE_HOST  = "127.0.0.1"
$env:VIDEOFORGE_PORT  = "$Port"
if ($env:VIDEOFORGE_BLENDER) { $env:VIDEOFORGE_BLENDER = $env:VIDEOFORGE_BLENDER }
$env:PYTHONPATH = "$backend;$sd\_internal"
$env:PYTHONIOENCODING = "utf-8"

Write-Host "VideoForge 后端（无窗口）"
Write-Host "  端口: $Port"
Write-Host "  sidecar: $sd"
if ($env:VIDEOFORGE_BLENDER) { Write-Host "  Blender: $($env:VIDEOFORGE_BLENDER)" }

# 用 -c 先设 sys.path 再跑（PYTHONPATH 里分号在某些上下文不稳，双保险）
& $py -c @"
import sys, os
sys.path.insert(0, r'$backend')
sys.path.insert(0, r'$sd\_internal')
sys.argv = ['main.py']
exec(open(r'$backend\main.py', encoding='utf-8').read(), {'__name__': '__main__', '__file__': r'$backend\main.py'})
"@
