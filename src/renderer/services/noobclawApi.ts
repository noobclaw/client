// NoobClaw Backend API Service
// Replaces direct AI provider calls with our proxied backend

import { noobClawAuth } from './noobclawAuth';
import { getBackendApiUrl } from './endpoints';

export interface TokenInfo {
  balance: number;
  totalUsed: number;
  walletAddress: string;
}

// v5.x+: notification row shape, shared between unread / list endpoints
// + rebate_received-specific metadata. severity drives UI: critical →
// full-screen modal, important → bottom-right banner + OS push, normal →
// top thin strip + red-dot badge in InviteView.
export interface NotificationRow {
  id: string;
  type: string;                  // 'rebate_received' | 'announcement' | ...
  severity: 'critical' | 'important' | 'normal';
  title_zh: string;
  title_en: string;
  body_zh: string;
  body_en: string;
  metadata?: {
    amount_usdt?: string;
    tx_hash?: string;
    batch_id?: string;
    recipient_wallet?: string;
    bscscan_url?: string;
    [k: string]: any;
  };
  read_at?: string | null;
  dismissed_at?: string | null;
  cta_clicked_at?: string | null;
  created_at: string;
  expires_at?: string | null;
}

// Per-chain block under PaymentInfo.chains. Backend emits these starting in
// v5.5 (TRON/USDT support). Older clients keep using the top-level fields
// (treasuryWallet/packages) so the response is forward+backward compatible.
export interface ChainBlock {
  treasuryWallet: string;
  bnbPriceUsd?: number;        // BSC only
  usdtContract?: string;       // TRON only
  enabled?: boolean;
  packages: Array<{
    bnb?: number;              // BSC packages
    usdt?: number;             // TRON packages
    label: string;
    usdValue: string;
    tokens: number;
    tokensDisplay: string;
  }>;
}

export interface PaymentInfo {
  treasuryWallet: string;
  bnbPriceUsd: number;
  chain: string;
  packages: Array<{
    bnb: number;
    label: string;
    usdValue: string;
    tokens: number;
    tokensDisplay: string;
  }>;
  noobPerDollar?: number;
  purchaseNoobPerDollarMin?: number;
  purchaseNoobPerDollarMax?: number;
  // Optional — present when backend has the multi-chain TRON channel enabled.
  // TRON is keyed only when tron_treasury_address is set in system_config; if
  // missing, the client falls back to BSC-only behavior.
  chains?: {
    BSC?: ChainBlock;
    TRON?: ChainBlock;
  };
}

class NoobClawApiService {
  // Dynamically read, supports local/production environment switching
  private get backendUrl() {
    return getBackendApiUrl();
  }

  getBaseUrl(): string {
    return `${this.backendUrl}/api/ai`;
  }

  getAuthHeaders(): Record<string, string> {
    return noobClawAuth.getAuthHeaders();
  }

  // All authenticated requests funnel through here. On 401 we route the
  // response into noobClawAuth.handleAuthExpired() which clears local state +
  // dispatches `noobclaw:need-login` for App.tsx → LoginWall. The handler
  // self-gates on `isAuthenticated` so a 401 from a never-logged-in user
  // (which is the normal case for these endpoints) does NOT pop the modal.
  private async authedFetch(input: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(input, init);
    if (res.status === 401) noobClawAuth.handleAuthExpired();
    return res;
  }

  async getTokenBalance(): Promise<TokenInfo | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/ai/balance`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getPaymentInfo(): Promise<PaymentInfo | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/info`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /**
   * Create a pending top-up order.
   *
   * - createOrder(0.3)                       → BSC (legacy single-arg form)
   * - createOrder(10,  'TRON')               → TRON / USDT
   * - createOrder(0.3, 'BSC')                → BSC (explicit chain)
   *
   * Returns the inserted order row plus, for TRON, a `treasuryWallet` field
   * so the caller can render the receive address without a second /info hit.
   */
  async createOrder(
    amount: number,
    chain: 'BSC' | 'TRON' = 'BSC',
  ): Promise<{ order?: any; treasuryWallet?: string; error?: string; code?: string } | null> {
    try {
      const body = chain === 'TRON'
        ? { chain: 'TRON', usdtAmount: amount }
        : { chain: 'BSC',  bnbAmount: amount };
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/create`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.message || data.error, code: data.code };
      return data;
    } catch {
      return null;
    }
  }

  async confirmOrder(orderNo: string, txHash: string): Promise<any> {
    const res = await this.authedFetch(`${this.backendUrl}/api/payment/confirm`, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNo, txHash }),
    });
    return res.json();
  }

  async pollOrderStatus(orderNo: string): Promise<{ order: any; tokenBalance?: number } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/status/${orderNo}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getOrderHistory(status?: string, orderNo?: string, from?: string, to?: string): Promise<{ orders: any[]; total: number }> {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (orderNo) params.set('orderNo', orderNo);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const qs = params.toString();
      const url = `${this.backendUrl}/api/payment/history${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { orders: [], total: 0 };
      const data = await res.json();
      return { orders: data.orders || [], total: data.total || 0 };
    } catch {
      return { orders: [], total: 0 };
    }
  }

  async cancelOrder(orderNo: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/payment/cancel`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNo }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error };
      return { success: true };
    } catch {
      return { success: false, error: 'Network error' };
    }
  }

  async getUserProfile(): Promise<any | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/profile`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getInviteList(page = 1, pageSize = 20): Promise<{ list: Array<{ wallet: string; createdAt: string; level?: number }>; total: number }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/referral/list?page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0 };
      return res.json();
    } catch {
      return { list: [], total: 0 };
    }
  }

  async getReferralRewards(page = 1, pageSize = 20): Promise<{ list: Array<{ noobAmount: number; reason: string; status: string; createdAt: string; contributorWallet?: string; level?: number }>; total: number; totalEarned: number }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/referral/rewards?page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0, totalEarned: 0 };
      return res.json();
    } catch {
      return { list: [], total: 0, totalEarned: 0 };
    }
  }

  async getAirdropRecords(): Promise<{ airdrops: any[] }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/airdrops`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { airdrops: [] };
      return res.json();
    } catch {
      return { airdrops: [] };
    }
  }

  async getReferralTicker(): Promise<{ items: Array<{ wallet: string; amount: number }>; day: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/referral/ticker`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [], day: '' };
      return res.json();
    } catch { return { items: [], day: '' }; }
  }

  // ─── v5.x+: USDT real-cash rebate endpoints ───
  // Backend route prefix: /api/me/* (see backend/src/routes/rebate.ts).
  // All four require auth headers — they're scoped to req.walletAddress.

  async getUsdtRebateSummary(): Promise<{ total_earned: string; total_sent: string; total_inflight: string; total_pending: string } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/summary`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  async getUsdtRebateBreakdown(): Promise<{ levels: Array<{ level: number; amount: string; contributor_count: number }> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/breakdown`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { levels: [] };
      return res.json();
    } catch { return { levels: [] }; }
  }

  async getUsdtRebateHistory(limit = 50): Promise<{ items: Array<{ id: string; amount_usdt: string; tx_hash: string; bscscan_url: string; created_at: string }> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/history?limit=${limit}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  // v5.x+: unified per-row commission ledger with FIFO-derived payout status.
  // Each rebate_earnings row is annotated 'sent' or 'pending'. 'sent' rows
  // carry the tx_hash + paid_at of the rebate_sends row that covers them
  // (approximate FIFO match — batched payouts mean N earnings → 1 send).
  //
  // Pagination: page 1-indexed, pageSize capped at 100 server-side. Rows
  // are sorted by earned_at DESC (newest first). FIFO matching runs over
  // the full ordered set before pagination, so a row's status is stable
  // across pages — page 2 won't suddenly flip pending → sent.
  async getUsdtRebateEarnings(page = 1, pageSize = 20): Promise<{
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    total_earned: string;
    total_sent: string;
    total_pending: string;
    items: Array<{
      id: string;
      level: number | null;
      contributor_wallet: string | null;
      amount_usdt: string;
      reason: string;
      source_asset: string;
      order_id: string | null;
      earned_at: string;
      status: 'sent' | 'pending';
      tx_hash: string | null;
      bscscan_url: string | null;
      paid_at: string | null;
    }>;
  }> {
    const empty = { page, pageSize, total: 0, totalPages: 1, total_earned: '0', total_sent: '0', total_pending: '0', items: [] };
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/rebate/earnings?page=${page}&pageSize=${pageSize}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return empty;
      return res.json();
    } catch { return empty; }
  }

  // ─── Generic notification endpoints (initially seeded with rebate_received) ───
  // The Modal/Banner/RedDot UI components poll these on launch + reactively.

  async getUnreadNotifications(): Promise<{ items: Array<NotificationRow> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/unread`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  async getNotificationHistory(limit = 50): Promise<{ items: Array<NotificationRow> }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/list?limit=${limit}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { items: [] };
      return res.json();
    } catch { return { items: [] }; }
  }

  async markNotificationRead(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/${id}/read`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      return res.ok;
    } catch { return false; }
  }

  async markNotificationDismissed(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/${id}/dismiss`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      return res.ok;
    } catch { return false; }
  }

  async markNotificationCtaClicked(id: string): Promise<boolean> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/${id}/cta-clicked`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      return res.ok;
    } catch { return false; }
  }

  async markAllNotificationsRead(): Promise<number> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/me/notifications/mark-all-read`, {
        method: 'POST', headers: this.getAuthHeaders(),
      });
      if (!res.ok) return 0;
      const j = await res.json();
      return j.count || 0;
    } catch { return 0; }
  }

  async getNoobEarnings(page = 1, limit = 20, reason = '', from = '', to = ''): Promise<{ list: any[]; total: number; stats: any }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (reason) params.set('reason', reason);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await this.authedFetch(`${this.backendUrl}/api/user/noob/earnings?${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0, stats: {} };
      return res.json();
    } catch {
      return { list: [], total: 0, stats: {} };
    }
  }

  async getCreditHistory(page = 1, limit = 20, from = '', to = ''): Promise<{ list: any[]; total: number; stats: any }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await this.authedFetch(`${this.backendUrl}/api/user/credits/history?${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0, stats: {} };
      return res.json();
    } catch {
      return { list: [], total: 0, stats: {} };
    }
  }

  async getNoobSends(page = 1, limit = 20, from = '', to = ''): Promise<{ list: any[]; total: number }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await this.authedFetch(`${this.backendUrl}/api/user/noob/sends?${params}`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { list: [], total: 0 };
      return res.json();
    } catch {
      return { list: [], total: 0 };
    }
  }
  async uploadAvatar(file: File): Promise<{ avatarUrl?: string; error?: string }> {
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const authHeaders = this.getAuthHeaders();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/avatar`, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || 'Upload failed' };
      return { avatarUrl: data.avatarUrl };
    } catch {
      return { error: 'Network error' };
    }
  }

  async claimLuckyBag(): Promise<{ hit: boolean; reward: number } | null> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/ai/lucky-bag/claim`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getNoobConfig(): Promise<{ tokenSymbol: string; totalSupply: string; contractAddress: string; taxRate: string }> {
    try {
      const res = await this.authedFetch(`${this.backendUrl}/api/user/noob/config`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' };
      return res.json();
    } catch {
      return { tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' };
    }
  }
  // ── Daily check-in ─────────────────────────────────────────────────

  /** Get today's check-in status: already checked in? pools remaining? */
  async getCheckinStatus(): Promise<{
    checked_in: boolean;
    noob_remaining: number;
    noob_cap: number;
    points_remaining: number;
    points_cap: number;
    pool_exhausted: boolean;
    last_reward: { noob: number; points: number } | null;
  }> {
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/checkin/status`, {
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId },
      });
      if (!res.ok) return { checked_in: false, noob_remaining: 0, noob_cap: 0, points_remaining: 0, points_cap: 0, pool_exhausted: false, last_reward: null };
      return res.json();
    } catch {
      return { checked_in: false, noob_remaining: 0, noob_cap: 0, points_remaining: 0, points_cap: 0, pool_exhausted: false, last_reward: null };
    }
  }

  /** Perform today's daily check-in. Returns reward or rejection reason. */
  async checkin(): Promise<{
    success: boolean;
    noob_reward?: number;
    points_reward?: number;
    already_checked_in?: boolean;
    pool_exhausted?: boolean;
    error?: string;
  }> {
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/checkin`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return res.json();
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Get status of all 4 daily activities + shared pool remaining. */
  async getActivityStatus(): Promise<{
    activities: Array<{ type: string; claimed: boolean; enabled?: boolean; last_reward: { noob: number; points: number } | null }>;
    pool: { noob_remaining: number; noob_cap: number; points_remaining: number; points_cap: number; exhausted: boolean };
  }> {
    const empty = {
      activities: [] as any[],
      pool: { noob_remaining: 0, noob_cap: 0, points_remaining: 0, points_cap: 0, exhausted: false },
    };
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/activity/status`, {
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId },
      });
      if (!res.ok) return empty;
      return res.json();
    } catch {
      return empty;
    }
  }

  /** Claim reward for one of: checkin / xhs_rewrite / og_brawl / personality_test */
  async claimActivity(activityType: string): Promise<{
    success: boolean;
    activity_type?: string;
    noob_reward?: number;
    points_reward?: number;
    already_claimed?: boolean;
    pool_exhausted?: boolean;
    error?: string;
  }> {
    try {
      const deviceId = this.getDeviceId();
      const res = await this.authedFetch(`${this.backendUrl}/api/user/activity/claim`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'x-device-id': deviceId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_type: activityType }),
      });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return res.json();
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Stable per-browser device ID for anti-abuse. Not cryptographically
   *  strong — just raises the cost of scripted farming. */
  private getDeviceId(): string {
    const KEY = 'noobclaw_device_id';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  }
}

export const noobClawApi = new NoobClawApiService();
