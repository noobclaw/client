/**
 * Tauri Shim — provides window.electron compatible API using HTTP + SSE.
 * When running in Tauri, this shim replaces Electron's preload bridge.
 * Frontend code continues using window.electron.* without any changes.
 *
 * IMPORTANT: All return formats MUST match the Electron IPC handlers in main.ts.
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

  // Generic message handler dispatches ALL event types (not just pre-registered ones)
  // This handles dynamic event types like api:stream:${id}:data
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const listeners = eventListeners.get('message');
      if (listeners) for (const fn of listeners) fn(data);
    } catch {}
  };

  // Override addEventListener to also register on EventSource for named events
  // The sidecar sends named events like "event: cowork:stream:message\ndata: {...}\n\n"
  // We need to register listeners dynamically as they're added
}

function onSSE(event: string, callback: Function): () => void {
  ensureSSE();
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
    // Register on EventSource for this specific event type
    if (eventSource) {
      eventSource.addEventListener(event, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const listeners = eventListeners.get(event);
          if (listeners) for (const fn of listeners) fn(data);
        } catch {}
      });
    }
  }
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

// ── Tauri Dialog helpers ──

async function tauriDialogOpen(opts: any): Promise<string | string[] | null> {
  try {
    const tauri = (window as any).__TAURI__;
    if (tauri?.dialog?.open) return await tauri.dialog.open(opts);
  } catch (e) { console.warn('[TauriShim] dialog.open failed:', e); }
  return null;
}

// ── Build the shim ──
// Every method's return format MUST match the corresponding ipcMain.handle in main.ts

export function createTauriElectronShim(): typeof window.electron {
  return {
    platform: navigator.platform.includes('Win') ? 'win32'
      : navigator.platform.includes('Mac') ? 'darwin' : 'linux',
    arch: navigator.userAgent.includes('arm') ? 'arm64' : 'x64',

    // ── Store (KV) ──
    store: {
      get: (key: string) => ipcInvoke('store:get', key),
      set: (key: string, value: any) => ipcInvoke('store:set', key, value),
      remove: (key: string) => ipcInvoke('store:remove', key),
    },

    // ── Skills ──
    skills: {
      list: () => ipcInvoke('skills:list').then(r => r ?? { success: true, skills: [] }),
      setEnabled: (opts: any) => ipcInvoke('skills:setEnabled', opts).then(r => r ?? { success: true }),
      delete: (id: string) => ipcInvoke('skills:delete', id).then(r => r ?? { success: true }),
      download: (source: string, meta?: any) => ipcInvoke('skills:download', source, meta).then(r => r ?? { success: false, error: 'Not available in Tauri mode' }),
      getRoot: () => ipcInvoke('skills:getRoot').then(r => r ?? ''),
      autoRoutingPrompt: () => ipcInvoke('skills:autoRoutingPrompt').then(r => r ?? { success: true, prompt: '' }),
      getConfig: (id: string) => ipcInvoke('skills:getConfig', id).then(r => r ?? {}),
      setConfig: (id: string, config: any) => ipcInvoke('skills:setConfig', id, config).then(r => r ?? { success: true }),
      testEmailConnectivity: (id: string, config: any) => ipcInvoke('skills:testEmailConnectivity', id, config).then(r => r ?? { success: false }),
      onChanged: (cb: () => void) => onSSE('skills:changed', cb),
    },

    // ── MCP ──
    mcp: {
      list: () => ipcInvoke('mcp:list').then(r => r ?? []),
      create: (data: any) => ipcInvoke('mcp:create', data).then(r => r ?? { success: true }),
      update: (id: string, data: any) => ipcInvoke('mcp:update', id, data).then(r => r ?? { success: true }),
      delete: (id: string) => ipcInvoke('mcp:delete', id).then(r => r ?? { success: true }),
      setEnabled: (opts: any) => ipcInvoke('mcp:setEnabled', opts).then(r => r ?? { success: true }),
      fetchMarketplace: () => ipcInvoke('mcp:fetchMarketplace').then(r => r ?? []),
    },

    // ── Permissions ──
    permissions: {
      checkCalendar: () => Promise.resolve({ status: 'denied' }),
      requestCalendar: () => Promise.resolve({ status: 'denied' }),
    },

    // ── API proxy (for Settings provider validation) ──
    api: {
      fetch: (opts: any) => ipcInvoke('api:fetch', opts).then(r => r ?? { ok: false, status: 0, body: '' }),
      stream: (opts: any) => ipcInvoke('api:stream', opts),
      cancelStream: (id: string) => ipcInvoke('api:stream:cancel', id),
      onStreamData: (id: string, cb: (chunk: string) => void) => onSSE(`api:stream:${id}:data`, cb),
      onStreamDone: (id: string, cb: () => void) => onSSE(`api:stream:${id}:done`, cb),
      onStreamError: (id: string, cb: (err: string) => void) => onSSE(`api:stream:${id}:error`, cb),
      onStreamAbort: (id: string, cb: () => void) => onSSE(`api:stream:${id}:abort`, cb),
    },

    // ── IPC Renderer ──
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => { apiPost('/api/ipc/send', { channel, args }); },
      on: (channel: string, func: (...args: any[]) => void) => onSSE(channel, func),
    },

    // ── Window controls (Tauri uses native titlebar) ──
    window: {
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => { try { (window as any).__TAURI__?.window?.getCurrent?.()?.close?.(); } catch {} },
      isMaximized: () => Promise.resolve(false),
      showSystemMenu: () => {},
      onStateChanged: (cb: any) => onSSE('window:state-changed', cb),
    },

    // ── API Config ──
    getApiConfig: () => apiGet('/api/apiConfig'),
    checkApiConfig: (opts?: any) => apiPost('/api/apiConfig/check', opts || {}),
    saveApiConfig: (config: any) => apiPost('/api/apiConfig/save', config),
    generateSessionTitle: (input: string | null) => ipcInvoke('generate-session-title', input).then(r => r ?? null),
    getRecentCwds: (limit?: number) => ipcInvoke('get-recent-cwds', limit).then(r => r ?? []),

    // ── Cowork ──
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

    // ── Dialog (Tauri native) ──
    dialog: {
      selectDirectory: async () => {
        const selected = await tauriDialogOpen({ directory: true, multiple: false });
        if (selected) return { success: true, path: typeof selected === 'string' ? selected : selected[0] };
        return { success: true, path: null };
      },
      selectFile: async (opts?: any) => {
        const filters = opts?.filters?.map((f: any) => ({ name: f.name, extensions: f.extensions }));
        const selected = await tauriDialogOpen({ directory: false, multiple: false, filters });
        if (selected) return { success: true, path: typeof selected === 'string' ? selected : selected[0] };
        return { success: true, path: null };
      },
      selectFiles: async (opts?: any) => {
        const filters = opts?.filters?.map((f: any) => ({ name: f.name, extensions: f.extensions }));
        const selected = await tauriDialogOpen({ directory: false, multiple: true, filters });
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected];
          return { success: true, filePaths: paths };
        }
        return { success: true, filePaths: [] };
      },
      saveInlineFile: () => Promise.resolve({ success: false, error: 'Not available in Tauri mode' }),
      readFileAsDataUrl: (filePath: string) => ipcInvoke('dialog:readFileAsDataUrl', filePath).then(r => r ?? { success: false }),
    },

    // ── Shell ──
    shell: {
      openPath: (p: string) => ipcInvoke('shell:openPath', p),
      showItemInFolder: (p: string) => ipcInvoke('shell:showItemInFolder', p),
      openExternal: async (url: string) => {
        try {
          const tauri = (window as any).__TAURI__;
          if (tauri?.opener?.openUrl) { await tauri.opener.openUrl(url); return; }
        } catch {}
        window.open(url, '_blank');
      },
    },

    // ── Auto Launch (not available in Tauri, return correct formats) ──
    autoLaunch: {
      get: () => Promise.resolve({ enabled: false }),
      set: (_enabled: boolean) => Promise.resolve({ success: true }),
    },

    // ── App Info ──
    appInfo: {
      getVersion: () => apiGet('/api/version').then((r: any) => r?.version || '1.0.0'),
      getSystemLocale: () => Promise.resolve(navigator.language),
    },

    // ── App Update (stub — Tauri has its own update mechanism) ──
    appUpdate: {
      download: () => Promise.resolve({ success: false }),
      cancelDownload: () => Promise.resolve(),
      install: () => Promise.resolve({ success: false }),
      onDownloadProgress: () => () => {},
    },

    // ── Log ──
    log: {
      getPath: () => ipcInvoke('log:getPath'),
      openFolder: () => ipcInvoke('log:openFolder'),
      exportZip: () => Promise.resolve({ success: false }),
    },

    // ── IM Gateway ──
    im: {
      getConfig: () => ipcInvoke('im:config:get').then(r => r ?? {}),
      setConfig: (config: any) => ipcInvoke('im:config:set', config).then(r => r ?? { success: true }),
      startGateway: (platform: string) => ipcInvoke('im:gateway:start', platform).then(r => r ?? { success: false }),
      stopGateway: (platform: string) => ipcInvoke('im:gateway:stop', platform).then(r => r ?? { success: true }),
      testGateway: (platform: string, override?: any) => ipcInvoke('im:gateway:test', platform, override).then(r => r ?? { success: false }),
      getStatus: () => ipcInvoke('im:status:get').then(r => r ?? {}),
      onStatusChange: (cb: any) => onSSE('im:status:change', cb),
      onMessageReceived: (cb: any) => onSSE('im:message:received', cb),
    },

    // ── Scheduled Tasks ──
    scheduledTasks: {
      list: () => ipcInvoke('scheduledTask:list').then(r => r ?? []),
      get: (id: string) => ipcInvoke('scheduledTask:get', id).then(r => r ?? null),
      create: (input: any) => ipcInvoke('scheduledTask:create', input).then(r => r ?? { success: false }),
      update: (id: string, input: any) => ipcInvoke('scheduledTask:update', id, input).then(r => r ?? { success: false }),
      delete: (id: string) => ipcInvoke('scheduledTask:delete', id).then(r => r ?? { success: true }),
      toggle: (id: string, enabled: boolean) => ipcInvoke('scheduledTask:toggle', id, enabled).then(r => r ?? { success: true }),
      runManually: (id: string) => ipcInvoke('scheduledTask:runManually', id).then(r => r ?? { success: false }),
      stop: (id: string) => ipcInvoke('scheduledTask:stop', id).then(r => r ?? { success: true }),
      listRuns: (taskId: string, limit?: number, offset?: number) =>
        ipcInvoke('scheduledTask:listRuns', taskId, limit, offset).then(r => r ?? []),
      countRuns: (taskId: string) => ipcInvoke('scheduledTask:countRuns', taskId).then(r => r ?? 0),
      listAllRuns: (limit?: number, offset?: number) =>
        ipcInvoke('scheduledTask:listAllRuns', limit, offset).then(r => r ?? []),
      onStatusUpdate: (cb: any) => onSSE('scheduledTask:statusUpdate', cb),
      onRunUpdate: (cb: any) => onSSE('scheduledTask:runUpdate', cb),
    },

    // ── Network Status ──
    networkStatus: {
      send: (status: string) => { apiPost('/api/ipc/send', { channel: 'network:status-change', args: [status] }); },
    },

    // ── Auth ──
    onAuthCallback: (cb: (token: string, wallet: string) => void) =>
      onSSE('auth:callback', (data: any) => cb(data?.token, data?.wallet)),

    // ── NoobClaw Platform ──
    noobclaw: {
      setAuthToken: (token: string | null) => ipcInvoke('noobclaw:set-auth-token', token),
      getMacAddress: () => ipcInvoke('noobclaw:get-mac-address').then(r => r ?? null),
      cacheAvatar: (url: string) => ipcInvoke('noobclaw:cache-avatar', url).then(r => r ?? { success: false, localPath: null }),
      getCachedAvatar: () => ipcInvoke('noobclaw:get-cached-avatar').then(r => r ?? null),
      onSsePayload: (cb: any) => onSSE('noobclaw:sse-payload', cb),
    },
  } as any;
}

// ── Initialize shim ──

export function initTauriShim(): void {
  if (!isTauriMode()) return;

  console.log('[TauriShim] Tauri detected, installing electron shim');
  (window as any).electron = createTauriElectronShim();

  // Listen for deep link auth callback from Tauri (noobclaw://auth?token=xxx&wallet=xxx)
  window.addEventListener('noobclaw-auth', ((e: CustomEvent) => {
    const { token, wallet } = e.detail || {};
    if (token && wallet) {
      console.log('[TauriShim] Auth callback received from deep link');
      const listeners = eventListeners.get('auth:callback');
      if (listeners) {
        for (const fn of listeners) fn({ token, wallet });
      }
    }
  }) as EventListener);
}
