/**
 * NoobClaw Browser Assistant — Background Service Worker
 * Connects to NoobClaw desktop client via Native Messaging.
 */

const NATIVE_HOST_NAME = 'com.noobclaw.browser';
let port = null;
let connected = false;

// v1.2.11: zombie-port 自愈用 — 必须在顶层 connect() 调用(下面那行)
// 之前声明,否则 TDZ。同坑前科:fd4e1ce 的 v1.2.7 修过一次。
let connectAttemptStartedAt = 0;
const STUCK_PORT_TIMEOUT_MS = 15000;

// Auto-connect on browser startup, install, and periodic keepalive.
// MV3 service workers can be killed any time; relying ONLY on onStartup
// loses the connection until the next alarm fire. Hence three triggers:
//   1. onStartup / onInstalled — first-load events
//   2. Top-level connect() — runs on EVERY service-worker wake (alarm,
//      tab event, message arrival, install). The guard inside connect()
//      makes redundant calls cheap.
//   3. Keepalive alarm every 30s — last-resort retry.
chrome.runtime.onStartup.addListener(() => { connect(); });
chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') { connect(); }  // always try, connect() is idempotent
});
// Top-level kick — fires on every SW wake. v1.1.0 didn't need this because
// it had fewer event listeners and the SW stayed alive longer; v1.2.x adds
// tab/group listeners that paradoxically made the SW more eager to die
// (more listeners → Chrome optimizes more aggressively). This line restores
// "open browser → instantly connected" UX without requiring the user to
// click the extension icon to wake things up.
connect();


// Resize image to reduce token usage
async function resizeImage(dataUrl, maxWidth) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    if (bmp.width <= maxWidth) return dataUrl;
    const scale = maxWidth / bmp.width;
    const canvas = new OffscreenCanvas(maxWidth, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.4 });
    const buf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return 'data:image/jpeg;base64,' + btoa(binary);
  } catch {
    return dataUrl;
  }
}

let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// v1.2.11 自愈逻辑 — connectAttemptStartedAt + STUCK_PORT_TIMEOUT_MS
// 已经移到文件顶部 (let port 旁边),否则 TDZ:顶层 connect() 调用早于
// 这两行声明执行。

function connect() {
  // 自愈:zombie port 检测
  if (port && !connected && (Date.now() - connectAttemptStartedAt > STUCK_PORT_TIMEOUT_MS)) {
    console.log('[NoobClaw] Zombie port (no bridge_status in', STUCK_PORT_TIMEOUT_MS, 'ms), force-resetting');
    try { port.disconnect(); } catch (_) {}
    port = null;
    connected = false;
    updateStatus('disconnected');
  }
  if (port) return;

  connectAttemptStartedAt = Date.now();
  updateStatus('connecting');

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener(async (msg) => {
      // Bridge status from native host
      if (msg.type === 'bridge_status') {
        if (msg.connected) {
          connected = true;
          reconnectDelay = 1000;
          updateStatus('connected');
          // Multi-browser routing (v1.2.0): announce ourselves to the
          // desktop bridge with our current tab inventory so it can route
          // commands to the right browser. Without this, the bridge can
          // only guess by "most recent activity".
          await sendTabInventory();
        } else {
          connected = false;
          updateStatus('disconnected');
        }
        return;
      }

      // Pong (keepalive)
      if (msg.type === 'pong') return;

      // Command from NoobClaw
      if (msg.id && msg.command) {
        const result = await executeCommand(msg);
        if (port) {
          port.postMessage(result);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.log('[NoobClaw] Native port disconnected:', error?.message || 'unknown');
      port = null;
      connected = false;
      updateStatus('disconnected');
      scheduleReconnect();
    });

  } catch (err) {
    console.error('[NoobClaw] Failed to connect native:', err);
    port = null;
    updateStatus('disconnected');
    scheduleReconnect();
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (port) {
    port.disconnect();
    port = null;
  }
  connected = false;
  updateStatus('disconnected');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

function updateStatus(status) {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ connectionStatus: status });
  }
  // Update badge
  if (status === 'connected') {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#00ff88' });
  } else if (status === 'connecting') {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#ffc832' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff5050' });
  }
  chrome.runtime.sendMessage({ type: 'status_update', status }).catch(() => {});
}

async function getActiveTab() {
  // Try lastFocusedWindow first (works even when Chrome is in background)
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) return tab;
  // Fallback: any active tab in any window
  [tab] = await chrome.tabs.query({ active: true });
  if (tab?.id) return tab;
  throw new Error('No active tab. Please open a tab in Chrome.');
}

// ── Tab-inventory protocol (multi-browser routing, v1.2.0) ────────────────
// On every browser start, we tell the desktop bridge which tabs we have
// open. After that we push updates whenever a tab is created, removed, or
// changes URL. The bridge uses this to pick which connected browser
// receives each command (the one whose tabs match the command's
// tab_url_pattern). Without this, the bridge can only "broadcast" or
// guess.
function getExtensionVersion() {
  try { return chrome.runtime.getManifest().version || ''; } catch { return ''; }
}

async function sendTabInventory() {
  if (!port) return;
  try {
    const tabs = await chrome.tabs.query({});
    port.postMessage({
      type: 'hello',
      version: getExtensionVersion(),
      tabs: tabs.map(t => ({ id: t.id, url: t.url || '' })),
    });
  } catch (e) {
    console.warn('[NoobClaw] sendTabInventory failed:', e?.message || e);
  }
}

// Debounced "tabs_changed" push. Tab events fire in bursts (e.g. opening
// 3 tabs at once = 3 events); we only want to push the final state once.
let tabsChangedTimer = null;
function pushTabsChangedDebounced() {
  if (tabsChangedTimer) clearTimeout(tabsChangedTimer);
  tabsChangedTimer = setTimeout(async () => {
    tabsChangedTimer = null;
    if (!port || !connected) return;
    try {
      const tabs = await chrome.tabs.query({});
      port.postMessage({
        type: 'tabs_changed',
        version: getExtensionVersion(),
        tabs: tabs.map(t => ({ id: t.id, url: t.url || '' })),
      });
    } catch {}
  }, 500);
}

// Wire tab events. We don't filter — any change to the tab universe might
// affect routing decisions, so push the whole list on any event.
chrome.tabs.onCreated.addListener(pushTabsChangedDebounced);
chrome.tabs.onRemoved.addListener(pushTabsChangedDebounced);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // Only care about URL changes (status/title changes are noise).
  if (changeInfo.url) pushTabsChangedDebounced();
});

// ── Multi-tab routing (Twitter v1) ─────────────────────────────────────────
// When NoobClaw sends a command with a `tabPattern` (regex string), we route
// it to the first tab whose URL matches. If no tab matches, we auto-open one
// at the platform's anchor URL. This lets XHS tasks and Twitter tasks run
// concurrently in different tabs without stepping on each other.
//
// Backward compatible: if the message has no tabPattern field (= old
// scenarios), we fall back to getActiveTab() exactly as before.

function anchorUrlFor(patternStr) {
  // Map known platform regexes to their canonical landing URL. Adding a
  // new platform = add one branch here. We don't try to reverse-engineer
  // arbitrary regexes — keep this explicit.
  // v1.2.14: 加币安分支 — 之前漏了导致 sidecar 抛 "No tab matching ...
  // no anchor URL known" 弹窗(没开 binance tab + 找不到 anchor URL)
  if (/xiaohongshu/.test(patternStr)) return 'https://www.xiaohongshu.com';
  if (/twitter|x\\\.com|x\.com/.test(patternStr)) return 'https://x.com/home';
  if (/binance/.test(patternStr)) return 'https://www.binance.com/square';
  return null;
}

function waitForTabLoad(tabId, timeoutMs = 12000) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
  });
}

async function findOrOpenTabByPattern(patternStr) {
  let pattern;
  try { pattern = new RegExp(patternStr); }
  catch (e) { throw new Error('Invalid tabPattern regex: ' + patternStr); }

  // Scan all tabs across all windows for a URL match.
  const tabs = await chrome.tabs.query({});
  const match = tabs.find(t => pattern.test(t.url || ''));
  if (match) return match;

  // No matching tab — open a NEW WINDOW at the platform's anchor URL.
  // We open a window (not a tab in the current window) per user request:
  // visually more obvious which platform each task is running on, and
  // less likely the user accidentally clicks something on the wrong
  // surface. focused: false keeps the new window in the background so
  // we don't steal focus from whatever the user is doing.
  //
  // chrome.windows.create returns a Window with a `tabs` array containing
  // the initial tab — we return that tab so all downstream code paths
  // (which expect a tab object) keep working unchanged.
  const anchorUrl = anchorUrlFor(patternStr);
  if (!anchorUrl) {
    throw new Error('No tab matching ' + patternStr + ' and no anchor URL known for that pattern');
  }
  const win = await chrome.windows.create({
    url: anchorUrl,
    focused: false,
    type: 'normal',
  });
  const initialTab = win.tabs && win.tabs[0];
  if (!initialTab || !initialTab.id) {
    throw new Error('chrome.windows.create returned no initial tab');
  }
  await waitForTabLoad(initialTab.id);
  return await chrome.tabs.get(initialTab.id);
}

async function injectContentScript(tabId) {
  try {
    // Check if already injected
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__noobclaw_injected === true,
    });
    if (result?.result) return; // Already injected
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    // Already injected or restricted page (chrome://, edge://, etc.)
  }
  // Wait a bit for content script to initialize
  await new Promise(r => setTimeout(r, 100));
}

async function sendToContentScript(tabId, command, params, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { command, params });
    } catch (e) {
      if (i < retries && e.message?.includes('Receiving end does not exist')) {
        // Content script not ready, re-inject and retry
        await injectContentScript(tabId);
        continue;
      }
      throw e;
    }
  }
}

// ── Tab Group status indicator (v1.2.2) ───────────────────────────────
// Goal: visual cue in the tab bar showing which tabs NoobClaw is actively
// driving, so XHS and Twitter automation are unambiguous.
//
// Why Tab Groups (not a page-injected banner): page DOM injection is
// detectable by host-site JS (XHS / X scan for known automation
// markers) and would risk getting the user flagged. Tab groups live
// entirely in browser chrome — page scripts cannot read tab.groupId,
// group title, or group color. Zero detection surface.
function platformLabelForPattern(patternStr) {
  if (!patternStr) return null;
  // v1.2.14:
  //   - binance 正则改成 /binance/i (老 /binance\.com/i 匹不上转义的 \.com)
  //   - 标签改成英文短名 + 品牌后缀,Chrome tab group 显示空间有限
  const color = 'green';
  if (/xiaohongshu/i.test(patternStr)) {
    return { title: '🤖 XHS · NoobClaw', color };
  }
  if (/twitter|x\\.com|x\.com/i.test(patternStr)) {
    return { title: '🤖 X · NoobClaw', color };
  }
  if (/binance/i.test(patternStr)) {
    return { title: '🤖 Binance · NoobClaw', color };
  }
  return { title: '🤖 NoobClaw', color };
}

// Per-window cache of "platform label → groupId" so we don't recreate
// the group on every command. Cleared on group-removed events.
const platformGroupByWindow = new Map(); // key: `${windowId}|${title}` → groupId

async function ensureTabInPlatformGroup(tab, patternStr) {
  // chrome.tabGroups requires the tabGroups permission. Skip pinned/
  // incognito tabs (Chrome refuses to group them).
  if (!tab || !tab.id) {
    console.log('[NoobClaw] tab group skip: no tab id');
    return;
  }
  if (tab.incognito) {
    console.log('[NoobClaw] tab group skip: incognito tab');
    return;
  }
  if (tab.pinned) {
    console.log('[NoobClaw] tab group skip: pinned tab');
    return;
  }
  if (!chrome.tabGroups || !chrome.tabs.group) {
    console.log('[NoobClaw] tab group skip: chrome.tabGroups API unavailable (old Chrome or missing permission)');
    return;
  }

  const info = platformLabelForPattern(patternStr);
  if (!info) {
    console.log('[NoobClaw] tab group skip: no platform label for pattern', patternStr);
    return;
  }

  const cacheKey = `${tab.windowId}|${info.title}`;
  const cachedGroupId = platformGroupByWindow.get(cacheKey);

  // Fast path: already in the right group.
  if (cachedGroupId && tab.groupId === cachedGroupId) {
    console.log('[NoobClaw] tab group: already in', info.title);
    return;
  }

  try {
    let groupId;
    if (cachedGroupId) {
      try {
        await chrome.tabGroups.get(cachedGroupId);
        groupId = await chrome.tabs.group({ groupId: cachedGroupId, tabIds: [tab.id] });
      } catch {
        platformGroupByWindow.delete(cacheKey);
        groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      }
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    }

    // First time this group is created → set its title + color.
    if (groupId !== cachedGroupId) {
      await chrome.tabGroups.update(groupId, {
        title: info.title,
        color: info.color,
        collapsed: false,
      });
      platformGroupByWindow.set(cacheKey, groupId);
      console.log('[NoobClaw] tab group created:', info.title, 'groupId=', groupId);
    } else {
      console.log('[NoobClaw] tab group: tab joined existing', info.title);
    }
  } catch (e) {
    // Non-fatal — automation continues even if grouping fails (e.g. user
    // manually moved the tab to another window mid-flight). Log loudly so
    // we can diagnose "tab group not visible" complaints.
    console.warn('[NoobClaw] tab group FAILED:', e?.message || e, '\n  tab=', tab, '\n  pattern=', patternStr);
  }
}

// Clean up cache when groups go away (user dragged the last tab out,
// closed the group, etc.) so we recreate fresh next time.
if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    for (const [k, v] of platformGroupByWindow.entries()) {
      if (v === group.id) platformGroupByWindow.delete(k);
    }
  });
}

async function executeCommand(msg) {
  const { id, command, params, tabPattern } = msg;
  // Per-message tab resolution. If the envelope carries a tabPattern (new
  // multi-tab routing introduced in Twitter v1), we resolve it ONCE and
  // expose it as `resolveTab` for all downstream code paths. The cached
  // resolve means a single command doesn't pay the lookup cost twice.
  //
  // ⚠️ HISTORICAL BUG (fixed in 1.2.6+): pre-1.2.6 this used to do
  //   const _outerGetActiveTab = getActiveTab;     // line A
  //   const getActiveTab = async () => { ... };    // line B
  // ...which threw `Cannot access 'getActiveTab' before initialization`
  // on EVERY call because line B's const shadows the outer function
  // declaration in this scope, putting `getActiveTab` (line A's RHS) in
  // the temporal dead zone. The error was an unhandled promise rejection
  // → no response posted back → bridge timed out after 3s on EVERY
  // command. That's the root cause of the "运行前检查 卡半天" symptom
  // and "插件 popup 显示连接 / 客户端显示未连接" state mismatch.
  //
  // Renamed the local resolver to `resolveTab` so it doesn't shadow the
  // module-level `getActiveTab` function — TDZ goes away. All inner
  // usages updated below from `getActiveTab()` → `resolveTab()`.
  let _resolvedTab = null;
  const resolveTab = async () => {
    if (_resolvedTab) return _resolvedTab;
    _resolvedTab = tabPattern
      ? await findOrOpenTabByPattern(tabPattern)
      : await resolveTab();
    // Drop the resolved tab into a labeled tab group so the user can
    // visually distinguish "X-controlled tab" from "XHS-controlled tab"
    // in the tab strip. Fire-and-forget — failure must NOT affect the
    // command (grouping is a UX nicety, not a correctness requirement).
    if (_resolvedTab && tabPattern) {
      ensureTabInPlatformGroup(_resolvedTab, tabPattern).catch(() => {});
    }
    return _resolvedTab;
  };
  try {
    let data;

    if (command === 'screenshot') {
      const tab = await resolveTab();
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 25 });
      const resized = await resizeImage(dataUrl, 640);
      data = { image: resized.split(',')[1] };
    } else if (command === 'navigate') {
      const tab = await resolveTab();
      let url = params.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
      await chrome.tabs.update(tab.id, { url });
      // Wait for page load
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 10000);
      });
      // Inject content script on new page
      await injectContentScript(tab.id);
      const updated = await chrome.tabs.get(tab.id);
      data = { url: updated.url, title: updated.title };
    } else if (command === 'tab_create') {
      const tab = await chrome.tabs.create({ url: params.url || 'about:blank' });
      data = { tabId: tab.id, url: tab.url };
    } else if (command === 'tab_close') {
      if (params.tabId) {
        await chrome.tabs.remove(params.tabId);
      } else {
        const tab = await resolveTab();
        await chrome.tabs.remove(tab.id);
      }
      data = { message: 'Tab closed' };
    } else if (command === 'tab_list') {
      const tabs = await chrome.tabs.query({});
      data = { tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })) };
    } else if (command === 'tab_switch') {
      if (params.tabId) {
        await chrome.tabs.update(params.tabId, { active: true });
        data = { message: `Switched to tab ${params.tabId}` };
      } else {
        data = { error: 'tabId is required' };
      }
    } else if (command === 'resize_window') {
      const tab = await resolveTab();
      const win = await chrome.windows.get(tab.windowId);
      await chrome.windows.update(win.id, {
        width: params.width || win.width,
        height: params.height || win.height,
      });
      data = { message: `Resized to ${params.width}x${params.height}` };
    } else if (command === 'go_back') {
      const tab = await resolveTab();
      await chrome.tabs.goBack(tab.id);
      data = { message: 'Navigated back' };
    } else if (command === 'go_forward') {
      const tab = await resolveTab();
      await chrome.tabs.goForward(tab.id);
      data = { message: 'Navigated forward' };
    } else if (command === 'reload') {
      const tab = await resolveTab();
      await chrome.tabs.reload(tab.id);
      data = { message: 'Page reloaded' };
    } else if (command === 'list_tabs') {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      data = { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
    } else if (command === 'get_tab_info') {
      const tab = await resolveTab();
      data = { id: tab.id, title: tab.title, url: tab.url, status: tab.status };
    } else if (command === 'main_world_click') {
      // Click in MAIN world — works on React apps where isolated world click fails
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return { error: 'not found: ' + sel };
          // Only scroll if element is outside viewport
          const r = el.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
          // Full mouse event sequence (same as content.js fireMouseSequence)
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          el.dispatchEvent(new MouseEvent('mouseover', init));
          el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, init, { bubbles: false })));
          el.dispatchEvent(new MouseEvent('mousemove', init));
          el.dispatchEvent(new MouseEvent('mousedown', init));
          if (el.focus) el.focus({ preventScroll: true });
          el.dispatchEvent(new MouseEvent('mouseup', init));
          el.dispatchEvent(new MouseEvent('click', init));
          el.click();
          return { message: 'Clicked ' + el.tagName.toLowerCase(), tag: el.tagName, w: Math.round(rect.width), h: Math.round(rect.height) };
        },
        args: [params.selector],
      });
      data = results[0]?.result || { error: 'executeScript failed' };
    } else if (command === 'upload_file_from_url') {
      // v1.2.17: 移到 background.js + main world 跑,绕开 content script 的
      // isolated world(实测在 isolated world 里给 binance 视频 modal 注入大文件,
      // input.files = dt.files 这一步会触发 binance React handler "Maximum call
      // stack size exceeded" 爆栈;在 main world 跑同样的代码 17 MB 完全没事)。
      // 之前 content.js 的 uploadFileFromUrl 保留以兼容老 orchestrator,但新调用都走这里。
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (selector, fileUrl, fileName, mimeType) => {
          try {
            const input = document.querySelector(selector);
            if (!input || input.tagName !== 'INPUT' || input.type !== 'file') {
              return { error: 'file_input_not_found', selector };
            }
            const resp = await fetch(fileUrl, { method: 'GET' });
            if (!resp.ok) return { error: 'fetch_http_' + resp.status };
            const blob = await resp.blob();
            if (!blob || blob.size === 0) return { error: 'empty_file' };
            const finalMime = mimeType || blob.type || 'application/octet-stream';
            const file = new File([blob], fileName, { type: finalMime });
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return { ok: true, message: 'Uploaded ' + fileName + ' (' + blob.size + ' bytes)', size: blob.size, mimeType: finalMime };
          } catch (err) {
            return { error: 'main_world_inject_failed: ' + (err && err.message || String(err)).slice(0, 200) };
          }
        },
        args: [params.selector || params.ref, params.fileUrl, params.fileName, params.mimeType || ''],
      });
      data = results[0]?.result || { error: 'executeScript_failed' };
    } else if (command === 'fetch_image') {
      // ── fetch_image (v1.2.8+) ──
      // Fetch an image URL through the browser's own network stack so it
      // uses the user's real IP / UA / cookies / referer — indistinguishable
      // from the user viewing the image in their tab. Used by scenarios
      // that "re-upload" imagery from source posts (e.g. Binance Square
      // rewrite mechanism reusing editorial illustrations from the original
      // post). Sidecar fetch would leak a different UA / empty cookie jar
      // and risk tripping CDN fingerprinting — this avoids that.
      //
      // Returns { base64, contentType, size } or { error }. Caller is
      // expected to pipe base64 straight into an upload_file command.
      const url = params.url;
      const maxBytes = params.maxBytes || 3 * 1024 * 1024; // 3 MB ceiling
      if (!url || !/^https?:\/\//i.test(url)) {
        data = { error: 'invalid_url' };
      } else {
        try {
          const resp = await fetch(url, {
            credentials: 'include',
            referrer: params.referrer || 'https://www.binance.com/',
          });
          if (!resp.ok) {
            data = { error: 'http_' + resp.status };
          } else {
            const ct = resp.headers.get('content-type') || '';
            if (!ct.startsWith('image/')) {
              data = { error: 'not_image', contentType: ct };
            } else {
              const blob = await resp.blob();
              if (blob.size > maxBytes) {
                data = { error: 'too_large', size: blob.size };
              } else {
                const buf = await blob.arrayBuffer();
                const bytes = new Uint8Array(buf);
                // Chunked to avoid call-stack blowup on very large images
                let binary = '';
                const CHUNK = 0x8000;
                for (let i = 0; i < bytes.length; i += CHUNK) {
                  binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                }
                data = {
                  base64: btoa(binary),
                  contentType: ct,
                  size: blob.size,
                };
              }
            }
          }
        } catch (e) {
          data = { error: String((e && e.message) || e).slice(0, 200) };
        }
      }
    } else if (command === 'editor_insert_text') {
      // ── editor_insert_text (v1.2.13+) ──
      // 通用富文本编辑器写入 — 用 document.execCommand('insertText') 走浏览器
      // 原生输入管道(beforeinput → input),React/ProseMirror/TipTap/CKEditor
      // 都能正确收到事件并同步状态。execCommand 失败兜底用 InputEvent dispatch。
      // 取代 binance_dom_action.prosemirror_insert_text(后者保留作 alias)。
      // 用法: { command: 'editor_insert_text', selector: '...', text: '...' }
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (cfg) => {
          const sel = cfg.selector;
          const text = cfg.text;
          if (!sel) return { error: 'selector_required' };
          if (typeof text !== 'string') return { error: 'text_required' };
          const editor = document.querySelector(sel);
          if (!editor) return { error: 'editor_not_found', selector: sel };
          try {
            editor.focus();
            let method = 'unknown';
            let inserted = false;
            if (typeof document.execCommand === 'function') {
              try {
                inserted = document.execCommand('insertText', false, text);
                if (inserted) method = 'execCommand';
              } catch (_) {}
            }
            if (!inserted) {
              const ev1 = new InputEvent('beforeinput', {
                inputType: 'insertText', data: text, bubbles: true, cancelable: true,
              });
              editor.dispatchEvent(ev1);
              const ev2 = new InputEvent('input', {
                inputType: 'insertText', data: text, bubbles: true,
              });
              editor.dispatchEvent(ev2);
              method = 'dispatchEvent';
              inserted = true;
            }
            return { ok: inserted, method, textLen: text.length, editorTextLen: (editor.textContent || '').length };
          } catch (e) {
            return { error: 'insert_failed', message: String(e && e.message || e).slice(0, 200) };
          }
        },
        args: [params || {}],
      });
      data = results[0]?.result || { error: 'executeScript_failed' };
    } else if (command === 'click_with_text') {
      // ── click_with_text (v1.2.13+) ──
      // 在容器内按 textContent 找按钮(元素)点击。取代 binance 系列里的
      // click_first_follow_button + submit_short_editor 大部分场景。
      // 用法: { command: 'click_with_text',
      //         containerSel: '.short-editor-inner.modal',  // 可选,默认 document
      //         tagSel: 'button',                            // 容器内匹啥 tag,默认 'button'
      //         acceptedTexts: ['关注', 'Follow'],
      //         opts: { fuzzy: true,           // 启用 substring 模糊(t.length ≤ accepted+5)
      //                 skipInactive: true,    // 有 .inactive class 视为禁用
      //                 skipDisabled: true,    // disabled 属性视为禁用
      //                 returnDebug: true,     // 失败时返回所有扫到的 button 文本
      //                 instance: 'first',     // 'first' | 'last' (扫到多个时取哪个)
      //                 noClick: false } }     // true = 只查不点(用于诊断)
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (cfg) => {
          const containerSel = cfg.containerSel || null;
          const tagSel = cfg.tagSel || 'button';
          const accepted = cfg.acceptedTexts || [];
          const opts = cfg.opts || {};
          const fuzzy = opts.fuzzy !== false;
          const skipInactive = opts.skipInactive !== false;
          const skipDisabled = opts.skipDisabled !== false;
          const instance = opts.instance || 'first';
          const noClick = !!opts.noClick;
          const returnDebug = !!opts.returnDebug;
          if (!accepted.length) return { error: 'acceptedTexts_required' };
          let containers = [document];
          if (containerSel) {
            const found = document.querySelectorAll(containerSel);
            if (!found.length) return { error: 'container_not_found', selector: containerSel };
            containers = Array.from(found);
          }
          const allBtns = [];
          for (const c of containers) {
            const btns = c.querySelectorAll(tagSel);
            for (const b of btns) allBtns.push(b);
          }
          const norm = (s) => (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          const debugTexts = [];
          const matches = [];
          for (const b of allBtns) {
            const t = norm(b.textContent);
            if (returnDebug) debugTexts.push(t.slice(0, 30));
            let matched = false;
            for (const a of accepted) {
              if (t === a) { matched = true; break; }
            }
            if (!matched && fuzzy) {
              for (const a of accepted) {
                if (t.length > 0 && t.length <= a.length + 5 && t.indexOf(a) >= 0) {
                  matched = true; break;
                }
              }
            }
            if (matched) matches.push({ el: b, text: t });
          }
          if (matches.length === 0) {
            return {
              error: 'no_match',
              scanned: allBtns.length,
              containers: containers.length,
              btn_texts: returnDebug ? debugTexts.slice(0, 20) : undefined,
            };
          }
          const picked = (instance === 'last') ? matches[matches.length - 1] : matches[0];
          const b = picked.el;
          if (skipDisabled && b.disabled) return { error: 'btn_disabled', text: picked.text };
          if (skipInactive && (b.className || '').indexOf('inactive') >= 0) {
            return { error: 'btn_inactive', text: picked.text };
          }
          if (noClick) {
            return { ok: true, text: picked.text, matchCount: matches.length, clicked: false };
          }
          b.scrollIntoView({ behavior: 'instant', block: 'center' });
          b.click();
          return { ok: true, text: picked.text, matchCount: matches.length, clicked: true };
        },
        args: [params || {}],
      });
      data = results[0]?.result || { error: 'executeScript_failed' };
    } else if (command === 'wait_for') {
      // ── wait_for (v1.2.13+) ──
      // 通用元素等待 — 替代 orchestrator 里那一堆轮询循环。
      // 用法: { command: 'wait_for',
      //         selector: '...',
      //         timeoutMs: 8000,           // 默认 5000
      //         condition: 'present' }     // 'present' | 'absent' | 'visible'
      const sel = (params && params.selector) || '';
      const timeoutMs = (params && params.timeoutMs) || 5000;
      const condition = (params && params.condition) || 'present';
      if (!sel) { data = { error: 'selector_required' }; }
      else {
        const tab = await resolveTab();
        const startedAt = Date.now();
        const POLL_MS = 250;
        let satisfied = false;
        let loops = 0;
        while (Date.now() - startedAt < timeoutMs) {
          loops++;
          try {
            const r = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN',
              func: (s, cond) => {
                const el = document.querySelector(s);
                if (cond === 'absent') return !el;
                if (!el) return false;
                if (cond === 'visible') {
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                }
                return true; // 'present'
              },
              args: [sel, condition],
            });
            if (r[0]?.result === true) { satisfied = true; break; }
          } catch (_) {}
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        const elapsed = Date.now() - startedAt;
        data = satisfied ? { ok: true, elapsedMs: elapsed, loops } : { error: 'timeout', elapsedMs: elapsed, loops };
      }
    } else if (command === 'extract_list') {
      // ── extract_list (v1.2.13+) ──
      // JSON-driven DOM 列表提取 — 通用版的 read_feed / find_follow_buttons。
      // 业务逻辑(选什么 selector / 提什么字段 / 怎么过滤)全在 orchestrator
      // 传的 rules 里,扩展只负责执行。
      //
      // 用法: { command: 'extract_list', rules: { ...见下面 } }
      // rules: {
      //   itemSelector: '.feed-buzz-card-base-view',
      //   itemSelectorFallback: '.card-content-box',  // optional
      //   itemFilter: { textOneOf: ['关注', 'Follow'] }, // optional 预过滤
      //   ancestorSelector: '.follow-card',  // optional 找到 item 后 closest()
      //   maxItems: 50,
      //   fields: {
      //     text: { selector: '.text', method: 'textContent', maxLen: 1500,
      //             altSelectors: ['.fallback', '...'] },
      //     handle: { selector: 'a[href*="/profile/"]', method: 'attribute',
      //               attr: 'href', regex: '/profile/([^/?#]+)', decode: 'uri' },
      //     cashtags: { selector: '[data-role="coinpair"]', method: 'attribute',
      //                 attr: 'data-value', multiple: true },
      //     likes: { selector: '.thumb-up-button .num span.current',
      //              method: 'textContent', parseNumber: true },
      //   },
      //   postFilter: { requireField: 'text',           // 字段值非空才保留
      //                 minLen: { field: 'text', value: 5 },
      //                 maxValue: { field: 'comments', value: 100 } },
      // }
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (rules) => {
          if (!rules || !rules.itemSelector) return { error: 'itemSelector_required' };
          // 解析数字: 支持 k/m/万 后缀
          const parseNum = (s) => {
            const raw = (s || '').replace(/[^0-9.kKmM万]/g, '');
            let n = parseFloat(raw) || 0;
            if (/[kK]/.test(raw)) n *= 1000;
            else if (/[mM]/.test(raw)) n *= 1000000;
            else if (/万/.test(raw)) n *= 10000;
            return Math.floor(n);
          };
          // 提单字段
          const extractField = (root, fieldRule) => {
            const sels = [fieldRule.selector].concat(fieldRule.altSelectors || []);
            if (fieldRule.multiple) {
              // 多匹配:返回数组
              const out = [];
              for (const sel of sels) {
                const els = root.querySelectorAll(sel);
                if (els.length === 0) continue;
                for (const el of els) {
                  let val = '';
                  if (fieldRule.method === 'attribute') val = el.getAttribute(fieldRule.attr || '') || '';
                  else val = (el.textContent || '').trim();
                  if (val) out.push(val);
                }
                break; // 第一个非空 selector
              }
              return out;
            }
            // 单匹配
            for (const sel of sels) {
              const el = root.querySelector(sel);
              if (!el) continue;
              let val = '';
              if (fieldRule.method === 'attribute') val = el.getAttribute(fieldRule.attr || '') || '';
              else val = (el.textContent || '').trim();
              if (fieldRule.regex && val) {
                try {
                  const m = val.match(new RegExp(fieldRule.regex));
                  val = m ? m[1] || m[0] : '';
                } catch (_) {}
              }
              if (fieldRule.decode === 'uri' && val) {
                try { val = decodeURIComponent(val); } catch (_) {}
              }
              if (fieldRule.parseNumber) val = parseNum(val);
              if (typeof val === 'string' && fieldRule.maxLen) val = val.slice(0, fieldRule.maxLen);
              if (val !== '' && val !== 0) return val;
              if (val === 0 && fieldRule.parseNumber) return 0; // 0 是合法数字
            }
            return fieldRule.parseNumber ? 0 : '';
          };
          // 主流程
          const stats = {
            url: location.href,
            scanned: 0, kept: 0,
            skippedFilter: 0, skippedNoText: 0, skippedShort: 0, skippedHigh: 0,
          };
          let items = document.querySelectorAll(rules.itemSelector);
          let useFallback = false;
          if (items.length === 0 && rules.itemSelectorFallback) {
            items = document.querySelectorAll(rules.itemSelectorFallback);
            useFallback = true;
          }
          stats.scanSource = useFallback ? 'fallback' : 'primary';
          stats.itemSelector = useFallback ? rules.itemSelectorFallback : rules.itemSelector;
          const max = Math.min(items.length, rules.maxItems || 50);
          const out = [];
          const itemFilter = rules.itemFilter || null;
          for (let i = 0; i < max; i++) {
            stats.scanned++;
            let item = items[i];
            // 预过滤(item 自己的 textContent)
            if (itemFilter && itemFilter.textOneOf) {
              const itemText = (item.textContent || '').trim();
              if (itemFilter.textOneOf.indexOf(itemText) < 0) {
                stats.skippedFilter++; continue;
              }
            }
            // 可选 ancestor 提升
            if (rules.ancestorSelector) {
              const anc = item.closest(rules.ancestorSelector);
              if (anc) item = anc;
            }
            // 提取所有字段
            const data = { _index: i };
            const fields = rules.fields || {};
            for (const fname of Object.keys(fields)) {
              data[fname] = extractField(item, fields[fname]);
            }
            // 后过滤
            const pf = rules.postFilter || {};
            if (pf.requireField && !data[pf.requireField]) { stats.skippedNoText++; continue; }
            if (pf.minLen) {
              const v = data[pf.minLen.field];
              if (typeof v !== 'string' || v.length < pf.minLen.value) { stats.skippedShort++; continue; }
            }
            if (pf.maxValue) {
              const v = data[pf.maxValue.field];
              if (typeof v === 'number' && v >= pf.maxValue.value) { stats.skippedHigh++; continue; }
            }
            stats.kept++;
            out.push(data);
          }
          return { items: out, stats };
        },
        args: [params && params.rules || {}],
      });
      data = results[0]?.result || { error: 'executeScript_failed' };
    } else if (command === 'click_in_card') {
      // ── click_in_card (v1.2.13+) ──
      // 在某张卡片(由 attr 唯一定位)里点击指定子元素。取代
      // click_card_comments_icon + 给 doLike 用的 :has() trick 提供更稳固的路径。
      // 用法: { command: 'click_in_card',
      //         cardSelector: '.feed-buzz-card-base-view',
      //         byAttr: 'href',                              // 在卡片内查啥属性匹配
      //         attrSelector: 'a',                           // 哪种 tag 上找该属性
      //         attrIncludes: '/post/abc123',                // 属性值 substring 匹配
      //         innerSelector: '.thumb-up-button' }          // 卡片内点啥
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (cfg) => {
          const cardSel = cfg.cardSelector || '';
          const byAttr = cfg.byAttr || 'href';
          const attrSelector = cfg.attrSelector || 'a';
          const attrIncludes = cfg.attrIncludes || '';
          const innerSel = cfg.innerSelector || '';
          if (!cardSel || !attrIncludes || !innerSel) return { error: 'missing_required_param' };
          const cards = document.querySelectorAll(cardSel);
          for (const card of cards) {
            const attrEls = card.querySelectorAll(attrSelector);
            let matched = false;
            for (const el of attrEls) {
              const v = el.getAttribute(byAttr) || '';
              if (v.indexOf(attrIncludes) >= 0) { matched = true; break; }
            }
            if (!matched) continue;
            const inner = card.querySelector(innerSel);
            if (!inner) return { error: 'inner_not_found_in_matched_card', cards: cards.length };
            inner.scrollIntoView({ behavior: 'instant', block: 'center' });
            const clickable = inner.querySelector('[role="button"]') || inner.firstElementChild || inner;
            clickable.click();
            return { ok: true, cardCount: cards.length };
          }
          return { error: 'no_card_matched_attr', cards: cards.length };
        },
        args: [params || {}],
      });
      data = results[0]?.result || { error: 'executeScript_failed' };
    } else if (command === 'binance_dom_action') {
      // ── binance_dom_action (v1.2.9+,v1.2.13 起 deprecated) ──
      // ⚠️ DEPRECATED — 新代码应该用顶层 editor_insert_text / click_with_text /
      // extract_list / wait_for / click_in_card 这 5 个通用原语。这里保留所有
      // 子动作作为 thin alias,仅为兼容老 backend orchestrator 不立即崩。
      //
      // 老逻辑(v1.2.9+) ──
      // CSP-safe DOM extraction/interaction for Binance Square. Some
      // pages (binance.com being one) ship strict CSPs that block the
      // generic `javascript` command's `new Function(code)` eval inside
      // the extension's isolated world. We work around by injecting a
      // STATIC function via chrome.scripting.executeScript({world:'MAIN',
      // func, args}) — Chrome's official mechanism that doesn't hit
      // CSP because the function source is parsed/injected, not evaluated.
      //
      // Single dispatcher; sub-action picks behavior. Pass:
      //   { action: 'read_feed', minTextLen, skipCommentGte }
      //   { action: 'find_follow_buttons' }
      //   { action: 'click_first_follow_button' }
      //   { action: 'click_card_comments_icon', cardIndex }
      //   { action: 'submit_short_editor', acceptedTexts: ["发文","回复"] }
      const tab = await resolveTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (cfg) => {
          // ALL logic must be inline here — no closures from outer scope.
          const action = cfg && cfg.action;
          try {
            if (action === 'read_feed') {
              const minTextLen = cfg.minTextLen || 5;
              const skipCommentGte = cfg.skipCommentGte || 100;
              const stats = {
                url: location.href,
                feedBuzzCardEls: document.querySelectorAll('.feed-buzz-card-base-view').length,
                cardContentBoxEls: document.querySelectorAll('.card-content-box').length,
                rootEls: document.querySelectorAll('.FeedBuzzBaseViewRoot, [class*="FeedBuzzBaseViewRoot"]').length,
                scannedCards: 0,
                skippedNoText: 0,
                skippedShortText: 0,
                skippedHighComments: 0,
              };
              const rootCards = document.querySelectorAll('.feed-buzz-card-base-view');
              const useRoot = rootCards.length > 0;
              const cards = useRoot ? rootCards : document.querySelectorAll('.card-content-box');
              stats.scanSource = useRoot ? 'feed-buzz-card-base-view' : 'card-content-box (fallback)';
              const out = [];
              const max = Math.min(cards.length, 50);
              for (let i = 0; i < max; i++) {
                stats.scannedCards++;
                const c = cards[i];
                const box = useRoot ? (c.querySelector('.card-content-box') || c) : c;
                const fullTextLink = box.querySelector('.feed-content-text > a[href*="/square/post/"]');
                let text = '';
                if (fullTextLink) text = (fullTextLink.textContent || '').trim();
                if (!text) {
                  const textEl = box.querySelector('.card__description.rich-text')
                    || box.querySelector('.feed-content-text')
                    || box.querySelector('[class*="description"]');
                  text = textEl ? (textEl.textContent || '').trim() : '';
                }
                if (!text) { stats.skippedNoText++; continue; }
                if (text.length < minTextLen) { stats.skippedShortText++; continue; }
                const ccEl = box.querySelector('.comments-icon .num span.current')
                  || box.querySelector('.comments-icon .num')
                  || box.querySelector('.comments-icon span.current');
                let commentCount = 0;
                if (ccEl) {
                  const raw = (ccEl.textContent || '').replace(/[^0-9.kKmM万]/g, '');
                  let n = parseFloat(raw) || 0;
                  if (/[kK]/.test(raw)) n *= 1000;
                  else if (/[mM]/.test(raw)) n *= 1000000;
                  else if (/万/.test(raw)) n *= 10000;
                  commentCount = Math.floor(n);
                }
                if (commentCount >= skipCommentGte) { stats.skippedHighComments++; continue; }
                const likeEl = box.querySelector('.thumb-up-button .num span.current')
                  || box.querySelector('.thumb-up-button .num');
                const likes = likeEl ? parseInt((likeEl.textContent || '').replace(/[^0-9]/g, ''), 10) || 0 : 0;
                const viewEl = box.querySelector('.view-counts .num span.current')
                  || box.querySelector('.view-counts .num');
                let views = 0;
                if (viewEl) {
                  const vraw = (viewEl.textContent || '').replace(/[^0-9.kKmM万]/g, '');
                  let v = parseFloat(vraw) || 0;
                  if (/[kK]/.test(vraw)) v *= 1000;
                  else if (/[mM]/.test(vraw)) v *= 1000000;
                  else if (/万/.test(vraw)) v *= 10000;
                  views = Math.floor(v);
                }
                let nick = '', handle = '', postUrl = '';
                const nickEl = box.querySelector('.nick-username .nick');
                if (nickEl) {
                  nick = (nickEl.textContent || '').trim();
                  const href = nickEl.getAttribute('href') || '';
                  const hm = href.match(/\/profile\/([^/?#]+)/);
                  if (hm) handle = decodeURIComponent(hm[1]);
                }
                const postLinkEl = box.querySelector('.feed-content-text a[href*="/square/post/"]');
                if (postLinkEl) postUrl = postLinkEl.getAttribute('href') || '';
                const cashtags = [];
                const ctEls = box.querySelectorAll('[data-role="coinpair"]');
                for (let ct = 0; ct < ctEls.length; ct++) {
                  const v = ctEls[ct].getAttribute('data-value') || '';
                  if (v) cashtags.push(v);
                }
                let sentiment = '';
                const tendencyEl = box.querySelector('.tendency-icon span');
                if (tendencyEl) sentiment = (tendencyEl.textContent || '').trim();
                out.push({
                  // v1.2.15: 不截断 text — 之前 1500 字符上限把币安长贴砍了,
                  // 改写算源字数全错。原子任务原则:扩展返回原文,业务方决定。
                  index: i, text: text,
                  comment_count: commentCount, likes, views,
                  nick, handle, post_url: postUrl, cashtags, sentiment,
                });
              }
              return { posts: out, stats };
            }

            if (action === 'find_follow_buttons') {
              let btnRoots = document.querySelectorAll('.feed-follow-button button');
              let fallback = false;
              if (!btnRoots.length) {
                btnRoots = document.querySelectorAll('button');
                fallback = true;
              }
              const out = [];
              for (let i = 0; i < btnRoots.length; i++) {
                const b = btnRoots[i];
                const t = (b.textContent || '').trim();
                if (t === '关注' || t === 'Follow' || t === '+ 关注' || t === '+ Follow') {
                  const rect = b.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0 && !b.disabled) {
                    const card = b.closest('.follow-card');
                    let handle = '', nick = '';
                    if (card) {
                      const a = card.querySelector('a[href*="/profile/"]');
                      if (a) {
                        const m = (a.getAttribute('href') || '').match(/\/profile\/([^/?#]+)/);
                        if (m) handle = decodeURIComponent(m[1]);
                      }
                      const n = card.querySelector('.nick');
                      if (n) nick = (n.textContent || '').trim();
                    }
                    out.push({ index: i, text: t, handle, nick, fallback });
                  }
                }
              }
              return { candidates: out };
            }

            if (action === 'click_first_follow_button') {
              const all = document.querySelectorAll('.feed-follow-button button, button');
              for (let i = 0; i < all.length; i++) {
                const b = all[i];
                const t = (b.textContent || '').trim();
                if (t === '关注' || t === 'Follow' || t === '+ 关注' || t === '+ Follow') {
                  const rect = b.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0 && !b.disabled) {
                    b.scrollIntoView({ behavior: 'instant', block: 'center' });
                    b.click();
                    return { clicked: true, text: t };
                  }
                }
              }
              return { clicked: false };
            }

            if (action === 'click_card_comments_icon') {
              const cardIdx = cfg.cardIndex || 0;
              const cards = document.querySelectorAll('.feed-buzz-card-base-view');
              const card = cards[cardIdx] || document.querySelectorAll('.card-content-box')[cardIdx];
              if (!card) return { error: 'card_not_found', scanned: cards.length };
              const commentsBtn = card.querySelector('.comments-icon');
              if (!commentsBtn) return { error: 'comments_icon_not_found' };
              commentsBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
              const clickable = commentsBtn.querySelector('[role="button"]') || commentsBtn.firstElementChild || commentsBtn;
              clickable.click();
              return { ok: true };
            }

            if (action === 'submit_short_editor') {
              // v1.2.10: 扫所有 .short-editor-inner (页面常有多个: 评论模态 +
              // 侧栏发文容器 + 页内 inline 编辑器),只查第一个会找错。
              // 同时:严格相等优先 + substring fuzzy 兜底("回复(0)" / "回复 (0)" 都能匹)。
              const accepted = cfg.acceptedTexts || ['发文', '回复', 'Post', 'Reply', 'Publish'];
              const modals = document.querySelectorAll('.short-editor-inner');
              if (!modals.length) return { error: 'modal_not_found' };
              const allBtns = [];
              const debugTexts = [];
              for (const m of modals) {
                const btns = m.querySelectorAll('button');
                for (const b of btns) allBtns.push(b);
              }
              const norm = (s) => (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
              for (const b of allBtns) {
                const t = norm(b.textContent);
                debugTexts.push(t.slice(0, 20));
                let matched = false;
                for (const a of accepted) {
                  if (t === a) { matched = true; break; }
                }
                if (!matched) {
                  for (const a of accepted) {
                    if (t.length > 0 && t.length <= a.length + 5 && t.indexOf(a) >= 0) {
                      matched = true; break;
                    }
                  }
                }
                if (matched) {
                  if (b.disabled) return { error: 'btn_disabled', text: t };
                  if ((b.className || '').indexOf('inactive') >= 0) return { error: 'btn_inactive', text: t };
                  b.scrollIntoView({ behavior: 'instant', block: 'center' });
                  b.click();
                  return { ok: true, text: t };
                }
              }
              return {
                error: 'submit_btn_not_found',
                scanned: allBtns.length,
                modals: modals.length,
                btn_texts: debugTexts.slice(0, 15),
              };
            }

            if (action === 'prosemirror_insert_text') {
              // v1.2.10: 真正解决 "ProseMirror 文字塞了但 React 不知道,按钮一直
              // inactive" 的根因。CDP type 走的是 keyboard 事件,有时 ProseMirror
              // 的 React 包装层不响应。这里用 document.execCommand('insertText') —
              // 浏览器原生的"插入文字"管道,跟用户键盘输入完全同一条路径
              // (beforeinput → input),React/ProseMirror 必然收到合法事件 →
              // 按钮变 active。execCommand 兜底:手动派 InputEvent('beforeinput')。
              const sel = cfg.selector || '.short-editor-inner .ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]';
              const editor = document.querySelector(sel);
              if (!editor) return { error: 'editor_not_found', selector: sel };
              const text = cfg.text;
              if (typeof text !== 'string') return { error: 'text_required' };
              try {
                editor.focus();
                // 兼容老浏览器:execCommand 优先(虽然 deprecated 但所有现代
                // 浏览器还都支持,且是触发 React onChange 最稳的方式)
                let method = 'unknown';
                let inserted = false;
                if (typeof document.execCommand === 'function') {
                  try {
                    inserted = document.execCommand('insertText', false, text);
                    if (inserted) method = 'execCommand';
                  } catch (_) {}
                }
                if (!inserted) {
                  // Fallback: 手动派发 beforeinput + input(InputEvent + inputType)
                  const ev1 = new InputEvent('beforeinput', {
                    inputType: 'insertText', data: text, bubbles: true, cancelable: true,
                  });
                  editor.dispatchEvent(ev1);
                  const ev2 = new InputEvent('input', {
                    inputType: 'insertText', data: text, bubbles: true,
                  });
                  editor.dispatchEvent(ev2);
                  method = 'dispatchEvent';
                  inserted = true;
                }
                return {
                  ok: inserted,
                  method,
                  textLen: text.length,
                  editorTextLen: (editor.textContent || '').length,
                };
              } catch (e) {
                return { error: 'insert_failed', message: String(e && e.message || e).slice(0, 200) };
              }
            }

            return { error: 'unknown_action: ' + action };
          } catch (e) {
            return { error: 'inner_exception: ' + (e && e.message ? e.message : String(e)) };
          }
        },
        args: [params || {}],
      });
      data = results[0]?.result || { error: 'executeScript_failed' };
    } else {
      // Forward to content script
      const tab = await resolveTab();
      await injectContentScript(tab.id);
      data = await sendToContentScript(tab.id, command, params);
    }

    return { id, success: true, data: data || {} };
  } catch (err) {
    return { id, success: false, error: err.message || String(err) };
  }
}

// Keepalive ping every 25s
setInterval(() => {
  if (port && connected) {
    port.postMessage({ type: 'ping' });
  }
}, 25000);

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({ connected, status: connected ? 'connected' : 'disconnected' });
  } else if (msg.type === 'reconnect') {
    disconnect();
    reconnectDelay = 1000;
    connect();
    sendResponse({ ok: true });
  }
  return true;
});

// Remove nativeMessaging from permissions since it's declared in manifest
// Auto-connect on startup
connect();
