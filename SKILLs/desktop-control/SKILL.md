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

**Windows (PowerShell):**
```powershell
# Move mouse to coordinates
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(500, 300)

# Click
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int info);' -Name Win32 -Namespace System
[System.Win32]::mouse_event(0x02, 0, 0, 0, 0)  # Left down
[System.Win32]::mouse_event(0x04, 0, 0, 0, 0)  # Left up
```

**macOS:**
```bash
# Using cliclick (install: brew install cliclick)
cliclick c:500,300    # Click at coordinates
cliclick m:500,300    # Move to coordinates
cliclick t:"hello"    # Type text
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
