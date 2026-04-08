/**
 * NoobClaw Sidecar Server — HTTP + SSE server for Tauri mode.
 * Replaces Electron IPC with HTTP API.
 *
 * When running as Tauri sidecar:
 * - Frontend communicates via fetch() to http://127.0.0.1:{port}
 * - Events stream via SSE (Server-Sent Events)
 * - No Electron dependency
 *
 * When running as Electron:
 * - This file is NOT used (Electron IPC is used instead)
 */

import http from 'http';
import { coworkLog } from './libs/coworkLogger';

const PORT = parseInt(process.argv[2] || '18800', 10);

// ── SSE connections ──

const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  // ── SSE stream ──
  if (url.pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    // Send heartbeat every 30s
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);
    req.on('close', () => clearInterval(heartbeat));
    return;
  }

  // ── Health check ──
  if (url.pathname === '/api/status' && req.method === 'GET') {
    writeJSON(res, 200, { status: 'ok', port: PORT, mode: 'tauri-sidecar' });
    return;
  }

  // ── Session start ──
  if (url.pathname === '/api/session/start' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { sessionId, prompt, cwd, systemPrompt, imageAttachments } = JSON.parse(body);
      // TODO: integrate with CoworkRunner
      broadcastSSE('session:started', { sessionId });
      writeJSON(res, 200, { sessionId, status: 'started' });
    } catch (e) {
      writeJSON(res, 400, { error: String(e) });
    }
    return;
  }

  // ── Session continue ──
  if (url.pathname === '/api/session/continue' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { sessionId, prompt } = JSON.parse(body);
      broadcastSSE('session:continued', { sessionId });
      writeJSON(res, 200, { sessionId, status: 'continued' });
    } catch (e) {
      writeJSON(res, 400, { error: String(e) });
    }
    return;
  }

  // ── Permission respond ──
  if (url.pathname === '/api/permission/respond' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { requestId, result } = JSON.parse(body);
      writeJSON(res, 200, { requestId, status: 'ok' });
    } catch (e) {
      writeJSON(res, 400, { error: String(e) });
    }
    return;
  }

  // ── Session stop ──
  if (url.pathname === '/api/session/stop' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { sessionId } = JSON.parse(body);
      writeJSON(res, 200, { sessionId, status: 'stopped' });
    } catch (e) {
      writeJSON(res, 400, { error: String(e) });
    }
    return;
  }

  // ── Config ──
  if (url.pathname === '/api/config' && req.method === 'GET') {
    writeJSON(res, 200, { mode: 'tauri-sidecar' });
    return;
  }

  // ── 404 ──
  writeJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NoobClaw sidecar server listening on http://127.0.0.1:${PORT}`);
  coworkLog('INFO', 'sidecar-server', `Started on port ${PORT}`);
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

// ── Export broadcastSSE for CoworkRunner integration ──
export { broadcastSSE, PORT };
