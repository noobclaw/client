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
import { z } from 'zod';
import { nativeScreenshot, nativeMouseMove, nativeClipboardVerify, hasNativeDesktop } from './nativeDesktopMac';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HAS_NATIVE = IS_MAC && hasNativeDesktop();

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
    // Try native SCContentFilter first (faster, ~50ms vs ~500ms for screencapture CLI)
    if (HAS_NATIVE) {
      try {
        const buf = nativeScreenshot(0.75);
        if (buf) {
          const fs = require('fs');
          fs.writeFileSync(savePath, buf);
          coworkLog('INFO', 'screenshot', `Native screenshot saved: ${savePath} (${buf.length} bytes)`);
          return `Saved ${savePath} (native)`;
        }
      } catch (e) {
        coworkLog('WARN', 'screenshot', `Native screenshot failed, falling back to screencapture: ${e}`);
      }
    }
    // Fallback to screencapture CLI
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
    // System Events doesn't support mouse_move directly; use cliclick or CGEvent via python
    try {
      const result = spawnSync('python3', ['-c',
        `import Quartz; Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), 0))`
      ], { timeout: 5000, encoding: 'utf8' });
      return result.status === 0 ? `Moved to (${x},${y})` : (result.stderr?.trim() || 'Failed');
    } catch {
      return `Moved to (${x},${y}) [fallback — mouse move may not be supported without cliclick]`;
    }
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
    // System Events doesn't support drag natively; use CGEvent via python
    try {
      const pyScript = `
import Quartz, time
p1,p2=(${x1},${y1}),(${x2},${y2})
e=Quartz.CGEventCreateMouseEvent(None,Quartz.kCGEventLeftMouseDown,p1,0)
Quartz.CGEventPost(Quartz.kCGHIDEventTap,e)
time.sleep(0.05)
for i in range(1,6):
  f=i/5.0;p=(p1[0]+(p2[0]-p1[0])*f,p1[1]+(p2[1]-p1[1])*f)
  e=Quartz.CGEventCreateMouseEvent(None,Quartz.kCGEventLeftMouseDragged,p,0)
  Quartz.CGEventPost(Quartz.kCGHIDEventTap,e);time.sleep(0.02)
e=Quartz.CGEventCreateMouseEvent(None,Quartz.kCGEventLeftMouseUp,p2,0)
Quartz.CGEventPost(Quartz.kCGHIDEventTap,e)
`;
      const result = spawnSync('python3', ['-c', pyScript], { timeout: 10000, encoding: 'utf8' });
      return result.status === 0 ? `Dragged (${x1},${y1}) to (${x2},${y2})` : (result.stderr?.trim() || 'Failed');
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
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

  // Parse combo syntax: "ctrl+c", "alt+shift+tab", etc.
  const parts = key.toLowerCase().split('+').map(p => p.trim());
  const modifiers: string[] = [];
  let mainKey = '';
  for (const p of parts) {
    if (['ctrl', 'control', 'alt', 'option', 'shift', 'cmd', 'command', 'meta', 'win', 'super'].includes(p)) {
      modifiers.push(p);
    } else {
      mainKey = p;
    }
  }
  if (!mainKey && modifiers.length > 0) mainKey = modifiers.pop()!;

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
    // SendKeys modifier prefixes: ^ = Ctrl, % = Alt, + = Shift
    let prefix = '';
    for (const mod of modifiers) {
      if (mod === 'ctrl' || mod === 'control') prefix += '^';
      else if (mod === 'alt' || mod === 'option') prefix += '%';
      else if (mod === 'shift') prefix += '+';
      // Win key not supported by SendKeys
    }
    const mapped = keyMap[mainKey] || mainKey;
    let sendKey: string;
    if (repeat > 1 && mapped.startsWith('{') && mapped.endsWith('}')) {
      sendKey = `${mapped.slice(0, -1)} ${repeat}}`;
    } else if (repeat > 1) {
      sendKey = mapped.repeat(repeat);
    } else {
      sendKey = mapped;
    }
    return runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${prefix}${sendKey}"); Write-Host "Pressed ${key} x${repeat}"`);
  }
  if (IS_MAC) {
    const keyCodeMap: Record<string, number> = {
      'enter': 36, 'return': 36, 'tab': 48, 'escape': 53, 'esc': 53,
      'delete': 51, 'backspace': 51, 'up': 126, 'down': 125, 'left': 123, 'right': 124,
      'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121, 'space': 49,
      'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
      'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
      'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
      'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31, 'p': 35,
      'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7,
      'y': 16, 'z': 6,
    };
    // Build AppleScript modifier clause
    const modMap: Record<string, string> = {
      'ctrl': 'control down', 'control': 'control down',
      'alt': 'option down', 'option': 'option down',
      'shift': 'shift down',
      'cmd': 'command down', 'command': 'command down', 'meta': 'command down',
    };
    const modClause = modifiers.map(m => modMap[m]).filter(Boolean);
    const using = modClause.length > 0 ? ` using {${modClause.join(', ')}}` : '';

    const code = keyCodeMap[mainKey];
    if (code !== undefined) {
      const scripts: string[] = [];
      for (let i = 0; i < repeat; i++) {
        scripts.push(`tell application "System Events" to key code ${code}${using}`);
      }
      return runOsa(scripts.join('\n'));
    }
    // Fallback: keystroke for printable chars
    const scripts: string[] = [];
    for (let i = 0; i < repeat; i++) {
      scripts.push(`tell application "System Events" to keystroke "${mainKey}"${using}`);
    }
    return runOsa(scripts.join('\n'));
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
    // Use stdin pipe to avoid PowerShell injection
    try {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $t = [Console]::In.ReadToEnd(); [System.Windows.Forms.Clipboard]::SetText($t); Write-Host "Copied to clipboard"'
      ], { input: text, timeout: 10000, windowsHide: true, encoding: 'utf8' });
      return result.stdout?.trim() || result.stderr?.trim() || 'Copied';
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (IS_MAC) {
    // Use stdin pipe to avoid shell injection
    try {
      const result = spawnSync('pbcopy', [], { input: text, timeout: 5000, encoding: 'utf8' });
      return result.status === 0 ? 'Copied to clipboard' : (result.stderr || 'Failed');
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return 'Unsupported platform';
}

/** Sanitize app name — allow only safe chars to prevent injection */
function sanitizeAppName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af._\-()]/g, '');
}

function openApp(appName: string): string {
  const safe = sanitizeAppName(appName);
  if (!safe) return 'Error: Invalid app name';
  if (IS_WIN) {
    return runPS(`$apps = Get-StartApps | Where-Object { $_.Name -like '*${safe}*' }; if ($apps) { Start-Process $apps[0].AppId; Write-Host "Launched: $($apps[0].Name)" } else { Start-Process '${safe}' -ErrorAction SilentlyContinue; Write-Host "Attempted to launch ${safe}" }`);
  }
  if (IS_MAC) {
    try {
      // Use spawnSync with array args to avoid shell injection
      const result = spawnSync('open', ['-a', safe], { timeout: 10000, encoding: 'utf8' });
      return result.status === 0 ? `Launched ${safe}` : (result.stderr?.trim() || `Failed to launch ${safe}`);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return 'Unsupported platform';
}

function waitSeconds(seconds: number): string {
  if (seconds > 30) seconds = 30;
  if (seconds < 0) seconds = 0;
  // Use spawnSync sleep to avoid blocking the event loop
  if (IS_WIN) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Sleep -Milliseconds ${Math.round(seconds * 1000)}`], { timeout: 35000, windowsHide: true });
  } else {
    spawnSync('sleep', [String(seconds)], { timeout: 35000 });
  }
  return `Waited ${seconds}s`;
}

// ── Build tool definitions for the new direct SDK integration ──

import { buildTool, type ToolDefinition } from './toolSystem';

export function buildDesktopControlToolDefs(): ToolDefinition[] {
  return [
    buildTool({
      name: 'desktop_screenshot',
      description: 'Take a screenshot of the entire screen. Returns the file path. Use this to see what is currently on screen before taking actions.',
      inputSchema: z.object({ save_path: z.string().optional() }),
      call: async (args) => {
        const result = screenshot(args.save_path || 'screenshot.png');
        coworkLog('INFO', 'desktop_screenshot', result);
        return { content: [{ type: 'text', text: result }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
    buildTool({
      name: 'desktop_zoom',
      description: 'Crop a rectangular region from the last screenshot for closer inspection. Useful when text is too small to read.',
      inputSchema: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number(), save_path: z.string().optional() }),
      call: async (args) => {
        const result = zoom(args.x0, args.y0, args.x1, args.y1, args.save_path || 'zoomed.png');
        return { content: [{ type: 'text', text: result }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
    buildTool({
      name: 'desktop_click',
      description: 'Click at screen coordinates. Supports left/right/middle button and single/double/triple click.',
      inputSchema: z.object({ x: z.number(), y: z.number(), button: z.enum(['left', 'right', 'middle']).optional(), clicks: z.number().min(1).max(3).optional() }),
      call: async (args) => {
        const result = click(args.x, args.y, args.button || 'left', args.clicks || 1);
        coworkLog('INFO', 'desktop_click', result);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_mouse_move',
      description: 'Move the mouse cursor to coordinates without clicking. Useful for hovering to reveal tooltips or menus.',
      inputSchema: z.object({ x: z.number(), y: z.number() }),
      call: async (args) => {
        const result = mouseMove(args.x, args.y);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_drag',
      description: 'Click and drag from one point to another. Used for moving windows, sliders, drag-and-drop.',
      inputSchema: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
      call: async (args) => {
        const result = drag(args.x1, args.y1, args.x2, args.y2);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_type',
      description: 'Type text at the current cursor position. The text is typed character by character as keyboard input.',
      inputSchema: z.object({ text: z.string().min(1) }),
      call: async (args) => {
        const result = typeText(args.text);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_key',
      description: 'Press a keyboard key or key combination. Examples: "enter", "tab", "escape", "f5", "ctrl+c" (Windows), "cmd+c" (macOS). Can repeat multiple times.',
      inputSchema: z.object({ key: z.string().min(1), repeat: z.number().min(1).max(100).optional() }),
      call: async (args) => {
        const result = pressKey(args.key, args.repeat || 1);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_scroll',
      description: 'Scroll at a specific screen position. Direction can be "up" or "down". Amount is number of scroll units (default 3).',
      inputSchema: z.object({ x: z.number(), y: z.number(), direction: z.enum(['up', 'down']), amount: z.number().min(1).max(20).optional() }),
      call: async (args) => {
        const result = scroll(args.x, args.y, args.direction, args.amount || 3);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_cursor_position',
      description: 'Get the current cursor position on screen.',
      inputSchema: z.object({}),
      call: async () => {
        const result = getCursorPosition();
        return { content: [{ type: 'text', text: result }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
    buildTool({
      name: 'desktop_read_clipboard',
      description: 'Read the current text content of the system clipboard.',
      inputSchema: z.object({}),
      call: async () => {
        const result = readClipboard();
        return { content: [{ type: 'text', text: result }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
    buildTool({
      name: 'desktop_write_clipboard',
      description: 'Write text to the system clipboard.',
      inputSchema: z.object({ text: z.string() }),
      call: async (args) => {
        const result = writeClipboard(args.text);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_open_app',
      description: 'Open or bring to front a desktop application by name.',
      inputSchema: z.object({ app_name: z.string().min(1) }),
      call: async (args) => {
        const result = openApp(args.app_name);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
    buildTool({
      name: 'desktop_wait',
      description: 'Wait for a specified number of seconds. Use when waiting for an app to load or animation to complete.',
      inputSchema: z.object({ seconds: z.number().min(0).max(30) }),
      call: async (args) => {
        const result = waitSeconds(args.seconds);
        return { content: [{ type: 'text', text: result }] };
      },
    }),
  ];
}
