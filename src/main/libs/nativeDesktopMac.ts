/**
 * Native Desktop macOS — bridge to optional Swift native module.
 * Provides fast SCContentFilter screenshots, smooth 60fps mouse animation,
 * and clipboard verification (clipboard guard).
 *
 * Reference: Claude Code @ant/computer-use-swift + @ant/computer-use-input
 *
 * This module tries to load a pre-compiled native addon.
 * If the addon is not available (not compiled, wrong platform), all functions
 * return null and the caller (desktopControlMcp.ts) falls back to
 * the existing spawnSync(osascript/Python) approach.
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export interface NativeScreenshotResult {
  data: Buffer;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
}

export interface NativeDesktopModule {
  screenshot(options?: { quality?: number; format?: string }): NativeScreenshotResult;
  mouseMove(x: number, y: number, options?: { durationMs?: number; easing?: string }): void;
  mouseClick(x: number, y: number, button?: string, clickCount?: number): void;
  mouseDrag(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void;
  keyType(text: string): void;
  keyPress(key: string, modifiers?: string[]): void;
  clipboardGet(): string;
  clipboardSet(text: string): void;
  clipboardVerify(expected: string): boolean;
  getActiveWindow(): { title: string; bundleId: string; pid: number } | null;
  listWindows(): Array<{ title: string; bundleId: string; pid: number }>;
}

// ── Native module loading (graceful fallback) ──

let nativeModule: NativeDesktopModule | null = null;
let loadAttempted = false;

/**
 * Try to load the native macOS desktop module.
 * Returns null if:
 * - Not on macOS
 * - Module not compiled/installed
 * - Module load fails
 */
export function loadNativeDesktopModule(): NativeDesktopModule | null {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;

  if (process.platform !== 'darwin') {
    coworkLog('INFO', 'nativeDesktopMac', 'Not macOS, skipping native module');
    return null;
  }

  try {
    // Try to load the native addon
    // Build path: native/macos-desktop/build/Release/noobclaw_desktop.node
    const path = require('path');
    const possiblePaths = [
      path.join(__dirname, '..', '..', '..', 'native', 'macos-desktop', 'build', 'Release', 'noobclaw_desktop.node'),
      path.join(process.resourcesPath || '', 'native', 'noobclaw_desktop.node'),
    ];

    for (const modulePath of possiblePaths) {
      try {
        const fs = require('fs');
        if (fs.existsSync(modulePath)) {
          nativeModule = require(modulePath) as NativeDesktopModule;
          coworkLog('INFO', 'nativeDesktopMac', `Native module loaded from ${modulePath}`);
          return nativeModule;
        }
      } catch (e) {
        coworkLog('WARN', 'nativeDesktopMac', `Failed to load from ${modulePath}: ${e}`);
      }
    }

    coworkLog('INFO', 'nativeDesktopMac', 'Native module not found, will use fallback (osascript/Python)');
    return null;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopMac', `Native module load error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Convenience accessors ──

export function hasNativeDesktop(): boolean {
  return loadNativeDesktopModule() !== null;
}

export function getNativeDesktop(): NativeDesktopModule | null {
  return loadNativeDesktopModule();
}

/**
 * Take a native screenshot (SCContentFilter).
 * Returns null if native module not available — caller should use screencapture CLI.
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
 * Smooth 60fps mouse movement (ease-out-cubic).
 * Returns false if native module not available.
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
 * Clipboard guard: verify clipboard content after paste.
 * Returns null if native module not available.
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
