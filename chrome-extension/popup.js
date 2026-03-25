const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectForm = document.getElementById('connectForm');
const disconnectForm = document.getElementById('disconnectForm');
const statusDiv = document.getElementById('status');
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');

const STATUS_MAP = {
  connected: { cls: 'connected', dot: 'green', text: 'Connected' },
  disconnected: { cls: 'disconnected', dot: 'red', text: 'Disconnected' },
  connecting: { cls: 'connecting', dot: 'yellow', text: 'Connecting...' },
  no_token: { cls: 'disconnected', dot: 'red', text: 'No token configured' },
  auth_fail: { cls: 'disconnected', dot: 'red', text: 'Invalid token' },
};

function updateUI(status) {
  const s = STATUS_MAP[status] || STATUS_MAP.disconnected;
  statusDiv.className = `status ${s.cls}`;
  dot.className = `dot ${s.dot}`;
  statusText.textContent = s.text;

  if (status === 'connected') {
    connectForm.style.display = 'none';
    disconnectForm.style.display = 'block';
  } else {
    connectForm.style.display = 'block';
    disconnectForm.style.display = 'none';
  }
}

// Load saved config
chrome.storage.local.get(['port', 'token', 'connectionStatus'], (data) => {
  if (data.port) portInput.value = data.port;
  if (data.token) tokenInput.value = data.token;
  updateUI(data.connectionStatus || 'disconnected');
});

// Listen for status updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status_update') {
    updateUI(msg.status);
  }
});

connectBtn.addEventListener('click', () => {
  const port = parseInt(portInput.value) || 12580;
  const token = tokenInput.value.trim();
  if (!token) {
    tokenInput.style.borderColor = '#ff5050';
    return;
  }
  tokenInput.style.borderColor = '';
  updateUI('connecting');
  chrome.runtime.sendMessage({ type: 'connect', port, token });
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  updateUI('disconnected');
});

// Check current status
chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
  if (response) updateUI(response.connected ? 'connected' : 'disconnected');
});
