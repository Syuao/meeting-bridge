[CmdletBinding()]
param([switch]$InstallChrome)
$ErrorActionPreference = 'Stop'
$Package = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $env:LOCALAPPDATA 'MeetingBridge'
$EdgeId = 'nikdjjonbnjblpeopjgddiclfdddlmcm'

function Find-Node {
  $bundled = Join-Path $Package 'node-runtime\node.exe'
  if (Test-Path $bundled) { return $bundled }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw '未找到 Node.js 22+。请安装 Node.js LTS 后重新运行：winget install OpenJS.NodeJS.LTS'
}

$Node = Find-Node
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'extension'),(Join-Path $Runtime 'host'),(Join-Path $Runtime 'node_modules') | Out-Null
Copy-Item (Join-Path $Package 'extension\*') (Join-Path $Runtime 'extension') -Recurse -Force
Copy-Item (Join-Path $Package 'host\*') (Join-Path $Runtime 'host') -Recurse -Force
Copy-Item (Join-Path $Package 'node_modules\*') (Join-Path $Runtime 'node_modules') -Recurse -Force
if (Test-Path (Join-Path $Package 'models')) { New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'models') | Out-Null; Copy-Item (Join-Path $Package 'models\*') (Join-Path $Runtime 'models') -Recurse -Force }
$ffmpegBundle = Join-Path $Package 'ffmpeg.exe'
if (Test-Path $ffmpegBundle) { Copy-Item $ffmpegBundle (Join-Path $Runtime 'ffmpeg.exe') -Force }

$Node = (Resolve-Path $Node).Path
$Bridge = (Resolve-Path (Join-Path $Runtime 'host\bridge.mjs')).Path
$LauncherCmd = Join-Path $Runtime 'host\launch-host.cmd'
$launcherText = "@echo off`r`nsetlocal`r`n`"$Node`" `"$Bridge`" %*`r`n"
Set-Content -Path $LauncherCmd -Value $launcherText -Encoding ASCII
$Launcher = $LauncherCmd
$launcherSourcePath = Join-Path $Package 'HostLauncher.cs'
if (Test-Path $launcherSourcePath) {
  try {
    $source = Get-Content $launcherSourcePath -Raw
    $escape = { param($v) $v.Replace('\','\\').Replace('`"','\`"') }
    $source = $source.Replace('__NODE__',(& $escape $Node)).Replace('__BRIDGE__',(& $escape $Bridge))
    $LauncherExe = Join-Path $Runtime 'host\launch-host.exe'
    Add-Type -TypeDefinition $source -OutputAssembly $LauncherExe -OutputType ConsoleApplication
    $Launcher = $LauncherExe
  } catch { Write-Warning "无法编译 Windows 原生启动器，将保留 CMD 启动器：$($_.Exception.Message)" }
}

$Manifest = Join-Path $Runtime 'local.meetingbridge.json'
$manifestObject = [ordered]@{
  name = 'local.meetingbridge'
  description = 'Local meeting audio transcription'
  path = $Launcher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$EdgeId/")
}
$manifestJson = $manifestObject | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($Manifest, $manifestJson + "`r`n", (New-Object Text.UTF8Encoding($false)))

$edgeKey = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\local.meetingbridge'
New-Item -Path $edgeKey -Force | Out-Null
Set-ItemProperty -Path $edgeKey -Name '(default)' -Value $Manifest
if ($InstallChrome) {
  $chromeKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\local.meetingbridge'
  New-Item -Path $chromeKey -Force | Out-Null
  Set-ItemProperty -Path $chromeKey -Name '(default)' -Value $Manifest
}

$ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $Runtime 'ffmpeg.exe')) -and -not $ffmpeg) {
  Write-Warning '未找到 ffmpeg.exe。系统声音监听需要 FFmpeg WASAPI；请安装后重新运行，或把 ffmpeg.exe 放入安装包根目录。'
  Write-Host '安装命令：winget install Gyan.FFmpeg.Shared'
}
Write-Host "Meeting Bridge 已安装到 $Runtime"
Write-Host 'Edge：打开 edge://extensions，开启开发人员模式，加载已解压的扩展：'
Write-Host (Join-Path $Runtime 'extension')
Write-Host '首次监听使用默认 Windows 输出设备；请在 Edge 和 Windows 音频设置中允许访问。'
