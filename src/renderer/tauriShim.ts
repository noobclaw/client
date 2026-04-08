/**
 * Tauri Shim — provides window.electron compatible API using HTTP + SSE.
 * When running in Tauri, this shim replaces Electron's preload bridge.
 * Frontend code continues using window.electron.* without any changes.
 */

const SIDECAR_PORT = 18800;
const BASE_URL = `http://127.0.0.1:${SIDECAR_PORT}`;

// ── Detect runtime mode ──

export function isTauriMode(): boolean {
  return !!(window as any).__TAURI__;
}

// ── SSE Event Source for streaming ──

let eventSource: EventSource | null = null;
const eventListeners = new Map<string, Set<Function>>();

function ensureSSE(): void {
  if (eventSource) return;
  eventSource = new EventSource(`${BASE_URL}/api/stream`);

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const listeners = eventListeners.get(e.type || 'message');
      if (listeners) {
        for (const fn of listeners) fn(data);
      }
    } catch {}
  };

  // Listen for specific event types
  const eventTypes = [
    'cowork:stream:message', 'cowork:stream:messageUpdate',
    'cowork:stream:permission', 'cowork:stream:complete',
    'cowork:stream:error',
  ];
  for (const type of eventTypes) {
    eventSource.addEventListener(type, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const listeners = eventListeners.get(type);
        if (listeners) {
          for (const fn of listeners) fn(data);
        }
      } catch {}
    });
  }
}

function onSSE(event: string, callback: Function): () => void {
  ensureSSE();
  if (!eventListeners.has(event)) eventListeners.set(event, new Set());
  eventListeners.get(event)!.add(callback);
  return () => eventListeners.get(event)?.delete(callback);
}

// ── HTTP helpers ──

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

async function apiPost(path: string, body?: any): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Build the shim ──

export function createTauriElectronShim(): typeof window.electron {
  const cowork = {
    listSessions: () => apiGet('/api/sessions'),
    getSession: (id: string) => apiGet(`/api/sessions/${id}`),
    getConfig: () => apiGet('/api/config'),
    updateConfig: (config: any) => apiPost('/api/config', config),

    startSession: (opts: any) => apiPost('/api/session/start', opts),
    continueSession: (opts: any) => apiPost('/api/session/continue', opts),
    stopSession: (id: string) => apiPost('/api/session/stop', { sessionId: id }),
    deleteSession: (id: string) => apiPost('/api/session/delete', { sessionId: id }),
    deleteAllSessions: () => apiPost('/api/sessions/deleteAll'),
    renameSession: (id: string, name: string) => apiPost('/api/session/rename', { sessionId: id, name }),
    pinSession: (id: string, pinned: boolean) => apiPost('/api/session/pin', { sessionId: id, pinned }),

    respondToPermission: (opts: any) => apiPost('/api/permission/respond', opts),

    listMemoryEntries: () => apiGet('/api/memory/list'),
    createMemoryEntry: (entry: any) => apiPost('/api/memory/create', entry),
    updateMemoryEntry: (id: string, entry: any) => apiPost('/api/memory/update', { id, ...entry }),
    deleteMemoryEntry: (id: string) => apiPost('/api/memory/delete', { id }),

    getSandboxStatus: () => apiGet('/api/sandbox/status'),
    installSandbox: () => apiPost('/api/sandbox/install'),
    onSandboxDownloadProgress: (cb: Function) => onSSE('sandbox:progress', cb),

    onStreamMessage: (cb: Function) => onSSE('cowork:stream:message', cb),
    onStreamMessageUpdate: (cb: Function) => onSSE('cowork:stream:messageUpdate', cb),
    onStreamPermission: (cb: Function) => onSSE('cowork:stream:permission', cb),
    onStreamComplete: (cb: Function) => onSSE('cowork:stream:complete', cb),
    onStreamError: (cb: Function) => onSSE('cowork:stream:error', cb),
  };

  const ipcRenderer = {
    on: (channel: string, callback: Function) => onSSE(channel, callback),
    send: (channel: string, ...args: any[]) => apiPost(`/api/ipc/${channel}`, { args }),
    invoke: (channel: string, ...args: any[]) => apiPost(`/api/ipc/${channel}`, { args }),
  };

  return {
    cowork,
    ipcRenderer,
    platform: navigator.platform.includes('Win') ? 'win32' : navigator.platform.includes('Mac') ? 'darwin' : 'linux',
    appInfo: {
      getVersion: () => apiGet('/api/version').then((r: any) => r.version || '1.0.0'),
    },
    shell: {
      openExternal: async (url: string) => {
        if ((window as any).__TAURI__) {
          const { open } = await import('@tauri-apps/plugin-opener');
          await open(url);
          return { success: true };
        }
        window.open(url, '_blank');
        return { success: true };
      },
    },
    dialog: {
      selectFiles: () => Promise.resolve({ canceled: true, filePaths: [] }),
      saveInlineFile: () => Promise.resolve({ success: false }),
      readFileAsDataUrl: () => Promise.resolve({ success: false }),
    },
    networkStatus: {
      send: (status: string) => apiPost('/api/network-status', { status }),
    },
    appUpdate: {
      onDownloadProgress: () => () => {},
      download: () => Promise.resolve({ success: false }),
      install: () => Promise.resolve({ success: false }),
      cancelDownload: () => Promise.resolve(),
    },
    getApiConfig: () => apiGet('/api/apiConfig'),
    checkApiConfig: (opts: any) => apiPost('/api/apiConfig/check', opts),
    saveApiConfig: (config: any) => apiPost('/api/apiConfig/save', config),
    noobclaw: {
      onSsePayload: (cb: Function) => onSSE('noobclaw:sse', cb),
    },
  } as any;
}

// ── Initialize shim ──

export function initTauriShim(): void {
  if (!isTauriMode()) return;

  console.log('[TauriShim] Tauri detected, installing electron shim');
  (window as any).electron = createTauriElectronShim();
}
