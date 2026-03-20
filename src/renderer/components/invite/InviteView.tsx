import React, { useState, useEffect } from 'react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';
import { i18nService } from '../../services/i18n';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface InviteViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

function maskWallet(addr: string): string {
  if (!addr || addr.length < 10) return addr || '';
  return `${addr.slice(0, 6)}****${addr.slice(-4)}`;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const loc = i18nService.getDateLocale();
    return d.toLocaleDateString(loc) + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

export const InviteView: React.FC<InviteViewProps> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const isMac = window.electron.platform === 'darwin';
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  const [profile, setProfile] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [bindResult, setBindResult] = useState<{ success: boolean; message: string } | null>(null);
  const [binding, setBinding] = useState(false);
  const [detailTab, setDetailTab] = useState<'records' | 'rewards'>('records');
  const [inviteList, setInviteList] = useState<Array<{ wallet: string; createdAt: string }>>([]);
  const [inviteListTotal, setInviteListTotal] = useState(0);
  const [inviteListPage, setInviteListPage] = useState(1);
  const [rewardList, setRewardList] = useState<Array<{ noobAmount: number; reason: string; status: string; createdAt: string; contributorWallet?: string; level?: number }>>([]);
  const [rewardListTotal, setRewardListTotal] = useState(0);
  const [rewardListPage, setRewardListPage] = useState(1);
  const [totalEarned, setTotalEarned] = useState(0);
  const [purchaseMin, setPurchaseMin] = useState(50);
  const [purchaseMax, setPurchaseMax] = useState(150);
  const PAGE_SIZE = 10;

  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  useEffect(() => {
    if (authState.isAuthenticated) {
      noobClawApi.getUserProfile().then(setProfile);
    }
    noobClawApi.getPaymentInfo().then(info => {
      if (info?.purchaseNoobPerDollarMin) setPurchaseMin(info.purchaseNoobPerDollarMin);
      if (info?.purchaseNoobPerDollarMax) setPurchaseMax(info.purchaseNoobPerDollarMax);
    });
  }, [authState.isAuthenticated]);

  const hasReferrer = !!profile?.referrerWallet;
  const referralLink = profile?.referralLink || `https://noobclaw.com/r/${authState.walletAddress}`;

  const copyLink = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const bindInvite = async () => {
    if (!inviteCode.trim()) return;
    setBinding(true);
    setBindResult(null);
    try {
      let referrerWallet = inviteCode.trim();
      const linkMatch = referrerWallet.match(/\/r\/([^/\s?]+)/);
      if (linkMatch) referrerWallet = linkMatch[1];
      const resp = await fetch(`${noobClawApi.getBaseUrl().replace('/api/ai', '')}/api/user/referral/register`, {
        method: 'POST',
        headers: { ...noobClawApi.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ referrerWallet }),
      });
      const data = await resp.json();
      setBindResult({
        success: data.success,
        message: data.success ? i18nService.t('inviteBindSuccess') : (data.message || i18nService.t('inviteBindFail')),
      });
      if (data.success) {
        setInviteCode('');
        noobClawApi.getUserProfile().then(setProfile);
      }
    } catch {
      setBindResult({ success: false, message: i18nService.t('inviteNetworkError') });
    }
    setBinding(false);
  };

  const loadRecords = async (page: number) => {
    const data = await noobClawApi.getInviteList(page, PAGE_SIZE);
    setInviteList(data.list);
    setInviteListTotal(data.total);
    setInviteListPage(page);
  };

  const loadRewards = async (page: number) => {
    const data = await noobClawApi.getReferralRewards(page, PAGE_SIZE);
    setRewardList(data.list);
    setRewardListTotal(data.total);
    setTotalEarned(data.totalEarned);
    setRewardListPage(page);
  };

  useEffect(() => {
    if (authState.isAuthenticated) {
      loadRecords(1);
    }
  }, [authState.isAuthenticated]);

  const switchDetailTab = (tab: 'records' | 'rewards') => {
    setDetailTab(tab);
    if (tab === 'records') {
      loadRecords(1);
    } else {
      loadRewards(1);
    }
  };

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
        <h1 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('invitePageTitle')}
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

  const recordsTotalPages = Math.ceil(inviteListTotal / PAGE_SIZE);
  const rewardsTotalPages = Math.ceil(rewardListTotal / PAGE_SIZE);

  // ─── Main page ───
  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {header}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex gap-4 h-full">

          {/* ── Left Column: Referrer + Link + How it works ── */}
          <div className="flex-1 min-w-0 space-y-3 flex flex-col">
            {/* My Referrer (upper level) */}
            {hasReferrer && (
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{i18nService.t('inviteMyUpper')}</div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <svg className="w-3 h-3 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  </div>
                  <span className="text-sm font-mono dark:text-claude-darkText text-claude-text">{maskWallet(profile.referrerWallet)}</span>
                </div>
              </div>
            )}

            {/* Bind Upper - only show when no referrer */}
            {!hasReferrer && (
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('inviteBindUpper')}</div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && bindInvite()}
                    placeholder={i18nService.t('inviteBindUpperPlaceholder')}
                    className="flex-1 text-xs px-3 py-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text focus:border-primary outline-none transition-colors"
                  />
                  <button
                    onClick={bindInvite}
                    disabled={binding || !inviteCode.trim()}
                    className="text-xs px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-black font-medium transition-all disabled:opacity-40"
                  >
                    {binding ? '...' : i18nService.t('inviteBind')}
                  </button>
                </div>
                {bindResult && (
                  <p className={`text-xs mt-1.5 ${bindResult.success ? 'text-primary' : 'text-red-400'}`}>{bindResult.message}</p>
                )}
              </div>
            )}

            {/* My Referral Link */}
            <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1.5">{i18nService.t('inviteYourLink')}</div>
              <div className="flex items-center gap-2 p-2 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 border dark:border-claude-darkBorder border-claude-border">
                <code className="flex-1 text-xs font-mono text-primary truncate select-all">{referralLink}</code>
              </div>
              <button
                onClick={copyLink}
                className={`mt-2 w-full text-sm py-1.5 rounded-lg font-medium transition-all ${
                  copied
                    ? 'bg-primary/20 text-primary'
                    : 'bg-primary hover:bg-primary-hover text-black'
                }`}
              >
                {copied ? i18nService.t('inviteCopied') : i18nService.t('inviteCopy')}
              </button>
            </div>

            {/* How it works + Reward rules */}
            <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
              <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('inviteHowItWorks')}</h3>
              <div className="space-y-2.5">
                {[
                  { title: i18nService.t('inviteStep1Title'), desc: i18nService.t('inviteStep1Desc') },
                  { title: i18nService.t('inviteStep2Title'), desc: i18nService.t('inviteStep2Desc') },
                  { title: i18nService.t('inviteStep3Title'), desc: i18nService.t('inviteStep3Desc', { purchaseMin: String(purchaseMin), purchaseMax: String(purchaseMax) }) },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">{i + 1}</div>
                    <div>
                      <div className="text-sm dark:text-claude-darkText text-claude-text">{step.title}</div>
                      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 p-2.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 border dark:border-claude-darkBorder border-claude-border">
                <div className="text-xs font-medium dark:text-claude-darkText text-claude-text mb-1.5">{i18nService.t('inviteRewardTitle')}</div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteRewardLevel1')}</span>
                    <span className="text-primary font-medium">&ge;50%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteRewardLevel2_6')}</span>
                    <span className="dark:text-claude-darkText text-claude-text">10% each</span>
                  </div>
                </div>
              </div>
            </div>


          </div>

          {/* ── Right Column: Stats + Invite Details / Rewards ── */}
          <div className="flex-1 min-w-0 space-y-3 flex flex-col">
            {/* Stats: Direct Referrals + Total Network */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <div className="text-xl font-bold text-primary">{profile?.directReferrals || 0}</div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteDirectReferrals')}</div>
              </div>
              <div className="p-3 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-center">
                <div className="text-xl font-bold text-primary">{profile?.totalReferrals || 0}</div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteTotalNetwork')}</div>
              </div>
            </div>

            {/* ── Invite Details / Rewards ── */}
            <div className="flex-1 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border flex flex-col min-h-0">
          {/* Tabs */}
          <div className="flex border-b dark:border-claude-darkBorder border-claude-border shrink-0">
            <button
              onClick={() => switchDetailTab('records')}
              className={`flex-1 py-2 text-xs font-medium text-center transition-colors relative ${
                detailTab === 'records'
                  ? 'text-primary'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t('inviteDetailMenu')}
              {detailTab === 'records' && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />}
            </button>
            <button
              onClick={() => switchDetailTab('rewards')}
              className={`flex-1 py-2 text-xs font-medium text-center transition-colors relative ${
                detailTab === 'rewards'
                  ? 'text-primary'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t('inviteRewardMenu')}
              {detailTab === 'rewards' && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />}
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-3">
            {detailTab === 'records' ? (
              inviteList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <svg className="w-8 h-8 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  <p className="text-xs">{i18nService.t('inviteNoRecords')}</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {inviteList.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between px-2 py-1.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                          <svg className="w-3 h-3 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                        </div>
                        <span className="text-xs font-mono dark:text-claude-darkText text-claude-text">{maskWallet(item.wallet)}</span>
                      </div>
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{formatDate(item.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                {totalEarned > 0 && (
                  <div className="mb-2 px-2 py-1.5 rounded-lg bg-primary/5 border border-primary/20 flex items-center justify-between">
                    <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('inviteTotalEarned')}</span>
                    <span className="text-sm font-bold text-primary">{totalEarned.toLocaleString()} NOOB</span>
                  </div>
                )}
                {rewardList.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <svg className="w-8 h-8 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <p className="text-xs">{i18nService.t('inviteNoRecords')}</p>
                  </div>
                ) : (
                  <div>
                    {/* Table header */}
                    <div className="grid grid-cols-4 gap-1 px-2 py-1.5 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary border-b dark:border-claude-darkBorder border-claude-border mb-1">
                      <span>{i18nService.t('inviteRewardColAmount')}</span>
                      <span>{i18nService.t('inviteRewardColTime')}</span>
                      <span>{i18nService.t('inviteRewardColContributor')}</span>
                      <span>{i18nService.t('inviteRewardColLevel')}</span>
                    </div>
                    <div className="space-y-1">
                      {rewardList.map((item, idx) => (
                        <div key={idx} className="grid grid-cols-4 gap-1 items-center px-2 py-1.5 rounded-lg dark:bg-claude-darkSurfaceInset bg-gray-50 text-xs">
                          <span className="font-semibold text-primary">+{item.noobAmount.toLocaleString()}</span>
                          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">{formatDate(item.createdAt)}</span>
                          <span className="font-mono dark:text-claude-darkText text-claude-text truncate">{item.contributorWallet ? maskWallet(item.contributorWallet) : '-'}</span>
                          <span className={`inline-flex items-center justify-center w-fit px-1.5 py-0.5 rounded-full text-xs font-medium ${
                            item.level === 1
                              ? 'bg-primary/10 text-primary'
                              : 'bg-gray-500/10 dark:text-claude-darkTextSecondary text-claude-textSecondary'
                          }`}>
                            {item.level ? `L${item.level}` : '-'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Pagination */}
          {(
            <div className="flex items-center justify-center gap-2 py-2 border-t dark:border-claude-darkBorder border-claude-border shrink-0">
              <button
                onClick={() => detailTab === 'records' ? loadRecords(inviteListPage - 1) : loadRewards(rewardListPage - 1)}
                disabled={detailTab === 'records' ? inviteListPage <= 1 : rewardListPage <= 1}
                className="text-xs px-2 py-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 transition-colors"
              >
                &laquo;
              </button>
              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {detailTab === 'records' ? inviteListPage : rewardListPage} / {detailTab === 'records' ? recordsTotalPages : rewardsTotalPages}
              </span>
              <button
                onClick={() => detailTab === 'records' ? loadRecords(inviteListPage + 1) : loadRewards(rewardListPage + 1)}
                disabled={detailTab === 'records' ? inviteListPage >= recordsTotalPages : rewardListPage >= rewardsTotalPages}
                className="text-xs px-2 py-1 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 transition-colors"
              >
                &raquo;
              </button>
            </div>
          )}
        </div>
          </div>

        </div>
      </div>
    </div>
  );
};

export default InviteView;
