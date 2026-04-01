// NoobClaw Backend API Service
// Replaces direct AI provider calls with our proxied backend

import { noobClawAuth } from './noobclawAuth';
import { getBackendApiUrl } from './endpoints';

export interface TokenInfo {
  balance: number;
  totalUsed: number;
  walletAddress: string;
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

  async getTokenBalance(): Promise<TokenInfo | null> {
    try {
      const res = await fetch(`${this.backendUrl}/api/ai/balance`, {
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
      const res = await fetch(`${this.backendUrl}/api/payment/info`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async createOrder(bnbAmount: number): Promise<{ order?: any; error?: string; code?: string } | null> {
    try {
      const res = await fetch(`${this.backendUrl}/api/payment/create`, {
        method: 'POST',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ bnbAmount }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.message || data.error, code: data.code };
      return data;
    } catch {
      return null;
    }
  }

  async confirmOrder(orderNo: string, txHash: string): Promise<any> {
    const res = await fetch(`${this.backendUrl}/api/payment/confirm`, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNo, txHash }),
    });
    return res.json();
  }

  async pollOrderStatus(orderNo: string): Promise<{ order: any; tokenBalance?: number } | null> {
    try {
      const res = await fetch(`${this.backendUrl}/api/payment/status/${orderNo}`, {
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
      const res = await fetch(`${this.backendUrl}/api/payment/cancel`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/profile`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async getInviteList(page = 1, pageSize = 20): Promise<{ list: Array<{ wallet: string; createdAt: string }>; total: number }> {
    try {
      const res = await fetch(`${this.backendUrl}/api/user/referral/list?page=${page}&pageSize=${pageSize}`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/referral/rewards?page=${page}&pageSize=${pageSize}`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/airdrops`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { airdrops: [] };
      return res.json();
    } catch {
      return { airdrops: [] };
    }
  }

  async getNoobEarnings(page = 1, limit = 20, reason = '', from = '', to = ''): Promise<{ list: any[]; total: number; stats: any }> {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (reason) params.set('reason', reason);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`${this.backendUrl}/api/user/noob/earnings?${params}`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/credits/history?${params}`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/noob/sends?${params}`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/avatar`, {
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
      const res = await fetch(`${this.backendUrl}/api/ai/lucky-bag/claim`, {
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
      const res = await fetch(`${this.backendUrl}/api/user/noob/config`, {
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return { tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' };
      return res.json();
    } catch {
      return { tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' };
    }
  }
}

export const noobClawApi = new NoobClawApiService();
