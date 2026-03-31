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

- **GUI application control** — WeChat, DingTalk, Slack, any desktop app
- **Visual verification** — Take screenshots to see what's on screen
- **Mouse/keyboard automation** — Click buttons, type text, drag elements
- **Multi-app workflows** — Copy from one app, paste to another

## Workflow Pattern

1. Take a screenshot to see current screen state
2. Analyze the screenshot to understand what's visible and find coordinates
3. Determine the action needed (click, type, scroll)
4. Execute the action using system commands
5. Take another screenshot to verify the result
6. Repeat until task is complete

---

## Taking Screenshots

**Windows** — ALWAYS wrap in single quotes to prevent bash variable expansion:
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; $s = [System.Windows.Forms.Screen]::PrimaryScreen; $bmp = New-Object System.Drawing.Bitmap($s.Bounds.Width, $s.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($s.Bounds.Location, [System.Drawing.Point]::Empty, $s.Bounds.Size); $bmp.Save("screenshot.png"); $g.Dispose(); $bmp.Dispose(); Write-Host "Saved screenshot.png"'
```

**macOS:**
```bash
screencapture -x screenshot.png
```

---

## Mouse Control — Click

**Windows — atomic move+click (DPI-aware, uses SendInput):**

ALWAYS wrap the entire PowerShell command in single quotes when calling from bash.
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NM { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NM]::SetProcessDPIAware(); $sw = [NM]::GetSystemMetrics(0); $sh = [NM]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NM+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $down = New-Object NM+INPUT; $down.type = 0; $down.mi.dwFlags = 0x0002; $up = New-Object NM+INPUT; $up.type = 0; $up.mi.dwFlags = 0x0004; [NM]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NM]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Write-Host "Clicked ($x, $y)"'
```

**Key rules:**
- Replace `$x = 500; $y = 300` with target coordinates from screenshot analysis
- `SetProcessDPIAware()` + `65535` normalization handles all DPI scaling (100%–200%)
- `Add-Type -ErrorAction SilentlyContinue` prevents failure if type already defined in session
- Move and click are sent in one atomic sequence

**macOS:**
```bash
osascript -e 'tell application "System Events" to click at {500, 300}'
```

---

## Mouse Control — Double Click

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NM2 { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NM2]::SetProcessDPIAware(); $sw = [NM2]::GetSystemMetrics(0); $sh = [NM2]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NM2+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $down = New-Object NM2+INPUT; $down.type = 0; $down.mi.dwFlags = 0x0002; $up = New-Object NM2+INPUT; $up.type = 0; $up.mi.dwFlags = 0x0004; [NM2]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NM2]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Start-Sleep -Milliseconds 80; [NM2]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Write-Host "Double-clicked ($x, $y)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to double click at {500, 300}'
```

---

## Mouse Control — Right Click

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMR { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMR]::SetProcessDPIAware(); $sw = [NMR]::GetSystemMetrics(0); $sh = [NMR]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NMR+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $rdown = New-Object NMR+INPUT; $rdown.type = 0; $rdown.mi.dwFlags = 0x0008; $rup = New-Object NMR+INPUT; $rup.type = 0; $rup.mi.dwFlags = 0x0010; [NMR]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NMR]::SendInput(2, @($rdown, $rup), [System.Runtime.InteropServices.Marshal]::SizeOf($rdown)); Write-Host "Right-clicked ($x, $y)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to secondary click at {500, 300}'
```

---

## Mouse Control — Scroll

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; $delta = 3; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMS { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMS]::SetProcessDPIAware(); $sw = [NMS]::GetSystemMetrics(0); $sh = [NMS]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NMS+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; [NMS]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; $scroll = New-Object NMS+INPUT; $scroll.type = 0; $scroll.mi.mouseData = [uint32]($delta * 120); $scroll.mi.dwFlags = 0x0800; [NMS]::SendInput(1, @($scroll), [System.Runtime.InteropServices.Marshal]::SizeOf($scroll)); Write-Host "Scrolled up $delta"'
```

For scroll **down**, use negative delta: `$delta = -3`

**macOS — scroll via keyboard (most reliable):**
```bash
# Scroll down (repeat key_code 125 = Down arrow)
osascript -e 'tell application "System Events" to repeat 5 times' -e 'key code 125' -e 'end repeat'
```
```bash
# Or: Page Down
osascript -e 'tell application "System Events" to key code 121'
```
```bash
# Or: Page Up
osascript -e 'tell application "System Events" to key code 116'
```

---

## Keyboard Input

**Windows** — ALWAYS wrap in single quotes:
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("Hello World")'
```

```bash
# Press Enter
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")'
```

```bash
# Ctrl+C (copy)
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")'
```

```bash
# Ctrl+V (paste)
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to keystroke "Hello World"'
osascript -e 'tell application "System Events" to key code 36'  # Enter
osascript -e 'tell application "System Events" to keystroke "c" using command down'  # Cmd+C
```

---

## Finding and Launching Apps

**Windows — list running apps with windows:**
```bash
powershell -NoProfile -NonInteractive -Command 'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object ProcessName, MainWindowTitle | Format-Table -AutoSize'
```

**Windows — search Start Menu for an app and launch it:**
```bash
powershell -NoProfile -NonInteractive -Command '$apps = Get-StartApps | Where-Object { $_.Name -like "*WeChat*" }; if ($apps) { Start-Process $apps[0].AppId; Write-Host "Launched: $($apps[0].Name)" } else { Write-Host "App not found" }'
```

**Windows — launch app by executable name:**
```bash
powershell -NoProfile -NonInteractive -Command 'Start-Process "WeChat.exe"'
```

**macOS:**
```bash
# List running apps
osascript -e 'tell application "System Events" to get name of every process whose visible is true'

# Launch app
open -a "WeChat"
```

---

## Window Management

**Windows — activate (bring to front) a window:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate("WeChat")'
```

**Windows — maximize a window:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class WM { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern IntPtr FindWindow(string c, string t); }" -ErrorAction SilentlyContinue; $hwnd = [WM]::FindWindow($null, "WeChat"); [WM]::ShowWindow($hwnd, 3); Write-Host "Maximized"'
```

**macOS:**
```bash
osascript -e 'tell application "WeChat" to activate'
```

---

## Wait / Delay

When you need to wait for an app to load or a dialog to appear:

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command 'Start-Sleep -Seconds 2; Write-Host "Done waiting"'
```

**macOS:**
```bash
sleep 2
```

---

## Limitations

- Cannot bypass system security dialogs (UAC, password prompts)
- Screenshot analysis depends on AI vision capability
- Mouse coordinates must be calculated from screenshot analysis
- Some applications may block automated input
- SendKeys may not work in some UWP/Store apps — use SendInput mouse clicks instead
