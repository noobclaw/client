/**
 * Browser Bridge — TCP server that connects to the Native Messaging Host
 * which bridges Chrome extension communication.
 *
 * Architecture:
 *   Chrome Extension <-> Native Messaging Host (stdin/stdout) <-> TCP <-> This bridge
 *
 * Also handles:
 *   - Native messaging host registration (registry on Windows, plist on macOS)
 *   - Extension installation detection
 */

import net from 'net';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { app, BrowserWindow, dialog, shell } from 'electron';

const NATIVE_HOST_NAME = 'com.noobclaw.browser';
const TCP_PORT = 12581;
const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/noobclaw-browser-assistant/dhmjehcfpjjliiknpahbnflgljinjdeo';
const EXTENSION_IDS = [
  'dhmjehcfpjjliiknpahbnflgljinjdeo',  // Chrome Web Store
  'nkgfcifmbbhjpegggaemohoedmcgklll',  // Local unpacked
];

let tcpServer: net.Server | null = null;
let clientSocket: net.Socket | null = null;
let bridgePort: number | null = null;

const pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// --- Status ---

export function getBrowserBridgeStatus(): {
  running: boolean;
  port: number | null;
  connected: boolean;
  extensionInstalled: boolean;
} {
  return {
    running: tcpServer !== null,
    port: bridgePort,
    connected: clientSocket !== null && !clientSocket.destroyed,
    extensionInstalled: isNativeHostRegistered(),
  };
}

// --- Native Messaging Host Registration ---

function getNativeHostManifestPath(): string {
  if (process.platform === 'win32') {
    // Windows: manifest can be anywhere, pointed to by registry
    return path.join(app.getPath('userData'), `${NATIVE_HOST_NAME}.json`);
  } else if (process.platform === 'darwin') {
    return path.join(
      process.env.HOME || '~',
      'Library/Application Support/Google/Chrome/NativeMessagingHosts',
      `${NATIVE_HOST_NAME}.json`
    );
  } else {
    // Linux
    return path.join(
      process.env.HOME || '~',
      '.config/google-chrome/NativeMessagingHosts',
      `${NATIVE_HOST_NAME}.json`
    );
  }
}

function getNativeHostScriptPath(): string {
  const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), 'resources');
  if (process.platform === 'win32') {
    return path.join(resourcesPath, 'native-messaging-host.bat');
  }
  // macOS/Linux: use shell wrapper script
  return path.join(resourcesPath, 'native-messaging-host.sh');
}

export function registerNativeMessagingHost(): void {
  try {
    const hostScriptPath = getNativeHostScriptPath();
    const manifestPath = getNativeHostManifestPath();

    // Create batch/shell wrapper (Chrome needs .bat/.exe on Windows, executable script on macOS/Linux)
    const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), 'resources');
    const jsSource = path.join(resourcesPath, 'native-messaging-host.js');

    if (process.platform === 'win32') {
      const nodeExe = path.join(resourcesPath, 'node-runtime', 'node.exe');
      const batPath = hostScriptPath;
      // Always rewrite to ensure correct paths
      fs.writeFileSync(batPath, `@echo off\r\n"${nodeExe}" "${jsSource}" %*\r\n`);
    } else {
      // macOS/Linux: create shell wrapper that uses bundled Node.js
      const nodeExe = path.join(resourcesPath, 'node-runtime', 'node');
      const shPath = hostScriptPath;
      fs.writeFileSync(shPath, `#!/bin/bash\n"${nodeExe}" "${jsSource}" "$@"\n`);
      try {
        fs.chmodSync(shPath, '755');
        fs.chmodSync(nodeExe, '755');
      } catch {}
    }

    // Create manifest
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: 'NoobClaw Browser Assistant Native Messaging Host',
      path: hostScriptPath,
      type: 'stdio',
      allowed_origins: EXTENSION_IDS.map(id => `chrome-extension://${id}/`),
    };

    // Ensure directory exists
    const manifestDir = path.dirname(manifestPath);
    if (!fs.existsSync(manifestDir)) {
      fs.mkdirSync(manifestDir, { recursive: true });
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Windows: write registry key
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(
          `reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}" /ve /t REG_SZ /d "${manifestPath}" /f`,
          { stdio: 'ignore' }
        );
      } catch (err) {
        console.error('[BrowserBridge] Failed to register native messaging host in registry:', err);
      }
    }

    console.log(`[BrowserBridge] Native messaging host registered: ${manifestPath}`);
  } catch (err) {
    console.error('[BrowserBridge] Failed to register native messaging host:', err);
  }
}

function isNativeHostRegistered(): boolean {
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const result = execSync(
        `reg query "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}" /ve`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }
      );
      return result.includes(NATIVE_HOST_NAME);
    } else {
      const manifestPath = getNativeHostManifestPath();
      return fs.existsSync(manifestPath);
    }
  } catch {
    return false;
  }
}

// --- Extension Installation Detection ---

export function isExtensionInstalled(): boolean {
  return isNativeHostRegistered();
}

export async function showExtensionPrompt(): Promise<void> {
  const status = getBrowserBridgeStatus();
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;

  if (!status.extensionInstalled) {
    // Not installed — show install dialog
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'NoobClaw',
      message: 'Install NoobClaw in Chrome',
      detail: 'This allows NoobClaw to work with websites directly in your browser. Only grant "always allow" for sites you trust.',
      buttons: ['Open Chrome Web Store', 'Not now', "Don't ask again"],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      shell.openExternal(CHROME_STORE_URL);
    }
  } else if (!status.connected) {
    // Installed but not connected
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'NoobClaw',
      message: 'Check your NoobClaw Chrome extension',
      detail: 'The Chrome extension needs to be enabled and Chrome must be running. Open the extension settings to verify.',
      buttons: ['Open Extension Settings', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      shell.openExternal(`chrome-extension://${EXTENSION_IDS[0]}/popup.html`);
    }
  }
}

// --- TCP Server (for native messaging host connection) ---

export async function startBrowserBridge(): Promise<{ port: number }> {
  if (tcpServer) {
    return { port: bridgePort! };
  }

  // Register native messaging host on startup
  registerNativeMessagingHost();

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      console.log('[BrowserBridge] Native messaging host connected');

      // Replace any existing connection
      if (clientSocket && !clientSocket.destroyed) {
        clientSocket.destroy();
      }
      clientSocket = socket;

      // Notify renderer
      notifyBridgeStatus(true);
      fireConnectionListeners();

      let recvBuf = '';
      socket.on('data', (data) => {
        recvBuf += data.toString('utf8');
        let newlineIdx;
        while ((newlineIdx = recvBuf.indexOf('\n')) >= 0) {
          const line = recvBuf.slice(0, newlineIdx);
          recvBuf = recvBuf.slice(newlineIdx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);

            if (msg.type === 'pong') return;

            // Response to a command
            if (msg.id && pendingRequests.has(msg.id)) {
              const pending = pendingRequests.get(msg.id)!;
              clearTimeout(pending.timer);
              pendingRequests.delete(msg.id);
              if (msg.success) {
                pending.resolve(msg.data);
              } else {
                pending.reject(new Error(msg.error || 'Command failed'));
              }
            }
          } catch (err) {
            console.error('[BrowserBridge] Failed to parse message:', err);
          }
        }
      });

      socket.on('close', () => {
        console.log('[BrowserBridge] Native messaging host disconnected');
        if (clientSocket === socket) {
          clientSocket = null;
          notifyBridgeStatus(false);
        }
        // Reject all pending
        for (const [id, pending] of pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Extension disconnected'));
          pendingRequests.delete(id);
        }
      });

      socket.on('error', (err) => {
        console.error('[BrowserBridge] Socket error:', err.message);
      });
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    });

    server.on('listening', () => {
      const addr = server.address() as net.AddressInfo;
      bridgePort = addr.port;
      tcpServer = server;
      console.log(`[BrowserBridge] TCP bridge started on 127.0.0.1:${bridgePort}`);
      resolve({ port: bridgePort });
    });

    server.listen(TCP_PORT, '127.0.0.1');
  });
}

export async function stopBrowserBridge(): Promise<void> {
  if (!tcpServer) return;

  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Bridge shutting down'));
    pendingRequests.delete(id);
  }

  if (clientSocket && !clientSocket.destroyed) {
    clientSocket.destroy();
    clientSocket = null;
  }

  return new Promise((resolve) => {
    if (tcpServer) {
      tcpServer.close(() => {
        tcpServer = null;
        bridgePort = null;
        console.log('[BrowserBridge] Stopped');
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// --- Notify renderer ---

function notifyBridgeStatus(connected: boolean) {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('browser-bridge:status', { connected });
    }
  } catch {}
}

// --- Connection listeners (for auto-retry) ---

const connectionListeners: Array<() => void> = [];

export function onExtensionConnected(callback: () => void): () => void {
  connectionListeners.push(callback);
  return () => {
    const idx = connectionListeners.indexOf(callback);
    if (idx >= 0) connectionListeners.splice(idx, 1);
  };
}

function fireConnectionListeners() {
  const cbs = connectionListeners.splice(0);
  for (const cb of cbs) {
    try { cb(); } catch {}
  }
}

// --- Send command to extension ---

export function sendBrowserCommand(
  command: string,
  params: Record<string, any> = {},
  timeoutMs = 30000
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!clientSocket || clientSocket.destroyed) {
      reject(new Error('BROWSER_NOT_CONNECTED'));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Browser command "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

    clientSocket.write(JSON.stringify({ id, command, params }) + '\n');
  });
}
