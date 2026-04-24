/**
 * BinanceWorkflowsPage — 币安广场 (Binance Square) 平台工作流页面.
 *
 * 结构镜像 XWorkflowsPage:
 *   - 卡片 grid (目前 2 张: 自动互动 + 自动发帖)
 *   - 底部特色 pills 条
 *   - 无 hero 介绍 (之前版本有,用户反馈冗余,与 X/XHS 页面对齐后去掉)
 *
 * v1 scenarios:
 *   binance_square_auto_engage   — 关注 KOL + 热门帖互动 (敬请期待)
 *   binance_square_post_creator  — 每日 1 条加密快评带 cashtag
 *
 * Card order 按用户要求: 自动互动/回复 放前面,发帖 放后面。
 */

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='binance' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  onGoToMyTasks?: () => void;
}

export const BinanceWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,
  loading,
  onOpenTask: _onOpenTask,
  onConfigure,
  onChanged: _onChanged,
  onGoToMyTasks,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);
  const [pendingScenario, setPendingScenario] = useState<Scenario | null>(null);

  const MAX_TASKS = 5;

  // Fallback so the card opens the wizard before backend list arrives.
  const POST_CREATOR_FALLBACK: Scenario = {
    id: 'binance_square_post_creator',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场自动发帖',
    name_en: 'Binance Square Auto Post',
    description_zh: '每日 AI 写一条 100-300 字加密快评,自动带 $TOKEN cashtag,发到币安广场。',
    description_en: 'Daily AI-drafted 100-300 char crypto market note, auto-tagged with $TOKEN cashtags, posted to Binance Square.',
    icon: '🔶',
    default_config: {
      keywords: ['BTC', 'ETH', 'SOL'],
      persona: '中文 web3 KOL,分享市场观察 / 链上数据 / 行业 alpha,语气克制、不喊单',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 0,
      min_scroll_delay_ms: 0, max_scroll_delay_ms: 0,
      read_dwell_min_ms: 0, read_dwell_max_ms: 0,
      max_run_duration_ms: 600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };

  const postCreator =
    scenarios.find(s => s.id === 'binance_square_post_creator')
    || scenarios.find(s => (s.platform as any) === 'binance' && s.workflow_type === 'viral_production')
    || POST_CREATOR_FALLBACK;

  // v2.4.59: auto_engage 也加 fallback,避免 backend scenarios 异步加载完成前
  // 卡片是 disabled 状态(用户反馈"开始互动按钮要等几秒才亮")。
  const AUTO_ENGAGE_FALLBACK: Scenario = {
    id: 'binance_square_auto_engage',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'auto_reply' as any,
    category: 'engagement',
    name_zh: '币安广场自动互动',
    name_en: 'Binance Square Auto Engagement',
    description_zh: '每次运行关注币安广场加密 KOL + 给热门帖写 AI 回复,动作间随机间隔。',
    description_en: 'Daily follow Binance Square crypto KOLs + AI-drafted replies to hot posts.',
    icon: '🤝',
    default_config: {
      keywords: [],
      persona: '中文 web3 用户,关注 BTC/ETH/链上数据/DeFi/Memecoin',
      daily_count: 2,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 1500, max_scroll_delay_ms: 3500,
      read_dwell_min_ms: 8000, read_dwell_max_ms: 18000,
      max_run_duration_ms: 7200000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const autoEngage =
    scenarios.find(s => s.id === 'binance_square_auto_engage')
    || AUTO_ENGAGE_FALLBACK;

  // v4.25+ 第 3 张卡:推特搬运。跨 X + 币安两个 tab 跑。
  const FROM_X_REPOST_FALLBACK: Scenario = {
    id: 'binance_from_x_repost',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · 推特搬运',
    name_en: 'Binance Square · Repost from X',
    description_zh: '从推特 feed 挑带图爆款,AI 改写成中文币安风格,原图一并上传,一键发到广场。运行期间占用 X + 币安两个标签页。',
    description_en: 'Pull viral image tweets from X, AI rewrite in Chinese Binance style, repost with original images. Locks both X + Binance tabs.',
    icon: '🔁',
    default_config: {
      keywords: [],
      persona: '中文 web3 KOL,搬运海外 alpha 并加上自己的锐评',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000, max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 10000, read_dwell_max_ms: 45000,
      max_run_duration_ms: 3600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const fromXRepost =
    scenarios.find(s => s.id === 'binance_from_x_repost')
    || FROM_X_REPOST_FALLBACK;

  // (previously we polled running task ids to drive the inline running-glow
  //  on the "已有任务" list. That list was removed — MyTasksPage is the
  //  single source of truth for running state now. No polling needed here.)

  const handleStart = (scenario: Scenario) => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    setPendingScenario(scenario);
    setLoginModalReason(scenario.id);
  };

  const handleLoginConfirmed = () => {
    setLoginModalReason(null);
    if (pendingScenario) {
      onConfigure(pendingScenario);
      setPendingScenario(null);
    }
  };

  const tasksByScenario: Record<string, Task[]> = {};
  for (const t of tasks) {
    const key = t.scenario_id;
    if (!tasksByScenario[key]) tasksByScenario[key] = [];
    tasksByScenario[key].push(t);
  }

  // Binance brand colors
  const binanceGold = '#F0B90B';
  const binanceGoldLight = '#FCD535';
  const binanceDark = '#181A20';

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario cards — same layout as X: jump straight to cards, no hero */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* 1. Auto engage (coming soon — backend scenario not yet built) */}
        <BinanceCard
          emoji="🤝"
          badgeZh="每日互动"
          badgeEn="Daily engagement"
          titleZh="币安广场自动互动"
          titleEn="Binance Square Auto Engagement"
          descZh="关注币安广场加密 KOL + 热门帖 AI 生成观点回复,每天 0-5 个动作随机打散,每个动作间 30 秒-10 分钟随机。"
          descEn="Follow Binance Square crypto KOLs + AI-drafted opinionated replies to hot posts. 0-5 actions/day, 30s-10min spacing."
          tagsLine={isZh ? '关注 · 回复 · 随机节奏' : 'Follow · Reply · Randomized pacing'}
          ctaZh={autoEngage ? '开始互动' : '敬请期待'}
          ctaEn={autoEngage ? 'Start' : 'Coming Soon'}
          enabled={!!autoEngage}
          loading={loading}
          scenario={autoEngage}
          onStart={() => autoEngage && handleStart(autoEngage)}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />

        {/* 2. Post creator */}
        <BinanceCard
          emoji="📊"
          badgeZh="每日发帖"
          badgeEn="Daily post"
          titleZh="币安广场自动发帖"
          titleEn="Binance Square Auto Post"
          descZh="AI 从你的 token 列表里随机挑一个,按你的人设写一条 100-300 字短评,自动带 $BTC 等 cashtag 触发 token 页流量。"
          descEn="AI picks a token from your watchlist, drafts a 100-300 char note in your persona, posts with $TICKER cashtags to trigger token-page traffic."
          tagsLine="$BTC · $ETH · $SOL · $BNB"
          ctaZh="立即开始"
          ctaEn="Get Started"
          enabled={true}
          loading={loading}
          scenario={postCreator}
          onStart={() => handleStart(postCreator)}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />

        {/* 3. Repost from X — v4.25+ 新卡 */}
        <BinanceCard
          emoji="🔁"
          badgeZh="推特搬运"
          badgeEn="X repost"
          titleZh="币安广场 · 推特搬运"
          titleEn="Binance Square · Repost from X"
          descZh="从推特 feed 挑带图爆款,AI 改写成中文币安风格,原图一并上传。⚠️ 运行期间占用推特 + 币安两个标签页,开跑前需双平台都登录。"
          descEn="Pull viral image tweets from X, AI rewrite in Chinese Binance style, repost with original images. ⚠️ Locks both X + Binance tabs while running."
          tagsLine={isZh ? '跨平台搬运 · 带图 · 双 tab 校验' : 'Cross-platform · With images · Dual-tab check'}
          ctaZh="立即开始"
          ctaEn="Get Started"
          enabled={true}
          loading={loading}
          scenario={fromXRepost}
          onStart={() => handleStart(fromXRepost)}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />
      </section>

      {/* Features pills — same compact design as X page */}
      <section className="mb-6">
        <div className="flex flex-wrap gap-2">
          {[
            { icon: '💎', zh: '原生 cashtag 导流', en: 'Native cashtag → token page traffic' },
            { icon: '💰', zh: '成本超低', en: 'Ultra-low cost' },
            { icon: '🛡️', zh: '严风控（每日动作上限 + 周休）', en: 'Strict caps (daily limits + weekly rest)' },
            { icon: '🎲', zh: '随机节奏（动作间 30 秒-10 分钟随机）', en: 'Randomized pacing (30s-10min between actions)' },
            { icon: '🤝', zh: '加密 KOL 池', en: 'Crypto KOL pool' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border text-gray-700 dark:text-gray-300"
              style={{
                borderColor: `${binanceGold}30`,
                background: `${binanceGold}10`,
              }}
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* "已有任务" 区块去掉 — 用户反馈底部冗余,我的任务 tab 已经有完整列表。
          Per X/XHS pages 也都没有这个区块,统一掉。 */}

      {/* Login gate — binance platform opens binance.com/square */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="binance"
          onCancel={() => { setLoginModalReason(null); setPendingScenario(null); }}
          onConfirmed={handleLoginConfirmed}
        />
      )}

      {/* Max-tasks modal */}
      {maxTasksModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setMaxTasksModalOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-2 text-center">
              <div className="text-4xl mb-3">📋</div>
              <h3 className="text-lg font-bold dark:text-white mb-1.5">
                {isZh ? '已达任务上限' : 'Task Limit Reached'}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                {isZh
                  ? `币安广场已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Binance Square tasks (max ${MAX_TASKS}).`}
                <br />
                {isZh
                  ? '可以先去看看现有任务,停用一些不需要的,再创建新的。'
                  : 'Open My Tasks to disable any you no longer need before creating a new one.'}
              </p>
            </div>
            <div className="px-6 py-4 flex gap-2">
              <button
                type="button"
                onClick={() => setMaxTasksModalOpen(false)}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                {isZh ? '知道了' : 'Got it'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMaxTasksModalOpen(false);
                  if (onGoToMyTasks) onGoToMyTasks();
                }}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


// ── Binance scenario card sub-component ──

interface BinanceCardProps {
  emoji: string;
  badgeZh: string;
  badgeEn: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  tagsLine: string;
  ctaZh: string;
  ctaEn: string;
  enabled: boolean;
  loading: boolean;
  scenario: Scenario | null;
  onStart: () => void;
  isZh: boolean;
  binanceGold: string;
  binanceGoldLight: string;
  binanceDark: string;
}

const BinanceCard: React.FC<BinanceCardProps> = ({
  emoji, badgeZh, badgeEn, titleZh, titleEn, descZh, descEn, tagsLine,
  ctaZh, ctaEn, enabled, loading, scenario, onStart, isZh,
  binanceGold, binanceGoldLight, binanceDark,
}) => {
  const dim = !enabled;
  return (
    <div
      className="relative rounded-2xl p-6 overflow-hidden border transition-all hover:shadow-2xl"
      style={{
        background: dim
          ? `linear-gradient(135deg, ${binanceDark}80 0%, #1E202680 100%)`
          : `linear-gradient(135deg, ${binanceDark} 0%, #1E2026 100%)`,
        borderColor: dim ? '#2B3139' : `${binanceGold}30`,
      }}>
      <div
        className="absolute -top-12 -right-12 w-36 h-36 rounded-full pointer-events-none"
        style={{ background: `radial-gradient(circle, ${binanceGold}${dim ? '08' : '15'} 0%, transparent 70%)` }}
      />
      <div className={`relative flex flex-col h-full ${dim ? 'opacity-60' : ''}`}>
        <div className="inline-flex items-center gap-1.5 text-xs font-medium mb-2" style={{ color: binanceGoldLight }}>
          <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: binanceGoldLight }} />
          {isZh ? badgeZh : badgeEn}
        </div>
        <h3 className="text-lg font-bold text-white mb-1.5">
          {emoji} {isZh ? titleZh : titleEn}
        </h3>
        <p className="text-sm text-gray-400 leading-relaxed mb-3 flex-1">
          {isZh ? descZh : descEn}
        </p>
        <div className="text-xs font-mono mb-4" style={{ color: binanceGold }}>
          {tagsLine}
        </div>
        <button
          type="button"
          onClick={onStart}
          disabled={!enabled || loading || !scenario}
          className="w-full text-sm font-semibold px-4 py-2.5 rounded-xl transition-all hover:brightness-110 active:brightness-95 shadow-md disabled:cursor-not-allowed disabled:hover:brightness-100"
          style={enabled
            ? {
                background: `linear-gradient(135deg, ${binanceGold} 0%, ${binanceGoldLight} 100%)`,
                color: binanceDark,
              }
            : {
                background: '#2B3139',
                color: '#6B7280',
              }}>
          {emoji} {isZh ? ctaZh : ctaEn} {enabled ? '→' : ''}
        </button>
      </div>
    </div>
  );
};

export default BinanceWorkflowsPage;
