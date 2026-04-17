const statusDiv = document.getElementById('status');
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const hint = document.getElementById('hint');
const reconnectBtn = document.getElementById('reconnectBtn');

const STATUS_MAP = {
  connected: { cls: 'connected', dot: 'green', text: 'Connected to NoobClaw' },
  disconnected: { cls: 'disconnected', dot: 'red', text: 'Disconnected' },
  connecting: { cls: 'connecting', dot: 'yellow', text: 'Connecting...' },
};

function updateUI(status) {
  const s = STATUS_MAP[status] || STATUS_MAP.disconnected;
  statusDiv.className = `status ${s.cls}`;
  dot.className = `dot ${s.dot}`;
  statusText.textContent = s.text;

  if (status === 'connected') {
    hint.textContent = 'Browser assistant is ready. Use NoobClaw to control this browser.';
    hint.className = 'hint';
  } else {
    hint.textContent = 'Make sure NoobClaw desktop client is running.';
    hint.className = 'hint error';
  }
}

if (chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['connectionStatus'], (data) => {
    updateUI(data.connectionStatus || 'disconnected');
  });
} else {
  updateUI('disconnected');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status_update') updateUI(msg.status);
});

reconnectBtn.addEventListener('click', () => {
  updateUI('connecting');
  chrome.runtime.sendMessage({ type: 'reconnect' });
});

chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
  if (response) updateUI(response.connected ? 'connected' : 'disconnected');
});
