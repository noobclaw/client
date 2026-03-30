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

const extensionPromptTexts: Record<string, {
  title: string; installMsg: string; installDetail: string;
  reconnectMsg: string; reconnectDetail: string;
  btnLocal: string; btnStore: string; btnNotNow: string;
  btnSettings: string; btnCancel: string;
}> = {
  en: {
    title: 'NoobClaw Browser Assistant',
    installMsg: 'Enable AI Browser Automation',
    installDetail: 'Install the NoobClaw Browser Assistant to let AI control your browser just like a human — clicking, typing, scrolling, and navigating websites using your real Chrome with all your login sessions.\n\n• AI operates your browser like a real person — no bot detection\n• Works with your logged-in accounts (social media, email, etc.)\n• 24/7 automated browsing, data collection, and form filling\n• All data stays local, nothing is sent to external servers',
    reconnectMsg: 'Chrome Extension Not Connected',
    reconnectDetail: 'The extension is installed but Chrome is not connected. Make sure Chrome is running with the NoobClaw extension enabled.',
    btnLocal: 'Install with Local Extension',
    btnStore: 'Install from Chrome Store',
    btnNotNow: 'Not now',
    btnSettings: 'Open Extension Settings',
    btnCancel: 'Cancel',
  },
  zh: {
    title: 'NoobClaw 浏览器助手',
    installMsg: '启用 AI 浏览器自动化',
    installDetail: '安装 NoobClaw 浏览器助手，让 AI 像真人一样操控您的浏览器 — 点击、输入、滚动、导航网页，使用您真实的 Chrome 及所有登录状态。\n\n• AI 像真人一样操作浏览器 — 不会被网站检测\n• 使用您已登录的账号（社交媒体、邮箱等）\n• 全天候 24 小时自动化浏览、数据采集和表单填写\n• 所有数据留在本地，不会发送到外部服务器',
    reconnectMsg: 'Chrome 扩展未连接',
    reconnectDetail: '扩展已安装但 Chrome 未连接。请确保 Chrome 正在运行且 NoobClaw 扩展已启用。',
    btnLocal: '一键安装本地扩展',
    btnStore: '从 Chrome 商店安装',
    btnNotNow: '暂不安装',
    btnSettings: '打开扩展设置',
    btnCancel: '取消',
  },
  'zh-TW': {
    title: 'NoobClaw 瀏覽器助手',
    installMsg: '啟用 AI 瀏覽器自動化',
    installDetail: '安裝 NoobClaw 瀏覽器助手，讓 AI 像真人一樣操控您的瀏覽器。\n\n• AI 像真人一樣操作瀏覽器 — 不會被網站偵測\n• 使用您已登入的帳號\n• 全天候 24 小時自動化瀏覽\n• 所有資料留在本地',
    reconnectMsg: 'Chrome 擴充功能未連線',
    reconnectDetail: '擴充功能已安裝但 Chrome 未連線。請確保 Chrome 正在運行且 NoobClaw 擴充功能已啟用。',
    btnLocal: '一鍵安裝本地擴充功能',
    btnStore: '從 Chrome 商店安裝',
    btnNotNow: '暫不安裝',
    btnSettings: '開啟擴充功能設定',
    btnCancel: '取消',
  },
  ja: {
    title: 'NoobClaw ブラウザアシスタント',
    installMsg: 'AIブラウザ自動化を有効にする',
    installDetail: 'NoobClaw ブラウザアシスタントをインストールして、AIに実際のChromeブラウザを操作させましょう。\n\n• ボット検知なし\n• ログイン済みアカウントで動作\n• 24時間自動化\n• データはすべてローカル',
    reconnectMsg: 'Chrome拡張機能が未接続',
    reconnectDetail: '拡張機能はインストール済みですが、Chromeが接続されていません。',
    btnLocal: 'ローカル拡張機能をインストール',
    btnStore: 'Chrome ストアからインストール',
    btnNotNow: '後で',
    btnSettings: '拡張機能の設定を開く',
    btnCancel: 'キャンセル',
  },
  ko: {
    title: 'NoobClaw 브라우저 어시스턴트',
    installMsg: 'AI 브라우저 자동화 활성화',
    installDetail: 'NoobClaw 브라우저 어시스턴트를 설치하여 AI가 실제 Chrome 브라우저를 사람처럼 제어하도록 하세요.\n\n• 봇 탐지 없음\n• 로그인된 계정으로 작동\n• 24시간 자동화\n• 모든 데이터는 로컬에 저장',
    reconnectMsg: 'Chrome 확장 프로그램 미연결',
    reconnectDetail: '확장 프로그램이 설치되었지만 Chrome이 연결되지 않았습니다.',
    btnLocal: '로컬 확장 프로그램 설치',
    btnStore: 'Chrome 스토어에서 설치',
    btnNotNow: '나중에',
    btnSettings: '확장 프로그램 설정 열기',
    btnCancel: '취소',
  },
};

function getPromptTexts() {
  const locale = app.getLocale().toLowerCase();
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hant')) return extensionPromptTexts['zh-TW'];
  if (locale.startsWith('zh')) return extensionPromptTexts.zh;
  if (locale.startsWith('ja')) return extensionPromptTexts.ja;
  if (locale.startsWith('ko')) return extensionPromptTexts.ko;
  return extensionPromptTexts.en;
}

export async function showExtensionPrompt(): Promise<void> {
  const status = getBrowserBridgeStatus();
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  const t = getPromptTexts();

  if (!status.extensionInstalled) {
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: t.title,
      message: t.installMsg,
      detail: t.installDetail,
      buttons: [t.btnLocal, t.btnStore, t.btnNotNow],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 0) {
      launchChromeWithExtension();
    } else if (result.response === 1) {
      shell.openExternal(CHROME_STORE_URL);
    }
  } else if (!status.connected) {
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: t.title,
      message: t.reconnectMsg,
      detail: t.reconnectDetail,
      buttons: [t.btnLocal, t.btnSettings, t.btnCancel],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 0) {
      launchChromeWithExtension();
    } else if (result.response === 1) {
      shell.openExternal(`chrome-extension://${EXTENSION_IDS[0]}/popup.html`);
    }
  }
}

function launchChromeWithExtension(): void {
  const { execFile } = require('child_process');
  const extensionPath = path.join(app.getAppPath(), '..', 'chrome-extension');

  if (process.platform === 'win32') {
    // Try common Chrome paths on Windows
    const chromePaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const chromePath = chromePaths.find(p => fs.existsSync(p));
    if (chromePath) {
      execFile(chromePath, [`--load-extension=${extensionPath}`], { detached: true, stdio: 'ignore' });
    } else {
      shell.openExternal('https://www.google.com/chrome/');
    }
  } else if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    try {
      execSync(`open -a "Google Chrome" --args --load-extension="${extensionPath}"`, { stdio: 'ignore' });
    } catch {
      shell.openExternal('https://www.google.com/chrome/');
    }
  } else {
    const { execSync } = require('child_process');
    try {
      execSync(`google-chrome --load-extension="${extensionPath}" &`, { stdio: 'ignore' });
    } catch {
      shell.openExternal('https://www.google.com/chrome/');
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
