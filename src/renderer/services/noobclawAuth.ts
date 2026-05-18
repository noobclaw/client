// NoobClaw Auth Service - Wallet-based authentication
import { getBackendApiUrl, getWebsiteUrl } from './endpoints';

export interface AuthState {
  isAuthenticated: boolean;
  walletAddress: string | null;
  tokenBalance: number;
  authToken: string | null;
  avatarUrl: string | null;
  // Web3Auth social login provenance (null when user signed in with their own wallet)
  socialEmail: string | null;
  socialProvider: string | null; // 'google' | 'twitter' | 'discord'
}

class NoobClawAuthService {
  private state: AuthState = {
    isAuthenticated: false,
    walletAddress: null,
    tokenBalance: 0,
    authToken: null,
    avatarUrl: null,
    socialEmail: null,
    socialProvider: null,
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
      this.state.socialEmail = localStorage.getItem('noobclaw_social_email') || null;
      this.state.socialProvider = localStorage.getItem('noobclaw_social_provider') || null;
      // Sync token to main process and refresh balance in background
      // Use setTimeout to ensure window.electron is available
      setTimeout(() => {
        this.syncTokenToMain(savedToken);
        this.reportDeviceInfo(savedToken);
        // Load cached avatar from local disk first (instant, no network)
        this.loadCachedAvatar();
      }, 0);
      this.refreshBalance().catch(console.error);
      this.refreshAvatar().catch(console.error);
    }
  }

  // Load avatar from local disk cache (instant, no flicker)
  private async loadCachedAvatar() {
    try {
      const localPath = await window.electron?.noobclaw?.getCachedAvatar();
      if (localPath) {
        this.state.avatarUrl = localPath;
        this.notify();
      }
    } catch { /* ignore */ }
  }

  // Cache avatar image to local disk via main process
  private async cacheAvatarToDisk(url: string) {
    try {
      const result = await window.electron?.noobclaw?.cacheAvatar(url);
      if (result?.success && result.localPath) {
        // Update to local path for instant loading next time
        localStorage.setItem('noobclaw_cached_avatar_local', result.localPath);
      }
    } catch { /* ignore */ }
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

  // Called from website after wallet connect (or social login via web3auth).
  // socialEmail/socialProvider are passed through the noobclaw:// deep link
  // when the user signed in via Google/X/Discord; pass empty string for plain
  // wallet logins so we know to clear stale social state.
  setAuthFromWebsite(token: string, walletAddress: string, socialEmail = '', socialProvider = '') {
    this.state.authToken = token;
    this.state.walletAddress = walletAddress;
    this.state.isAuthenticated = true;
    this.state.socialEmail = socialEmail || null;
    this.state.socialProvider = socialProvider || null;
    localStorage.setItem('noobclaw_auth_token', token);
    localStorage.setItem('noobclaw_wallet_address', walletAddress);
    if (socialEmail) localStorage.setItem('noobclaw_social_email', socialEmail);
    else localStorage.removeItem('noobclaw_social_email');
    if (socialProvider) localStorage.setItem('noobclaw_social_provider', socialProvider);
    else localStorage.removeItem('noobclaw_social_provider');
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

  /**
   * Client-side pre-flight check before kicking off any task that will burn
   * credits (创建涨粉任务 / 直接运行任务). If balance is below `threshold`,
   * fires the same 'noobclaw:token-insufficient' event used by /api/ai 402
   * responses so App-level TokenInsufficientDialog renders — caller should
   * `return` when this returns false.
   *
   * Default threshold 10000: one 涨粉 round burns roughly 1.5-4.5K tokens
   * (action charges + AI 写评论的 token),10000 ≈ 2-3 轮 buffer 让用户至少
   * 跑完手头这个任务再充。
   *
   * Returns true when balance is sufficient OR user is unauthenticated
   * (login UI 会先拦在前面,这里不重复弹窗)。
   */
  hasEnoughBalanceForTask(threshold = 10000): boolean {
    if (!this.state.isAuthenticated) return true;
    if (this.state.tokenBalance >= threshold) return true;
    window.dispatchEvent(new CustomEvent('noobclaw:token-insufficient', {
      detail: { balance: this.state.tokenBalance, threshold },
    }));
    return false;
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
        // v1.x: 后端在 /api/ai/balance 顺道返回"已上链已结算但还没通知客户端"
        // 的 BUSDT 返佣列表(并原子标记 notified_at)。客户端每 15s 调一次本接口,
        // 所以新到账的返佣最多延迟 15s 弹 RebateDrawer 抽屉。
        // 多笔时错开 4.6s 触发,让 RebateDrawer 的"新事件接管旧事件"逻辑给
        // 每一笔一个完整的 4s 展示窗口。
        const pending = (data as any).pendingRebates as Array<{ id: string; amount: string; fromWallet: string | null; level: number | null }> | undefined;
        if (Array.isArray(pending) && pending.length > 0) {
          pending.forEach((item, idx) => {
            if (!item || item.amount === undefined || item.amount === null) return;
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('noobclaw:rebate-received', {
                detail: { amount: item.amount, fromWallet: item.fromWallet ?? undefined, level: item.level ?? undefined },
              }));
            }, idx * (4000 + 600));
          });
        }
        return data.tokenBalance;
      }
      if (res.status === 401) {
        this.handleAuthExpired();
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
          // Cache to local disk in background for instant loading next time
          this.cacheAvatarToDisk(data.avatar_url);
        }
        return;
      }
      if (res.status === 401) {
        this.handleAuthExpired();
      }
    } catch { /* ignore */ }
  }

  // Central 401 handler — invoked whenever any authenticated request comes
  // back as 401. Only acts if the user was previously logged in (so we don't
  // pop the login modal at boot for never-logged-in users whose unauthed
  // requests get rejected). Clears local state, then fires the
  // `noobclaw:need-login` event that App.tsx listens for to show LoginWall.
  handleAuthExpired() {
    if (!this.state.isAuthenticated) return;
    this.logout();
    try {
      window.dispatchEvent(new CustomEvent('noobclaw:need-login', { detail: { reason: 'expired' } }));
    } catch { /* SSR / non-window contexts — never hits in renderer */ }
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
      socialEmail: null,
      socialProvider: null,
    };
    localStorage.removeItem('noobclaw_auth_token');
    localStorage.removeItem('noobclaw_wallet_address');
    localStorage.removeItem('noobclaw_avatar_url');
    localStorage.removeItem('noobclaw_social_email');
    localStorage.removeItem('noobclaw_social_provider');
    this.syncTokenToMain(null);
    this.notify();
  }

  openWebsiteLogin() {
    // Dynamically read: points to localhost:3001 for local testing, noobclaw.com for production
    const websiteUrl = getWebsiteUrl() + '?action=connect&from=app';
    // Open in default browser via electron
    if (typeof window !== 'undefined' && (window as any).electron) {
      (window as any).electron.shell.openExternal(websiteUrl);
    } else {
      window.open(websiteUrl, '_blank');
    }
  }

  /**
   * Show the in-app LoginWall modal first instead of jumping straight to the
   * external website. App.tsx mounts LoginWall globally and listens for the
   * `noobclaw:need-login` event — dispatching it here makes the modal pop up
   * with the "Connect Wallet" button (which itself calls openWebsiteLogin()
   * when the user clicks). This gives users a chance to read what's about to
   * happen before being thrown into the browser.
   *
   * Use this from buttons / page actions; reserve openWebsiteLogin() for the
   * Connect button INSIDE LoginWall (otherwise you'd loop the modal).
   */
  requireLoginUI() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('noobclaw:need-login'));
    }
  }
}

export const noobClawAuth = new NoobClawAuthService();
