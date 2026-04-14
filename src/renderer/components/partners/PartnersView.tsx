import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import { noobClawApi } from '../../services/noobclawApi';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Partner {
  id: string;
  name: string;
  logo_url: string;
  banner_url: string;
  description: string;
  link: string;
}

interface PartnersViewProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  updateBadge?: React.ReactNode;
  onShowInvite?: () => void;
}

type Tab = 'activities' | 'partners';

const PartnersView: React.FC<PartnersViewProps> = ({
  isSidebarCollapsed: _isSidebarCollapsed,
  onToggleSidebar: _onToggleSidebar,
  onNewChat: _onNewChat,
  updateBadge: _updateBadge,
  onShowInvite,
}) => {
  const [tab, setTab] = useState<Tab>('activities');
  const isZh = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-6 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border">
        <TabButton active={tab === 'activities'} onClick={() => setTab('activities')}>
          🎉 {isZh ? '活动' : 'Activities'}
        </TabButton>
        <TabButton active={tab === 'partners'} onClick={() => setTab('partners')}>
          🤝 {isZh ? '合作' : 'Partners'}
        </TabButton>
      </div>
      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'activities' ? (
          <ActivitiesTab isZh={isZh} onShowInvite={onShowInvite} />
        ) : (
          <PartnersTab isZh={isZh} />
        )}
      </div>
    </div>
  );
};

// ── Tab button ────────────────────────────────────────────────────────

const TabButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      active
        ? 'bg-claude-accent/10 text-claude-accent'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
    }`}
  >
    {children}
  </button>
);

// ── Activities tab ────────────────────────────────────────────────────

const ActivitiesTab: React.FC<{ isZh: boolean; onShowInvite?: () => void }> = ({ isZh, onShowInvite }) => {
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  useEffect(() => noobClawAuth.subscribe(setAuthState), []);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Card A: Daily Check-in */}
      <CheckinCard isZh={isZh} isAuthenticated={authState.isAuthenticated} />

      {/* Card B: Invite Friends */}
      <div className="rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-3xl">🎁</span>
          <div>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {isZh ? '邀请好友赚币' : 'Invite Friends to Earn'}
            </h3>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {isZh
                ? '分享你的邀请链接，好友注册后双方都能获得 $NoobCoin 奖励'
                : 'Share your invite link — both you and your friends earn $NoobCoin rewards'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onShowInvite?.()}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors"
        >
          {isZh ? '🎁 去邀请 →' : '🎁 Invite Friends →'}
        </button>
      </div>
    </div>
  );
};

// ── Check-in card ─────────────────────────────────────────────────────

const CheckinCard: React.FC<{ isZh: boolean; isAuthenticated: boolean }> = ({ isZh, isAuthenticated }) => {
  const [loading, setLoading] = useState(true);
  const [checkedIn, setCheckedIn] = useState(false);
  const [poolExhausted, setPoolExhausted] = useState(false);
  const [lastReward, setLastReward] = useState<{ noob: number; points: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justCheckedIn, setJustCheckedIn] = useState(false);
  const [reward, setReward] = useState<{ noob: number; points: number } | null>(null);
  const [remainingPool, setRemainingPool] = useState(0);
  const [poolCap, setPoolCap] = useState(0);

  const fetchStatus = useCallback(async () => {
    if (!isAuthenticated) { setLoading(false); return; }
    try {
      const s = await noobClawApi.getCheckinStatus();
      setCheckedIn(s.checked_in);
      setLastReward(s.last_reward);
      setRemainingPool(s.remaining_pool);
      setPoolCap(s.pool_cap);
      setPoolExhausted(s.remaining_pool <= 0);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleCheckin = async () => {
    if (!isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    setSubmitting(true);
    try {
      const r = await noobClawApi.checkin();
      if (r.success) {
        setCheckedIn(true);
        setJustCheckedIn(true);
        setReward({ noob: r.noob_reward!, points: r.points_reward! });
      } else if (r.already_checked_in) {
        setCheckedIn(true);
      } else if (r.pool_exhausted) {
        setPoolExhausted(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const formatNum = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();

  return (
    <div className="rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-3xl">📅</span>
        <div>
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {isZh ? '每日签到' : 'Daily Check-in'}
          </h3>
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {isZh
              ? '每天签到领 $NoobCoin 和积分奖励'
              : 'Check in daily for $NoobCoin + credit rewards'}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <span className="h-5 w-5 rounded-full border-2 border-claude-accent border-t-transparent animate-spin" />
        </div>
      ) : justCheckedIn && reward ? (
        /* Success state */
        <div className="text-center py-4">
          <div className="text-4xl mb-2">🎊</div>
          <div className="text-lg font-bold dark:text-claude-darkText text-claude-text mb-1">
            {isZh ? '签到成功！' : 'Checked in!'}
          </div>
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary space-y-1">
            <div>💰 +{reward.noob} $NoobCoin</div>
            <div>⭐ +{formatNum(reward.points)} {isZh ? '积分' : 'credits'}</div>
          </div>
        </div>
      ) : checkedIn ? (
        /* Already checked in */
        <div className="text-center py-4">
          <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed">
            ✓ {isZh ? '今日已签到' : 'Already checked in today'}
          </button>
          {lastReward && (
            <div className="mt-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {isZh ? '今日奖励' : "Today's reward"}: +{lastReward.noob} $NoobCoin · +{formatNum(lastReward.points)} {isZh ? '积分' : 'credits'}
            </div>
          )}
        </div>
      ) : poolExhausted ? (
        /* Pool empty */
        <div className="text-center py-4">
          <div className="text-2xl mb-2">😢</div>
          <div className="text-sm font-medium dark:text-amber-400 text-amber-600 mb-1">
            {isZh ? '今日积分已发完，您来晚了' : "Today's pool is empty — you're a bit late"}
          </div>
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {isZh ? '明天早点来签到吧！' : 'Come back earlier tomorrow!'}
          </div>
        </div>
      ) : (
        /* Ready to check in */
        <div>
          <button
            type="button"
            onClick={handleCheckin}
            disabled={submitting || !isAuthenticated}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                {isZh ? '签到中...' : 'Checking in...'}
              </span>
            ) : !isAuthenticated ? (
              isZh ? '请先登录' : 'Please log in first'
            ) : (
              isZh ? '📅 立即签到' : '📅 Check in now'
            )}
          </button>
          {poolCap > 0 && (
            <div className="mt-3 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary text-center">
              {isZh ? '今日积分池剩余' : 'Pool remaining'}: {formatNum(remainingPool)} / {formatNum(poolCap)}
            </div>
          )}
        </div>
      )}

      {/* Rules */}
      <div className="mt-4 pt-3 border-t dark:border-claude-darkBorder border-claude-border text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary space-y-1">
        <div>{isZh ? '• 每次签到随机获得 50~100 $NoobCoin + 4000~10000 积分' : '• Each check-in rewards 50~100 $NoobCoin + 4,000~10,000 credits'}</div>
        <div>{isZh ? '• 每个钱包地址每天限签一次' : '• One check-in per wallet per day'}</div>
        <div>{isZh ? `• 每日全站积分总量有限（${formatNum(poolCap)}），先到先得` : `• Daily pool capped at ${formatNum(poolCap)} — first come first served`}</div>
      </div>
    </div>
  );
};

// ── Partners tab ──────────────────────────────────────────────────────

const PartnersTab: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const baseUrl = getBackendApiUrl();
    fetch(`${baseUrl}/api/partners`)
      .then(r => r.json())
      .then(data => { setPartners(data.partners || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center py-12">
        <span className="h-5 w-5 rounded-full border-2 border-claude-accent border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="text-xl font-bold dark:text-claude-darkText text-claude-text mb-6">
        {isZh ? '合作伙伴' : 'Partners'}
      </h2>
      {partners.length === 0 ? (
        <div className="text-sm dark:text-claude-darkTextSecondary text-center py-12">
          {isZh ? '暂无合作伙伴' : 'No partners yet'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {partners.map(p => (
            <div
              key={p.id}
              className="group relative rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-all cursor-pointer"
              onClick={() => p.link && window.electron?.shell?.openExternal(p.link)}
            >
              <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                {p.banner_url ? (
                  <img src={p.banner_url} alt={p.name} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-gray-700 to-gray-900" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <div className="flex items-center gap-2.5 mb-1.5">
                    {p.logo_url && (
                      <img src={p.logo_url} alt={p.name} className="w-8 h-8 rounded-full object-cover border border-white/20" />
                    )}
                    <h3 className="font-semibold text-white text-sm">{p.name}</h3>
                  </div>
                  {p.description && (
                    <p className="text-xs text-white/70 line-clamp-2">{p.description}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PartnersView;
