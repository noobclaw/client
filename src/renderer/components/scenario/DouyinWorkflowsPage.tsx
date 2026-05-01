/**
 * DouyinWorkflowsPage — 抖音平台工作流页面.
 *
 * v1 只挂一个 scenario:
 *   douyin_auto_engage — 自动浏览精选 / 推荐流,按用户配置做点赞 / 关注 / 评论
 *
 * 结构跟 TikTokWorkflowsPage 完全对齐,字段隔离 (主色由粉改红,login 走 douyin)
 * — TikTok 的卡片 / 任务上限 / login modal 流程都直接复用,只是平台不同。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='douyin' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  /** Jump to "My Tasks" filtered to Douyin — used by 已达上限 modal CTA. */
  onGoToMyTasks?: () => void;
}

export const DouyinWorkflowsPage: React.FC<Props> = ({
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
  const [, setRunningTaskIds] = useState<Set<string>>(new Set());

  // 同平台任务上限 5 个 — 跟 X / Binance / XHS / YouTube / TikTok 对齐。
  const MAX_TASKS = 5;
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);

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

  const findById = (id: string): Scenario | null =>
    scenarios.find(s => s.id === id) || null;

  // Fallback 让卡片在 scenario 列表还没拉到时也能点开 wizard
  const FALLBACK_AUTO_ENGAGE: Scenario = {
    id: 'douyin_auto_engage',
    version: '1.0.0',
    platform: 'douyin' as any,
    workflow_type: 'auto_reply' as any,
    category: 'engagement',
    name_zh: '抖音 · 互动涨粉',
    name_en: 'Douyin Engage & Grow',
    description_zh: '每天定时刷抖音精选 / 推荐流，挑出若干视频按你配置的组合做点赞 / 关注 / 评论。三项动作可独立开关，评论由 AI 按视频文案与置顶评论自动生成，行为间隔随机模拟真人。',
    description_en: 'Browses Douyin Jingxuan / Recommend feed on schedule, picks videos and runs your configured mix of like / follow / comment. Each action toggles independently; comments are AI-generated from caption + top comments.',
    icon: '🎶',
    default_config: {
      keywords: [],
      persona: '对短视频感兴趣的普通观众，评论自然口语，不爹味、不拍马屁',
      daily_count: 5,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1,
      max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000,
      max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 12000,
      read_dwell_max_ms: 45000,
      max_run_duration_ms: 7200000,
      min_interval_hours: 24,
      weekly_rest_days: 1,
      cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48,
      cooldown_account_flag_hours: 72,
    } as any,
    required_login_url: 'https://www.douyin.com',
    entry_urls: {},
    skills: {},
  } as any;

  const autoEngage = findById('douyin_auto_engage') || FALLBACK_AUTO_ENGAGE;

  const handleConfigure = useCallback(async (scenario: Scenario | null) => {
    if (!scenario) {
      alert(isZh ? '场景元数据还在加载中，请稍后再试' : 'Scenario metadata still loading');
      return;
    }
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    // 先弹登录检查 modal,确认浏览器 + 抖音标签 + 登录都通过再进 wizard
    setLoginModalReason(scenario.id);
  }, [isZh, tasks.length]);

  const handleLoginConfirmed = () => {
    const reason = loginModalReason;
    setLoginModalReason(null);
    if (reason === 'douyin_auto_engage') {
      onConfigure(autoEngage);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Single scenario card. 用 max-w-3xl 让单卡片不被拉到全宽,跟
          TikTokWorkflowsPage / YoutubeWorkflowsPage 视觉一致。 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto">
        <DouyinScenarioCard
          loading={loading}
          scenario={autoEngage}
          onConfigure={() => handleConfigure(autoEngage)}
          isZh={isZh}
        />
      </section>

      {/* Feature pills */}
      <section className="mb-6">
        <div className="flex flex-wrap gap-2 justify-center">
          {[
            { icon: '👍', zh: '点赞 / 关注 / 评论 三项可独立开关', en: 'Like / follow / comment toggles each independent' },
            { icon: '💬', zh: 'AI 评论按视频文案 + 置顶评论自动生成,默认中文', en: 'AI comments from caption + top comments (default Chinese)' },
            { icon: '🛡️', zh: '严风控 — 行为间隔随机 + 每日上限', en: 'Strict anti-detection — randomized intervals + daily caps' },
            { icon: '⏰', zh: '到点自动 / 也可手动触发', en: 'Schedule-driven or manual trigger' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-violet-500/20 bg-violet-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* Login modal */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="douyin"
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={handleLoginConfirmed}
        />
      )}

      {/* Task limit modal */}
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
                  ? `抖音已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Douyin tasks (max ${MAX_TASKS}).`}
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
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-violet-500 to-purple-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Scenario card sub-component ─────────────────────────────────────

type CardProps = {
  loading: boolean;
  scenario: Scenario | null;
  onConfigure: () => void;
  isZh: boolean;
};

const DouyinScenarioCard: React.FC<CardProps> = ({ loading, scenario, onConfigure, isZh }) => {
  return (
    <div className="relative rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-purple-500/5 to-transparent p-5 overflow-hidden flex flex-col md:col-span-2">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
          {isZh ? '互动涨粉' : 'Engage & Grow'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          🎶 {isZh ? '抖音 · 互动涨粉' : 'Douyin Engage & Grow'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '每天定时刷抖音精选 / 推荐流，挑出若干视频按你配置的组合做点赞 / 关注 / 评论。三项动作可独立开关，评论由 AI 按视频文案与置顶评论自动生成，行为间隔随机模拟真人。'
            : 'Browses Douyin Jingxuan / Recommend feed on schedule, picks videos and runs your configured mix of like / follow / comment. Each action toggles independently; comments are AI-generated from caption + top comments.'}
        </p>
        <button
          type="button"
          onClick={onConfigure}
          disabled={loading || !scenario}
          className="w-full px-4 py-2.5 text-sm font-bold rounded-xl bg-violet-500 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg shadow-violet-500/25 transition-all active:scale-95"
        >
          🎶 {isZh ? '开始互动' : 'Start'} →
        </button>
      </div>
    </div>
  );
};
