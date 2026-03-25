/**
 * NoobClaw Browser Assistant — Background Service Worker
 * Maintains WebSocket connection to NoobClaw desktop client.
 */

let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// Load saved config
async function getConfig() {
  const data = await chrome.storage.local.get(['port', 'token', 'autoConnect']);
  return {
    port: data.port || 12580,
    token: data.token || '',
    autoConnect: data.autoConnect !== false,
  };
}

async function connect() {
  const config = await getConfig();
  if (!config.token) {
    updateStatus('no_token');
    return;
  }

  if (ws && ws.readyState <= 1) return; // already connecting/open

  updateStatus('connecting');

  try {
    ws = new WebSocket(`ws://127.0.0.1:${config.port}`);

    ws.onopen = () => {
      console.log('[NoobClaw] Connected to bridge');
      ws.send(JSON.stringify({ type: 'auth', token: config.token }));
      reconnectDelay = 1000;
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'auth_ok') {
          connected = true;
          updateStatus('connected');
          return;
        }

        if (msg.type === 'auth_fail') {
          connected = false;
          updateStatus('auth_fail');
          ws.close();
          return;
        }

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

    ws.onerror = (err) => {
      console.error('[NoobClaw] WebSocket error:', err);
    };
  } catch (err) {
    console.error('[NoobClaw] Connect failed:', err);
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
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const config = await getConfig();
    if (config.autoConnect && config.token) {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connect();
    }
  }, reconnectDelay);
}

function updateStatus(status) {
  chrome.storage.local.set({ connectionStatus: status });
  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'status_update', status }).catch(() => {});
}

async function executeCommand(msg) {
  const { id, command, params } = msg;
  try {
    let data;

    if (command === 'screenshot') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
      data = { image: dataUrl.split(',')[1] };
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
  if (msg.type === 'connect') {
    chrome.storage.local.set({ port: msg.port, token: msg.token }, () => {
      connect();
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
  } else if (msg.type === 'get_status') {
    sendResponse({ connected, status: connected ? 'connected' : 'disconnected' });
  }
  return true;
});

// Auto-connect on startup
getConfig().then(config => {
  if (config.autoConnect && config.token) {
    connect();
  }
});
