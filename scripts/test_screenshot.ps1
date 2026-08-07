#Requires -Version 5.1
<#
  启动 启禾文件管理，前置窗口并截图，测试关闭到托盘行为。
#>
$ErrorActionPreference = "Stop"

$projectRoot = Join-Path $env:USERPROFILE "Documents\kimi\workspace\certmanager"
$exe = Join-Path $projectRoot "build\bin\qihefilemanager.exe"
$outImg = Join-Path $projectRoot "test-screenshot.png"

if (-not (Test-Path $exe)) {
    throw "找不到可执行文件: $exe"
}

# 清理旧进程
Get-Process -Name "qihefilemanager" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 启动应用
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "进程已启动，PID: $($proc.Id)"

# 等待窗口出现并前置
$p = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
        break
    }
}

if (-not $p -or $p.MainWindowHandle -eq 0) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "未找到应用窗口"
}

Write-Host "窗口句柄: $($p.MainWindowHandle)"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@ -Language CSharp

# SW_SHOWMAXIMIZED = 3
[WinApi]::ShowWindow($p.MainWindowHandle, 3) | Out-Null
[WinApi]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Seconds 2

# 截图主显示器
Add-Type -AssemblyName System.Drawing
$screen = [System.Drawing.Rectangle]::FromLTRB(0, 0, 1920, 1080)
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save($outImg, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Host "截图已保存: $outImg"

# 测试关闭到托盘：发送 WM_CLOSE
[WinApi]::PostMessage($p.MainWindowHandle, 0x10, 0, 0) | Out-Null
Write-Host "已发送 WM_CLOSE"

Start-Sleep -Seconds 3
$still = Get-Process -Name "qihefilemanager" -ErrorAction SilentlyContinue
if ($still) {
    Write-Host "进程仍在运行，关闭到托盘成功，PID: $($still.Id)"
} else {
    Write-Host "进程已退出，关闭到托盘失败"
}

# 最终清理
Get-Process -Name "qihefilemanager" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
