/**
 * NoobClaw Browser Assistant — Background Service Worker
 * Connects to NoobClaw desktop client via Native Messaging.
 */

const NATIVE_HOST_NAME = 'com.noobclaw.browser';
let port = null;
let connected = false;

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

function connect() {
  if (port) return;

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
  if (/xiaohongshu/.test(patternStr)) return 'https://www.xiaohongshu.com';
  if (/twitter|x\\\.com|x\.com/.test(patternStr)) return 'https://x.com/home';
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
  // Platform name in front (more useful at a glance than brand name).
  // Color stays brand green for "this is NoobClaw automation" recognition.
  const color = 'green';
  if (/xiaohongshu/i.test(patternStr)) {
    return { title: '🤖 小红书任务 · NoobClaw', color };
  }
  if (/twitter|x\\.com|x\.com/i.test(patternStr)) {
    return { title: '🤖 推特任务 · NoobClaw', color };
  }
  return { title: '🤖 NoobClaw 任务', color };
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
  // alias it as `getActiveTab` inside this function so all downstream
  // code paths transparently target the matched tab. The cached resolve
  // means a single command doesn't pay the lookup cost twice.
  let _resolvedTab = null;
  const _outerGetActiveTab = getActiveTab; // legacy "active tab" resolver
  // eslint-disable-next-line no-shadow
  const getActiveTab = async () => {
    if (_resolvedTab) return _resolvedTab;
    _resolvedTab = tabPattern
      ? await findOrOpenTabByPattern(tabPattern)
      : await _outerGetActiveTab();
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
      const tab = await getActiveTab();
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 25 });
      const resized = await resizeImage(dataUrl, 640);
      data = { image: resized.split(',')[1] };
    } else if (command === 'navigate') {
      const tab = await getActiveTab();
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
        const tab = await getActiveTab();
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
      const tab = await getActiveTab();
      const win = await chrome.windows.get(tab.windowId);
      await chrome.windows.update(win.id, {
        width: params.width || win.width,
        height: params.height || win.height,
      });
      data = { message: `Resized to ${params.width}x${params.height}` };
    } else if (command === 'go_back') {
      const tab = await getActiveTab();
      await chrome.tabs.goBack(tab.id);
      data = { message: 'Navigated back' };
    } else if (command === 'go_forward') {
      const tab = await getActiveTab();
      await chrome.tabs.goForward(tab.id);
      data = { message: 'Navigated forward' };
    } else if (command === 'reload') {
      const tab = await getActiveTab();
      await chrome.tabs.reload(tab.id);
      data = { message: 'Page reloaded' };
    } else if (command === 'list_tabs') {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      data = { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
    } else if (command === 'get_tab_info') {
      const tab = await getActiveTab();
      data = { id: tab.id, title: tab.title, url: tab.url, status: tab.status };
    } else if (command === 'main_world_click') {
      // Click in MAIN world — works on React apps where isolated world click fails
      const tab = await getActiveTab();
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
    } else {
      // Forward to content script
      const tab = await getActiveTab();
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
