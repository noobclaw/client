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

  // Listen for named event types from sidecar
  const eventTypes = [
    'cowork:stream:message', 'cowork:stream:messageUpdate',
    'cowork:stream:permission', 'cowork:stream:complete',
    'cowork:stream:error', 'cowork:sandbox:downloadProgress',
    'scheduledTask:statusUpdate', 'scheduledTask:runUpdate',
    'im:status:change', 'im:message:received',
    'skills:changed', 'window:state-changed',
    'noobclaw:sse-payload', 'auth:callback',
  ];
  for (const type of eventTypes) {
    eventSource.addEventListener(type, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const listeners = eventListeners.get(type);
        if (listeners) for (const fn of listeners) fn(data);
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
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    return res.json();
  } catch (e) {
    console.warn(`[TauriShim] GET ${path} failed:`, e);
    return null;
  }
}

async function apiPost(path: string, body?: any): Promise<any> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  } catch (e) {
    console.warn(`[TauriShim] POST ${path} failed:`, e);
    return null;
  }
}

// Generic IPC invoke via HTTP
async function ipcInvoke(channel: string, ...args: any[]): Promise<any> {
  return apiPost('/api/ipc/invoke', { channel, args });
}

// ── Build the shim ──

export function createTauriElectronShim(): typeof window.electron {
  return {
    platform: navigator.platform.includes('Win') ? 'win32'
      : navigator.platform.includes('Mac') ? 'darwin' : 'linux',
    arch: navigator.userAgent.includes('arm') ? 'arm64' : 'x64',

    store: {
      get: (key: string) => ipcInvoke('store:get', key),
      set: (key: string, value: any) => ipcInvoke('store:set', key, value),
      remove: (key: string) => ipcInvoke('store:remove', key),
    },

    skills: {
      list: () => ipcInvoke('skills:list'),
      setEnabled: (opts: any) => ipcInvoke('skills:setEnabled', opts),
      delete: (id: string) => ipcInvoke('skills:delete', id),
      download: (source: string, meta?: any) => ipcInvoke('skills:download', source, meta),
      getRoot: () => ipcInvoke('skills:getRoot'),
      autoRoutingPrompt: () => ipcInvoke('skills:autoRoutingPrompt'),
      getConfig: (id: string) => ipcInvoke('skills:getConfig', id),
      setConfig: (id: string, config: any) => ipcInvoke('skills:setConfig', id, config),
      testEmailConnectivity: (id: string, config: any) => ipcInvoke('skills:testEmailConnectivity', id, config),
      onChanged: (cb: () => void) => onSSE('skills:changed', cb),
    },

    mcp: {
      list: () => ipcInvoke('mcp:list'),
      create: (data: any) => ipcInvoke('mcp:create', data),
      update: (id: string, data: any) => ipcInvoke('mcp:update', id, data),
      delete: (id: string) => ipcInvoke('mcp:delete', id),
      setEnabled: (opts: any) => ipcInvoke('mcp:setEnabled', opts),
      fetchMarketplace: () => ipcInvoke('mcp:fetchMarketplace'),
    },

    permissions: {
      checkCalendar: () => Promise.resolve(false),
      requestCalendar: () => Promise.resolve(false),
    },

    api: {
      fetch: (opts: any) => ipcInvoke('api:fetch', opts),
      stream: (opts: any) => ipcInvoke('api:stream', opts),
      cancelStream: (id: string) => ipcInvoke('api:stream:cancel', id),
      onStreamData: (id: string, cb: (chunk: string) => void) => onSSE(`api:stream:${id}:data`, cb),
      onStreamDone: (id: string, cb: () => void) => onSSE(`api:stream:${id}:done`, cb),
      onStreamError: (id: string, cb: (err: string) => void) => onSSE(`api:stream:${id}:error`, cb),
      onStreamAbort: (id: string, cb: () => void) => onSSE(`api:stream:${id}:abort`, cb),
    },

    ipcRenderer: {
      send: (channel: string, ...args: any[]) => { apiPost('/api/ipc/send', { channel, args }); },
      on: (channel: string, func: (...args: any[]) => void) => onSSE(channel, func),
    },

    window: {
      minimize: () => { /* Tauri handles via native titlebar */ },
      toggleMaximize: () => { /* Tauri handles via native titlebar */ },
      close: () => { (window as any).__TAURI__?.window?.getCurrent?.()?.close?.(); },
      isMaximized: () => Promise.resolve(false),
      showSystemMenu: () => {},
      onStateChanged: (cb: any) => onSSE('window:state-changed', cb),
    },

    getApiConfig: () => apiGet('/api/apiConfig'),
    checkApiConfig: (opts?: any) => apiPost('/api/apiConfig/check', opts),
    saveApiConfig: (config: any) => apiPost('/api/apiConfig/save', config),
    generateSessionTitle: (input: string | null) => ipcInvoke('generate-session-title', input),
    getRecentCwds: (limit?: number) => ipcInvoke('get-recent-cwds', limit),

    cowork: {
      startSession: (opts: any) => apiPost('/api/session/start', opts),
      continueSession: (opts: any) => apiPost('/api/session/continue', opts),
      stopSession: (id: string) => apiPost('/api/session/stop', { sessionId: id }),
      deleteSession: (id: string) => apiPost('/api/session/delete', { sessionId: id }),
      deleteSessions: (ids: string[]) => apiPost('/api/session/deleteBatch', { sessionIds: ids }),
      setSessionPinned: (opts: any) => apiPost('/api/session/pin', opts),
      renameSession: (opts: any) => apiPost('/api/session/rename', opts),
      getSession: (id: string) => apiGet(`/api/session/${id}`),
      listSessions: () => apiGet('/api/sessions'),
      exportResultImage: () => Promise.resolve({ success: false }),
      captureImageChunk: () => Promise.resolve({ success: false }),
      saveResultImage: () => Promise.resolve({ success: false }),

      respondToPermission: (opts: any) => apiPost('/api/permission/respond', opts),

      getConfig: () => apiGet('/api/config'),
      setConfig: (config: any) => apiPost('/api/config', config),

      listMemoryEntries: (input: any) => apiPost('/api/memory/list', input),
      createMemoryEntry: (input: any) => apiPost('/api/memory/create', input),
      updateMemoryEntry: (input: any) => apiPost('/api/memory/update', input),
      deleteMemoryEntry: (input: any) => apiPost('/api/memory/delete', input),
      getMemoryStats: () => apiGet('/api/memory/stats'),

      getSandboxStatus: () => apiGet('/api/sandbox/status'),
      installSandbox: () => apiPost('/api/sandbox/install'),
      onSandboxDownloadProgress: (cb: any) => onSSE('cowork:sandbox:downloadProgress', cb),

      onStreamMessage: (cb: any) => onSSE('cowork:stream:message', cb),
      onStreamMessageUpdate: (cb: any) => onSSE('cowork:stream:messageUpdate', cb),
      onStreamPermission: (cb: any) => onSSE('cowork:stream:permission', cb),
      onStreamComplete: (cb: any) => onSSE('cowork:stream:complete', cb),
      onStreamError: (cb: any) => onSSE('cowork:stream:error', cb),
    },

    dialog: {
      selectDirectory: () => Promise.resolve({ canceled: true, filePaths: [] }),
      selectFile: () => Promise.resolve({ canceled: true, filePaths: [] }),
      selectFiles: () => Promise.resolve({ canceled: true, filePaths: [] }),
      saveInlineFile: () => Promise.resolve({ success: false }),
      readFileAsDataUrl: () => Promise.resolve({ success: false }),
    },

    shell: {
      openPath: (p: string) => ipcInvoke('shell:openPath', p),
      showItemInFolder: (p: string) => ipcInvoke('shell:showItemInFolder', p),
      openExternal: async (url: string) => {
        // Use Tauri opener plugin if available, fallback to window.open
        try {
          const tauri = (window as any).__TAURI__;
          if (tauri?.opener?.openUrl) {
            await tauri.opener.openUrl(url);
            return;
          }
        } catch {}
        window.open(url, '_blank');
      },
    },

    autoLaunch: {
      get: () => Promise.resolve(false),
      set: () => Promise.resolve(),
    },

    appInfo: {
      getVersion: () => apiGet('/api/version').then((r: any) => r?.version || '1.0.0'),
      getSystemLocale: () => Promise.resolve(navigator.language),
    },

    appUpdate: {
      download: () => Promise.resolve({ success: false }),
      cancelDownload: () => Promise.resolve(),
      install: () => Promise.resolve({ success: false }),
      onDownloadProgress: () => () => {},
    },

    log: {
      getPath: () => ipcInvoke('log:getPath'),
      openFolder: () => ipcInvoke('log:openFolder'),
      exportZip: () => Promise.resolve({ success: false }),
    },

    im: {
      getConfig: () => ipcInvoke('im:config:get'),
      setConfig: (config: any) => ipcInvoke('im:config:set', config),
      startGateway: (platform: string) => ipcInvoke('im:gateway:start', platform),
      stopGateway: (platform: string) => ipcInvoke('im:gateway:stop', platform),
      testGateway: (platform: string, override?: any) => ipcInvoke('im:gateway:test', platform, override),
      getStatus: () => ipcInvoke('im:status:get'),
      onStatusChange: (cb: any) => onSSE('im:status:change', cb),
      onMessageReceived: (cb: any) => onSSE('im:message:received', cb),
    },

    scheduledTasks: {
      list: () => ipcInvoke('scheduledTask:list'),
      get: (id: string) => ipcInvoke('scheduledTask:get', id),
      create: (input: any) => ipcInvoke('scheduledTask:create', input),
      update: (id: string, input: any) => ipcInvoke('scheduledTask:update', id, input),
      delete: (id: string) => ipcInvoke('scheduledTask:delete', id),
      toggle: (id: string, enabled: boolean) => ipcInvoke('scheduledTask:toggle', id, enabled),
      runManually: (id: string) => ipcInvoke('scheduledTask:runManually', id),
      stop: (id: string) => ipcInvoke('scheduledTask:stop', id),
      listRuns: (taskId: string, limit?: number, offset?: number) =>
        ipcInvoke('scheduledTask:listRuns', taskId, limit, offset),
      countRuns: (taskId: string) => ipcInvoke('scheduledTask:countRuns', taskId),
      listAllRuns: (limit?: number, offset?: number) =>
        ipcInvoke('scheduledTask:listAllRuns', limit, offset),
      onStatusUpdate: (cb: any) => onSSE('scheduledTask:statusUpdate', cb),
      onRunUpdate: (cb: any) => onSSE('scheduledTask:runUpdate', cb),
    },

    networkStatus: {
      send: (status: string) => { apiPost('/api/network-status', { status }); },
    },

    onAuthCallback: (cb: (token: string, wallet: string) => void) =>
      onSSE('auth:callback', (data: any) => cb(data.token, data.wallet)),

    noobclaw: {
      setAuthToken: (token: string | null) => ipcInvoke('noobclaw:set-auth-token', token),
      getMacAddress: () => ipcInvoke('noobclaw:get-mac-address'),
      cacheAvatar: (url: string) => ipcInvoke('noobclaw:cache-avatar', url),
      getCachedAvatar: () => ipcInvoke('noobclaw:get-cached-avatar'),
      onSsePayload: (cb: any) => onSSE('noobclaw:sse-payload', cb),
    },
  } as any;
}

// ── Initialize shim ──

export function initTauriShim(): void {
  if (!isTauriMode()) return;

  console.log('[TauriShim] Tauri detected, installing electron shim');
  (window as any).electron = createTauriElectronShim();
}
