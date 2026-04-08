/**
 * NoobClaw Sidecar Server — HTTP + SSE server for Tauri mode.
 * Replaces Electron IPC with HTTP API + Server-Sent Events.
 *
 * Architecture:
 * - Tauri WebView ←→ HTTP/SSE ←→ This server ←→ CoworkRunner ←→ AI APIs
 * - No Electron dependency. Uses platformAdapter for OS integration.
 */

import http from 'http';
import path from 'path';
import { ensureDataDirs, getUserDataPath } from './libs/platformAdapter';
import { coworkLog } from './libs/coworkLogger';

// Ensure directories exist before anything else
ensureDataDirs();

const PORT = parseInt(process.argv[2] || '18800', 10);

// ── SSE Client Management ──

const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ── CoworkRunner Integration (lazy loaded to avoid Electron imports at module level) ──

let runnerInstance: any = null;

async function getRunner() {
  if (runnerInstance) return runnerInstance;

  // Dynamic import to avoid top-level Electron dependencies
  try {
    const { CoworkRunner } = await import('./libs/coworkRunner');
    const { CoworkStore } = await import('./coworkStore');
    const { SqliteStore } = await import('./sqliteStore');

    // Initialize SQLite store (loads existing DB from disk if available)
    const sqliteStore = await SqliteStore.create(getUserDataPath());
    const store = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());

    // Wire up claudeSettings store getter so API config resolution works
    const { setStoreGetter } = await import('./libs/claudeSettings');
    setStoreGetter(() => sqliteStore);

    runnerInstance = new CoworkRunner(store);
    // Expose sqliteStore for KV operations (store:get/set)
    (runnerInstance as any)._sqliteStore = sqliteStore;

    // Wire events to SSE broadcasts
    runnerInstance.on('message', (sessionId: string, message: any) => {
      broadcastSSE('cowork:stream:message', { sessionId, message });
    });
    runnerInstance.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
      broadcastSSE('cowork:stream:messageUpdate', { sessionId, messageId, content });
    });
    runnerInstance.on('permissionRequest', (sessionId: string, request: any) => {
      broadcastSSE('cowork:stream:permission', { sessionId, request });
    });
    runnerInstance.on('complete', (sessionId: string) => {
      broadcastSSE('cowork:stream:complete', { sessionId });
    });
    runnerInstance.on('error', (sessionId: string, error: string) => {
      broadcastSSE('cowork:stream:error', { sessionId, error });
    });

    // Start browser bridge (TCP server on port 12581 for Chrome extension)
    try {
      const { startBrowserBridge, registerNativeMessagingHost } = await import('./libs/browserBridge');
      await startBrowserBridge();
      registerNativeMessagingHost();
      coworkLog('INFO', 'sidecar-server', 'Browser bridge started');
    } catch (e: any) {
      coworkLog('WARN', 'sidecar-server', `Browser bridge failed: ${e.message}`);
    }

    coworkLog('INFO', 'sidecar-server', 'CoworkRunner initialized');

    // Start OpenAI compatibility proxy AFTER returning runner (non-blocking)
    // This prevents the proxy startup from blocking the entire init chain
    setImmediate(async () => {
      try {
        console.log('[sidecar] Starting OpenAI compat proxy...');
        const { startCoworkOpenAICompatProxy, getCoworkOpenAICompatProxyStatus } = await import('./libs/coworkOpenAICompatProxy');
        await startCoworkOpenAICompatProxy();
        const status = getCoworkOpenAICompatProxyStatus();
        console.log(`[sidecar] OpenAI compat proxy started: running=${status.running}, baseURL=${status.baseURL}`);
      } catch (e: any) {
        console.error(`[sidecar] OpenAI compat proxy failed: ${e.message || e}`);
      }
    });
    return runnerInstance;
  } catch (e: any) {
    console.error('[sidecar] FATAL: Failed to init CoworkRunner:', e?.message || e, e?.stack || '');
    coworkLog('ERROR', 'sidecar-server', `Failed to init CoworkRunner: ${e}`);
    return null;
  }
}

// ── SkillManager (lazy loaded) ──

let skillManagerInstance: any = null;

async function getSkillManagerInstance(): Promise<any> {
  if (skillManagerInstance) return skillManagerInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { SkillManager } = await import('./skillManager');
    const sqlStore = runner._sqliteStore;
    skillManagerInstance = new SkillManager(() => sqlStore);
    // Copy bundled skills to userData on first run
    try { skillManagerInstance.syncBundledSkillsToUserData(); } catch (e) { console.warn('[sidecar] syncBundledSkills failed:', e); }
    coworkLog('INFO', 'sidecar-server', `SkillManager initialized, skills: ${skillManagerInstance.listSkills()?.length ?? 0}`);
    return skillManagerInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar-server', `SkillManager init failed: ${e}`);
    return null;
  }
}

// ── McpStore (lazy loaded) ──

let mcpStoreInstance: any = null;

async function getMcpStoreInstance(): Promise<any> {
  if (mcpStoreInstance) return mcpStoreInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { McpStore } = await import('./mcpStore');
    const db = runner._sqliteStore.getDatabase();
    const saveFn = runner._sqliteStore.getSaveFunction();
    mcpStoreInstance = new McpStore(db, saveFn);
    return mcpStoreInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `McpStore init failed: ${e}`);
    return null;
  }
}

// ── ScheduledTaskStore + Scheduler (lazy loaded) ──

let scheduledTaskStoreInstance: any = null;
let schedulerInstance: any = null;

async function getScheduledTaskStoreInstance(): Promise<any> {
  if (scheduledTaskStoreInstance) return scheduledTaskStoreInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { ScheduledTaskStore } = await import('./scheduledTaskStore');
    const db = runner._sqliteStore.getDatabase();
    const saveFn = runner._sqliteStore.getSaveFunction();
    scheduledTaskStoreInstance = new ScheduledTaskStore(db, saveFn);
    return scheduledTaskStoreInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `ScheduledTaskStore init failed: ${e}`);
    return null;
  }
}

async function getSchedulerInstance(): Promise<any> {
  if (schedulerInstance) return schedulerInstance;
  try {
    const sts = await getScheduledTaskStoreInstance();
    const runner = await getRunner();
    if (!sts || !runner) return null;
    const { Scheduler } = await import('./libs/scheduler');
    schedulerInstance = new Scheduler({
      scheduledTaskStore: sts,
      coworkStore: runner.store,
      getCoworkRunner: () => runner,
      getIMGatewayManager: () => imGatewayManagerInstance,
      getSkillsPrompt: async () => '',
    });
    schedulerInstance.start?.();
    return schedulerInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `Scheduler init failed: ${e}`);
    return null;
  }
}

// ── IMGatewayManager (lazy loaded) ──

let imGatewayManagerInstance: any = null;

async function getIMGatewayManagerInstance(): Promise<any> {
  if (imGatewayManagerInstance) return imGatewayManagerInstance;
  try {
    const runner = await getRunner();
    if (!runner?._sqliteStore) return null;
    const { IMGatewayManager } = await import('./im/imGatewayManager');
    const db = runner._sqliteStore.getDatabase();
    const saveFn = runner._sqliteStore.getSaveFunction();
    imGatewayManagerInstance = new IMGatewayManager(db, saveFn, {
      coworkRunner: runner,
      coworkStore: runner.store,
    });
    // Wire IM events to SSE
    imGatewayManagerInstance.on?.('statusChange', (status: any) => broadcastSSE('im:status:change', status));
    imGatewayManagerInstance.on?.('message', (msg: any) => broadcastSSE('im:message:received', msg));
    return imGatewayManagerInstance;
  } catch (e) {
    coworkLog('WARN', 'sidecar', `IMGatewayManager init failed: ${e}`);
    return null;
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    // ── SSE Stream ──
    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      sseClients.add(res);
      const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); } }, 30000);
      req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
      return;
    }

    // ── Status ──
    if (pathname === '/api/status') {
      return writeJSON(res, 200, { status: 'ok', port: PORT, mode: 'tauri-sidecar', clients: sseClients.size });
    }

    // ── Sessions ──
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: true, sessions: [] });
      const sessions = runner.store.listSessions();
      return writeJSON(res, 200, { success: true, sessions });
    }

    if (pathname === '/api/session/start' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });

      try {
        const config = runner.store.getConfig();
        const cwd = body.cwd || config.workingDirectory || require('os').homedir();
        const title = body.prompt?.split('\n')[0]?.slice(0, 50) || 'New Session';
        const session = runner.store.createSession(title, cwd, body.systemPrompt || config.systemPrompt || '', config.executionMode || 'local', body.activeSkillIds || []);
        runner.store.addMessage(session.id, { type: 'user', content: body.prompt, metadata: body.imageAttachments?.length ? { imageAttachments: body.imageAttachments } : undefined });
        runner.store.updateSession(session.id, { status: 'running' });

        // Start async (don't await)
        runner.startSession(session.id, body.prompt, {
          skipInitialUserMessage: true,
          systemPrompt: body.systemPrompt,
          imageAttachments: body.imageAttachments,
          skillIds: body.activeSkillIds,
          workspaceRoot: cwd,
        }).catch((e: any) => {
          coworkLog('ERROR', 'sidecar', `Session error: ${e}`);
          runner.store.updateSession(session.id, { status: 'error' });
          runner.store.addMessage(session.id, { type: 'system', content: `Error: ${e.message || e}` });
          broadcastSSE('cowork:stream:error', { sessionId: session.id, error: String(e) });
        });

        const updatedSession = runner.store.getSession(session.id) || session;
        return writeJSON(res, 200, { success: true, session: updatedSession });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/session/continue' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });

      try {
        runner.continueSession(body.sessionId, body.prompt, {
          systemPrompt: body.systemPrompt,
          imageAttachments: body.imageAttachments,
        }).catch((e: any) => {
          coworkLog('ERROR', 'sidecar', `Continue error: ${e}`);
          broadcastSSE('cowork:stream:error', { sessionId: body.sessionId, error: String(e) });
        });

        const session = runner.store.getSession(body.sessionId);
        return writeJSON(res, 200, { success: true, session });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/session/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) {
        runner.stopSession(body.sessionId);
        runner.store.updateSession(body.sessionId, { status: 'idle' });
      }
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/session/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.deleteSession(body.sessionId);
      return writeJSON(res, 200, { success: true });
    }

    // ── Permission ──
    if (pathname === '/api/permission/respond' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.respondToPermission(body.requestId, body.result);
      return writeJSON(res, 200, { success: true });
    }

    // ── Config ──
    if (pathname === '/api/config' && req.method === 'GET') {
      const runner = await getRunner();
      if (!runner) {
        const os = require('os');
        return writeJSON(res, 200, { success: true, config: { workingDirectory: os.homedir(), executionMode: 'local' } });
      }
      return writeJSON(res, 200, { success: true, config: runner.store.getConfig() });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.setConfig(body);
      return writeJSON(res, 200, { success: true });
    }

    // ── API Config ──
    if (pathname === '/api/apiConfig' && req.method === 'GET') {
      try {
        const runner = await getRunner(); // ensure store is initialized
        const { getCurrentApiConfig } = await import('./libs/claudeSettings');
        const config = getCurrentApiConfig();
        if (config) return writeJSON(res, 200, { hasConfig: true, config });
        // Even if resolveCurrentApiConfig fails (e.g., no auth token for noobclawAI),
        // return the raw app_config so frontend knows a provider IS configured
        const ss = runner?._sqliteStore;
        const appConfig = ss?.get?.('app_config');
        if (appConfig?.providers) {
          // Find any enabled provider
          const enabledProvider = Object.entries(appConfig.providers).find(([_, v]: [string, any]) => v?.enabled);
          if (enabledProvider) {
            return writeJSON(res, 200, {
              hasConfig: true,
              config: {
                apiKey: '',
                baseURL: (enabledProvider[1] as any).baseUrl || '',
                model: appConfig.model?.defaultModel || '',
                apiType: (enabledProvider[1] as any).apiFormat || 'openai',
                providerName: enabledProvider[0],
                isOpenAICompat: (enabledProvider[1] as any).apiFormat === 'openai',
              },
              needsAuth: enabledProvider[0] === 'noobclawAI',
            });
          }
        }
        return writeJSON(res, 200, { hasConfig: false, config: null });
      } catch (e) {
        return writeJSON(res, 200, { hasConfig: false, config: null, error: String(e) });
      }
    }

    if (pathname === '/api/apiConfig/check' && req.method === 'POST') {
      try {
        const runner = await getRunner(); // ensure store + proxy initialized
        const { resolveCurrentApiConfig, getNoobClawAuthToken } = await import('./libs/claudeSettings');
        const { config, error } = resolveCurrentApiConfig();
        if (config) {
          return writeJSON(res, 200, { hasConfig: true, config });
        }
        // If noobclawAI is configured but auth token is missing, tell frontend to login
        const ss = runner?._sqliteStore;
        const appConfig = ss?.get?.('app_config');
        const noobclawEnabled = appConfig?.providers?.noobclawAI?.enabled;
        if (noobclawEnabled && !getNoobClawAuthToken()) {
          return writeJSON(res, 200, { hasConfig: false, error: 'Missing auth token — please connect your wallet to use NoobClaw AI.' });
        }
        return writeJSON(res, 200, { hasConfig: false, config: null, error });
      } catch (e) {
        return writeJSON(res, 200, { hasConfig: false, config: null, error: String(e) });
      }
    }

    if (pathname === '/api/apiConfig/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        await getRunner(); // ensure store is initialized
        const { saveCoworkApiConfig } = await import('./libs/coworkConfigStore');
        saveCoworkApiConfig(body);
        return writeJSON(res, 200, { success: true });
      } catch (e) {
        return writeJSON(res, 500, { error: String(e) });
      }
    }

    // ── Session detail ──
    if (pathname.startsWith('/api/session/') && req.method === 'GET' && !pathname.includes('/api/session/start') && !pathname.includes('/api/session/stop') && !pathname.includes('/api/session/delete') && !pathname.includes('/api/session/pin') && !pathname.includes('/api/session/rename')) {
      const sessionId = pathname.split('/api/session/')[1];
      if (sessionId) {
        const runner = await getRunner();
        if (!runner) return writeJSON(res, 200, { success: false, error: 'Runner not ready' });
        const session = runner.store.getSession(sessionId); // includes messages
        return writeJSON(res, 200, { success: true, session });
      }
    }

    if (pathname === '/api/session/deleteBatch' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) for (const id of (body.sessionIds || [])) runner.store.deleteSession(id);
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/session/pin' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateSession(body.sessionId, { pinned: body.pinned });
      return writeJSON(res, 200, { status: 'ok' });
    }

    if (pathname === '/api/session/rename' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateSession(body.sessionId, { title: body.title });
      return writeJSON(res, 200, { status: 'ok' });
    }

    // ── Memory ──
    if (pathname === '/api/memory/list' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { entries: [], total: 0 });
      return writeJSON(res, 200, runner.store.listMemoryEntries?.(body) || []);
    }

    if (pathname === '/api/memory/create' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 503, { error: 'Runner not ready' });
      const entry = runner.store.createMemoryEntry?.(body);
      return writeJSON(res, 200, { success: true, entry });
    }

    if (pathname === '/api/memory/update' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateMemoryEntry?.(body);
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/memory/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.deleteMemoryEntry?.(body.id);
      return writeJSON(res, 200, { success: true });
    }

    if (pathname === '/api/memory/stats' && req.method === 'GET') {
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 200, { total: 0 });
      return writeJSON(res, 200, runner.store.getMemoryStats?.() || { total: 0 });
    }

    // ── Sandbox ──
    if (pathname === '/api/sandbox/status' && req.method === 'GET') {
      return writeJSON(res, 200, { ready: false, mode: 'tauri-sidecar' });
    }

    if (pathname === '/api/sandbox/install' && req.method === 'POST') {
      return writeJSON(res, 200, { status: 'not-supported', message: 'Sandbox not available in Tauri mode' });
    }

    // ── Generic IPC invoke (for features not yet ported to dedicated routes) ──
    if (pathname === '/api/ipc/invoke' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { channel, args } = body;
      const runner = await getRunner();

      // Route IPC channels to runner methods
      const ss = runner?._sqliteStore;
      try {
        switch (channel) {
          // ── Store KV ──
          case 'store:get': return writeJSON(res, 200, ss?.get?.(args[0]) ?? null);
          case 'store:set': ss?.set?.(args[0], args[1]); return writeJSON(res, 200, { status: 'ok' });
          case 'store:remove': ss?.delete?.(args[0]); return writeJSON(res, 200, { status: 'ok' });

          // ── Skills ──
          case 'skills:list': {
            const sm = await getSkillManagerInstance();
            return writeJSON(res, 200, { success: true, skills: sm?.listSkills?.() ?? [] });
          }
          case 'skills:setEnabled': {
            const sm = await getSkillManagerInstance();
            sm?.setSkillEnabled?.(args[0]?.id, args[0]?.enabled);
            return writeJSON(res, 200, { success: true });
          }
          case 'skills:delete': {
            const sm = await getSkillManagerInstance();
            sm?.deleteSkill?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'skills:download': {
            const sm = await getSkillManagerInstance();
            try {
              const result = await sm?.downloadSkill?.(args[0], args[1]);
              return writeJSON(res, 200, result ?? { success: true });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e.message });
            }
          }
          case 'skills:getRoot': {
            const sm = await getSkillManagerInstance();
            return writeJSON(res, 200, sm?.getSkillsRoot?.() ?? '');
          }
          case 'skills:autoRoutingPrompt': {
            const sm = await getSkillManagerInstance();
            try {
              const prompt = sm?.buildAutoRoutingPrompt?.() ?? '';
              return writeJSON(res, 200, { success: true, prompt });
            } catch { return writeJSON(res, 200, { success: true, prompt: '' }); }
          }
          case 'skills:getConfig': {
            const sm = await getSkillManagerInstance();
            return writeJSON(res, 200, sm?.getSkillConfig?.(args[0]) ?? {});
          }
          case 'skills:setConfig': {
            const sm = await getSkillManagerInstance();
            sm?.setSkillConfig?.(args[0], args[1]);
            return writeJSON(res, 200, { success: true });
          }
          case 'skills:testEmailConnectivity':
            return writeJSON(res, 200, { success: false, error: 'Not available in Tauri mode' });

          // ── MCP ──
          case 'mcp:list': {
            const ms = await getMcpStoreInstance();
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:create': {
            const ms = await getMcpStoreInstance();
            ms?.createServer?.(args[0]);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:update': {
            const ms = await getMcpStoreInstance();
            ms?.updateServer?.(args[0], args[1]);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:delete': {
            const ms = await getMcpStoreInstance();
            ms?.deleteServer?.(args[0]);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:setEnabled': {
            const ms = await getMcpStoreInstance();
            ms?.setEnabled?.(args[0]?.id, args[0]?.enabled);
            return writeJSON(res, 200, { success: true, servers: ms?.listServers?.() ?? [] });
          }
          case 'mcp:fetchMarketplace': {
            try {
              const mpRes = await fetch('https://api-overmind.noobclaw.com/api/v1/kv/mcp-marketplace');
              const mpJson = await mpRes.json() as any;
              return writeJSON(res, 200, { success: true, data: mpJson?.data?.value ?? [] });
            } catch { return writeJSON(res, 200, { success: true, data: [] }); }
          }

          // ── API fetch proxy ──
          case 'api:fetch': {
            const opts = args[0];
            try {
              const fetchRes = await fetch(opts.url, {
                method: opts.method || 'GET',
                headers: opts.headers || {},
                body: opts.body || undefined,
              });
              const bodyText = await fetchRes.text();
              return writeJSON(res, 200, { ok: fetchRes.ok, status: fetchRes.status, body: bodyText });
            } catch (e: any) {
              return writeJSON(res, 200, { ok: false, status: 0, body: '', error: e.message });
            }
          }

          // ── Log ──
          case 'log:getPath': {
            const { getCoworkLogPath } = await import('./libs/coworkLogger');
            return writeJSON(res, 200, getCoworkLogPath());
          }
          case 'log:openFolder': {
            const { getCoworkLogPath } = await import('./libs/coworkLogger');
            const { openExternal } = await import('./libs/platformAdapter');
            await openExternal(require('path').dirname(getCoworkLogPath()));
            return writeJSON(res, 200, { status: 'ok' });
          }

          // ── Shell ──
          case 'shell:openPath':
          case 'shell:showItemInFolder': {
            const { openExternal: oe } = await import('./libs/platformAdapter');
            await oe(args[0]);
            return writeJSON(res, 200, { status: 'ok' });
          }

          // ── App info ──
          case 'app:getVersion': return writeJSON(res, 200, '1.0.0');
          case 'app:getSystemLocale': return writeJSON(res, 200, Intl.DateTimeFormat().resolvedOptions().locale || 'en-US');

          // ── Session title ──
          case 'generate-session-title': {
            try {
              const { generateSessionTitle } = await import('./libs/coworkUtil');
              const title = await generateSessionTitle?.(args[0]);
              return writeJSON(res, 200, title ?? null);
            } catch { return writeJSON(res, 200, null); }
          }
          case 'get-recent-cwds': {
            if (runner) {
              const limit = Math.min(Math.max(args[0] ?? 8, 1), 20);
              const cwds = runner.store.listRecentCwds?.(limit) ?? [];
              return writeJSON(res, 200, cwds);
            }
            return writeJSON(res, 200, []);
          }

          // ── Cowork session IPC (for channels not yet routed to dedicated endpoints) ──
          case 'cowork:session:list': {
            const sessions = runner?.store?.listSessions?.() ?? [];
            return writeJSON(res, 200, { success: true, sessions });
          }
          case 'cowork:session:get': {
            const session = runner?.store?.getSession?.(args[0]);
            return writeJSON(res, 200, { success: true, session: session ?? null });
          }
          case 'cowork:config:get': {
            const config = runner?.store?.getConfig?.() ?? {};
            return writeJSON(res, 200, { success: true, config });
          }
          case 'cowork:config:set': {
            runner?.store?.setConfig?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'cowork:memory:listEntries': {
            const entries = runner?.store?.listUserMemories?.(args[0] ?? {}) ?? [];
            return writeJSON(res, 200, { success: true, entries });
          }
          case 'cowork:memory:createEntry': {
            const entry = runner?.store?.createUserMemory?.(args[0]);
            return writeJSON(res, 200, { success: true, entry });
          }
          case 'cowork:memory:updateEntry': {
            runner?.store?.updateUserMemory?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'cowork:memory:deleteEntry': {
            runner?.store?.deleteUserMemory?.(args[0]?.id);
            return writeJSON(res, 200, { success: true });
          }
          case 'cowork:memory:getStats': {
            return writeJSON(res, 200, { success: true, stats: runner?.store?.getUserMemoryStats?.() ?? { total: 0 } });
          }

          // ── Scheduled Tasks ──
          case 'scheduledTask:list': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, tasks: sts?.listTasks?.() ?? [] });
          }
          case 'scheduledTask:get': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, task: sts?.getTask?.(args[0]) ?? null });
          }
          case 'scheduledTask:create': {
            const sts = await getScheduledTaskStoreInstance();
            try {
              const task = sts?.createTask?.(args[0]);
              const sched = await getSchedulerInstance();
              sched?.reschedule?.();
              return writeJSON(res, 200, { success: true, task });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'scheduledTask:update': {
            const sts = await getScheduledTaskStoreInstance();
            try {
              const task = sts?.updateTask?.(args[0], args[1]);
              const sched = await getSchedulerInstance();
              sched?.reschedule?.();
              return writeJSON(res, 200, { success: true, task });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'scheduledTask:delete': {
            const sched = await getSchedulerInstance();
            sched?.stopTask?.(args[0]);
            const sts = await getScheduledTaskStoreInstance();
            const result = sts?.deleteTask?.(args[0]);
            sched?.reschedule?.();
            return writeJSON(res, 200, { success: true, result });
          }
          case 'scheduledTask:toggle': {
            const sts = await getScheduledTaskStoreInstance();
            const task = sts?.toggleTask?.(args[0], args[1]);
            const sched = await getSchedulerInstance();
            sched?.reschedule?.();
            return writeJSON(res, 200, { success: true, task });
          }
          case 'scheduledTask:runManually': {
            const sched = await getSchedulerInstance();
            sched?.runManually?.(args[0])?.catch?.(() => {});
            return writeJSON(res, 200, { success: true });
          }
          case 'scheduledTask:stop': {
            const sched = await getSchedulerInstance();
            const result = sched?.stopTask?.(args[0]);
            return writeJSON(res, 200, { success: true, result });
          }
          case 'scheduledTask:listRuns': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, runs: sts?.listRuns?.(args[0], args[1], args[2]) ?? [] });
          }
          case 'scheduledTask:countRuns': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, count: sts?.countRuns?.(args[0]) ?? 0 });
          }
          case 'scheduledTask:listAllRuns': {
            const sts = await getScheduledTaskStoreInstance();
            return writeJSON(res, 200, { success: true, runs: sts?.listAllRuns?.(args[0], args[1]) ?? [] });
          }

          // ── IM Gateway ──
          case 'im:config:get': {
            const img = await getIMGatewayManagerInstance();
            return writeJSON(res, 200, { success: true, config: img?.getConfig?.() ?? {} });
          }
          case 'im:config:set': {
            const img = await getIMGatewayManagerInstance();
            img?.setConfig?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'im:gateway:start': {
            const img = await getIMGatewayManagerInstance();
            try {
              img?.setConfig?.({ [args[0]]: { enabled: true } });
              await img?.startGateway?.(args[0]);
              return writeJSON(res, 200, { success: true });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'im:gateway:stop': {
            const img = await getIMGatewayManagerInstance();
            img?.setConfig?.({ [args[0]]: { enabled: false } });
            await img?.stopGateway?.(args[0]);
            return writeJSON(res, 200, { success: true });
          }
          case 'im:gateway:test': {
            const img = await getIMGatewayManagerInstance();
            try {
              const result = await img?.testGateway?.(args[0], args[1]);
              return writeJSON(res, 200, { success: true, result });
            } catch (e: any) { return writeJSON(res, 200, { success: false, error: e.message }); }
          }
          case 'im:status:get': {
            const img = await getIMGatewayManagerInstance();
            return writeJSON(res, 200, { success: true, status: img?.getStatus?.() ?? {} });
          }

          // ── NoobClaw platform ──
          case 'noobclaw:set-auth-token': {
            const { setNoobClawAuthToken } = await import('./libs/claudeSettings');
            setNoobClawAuthToken?.(args[0]);
            // Connect/disconnect NoobClaw SSE based on auth token
            if (args[0]) {
              connectNoobClawSSE(args[0]).catch(() => {});
            } else if (noobclawSseConnection) {
              try { noobclawSseConnection.destroy(); } catch {}
              noobclawSseConnection = null;
            }
            return writeJSON(res, 200, { success: true });
          }
          case 'noobclaw:get-mac-address': {
            const os = require('os');
            const interfaces = os.networkInterfaces();
            for (const iface of Object.values(interfaces) as any[]) {
              for (const info of (iface || [])) {
                if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
                  return writeJSON(res, 200, info.mac);
                }
              }
            }
            return writeJSON(res, 200, null);
          }
          case 'noobclaw:cache-avatar': {
            try {
              const avatarUrl = args[0];
              const avatarDir = path.join(getUserDataPath(), 'avatars');
              const fs = require('fs');
              fs.mkdirSync(avatarDir, { recursive: true });
              const ext = avatarUrl.includes('.png') ? '.png' : '.jpg';
              const localPath = path.join(avatarDir, `avatar${ext}`);
              const response = await fetch(avatarUrl);
              const buffer = Buffer.from(await response.arrayBuffer());
              fs.writeFileSync(localPath, buffer);
              return writeJSON(res, 200, { success: true, localPath });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, localPath: null });
            }
          }
          case 'noobclaw:get-cached-avatar': {
            const fs = require('fs');
            const avatarDir = path.join(getUserDataPath(), 'avatars');
            for (const ext of ['.png', '.jpg']) {
              const p = path.join(avatarDir, `avatar${ext}`);
              if (fs.existsSync(p)) return writeJSON(res, 200, `file://${p}`);
            }
            return writeJSON(res, 200, null);
          }

          // ── Browser Extension ──
          case 'extension:prompt-response': {
            try {
              const { resolveExtensionPrompt } = await import('./libs/browserBridge');
              resolveExtensionPrompt(args[0], args[1]); // requestId, 'install' | 'cancel'
            } catch {}
            return writeJSON(res, 200, { success: true });
          }

          // ── Dialog ──
          case 'dialog:readFileAsDataUrl': {
            try {
              const fs = require('fs');
              const filePath = args[0];
              const data = fs.readFileSync(filePath);
              const ext = require('path').extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
              const mime = mimeMap[ext] || 'application/octet-stream';
              return writeJSON(res, 200, { success: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` });
            } catch (e: any) {
              return writeJSON(res, 200, { success: false, error: e.message });
            }
          }

          default:
            coworkLog('WARN', 'sidecar-server', `Unhandled IPC channel: ${channel}`);
            return writeJSON(res, 200, null);
        }
      } catch (e) {
        coworkLog('ERROR', 'sidecar-server', `IPC error [${channel}]: ${e}`);
        return writeJSON(res, 500, { error: String(e) });
      }
    }

    if (pathname === '/api/ipc/send' && req.method === 'POST') {
      // Fire-and-forget IPC sends (no return value expected)
      return writeJSON(res, 200, { status: 'ok' });
    }

    // ── HTTP Proxy (bypass CORS for external API calls from Tauri WebView) ──
    if (pathname === '/api/proxy' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
        const proxyRes = await fetch(body.url, {
          method: body.method || 'GET',
          headers: body.headers || {},
          body: body.body || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const responseBody = await proxyRes.text();
        return writeJSON(res, 200, { ok: proxyRes.ok, status: proxyRes.status, body: responseBody });
      } catch (e: any) {
        coworkLog('WARN', 'proxy', `Proxy failed for ${body.url}: ${e.message}`);
        return writeJSON(res, 200, { ok: false, status: 0, body: '', error: e.message });
      }
    }

    // ── Version ──
    if (pathname === '/api/version') {
      return writeJSON(res, 200, { version: '1.0.0', mode: 'tauri-sidecar' });
    }

    // ── 404 ──
    writeJSON(res, 404, { error: 'Not found', path: pathname });
  } catch (e) {
    coworkLog('ERROR', 'sidecar-server', `Request error: ${e}`);
    writeJSON(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NoobClaw sidecar server listening on http://127.0.0.1:${PORT}`);
  coworkLog('INFO', 'sidecar-server', `Started on port ${PORT}`);

  // Pre-initialize runner immediately so data is ready when frontend connects
  getRunner().then((runner) => {
    if (runner) {
      coworkLog('INFO', 'sidecar-server', 'Runner pre-initialized successfully');
    } else {
      coworkLog('WARN', 'sidecar-server', 'Runner pre-initialization failed — will retry on first request');
    }
  }).catch(e => coworkLog('ERROR', 'sidecar-server', `Runner pre-init error: ${e}`));
});

// ── Helpers ──

function writeJSON(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── NoobClaw SSE Connection (for auth, wallet, balance updates) ──

let noobclawSseConnection: any = null;

async function connectNoobClawSSE(authToken: string): Promise<void> {
  if (noobclawSseConnection) {
    try { noobclawSseConnection.destroy?.(); } catch {}
    noobclawSseConnection = null;
  }

  if (!authToken) return;

  try {
    const https = require('https');
    const url = 'https://api.noobclaw.com/api/sse';

    const req = https.get(url, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    }, (res: any) => {
      if (res.statusCode !== 200) {
        coworkLog('WARN', 'noobclaw-sse', `SSE connection failed: ${res.statusCode}`);
        return;
      }

      coworkLog('INFO', 'noobclaw-sse', 'Connected to NoobClaw SSE');
      noobclawSseConnection = res;

      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventData = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            eventData += line.slice(6);
          } else if (line === '' && eventData) {
            try {
              const payload = JSON.parse(eventData);
              broadcastSSE('noobclaw:sse-payload', payload);
            } catch {}
            eventData = '';
          }
        }
      });

      res.on('end', () => {
        coworkLog('INFO', 'noobclaw-sse', 'SSE connection closed, reconnecting in 5s...');
        noobclawSseConnection = null;
        setTimeout(() => {
          const { getNoobClawAuthToken } = require('./libs/claudeSettings');
          const token = getNoobClawAuthToken?.();
          if (token) connectNoobClawSSE(token);
        }, 5000);
      });
    });

    req.on('error', (e: any) => {
      coworkLog('WARN', 'noobclaw-sse', `SSE error: ${e.message}`);
      noobclawSseConnection = null;
    });
  } catch (e) {
    coworkLog('ERROR', 'noobclaw-sse', `Failed to connect: ${e}`);
  }
}

// ── Graceful shutdown ──

function shutdown() {
  coworkLog('INFO', 'sidecar-server', 'Shutting down...');
  if (noobclawSseConnection) { try { noobclawSseConnection.destroy(); } catch {} }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Monitor parent process exit via periodic check (more reliable than stdin)
// The Tauri Rust side kills the sidecar via SIGTERM on exit
const parentPid = process.ppid;
if (parentPid && parentPid > 1) {
  const checkParent = setInterval(() => {
    try {
      process.kill(parentPid, 0); // Check if parent is alive (signal 0 = no-op)
    } catch {
      coworkLog('INFO', 'sidecar-server', 'Parent process gone, exiting');
      clearInterval(checkParent);
      shutdown();
    }
  }, 3000);
}

export { broadcastSSE, PORT };
