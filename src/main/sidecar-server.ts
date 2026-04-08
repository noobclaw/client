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
      if (!runner) return writeJSON(res, 503, { error: 'Runner not ready' });

      const sessionId = body.sessionId || require('uuid').v4();
      runner.startSession(sessionId, body.prompt, {
        systemPrompt: body.systemPrompt,
        imageAttachments: body.imageAttachments,
        skillIds: body.skillIds,
      }).catch((e: any) => coworkLog('ERROR', 'sidecar', `Session error: ${e}`));

      return writeJSON(res, 200, { sessionId, status: 'started' });
    }

    if (pathname === '/api/session/continue' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const runner = await getRunner();
      if (!runner) return writeJSON(res, 503, { error: 'Runner not ready' });

      runner.continueSession(body.sessionId, body.prompt, {
        systemPrompt: body.systemPrompt,
        imageAttachments: body.imageAttachments,
      }).catch((e: any) => coworkLog('ERROR', 'sidecar', `Continue error: ${e}`));

      return writeJSON(res, 200, { sessionId: body.sessionId, status: 'continued' });
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
      try {
        switch (channel) {
          case 'store:get': {
            const ss = runner?._sqliteStore;
            return writeJSON(res, 200, ss?.get?.(args[0]) ?? null);
          }
          case 'store:set': {
            const ss = runner?._sqliteStore;
            ss?.set?.(args[0], args[1]);
            return writeJSON(res, 200, { status: 'ok' });
          }
          case 'store:remove': {
            const ss = runner?._sqliteStore;
            ss?.delete?.(args[0]);
            return writeJSON(res, 200, { status: 'ok' });
          }
          case 'log:getPath': {
            const { getCoworkLogPath } = await import('./libs/coworkLogger');
            return writeJSON(res, 200, getCoworkLogPath());
          }
          case 'log:openFolder': {
            const { getCoworkLogPath } = await import('./libs/coworkLogger');
            const { openExternal } = await import('./libs/platformAdapter');
            const logPath = getCoworkLogPath();
            const dir = require('path').dirname(logPath);
            await openExternal(dir);
            return writeJSON(res, 200, { status: 'ok' });
          }
          case 'shell:openPath':
          case 'shell:showItemInFolder': {
            const { openExternal: openExt } = await import('./libs/platformAdapter');
            await openExt(args[0]);
            return writeJSON(res, 200, { status: 'ok' });
          }
          case 'app:getVersion': return writeJSON(res, 200, '1.0.0');
          case 'app:getSystemLocale': return writeJSON(res, 200, Intl.DateTimeFormat().resolvedOptions().locale || 'en-US');
          default:
            coworkLog('WARN', 'sidecar-server', `Unhandled IPC channel: ${channel}`);
            return writeJSON(res, 200, null);
        }
      } catch (e) {
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
