# ============================================================================
# tools/start-ovf-full.ps1 —— openVideoForge **完整启动**（页面 + 桥 + Blender 后端）
#
# ★ 为什么多这一步：
#   VideoForgeService.exe 是 GUI 壳，窗口一关服务就退出，
#   而 openVideoForge 只需要后端的 /api/studio/*（白膜渲染）。
#   ⇒ 这里直接跑打包好的 _internal\backend\main.py（纯 uvicorn，无窗口），
#     端口固定 VIDEOFORGE_PORT（默认 8798），Blender 由 VIDEOFORGE_BLENDER 指定。
#
# ★ 路径全部走环境变量 / 标准目录（2026-11-16 开源时整理）：
#   以前这里写死了开发机的盘符路径，别人跑不起来。覆盖方式：
#     VIDEOFORGE_BLENDER     Blender 可执行文件
#     VIDEOFORGE_PYTHON      Python 可执行文件
#     VIDEOFORGE_DATA_DIR    VideoForge 业务数据目录
#     VIDEOFORGE_SIDECAR_DIR sidecar 目录（含 _internal）
#     OVF_OUT_DIR            产物目录
#     OVF_LOG_DIR            日志目录
#
# 用法：powershell -File tools/start-ovf-full.ps1 [-Port 8798] [-NoBlender]
# ============================================================================
param(
  [int]$Port = 8798,
  [switch]$NoBlender
)

$ErrorActionPreference = 'Continue'
$HomeDir = $env:USERPROFILE
if (-not $HomeDir) { $HomeDir = $HOME }

# ── 0. 日志目录（默认临时目录，不再写死开发机路径）
$LogDir = if ($env:OVF_LOG_DIR) { $env:OVF_LOG_DIR } else { Join-Path $env:TEMP "ovf-logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ── 1. Blender（可选，但有它才能出白膜 MP4）
$blender = $env:VIDEOFORGE_BLENDER
if (-not $blender) {
  # 常见安装位置里按版本目录扫
  foreach ($base in @(
    "C:\Program Files\Blender Foundation",
    "C:\Program Files (x86)\Blender Foundation"
  )) {
    if (-not $blender) {
      foreach ($d in Get-ChildItem $base -Directory -ErrorAction SilentlyContinue) {
        if ($d.Name -like "blender*") {
          $p = Join-Path $d.FullName "blender.exe"
          if (Test-Path $p) { $blender = $p; break }
        }
      }
    }
  }
  # PATH 里找 blender
  if (-not $blender) {
    $cmd = Get-Command blender -ErrorAction SilentlyContinue
    if ($cmd) { $blender = $cmd.Source }
  }
}
if ($blender -and -not $NoBlender) { $env:VIDEOFORGE_BLENDER = $blender }

# ── 2. Python
$py = $env:VIDEOFORGE_PYTHON
if (-not $py) {
  foreach ($c in @("python", "python3", "py")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
  }
}
if (-not $py) { Write-Host "[OVF] 找不到 Python（可用 VIDEOFORGE_PYTHON 指定），跳过 Blender 后端"; $py = $null }

# ★ 数据目录**显式指死**。
#   后端的 resolve_data_root() 顺序是：
#     VIDEOFORGE_DATA_DIR → %LOCALAPPDATA%\VideoForge\data（要有 db）→ <cwd>\data
#   不显式指定的话会回退到 <cwd>\data —— 数据跟着工作目录跑，随手就跑到别处去了。
$VfData = if ($env:VIDEOFORGE_DATA_DIR) { $env:VIDEOFORGE_DATA_DIR } else { Join-Path $HomeDir ".videoforge" }
New-Item -ItemType Directory -Force -Path $VfData | Out-Null
$env:VIDEOFORGE_DATA_DIR = $VfData

# ── 3. sidecar 后端
#   优先用环境变量；否则按**同级目录**推导（VideoForge 仓库与本仓库并排时可用）。
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
$backend = if ($sd) { Join-Path $sd "_internal\backend" } else { $null }
if ($py -and $backend -and (Test-Path $backend) -and -not $NoBlender) {
  $env:VIDEOFORGE_HOST = "127.0.0.1"
  $env:VIDEOFORGE_PORT = "$Port"
  $env:PYTHONIOENCODING = "utf-8"
  $boot = Join-Path $env:TEMP "vf_boot_$Port.py"
  $code = @"
import sys
sys.path.insert(0, r'$backend')
sys.path.insert(0, r'$(Join-Path $sd "_internal")')
src = open(r'$backend\main.py', encoding='utf-8').read()
exec(compile(src, r'$backend\main.py', 'exec'), {'__name__': '__main__', '__file__': r'$backend\main.py'})
"@
  Set-Content -Path $boot -Value $code -Encoding UTF8
  $log = Join-Path $LogDir "vf-backend-$Port.log"
  Start-Process -FilePath $py -ArgumentList @($boot) -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Write-Host "[OVF] VideoForge 后端（无窗口）→ http://127.0.0.1:$Port   日志: $log"
  if ($blender) { Write-Host "[OVF] Blender: $blender" }
  Start-Sleep -Seconds 3
} elseif ($NoBlender) {
  Write-Host "[OVF] 跳过 Blender 后端（-NoBlender）"
} elseif (-not $backend) {
  Write-Host "[OVF] 找不到 sidecar 目录（用 VIDEOFORGE_SIDECAR_DIR 指定，或把 VideoForge 仓库放在同级目录）"
}

# ── 4. openVideoForge 页面 + 桥
$ovf = $PSScriptRoot
if (-not $ovf) { $ovf = (Get-Location).Path }
$cli = Join-Path $ovf "bin\cli.mjs"
if (Test-Path $cli) {
  $out = if ($env:OVF_OUT_DIR) { $env:OVF_OUT_DIR } else { Join-Path $HomeDir "Downloads\OpenVideoForge" }
  Write-Host "[OVF] 页面 + 桥 → http://127.0.0.1:8802/index.html   输出目录: $out"
} else {
  Write-Host "[OVF] bin\cli.mjs 不在 $ovf —— 从源码目录启动"
}
