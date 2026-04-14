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
  onShowXhs?: () => void;
  onShowPersonality?: () => void;
}

type Tab = 'activities' | 'partners';

const PartnersView: React.FC<PartnersViewProps> = ({
  isSidebarCollapsed: _isSidebarCollapsed,
  onToggleSidebar: _onToggleSidebar,
  onNewChat: _onNewChat,
  updateBadge: _updateBadge,
  onShowInvite,
  onShowXhs,
  onShowPersonality,
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
          <ActivitiesTab isZh={isZh} onShowInvite={onShowInvite} onShowXhs={onShowXhs} onShowPersonality={onShowPersonality} />
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

const ActivitiesTab: React.FC<{
  isZh: boolean;
  onShowInvite?: () => void;
  onShowXhs?: () => void;
  onShowPersonality?: () => void;
}> = ({ isZh, onShowInvite, onShowXhs, onShowPersonality }) => {
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  useEffect(() => noobClawAuth.subscribe(setAuthState), []);

  const [status, setStatus] = useState<{
    activities: Array<{ type: string; claimed: boolean; enabled?: boolean; last_reward: { noob: number; points: number } | null }>;
    pool: { noob_remaining: number; noob_cap: number; points_remaining: number; points_cap: number; exhausted: boolean };
  } | null>(null);
  const [popup, setPopup] = useState<{ activity: string; reward: { noob: number; points: number } } | null>(null);

  const reload = useCallback(async () => {
    if (!authState.isAuthenticated) return;
    const s = await noobClawApi.getActivityStatus();
    setStatus(s);
  }, [authState.isAuthenticated]);

  useEffect(() => { reload(); }, [reload]);

  const isClaimed = (type: string) => status?.activities.find(a => a.type === type)?.claimed || false;
  const isEnabled = (type: string) => status?.activities.find(a => a.type === type)?.enabled !== false;
  const lastReward = (type: string) => status?.activities.find(a => a.type === type)?.last_reward || null;
  const exhausted = status?.pool.exhausted || false;

  const claim = async (type: string, afterClaim?: () => void) => {
    if (!authState.isAuthenticated) { noobClawAuth.openWebsiteLogin(); return; }
    const r = await noobClawApi.claimActivity(type);
    if (r.success) {
      setPopup({ activity: type, reward: { noob: r.noob_reward || 0, points: r.points_reward || 0 } });
      reload();
      afterClaim?.();
    } else if (r.already_claimed) {
      reload();
    } else if (r.pool_exhausted) {
      reload();
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Card A: Daily Check-in */}
      <ActivityCard
        isZh={isZh}
        icon="📅"
        titleZh="每日签到"
        titleEn="Daily Check-in"
        descZh="每天签到领 $NoobCoin 和积分奖励"
        descEn="Check in daily for $NoobCoin + credit rewards"
        ctaZh="📅 立即签到"
        ctaEn="📅 Check in now"
        claimed={isClaimed('checkin')}
        enabled={isEnabled('checkin')}
        lastReward={lastReward('checkin')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('checkin')}
      />

      {/* Card B: XHS Auto-Rewrite */}
      <ActivityCard
        isZh={isZh}
        icon="📝"
        titleZh="小红书自动仿写爆款"
        titleEn="XHS Auto-Rewrite Viral Post"
        descZh="一键跳转小红书自动化栏目，完成一次仿写即可领奖励"
        descEn="Jump to XHS automation — complete one rewrite to claim rewards"
        ctaZh="🚀 去仿写 + 领奖"
        ctaEn="🚀 Go rewrite & claim"
        claimed={isClaimed('xhs_rewrite')}
        enabled={isEnabled('xhs_rewrite')}
        lastReward={lastReward('xhs_rewrite')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('xhs_rewrite', () => onShowXhs?.())}
      />

      {/* Card C: OG Brawl Game */}
      <ActivityCard
        isZh={isZh}
        icon="⚔️"
        titleZh="玩一次 OG 对战"
        titleEn="Play OG Brawl Once"
        descZh="打开浏览器进入 OG 对战游戏，玩一局就能领奖励"
        descEn="Opens browser to the OG Brawl game — one match earns rewards"
        ctaZh="⚔️ 去对战 + 领奖"
        ctaEn="⚔️ Go battle & claim"
        claimed={isClaimed('og_brawl')}
        enabled={isEnabled('og_brawl')}
        lastReward={lastReward('og_brawl')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('og_brawl', () => {
          try { (window as any).api?.openExternal?.('https://noobclaw.com/brawl'); } catch {}
        })}
      />

      {/* Card D: Personality Test */}
      <ActivityCard
        isZh={isZh}
        icon="🧠"
        titleZh="完成一次人格测试"
        titleEn="Complete a Personality Test"
        descZh="做一次 MBTI / 人格测试，提交即可领奖励"
        descEn="Take a personality/MBTI test once to earn rewards"
        ctaZh="🧠 去测试 + 领奖"
        ctaEn="🧠 Take test & claim"
        claimed={isClaimed('personality_test')}
        enabled={isEnabled('personality_test')}
        lastReward={lastReward('personality_test')}
        exhausted={exhausted}
        isAuthenticated={authState.isAuthenticated}
        onClaim={() => claim('personality_test', () => onShowPersonality?.())}
      />

      {/* Card E: Invite Friends */}
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

      {popup && (
        <RewardPopup
          isZh={isZh}
          activity={popup.activity}
          reward={popup.reward}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
};

// ── Generic Activity Card ─────────────────────────────────────────────

interface ActivityCardProps {
  isZh: boolean;
  icon: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  ctaZh: string;
  ctaEn: string;
  claimed: boolean;
  enabled?: boolean;
  lastReward: { noob: number; points: number } | null;
  exhausted: boolean;
  isAuthenticated: boolean;
  onClaim: () => void | Promise<void>;
}

const formatNum = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();

const ActivityCard: React.FC<ActivityCardProps> = ({
  isZh, icon, titleZh, titleEn, descZh, descEn, ctaZh, ctaEn,
  claimed, enabled = true, lastReward, exhausted, isAuthenticated, onClaim,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const handleClick = async () => {
    if (submitting) return;
    setSubmitting(true);
    try { await onClaim(); } finally { setSubmitting(false); }
  };

  return (
    <div className={`rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6 ${!enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3 mb-4">
        <span className="text-3xl">{icon}</span>
        <div>
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {isZh ? titleZh : titleEn}
          </h3>
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {isZh ? descZh : descEn}
          </p>
        </div>
      </div>

      {!enabled ? (
        <div className="text-center py-3">
          <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed">
            🚧 {isZh ? '活动已暂停，敬请期待' : 'Activity paused — stay tuned'}
          </button>
        </div>
      ) : claimed ? (
        <div className="text-center py-3">
          <button disabled className="w-full py-3 rounded-xl text-sm font-semibold bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed">
            ✓ {isZh ? '今日已完成' : 'Completed today'}
          </button>
          {lastReward && (
            <div className="mt-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {isZh ? '奖励' : 'Reward'}:
              {lastReward.noob > 0 && ` +${lastReward.noob} $NoobCoin`}
              {lastReward.noob > 0 && lastReward.points > 0 && ' ·'}
              {lastReward.points > 0 && ` +${formatNum(lastReward.points)} ${isZh ? '积分' : 'credits'}`}
            </div>
          )}
        </div>
      ) : exhausted ? (
        <div className="text-center py-3">
          <div className="text-2xl mb-1">😢</div>
          <div className="text-sm font-medium dark:text-amber-400 text-amber-600">
            {isZh ? '今日奖池已发完，您来晚了' : "Today's pool is empty — come back tomorrow"}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={submitting || !isAuthenticated}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              {isZh ? '处理中...' : 'Processing...'}
            </span>
          ) : !isAuthenticated ? (
            isZh ? '请先登录' : 'Please log in first'
          ) : (
            isZh ? ctaZh : ctaEn
          )}
        </button>
      )}
    </div>
  );
};

// ── Cool Reward Popup ─────────────────────────────────────────────────

const ACTIVITY_LABELS_ZH: Record<string, { title: string; emoji: string }> = {
  checkin: { title: '签到成功', emoji: '📅' },
  xhs_rewrite: { title: '小红书任务完成', emoji: '📝' },
  og_brawl: { title: 'OG 对战开始', emoji: '⚔️' },
  personality_test: { title: '人格测试启动', emoji: '🧠' },
};
const ACTIVITY_LABELS_EN: Record<string, { title: string; emoji: string }> = {
  checkin: { title: 'Checked In', emoji: '📅' },
  xhs_rewrite: { title: 'XHS Task Claimed', emoji: '📝' },
  og_brawl: { title: 'Brawl Unlocked', emoji: '⚔️' },
  personality_test: { title: 'Test Started', emoji: '🧠' },
};

const RewardPopup: React.FC<{
  isZh: boolean;
  activity: string;
  reward: { noob: number; points: number };
  onClose: () => void;
}> = ({ isZh, activity, reward, onClose }) => {
  const labels = isZh ? ACTIVITY_LABELS_ZH : ACTIVITY_LABELS_EN;
  const info = labels[activity] || { title: activity, emoji: '🎉' };
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative max-w-sm w-[92vw] rounded-3xl p-8 text-center shadow-2xl animate-[popIn_0.35s_cubic-bezier(.2,1.4,.4,1)] bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors flex items-center justify-center text-lg"
        >
          ×
        </button>
        <div className="text-7xl mb-2 drop-shadow-[0_4px_12px_rgba(0,0,0,0.3)]">{info.emoji}</div>
        <div className="text-2xl font-bold text-white mb-1 drop-shadow">{info.title}</div>
        <div className="text-sm text-white/80 mb-5">{isZh ? '恭喜获得今日奖励 🎊' : 'Enjoy your daily rewards 🎊'}</div>
        <div className="space-y-2 mb-6">
          {reward.noob > 0 && (
            <div className="rounded-xl bg-white/20 backdrop-blur px-4 py-3 text-white text-left flex items-center justify-between">
              <span className="text-sm">💰 $NoobCoin</span>
              <span className="text-xl font-bold">+{reward.noob}</span>
            </div>
          )}
          {reward.points > 0 && (
            <div className="rounded-xl bg-white/20 backdrop-blur px-4 py-3 text-white text-left flex items-center justify-between">
              <span className="text-sm">⭐ {isZh ? '积分' : 'Credits'}</span>
              <span className="text-xl font-bold">+{formatNum(reward.points)}</span>
            </div>
          )}
          {reward.noob === 0 && reward.points === 0 && (
            <div className="rounded-xl bg-white/20 backdrop-blur px-4 py-3 text-white text-sm">
              {isZh ? '奖池余额不足，下次再来！' : 'Pool is empty — try again tomorrow!'}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-white text-gray-900 hover:bg-white/90 transition-colors"
        >
          {isZh ? '太棒了 🎉' : 'Awesome 🎉'}
        </button>
      </div>
      <style>{`
        @keyframes popIn {
          0% { transform: scale(0.6); opacity: 0; }
          60% { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
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
