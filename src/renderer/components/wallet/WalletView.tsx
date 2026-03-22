import React, { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi, PaymentInfo } from '../../services/noobclawApi';
import { i18nService } from '../../services/i18n';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface WalletViewProps {
  onOpenSettings?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const ORDER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: i18nService.t('walletStatusPending'),
    completed: i18nService.t('walletStatusCompleted'),
    cancelled: i18nService.t('walletStatusCancelled'),
    expired: i18nService.t('walletStatusExpired'),
    failed: i18nService.t('walletStatusFailed'),
    confirming: i18nService.t('walletStatusConfirming'),
  };
  return map[status] || status;
}

function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    pending: 'bg-yellow-500/10 text-yellow-500',
    completed: 'bg-primary/10 text-primary',
    cancelled: 'bg-gray-500/10 text-gray-400',
    expired: 'bg-red-500/10 text-red-400',
    failed: 'bg-red-500/10 text-red-400',
    confirming: 'bg-blue-500/10 text-blue-400',
  };
  return map[status] || 'bg-gray-500/10 text-gray-400';
}

export const WalletView: React.FC<WalletViewProps> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const isMac = window.electron.platform === 'darwin';
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
  const [orderHistory, setOrderHistory] = useState<any[]>([]);
  const [, setOrderTotal] = useState(0);
  const [pendingOrderNo, setPendingOrderNo] = useState('');
  const [pendingBnbAmount, setPendingBnbAmount] = useState('');
  const [pendingCreatedAt, setPendingCreatedAt] = useState('');
  const [step, setStep] = useState<'select' | 'pay' | 'success'>('select');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<any>(null);
  const [subPage, setSubPage] = useState<'main' | 'orderHistory' | 'noobCoinDetail'>('main');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchOrderNo, setSearchOrderNo] = useState('');
  const [searchFrom, setSearchFrom] = useState('');
  const [searchTo, setSearchTo] = useState('');
  const [countdown, setCountdown] = useState('');
  const [isExpired, setIsExpired] = useState(false);
  const [copyToast, setCopyToast] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ visible: boolean; title: string; message: string; onConfirm: () => void }>({ visible: false, title: '', message: '', onConfirm: () => {} });

  // NoobCoin detail state
  const [noobTab, setNoobTab] = useState<'earnings' | 'sends'>('earnings');
  const [noobStats, setNoobStats] = useState<any>({});
  const [noobEarnings, setNoobEarnings] = useState<any[]>([]);
  const [noobEarningsTotal, setNoobEarningsTotal] = useState(0);
  const [noobEarningsPage, setNoobEarningsPage] = useState(1);
  const [noobEarningsReason, setNoobEarningsReason] = useState('');
  const [noobEarningsFrom, setNoobEarningsFrom] = useState('');
  const [noobEarningsTo, setNoobEarningsTo] = useState('');
  const [noobSends, setNoobSends] = useState<any[]>([]);
  const [noobSendsTotal, setNoobSendsTotal] = useState(0);
  const [noobSendsPage, setNoobSendsPage] = useState(1);
  const [noobSendsFrom, setNoobSendsFrom] = useState('');
  const [noobSendsTo, setNoobSendsTo] = useState('');
  const [noobConfig, setNoobConfig] = useState<{ tokenSymbol: string; totalSupply: string; contractAddress: string; taxRate: string }>({ tokenSymbol: 'Noob', totalSupply: '1000000000', contractAddress: '', taxRate: '2' });
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  useEffect(() => {
    if (authState.isAuthenticated) {
      loadData();
      noobClawAuth.refreshBalance();
    }
  }, [authState.isAuthenticated]);

  useEffect(() => {
    if (!authState.isAuthenticated) return;
    const timer = setInterval(() => noobClawAuth.refreshBalance(), 15000);
    return () => clearInterval(timer);
  }, [authState.isAuthenticated]);

  const loadData = async () => {
    const [info, historyData, profileData, noobCfg] = await Promise.all([
      noobClawApi.getPaymentInfo(),
      noobClawApi.getOrderHistory(),
      noobClawApi.getUserProfile(),
      noobClawApi.getNoobConfig(),
    ]);
    setPaymentInfo(info);
    setOrderHistory(historyData.orders);
    setOrderTotal(historyData.total);
    setProfile(profileData);
    setNoobConfig(noobCfg);
  };

  const loadNoobEarnings = useCallback(async (page = 1, reason = '', from = '', to = '') => {
    const data = await noobClawApi.getNoobEarnings(page, 20, reason, from, to);
    setNoobEarnings(data.list);
    setNoobEarningsTotal(data.total);
    if (data.stats) setNoobStats(data.stats);
  }, []);

  const loadNoobSends = useCallback(async (page = 1, from = '', to = '') => {
    const data = await noobClawApi.getNoobSends(page, 20, from, to);
    setNoobSends(data.list);
    setNoobSendsTotal(data.total);
  }, []);

  const loadOrders = useCallback(async (status?: string, orderNo?: string, from?: string, to?: string) => {
    const data = await noobClawApi.getOrderHistory(status || undefined, orderNo || undefined, from || undefined, to || undefined);
    setOrderHistory(data.orders);
    setOrderTotal(data.total);
  }, []);

  // Countdown timer
  useEffect(() => {
    if (step !== 'pay' || !pendingCreatedAt) return;

    const tick = () => {
      const created = new Date(pendingCreatedAt).getTime();
      const remaining = created + ORDER_TIMEOUT_MS - Date.now();
      if (remaining <= 0) {
        setCountdown('0:00:00');
        setIsExpired(true);
        return;
      }
      setCountdown(formatCountdown(remaining));
      setIsExpired(false);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [step, pendingCreatedAt]);

  // Poll order status
  useEffect(() => {
    if (step !== 'pay' || !pendingOrderNo || isExpired) return;
    const interval = setInterval(async () => {
      const result = await noobClawApi.pollOrderStatus(pendingOrderNo);
      if (result?.order?.status === 'completed') {
        await noobClawAuth.refreshBalance();
        setStep('success');
      } else if (result?.order?.status === 'expired' || result?.order?.status === 'cancelled') {
        setIsExpired(true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [step, pendingOrderNo, isExpired]);

  const handleSelectPackage = async (bnbAmount: number) => {
    setLoading(true);
    setError('');
    const result = await noobClawApi.createOrder(bnbAmount);
    if (result?.order) {
      setPendingOrderNo(result.order.order_no);
      setPendingBnbAmount(parseFloat(result.order.bnb_amount).toFixed(10));
      setPendingCreatedAt(result.order.created_at);
      setIsExpired(false);
      setStep('pay');
    } else if (result?.code === 'PENDING_LIMIT') {
      setError(i18nService.t('walletPendingLimitError'));
    } else {
      setError(result?.error || i18nService.t('walletCreateOrderFailed'));
    }
    setLoading(false);
  };

  const doCancelOrder = async (orderNo: string) => {
    const result = await noobClawApi.cancelOrder(orderNo);
    if (result.success) {
      if (orderNo === pendingOrderNo && step === 'pay') {
        resetPayState();
      }
      loadOrders(statusFilter);
    }
  };

  const handleCancelOrder = (orderNo: string) => {
    setConfirmDialog({
      visible: true,
      title: i18nService.t('walletConfirmCancelTitle'),
      message: i18nService.t('walletConfirmCancelMessage'),
      onConfirm: () => { setConfirmDialog(d => ({ ...d, visible: false })); doCancelOrder(orderNo); },
    });
  };

  const handleBack = () => {
    setConfirmDialog({
      visible: true,
      title: i18nService.t('walletConfirmBackTitle'),
      message: i18nService.t('walletConfirmBackMessage'),
      onConfirm: () => { setConfirmDialog(d => ({ ...d, visible: false })); resetPayState(); },
    });
  };

  const handleViewPendingOrder = (order: any) => {
    setPendingOrderNo(order.order_no);
    setPendingBnbAmount(parseFloat(order.bnb_amount).toFixed(10));
    setPendingCreatedAt(order.created_at);
    setIsExpired(false);
    setStep('pay');
    setSubPage('main');
  };

  const resetPayState = () => {
    setStep('select');
    setError('');
    setPendingOrderNo('');
    setPendingBnbAmount('');
    setPendingCreatedAt('');
    setIsExpired(false);
    setCountdown('');
  };

  const handleAvatarUpload = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 1 * 1024 * 1024) {
        setAvatarError(i18nService.t('walletFileSizeLimit'));
        return;
      }
      if (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) {
        setAvatarError(i18nService.t('walletFileTypeLimit'));
        return;
      }
      setAvatarUploading(true);
      setAvatarError('');
      const result = await noobClawApi.uploadAvatar(file);
      if (result.avatarUrl) {
        noobClawAuth.setAvatarUrl(result.avatarUrl);
      } else {
        setAvatarError(result.error || 'Upload failed');
      }
      setAvatarUploading(false);
    };
    input.click();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 2000);
  };

  const statusTabs = [
    { key: '', label: i18nService.t('walletStatusAll') },
    { key: 'pending', label: i18nService.t('walletStatusPending') },
    { key: 'completed', label: i18nService.t('walletStatusCompleted') },
    { key: 'cancelled', label: i18nService.t('walletStatusCancelled') },
    { key: 'expired', label: i18nService.t('walletStatusExpired') },
  ];

  // ─── Header ───
  const header = (
    <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
      <div className="flex items-center space-x-3 h-8">
        {isSidebarCollapsed && (
          <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
            <button type="button" onClick={onToggleSidebar} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
              <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
            </button>
            <button type="button" onClick={onNewChat} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
              <ComposeIcon className="h-4 w-4" />
            </button>
            {updateBadge}
          </div>
        )}
        {(subPage === 'orderHistory' || subPage === 'noobCoinDetail') && (
          <button type="button" onClick={() => setSubPage('main')} className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
        )}
        <h1 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {subPage === 'orderHistory' ? i18nService.t('walletHistory') : subPage === 'noobCoinDetail' ? 'NoobCoin' : i18nService.t('myWallet')}
        </h1>
      </div>
      <WindowTitleBar inline />
    </div>
  );

  // ─── Not authenticated ───
  if (!authState.isAuthenticated) {
    return (
      <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
          </div>
          <h2 className="text-lg font-bold dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('walletConnectTitle')}</h2>
          <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm mb-6">{i18nService.t('walletConnectDesc')}</p>
          <button
            onClick={() => noobClawAuth.openWebsiteLogin()}
            className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-black rounded-lg font-medium transition-all"
          >
            {i18nService.t('walletConnectBtn')}
          </button>
        </div>
      </div>
    );
  }

  const walletAddr = authState.walletAddress || '';
  const balance = authState.tokenBalance;

  // ─── Confirm Dialog (shared) ───
  const confirmDialogEl = confirmDialog.visible ? (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-6 w-full max-w-sm p-5 rounded-xl dark:bg-claude-darkSurface bg-white shadow-xl border dark:border-claude-darkBorder border-claude-border">
        <h3 className="text-sm font-bold dark:text-claude-darkText text-claude-text mb-2">{confirmDialog.title}</h3>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4 leading-relaxed">{confirmDialog.message}</p>
        <div className="flex gap-2">
          <button
            onClick={() => setConfirmDialog(d => ({ ...d, visible: false }))}
            className="flex-1 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text transition-colors"
          >
            {i18nService.t('walletDialogCancel')}
          </button>
          <button
            onClick={confirmDialog.onConfirm}
            className="flex-1 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
          >
            {i18nService.t('walletDialogConfirm')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // ─── Order History sub-page ───
  if (subPage === 'orderHistory') {
    return (
      <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative">
        {header}
        {confirmDialogEl}

        {/* Status filter tabs */}
        <div className="flex gap-1 px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border overflow-x-auto">
          {statusTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setStatusFilter(tab.key); setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(tab.key); }}
              className={`px-3 py-1.5 text-xs rounded-lg whitespace-nowrap transition-colors ${
                statusFilter === tab.key
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search filters */}
        <div className="px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border space-y-2">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={searchOrderNo}
              onChange={(e) => setSearchOrderNo(e.target.value)}
              placeholder={i18nService.t('walletOrderNo')}
              className="flex-1 px-2.5 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="flex gap-2 items-center">
            <input
              type="date"
              value={searchFrom}
              onChange={(e) => setSearchFrom(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border outline-none focus:ring-1 focus:ring-primary/50 dark:[color-scheme:dark]"
            />
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">—</span>
            <input
              type="date"
              value={searchTo}
              onChange={(e) => setSearchTo(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border outline-none focus:ring-1 focus:ring-primary/50 dark:[color-scheme:dark]"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => loadOrders(statusFilter, searchOrderNo, searchFrom ? `${searchFrom}T00:00:00` : '', searchTo ? `${searchTo}T23:59:59` : '')}
              className="px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              {i18nService.t('walletSearch')}
            </button>
            <button
              onClick={() => { setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(statusFilter); }}
              className="px-3 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-80 transition-colors"
            >
              {i18nService.t('walletClear')}
            </button>
          </div>
        </div>

        {/* Order List */}
        <div className="flex-1 overflow-y-auto p-4">
          {orderHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <svg className="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              <p className="text-sm">{i18nService.t('inviteNoRecords')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {orderHistory.map((order) => {
                const isPending = order.status === 'pending';
                const createdTime = new Date(order.created_at);
                const timeStr = createdTime.toLocaleDateString(i18nService.getDateLocale()) + ' ' +createdTime.toLocaleTimeString(i18nService.getDateLocale(), { hour: '2-digit', minute: '2-digit' });

                return (
                  <div key={order.id} className="p-3.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <code className="text-xs font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">{order.order_no}</code>
                        <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mt-1">
                          {parseFloat(order.bnb_amount).toFixed(10)} BNB
                          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary font-normal"> · {(order.tokens_purchased / 1_000_000).toFixed(1)}{i18nService.t('walletMTokenUnit')}</span>
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusColor(order.status)}`}>
                        {getStatusLabel(order.status)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{timeStr}</span>
                      {isPending && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleViewPendingOrder(order)}
                            className="text-xs px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          >
                            {i18nService.t('walletPayNow')}
                          </button>
                          <button
                            onClick={() => handleCancelOrder(order.order_no)}
                            className="text-xs px-2.5 py-1 rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-400 transition-colors"
                          >
                            {i18nService.t('walletCancelOrder')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── NoobCoin Detail sub-page ───
  if (subPage === 'noobCoinDetail') {
    const PAGE_SIZE = 20;
    const earningsTotalPages = Math.ceil(noobEarningsTotal / PAGE_SIZE) || 1;
    const sendsTotalPages = Math.ceil(noobSendsTotal / PAGE_SIZE) || 1;

    const reasonLabels: Record<string, string> = {
      referral_bonus: i18nService.t('walletReasonReferralBonus'),
      purchase_bonus: i18nService.t('walletReasonPurchaseBonus'),
      lucky_bag: i18nService.t('walletReasonLuckyBag'),
    };

    // Auto-load on mount
    if (noobEarnings.length === 0 && noobEarningsTotal === 0 && !noobStats.totalEarned && noobStats.totalEarned !== 0) {
      loadNoobEarnings(1, '', '', '');
    }

    return (
      <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative">
        {header}
        {copyToast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-primary text-black text-xs font-medium shadow-lg animate-fade-in">
            {i18nService.t('walletCopiedToClipboard')}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5 max-w-xl mx-auto w-full space-y-4">

          {/* Intro card */}
          <div className="rounded-2xl overflow-hidden border dark:border-primary/20 border-primary/15 shadow-lg" style={{ background: 'linear-gradient(145deg, rgba(74,222,128,0.12) 0%, rgba(74,222,128,0.03) 50%, rgba(74,222,128,0.08) 100%)' }}>
            {/* Header: Logo + Name + Symbol */}
            <div className="p-5 pb-4">
              <div className="flex items-center gap-3.5 mb-4">
                <div className="relative">
                  <img src="logo.png" alt="NoobCoin" className="w-14 h-14 rounded-2xl shadow-lg ring-2 ring-primary/30" />
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-md">
                    <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                  </div>
                </div>
                <div>
                  <h2 className="text-xl font-bold dark:text-claude-darkText text-claude-text tracking-tight">NoobCoin</h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs font-mono font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">${noobConfig.tokenSymbol}</span>
                    <span className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">BSC (BEP-20)</span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
                {i18nService.t('walletNoobCoinDesc')}
              </p>
            </div>

            {/* Divider */}
            <div className="mx-5 border-t dark:border-primary/10 border-primary/10" />

            {/* Token Info Grid */}
            <div className="p-5 pt-4 grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl dark:bg-black/25 bg-white/70 backdrop-blur-sm border dark:border-white/5 border-black/5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" /></svg>
                  <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletTokenSymbol')}</p>
                </div>
                <p className="text-sm font-bold dark:text-claude-darkText text-claude-text">{noobConfig.tokenSymbol}</p>
              </div>
              <div className="p-3 rounded-xl dark:bg-black/25 bg-white/70 backdrop-blur-sm border dark:border-white/5 border-black/5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                  <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletTotalSupply')}</p>
                </div>
                <p className="text-sm font-bold dark:text-claude-darkText text-claude-text">{Number(noobConfig.totalSupply).toLocaleString()}</p>
              </div>
              <div className="p-3 rounded-xl dark:bg-black/25 bg-white/70 backdrop-blur-sm border dark:border-white/5 border-black/5 col-span-2">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                  <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletContractAddress')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] font-mono dark:text-claude-darkText text-claude-text truncate flex-1">
                    {noobConfig.contractAddress || i18nService.t('walletTBD')}
                  </code>
                  {noobConfig.contractAddress && (
                    <button
                      onClick={() => copyToClipboard(noobConfig.contractAddress)}
                      className="shrink-0 p-1.5 rounded-lg hover:bg-primary/15 active:bg-primary/25 transition-colors group"
                      title={i18nService.t('walletCopy')}
                    >
                      <svg className="w-3.5 h-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary group-hover:text-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeWidth={2}/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeWidth={2}/></svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Feature highlight */}
            <div className="mx-5 mb-4 p-3 rounded-xl bg-primary/8 border border-primary/15">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-bold text-primary">{noobConfig.taxRate}% {i18nService.t('walletTaxToken')}</span>
              </div>
              <p className="text-[11px] dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 leading-relaxed">
                {i18nService.t('walletTaxDesc', { taxRate: noobConfig.taxRate })}
              </p>
            </div>

            {/* Footer link */}
            <div className="px-5 pb-4">
              <button
                onClick={() => window.electron?.shell?.openExternal('https://noobclaw.com')}
                className="text-xs text-primary hover:text-primary/80 hover:underline transition-colors flex items-center gap-1"
              >
                {i18nService.t('walletSeeWebsite')}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </button>
            </div>
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: i18nService.t('walletStatTotalEarned'), value: noobStats.totalEarned || 0, color: 'text-white' },
              { label: i18nService.t('walletStatReferral'), value: noobStats.referralEarned || 0, color: 'text-purple-400' },
              { label: i18nService.t('walletStatLuckyBag'), value: noobStats.luckyBagEarned || 0, color: 'text-orange-400' },
              { label: i18nService.t('walletStatPurchase'), value: noobStats.purchaseEarned || 0, color: 'text-sky-400' },
              { label: i18nService.t('walletStatOnChainSent'), value: noobStats.totalSent || 0, color: 'text-green-400' },
              { label: i18nService.t('walletStatOnChainPending'), value: noobStats.pending || 0, color: 'text-yellow-400' },
            ].map((s, i) => (
              <div key={i} className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1 truncate">{s.label}</p>
                <p className={`text-sm font-bold ${s.color}`}>{Number(s.value).toLocaleString()}</p>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b dark:border-claude-darkBorder border-claude-border">
            {([
              { key: 'earnings' as const, label: i18nService.t('walletTabEarnings') },
              { key: 'sends' as const, label: i18nService.t('walletTabSends') },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => {
                  setNoobTab(tab.key);
                  if (tab.key === 'earnings') { setNoobEarningsPage(1); loadNoobEarnings(1, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }
                  else { setNoobSendsPage(1); loadNoobSends(1, noobSendsFrom, noobSendsTo); }
                }}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  noobTab === tab.key
                    ? 'border-primary text-primary'
                    : 'border-transparent dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Earnings tab */}
          {noobTab === 'earnings' && (
            <div className="space-y-3">
              {/* Filters */}
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  value={noobEarningsReason}
                  onChange={e => setNoobEarningsReason(e.target.value)}
                  className="text-xs px-2.5 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text"
                >
                  <option value="">{i18nService.t('walletFilterAllTypes')}</option>
                  <option value="referral_bonus">{i18nService.t('walletFilterReferral')}</option>
                  <option value="purchase_bonus">{i18nService.t('walletFilterPurchase')}</option>
                  <option value="lucky_bag">{i18nService.t('walletFilterLuckyBag')}</option>
                </select>
                <input type="date" value={noobEarningsFrom} onChange={e => setNoobEarningsFrom(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">~</span>
                <input type="date" value={noobEarningsTo} onChange={e => setNoobEarningsTo(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <button
                  onClick={() => { setNoobEarningsPage(1); loadNoobEarnings(1, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  {i18nService.t('walletSearch')}
                </button>
                <button
                  onClick={() => { setNoobEarningsReason(''); setNoobEarningsFrom(''); setNoobEarningsTo(''); setNoobEarningsPage(1); loadNoobEarnings(1, '', '', ''); }}
                  className="text-xs px-3 py-1.5 rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText transition-colors"
                >
                  {i18nService.t('walletClear')}
                </button>
              </div>

              {/* List */}
              {noobEarnings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <svg className="w-10 h-10 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <p className="text-sm">{i18nService.t('walletNoRecords')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {noobEarnings.map((record: any, idx: number) => {
                    const time = new Date(record.created_at);
                    const timeStr = time.toLocaleDateString(i18nService.getDateLocale()) + ' ' +time.toLocaleTimeString(i18nService.getDateLocale(), { hour: '2-digit', minute: '2-digit' });
                    return (
                      <div key={idx} className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-primary">+{Number(record.noob_amount).toLocaleString()} $NOOB</span>
                          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{timeStr}</span>
                        </div>
                        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{reasonLabels[record.reason] || record.reason}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination */}
              {earningsTotalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    disabled={noobEarningsPage <= 1}
                    onClick={() => { const p = noobEarningsPage - 1; setNoobEarningsPage(p); loadNoobEarnings(p, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    ‹ {i18nService.t('walletPrev')}
                  </button>
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{noobEarningsPage} / {earningsTotalPages}</span>
                  <button
                    disabled={noobEarningsPage >= earningsTotalPages}
                    onClick={() => { const p = noobEarningsPage + 1; setNoobEarningsPage(p); loadNoobEarnings(p, noobEarningsReason, noobEarningsFrom, noobEarningsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    {i18nService.t('walletNext')} ›
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Sends tab */}
          {noobTab === 'sends' && (
            <div className="space-y-3">
              {/* Filters */}
              <div className="flex flex-wrap gap-2 items-center">
                <input type="date" value={noobSendsFrom} onChange={e => setNoobSendsFrom(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">~</span>
                <input type="date" value={noobSendsTo} onChange={e => setNoobSendsTo(e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text" />
                <button
                  onClick={() => { setNoobSendsPage(1); loadNoobSends(1, noobSendsFrom, noobSendsTo); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  {i18nService.t('walletSearch')}
                </button>
                <button
                  onClick={() => { setNoobSendsFrom(''); setNoobSendsTo(''); setNoobSendsPage(1); loadNoobSends(1, '', ''); }}
                  className="text-xs px-3 py-1.5 rounded-lg dark:bg-claude-darkSurfaceHover bg-gray-100 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText transition-colors"
                >
                  {i18nService.t('walletClear')}
                </button>
              </div>

              {/* List */}
              {noobSends.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <svg className="w-10 h-10 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <p className="text-sm">{i18nService.t('walletNoRecords')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {noobSends.map((record: any, idx: number) => {
                    const time = new Date(record.created_at);
                    const timeStr = time.toLocaleDateString(i18nService.getDateLocale()) + ' ' +time.toLocaleTimeString(i18nService.getDateLocale(), { hour: '2-digit', minute: '2-digit' });
                    return (
                      <div key={idx} className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-green-400">+{Number(record.noob_amount).toLocaleString()} $NOOB</span>
                          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{timeStr}</span>
                        </div>
                        {record.tx_hash && (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline font-mono truncate max-w-full text-left"
                            onClick={() => window.electron?.shell?.openExternal(`https://bscscan.com/tx/${record.tx_hash}`)}
                          >
                            TX: {record.tx_hash.slice(0, 10)}...{record.tx_hash.slice(-8)}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination */}
              {sendsTotalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    disabled={noobSendsPage <= 1}
                    onClick={() => { const p = noobSendsPage - 1; setNoobSendsPage(p); loadNoobSends(p, noobSendsFrom, noobSendsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    ‹ {i18nService.t('walletPrev')}
                  </button>
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{noobSendsPage} / {sendsTotalPages}</span>
                  <button
                    disabled={noobSendsPage >= sendsTotalPages}
                    onClick={() => { const p = noobSendsPage + 1; setNoobSendsPage(p); loadNoobSends(p, noobSendsFrom, noobSendsTo); }}
                    className="text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary disabled:opacity-30 hover:text-primary transition-colors"
                  >
                    {i18nService.t('walletNext')} ›
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    );
  }

  // ─── Main page ───
  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg relative">
      {header}
      {copyToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-primary text-black text-xs font-medium shadow-lg animate-fade-in">
          {i18nService.t('walletCopiedToClipboard')}
        </div>
      )}
      {confirmDialogEl}
      <div className="flex-1 overflow-y-auto p-5 max-w-xl mx-auto w-full space-y-4">

        {/* Wallet Header */}
        <div className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          {/* Avatar + Wallet Info */}
          <div className="flex items-center gap-4 mb-4">
            <div className="relative group shrink-0">
              <button
                type="button"
                onClick={handleAvatarUpload}
                disabled={avatarUploading}
                className="relative w-16 h-16 rounded-full overflow-hidden border-2 dark:border-claude-darkBorder border-claude-border hover:border-primary/50 transition-colors cursor-pointer"
                title={i18nService.t('walletChangeAvatar')}
              >
                {authState.avatarUrl ? (
                  <img src={authState.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                    <span className="text-white text-lg font-bold">{walletAddr.slice(2, 4).toUpperCase()}</span>
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                  {avatarUploading ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  )}
                </div>
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('walletMyWalletBsc')}</span>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs text-primary">{i18nService.t('walletConnected')}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono dark:text-claude-darkText text-claude-text flex-1 truncate">{walletAddr}</code>
                <button onClick={() => copyToClipboard(walletAddr)} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary px-2 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border hover:border-primary/40 transition-all">
                  {i18nService.t('walletCopy')}
                </button>
              </div>
              {avatarError && <p className="text-xs text-red-400 mt-1">{avatarError}</p>}
            </div>
          </div>
          <div className="flex items-stretch gap-4">
            {/* Token Balance - Left */}
            <div className="flex-1">
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('walletTokenBalance')}</p>
              <p className="text-2xl font-bold text-primary">
                {(balance / 1_000_000).toFixed(2)}M
              </p>
            </div>
            {/* NoobCoin - Right */}
            <div className="flex-1 flex flex-col items-center justify-center border-l dark:border-claude-darkBorder border-claude-border pl-4">
              <div className="flex items-center gap-2 mb-1">
                <img src="logo.png" alt="NoobCoin" className="w-6 h-6 rounded-full" />
                <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">NoobCoin{i18nService.t('walletNoobCoinTotal')}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-primary">{Number(profile?.totalNoob || 0).toLocaleString()}</span>
                <button
                  onClick={() => setSubPage('noobCoinDetail')}
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  {i18nService.t('walletView')}
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
          </div>
          {balance < 100000 && (
            <div className="mt-3 p-2.5 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-xs text-yellow-500">
              {i18nService.t('walletLowBalance')}
            </div>
          )}
        </div>

        {/* Buy Tokens */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('walletTopUp')}</h3>
            <button
              onClick={() => { setSubPage('orderHistory'); setStatusFilter(''); setSearchOrderNo(''); setSearchFrom(''); setSearchTo(''); loadOrders(''); }}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary transition-colors flex items-center gap-1"
            >
              {i18nService.t('walletHistory')}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">
              {error}
            </div>
          )}

          {step === 'select' && (
            <div className="grid grid-cols-3 gap-3">
              {paymentInfo?.packages.map((pkg: any) => (
                <div key={pkg.bnb} className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center flex flex-col">
                  <p className="font-bold dark:text-claude-darkText text-claude-text mb-1">{pkg.label}</p>
                  <p className="text-xs text-primary font-medium mb-3">{pkg.tokensDisplay}</p>
                  <button
                    onClick={() => handleSelectPackage(pkg.bnb)}
                    disabled={loading}
                    className="mt-auto w-full py-2 rounded-lg bg-primary hover:bg-primary-hover text-black text-xs font-semibold disabled:opacity-40 transition-all"
                  >
                    {i18nService.t('walletTopUp')}
                  </button>
                </div>
              )) || (
                <div className="col-span-3 text-center dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm py-4">{i18nService.t('walletLoadingPackages')}</div>
              )}
            </div>
          )}

          {step === 'pay' && (
            <div className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
              {/* Countdown timer */}
              <div className={`mb-4 p-3 rounded-lg text-center ${isExpired ? 'bg-red-500/5 border border-red-500/20' : 'bg-primary/5 border border-primary/20'}`}>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                  {i18nService.t('walletCountdownPrefix')}
                </div>
                <div className={`text-2xl font-mono font-bold ${isExpired ? 'text-red-400' : 'text-primary'}`}>
                  {countdown || '0:30:00'}
                </div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                  {i18nService.t('walletCountdownSuffix')}
                </div>
              </div>

              {isExpired ? (
                /* Expired state */
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <p className="text-sm font-medium text-red-400 mb-2">{i18nService.t('walletOrderExpired')}</p>
                  <p className="text-xs text-red-400/70 mb-4">{i18nService.t('walletTimeoutWarning')}</p>
                  <button
                    onClick={resetPayState}
                    className="w-full py-2 rounded-lg bg-primary hover:bg-primary-hover text-black text-sm font-medium transition-all"
                  >
                    {i18nService.t('walletBack')}
                  </button>
                </div>
              ) : (
                /* Payment info */
                <>
                  <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">{i18nService.t('walletSendBnb')}</h4>
                  <div className="space-y-3 mb-4">
                    <div>
                      <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('walletSendExactly')}</p>
                      <div className="flex items-center gap-2">
                        <code className="font-bold text-primary text-lg">{pendingBnbAmount} BNB</code>
                        <button onClick={() => copyToClipboard(pendingBnbAmount)} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary px-2 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border transition-colors">{i18nService.t('walletCopy')}</button>
                      </div>
                      <p className="text-xs text-yellow-500 mt-1">
                        {i18nService.t('walletExactAmountWarning')}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('walletTreasuryWallet')}</p>
                      <div className="flex items-start gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <code className="text-xs font-mono dark:text-claude-darkText text-claude-text flex-1 truncate">{paymentInfo?.treasuryWallet || 'Loading...'}</code>
                            <button onClick={() => copyToClipboard(paymentInfo?.treasuryWallet || '')} className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-primary px-2 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border transition-colors">{i18nService.t('walletCopy')}</button>
                          </div>
                        </div>
                        {paymentInfo?.treasuryWallet && (
                          <div className="flex flex-col items-center">
                            <div className="bg-white p-1.5 rounded-lg">
                              <QRCodeSVG value={paymentInfo.treasuryWallet} size={80} />
                            </div>
                            <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1 text-center">{i18nService.t('walletScanQr')}</p>
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('walletOrderNo')}</p>
                      <code className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{pendingOrderNo}</code>
                    </div>
                  </div>

                  {/* Waiting indicator */}
                  <div className="mb-3 p-3 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-3">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                    <p className="text-xs text-primary">
                      {i18nService.t('walletWaitingConfirmation')}
                    </p>
                  </div>

                  {/* Tips */}
                  <div className="mb-4 space-y-1.5">
                    <div className="flex items-start gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      <span className="text-primary mt-0.5">*</span>
                      <span>{i18nService.t('walletAutoConfirmNote')}</span>
                    </div>
                    <div className="flex items-start gap-2 text-xs text-red-400/80">
                      <span className="text-red-400 mt-0.5">*</span>
                      <span>{i18nService.t('walletTimeoutWarning')}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCancelOrder(pendingOrderNo)}
                      className="flex-1 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-400 hover:border-red-400/40 transition-colors"
                    >
                      {i18nService.t('walletCancelOrder')}
                    </button>
                    <button
                      onClick={handleBack}
                      className="flex-1 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text transition-colors"
                    >
                      {i18nService.t('walletBack')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'success' && (
            <div className="p-5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border border-primary/20 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
                <svg className="w-7 h-7 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <p className="font-bold text-primary mb-1">{i18nService.t('walletPaymentConfirmed')}</p>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">{i18nService.t('walletTokensAdded')}</p>
              <p className="text-xl font-bold dark:text-claude-darkText text-claude-text">{(authState.tokenBalance / 1_000_000).toFixed(2)}{i18nService.t('walletMTokenUnit')}</p>
              <button onClick={() => { resetPayState(); loadData(); }} className="mt-4 text-sm text-primary hover:underline">
                {i18nService.t('walletBackToWallet')}
              </button>
            </div>
          )}
        </div>


      </div>
    </div>
  );
};

export default WalletView;
