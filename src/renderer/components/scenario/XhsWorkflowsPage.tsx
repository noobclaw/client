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

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';

// Lightweight track lookup for task card display (full presets live in ConfigWizard)
// @ts-ignore — kept inline so future card layouts can reference it without re-importing
const _TRACK_PRESETS: Array<{ id: string; icon: string; name_zh: string }> = [ // eslint-disable-line
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
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  /** Called after a new task is created (e.g. link-mode submit)
   *  so parent can refresh its tasks[] list before routing to detail. */
  onChanged?: () => void | Promise<void>;
  /** Open the standalone sensitive-word check page (no scenario, no task). */
  onOpenSensitiveCheck?: () => void;
}

export const XhsWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,
  loading: _loading,
  // onOpenWorkflow — unused until auto_reply / mass_comment ship
  onOpenTask,
  onConfigure,
  onChanged,
  onOpenSensitiveCheck,
}) => {
  // @ts-ignore — Pre-create-only refactor used scenarioById to look up
  // each task's scenario when rendering the task list. Tasks moved out
  // (now in MyTasksPage), but the wizard helpers might still need this.
  const _scenarioById = new Map(scenarios.map(s => [s.id, s])); // eslint-disable-line
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  // (Task list moved to its own top-level "我的任务" page in v2.4.20+.
  //  This page is now creation-only — no task polling needed here.)

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

  // Auto-reply scenario lookup (Plan B). Fallback id matches the scenario
  // folder name on the backend so the wizard can boot before the scenarios
  // list arrives over network.
  const AUTO_REPLY_FALLBACK: Scenario = {
    ...FALLBACK_SCENARIO,
    id: 'xhs_auto_reply_universal',
    workflow_type: 'auto_reply' as any,
    name_zh: '小红书自动互动',
    name_en: 'XHS Auto Engage',
    description_zh: '按关键词找文章，AI 生成评论+用户回复，30-80 秒间隔安全发布。每次还会按 0~30% 概率关注作者。',
    description_en: 'Find articles by keyword, AI-reply + reply to comments, post on safe jitter. Optionally follow the author (0-30% chance).',
    icon: '💬',
    default_config: {
      keywords: ['副业', '兼职', '下班赚钱'],
      persona: '一个热心、有共鸣感的同行',
      daily_count: 6,
      schedule_window: '10:00-11:30',
    } as any,
  };
  const autoReplyScenario = scenarios.find(
    s => s.platform === 'xhs' && (s.workflow_type as any) === 'auto_reply'
  ) || AUTO_REPLY_FALLBACK;
  // (autoReplyTask lookup removed v2.4.27 — card always opens wizard for
  //  a NEW task instead of resuming an existing one. Kept the scenario
  //  lookup above since the wizard still needs the scenario reference.)

  const MAX_TASKS = 5;

  // Link-mode state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linksText, setLinksText] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkAutoUpload, setLinkAutoUpload] = useState(true);

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
        auto_upload: linkAutoUpload,
      } as any);
      setLinkModalOpen(false);
      setLinksText('');
      // 先 refresh 父组件 tasks[]，否则跳转后 TaskDetailPage.tasks.find() 找不到新任务显示"无任务"
      if (onChanged) { await onChanged(); }
      // 然后跳转详情 + 异步触发运行。fromOverride='tasks' 让用户点返回时
      // 回到「我的自动化运营任务」列表，而不是回到刚交完的快速创建 modal。
      onOpenTask(task.id, 'tasks');
      scenarioService.runTaskNow(task.id).catch((e) => {
        console.error('[LinkMode] runTaskNow failed:', e);
      });
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
    // Same pre-check as batch mode: open LoginRequiredModal first, only show
    // the link-mode URL form after extension + XHS tab + login all pass.
    setLoginModalReason('linkmode');
  };

  const handleAutoReplyClick = () => {
    if (tasks.length >= MAX_TASKS) {
      alert(i18nService.currentLanguage === 'zh' ? '最多创建 ' + MAX_TASKS + ' 个任务' : 'Max ' + MAX_TASKS + ' tasks allowed');
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    // v2.4.27: card always opens the wizard for a NEW task — even if the
    // user already has an auto-reply task. Pre-2.4.27 we shortcut to the
    // existing task ("继续任务") which made it impossible to create a
    // second / third auto-reply task with different keywords or a
    // different track from this entry point. Multi-task support already
    // exists everywhere else; this card was the only blocker.
    setLoginModalReason('autoreply');
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
    const reason = loginModalReason;
    setLoginModalReason(null);
    // After checks pass, open whichever form the user was heading to.
    if (reason === 'linkmode') {
      setLinkModalOpen(true);
    } else if (reason === 'autoreply') {
      onConfigure(autoReplyScenario);
    } else {
      onConfigure(primaryScenario);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Four-card grid — all XHS tools grouped together at the top:
          批量仿写 · 指定链接 · 敏感词检测 · 自动回复 */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. Batch rewrite (keyword) */}
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

        {/* 2. Link mode */}
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

        {/* 3. Sensitive-word checker */}
        <div className="relative rounded-2xl border border-yellow-500/30 bg-gradient-to-br from-yellow-500/10 via-amber-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-yellow-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-yellow-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '即开即用' : 'Instant'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              🚫 {i18nService.currentLanguage === 'zh' ? '敏感词检测' : 'Sensitive Word Checker'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '粘贴笔记标题/正文，1 秒比对 2026 版小红书敏感词库，标出绝对化用语、引流话术、医疗医美等限流词。'
                : 'Paste your note, instantly check against the 2026 XHS sensitive-word library. Flags ad-law violations, off-platform funnels and rate-limit triggers.'}
            </p>
            <button
              type="button"
              onClick={() => onOpenSensitiveCheck && onOpenSensitiveCheck()}
              className="w-full px-6 py-3 text-sm font-bold rounded-xl bg-yellow-500 text-white hover:bg-yellow-600 shadow-lg shadow-yellow-500/25 transition-all active:scale-95"
            >
              🚫 {i18nService.currentLanguage === 'zh' ? '开始检测' : 'Start Check'} →
            </button>
          </div>
        </div>

        {/* 4. Auto-reply */}
        <div className="relative rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/5 to-transparent p-6 overflow-hidden">
          <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col h-full">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-500 mb-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
              {i18nService.currentLanguage === 'zh' ? '智能互动' : 'Auto Engage'}
            </div>
            <h2 className="text-lg sm:text-xl font-bold dark:text-white mb-1.5">
              💬 {i18nService.currentLanguage === 'zh' ? '小红书自动互动' : 'XHS Auto Engage'}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
              {i18nService.currentLanguage === 'zh'
                ? '每日自动找最近一周高评论文章（0-6 篇随机），AI 一次生成「文章评论 + 用户回复」，按评论 30-80 秒、文章 60-200 秒随机间隔安全发布。每次再按 0-30% 概率关注作者（每日 0-5 人随机封顶）。'
                : 'Daily: 0-6 random high-comment articles, AI replies + per-comment replies, 30-80s/60-200s safe jitter. Optionally follow the author (~30% chance, capped 0-5 follows/day).'}
            </p>
            <button
              type="button"
              onClick={handleAutoReplyClick}
              className="w-full px-6 py-3 text-sm font-bold rounded-xl bg-cyan-500 text-white hover:bg-cyan-600 shadow-lg shadow-cyan-500/25 transition-all active:scale-95"
            >
              💬 {i18nService.currentLanguage === 'zh' ? '开始互动' : 'Start'} →
            </button>
          </div>
        </div>
      </section>

      {/* Advantage pills (moved out of banner, cross both cards). Note:
          "✨ 原创质量高" leads since it's the most user-meaningful claim;
          the rest are operational properties of the bot. */}
      <section className="mb-6 flex flex-wrap items-center gap-2">
        {[
          { icon: '✨', zh: '原创质量高', en: 'High-quality original output' },
          { icon: '💰', zh: '成本超低', en: 'Ultra-low cost' },
          { icon: '🛡️', zh: '不封号', en: 'Safe' },
          { icon: '🤖', zh: '全自动', en: 'Auto' },
          { icon: '🚀', zh: '自动上传', en: 'Auto Upload' },
          { icon: '🌊', zh: '爆款池', en: 'Viral Pool' },
        ].map((p, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-green-500/20 bg-green-500/5 text-gray-700 dark:text-gray-300">
            {p.icon} {i18nService.currentLanguage === 'zh' ? p.zh : p.en}
          </span>
        ))}
      </section>

      {/* Link-mode modal. 背景点击 NOT 关闭弹窗——用户粘贴的链接很长，容易误
          点关掉；必须通过取消按钮关闭。 */}
      {linkModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6"
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
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y min-h-[200px] break-all"
              disabled={linkSubmitting}
            />

            {/* 自动上传 vs 仅生成 */}
            <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
              {i18nService.currentLanguage === 'zh' ? '生成后的处理' : 'After generation'}
            </label>
            <div className="space-y-2">
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${linkAutoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="link_auto_upload" checked={linkAutoUpload} onChange={() => setLinkAutoUpload(true)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {i18nService.currentLanguage === 'zh' ? '📤 自动上传到小红书草稿箱' : '📤 Auto-upload to XHS drafts'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {i18nService.currentLanguage === 'zh' ? '全流程无人值守。⚠️ 单日 >3 篇有封号风险。' : 'Unattended. ⚠️ >3/day risks ban.'}
                  </div>
                </div>
              </label>
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!linkAutoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="link_auto_upload" checked={!linkAutoUpload} onChange={() => setLinkAutoUpload(false)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {i18nService.currentLanguage === 'zh' ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {i18nService.currentLanguage === 'zh' ? '存盘后手动审核上传，封号风险最低。' : 'Review and upload manually later.'}
                  </div>
                </div>
              </label>
            </div>

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
