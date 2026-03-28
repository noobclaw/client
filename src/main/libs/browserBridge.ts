/**
 * Browser Bridge — WebSocket server that connects to a Chrome extension
 * for AI-controlled browser automation.
 *
 * Lifecycle follows the same pattern as coworkOpenAICompatProxy.ts:
 * module-level state, exported start/stop/status functions.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';

let server: http.Server | null = null;
let wss: any = null; // WebSocketServer
let extensionSocket: any = null; // current connected extension
let bridgePort: number | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export function getBrowserBridgeStatus(): {
  running: boolean;
  port: number | null;
  connected: boolean;
} {
  return {
    running: server !== null,
    port: bridgePort,
    connected: extensionSocket !== null && extensionSocket.readyState === 1, // WebSocket.OPEN
  };
}

export async function startBrowserBridge(): Promise<{ port: number }> {
  if (server) {
    return { port: bridgePort! };
  }

  // Dynamic import ws to avoid bundling issues
  const { WebSocketServer } = await import('ws');

  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'NoobClaw Browser Bridge' }));
    });

    const wsServer = new WebSocketServer({ server: httpServer });

    wsServer.on('connection', (ws: any) => {
      console.log('[BrowserBridge] Extension connected');

      // Replace any existing connection
      if (extensionSocket && extensionSocket.readyState === 1) {
        extensionSocket.close(1000, 'Replaced by new connection');
      }
      extensionSocket = ws;

      // Auto-accept connection (localhost-only, no token needed)
      ws.send(JSON.stringify({ type: 'connected' }));

      // Notify renderer and fire connection listeners (auto-retry)
      notifyBridgeStatus(true);
      fireConnectionListeners();

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());

          // Pong (keepalive)
          if (msg.type === 'pong') return;

          // Response to a command
          if (msg.id && pendingRequests.has(msg.id)) {
            const pending = pendingRequests.get(msg.id)!;
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.id);
            if (msg.success) {
              pending.resolve(msg.data);
            } else {
              pending.reject(new Error(msg.error || 'Command failed'));
            }
          }
        } catch (err) {
          console.error('[BrowserBridge] Failed to parse message:', err);
        }
      });

      ws.on('close', () => {
        console.log('[BrowserBridge] Extension disconnected');
        if (extensionSocket === ws) {
          extensionSocket = null;
          notifyBridgeStatus(false);
        }
        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Extension disconnected'));
          pendingRequests.delete(id);
        }
      });

      ws.on('error', (err: any) => {
        console.error('[BrowserBridge] WebSocket error:', err.message);
      });
    });

    // Keepalive ping every 25s (Chrome kills service workers after 30s idle)
    const keepaliveInterval = setInterval(() => {
      if (extensionSocket && extensionSocket.readyState === 1) {
        extensionSocket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    wsServer.on('close', () => {
      clearInterval(keepaliveInterval);
    });

    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Try random port
        httpServer.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    });

    httpServer.on('listening', () => {
      const addr = httpServer.address() as any;
      bridgePort = addr.port;
      server = httpServer;
      wss = wsServer;
      console.log(`[BrowserBridge] Started on ws://127.0.0.1:${bridgePort}`);
      resolve({ port: bridgePort! });
    });

    httpServer.listen(12580, '127.0.0.1');
  });
}

export async function stopBrowserBridge(): Promise<void> {
  if (!server) return;

  // Reject all pending requests
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Bridge shutting down'));
    pendingRequests.delete(id);
  }

  if (extensionSocket && extensionSocket.readyState === 1) {
    extensionSocket.close(1000, 'Bridge shutting down');
    extensionSocket = null;
  }

  return new Promise((resolve) => {
    if (wss) {
      wss.close(() => {
        if (server) {
          server.close(() => {
            server = null;
            wss = null;
            bridgePort = null;
            console.log('[BrowserBridge] Stopped');
            resolve();
          });
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

function notifyBridgeStatus(connected: boolean) {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('browser-bridge:status', { connected });
    }
  } catch {}
}

// Listeners waiting for extension to connect (for auto-retry)
const connectionListeners: Array<() => void> = [];

export function onExtensionConnected(callback: () => void): () => void {
  connectionListeners.push(callback);
  return () => {
    const idx = connectionListeners.indexOf(callback);
    if (idx >= 0) connectionListeners.splice(idx, 1);
  };
}

function fireConnectionListeners() {
  const cbs = connectionListeners.splice(0);
  for (const cb of cbs) {
    try { cb(); } catch {}
  }
}

export function sendBrowserCommand(
  command: string,
  params: Record<string, any> = {},
  timeoutMs = 30000
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject(new Error('BROWSER_NOT_CONNECTED'));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Browser command "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

    extensionSocket.send(JSON.stringify({ id, command, params }));
  });
}
