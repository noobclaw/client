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
const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/noobclaw-browser-assistan/abchfdkiphahgkoalhnmlfpfmgkedigf';
const EDGE_STORE_URL = 'https://microsoftedge.microsoft.com/addons/detail/laphnggbfbalnemcgjcgmdjaaehldkbd';
const FIREFOX_STORE_URL = 'https://addons.mozilla.org/addon/noobclaw-browser-assistant/';
const EXTENSION_IDS = [
  // New Chrome Web Store listing ID (current, 2026-04)
  'abchfdkiphahgkoalhnmlfpfmgkedigf',
  // Legacy fixed ID (extensions with manifest.key) — kept so users who
  // still have the dev/sideload build keep working.
  'dhmjehcfpjjliiknpahbnflgljinjdeo',
  // Microsoft Edge Add-ons listing ID. Edge re-signs the CRX with
  // its own private key when accepting a submission without "key" in
  // manifest, so the runtime extension id is DIFFERENT from the
  // Chrome Web Store one even though the source code is identical.
  // Without this entry, Edge users' extensions can connect over TCP
  // but the native messaging host manifest's allowed_origins doesn't
  // accept their chrome-extension:// origin.
  'laphnggbfbalnemcgjcgmdjaaehldkbd',
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
let bridgePort: number | null = null;

// Multi-browser support (v2.4.9): each connected browser instance owns its
// own socket + cached open-tab URL list. Pre-2.4.9 we kept ONE clientSocket
// global and `if (clientSocket) clientSocket.destroy()` on each new connect
// — which meant logging into XHS in browser A and Twitter in browser B
// killed whichever connected first. Now we keep them all in a Map and
// route each command to the connection whose tabs match the requested
// `tabPattern`. Commands without a pattern fall back to whichever
// connection saw the most recent activity.
interface BrowserConn {
  id: string;
  socket: net.Socket;
  tabs: Array<{ id: number; url: string }>;
  /** Extension version reported in the `hello` message. Empty until the
   *  extension side rolls out v1.2.0+ (older versions don't send it). */
  extensionVersion: string;
  /** When this connection was accepted by the bridge. The renderer uses
   *  this to distinguish "extension still mid-handshake (just connected,
   *  hello not arrived yet)" from "extension is genuinely too old to send
   *  hello at all" — if connectedAt is more than ~5s ago and version is
   *  still empty, the extension predates the v1.2.0 hello protocol and
   *  the user must update. */
  connectedAt: number;
  lastActivityAt: number;
  /** Consecutive sendBrowserCommand timeouts on this conn. After 2 in a
   *  row the socket is considered dead and force-destroyed (the close
   *  handler then removes it from browserConns). Reset to 0 on every
   *  successful response. */
  consecutiveTimeouts: number;
}
const browserConns = new Map<string, BrowserConn>();
let connSeq = 0;

function isAnyBrowserConnected(): boolean {
  for (const c of browserConns.values()) {
    if (!c.socket.destroyed) return true;
  }
  return false;
}

/** Snapshot of every connected browser extension (for the renderer to
 *  detect outdated versions and prompt the user to update). Includes
 *  connectedAt so the renderer can distinguish "still handshaking" from
 *  "definitely too old to send hello at all" (1.1.0 etc.). */
export function getConnectedExtensions(): Array<{
  id: string;
  version: string;
  tabCount: number;
  connectedAt: number;
}> {
  const out: Array<{ id: string; version: string; tabCount: number; connectedAt: number }> = [];
  for (const c of browserConns.values()) {
    if (c.socket.destroyed) continue;
    out.push({
      id: c.id,
      // Empty string means the extension is so old it pre-dates the
      // hello-with-version protocol (i.e. < 1.2.0).
      version: c.extensionVersion || '',
      tabCount: c.tabs.length,
      connectedAt: c.connectedAt,
    });
  }
  return out;
}

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
    connected: isAnyBrowserConnected(),
    extensionInstalled: isNativeHostRegistered(),
  };
}

// --- Native Messaging Host Registration ---

function getNativeHostManifestPaths(): { browser: BrowserType; manifestPath: string; regKey?: string }[] {
  const home = process.env.HOME || '~';
  const results: { browser: BrowserType; manifestPath: string; regKey?: string }[] = [];

  if (process.platform === 'win32') {
    const basePath = path.join(getUserDataPath(), `${NATIVE_HOST_NAME}.json`);
    // Firefox MUST use a separate manifest file on Windows: Chrome/Edge use
    // `allowed_origins` (CRX-id list), Firefox uses `allowed_extensions`
    // (gecko id list). If we point all three at the same file, the last
    // iteration in the registration loop (line ~295) overwrites it with
    // only the firefox-shaped fields and Chrome/Edge silently lose their
    // allowed_origins → connectNative starts failing for the other browsers
    // with no obvious cause. Separate files, separate registry keys.
    const firefoxPath = path.join(getUserDataPath(), `${NATIVE_HOST_NAME}.firefox.json`);
    results.push(
      { browser: 'chrome', manifestPath: basePath, regKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}` },
      { browser: 'edge', manifestPath: basePath, regKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}` },
      { browser: 'firefox', manifestPath: firefoxPath, regKey: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}` },
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
  // The wrapper script (.bat / .sh) MUST live in a user-writable location.
  // registerNativeMessagingHost rewrites it on every startup so the
  // embedded process.execPath stays in sync with the current install
  // location (which changes whenever the user upgrades to a build at a
  // different install root — e.g. moving from D:\noobclaw to
  // C:\Program Files\NoobClaw on Windows). Putting it under
  // resourcesPath puts it under %ProgramFiles% on per-machine NSIS
  // installs, where the standard user has read+execute but NOT write,
  // so fs.writeFileSync throws EPERM and the entire register flow
  // aborts before Firefox / chrome / edge manifests get a chance to
  // land — see [BrowserBridge] EPERM in sidecar.log for the failure
  // signature. %APPDATA% (Windows) and ~/Library/Application Support
  // (macOS) / ~/.config (Linux) are always writable because that's
  // where Tauri/Electron store user data anyway.
  const userData = getUserDataPath();
  if (process.platform === 'win32') {
    return path.join(userData, 'native-messaging-host.bat');
  }
  // macOS/Linux: use shell wrapper script
  return path.join(userData, 'native-messaging-host.sh');
}

export function registerNativeMessagingHost(): void {
  try {
    const hostScriptPath = getNativeHostScriptPath();
    const resourcesPath = getResourcesPath();
    const jsSource = path.join(resourcesPath, 'native-messaging-host.js');
    console.log(`[BrowserBridge] registerNativeMessagingHost: resourcesPath=${resourcesPath}, hostScriptPath=${hostScriptPath}, execPath=${process.execPath}`);

    // In Tauri (sidecar) mode we ship neither a `node-runtime/` directory
    // nor the Electron executable. Invoke the sidecar binary itself with a
    // special `--native-messaging-host` flag — sidecar-server.ts branches on
    // this and runs the host loop without starting the HTTP server.
    const useSidecarAsHost = !isElectronMode() && process.platform !== undefined;

    // Create batch/shell wrapper
    if (process.platform === 'win32') {
      if (useSidecarAsHost) {
        // process.execPath is the sidecar .exe in Tauri mode.
        fs.writeFileSync(hostScriptPath, `@echo off\r\n"${process.execPath}" --native-messaging-host %*\r\n`);
      } else {
        const nodeExe = path.join(resourcesPath, 'node-runtime', 'node.exe');
        fs.writeFileSync(hostScriptPath, `@echo off\r\n"${nodeExe}" "${jsSource}" %*\r\n`);
      }
    } else {
      // macOS/Linux
      if (useSidecarAsHost) {
        fs.writeFileSync(hostScriptPath, `#!/bin/bash\nexec "${process.execPath}" --native-messaging-host "$@"\n`);
        try { fs.chmodSync(hostScriptPath, '755'); } catch {}
      } else {
        // find a working node binary
        let nodeExe = path.join(resourcesPath, 'node-runtime', 'node');
        if (!fs.existsSync(nodeExe)) {
          const electronNode = process.execPath;
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
          // Firefox identifies extensions by the gecko id in
          // browser_specific_settings, NOT a CRX-style hash like Chrome.
          // The published AMO listing uses `hi@noobclaw.com` (see
          // chrome-extension/manifest.json browser_specific_settings.gecko.id);
          // keep `noobclaw-browser-assistant@noobclaw.com` as a fallback
          // so any sideloaded dev build (or an older AMO listing under the
          // longer name) still passes the allowed_extensions check.
          // Mismatch here is silent on Firefox's side — the extension
          // simply gets `Error: An unexpected error occurred` from
          // browser.runtime.connectNative without telling the user the
          // host manifest blocked it, which manifests as the red
          // exclamation badge on the toolbar icon.
          manifest.allowed_extensions = [
            'hi@noobclaw.com',
            'noobclaw-browser-assistant@noobclaw.com',
          ];
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

        // ③ 自愈校验：读回刚写的文件，确认 allowed_origins 包含所有 EXTENSION_IDS。
        // 罕见场景：其他进程并发写、杀软拦截、文件系统 race 可能导致写入内容不完整。
        // 不一致时 WARN 日志 + 再写一遍，还不一致就 ERROR 提示用户手动排查。
        if (browser !== 'firefox') {
          try {
            const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const need = EXTENSION_IDS.map(id => `chrome-extension://${id}/`);
            const got: string[] = Array.isArray(written.allowed_origins) ? written.allowed_origins : [];
            const missing = need.filter(x => !got.includes(x));
            if (missing.length > 0) {
              console.warn(`[BrowserBridge] ${browser} manifest missing ${missing.length} origin(s), rewriting:`, missing);
              written.allowed_origins = [...got, ...missing];
              fs.writeFileSync(manifestPath, JSON.stringify(written, null, 2));
              // Re-verify after retry write
              const reRead = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              const stillMissing = need.filter(x => !(reRead.allowed_origins || []).includes(x));
              if (stillMissing.length > 0) {
                console.error(`[BrowserBridge] ${browser} manifest STILL missing after rewrite:`, stillMissing);
              } else {
                console.log(`[BrowserBridge] ${browser} manifest self-healed: all ${need.length} origins present.`);
              }
            }
          } catch (verifyErr) {
            console.error(`[BrowserBridge] ${browser} manifest verify failed:`, verifyErr);
          }
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
    guideDetail: 'The NoobClaw extension folder path has been copied to your clipboard.\n\nPlease follow these steps:\n1. Open Chrome browser, type chrome://extensions/ in the address bar and press Enter\n2. Turn on "Developer mode" (top right corner)\n3. Click "Load unpacked"\n4. Paste the copied path into the file dialog\'s address bar and press Enter\n5. Select the chrome-extension folder to load it\n\nPath: {path}',
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
    guideDetail: 'NoobClaw 插件目录已复制到剪贴板。\n\n请按以下步骤操作：\n1. 打开 Chrome 浏览器，在地址栏输入 chrome://extensions/ 并回车\n2. 打开右上角「开发者模式」开关\n3. 点击「加载已解压的扩展程序」\n4. 在弹出的文件选择框地址栏粘贴刚复制的路径并回车\n5. 点进 chrome-extension 文件夹进行加载\n\n路径：{path}',
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
    guideDetail: 'NoobClaw 插件目錄已複製到剪貼簿。\n\n請按以下步驟操作：\n1. 打開 Chrome 瀏覽器，在地址欄輸入 chrome://extensions/ 並按 Enter\n2. 開啟右上角「開發人員模式」\n3. 點擊「載入未封裝項目」\n4. 在彈出的檔案選擇框地址欄貼上剛複製的路徑並按 Enter\n5. 點進 chrome-extension 資料夾進行載入\n\n路徑：{path}',
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
  const locale = (app?.getLocale?.() || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase();
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

  // Sidecar/Tauri mode: use the global extensionPromptCallback if registered,
  // otherwise open Chrome Store directly
  if (_extensionPromptCallback) {
    try {
      const choice = await _extensionPromptCallback({
        storeUrl: CHROME_STORE_URL,
        title: 'Browser Extension Required',
        message: 'NoobClaw needs the browser extension for full browser automation.\nInstall it now?',
      });
      if (choice === 'cancel') return 'cancelled';
      try { await openExternal(CHROME_STORE_URL); } catch {}
      return 'installed';
    } catch {}
  }

  // Fallback: open Chrome Store directly
  try { await openExternal(CHROME_STORE_URL); } catch {}
  return 'installed';
}

// Callback for extension install prompt — set by sidecar-server to avoid circular import
type ExtensionPromptCallback = (opts: { storeUrl: string; title: string; message: string }) => Promise<'install' | 'cancel'>;
let _extensionPromptCallback: ExtensionPromptCallback | null = null;

export function setExtensionPromptCallback(cb: ExtensionPromptCallback): void {
  _extensionPromptCallback = cb;
}

// Legacy resolver — kept for backward compat
export function resolveExtensionPrompt(_requestId: string, _result: string): void {}

/**
 * Check if extension is actually installed by looking at Chrome's extension directory
 */
export function isExtensionInstalled(): boolean {
  try {
    const homeDir = require('os').homedir();
    // Check both new (Store) and legacy (sideloaded) extension IDs
    const basePaths: string[] = [];
    if (process.platform === 'win32') {
      basePaths.push(
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions'),
        path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions'),
      );
    } else if (process.platform === 'darwin') {
      basePaths.push(
        path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions'),
        path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Extensions'),
      );
    } else {
      basePaths.push(
        path.join(homeDir, '.config', 'google-chrome', 'Default', 'Extensions'),
        path.join(homeDir, '.config', 'microsoft-edge', 'Default', 'Extensions'),
      );
    }
    for (const base of basePaths) {
      for (const id of EXTENSION_IDS) {
        if (fs.existsSync(path.join(base, id))) return true;
      }
    }
    return false;
  } catch { return false; }
}

export async function installLocalExtension(): Promise<{ extensionPath: string; browserFound: boolean }> {
  let clipboard: any = null;
  try { clipboard = require('electron').clipboard; } catch {}
  const browsers = detectBrowsers();
  const win = BrowserWindow?.getFocusedWindow?.();
  const t = getPromptTexts();

  // Always compute the extension path so the renderer can copy it to the
  // clipboard via navigator.clipboard.writeText even when we're running
  // inside a Tauri sidecar (where require('electron') isn't available and
  // the old clipboard write silently no-op'd — this was the root of
  // '已复制' being a lie for Tauri users).
  //
  // ⭐ v2.4.31 — return the PARENT folder (resources/), not the
  // chrome-extension folder itself. Reason: when the user pastes this
  // path into Chrome's "加载已解压的扩展程序" / "Load unpacked" file
  // dialog, the picker navigates INTO that folder and shows its
  // contents. If we put `.../resources/chrome-extension` on the
  // clipboard, the dialog opens INSIDE chrome-extension (showing
  // background.js / content.js / etc.) and the user has to click "Up"
  // before they can select chrome-extension itself — confusing. By
  // putting `.../resources` on the clipboard, the dialog opens at the
  // parent → user sees `chrome-extension` folder visible → clicks it
  // once → "Select Folder". Cleaner one-click selection.
  const extensionPath = getResourcesPath();

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
    return { extensionPath, browserFound: false };
  }

  // Electron has clipboard; Tauri doesn't — we return the path so the
  // renderer does the clipboard write itself using navigator.clipboard.
  clipboard?.writeText?.(extensionPath);

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
  return { extensionPath, browserFound: true };
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
      // Multi-browser: every native-host connection becomes its own entry
      // in browserConns. We learn what tabs the browser has via the new
      // `hello` / `tabs_changed` protocol from background.js.
      const connId = `conn_${++connSeq}`;
      const conn: BrowserConn = {
        id: connId,
        socket,
        tabs: [],
        extensionVersion: '',
        connectedAt: Date.now(),
        lastActivityAt: Date.now(),
        consecutiveTimeouts: 0,
      };
      // OS-level TCP keepalive — if the socket goes silently dead (system
      // sleep, network blip, native host crash without proper FIN), the OS
      // will probe every ~30s and after a few failed probes will fire
      // socket.on('close'), which removes the stale conn from the map.
      // Without this, dead sockets linger for 2 hours (default Linux/macOS
      // TCP keepalive timer) — long enough that every sendBrowserCommand
      // hits the dead conn first, waits 3s for timeout, returns failure.
      // User-visible symptom: "运行前检查" hangs forever.
      try { socket.setKeepAlive(true, 30000); } catch {}
      try { socket.setNoDelay(true); } catch {}
      browserConns.set(connId, conn);
      console.log(`[BrowserBridge] Browser ${connId} connected (total: ${browserConns.size})`);

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

            // Tab inventory updates from the extension. The extension sends
            // `hello` once on connect, then `tabs_changed` on every tab
            // create / update / remove. We use these to route subsequent
            // commands by tabPattern without round-tripping a query first.
            if (msg.type === 'hello' || msg.type === 'tabs_changed') {
              if (typeof msg.version === 'string' && msg.version) {
                conn.extensionVersion = msg.version;
              }
              if (Array.isArray(msg.tabs)) {
                conn.tabs = msg.tabs.map((t: any) => ({
                  id: Number(t.id),
                  url: String(t.url || ''),
                }));
                conn.lastActivityAt = Date.now();
              }
              return;
            }

            // Response to a command — could come from ANY connection. The
            // pendingRequests map is keyed by command id which is unique
            // across browsers, so no de-dup needed.
            if (msg.id && pendingRequests.has(msg.id)) {
              const pending = pendingRequests.get(msg.id)!;
              clearTimeout(pending.timer);
              pendingRequests.delete(msg.id);
              conn.lastActivityAt = Date.now();
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
        console.log(`[BrowserBridge] Browser ${connId} disconnected (remaining: ${browserConns.size - 1})`);
        browserConns.delete(connId);
        if (!isAnyBrowserConnected()) notifyBridgeStatus(false);
        // Reject any pending requests that were definitely targeted at this
        // connection. We can't tell from pending entries which conn they
        // were sent to, so on FULL disconnect (no browsers left) we reject
        // all. Otherwise we let them ride — another browser might respond,
        // or they'll time out naturally.
        if (browserConns.size === 0) {
          for (const [id, pending] of pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Extension disconnected'));
            pendingRequests.delete(id);
          }
        }
      });

      socket.on('error', (err) => {
        console.error(`[BrowserBridge] Socket error on ${connId}:`, err.message);
      });
    });

    // ⚠️ DO NOT silently fall back to a random port on EADDRINUSE — that
    // was the root cause of the "extension says connected but client says
    // disconnected" bug. The chrome-extension's native messaging host has
    // ELECTRON_PORT = 12581 hard-coded; if we bind a random port instead,
    // the host happily connects to whatever stale process IS holding 12581
    // (zombie NoobClaw, stale Electron, anything), the extension popup
    // shows green "Connected", but our actual bridge has zero conns.
    //
    // Instead: retry binding TCP_PORT a few times (handles a graceful
    // shutdown of a previous instance still in cleanup), then give up and
    // log loudly. UI's bridge-status indicator stays "disconnected" so the
    // user knows something's wrong and can investigate / kill the stale
    // process / restart.
    let retriesLeft = 5;
    const tryListen = () => {
      server.listen(TCP_PORT, '127.0.0.1');
    };

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        if (retriesLeft > 0) {
          retriesLeft--;
          console.warn(`[BrowserBridge] Port ${TCP_PORT} busy (likely a previous NoobClaw instance still cleaning up), retrying in 1s — ${retriesLeft} attempts left`);
          setTimeout(tryListen, 1000);
        } else {
          console.error(`[BrowserBridge] FATAL: port ${TCP_PORT} is held by another process. ` +
            `The chrome extension hard-codes this port, so the client cannot route ` +
            `commands until the holder is freed. ` +
            `Diagnose with:\n` +
            `  macOS/Linux: lsof -i :${TCP_PORT}\n` +
            `  Windows:     netstat -ano | findstr :${TCP_PORT}`);
          notifyBridgeStatus(false);
          reject(new Error(`EADDRINUSE: port ${TCP_PORT} held by another process; please close stale NoobClaw / kill the holder PID`));
        }
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

    tryListen();
  });
}

export async function stopBrowserBridge(): Promise<void> {
  if (!tcpServer) return;

  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Bridge shutting down'));
    pendingRequests.delete(id);
  }

  // Tear down every browser connection (multi-browser).
  for (const conn of browserConns.values()) {
    if (!conn.socket.destroyed) conn.socket.destroy();
  }
  browserConns.clear();

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

/**
 * Routing options for a command (multi-tab + multi-browser support).
 *   tabPattern: regex string. The bridge picks the connected browser whose
 *               cached open-tab list contains a URL matching the pattern.
 *               If multiple browsers match, the one with the most-recent
 *               activity wins. If none match, falls back to whichever
 *               browser saw the most recent activity (which then
 *               findOrOpenTabByPattern in that browser will auto-open the
 *               anchor URL).
 *   When omitted: pre-multi-browser fallback — most-recently-active conn.
 */
export interface SendBrowserCommandOptions {
  tabPattern?: string;
}

/** Pick the browser connection that should receive a command. */
function pickConnForPattern(tabPattern: string | undefined): BrowserConn | null {
  const conns = Array.from(browserConns.values()).filter(c => !c.socket.destroyed);
  if (conns.length === 0) return null;
  if (conns.length === 1) return conns[0];

  if (tabPattern) {
    let pattern: RegExp;
    try { pattern = new RegExp(tabPattern); }
    catch { return conns.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]; }
    // Prefer a connection that already has a matching tab open.
    const matching = conns.filter(c => c.tabs.some(t => pattern.test(t.url || '')));
    if (matching.length > 0) {
      return matching.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    }
    // No browser has the right tab — fall through to "most-recent" so the
    // extension can auto-open the anchor URL in that browser. (This means
    // Twitter task tries to open x.com in browser A even if user prefers
    // browser B; can revisit if it's annoying. For now: predictable.)
  }

  return conns.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
}

export function sendBrowserCommand(
  command: string,
  params: Record<string, any> = {},
  timeoutMs = 30000,
  options: SendBrowserCommandOptions = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const conn = pickConnForPattern(options.tabPattern);
    if (!conn) {
      reject(new Error('BROWSER_NOT_CONNECTED'));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Browser command "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

    // Wire envelope. tabPattern is optional — old extensions that don't
    // know about it simply ignore the field. New extensions route via it.
    const envelope: Record<string, any> = { id, command, params };
    if (options.tabPattern) envelope.tabPattern = options.tabPattern;

    conn.lastActivityAt = Date.now();
    conn.socket.write(JSON.stringify(envelope) + '\n');
  });
}
