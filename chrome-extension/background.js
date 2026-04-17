/**
 * NoobClaw Browser Assistant — Background Service Worker
 * Connects to NoobClaw desktop client via Native Messaging.
 */

const NATIVE_HOST_NAME = 'com.noobclaw.browser';
let port = null;
let connected = false;

// Auto-connect on browser startup, install, and periodic keepalive
chrome.runtime.onStartup.addListener(() => { connect(); });
chrome.runtime.onInstalled.addListener(() => { connect(); });
// Keepalive: MV3 service workers sleep after ~30s idle; setTimeout timers
// don't survive. Chrome alarms DO wake the SW reliably. Every 15 seconds:
// if disconnected, attempt reconnect.
chrome.alarms.create('keepalive', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && !connected) { connect(); }
  if (alarm.name === 'reconnect' && !connected) { connect(); }
});

// Also reconnect when any tab activates — wakes the SW naturally and
// handles the "user just opened Chrome" case where onStartup didn't fire
// (e.g. Chrome was still running in background when last closed).
chrome.tabs.onActivated.addListener(() => {
  if (!connected) connect();
});


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
  // MV3 service worker can sleep mid-timeout. Use chrome.alarms instead —
  // it wakes the SW reliably. Alarm min delay is 30s in packed extensions
  // but ~1s in unpacked/dev. Still better than setTimeout which silently dies.
  const delayMin = Math.max(0.25, reconnectDelay / 60000); // seconds → minutes
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  try {
    chrome.alarms.create('reconnect', { delayInMinutes: delayMin });
  } catch (e) {
    // Fallback
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    }
  }
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

async function executeCommand(msg) {
  const { id, command, params } = msg;
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
