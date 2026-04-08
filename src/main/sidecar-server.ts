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

    coworkLog('INFO', 'sidecar-server', 'CoworkRunner initialized');
    return runnerInstance;
  } catch (e) {
    coworkLog('ERROR', 'sidecar-server', `Failed to init CoworkRunner: ${e}`);
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
          systemPrompt: body.systemPrompt,
          imageAttachments: body.imageAttachments,
          skillIds: body.activeSkillIds,
        }).catch((e: any) => coworkLog('ERROR', 'sidecar', `Session error: ${e}`));

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
        runner.store.addMessage(body.sessionId, { type: 'user', content: body.prompt, metadata: body.imageAttachments?.length ? { imageAttachments: body.imageAttachments } : undefined });
        runner.store.updateSession(body.sessionId, { status: 'running' });

        runner.continueSession(body.sessionId, body.prompt, {
          systemPrompt: body.systemPrompt,
          imageAttachments: body.imageAttachments,
        }).catch((e: any) => coworkLog('ERROR', 'sidecar', `Continue error: ${e}`));

        const session = runner.store.getSession(body.sessionId);
        return writeJSON(res, 200, { success: true, session });
      } catch (e: any) {
        return writeJSON(res, 200, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/session/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.stopSession(body.sessionId);
      return writeJSON(res, 200, { status: 'stopped' });
    }

    if (pathname === '/api/session/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.deleteSession(body.sessionId);
      return writeJSON(res, 200, { status: 'deleted' });
    }

    // ── Permission ──
    if (pathname === '/api/permission/respond' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.respondToPermission(body.requestId, body.result);
      return writeJSON(res, 200, { status: 'ok' });
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
        await getRunner(); // ensure store is initialized
        const { getCurrentApiConfig } = await import('./libs/claudeSettings');
        const config = getCurrentApiConfig();
        if (config) return writeJSON(res, 200, { hasConfig: true, config });
        return writeJSON(res, 200, { hasConfig: false, config: null });
      } catch (e) {
        return writeJSON(res, 200, { hasConfig: false, config: null, error: String(e) });
      }
    }

    if (pathname === '/api/apiConfig/check' && req.method === 'POST') {
      try {
        await getRunner(); // ensure store is initialized
        const { resolveCurrentApiConfig } = await import('./libs/claudeSettings');
        const { config, error } = resolveCurrentApiConfig();
        return writeJSON(res, 200, { hasConfig: !!config, config, error });
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
        const session = runner.store.getSession(sessionId);
        const messages = session ? runner.store.getMessages(sessionId) : [];
        return writeJSON(res, 200, { success: true, session, messages });
      }
    }

    if (pathname === '/api/session/deleteBatch' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) for (const id of (body.sessionIds || [])) runner.store.deleteSession(id);
      return writeJSON(res, 200, { status: 'deleted' });
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
      return writeJSON(res, 200, entry || { status: 'created' });
    }

    if (pathname === '/api/memory/update' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.updateMemoryEntry?.(body);
      return writeJSON(res, 200, { status: 'updated' });
    }

    if (pathname === '/api/memory/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (runner) runner.store.deleteMemoryEntry?.(body.id);
      return writeJSON(res, 200, { status: 'deleted' });
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
            // TODO: integrate SkillManager in sidecar
            return writeJSON(res, 200, { success: true, skills: [] });
          }
          case 'skills:setEnabled':
          case 'skills:delete':
          case 'skills:download':
          case 'skills:setConfig':
          case 'skills:testEmailConnectivity':
            return writeJSON(res, 200, { success: true });
          case 'skills:getRoot': {
            try {
              const { getSkillsRoot } = await import('./libs/coworkUtil');
              return writeJSON(res, 200, getSkillsRoot());
            } catch { return writeJSON(res, 200, ''); }
          }
          case 'skills:autoRoutingPrompt': return writeJSON(res, 200, { success: true, prompt: '' });
          case 'skills:getConfig': return writeJSON(res, 200, {});

          // ── MCP ──
          case 'mcp:list': return writeJSON(res, 200, []);
          case 'mcp:create':
          case 'mcp:update':
          case 'mcp:delete':
          case 'mcp:setEnabled':
            return writeJSON(res, 200, { success: true });
          case 'mcp:fetchMarketplace': return writeJSON(res, 200, []);

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
          case 'generate-session-title': return writeJSON(res, 200, null); // TODO: implement LLM title generation
          case 'get-recent-cwds': {
            if (runner) {
              const cwds = runner.store.getRecentCwds?.(args[0] ?? 10) ?? [];
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
          case 'scheduledTask:list': return writeJSON(res, 200, []);
          case 'scheduledTask:get': return writeJSON(res, 200, null);
          case 'scheduledTask:create': return writeJSON(res, 200, { success: false, error: 'Not yet implemented in Tauri' });
          case 'scheduledTask:update': return writeJSON(res, 200, { success: false });
          case 'scheduledTask:delete': return writeJSON(res, 200, { success: true });
          case 'scheduledTask:toggle': return writeJSON(res, 200, { success: true });
          case 'scheduledTask:runManually': return writeJSON(res, 200, { success: false });
          case 'scheduledTask:stop': return writeJSON(res, 200, { success: true });
          case 'scheduledTask:listRuns': return writeJSON(res, 200, []);
          case 'scheduledTask:countRuns': return writeJSON(res, 200, 0);
          case 'scheduledTask:listAllRuns': return writeJSON(res, 200, []);

          // ── IM Gateway (stub) ──
          case 'im:config:get': return writeJSON(res, 200, {});
          case 'im:config:set': return writeJSON(res, 200, { success: true });
          case 'im:gateway:start': return writeJSON(res, 200, { success: false, error: 'Not available in Tauri mode' });
          case 'im:gateway:stop': return writeJSON(res, 200, { success: true });
          case 'im:gateway:test': return writeJSON(res, 200, { success: false, error: 'Not available in Tauri mode' });
          case 'im:status:get': return writeJSON(res, 200, {});

          // ── NoobClaw platform ──
          case 'noobclaw:set-auth-token': {
            const { setNoobClawAuthToken } = await import('./libs/claudeSettings');
            setNoobClawAuthToken?.(args[0]);
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
          case 'noobclaw:cache-avatar': return writeJSON(res, 200, { success: false, localPath: null });
          case 'noobclaw:get-cached-avatar': return writeJSON(res, 200, null);

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

// ── Graceful shutdown ──

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });

export { broadcastSSE, PORT };
