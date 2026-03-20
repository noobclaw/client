// NoobClaw Auth Service - Wallet-based authentication
import { getBackendApiUrl, getWebsiteUrl } from './endpoints';

export interface AuthState {
  isAuthenticated: boolean;
  walletAddress: string | null;
  tokenBalance: number;
  authToken: string | null;
  avatarUrl: string | null;
}

class NoobClawAuthService {
  private state: AuthState = {
    isAuthenticated: false,
    walletAddress: null,
    tokenBalance: 0,
    authToken: null,
    avatarUrl: null,
  };

  private listeners: Array<(state: AuthState) => void> = [];
  // Dynamically read, supports local/production environment switching
  private get backendUrl() { return getBackendApiUrl(); }

  constructor() {
    // Restore from localStorage if available
    const savedToken = localStorage.getItem('noobclaw_auth_token');
    const savedWallet = localStorage.getItem('noobclaw_wallet_address');
    const savedAvatar = localStorage.getItem('noobclaw_avatar_url');
    if (savedToken && savedWallet) {
      this.state.authToken = savedToken;
      this.state.walletAddress = savedWallet;
      this.state.isAuthenticated = true;
      this.state.avatarUrl = savedAvatar || null;
      // Sync token to main process and refresh balance in background
      // Use setTimeout to ensure window.electron is available
      setTimeout(() => {
        this.syncTokenToMain(savedToken);
        this.reportDeviceInfo(savedToken);
      }, 0);
      this.refreshBalance().catch(console.error);
      this.refreshAvatar().catch(console.error);
    }
  }

  getState(): AuthState {
    return { ...this.state };
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify() {
    this.listeners.forEach(l => l(this.getState()));
  }

  private syncTokenToMain(token: string | null) {
    window.electron?.noobclaw?.setAuthToken(token).catch(() => {});
  }

  // Called from website after wallet connect
  setAuthFromWebsite(token: string, walletAddress: string) {
    this.state.authToken = token;
    this.state.walletAddress = walletAddress;
    this.state.isAuthenticated = true;
    localStorage.setItem('noobclaw_auth_token', token);
    localStorage.setItem('noobclaw_wallet_address', walletAddress);
    this.syncTokenToMain(token);
    this.refreshBalance();
    this.refreshAvatar();
    this.reportDeviceInfo(token);
    this.notify();
  }

  // Report device MAC address to backend
  private async reportDeviceInfo(token: string) {
    try {
      const mac = await window.electron?.noobclaw?.getMacAddress();
      if (!mac) return;
      await fetch(`${this.backendUrl}/api/auth/device-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ macAddress: mac }),
      });
    } catch { /* ignore */ }
  }

  async refreshBalance(): Promise<number> {
    if (!this.state.authToken) return 0;
    try {
      const res = await fetch(`${this.backendUrl}/api/ai/balance`, {
        headers: { Authorization: `Bearer ${this.state.authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        this.state.tokenBalance = data.tokenBalance;
        this.notify();
        return data.tokenBalance;
      }
      if (res.status === 401) {
        this.logout();
      }
    } catch (err) {
      console.error('Failed to refresh balance:', err);
    }
    return this.state.tokenBalance;
  }

  async refreshAvatar(): Promise<void> {
    if (!this.state.authToken) return;
    try {
      const res = await fetch(`${this.backendUrl}/api/user/profile`, {
        headers: { Authorization: `Bearer ${this.state.authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.avatar_url) {
          this.state.avatarUrl = data.avatar_url;
          localStorage.setItem('noobclaw_avatar_url', data.avatar_url);
          this.notify();
        }
      }
    } catch { /* ignore */ }
  }

  setAvatarUrl(url: string) {
    this.state.avatarUrl = url;
    localStorage.setItem('noobclaw_avatar_url', url);
    this.notify();
  }

  getAuthHeaders(): Record<string, string> {
    if (!this.state.authToken) return {};
    return {
      Authorization: `Bearer ${this.state.authToken}`,
      'x-wallet-address': this.state.walletAddress || '',
    };
  }

  logout() {
    this.state = {
      isAuthenticated: false,
      walletAddress: null,
      tokenBalance: 0,
      authToken: null,
      avatarUrl: null,
    };
    localStorage.removeItem('noobclaw_auth_token');
    localStorage.removeItem('noobclaw_wallet_address');
    localStorage.removeItem('noobclaw_avatar_url');
    this.syncTokenToMain(null);
    this.notify();
  }

  openWebsiteLogin() {
    // Dynamically read: points to localhost:3001 for local testing, noobclaw.com for production
    const websiteUrl = getWebsiteUrl();
    // Open in default browser via electron
    if (typeof window !== 'undefined' && (window as any).electron) {
      (window as any).electron.shell.openExternal(websiteUrl);
    } else {
      window.open(websiteUrl, '_blank');
    }
  }
}

export const noobClawAuth = new NoobClawAuthService();
