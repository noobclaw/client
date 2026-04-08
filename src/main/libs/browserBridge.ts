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
import { isElectronMode, getUserDataPath, getAppPath, getResourcesPath, openExternal } from './platformAdapter';

// Conditionally load Electron modules — unavailable in sidecar mode
let app: any = null;
let BrowserWindow: any = null;
let dialog: any = null;
let shell: any = null;
try {
  if (isElectronMode()) {
    const electron = require('electron');
    app = electron.app;
    BrowserWindow = electron.BrowserWindow;
    dialog = electron.dialog;
    shell = electron.shell;
  }
} catch {}

const NATIVE_HOST_NAME = 'com.noobclaw.browser';
const TCP_PORT = 12581;
const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/noobclaw-browser-assistant/dhmjehcfpjjliiknpahbnflgljinjdeo';
const EDGE_STORE_URL = 'https://microsoftedge.microsoft.com/addons/detail/noobclaw-browser-assistant/';
const FIREFOX_STORE_URL = 'https://addons.mozilla.org/addon/noobclaw-browser-assistant/';
const EXTENSION_IDS = [
  'dhmjehcfpjjliiknpahbnflgljinjdeo',  // Fixed ID (key in manifest.json)
];

type BrowserType = 'chrome' | 'edge' | 'firefox';

interface DetectedBrowser {
  type: BrowserType;
  name: string;
  path: string;
  storeUrl: string;
}

function detectBrowsers(): DetectedBrowser[] {
  const browsers: DetectedBrowser[] = [];

  if (process.platform === 'win32') {
    const chromePaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const edgePaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    const firefoxPaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Mozilla Firefox', 'firefox.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Mozilla Firefox', 'firefox.exe'),
    ];

    const chromePath = chromePaths.find(p => fs.existsSync(p));
    if (chromePath) browsers.push({ type: 'chrome', name: 'Google Chrome', path: chromePath, storeUrl: CHROME_STORE_URL });

    const edgePath = edgePaths.find(p => fs.existsSync(p));
    if (edgePath) browsers.push({ type: 'edge', name: 'Microsoft Edge', path: edgePath, storeUrl: EDGE_STORE_URL });

    const firefoxPath = firefoxPaths.find(p => fs.existsSync(p));
    if (firefoxPath) browsers.push({ type: 'firefox', name: 'Firefox', path: firefoxPath, storeUrl: FIREFOX_STORE_URL });

  } else if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/Google Chrome.app')) {
      browsers.push({ type: 'chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app', storeUrl: CHROME_STORE_URL });
    }
    if (fs.existsSync('/Applications/Microsoft Edge.app')) {
      browsers.push({ type: 'edge', name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app', storeUrl: EDGE_STORE_URL });
    }
    if (fs.existsSync('/Applications/Firefox.app')) {
      browsers.push({ type: 'firefox', name: 'Firefox', path: '/Applications/Firefox.app', storeUrl: FIREFOX_STORE_URL });
    }
  } else {
    // Linux
    const { execSync } = require('child_process');
    try { execSync('which google-chrome', { stdio: 'pipe' }); browsers.push({ type: 'chrome', name: 'Google Chrome', path: 'google-chrome', storeUrl: CHROME_STORE_URL }); } catch {}
    try { execSync('which microsoft-edge', { stdio: 'pipe' }); browsers.push({ type: 'edge', name: 'Microsoft Edge', path: 'microsoft-edge', storeUrl: EDGE_STORE_URL }); } catch {}
    try { execSync('which firefox', { stdio: 'pipe' }); browsers.push({ type: 'firefox', name: 'Firefox', path: 'firefox', storeUrl: FIREFOX_STORE_URL }); } catch {}
  }

  return browsers; // Chrome first by default
}

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

function getNativeHostManifestPaths(): { browser: BrowserType; manifestPath: string; regKey?: string }[] {
  const home = process.env.HOME || '~';
  const results: { browser: BrowserType; manifestPath: string; regKey?: string }[] = [];

  if (process.platform === 'win32') {
    const basePath = path.join(app.getPath('userData'), `${NATIVE_HOST_NAME}.json`);
    results.push(
      { browser: 'chrome', manifestPath: basePath, regKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}` },
      { browser: 'edge', manifestPath: basePath, regKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}` },
    );
  } else if (process.platform === 'darwin') {
    results.push(
      { browser: 'chrome', manifestPath: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`) },
      { browser: 'edge', manifestPath: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`) },
      { browser: 'firefox', manifestPath: path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`) },
    );
  } else {
    results.push(
      { browser: 'chrome', manifestPath: path.join(home, '.config/google-chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`) },
      { browser: 'edge', manifestPath: path.join(home, '.config/microsoft-edge/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`) },
      { browser: 'firefox', manifestPath: path.join(home, '.mozilla/native-messaging-hosts', `${NATIVE_HOST_NAME}.json`) },
    );
  }

  return results;
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
    const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), 'resources');
    const jsSource = path.join(resourcesPath, 'native-messaging-host.js');

    // Create batch/shell wrapper
    if (process.platform === 'win32') {
      const nodeExe = path.join(resourcesPath, 'node-runtime', 'node.exe');
      fs.writeFileSync(hostScriptPath, `@echo off\r\n"${nodeExe}" "${jsSource}" %*\r\n`);
    } else {
      // macOS/Linux: find a working node binary
      // Priority: 1) bundled node-runtime  2) Electron's own node  3) system node
      let nodeExe = path.join(resourcesPath, 'node-runtime', 'node');
      if (!fs.existsSync(nodeExe)) {
        // Electron's node binary (inside the .app bundle on macOS)
        const electronNode = process.execPath;
        // Check if system node is available as a more reliable option for Native Messaging
        const { execSync } = require('child_process');
        try {
          const systemNode = execSync('which node', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          if (systemNode && fs.existsSync(systemNode)) {
            nodeExe = systemNode;
          } else {
            nodeExe = electronNode;
          }
        } catch {
          nodeExe = electronNode;
        }
      }
      fs.writeFileSync(hostScriptPath, `#!/bin/bash\nexec "${nodeExe}" "${jsSource}" "$@"\n`);
      try { fs.chmodSync(hostScriptPath, '755'); } catch {}
      if (fs.existsSync(nodeExe)) {
        try { fs.chmodSync(nodeExe, '755'); } catch {}
      }
    }

    // Register for all browsers
    const allPaths = getNativeHostManifestPaths();
    const { execSync } = require('child_process');

    for (const { browser, manifestPath, regKey } of allPaths) {
      try {
        // Firefox uses "allowed_extensions" instead of "allowed_origins"
        const manifest: any = {
          name: NATIVE_HOST_NAME,
          description: 'NoobClaw Browser Assistant Native Messaging Host',
          path: hostScriptPath,
          type: 'stdio',
        };
        if (browser === 'firefox') {
          manifest.allowed_extensions = ['noobclaw-browser-assistant@noobclaw.com'];
        } else {
          manifest.allowed_origins = EXTENSION_IDS.map(id => `chrome-extension://${id}/`);
        }

        const manifestDir = path.dirname(manifestPath);
        if (!fs.existsSync(manifestDir)) {
          fs.mkdirSync(manifestDir, { recursive: true });
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        // Windows: write registry key for Chrome and Edge
        if (process.platform === 'win32' && regKey) {
          try {
            execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'ignore' });
          } catch {}
        }

        console.log(`[BrowserBridge] Registered native messaging host for ${browser}: ${manifestPath}`);
      } catch (err) {
        console.error(`[BrowserBridge] Failed to register for ${browser}:`, err);
      }
    }
  } catch (err) {
    console.error('[BrowserBridge] Failed to register native messaging host:', err);
  }
}

function isNativeHostRegistered(): boolean {
  const allPaths = getNativeHostManifestPaths();
  for (const { manifestPath, regKey } of allPaths) {
    try {
      if (process.platform === 'win32' && regKey) {
        const { execSync } = require('child_process');
        const result = execSync(`reg query "${regKey}" /ve`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
        if (result.includes(NATIVE_HOST_NAME)) return true;
      } else if (fs.existsSync(manifestPath)) {
        return true;
      }
    } catch {}
  }
  return false;
}

// --- Extension Installation Detection ---

const extensionPromptTexts: Record<string, Record<string, string>> = {
  en: {
    title: 'NoobClaw Browser Assistant',
    installMsg: 'Enable AI Browser Automation',
    installDetail: 'Install the NoobClaw Browser Assistant to let AI control your browser just like a human — clicking, typing, scrolling, and navigating websites using your real browser with all your login sessions.\n\n• AI operates your browser like a real person — no bot detection\n• Works with your logged-in accounts (social media, email, etc.)\n• 24/7 automated browsing, data collection, and form filling\n• All data stays local, nothing is sent to external servers',
    btnStore: 'Install from Chrome Store',
    btnLocal: 'Install Local Extension',
    btnNotNow: 'Not now',
    btnCancel: 'Cancel',
    noBrowserMsg: 'No supported browser found',
    noBrowserDetail: 'NoobClaw Browser Assistant requires Chrome, Edge, or Firefox. Please install Google Chrome first.',
    btnDownloadChrome: 'Download Chrome',
    guideMsg: 'Install Browser Extension',
    guideDetail: 'The extension path has been copied to your clipboard.\n\nPlease follow these steps:\n1. Open Chrome browser, type chrome://extensions/ in the address bar and press Enter\n2. Turn on "Developer mode" (top right corner)\n3. Click "Load unpacked"\n4. Paste the path (already copied) and confirm\n\nPath: {path}',
  },
  zh: {
    title: 'NoobClaw 浏览器助手',
    installMsg: '启用 AI 浏览器自动化',
    installDetail: '安装 NoobClaw 浏览器助手，让 AI 像真人一样操控您的浏览器 — 点击、输入、滚动、导航网页，使用您真实的浏览器及所有登录状态。\n\n• AI 像真人一样操作浏览器 — 不会被网站检测\n• 使用您已登录的账号（社交媒体、邮箱等）\n• 全天候 24 小时自动化浏览、数据采集和表单填写\n• 所有数据留在本地，不会发送到外部服务器',
    btnStore: '从Chrome商店安装',
    btnLocal: '安装本地扩展',
    btnNotNow: '暂不安装',
    btnCancel: '取消',
    noBrowserMsg: '未检测到支持的浏览器',
    noBrowserDetail: 'NoobClaw 浏览器助手需要 Chrome、Edge 或 Firefox。请先下载安装 Google Chrome。',
    btnDownloadChrome: '下载 Chrome',
    guideMsg: '安装浏览器扩展',
    guideDetail: '扩展路径已复制到剪贴板。\n\n请按以下步骤操作：\n1. 打开 Chrome 浏览器，在地址栏输入 chrome://extensions/ 并回车\n2. 打开右上角「开发者模式」开关\n3. 点击「加载已解压的扩展程序」\n4. 在路径栏粘贴（已复制到剪贴板）并确认\n\n路径：{path}',
  },
  'zh-TW': {
    title: 'NoobClaw 瀏覽器助手',
    installMsg: '啟用 AI 瀏覽器自動化',
    installDetail: '安裝 NoobClaw 瀏覽器助手，讓 AI 像真人一樣操控您的瀏覽器。\n\n• 不會被網站偵測\n• 使用您已登入的帳號\n• 全天候自動化\n• 資料留在本地',
    btnStore: '從Chrome商店安裝',
    btnLocal: '安裝本地擴充功能',
    btnNotNow: '暫不安裝',
    btnCancel: '取消',
    noBrowserMsg: '未偵測到支援的瀏覽器',
    noBrowserDetail: '請先下載安裝 Google Chrome。',
    btnDownloadChrome: '下載 Chrome',
    guideMsg: '擴充功能頁面已開啟',
    guideDetail: '擴展路徑已複製到剪貼簿。\n\n請按以下步驟操作：\n1. 打開 Chrome 瀏覽器，在地址欄輸入 chrome://extensions/ 並按 Enter\n2. 開啟右上角「開發人員模式」\n3. 點擊「載入未封裝項目」\n4. 貼上路徑（已複製到剪貼簿）並確認\n\n路徑：{path}',
  },
  ja: {
    title: 'NoobClaw ブラウザアシスタント',
    installMsg: 'AIブラウザ自動化を有効にする',
    installDetail: 'AIにブラウザを操作させましょう。\n\n• ボット検知なし\n• ログイン済みアカウントで動作\n• 24時間自動化\n• データはローカル',
    btnStore: 'Chromeストアからインストール',
    btnLocal: 'ローカル拡張機能をインストール',
    btnNotNow: '後で',
    btnCancel: 'キャンセル',
    noBrowserMsg: '対応ブラウザが見つかりません',
    noBrowserDetail: 'Google Chromeをインストールしてください。',
    btnDownloadChrome: 'Chromeをダウンロード',
    guideMsg: '拡張機能ページを開きました',
    guideDetail: 'パスはクリップボードにコピー済みです。\n\n手順：\n1. Chrome ブラウザを開き、アドレスバーに chrome://extensions/ と入力して Enter\n2. 右上の「デベロッパーモード」をオン\n3. 「パッケージ化されていない拡張機能を読み込む」をクリック\n4. パスを貼り付けて確認\n\nパス：{path}',
  },
  ko: {
    title: 'NoobClaw 브라우저 어시스턴트',
    installMsg: 'AI 브라우저 자동화 활성화',
    installDetail: 'AI가 브라우저를 사람처럼 제어합니다.\n\n• 봇 탐지 없음\n• 로그인 계정으로 작동\n• 24시간 자동화\n• 로컬 저장',
    btnStore: 'Chrome 스토어에서 설치',
    btnLocal: '로컬 확장 프로그램 설치',
    btnNotNow: '나중에',
    btnCancel: '취소',
    noBrowserMsg: '지원 브라우저를 찾을 수 없습니다',
    noBrowserDetail: 'Google Chrome을 설치해 주세요.',
    btnDownloadChrome: 'Chrome 다운로드',
    guideMsg: '확장 프로그램 페이지 열림',
    guideDetail: '경로가 클립보드에 복사되었습니다.\n\n다음 단계를 따르세요:\n1. Chrome 브라우저를 열고 주소창에 chrome://extensions/ 입력 후 Enter\n2. 오른쪽 상단 "개발자 모드" 활성화\n3. "압축해제된 확장 프로그램을 로드합니다" 클릭\n4. 경로 붙여넣기(이미 복사됨) 후 확인\n\n경로: {path}',
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

/**
 * Show extension install prompt. Returns:
 * - 'installed': user chose to install
 * - 'cancelled': user chose "not now"
 */
export async function showExtensionPrompt(): Promise<'installed' | 'cancelled'> {
  const win = BrowserWindow?.getFocusedWindow?.();

  if (win && dialog) {
    // Electron mode: use native dialog
    const t = getPromptTexts();
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: t.title,
      message: t.installMsg,
      detail: t.installDetail,
      buttons: [t.btnStore, t.btnLocal, t.btnNotNow],
      defaultId: 0,
      cancelId: 2,
    });

    if (result.response === 0) {
      const browsers = detectBrowsers();
      const storeUrl = browsers.length > 0 ? browsers[0].storeUrl : CHROME_STORE_URL;
      shell?.openExternal?.(storeUrl) ?? openExternal(storeUrl);
      return 'installed';
    } else if (result.response === 1) {
      await installLocalExtension();
      return 'installed';
    }
    return 'cancelled';
  }

  // Sidecar/Tauri mode: open Chrome Web Store directly
  try {
    await openExternal(CHROME_STORE_URL);
  } catch {}
  return 'installed';
}

/**
 * Check if extension is actually installed by looking at Chrome's extension directory
 */
export function isExtensionInstalled(): boolean {
  const EXTENSION_ID = 'dhmjehcfpjjliiknpahbnflgljinjdeo';
  try {
    const homeDir = require('os').homedir();
    let extDirs: string[] = [];
    if (process.platform === 'win32') {
      extDirs = [
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', EXTENSION_ID),
        path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions', EXTENSION_ID),
      ];
    } else if (process.platform === 'darwin') {
      extDirs = [
        path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions', EXTENSION_ID),
        path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Extensions', EXTENSION_ID),
      ];
    } else {
      extDirs = [
        path.join(homeDir, '.config', 'google-chrome', 'Default', 'Extensions', EXTENSION_ID),
        path.join(homeDir, '.config', 'microsoft-edge', 'Default', 'Extensions', EXTENSION_ID),
      ];
    }
    return extDirs.some(dir => fs.existsSync(dir));
  } catch { return false; }
}

async function installLocalExtension(): Promise<void> {
  const { clipboard } = require('electron');
  const browsers = detectBrowsers();
  const win = BrowserWindow.getFocusedWindow();
  const t = getPromptTexts();

  if (browsers.length === 0) {
    if (win) {
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: t.title,
        message: t.noBrowserMsg,
        detail: t.noBrowserDetail,
        buttons: [t.btnDownloadChrome, t.btnCancel],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) {
        shell.openExternal('https://www.google.com/chrome/');
      }
    }
    return;
  }

  // Get extension path
  const extensionPath = path.join(
    process.resourcesPath || path.join(app.getAppPath(), '..'),
    'chrome-extension'
  );

  // Copy path to clipboard
  clipboard.writeText(extensionPath);

  // Open chrome://extensions page
  const browser = browsers[0];
  const extensionsUrl = browser.type === 'firefox'
    ? 'about:debugging#/runtime/this-firefox'
    : browser.type === 'edge'
      ? 'edge://extensions'
      : 'chrome://extensions';

  if (process.platform === 'win32') {
    const { execFile } = require('child_process');
    execFile(browser.path, [extensionsUrl], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    try { execSync(`open -a "${browser.path}" "${extensionsUrl}"`, { stdio: 'ignore' }); } catch {}
  } else {
    const { execFile } = require('child_process');
    try { execFile(browser.path, [extensionsUrl], { detached: true, stdio: 'ignore' }); } catch {}
  }

  // Show instructions
  if (win) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: t.title,
      message: t.guideMsg,
      detail: t.guideDetail.replace('{path}', extensionPath),
      buttons: ['OK'],
    });
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
