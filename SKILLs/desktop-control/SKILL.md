---
name: desktop-control
description: Control your desktop like a human — take screenshots, move the mouse, click, type, and interact with any GUI application. Works on Windows and macOS.
name_zh: "桌面控制"
description_zh: "像人一样操控桌面 — 截屏、移动鼠标、点击、输入，操控任何GUI应用程序。支持 Windows 和 macOS。"
name_ja: "デスクトップ制御"
description_ja: "人間のようにデスクトップを操作 — スクリーンショット、マウス移動、クリック、入力。Windows/macOS対応。"
name_ko: "데스크톱 제어"
description_ko: "사람처럼 데스크톱을 제어 — 스크린샷, 마우스 이동, 클릭, 입력. Windows/macOS 지원."
official: true
version: 1.0.0
---

# Desktop Control Skill

## When to Use This Skill

Use this skill when you need to interact with GUI applications that don't have command-line interfaces:

- **GUI application control** — Photoshop, WeChat, Slack, any desktop app
- **Visual verification** — Take screenshots to see what's on screen
- **Mouse/keyboard automation** — Click buttons, type text, drag elements
- **Multi-app workflows** — Copy from one app, paste to another

## How It Works

This skill uses system-level commands to control the desktop:

### Taking Screenshots

**Windows:**
```bash
# Full screen screenshot
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bitmap.Save('screenshot.png'); }"
```

**macOS:**
```bash
screencapture -x screenshot.png
```

### Mouse Control

**Windows — always use this single atomic script (move + click in one call, DPI-aware, uses SendInput):**
```bash
powershell -NoProfile -NonInteractive -Command '
$x = 500; $y = 300  # <-- replace with target coordinates

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NativeMouse {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inp, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
}
"@ -ErrorAction SilentlyContinue

[NativeMouse]::SetProcessDPIAware()
$screenW = [NativeMouse]::GetSystemMetrics(0)
$screenH = [NativeMouse]::GetSystemMetrics(1)
$nx = [int](($x * 65535) / $screenW)
$ny = [int](($y * 65535) / $screenH)

$move  = New-Object NativeMouse+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001
$down  = New-Object NativeMouse+INPUT; $down.type = 0; $down.mi.dwFlags = 0x0002
$up    = New-Object NativeMouse+INPUT; $up.type   = 0; $up.mi.dwFlags   = 0x0004

[NativeMouse]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move))
Start-Sleep -Milliseconds 50
[NativeMouse]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down))
Write-Host "Clicked at ($x, $y)"
'
```

**Notes:**
- Replace `$x = 500; $y = 300` with the actual coordinates from screenshot analysis
- `SetProcessDPIAware()` + `65535` normalization handles all DPI scaling (100%, 125%, 150%, 200%)
- Move and click are sent in one atomic sequence — no window to interfere between steps
- `Add-Type -ErrorAction SilentlyContinue` prevents failure if already defined in the same session

**macOS:**
```bash
# Move and click in one command — no cliclick needed
osascript -e 'tell application "System Events" to click at {500, 300}'

# Or using built-in screencapture coordinates
cliclick c:500,300    # if cliclick is available (brew install cliclick)
```

### Keyboard Input

**Windows:**
```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("Hello World")
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to keystroke "Hello World"'
osascript -e 'tell application "System Events" to key code 36'  # Enter
```

### Window Management

**Windows:**
```powershell
# List windows
Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, MainWindowTitle

# Activate window
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.Interaction]::AppActivate("Window Title")
```

**macOS:**
```bash
# List windows
osascript -e 'tell application "System Events" to get name of every process whose visible is true'

# Activate window
osascript -e 'tell application "AppName" to activate'
```

## Workflow Pattern

1. Take a screenshot to see current screen state
2. Analyze the screenshot to understand what's visible
3. Determine the action needed (click, type, scroll)
4. Execute the action using system commands
5. Take another screenshot to verify the result
6. Repeat until task is complete

## Limitations

- Cannot bypass system security dialogs (UAC, password prompts)
- Screenshot analysis depends on AI vision capability
- Mouse coordinates must be calculated from screenshot analysis
- Some applications may block automated input
