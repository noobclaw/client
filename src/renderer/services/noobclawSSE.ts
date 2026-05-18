// noobclawSSE — 跟 /api/me/events/stream 保持的 EventSource 连接。
//
// 用途:服务器主动 push 业务事件 → 派发成 DOM CustomEvent,跟 polling 路径
// 共用同一个事件名(例如 'noobclaw:rebate-received' → <RebateDrawer> 监听)。
// SSE 命中即时,polling /api/ai/balance 是兜底。dedup 由后端 notified_at 原子
// 标记保证,两路径只有一条命中。
//
// 设计:
//   - 单例 service,由 App.tsx 在 authState.isAuthenticated 翻 true 时
//     start(),false 时 stop()。
//   - 浏览器原生 EventSource 自带重连(~3s 默认),所以基本不用我们自己
//     写重连;但有两个例外要手动处理:
//       (1) 401 — 后端拒绝 → 客户端 token 失效,EventSource 会持续重试
//           失败,要主动停掉,等下次 auth 再 start。
//       (2) 服务端主动 server-shutdown event → 立刻断开 + 退避后重连,
//           避免所有客户端在 PM2 reload 完成的瞬间同时连回来打爆后端。
//   - EventSource 不支持 Authorization header,所以我们走 query param
//     ?token=... 把 JWT 当查询串传(后端 authMiddleware 已经接受这种)。
//     生产是 HTTPS,token 暴露在 URL 但不会出现在浏览器 history(SPA 内部
//     不导航),log 中可能出现 — 跟现有 /api/me/* 同源,可接受。
//
// 不在这里做:
//   - 业务事件解析逻辑放到调用方(谁监听 DOM 事件谁处理 payload)。
//   - 鉴权失败的 UI 反馈,由 App.tsx 监听 'noobclaw:need-login' 处理。

import { getBackendApiUrl } from './endpoints';

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const SHUTDOWN_BACKOFF_MS = 5000;  // PM2 reload 时全员退避,避免雪崩

class NoobClawSSEService {
  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private currentToken: string | null = null;
  private stopped = true;

  /**
   * 启动 SSE。token 变化时(用户切账号 / refresh token)调用,会自动 close
   * 旧连接再建新的。stopped=false 期间断线 → 自动重连。
   */
  start(token: string): void {
    if (this.es && this.currentToken === token) return;  // 同 token 重复 start 幂等
    this.stop();  // 关旧的(如果有)
    this.currentToken = token;
    this.stopped = false;
    this.open();
  }

  /**
   * 停止 SSE。logout / handleAuthExpired 时调用。
   * 清理重连 timer,关 EventSource,清状态。
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.es) {
      try { this.es.close(); } catch { /* already closed */ }
      this.es = null;
    }
    this.currentToken = null;
    this.attempts = 0;
  }

  private open(): void {
    if (this.stopped || !this.currentToken) return;
    const url = `${getBackendApiUrl()}/api/me/events/stream?token=${encodeURIComponent(this.currentToken)}`;

    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch (err) {
      console.warn('[SSE] failed to construct EventSource:', err);
      this.scheduleReconnect();
      return;
    }
    this.es = es;

    es.onopen = () => {
      this.attempts = 0;  // reset 退避计数,下次断重新从 base 开始
    };

    // 后端发的注释行(`: ping` / `: connected`)不会触发任何 listener —
    // 它们只为保活 socket。所以 onmessage 只匹配真正的 named event。

    // Named event 'rebate-received' — 跟 polling 路径同样 dispatch
    // 'noobclaw:rebate-received' DOM 事件,RebateDrawer 单监听点接住。
    es.addEventListener('rebate-received', (e: MessageEvent) => {
      let detail: unknown = null;
      try { detail = JSON.parse(e.data); } catch { /* malformed, drop */ return; }
      window.dispatchEvent(new CustomEvent('noobclaw:rebate-received', { detail }));
    });

    // 服务端 PM2 reload 时主动告别。退避更长 → 避免所有客户端同时回连。
    es.addEventListener('server-shutdown', () => {
      console.info('[SSE] server-shutdown received, backing off before reconnect');
      try { es.close(); } catch { /* */ }
      this.es = null;
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.open(), SHUTDOWN_BACKOFF_MS);
    });

    es.onerror = () => {
      // EventSource 内部会自动重连(readyState 切回 CONNECTING),但 401/CORS
      // 这类硬错也会反复触发 onerror。我们做指数退避主动重连,把控制权
      // 拿回来 — 既能比浏览器默认 3s 更平滑,也能在 stopped 时直接放弃。
      try { es.close(); } catch { /* */ }
      this.es = null;
      if (this.stopped) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    // 指数退避:1.5s, 3s, 6s, 12s, 24s, 30s (capped)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}

export const noobClawSSE = new NoobClawSSEService();
