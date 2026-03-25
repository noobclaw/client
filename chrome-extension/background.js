/**
 * NoobClaw Browser Assistant — Background Service Worker
 * Auto-connects to NoobClaw desktop client via WebSocket on localhost.
 * No token needed — security is ensured by localhost-only binding.
 */

let ws = null;
let connected = false;

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
const DEFAULT_PORT = 12580;

function connect() {
  if (ws && ws.readyState <= 1) return;

  updateStatus('connecting');

  try {
    ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}`);

    ws.onopen = () => {
      console.log('[NoobClaw] Connected to desktop client');
      reconnectDelay = 1000;
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Connection confirmed
        if (msg.type === 'connected') {
          connected = true;
          updateStatus('connected');
          return;
        }

        // Keepalive
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Command from NoobClaw
        if (msg.id && msg.command) {
          const result = await executeCommand(msg);
          ws.send(JSON.stringify(result));
        }
      } catch (err) {
        console.error('[NoobClaw] Message error:', err);
      }
    };

    ws.onclose = () => {
      connected = false;
      updateStatus('disconnected');
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // Will trigger onclose
    };
  } catch (err) {
    updateStatus('disconnected');
    scheduleReconnect();
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close(1000, 'User disconnect');
    ws = null;
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

async function executeCommand(msg) {
  const { id, command, params } = msg;
  try {
    let data;

    if (command === 'screenshot') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 40 });
      // Resize to max 800px width to reduce token usage
      const resized = await resizeImage(dataUrl, 800);
      data = { image: resized.split(',')[1] };
    } else if (command === 'navigate') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
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
      const updated = await chrome.tabs.get(tab.id);
      data = { url: updated.url, title: updated.title };
    } else {
      // Forward to content script
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      // Ensure content script is injected
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch (e) {
        // Already injected or restricted page
      }

      data = await chrome.tabs.sendMessage(tab.id, { command, params });
    }

    return { id, success: true, data: data || {} };
  } catch (err) {
    return { id, success: false, error: err.message || String(err) };
  }
}

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

// Auto-connect on startup
connect();
