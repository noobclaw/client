/**
 * Native Desktop macOS — bridge to the pre-compiled Objective-C++ addon
 * at `native/macos-desktop/src/noobclaw_desktop.mm`.
 *
 * Provides fast CGDisplayCreateImage screenshots, smooth 60fps CGEvent
 * mouse motion, real kernel-level keyboard input, clipboard verification,
 * and active-window / window list lookup — replacing the
 * spawnSync(osascript/screencapture/python3) fallbacks in
 * desktopControlMcp.ts when available.
 *
 * Build pipeline:
 *   1. CI macOS job runs `cd native/macos-desktop && node-gyp rebuild`.
 *   2. prepare-tauri-resources.js copies the resulting .node file to
 *      src-tauri/resources/native/noobclaw_desktop.node.
 *   3. Tauri bundles that into .app/Contents/Resources/resources/
 *      native/noobclaw_desktop.node via the `resources` glob.
 *   4. At runtime this loader walks a candidate list (favouring the
 *      Tauri .app path via getResourcesPath()) and require()s the
 *      first file that exists. Silent fallback to null on any error
 *      so the caller (desktopControlMcp) reverts to osascript/python.
 *
 * Runtime permissions: the OS prompts the user on first call:
 *   - Screen recording (screenshot)
 *   - Accessibility (mouseMove / mouseClick / keyPress to other apps)
 * See src-tauri/entitlements.plist for the matching hardened-runtime
 * entitlements.
 */

import path from 'path';
import fs from 'fs';
import { coworkLog } from './coworkLogger';
import { getResourcesPath } from './platformAdapter';

// ── Types ──

export interface NativeScreenshotResult {
  data: Buffer;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
}

export interface NativeWindowInfo {
  title: string;
  bundleId: string;
  pid: number;
}

export interface NativeDesktopModule {
  screenshot(options?: { quality?: number; format?: 'jpeg' | 'png' }): NativeScreenshotResult;
  mouseMove(x: number, y: number, options?: { durationMs?: number; easing?: string }): void;
  mouseClick(x: number, y: number, button?: 'left' | 'right' | 'middle', clickCount?: number): void;
  mouseDrag(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void;
  keyType(text: string): void;
  keyPress(key: string, modifiers?: string[]): void;
  clipboardGet(): string;
  clipboardSet(text: string): boolean;
  clipboardVerify(expected: string): boolean;
  getActiveWindow(): NativeWindowInfo | null;
  listWindows(): NativeWindowInfo[];
  isAccessibilityTrusted(options?: { prompt?: boolean }): boolean;
}

// ── Native module loading (graceful fallback) ──

let nativeModule: NativeDesktopModule | null = null;
let loadAttempted = false;

/**
 * Walk every plausible location for the compiled addon across the
 * layouts we ship in (Tauri prod .app, Tauri dev, Electron prod,
 * Electron dev) and return the first path that exists on disk.
 */
function candidateAddonPaths(): string[] {
  const exeDir = path.dirname(process.execPath);
  const resourcesDir = getResourcesPath();
  return [
    // Tauri prod — nested inside bundled resources
    path.join(resourcesDir, 'native', 'noobclaw_desktop.node'),
    path.join(resourcesDir, 'resources', 'native', 'noobclaw_desktop.node'),
    // macOS .app explicit sibling walk (belt-and-braces if
    // getResourcesPath ever returns a different parent)
    path.join(exeDir, '..', 'Resources', 'native', 'noobclaw_desktop.node'),
    path.join(exeDir, '..', 'Resources', 'resources', 'native', 'noobclaw_desktop.node'),
    // Next to the sidecar binary (last-resort flat layout)
    path.join(exeDir, 'native', 'noobclaw_desktop.node'),
    // Electron dev / repo checkout
    path.join(__dirname, '..', '..', '..', 'native', 'macos-desktop', 'build', 'Release', 'noobclaw_desktop.node'),
    path.join(__dirname, '..', '..', '..', '..', 'native', 'macos-desktop', 'build', 'Release', 'noobclaw_desktop.node'),
  ];
}

/**
 * Try to load the native macOS desktop module.
 * Returns null if not on macOS, if the addon isn't bundled, or if
 * require() throws. Idempotent — the result is cached after the first
 * attempt so we don't retry a known-missing file on every call.
 */
export function loadNativeDesktopModule(): NativeDesktopModule | null {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;

  if (process.platform !== 'darwin') {
    return null;
  }

  const tried: string[] = [];
  for (const candidate of candidateAddonPaths()) {
    tried.push(candidate);
    try {
      if (fs.existsSync(candidate)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(candidate) as NativeDesktopModule;
        // Smoke-check — the addon exports screenshot + mouseMove as its
        // bare minimum. If the file exists but is missing exports it's
        // a stale/half-built artifact and we'd rather fall back than
        // crash at first use.
        if (typeof (mod as any).screenshot === 'function'
          && typeof (mod as any).mouseMove === 'function') {
          nativeModule = mod;
          coworkLog('INFO', 'nativeDesktopMac', `Native module loaded from ${candidate}`);
          return nativeModule;
        }
        coworkLog('WARN', 'nativeDesktopMac', `Addon at ${candidate} is missing required exports, skipping`);
      }
    } catch (e: any) {
      coworkLog('WARN', 'nativeDesktopMac', `require(${candidate}) failed: ${e?.message || e}`);
    }
  }

  coworkLog('INFO', 'nativeDesktopMac', 'Native module not found, falling back to osascript/python. Tried: ' + tried.join(' | '));
  return null;
}

// ── Convenience accessors ──

export function hasNativeDesktop(): boolean {
  return loadNativeDesktopModule() !== null;
}

export function getNativeDesktop(): NativeDesktopModule | null {
  return loadNativeDesktopModule();
}

/**
 * Take a native screenshot. Returns null if native module not
 * available — caller should fall back to `screencapture` CLI.
 */
export function nativeScreenshot(quality: number = 0.75): Buffer | null {
  const mod = loadNativeDesktopModule();
  if (!mod) return null;
  try {
    const result = mod.screenshot({ quality, format: 'jpeg' });
    return result.data;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native screenshot failed: ${e}`);
    return null;
  }
}

/**
 * Smooth 60fps mouse movement (ease-out-cubic). Returns false if
 * native module not available.
 */
export function nativeMouseMove(x: number, y: number, durationMs: number = 300): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    mod.mouseMove(x, y, { durationMs, easing: 'ease-out-cubic' });
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native mouse move failed: ${e}`);
    return false;
  }
}

/**
 * CGEvent mouse click. Returns false if native module not available.
 */
export function nativeMouseClick(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  clicks: number = 1,
): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    mod.mouseClick(x, y, button, clicks);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native mouse click failed: ${e}`);
    return false;
  }
}

/**
 * CGEvent drag (press at x1,y1, animate to x2,y2, release).
 */
export function nativeMouseDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number = 400,
): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    mod.mouseDrag(x1, y1, x2, y2, durationMs);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native mouse drag failed: ${e}`);
    return false;
  }
}

/**
 * Type unicode text via CGEventKeyboardSetUnicodeString. Returns false
 * if native module not available.
 */
export function nativeKeyType(text: string): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    mod.keyType(text);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native key type failed: ${e}`);
    return false;
  }
}

/**
 * Press a named key (e.g. "enter", "f5", "a") with optional modifiers.
 * Returns false if native module not available.
 */
export function nativeKeyPress(key: string, modifiers: string[] = []): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    mod.keyPress(key, modifiers);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native key press failed: ${e}`);
    return false;
  }
}

/**
 * Clipboard guard: verify clipboard content. Returns null if native
 * module not available, true/false otherwise.
 */
export function nativeClipboardVerify(expected: string): boolean | null {
  const mod = loadNativeDesktopModule();
  if (!mod) return null;
  try {
    return mod.clipboardVerify(expected);
  } catch {
    return null;
  }
}

export function nativeClipboardGet(): string | null {
  const mod = loadNativeDesktopModule();
  if (!mod) return null;
  try {
    return mod.clipboardGet();
  } catch {
    return null;
  }
}

export function nativeClipboardSet(text: string): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    return mod.clipboardSet(text);
  } catch {
    return false;
  }
}

export function nativeGetActiveWindow(): NativeWindowInfo | null {
  const mod = loadNativeDesktopModule();
  if (!mod) return null;
  try {
    return mod.getActiveWindow();
  } catch {
    return null;
  }
}

export function nativeListWindows(): NativeWindowInfo[] | null {
  const mod = loadNativeDesktopModule();
  if (!mod) return null;
  try {
    return mod.listWindows();
  } catch {
    return null;
  }
}

/**
 * Check (and optionally prompt for) macOS Accessibility permission.
 * Without this, CGEvent input injection into other apps is silently
 * dropped by the WindowServer. Returns false if native module not
 * available.
 */
export function nativeIsAccessibilityTrusted(prompt: boolean = false): boolean {
  const mod = loadNativeDesktopModule();
  if (!mod) return false;
  try {
    return mod.isAccessibilityTrusted({ prompt });
  } catch {
    return false;
  }
}
