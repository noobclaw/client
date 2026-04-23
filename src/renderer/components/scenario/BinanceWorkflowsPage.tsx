/**
 * BinanceWorkflowsPage — 币安广场 (Binance Square) 平台工作流页面.
 *
 * v1 只有一个 scenario：binance_square_post_creator
 *   - 每日 1 条原创短帖（100-300 字）
 *   - 用户提供 token 列表 + persona + 语言模式
 *   - AI 按抽中的钩子写文 → 自动写入 ProseMirror 编辑器 → 点击发文
 *
 * 形态最像 x_post_creator（参见 XWorkflowsPage 中段）：纯文本、单帖、
 * 不依赖 feed 抓取。Binance Square 的发帖入口是 /square 主页内嵌的
 * ProseMirror 弹窗，所以不需要"指定链接"那种 quick-link 模式。
 */

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
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
  loading: _loading,
  onOpenTask,
  onConfigure,
  onChanged: _onChanged,
  onGoToMyTasks,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);

  const MAX_TASKS = 5;

  // Fallback so the card opens the wizard before backend list arrives.
  // Same shape used by XhsWorkflowsPage / XWorkflowsPage.
  const FALLBACK: Scenario = {
    id: 'binance_square_post_creator',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场自动发帖',
    name_en: 'Binance Square Auto Post',
    description_zh: '每日 AI 写一条 100-300 字加密快评，自动带 $TOKEN cashtag，发到币安广场。',
    description_en: 'Daily AI-drafted 100-300 char crypto market note, auto-tagged with $TOKEN cashtags, posted to Binance Square.',
    icon: '📊',
    default_config: {
      keywords: ['BTC', 'ETH', 'SOL'],
      persona: '中文 web3 KOL，分享市场观察 / 链上数据 / 行业 alpha，语气克制、不喊单',
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
    required_login_url: 'https://www.binance.com/zh-CN/square',
    entry_urls: {},
    skills: {},
  };

  const postCreator =
    scenarios.find(s => s.id === 'binance_square_post_creator')
    || scenarios.find(s => (s.platform as any) === 'binance' && s.workflow_type === 'viral_production')
    || FALLBACK;

  // Poll running task ids — same UX as X/XHS pages so the "运行中..." pill
  // stays accurate across the whole tab.
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const ids = await scenarioService.getRunningTaskIds();
        if (!cancelled) setRunningTaskIds(new Set(ids));
      } catch {}
    };
    void pull();
    const h = setInterval(pull, 5000);
    return () => { cancelled = true; clearInterval(h); };
  }, []);

  const handleStart = () => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    setLoginModalReason('post_creator');
  };

  const handleLoginConfirmed = () => {
    setLoginModalReason(null);
    onConfigure(postCreator);
  };

  const myPostCreatorTasks = tasks.filter(t => t.scenario_id === postCreator.id);

  // Binance brand colors hard-coded so we don't rely on Tailwind to match
  // the exact gold tone used on binance.com (their gold is #F0B90B; the
  // closest Tailwind yellow-500 is #EAB308 which reads slightly green next
  // to the real brand). Dark card surface mirrors Binance's #181A20.
  const binanceGold = '#F0B90B';
  const binanceGoldLight = '#FCD535';
  const binanceDark = '#181A20';

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Hero — Binance-style: dark surface, gold diamond mark, gold rule */}
      <section className="mb-6">
        <div
          className="rounded-2xl p-6 overflow-hidden relative border"
          style={{
            background: `linear-gradient(135deg, ${binanceDark} 0%, #1E2026 100%)`,
            borderColor: `${binanceGold}40`,
            boxShadow: `0 0 40px -20px ${binanceGold}40`,
          }}>
          <div
            className="absolute -top-20 -right-20 w-48 h-48 rounded-full pointer-events-none"
            style={{ background: `radial-gradient(circle, ${binanceGold}20 0%, transparent 70%)` }}
          />
          <div className="relative flex items-center gap-3">
            {/* Binance lattice diamond mark — pure CSS to avoid shipping a logo */}
            <div
              className="shrink-0 w-12 h-12 flex items-center justify-center rounded-lg"
              style={{ background: `${binanceGold}15`, border: `1px solid ${binanceGold}40` }}>
              <svg viewBox="0 0 32 32" className="w-7 h-7" fill={binanceGold}>
                <path d="M9.6 12.4L16 6l6.4 6.4L26 8.8 16 -1.2 6 8.8l3.6 3.6zM2 16l3.6-3.6L9.2 16l-3.6 3.6L2 16zm7.6 3.6L16 26l6.4-6.4 3.6 3.6L16 33.2 6 23.2l3.6-3.6zM22.8 16l3.6-3.6L30 16l-3.6 3.6-3.6-3.6zM19.6 16L16 12.4 12.4 16 16 19.6 19.6 16z"/>
              </svg>
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-bold text-white mb-1 flex items-center gap-2">
                {isZh ? '币安广场自动化运营' : 'Binance Square Automation'}
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                  style={{ background: binanceGold, color: binanceDark }}>
                  BETA
                </span>
              </h2>
              <p className="text-sm text-gray-400">
                {isZh
                  ? '让 AI 用你的口吻每天在币安广场发一条加密快评，自动带 cashtag 触发 token 页流量。'
                  : 'AI posts one daily crypto note in your voice on Binance Square, auto-tagged with cashtags to surface on token pages.'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Single scenario card — Binance-style dark with gold accents */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          className="relative rounded-2xl p-6 overflow-hidden border transition-all hover:shadow-2xl"
          style={{
            background: `linear-gradient(135deg, ${binanceDark} 0%, #1E2026 100%)`,
            borderColor: `${binanceGold}30`,
          }}>
          <div
            className="absolute -top-12 -right-12 w-36 h-36 rounded-full pointer-events-none"
            style={{ background: `radial-gradient(circle, ${binanceGold}15 0%, transparent 70%)` }}
          />
          <div className="relative flex flex-col h-full">
            <div className="flex items-start gap-3 mb-3">
              <div className="text-3xl shrink-0">📊</div>
              <div>
                <h3 className="text-lg font-bold text-white">
                  {isZh ? '每日自动发帖' : 'Daily Auto Post'}
                </h3>
                <p className="text-xs mt-0.5" style={{ color: binanceGoldLight }}>
                  {isZh ? '1 条 / 天 · 100-300 字 · 自动 cashtag' : '1 post/day · 100-300 chars · auto cashtag'}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-4 flex-1">
              {isZh
                ? 'AI 从你的 token 列表里随机挑一个，按你的人设写一条短评，发到 Binance Square。带 $BTC 等 cashtag 自动触发 token 页流量入口。'
                : 'AI picks a token from your watchlist, drafts a short note in your persona, posts to Binance Square. $TICKER cashtags trigger token-page traffic.'}
            </p>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {(['BTC', 'ETH', 'SOL', 'BNB'] as const).map(tag => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 rounded-full font-mono font-semibold"
                  style={{
                    background: `${binanceGold}15`,
                    color: binanceGold,
                    border: `1px solid ${binanceGold}30`,
                  }}>
                  ${tag}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={handleStart}
              className="w-full text-sm font-semibold px-4 py-2.5 rounded-xl transition-all hover:brightness-110 active:brightness-95 shadow-md"
              style={{
                background: `linear-gradient(135deg, ${binanceGold} 0%, ${binanceGoldLight} 100%)`,
                color: binanceDark,
              }}>
              {isZh ? '⚡ 立即开始' : '⚡ Get Started'}
            </button>
          </div>
        </div>

        {/* Placeholder card for future scenarios — same dark Binance look but dim */}
        <div
          className="relative rounded-2xl p-6 overflow-hidden border"
          style={{
            background: `linear-gradient(135deg, ${binanceDark}80 0%, #1E202680 100%)`,
            borderColor: '#2B3139',
          }}>
          <div className="relative flex flex-col h-full opacity-50">
            <div className="flex items-start gap-3 mb-3">
              <div className="text-3xl shrink-0">🔥</div>
              <div>
                <h3 className="text-lg font-bold text-white">
                  {isZh ? '热点引用回应' : 'Hot Topic Quote Reply'}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {isZh ? '即将上线' : 'Coming soon'}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-4 flex-1">
              {isZh
                ? '抓 Square 热门帖，AI 生成有观点的引用回应。'
                : 'Scan trending posts, AI drafts opinionated quote replies.'}
            </p>
            <button
              type="button"
              disabled
              className="w-full text-sm font-semibold px-4 py-2.5 rounded-xl bg-gray-700/50 text-gray-500 cursor-not-allowed">
              {isZh ? '敬请期待' : 'Coming Soon'}
            </button>
          </div>
        </div>
      </section>

      {/* "已有任务" 提示 */}
      {myPostCreatorTasks.length > 0 && (
        <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/50 dark:bg-gray-900/50 p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            {isZh ? '你已经有 ' + myPostCreatorTasks.length + ' 个币安广场任务在跑：' : 'You have ' + myPostCreatorTasks.length + ' Binance Square task(s):'}
          </div>
          <div className="space-y-2">
            {myPostCreatorTasks.slice(0, 3).map(task => (
              <button
                key={task.id}
                type="button"
                onClick={() => onOpenTask(task.id, 'create')}
                className="w-full text-left rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-yellow-500/5 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base">📊</span>
                    <span className="text-sm font-medium dark:text-white truncate">
                      {(task.keywords || []).slice(0, 4).map(k => '$' + String(k).replace(/^\$/, '')).join(' ') || (isZh ? '币安广场任务' : 'Binance Square task')}
                    </span>
                  </div>
                  {runningTaskIds.has(task.id) && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/30 shrink-0">
                      {isZh ? '运行中' : 'Running'}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Login gate */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={handleLoginConfirmed}
        />
      )}

      {/* Max-tasks modal — same pattern as XHS */}
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
                  ? '可以先去看看现有任务，停用一些不需要的，再创建新的。'
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

export default BinanceWorkflowsPage;
