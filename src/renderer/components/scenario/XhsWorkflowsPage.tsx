/**
 * XhsWorkflowsPage — layer 1 inside 小红书 tab.
 *
 * Sections (top-down):
 *   1. Quick-start banner for 爆款仿写 (one-click with login gate)
 *   2. NoobClaw 5 advantages hero (moved from the old WorkflowDetailPage)
 *   3. "My tasks" list (collapsed card per task)
 *   4. Workflow-type grid (爆款仿写 active, 4 coming soon)
 *
 * The top banner is the "一键按钮" users were looking for. It:
 *   - Checks XHS login via scenarioService.checkXhsLogin
 *   - Shows LoginRequiredModal if not logged in
 *   - If no task yet, opens the config wizard for the first available
 *     xhs_viral_production scenario
 *   - If a task already exists, jumps straight to its task detail page
 */

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';

// Lightweight track lookup for task card display (full presets live in ConfigWizard)
const TRACK_PRESETS: Array<{ id: string; icon: string; name_zh: string }> = [
  { id: 'career_side_hustle', icon: '💼', name_zh: '副业 · 打工人赚钱' },
  { id: 'indie_dev', icon: '👩‍💻', name_zh: '独立开发 · 程序员记录' },
  { id: 'personal_finance', icon: '💰', name_zh: '理财 · 记账攻略' },
  { id: 'travel', icon: '✈️', name_zh: '旅行 · 攻略分享' },
  { id: 'food', icon: '🍲', name_zh: '美食 · 探店做饭' },
  { id: 'outfit', icon: '👗', name_zh: '穿搭 · 风格分享' },
  { id: 'beauty', icon: '💄', name_zh: '美妆 · 产品测评' },
  { id: 'fitness', icon: '💪', name_zh: '健身 · 减脂日记' },
  { id: 'reading', icon: '📚', name_zh: '读书 · 书单笔记' },
  { id: 'parenting', icon: '🧸', name_zh: '育儿 · 亲子日常' },
  { id: 'exam_prep', icon: '🎓', name_zh: '考研 · 备考党' },
  { id: 'pets', icon: '🐱', name_zh: '宠物 · 猫狗日常' },
  { id: 'home_decor', icon: '🏠', name_zh: '家居 · 小屋布置' },
  { id: 'study_method', icon: '🏆', name_zh: '学习 · 效率工具' },
  { id: 'career_growth', icon: '🎯', name_zh: '职场 · 升级打怪' },
  { id: 'emotional_wellness', icon: '🧘', name_zh: '情感 · 心理疗愈' },
  { id: 'photography', icon: '📷', name_zh: '摄影 · 日常记录' },
  { id: 'crafts', icon: '🎨', name_zh: '手工 · DIY' },
];

type WorkflowDef = {
  id: string;
  icon: string;
  titleKey: string;
  descKey: string;
  available: boolean;
};

// @ts-ignore — Future workflow types, kept for when auto_reply / mass_comment ship.
const _WORKFLOWS: WorkflowDef[] = [ // eslint-disable-line
  { id: 'viral_production', icon: '🔥', titleKey: 'scenarioWorkflowViral', descKey: 'scenarioWorkflowViralDesc', available: true },
  { id: 'auto_reply', icon: '💬', titleKey: 'scenarioWorkflowAutoReply', descKey: 'scenarioWorkflowAutoReplyDesc', available: false },
  { id: 'mass_comment', icon: '🎯', titleKey: 'scenarioWorkflowMassComment', descKey: 'scenarioWorkflowMassCommentDesc', available: false },
  { id: 'dm_reply', icon: '📬', titleKey: 'scenarioWorkflowDmReply', descKey: 'scenarioWorkflowDmRelyDesc', available: false },
  { id: 'data_monitor', icon: '📈', titleKey: 'scenarioWorkflowDataMonitor', descKey: 'scenarioWorkflowDataMonitorDesc', available: false },
];

// Advantage pills are now inline in the banner — no separate const needed.

interface Props {
  scenarios: Scenario[];
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  // onOpenWorkflow removed — no intermediate workflow detail page
  onOpenTask: (task_id: string) => void;
  onConfigure: (scenario: Scenario) => void;
}

export const XhsWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask,
  loading,
  // onOpenWorkflow — unused until auto_reply / mass_comment ship
  onOpenTask,
  onConfigure,
}) => {
  const scenarioById = new Map(scenarios.map(s => [s.id, s]));
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  // Track which task is actually running right now (not just scheduled).
  // We poll once on mount and every 5s so the badge shows "运行中" when
  // a job is in progress, vs "定时运行" when it's just armed.
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  useEffect(() => {
    const poll = () => {
      scenarioService.getRunningTaskId().then(id => setRunningTaskId(id || null)).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  // Find the default viral-production scenario. If the backend scenario list
  // hasn't loaded yet, use a hardcoded fallback so the "立即开始" button
  // ALWAYS opens the config wizard — never navigates to an empty sub-page.
  const FALLBACK_SCENARIO: Scenario = {
    id: 'xhs_viral_production_career',
    version: '1.0.0',
    platform: 'xhs',
    workflow_type: 'viral_production',
    category: 'knowledge',
    name_zh: '副业干货',
    name_en: 'Side Hustle Notes',
    description_zh: '自动发现小红书副业图文爆款，本地 AI 拆解后用你的 persona 生成仿写。',
    description_en: 'Discover viral side-hustle image notes on Xiaohongshu.',
    icon: '💼',
    default_config: {
      keywords: ['副业', '下班赚钱', '兼职', '月入'],
      persona: '一个想在下班后搞点副业的普通打工人，真诚不装',
      daily_count: 3,
      variants_per_post: 3,
      schedule_window: '08:00-09:00',
    },
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 20,
      min_scroll_delay_ms: 1800, max_scroll_delay_ms: 4200,
      read_dwell_min_ms: 2500, read_dwell_max_ms: 5500,
      max_run_duration_ms: 720000, min_interval_hours: 8,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.xiaohongshu.com',
    entry_urls: {},
    skills: {},
  };

  const primaryScenario = scenarios.find(
    s => s.platform === 'xhs' && s.workflow_type === 'viral_production'
  ) || FALLBACK_SCENARIO;

  const primaryTask = tasks.find(t => t.scenario_id === primaryScenario.id);

  const handleQuickStart = () => {
    // Gate: must be logged in with wallet
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    // Always open wizard to create a new task (not jump to existing)
    onConfigure(primaryScenario);
  };

  const handleLoginConfirmed = () => {
    setLoginModalReason(null);
    handleQuickStart();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Quick-start banner with advantage pills inside */}
      <section className="mb-6">
        <div className="relative rounded-2xl border border-green-500/30 bg-gradient-to-br from-green-500/10 via-emerald-500/5 to-transparent p-6 sm:p-8 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-green-500/10 blur-3xl pointer-events-none" />
          <div className="relative">
            <div className="flex items-center justify-between gap-6 flex-wrap mb-4">
              <div className="flex-1 min-w-0">
                <div className="inline-flex items-center gap-1.5 text-xs font-medium text-green-500 mb-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  {i18nService.t('scenarioWorkflowAvailable')}
                </div>
                <h2 className="text-xl sm:text-2xl font-bold dark:text-white mb-1.5">
                  🔥 {i18nService.t('scenarioQuickStartTitle')}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300 max-w-2xl leading-relaxed">
                  {i18nService.t('scenarioQuickStartDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={handleQuickStart}
                className="shrink-0 px-8 py-4 text-base font-bold rounded-xl bg-green-500 text-white hover:bg-green-600 shadow-lg shadow-green-500/25 transition-all active:scale-95"
              >
                {primaryTask
                  ? '📋 ' + i18nService.t('scenarioQuickStartContinueBtn') + ' →'
                  : '🚀 ' + i18nService.t('scenarioQuickStartBtn') + ' →'}
              </button>
            </div>
            {/* Advantage pills inside the banner */}
            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-green-500/10">
              <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">🛡️ 不封号</span>
              <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">🤖 全自动生成</span>
              <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">🚀 自动上传</span>
              <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">💰 Token省10倍</span>
              <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">🌊 爆款池</span>
            </div>
          </div>
        </div>
      </section>

      {/* Platform tasks */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            📌 小红书任务
          </h2>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            同一平台最多同时运行一个任务
          </span>
        </div>
        {loading && tasks.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {i18nService.t('scenarioSectionNoTasks')}
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map(task => {
              const scenario = scenarioById.get(task.scenario_id);
              const taskDrafts = draftsByTask.get(task.id) || [];
              const pendingCount = taskDrafts.filter(d => d.status === 'pending').length;
              const trackPreset = TRACK_PRESETS.find(t => t.id === task.track);
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenTask(task.id)}
                  className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 hover:border-green-500/50 dark:hover:border-green-500/50 bg-white dark:bg-gray-900 p-4 transition-colors"
                >
                  {/* Top row: track + ID + status badge */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{trackPreset?.icon || scenario?.icon || '🔥'}</span>
                      <span className="font-medium dark:text-white">
                        {trackPreset?.name_zh || task.track || scenario?.name_zh || task.scenario_id}
                      </span>
                      <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono">
                        #{task.id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {runningTaskId === task.id ? (
                        <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          运行中
                        </span>
                      ) : task.active ? (
                        <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">
                          ⏰ 定时运行
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-800 text-gray-500">
                          待命
                        </span>
                      )}
                      {pendingCount > 0 && (
                        <span className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-500 border border-amber-500/30">
                          {pendingCount} 条待审
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Config details */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    <div>关键词: {task.keywords.join(' · ')}</div>
                    <div className="truncate">Persona: {task.persona}</div>
                    <div>⏰ {({ '30min': '每30分钟', '1h': '每小时', '6h': '每6小时', 'daily': '每天 ' + (task.daily_time || '08:00') } as Record<string, string>)[(task as any).run_interval || 'daily'] || '每天 ' + (task.daily_time || '08:00')} · {task.daily_count} 条/次 · {task.variants_per_post} 份改写</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Future workflow types — hidden for now (only 爆款仿写 is live,
          and it's already represented by the quick-start banner above).
          Will be re-enabled when auto_reply / mass_comment ship. */}

      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={handleLoginConfirmed}
        />
      )}
    </div>
  );
};

export default XhsWorkflowsPage;
