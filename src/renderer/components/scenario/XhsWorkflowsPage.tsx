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
    description_zh: '自动发现小红书图文爆款，AI 改写标题和内容，保存到本地并上传草稿箱。',
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

  const MAX_TASKS = 5;

  // Link-mode state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linksText, setLinksText] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  const validateLinks = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: i18nService.currentLanguage === 'zh' ? '至少粘贴 1 个链接' : 'Paste at least 1 URL' };
    if (lines.length > 3) return { ok: [], err: i18nService.currentLanguage === 'zh' ? '最多 3 个链接' : 'Max 3 URLs' };
    for (const l of lines) {
      if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
        return { ok: [], err: (i18nService.currentLanguage === 'zh' ? '不是小红书链接：' : 'Not an XHS link: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

  const handleLinkModeSubmit = async () => {
    if (linkSubmitting) return;
    const { ok, err } = validateLinks(linksText);
    if (err) { alert(err); return; }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    setLinkSubmitting(true);
    try {
      // 默认到 1 分钟后开始（由 scheduler 或手动 runTaskNow 触发）
      const now = new Date();
      const mm = String(now.getMinutes()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const task = await scenarioService.createTask({
        scenario_id: primaryScenario.id,
        track: 'link_mode',
        keywords: [],
        urls: ok,
        persona: '',
        daily_count: ok.length,
        variants_per_post: 1,
        daily_time: `${hh}:${mm}`,
        run_interval: 'once',
        enabled: true,
        active: true,
      } as any);
      setLinkModalOpen(false);
      setLinksText('');
      // 立即开跑
      await scenarioService.runTaskNow(task.id);
      onOpenTask(task.id);
    } catch (e) {
      alert((i18nService.currentLanguage === 'zh' ? '创建失败：' : 'Create failed: ') + String(e).slice(0, 120));
    } finally {
      setLinkSubmitting(false);
    }
  };

  const handleLinkModeClick = () => {
    if (tasks.length >= MAX_TASKS) {
      alert(i18nService.currentLanguage === 'zh' ? '最多创建 ' + MAX_TASKS + ' 个任务' : 'Max ' + MAX_TASKS + ' tasks allowed');
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    setLinkModalOpen(true);
  };

  const handleQuickStart = () => {
    // Gate: max 5 tasks
    if (tasks.length >= MAX_TASKS) {
      alert(i18nService.currentLanguage === 'zh' ? '最多创建 ' + MAX_TASKS + ' 个任务' : 'Max ' + MAX_TASKS + ' tasks allowed');
      return;
    }
    // Gate: must be logged in with wallet
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    // Show check modal first (extension + XHS tab + login)
    setLoginModalReason('quickstart');
  };

  const handleLoginConfirmed = () => {
    setLoginModalReason(null);
    // After checks pass, open wizard
    onConfigure(primaryScenario);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Two-card row: 批量仿写 (left) + 指定链接 (right) */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* LEFT: Batch rewrite (keyword) */}
        <div className="relative rounded-2xl border border-green-500/30 bg-gradient-to-br from-green-500/10 via-emerald-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-green-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-green-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {i18nService.t('scenarioWorkflowAvailable')}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              🔥 {i18nService.t('scenarioQuickStartTitle')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.t('scenarioQuickStartDesc')}
            </p>
            <button
              type="button"
              onClick={handleQuickStart}
              className="w-full px-6 py-3 text-sm font-bold rounded-xl bg-green-500 text-white hover:bg-green-600 shadow-lg shadow-green-500/25 transition-all active:scale-95"
            >
              {primaryTask
                ? '📋 ' + i18nService.t('scenarioQuickStartContinueBtn') + ' →'
                : '🚀 ' + i18nService.t('scenarioQuickStartBtn') + ' →'}
            </button>
          </div>
        </div>

        {/* RIGHT: Link mode */}
        <div className="relative rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 via-fuchsia-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-purple-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '按需定制' : 'Custom'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              🔗 {i18nService.t('scenarioLinkModeTitle')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.t('scenarioLinkModeDesc')}
            </p>
            <button
              type="button"
              onClick={handleLinkModeClick}
              className="w-full px-6 py-3 text-sm font-bold rounded-xl bg-purple-500 text-white hover:bg-purple-600 shadow-lg shadow-purple-500/25 transition-all active:scale-95"
            >
              🔗 {i18nService.t('scenarioLinkModeBtn')} →
            </button>
          </div>
        </div>
      </section>

      {/* Advantage pills (moved out of banner, cross both cards) */}
      <section className="mb-6 flex flex-wrap items-center gap-2">
        {[
          { icon: '🛡️', zh: '不封号', en: 'Safe' },
          { icon: '🤖', zh: '全自动', en: 'Auto' },
          { icon: '🚀', zh: '自动上传', en: 'Auto Upload' },
          { icon: '💰', zh: '省Token', en: 'Save Tokens' },
          { icon: '🌊', zh: '爆款池', en: 'Viral Pool' },
        ].map((p, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">
            {p.icon} {i18nService.currentLanguage === 'zh' ? p.zh : p.en}
          </span>
        ))}
      </section>

      {/* Link-mode modal */}
      {linkModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => !linkSubmitting && setLinkModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold dark:text-white mb-2">🔗 {i18nService.t('scenarioLinkModeTitle')}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">{i18nService.t('scenarioLinkModeHint')}</p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {i18nService.t('scenarioLinkModeLabel')}
            </label>
            <textarea
              value={linksText}
              onChange={e => setLinksText(e.target.value)}
              placeholder={i18nService.t('scenarioLinkModePlaceholder')}
              rows={5}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-none"
              disabled={linkSubmitting}
            />
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => !linkSubmitting && setLinkModalOpen(false)}
                disabled={linkSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {i18nService.currentLanguage === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleLinkModeSubmit}
                disabled={linkSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
              >
                {linkSubmitting
                  ? (i18nService.currentLanguage === 'zh' ? '创建中...' : 'Creating...')
                  : '🚀 ' + i18nService.t('scenarioLinkModeSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Platform tasks */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            📌 {i18nService.currentLanguage === 'zh' ? '仿写任务' : 'Rewrite Tasks'}
          </h2>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {i18nService.currentLanguage === 'zh' ? '同一平台最多同时运行一个任务' : 'One task per platform at a time'}
          </span>
        </div>
        {loading && tasks.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {i18nService.currentLanguage === 'zh' ? '加载中...' : 'Loading...'}
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
              // "已生成" 用 drafts 总数统计（包括 pending 和已上传的），反映 AI 产出量
              const generatedCount = taskDrafts.length;
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
                          {i18nService.currentLanguage === 'zh' ? '运行中' : 'Running'}
                        </span>
                      ) : task.active ? (
                        <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">
                          ⏰ {i18nService.currentLanguage === 'zh' ? '定时运行' : 'Scheduled'}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-800 text-gray-500">
                          {i18nService.currentLanguage === 'zh' ? '待命' : 'Standby'}
                        </span>
                      )}
                      {generatedCount > 0 && (
                        <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30">
                          {i18nService.currentLanguage === 'zh' ? '已生成 ' + generatedCount + ' 条' : 'Generated ' + generatedCount}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Config details */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    <div>{i18nService.currentLanguage === 'zh' ? '关键词' : 'Keywords'}: {task.keywords.join(' · ')}</div>
                    <div>⏰ {({ '30min': i18nService.currentLanguage === 'zh' ? '每30分钟' : 'Every 30min', '1h': i18nService.currentLanguage === 'zh' ? '每小时' : 'Hourly', '6h': i18nService.currentLanguage === 'zh' ? '每6小时' : 'Every 6h', 'daily': (i18nService.currentLanguage === 'zh' ? '每天 ' : 'Daily ') + (task.daily_time || '08:00') } as Record<string, string>)[(task as any).run_interval || 'daily'] || (i18nService.currentLanguage === 'zh' ? '每天 ' : 'Daily ') + (task.daily_time || '08:00')} · {task.daily_count} {i18nService.currentLanguage === 'zh' ? '条/次' : '/run'}</div>
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
