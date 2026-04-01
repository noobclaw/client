/**
 * Desktop Control MCP Server — provides native desktop automation tools
 * as an in-process MCP server for the Claude Agent SDK.
 *
 * Replaces the desktop-control SKILL.md prompt-only approach with real
 * executable tools. The AI calls click({x,y}) instead of composing
 * PowerShell commands manually.
 *
 * Ported from Anthropic's @ant/computer-use-mcp architecture.
 */

import { spawnSync, execSync } from 'child_process';
import { coworkLog } from './coworkLogger';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ── Blocked system key combos (from Claude Code keyBlocklist.ts) ──

const BLOCKED_KEYS_WIN = new Set([
  'ctrl+alt+delete', 'alt+f4', 'alt+tab', 'win+l', 'win+d',
  'meta+l', 'meta+d', 'ctrl+alt+del',
]);
const BLOCKED_KEYS_MAC = new Set([
  'cmd+q', 'meta+q', 'cmd+shift+q', 'meta+shift+q',
  'cmd+option+esc', 'meta+alt+esc', 'cmd+tab', 'meta+tab',
  'cmd+space', 'meta+space', 'ctrl+cmd+q', 'ctrl+meta+q',
]);

function isBlockedKeyCombo(keys: string): boolean {
  const normalized = keys.toLowerCase().trim()
    .replace(/command/g, 'meta').replace(/cmd/g, 'meta')
    .replace(/windows/g, 'meta').replace(/win/g, 'meta')
    .replace(/option/g, 'alt').replace(/control/g, 'ctrl');
  const set = IS_WIN ? BLOCKED_KEYS_WIN : BLOCKED_KEYS_MAC;
  return set.has(normalized);
}

// ── Windows SendInput helper (shared Add-Type, DPI-aware) ──

function winSendInputMove(x: number, y: number): string {
  return `$x=${x};$y=${y};` +
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; ' +
    'public class DM { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } ' +
    '[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } ' +
    '[DllImport(\\"user32.dll\\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); ' +
    '[DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware(); ' +
    '[DllImport(\\"user32.dll\\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; ' +
    '[DM]::SetProcessDPIAware(); $sw=[DM]::GetSystemMetrics(0); $sh=[DM]::GetSystemMetrics(1); ' +
    '$nx=[int](($x*65535)/$sw); $ny=[int](($y*65535)/$sh); ' +
    '$m=New-Object DM+INPUT; $m.type=0; $m.mi.dx=$nx; $m.mi.dy=$ny; $m.mi.dwFlags=0x8001; ' +
    '[DM]::SendInput(1, @($m), [System.Runtime.InteropServices.Marshal]::SizeOf($m)); Start-Sleep -Milliseconds 50';
}

function winClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clicks: number = 1): string {
  const flagMap = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] };
  const [downFlag, upFlag] = flagMap[button];
  let ps = winSendInputMove(x, y) + '; ';
  ps += `$dn=New-Object DM+INPUT;$dn.type=0;$dn.mi.dwFlags=0x${downFlag.toString(16)};`;
  ps += `$up=New-Object DM+INPUT;$up.type=0;$up.mi.dwFlags=0x${upFlag.toString(16)};`;
  for (let i = 0; i < clicks; i++) {
    if (i > 0) ps += 'Start-Sleep -Milliseconds 80;';
    ps += '[DM]::SendInput(2,@($dn,$up),[System.Runtime.InteropServices.Marshal]::SizeOf($dn));';
  }
  return ps;
}

function runPS(cmd: string): string {
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      timeout: 15000, windowsHide: true, encoding: 'utf8',
    });
    return result.stdout?.trim() || result.stderr?.trim() || '';
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function runOsa(script: string): string {
  try {
    const result = spawnSync('osascript', ['-e', script], {
      timeout: 15000, encoding: 'utf8',
    });
    return result.stdout?.trim() || result.stderr?.trim() || '';
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Tool implementations ──

function screenshot(savePath: string = 'screenshot.png'): string {
  if (IS_WIN) {
    return runPS(
      `Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen; ` +
      `$bmp=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height); ` +
      `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($s.Bounds.Location,[System.Drawing.Point]::Empty,$s.Bounds.Size); ` +
      `$bmp.Save("${savePath.replace(/"/g, '\\"')}"); $g.Dispose(); $bmp.Dispose(); ` +
      `Write-Host "Saved ${savePath}"`
    );
  }
  if (IS_MAC) {
    try {
      execSync(`screencapture -x "${savePath}"`, { timeout: 10000 });
      return `Saved ${savePath}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return 'Unsupported platform';
}

function zoom(x0: number, y0: number, x1: number, y1: number, savePath: string = 'zoomed.png'): string {
  if (IS_WIN) {
    const w = x1 - x0;
    const h = y1 - y0;
    return runPS(
      `Add-Type -AssemblyName System.Drawing; $src=[System.Drawing.Image]::FromFile("screenshot.png"); ` +
      `$bmp=New-Object System.Drawing.Bitmap(${w},${h}); $g=[System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.DrawImage($src,0,0,(New-Object System.Drawing.Rectangle(${x0},${y0},${w},${h})),[System.Drawing.GraphicsUnit]::Pixel); ` +
      `$bmp.Save("${savePath}"); $g.Dispose(); $bmp.Dispose(); $src.Dispose(); Write-Host "Zoomed to ${savePath}"`
    );
  }
  if (IS_MAC) {
    try {
      const w = x1 - x0;
      const h = y1 - y0;
      execSync(`screencapture -x -R ${x0},${y0},${w},${h} "${savePath}"`, { timeout: 10000 });
      return `Zoomed to ${savePath}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return 'Unsupported platform';
}

function click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', clicks: number = 1): string {
  if (IS_WIN) {
    const ps = winClick(x, y, button, clicks) + ` Write-Host "${button}-clicked (${x},${y}) x${clicks}"`;
    return runPS(ps);
  }
  if (IS_MAC) {
    const clickType = button === 'right' ? 'secondary click' : button === 'middle' ? 'click' : (clicks === 2 ? 'double click' : clicks === 3 ? 'triple click' : 'click');
    return runOsa(`tell application "System Events" to ${clickType} at {${x}, ${y}}`);
  }
  return 'Unsupported platform';
}

function mouseMove(x: number, y: number): string {
  if (IS_WIN) {
    return runPS(winSendInputMove(x, y) + `; Write-Host "Moved to (${x},${y})"`);
  }
  if (IS_MAC) {
    return runOsa(`tell application "System Events" to move mouse to {${x}, ${y}}`);
  }
  return 'Unsupported platform';
}

function drag(x1: number, y1: number, x2: number, y2: number): string {
  if (IS_WIN) {
    // Move to start, press down, move in steps, release
    let ps = winSendInputMove(x1, y1) + '; ';
    ps += '$dn=New-Object DM+INPUT;$dn.type=0;$dn.mi.dwFlags=0x0002;[DM]::SendInput(1,@($dn),[System.Runtime.InteropServices.Marshal]::SizeOf($dn));Start-Sleep -Milliseconds 50;';
    // 5 intermediate steps
    for (let i = 1; i <= 5; i++) {
      const cx = Math.round(x1 + (x2 - x1) * i / 5);
      const cy = Math.round(y1 + (y2 - y1) * i / 5);
      ps += `$x=${cx};$y=${cy};$nx=[int](($x*65535)/$sw);$ny=[int](($y*65535)/$sh);$mv=New-Object DM+INPUT;$mv.type=0;$mv.mi.dx=$nx;$mv.mi.dy=$ny;$mv.mi.dwFlags=0x8001;[DM]::SendInput(1,@($mv),[System.Runtime.InteropServices.Marshal]::SizeOf($mv));Start-Sleep -Milliseconds 20;`;
    }
    ps += '$up=New-Object DM+INPUT;$up.type=0;$up.mi.dwFlags=0x0004;[DM]::SendInput(1,@($up),[System.Runtime.InteropServices.Marshal]::SizeOf($up));';
    ps += `Write-Host "Dragged (${x1},${y1}) to (${x2},${y2})"`;
    return runPS(ps);
  }
  if (IS_MAC) {
    return runOsa(`tell application "System Events" to drag from {${x1},${y1}} to {${x2},${y2}}`);
  }
  return 'Unsupported platform';
}

function typeText(text: string): string {
  if (IS_WIN) {
    // Escape SendKeys special chars
    const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}');
    return runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${escaped.replace(/"/g, '`"')}"); Write-Host "Typed ${text.length} chars"`);
  }
  if (IS_MAC) {
    return runOsa(`tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"`);
  }
  return 'Unsupported platform';
}

function pressKey(key: string, repeat: number = 1): string {
  if (isBlockedKeyCombo(key)) {
    return `BLOCKED: "${key}" is a system key combo that could disrupt the user's session. Use the app's menu or close button instead.`;
  }
  if (IS_WIN) {
    const keyMap: Record<string, string> = {
      'enter': '{ENTER}', 'tab': '{TAB}', 'escape': '{ESC}', 'esc': '{ESC}',
      'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'del': '{DELETE}',
      'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
      'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
      'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}', 'f5': '{F5}',
      'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}', 'f9': '{F9}', 'f10': '{F10}',
      'f11': '{F11}', 'f12': '{F12}', 'space': ' ',
    };
    const mapped = keyMap[key.toLowerCase()] || key;
    const sendKey = repeat > 1 ? `${mapped.replace('}', ` ${repeat}}`)}` : mapped;
    return runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${sendKey}"); Write-Host "Pressed ${key} x${repeat}"`);
  }
  if (IS_MAC) {
    const keyCodeMap: Record<string, number> = {
      'enter': 36, 'return': 36, 'tab': 48, 'escape': 53, 'esc': 53,
      'delete': 51, 'backspace': 51, 'up': 126, 'down': 125, 'left': 123, 'right': 124,
      'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121, 'space': 49,
      'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
    };
    const code = keyCodeMap[key.toLowerCase()];
    if (code !== undefined) {
      let script = '';
      for (let i = 0; i < repeat; i++) {
        script += `tell application "System Events" to key code ${code}\n`;
      }
      return runOsa(script);
    }
    return runOsa(`tell application "System Events" to keystroke "${key}"`);
  }
  return 'Unsupported platform';
}

function scroll(x: number, y: number, direction: 'up' | 'down', amount: number = 3): string {
  const delta = direction === 'up' ? amount : -amount;
  if (IS_WIN) {
    const ps = winSendInputMove(x, y) +
      `; $sc=New-Object DM+INPUT;$sc.type=0;$sc.mi.mouseData=[uint32](${delta}*120);$sc.mi.dwFlags=0x0800;` +
      `[DM]::SendInput(1,@($sc),[System.Runtime.InteropServices.Marshal]::SizeOf($sc)); Write-Host "Scrolled ${direction} ${amount}"`;
    return runPS(ps);
  }
  if (IS_MAC) {
    const keyCode = direction === 'up' ? 116 : 121; // Page Up / Page Down
    return runOsa(`tell application "System Events" to key code ${keyCode}`);
  }
  return 'Unsupported platform';
}

function getCursorPosition(): string {
  if (IS_WIN) {
    return runPS('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Host "($($p.X),$($p.Y))"');
  }
  if (IS_MAC) {
    return runOsa('tell application "System Events" to get position of mouse');
  }
  return 'Unsupported platform';
}

function readClipboard(): string {
  if (IS_WIN) {
    return runPS('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()');
  }
  if (IS_MAC) {
    try { return execSync('pbpaste', { encoding: 'utf8', timeout: 5000 }); }
    catch { return ''; }
  }
  return 'Unsupported platform';
}

function writeClipboard(text: string): string {
  if (IS_WIN) {
    return runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("${text.replace(/"/g, '`"')}"); Write-Host "Copied to clipboard"`);
  }
  if (IS_MAC) {
    try {
      execSync(`echo "${text.replace(/"/g, '\\"')}" | pbcopy`, { timeout: 5000 });
      return 'Copied to clipboard';
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return 'Unsupported platform';
}

function openApp(appName: string): string {
  if (IS_WIN) {
    return runPS(`$apps = Get-StartApps | Where-Object { $_.Name -like "*${appName}*" }; if ($apps) { Start-Process $apps[0].AppId; Write-Host "Launched: $($apps[0].Name)" } else { Start-Process "${appName}" -ErrorAction SilentlyContinue; Write-Host "Attempted to launch ${appName}" }`);
  }
  if (IS_MAC) {
    try {
      execSync(`open -a "${appName}"`, { timeout: 10000 });
      return `Launched ${appName}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return 'Unsupported platform';
}

function waitSeconds(seconds: number): string {
  if (seconds > 30) seconds = 30;
  if (seconds < 0) seconds = 0;
  const ms = Math.round(seconds * 1000);
  // Synchronous wait
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — short durations only */ }
  return `Waited ${seconds}s`;
}

// ── Build MCP tools array for SDK registration ──

export function buildDesktopControlTools(sdkTool: Function, z: any): any[] {
  return [
    sdkTool(
      'desktop_screenshot',
      'Take a screenshot of the entire screen. Returns the file path. Use this to see what is currently on screen before taking actions.',
      { save_path: z.string().optional() },
      async (args: { save_path?: string }) => {
        const result = screenshot(args.save_path || 'screenshot.png');
        coworkLog('INFO', 'desktop_screenshot', result);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_zoom',
      'Crop a rectangular region from the last screenshot for closer inspection. Useful when text is too small to read.',
      { x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number(), save_path: z.string().optional() },
      async (args: { x0: number; y0: number; x1: number; y1: number; save_path?: string }) => {
        const result = zoom(args.x0, args.y0, args.x1, args.y1, args.save_path || 'zoomed.png');
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_click',
      'Click at screen coordinates. Supports left/right/middle button and single/double/triple click.',
      { x: z.number(), y: z.number(), button: z.enum(['left', 'right', 'middle']).optional(), clicks: z.number().min(1).max(3).optional() },
      async (args: { x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }) => {
        const result = click(args.x, args.y, args.button || 'left', args.clicks || 1);
        coworkLog('INFO', 'desktop_click', result);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_mouse_move',
      'Move the mouse cursor to coordinates without clicking. Useful for hovering to reveal tooltips or menus.',
      { x: z.number(), y: z.number() },
      async (args: { x: number; y: number }) => {
        const result = mouseMove(args.x, args.y);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_drag',
      'Click and drag from one point to another. Used for moving windows, sliders, drag-and-drop.',
      { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() },
      async (args: { x1: number; y1: number; x2: number; y2: number }) => {
        const result = drag(args.x1, args.y1, args.x2, args.y2);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_type',
      'Type text at the current cursor position. The text is typed character by character as keyboard input.',
      { text: z.string().min(1) },
      async (args: { text: string }) => {
        const result = typeText(args.text);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_key',
      'Press a keyboard key or key combination. Examples: "enter", "tab", "escape", "f5", "ctrl+c" (Windows), "cmd+c" (macOS). Can repeat multiple times.',
      { key: z.string().min(1), repeat: z.number().min(1).max(100).optional() },
      async (args: { key: string; repeat?: number }) => {
        const result = pressKey(args.key, args.repeat || 1);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_scroll',
      'Scroll at a specific screen position. Direction can be "up" or "down". Amount is number of scroll units (default 3).',
      { x: z.number(), y: z.number(), direction: z.enum(['up', 'down']), amount: z.number().min(1).max(20).optional() },
      async (args: { x: number; y: number; direction: 'up' | 'down'; amount?: number }) => {
        const result = scroll(args.x, args.y, args.direction, args.amount || 3);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_cursor_position',
      'Get the current cursor position on screen.',
      {},
      async () => {
        const result = getCursorPosition();
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_read_clipboard',
      'Read the current text content of the system clipboard.',
      {},
      async () => {
        const result = readClipboard();
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_write_clipboard',
      'Write text to the system clipboard.',
      { text: z.string() },
      async (args: { text: string }) => {
        const result = writeClipboard(args.text);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_open_app',
      'Open or bring to front a desktop application by name.',
      { app_name: z.string().min(1) },
      async (args: { app_name: string }) => {
        const result = openApp(args.app_name);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
    sdkTool(
      'desktop_wait',
      'Wait for a specified number of seconds. Use when waiting for an app to load or animation to complete.',
      { seconds: z.number().min(0).max(30) },
      async (args: { seconds: number }) => {
        const result = waitSeconds(args.seconds);
        return { content: [{ type: 'text', text: result }] } as any;
      }
    ),
  ];
}
