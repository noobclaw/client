/**
 * XWorkflowsPage — Twitter (X) 平台工作流页面.
 *
 * 结构镜像 XhsWorkflowsPage：
 *   - 顶部一个简短 hero 介绍
 *   - 3 张 scenario 卡片
 *   - 已有任务列表
 *
 * v1 scenario set (see backend feature/twitter-v1 branch):
 *   x_auto_engage   — 自动关注 KOL + 评论 feed + 评论已关注
 *   x_link_rewrite  — 指定推文链接仿写发推
 *   x_post_creator  — 每日自动发 1 条推（3 机制随机）
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';

// web3 KOL track preset 的简表（用于任务卡片显示图标+名称）
const WEB3_TRACK_ICONS: Record<string, { icon: string; name_zh: string }> = {
  web3_alpha: { icon: '🎯', name_zh: 'Web3 · Alpha 猎人' },
  web3_defi: { icon: '🏛️', name_zh: 'Web3 · DeFi 用户' },
  web3_meme: { icon: '🎪', name_zh: 'Web3 · Meme 文化' },
  web3_builder: { icon: '🛠️', name_zh: 'Web3 · 建设者' },
  web3_zh_kol: { icon: '📢', name_zh: 'Web3 · 通用 KOL' },
};

interface Props {
  scenarios: Scenario[];           // already filtered to platform='x' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string) => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
}

export const XWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,   // not used yet on Twitter side — drafts-free MVP
  loading,
  onOpenTask,
  onConfigure,
  onChanged: _onChanged,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());

  // Poll which tasks are currently running (could be > 1 with multi-tab
  // concurrency when XHS task + Twitter task are both in flight)
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

  // Resolve each scenario by id, fall back to a placeholder when the
  // backend list hasn't loaded yet. Matches the pattern in XhsWorkflowsPage.
  const findById = (id: string): Scenario | null =>
    scenarios.find(s => s.id === id) || null;

  const autoEngage = findById('x_auto_engage');
  const linkRewrite = findById('x_link_rewrite');
  const postCreator = findById('x_post_creator');

  // Tasks grouped by scenario_id
  const tasksByScenario: Record<string, Task[]> = {};
  for (const t of tasks) {
    const key = t.scenario_id;
    if (!tasksByScenario[key]) tasksByScenario[key] = [];
    tasksByScenario[key].push(t);
  }

  // ── Login gate ──
  const handleConfigure = useCallback(async (scenario: Scenario | null) => {
    if (!scenario) {
      alert(isZh ? '场景元数据还在加载中，请稍后再试' : 'Scenario metadata still loading');
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    onConfigure(scenario);
  }, [onConfigure, isZh]);

  // ── UI helpers ──
  const scheduleLabel = (task: Task): string => {
    const interval = (task as any).run_interval || 'daily_random';
    const map: Record<string, string> = isZh
      ? { '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时',
          'daily': '每天 ' + (task.daily_time || '08:00'),
          'daily_random': '每日随机时间', 'once': '手动' }
      : { '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h',
          'daily': 'Daily ' + (task.daily_time || '08:00'),
          'daily_random': 'Once daily (random)', 'once': 'Manual' };
    return map[interval] || interval;
  };

  // ── Render ──

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Hero */}
      <section className="mb-6 rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-blue-500/5 to-transparent p-5 relative overflow-hidden">
        <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-sky-500/10 blur-3xl pointer-events-none" />
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-500 mb-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
            {isZh ? 'Twitter / X' : 'Twitter / X'}
          </div>
          <h2 className="text-xl font-bold dark:text-white mb-1.5">
            🐦 {isZh ? 'Twitter 自动化' : 'Twitter Automation'}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            {isZh
              ? '专为 Web3 KOL 设计：自动关注圈内 KOL、智能评论互动、每日自动发推，三件事随机打散，看起来像真人而不是机器。'
              : 'Built for Web3 KOLs: auto-follow peers, smart-engage with tweets, and post daily. All randomized to feel human.'}
          </p>
          <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed mt-2">
            {isZh
              ? '⚠️ 大陆用户注意：x.com 在大陆需 VPN / 代理访问，运行任务前请确保浏览器能正常打开 Twitter。'
              : '⚠️ Mainland China users: x.com requires VPN / proxy. Verify your browser can reach Twitter before running tasks.'}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {[
              { icon: '🛡️', zh: '严风控', en: 'Strict caps' },
              { icon: '🎲', zh: '随机节奏', en: 'Randomized pacing' },
              { icon: '🌐', zh: '中英混合', en: 'zh/en/mixed' },
              { icon: '🤝', zh: '500 KOL 池', en: '500+ KOL pool' },
            ].map((p, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-white/10 dark:bg-white/5 text-gray-300">
                {p.icon} {isZh ? p.zh : p.en}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Scenario cards */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 1. Auto engage */}
        <ScenarioCard
          color="emerald"
          emoji="🐦"
          badge={isZh ? '每日互动' : 'Daily engagement'}
          titleZh="推特自动互动"
          titleEn="X Auto Engagement"
          descZh="关注 KOL + 评论已关注 + 浏览 feed 挑推评论，每天 0-5 个动作随机打散，每个动作间 8-30 分钟。"
          descEn="Follow KOLs + reply to followed + scroll feed & reply. 0-5 actions/day, 8-30 min between actions."
          loading={loading}
          scenario={autoEngage}
          existingTasks={autoEngage ? tasksByScenario[autoEngage.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(autoEngage)}
          scheduleLabel={scheduleLabel}
          isZh={isZh}
          ctaZh="配置自动互动"
          ctaEn="Configure"
        />
        {/* 2. Post creator */}
        <ScenarioCard
          color="sky"
          emoji="📝"
          badge={isZh ? '每日发推' : 'Daily post'}
          titleZh="推特发推"
          titleEn="X Post Creator"
          descZh="每天自动发 1 条推，30% feed 仿写 / 30% 按热点原创 / 40% 引用回应，三机制随机保持多样性。"
          descEn="Posts 1 tweet/day: 30% feed-rewrite / 30% original / 40% quote-tweet, randomized for variety."
          loading={loading}
          scenario={postCreator}
          existingTasks={postCreator ? tasksByScenario[postCreator.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(postCreator)}
          scheduleLabel={scheduleLabel}
          isZh={isZh}
          ctaZh="配置发推"
          ctaEn="Configure"
        />
        {/* 3. Link rewrite */}
        <ScenarioCard
          color="violet"
          emoji="✍️"
          badge={isZh ? '手动一次性' : 'One-shot'}
          titleZh="指定推文仿写"
          titleEn="Tweet Rewrite (URL)"
          descZh="粘贴 1-5 条推文链接，AI 解构每条钩子 + 结构，用你的人设仿写成新推（不抄袭），逐条间隔发布。"
          descEn="Paste 1-5 tweet URLs. AI deconstructs hook + structure, rewrites in your voice (no copying), posts one by one."
          loading={loading}
          scenario={linkRewrite}
          existingTasks={linkRewrite ? tasksByScenario[linkRewrite.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(linkRewrite)}
          scheduleLabel={scheduleLabel}
          isZh={isZh}
          ctaZh="开始仿写"
          ctaEn="Start"
        />
      </section>

      {/* My Twitter tasks (flat list) */}
      {tasks.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold dark:text-white mb-3">
            {isZh ? '🐦 我的推特任务' : '🐦 My Twitter Tasks'}
          </h3>
          <div className="space-y-2">
            {tasks.map(t => {
              const isRunning = runningTaskIds.has(t.id);
              const track = WEB3_TRACK_ICONS[t.track] || { icon: '🐦', name_zh: t.track };
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    isRunning
                      ? 'border-green-500/50 ring-1 ring-green-500/20 bg-white dark:bg-gray-800/50'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 hover:border-sky-500/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium dark:text-white mb-0.5 truncate">
                        {track.icon} {track.name_zh}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        ⏰ {scheduleLabel(t)} · {t.daily_count} {isZh ? '次/天' : '/day'}
                      </div>
                    </div>
                    {isRunning && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 font-medium shrink-0">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                        {isZh ? '运行中' : 'Running'}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">›</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Login modal (reuses XHS login gate component but shows "X" copy).
          TODO: if we need X-specific login detection (twitter.com not
          xiaohongshu.com), expand LoginRequiredModal to accept a platform
          prop. For MVP we assume user logs into x.com in the same Chrome.  */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="x"
          onCancel={() => setLoginModalReason(null)}
          onConfirmed={() => setLoginModalReason(null)}
        />
      )}
    </div>
  );
};

// ── Scenario card sub-component ──

type ScenarioCardProps = {
  color: 'emerald' | 'sky' | 'violet';
  emoji: string;
  badge: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  ctaZh: string;
  ctaEn: string;
  loading: boolean;
  scenario: Scenario | null;
  existingTasks: Task[];
  runningTaskIds: Set<string>;
  onOpenTask: (id: string) => void;
  onConfigure: () => void;
  scheduleLabel: (t: Task) => string;
  isZh: boolean;
};

const ScenarioCard: React.FC<ScenarioCardProps> = ({
  color, emoji, badge, titleZh, titleEn, descZh, descEn, ctaZh, ctaEn,
  loading, scenario, existingTasks, runningTaskIds, onOpenTask, onConfigure,
  scheduleLabel, isZh,
}) => {
  const palette: Record<typeof color, { border: string; bg: string; text: string; btn: string; shadow: string }> = {
    emerald: {
      border: 'border-emerald-500/30',
      bg: 'from-emerald-500/10 via-green-500/5',
      text: 'text-emerald-500',
      btn: 'bg-emerald-500 hover:bg-emerald-600',
      shadow: 'shadow-emerald-500/25',
    },
    sky: {
      border: 'border-sky-500/30',
      bg: 'from-sky-500/10 via-blue-500/5',
      text: 'text-sky-500',
      btn: 'bg-sky-500 hover:bg-sky-600',
      shadow: 'shadow-sky-500/25',
    },
    violet: {
      border: 'border-violet-500/30',
      bg: 'from-violet-500/10 via-purple-500/5',
      text: 'text-violet-500',
      btn: 'bg-violet-500 hover:bg-violet-600',
      shadow: 'shadow-violet-500/25',
    },
  };
  const c = palette[color];
  const firstTask = existingTasks[0];
  const isRunning = firstTask ? runningTaskIds.has(firstTask.id) : false;

  return (
    <div className={`relative rounded-2xl border ${c.border} bg-gradient-to-br ${c.bg} to-transparent p-5 overflow-hidden flex flex-col`}>
      <div className={`absolute -top-16 -right-16 w-40 h-40 rounded-full ${c.bg.replace('from-', 'bg-').split(' ')[0]}/10 blur-3xl pointer-events-none`} />
      <div className="relative flex flex-col flex-1">
        <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${c.text} mb-2`}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.text.replace('text-', 'bg-')} animate-pulse`} />
          {badge}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          {emoji} {isZh ? titleZh : titleEn}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh ? descZh : descEn}
        </p>

        {/* Existing task summary (if any) */}
        {firstTask && (
          <button
            type="button"
            onClick={() => onOpenTask(firstTask.id)}
            className={`text-left rounded-lg border p-2 mb-2 text-[11px] transition-colors ${
              isRunning
                ? 'border-green-500/50 bg-green-500/5'
                : 'border-gray-200 dark:border-gray-700 bg-white/40 dark:bg-gray-800/40 hover:border-gray-300'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="dark:text-white truncate">
                ⏰ {scheduleLabel(firstTask)}
              </span>
              {isRunning && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1 py-0.5 rounded bg-green-500/10 text-green-600 shrink-0">
                  <span className="inline-block w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                  {isZh ? '运行中' : 'Running'}
                </span>
              )}
            </div>
          </button>
        )}

        <button
          type="button"
          onClick={onConfigure}
          disabled={loading || !scenario}
          className={`w-full px-4 py-2.5 text-sm font-bold rounded-xl ${c.btn} disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg ${c.shadow} transition-all active:scale-95`}
        >
          {emoji} {firstTask ? (isZh ? '管理任务' : 'Manage') : (isZh ? ctaZh : ctaEn)} →
        </button>
      </div>
    </div>
  );
};
