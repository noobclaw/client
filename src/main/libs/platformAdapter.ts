/**
 * Platform Adapter — abstracts Electron-specific APIs.
 * In Electron mode: uses real Electron APIs.
 * In Tauri sidecar mode: uses Node.js equivalents.
 *
 * This allows CoworkRunner and other libs to work in both modes.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

// ── Mode detection ──

let _mode: 'electron' | 'sidecar' | null = null;

export function getPlatformMode(): 'electron' | 'sidecar' {
  if (_mode) return _mode;

  try {
    // If we can import electron's app module, we're in Electron
    require('electron');
    _mode = 'electron';
  } catch {
    _mode = 'sidecar';
  }
  return _mode;
}

export function isElectronMode(): boolean {
  return getPlatformMode() === 'electron';
}

export function isSidecarMode(): boolean {
  return getPlatformMode() === 'sidecar';
}

// ── app.getPath() equivalent ──

export function getUserDataPath(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getPath('userData');
    } catch {}
  }

  // Sidecar fallback: standard OS paths
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NoobClaw');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'NoobClaw');
  }
  return path.join(os.homedir(), '.noobclaw');
}

// ── app.getPath('home') equivalent ──

export function getHomePath(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getPath('home');
    } catch {}
  }
  return os.homedir();
}

// ── app.getName() equivalent ──

export function getAppName(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getName();
    } catch {}
  }
  return 'NoobClaw';
}

// ── app.isPackaged equivalent ──

export function isPackaged(): boolean {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.isPackaged;
    } catch {}
  }
  // Sidecar: always "packaged" (running as compiled binary)
  return true;
}

// ── app.getAppPath() equivalent ──

export function getAppPath(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getAppPath();
    } catch {}
  }
  // Sidecar: use process.cwd() or __dirname
  return process.cwd();
}

// ── resourcesPath equivalent ──

export function getResourcesPath(): string {
  if (isElectronMode()) {
    try {
      return process.resourcesPath || getAppPath();
    } catch {}
  }
  // Sidecar: resources are relative to the binary
  return path.resolve(process.execPath, '..');
}

// ── shell.openExternal() equivalent ──

export async function openExternal(url: string): Promise<boolean> {
  if (isElectronMode()) {
    try {
      const { shell } = require('electron');
      await shell.openExternal(url);
      return true;
    } catch {}
  }

  // Sidecar fallback: use OS-specific commands
  try {
    if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { windowsHide: true });
    } else if (process.platform === 'darwin') {
      execSync(`open "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Ensure data directories exist ──

export function ensureDataDirs(): void {
  const dirs = [
    getUserDataPath(),
    path.join(getUserDataPath(), 'logs'),
    path.join(getUserDataPath(), 'cowork'),
    path.join(getUserDataPath(), 'cowork', 'bin'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
