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
import { ExtensionUpdateBanner } from './ExtensionUpdateBanner';
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
  onChanged,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());

  // ── x_link_rewrite quick-create modal (mirrors XHS link-mode flow) ──
  // The user's expectation: paste URLs → click run → done. No wizard, no
  // schedule (it's a one-shot job, run_interval='once'). Modal collects
  // the URL list + auto_upload toggle, creates the task, jumps to detail
  // page, fires runTaskNow asynchronously. Same shape as XHS link-mode.
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linksText, setLinksText] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkAutoUpload, setLinkAutoUpload] = useState(true);

  const validateTweetLinks = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: isZh ? '至少粘贴 1 条推文链接' : 'Paste at least 1 tweet URL' };
    if (lines.length > 5) return { ok: [], err: isZh ? '最多 5 条' : 'Max 5 URLs' };
    for (const l of lines) {
      // Accept twitter.com or x.com /<handle>/status/<id>
      if (!/^https?:\/\/(www\.)?(twitter|x)\.com\/[^/]+\/status\/\d+/i.test(l)) {
        return { ok: [], err: (isZh ? '不是有效推文链接：' : 'Not a valid tweet URL: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

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
    // x_link_rewrite is intentionally a one-shot job — same UX as XHS link
    // mode: open a quick modal for URLs + auto_upload, no wizard / schedule.
    // Other Twitter scenarios still go through the full ConfigWizard.
    if (scenario.id === 'x_link_rewrite') {
      setLinkModalOpen(true);
      return;
    }
    onConfigure(scenario);
  }, [onConfigure, isZh]);

  const handleLinkSubmit = useCallback(async () => {
    if (linkSubmitting) return;
    const { ok, err } = validateTweetLinks(linksText);
    if (err) { alert(err); return; }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }
    if (!linkRewrite) {
      alert(isZh ? '场景元数据还在加载中，请稍后再试' : 'Scenario metadata still loading');
      return;
    }
    setLinkSubmitting(true);
    try {
      const now = new Date();
      const mm = String(now.getMinutes()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const newTask = await scenarioService.createTask({
        scenario_id: linkRewrite.id,
        // No track concept for link rewrite — pass an explicit sentinel so
        // detail page knows this came from URL-mode (not a real preset).
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
      // Refresh parent tasks[] before jumping so detail page can find it
      if (onChanged) { await onChanged(); }
      onOpenTask(newTask.id);
      scenarioService.runTaskNow(newTask.id).catch((e: any) => {
        console.error('[XLinkMode] runTaskNow failed:', e);
      });
    } catch (e) {
      alert((isZh ? '创建失败：' : 'Create failed: ') + String(e).slice(0, 120));
    } finally {
      setLinkSubmitting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linksText, linkAutoUpload, linkSubmitting, linkRewrite, isZh]);

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
      <ExtensionUpdateBanner />
      {/* Scenario cards — match XHS layout: jump straight to the cards,
          no platform hero / intro paragraph / mainland-VPN warning above.
          The three Twitter scenarios speak for themselves; the bottom
          features row covers what was previously in the hero pills. */}
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
          isZh={isZh}
          ctaZh="配置开始互动"
          ctaEn="Configure & Start"
        />
        {/* 2. Post creator */}
        <ScenarioCard
          color="sky"
          emoji="📝"
          badge={isZh ? '每日发推' : 'Daily post'}
          titleZh="推特发推"
          titleEn="X Post Creator"
          descZh="每天自动发 1 条推，40% feed 仿写（字数≥100、浏览≥1万）/ 40% 按热点原创 / 20% 转推回应，三机制随机保持多样性。"
          descEn="Posts 1 tweet/day: 40% feed-rewrite (≥100 chars, ≥10K views) / 40% original / 20% quote-tweet, randomized for variety."
          loading={loading}
          scenario={postCreator}
          existingTasks={postCreator ? tasksByScenario[postCreator.id] || [] : []}
          runningTaskIds={runningTaskIds}
          onOpenTask={onOpenTask}
          onConfigure={() => handleConfigure(postCreator)}
          isZh={isZh}
          ctaZh="配置开始发推"
          ctaEn="Configure & Start"
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
          isZh={isZh}
          ctaZh="开始仿写"
          ctaEn="Start"
        />
      </section>

      {/* Twitter features row — replaces the old hero. Per-platform notes
          users actually need: risk-control posture, randomization, language,
          KOL pool, mainland-VPN reminder. Compact pill design so it doesn't
          steal attention from the cards above. */}
      <section className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
          {isZh ? '🐦 推特自动化 · 几个特点' : '🐦 Twitter Automation · Highlights'}
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { icon: '🛡️', zh: '严风控（每日动作上限 + 周休）', en: 'Strict caps (daily limits + weekly rest)' },
            { icon: '🎲', zh: '随机节奏（动作间 8-30 分钟随机）', en: 'Randomized pacing (8-30 min between actions)' },
            { icon: '🌐', zh: '中英混合（自动跟随原推语言）', en: 'zh/en/mixed (follows source language)' },
            { icon: '🤝', zh: '500+ web3 KOL 池', en: '500+ Web3 KOL pool' },
            { icon: '🎨', zh: '随机配图（约 30% 概率，AI 生图）', en: 'Random images (~30%, AI-generated)' },
            { icon: '⚠️', zh: '大陆需 VPN / 代理访问 x.com', en: 'Mainland China: VPN required for x.com' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-sky-500/20 bg-sky-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* My Twitter tasks — rich card layout matching XHS task list:
          type badge, track icon + name, ID hash, status badge, persona
          snippet, schedule line. For x_link_rewrite tasks we also show
          the URL count + first 3 URLs since that's the user's main input. */}
      {tasks.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              🐦 {isZh ? '推特任务' : 'Twitter Tasks'}
            </h2>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              {isZh ? '同一平台最多同时运行一个任务' : 'One task per platform at a time'}
            </span>
          </div>
          <div className="space-y-3">
            {/* Sort: running tasks first (so user immediately sees what's
                actively going), then everything else in original order.
                Stable sort — non-running tasks keep their relative order. */}
            {tasks
              .map((t, i) => ({ t, i, running: runningTaskIds.has(t.id) }))
              .sort((a, b) => {
                if (a.running !== b.running) return a.running ? -1 : 1;
                return a.i - b.i;
              })
              .map(({ t }) => {
              const isRunning = runningTaskIds.has(t.id);
              const track = WEB3_TRACK_ICONS[t.track] || { icon: '🐦', name_zh: t.track };
              const scenarioId = t.scenario_id;
              // Type badge per scenario, mirrors XHS workflow-type badge styling
              const typeLabel = scenarioId === 'x_auto_engage'
                ? { icon: '🐦', zh: '自动互动', en: 'Auto Engage', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' }
                : scenarioId === 'x_post_creator'
                  ? { icon: '📝', zh: '每日发推', en: 'Daily Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' }
                  : scenarioId === 'x_link_rewrite'
                    ? { icon: '✍️', zh: '指定推文仿写', en: 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' }
                    : { icon: '🐦', zh: t.scenario_id, en: t.scenario_id, color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
              const isLinkRewrite = scenarioId === 'x_link_rewrite';
              const taskUrls: string[] = (t as any).urls || [];
              const personaSnippet = (t.persona || '').trim().split('\n')[0].slice(0, 80);
              const interval = (t as any).run_interval || 'daily_random';
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className={`w-full text-left rounded-xl border p-4 transition-colors relative ${
                    isRunning
                      ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow'
                      : 'border-gray-200 dark:border-gray-700 hover:border-sky-500/50 dark:hover:border-sky-500/50 bg-white dark:bg-gray-900'
                  }`}
                >
                  {/* Top row: type badge + track + ID + status badges */}
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeLabel.color}`}>
                        {typeLabel.icon} {isZh ? typeLabel.zh : typeLabel.en}
                      </span>
                      {/* Track icon/name hidden for x_link_rewrite — that scenario
                          is URL-driven, the track is meaningless for it. */}
                      {!isLinkRewrite && (
                        <>
                          <span className="text-lg">{track.icon}</span>
                          <span className="font-medium dark:text-white truncate">{track.name_zh}</span>
                        </>
                      )}
                      <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
                        #{t.id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isRunning ? (
                        <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          {isZh ? '运行中' : 'Running'}
                        </span>
                      ) : interval === 'once' || isLinkRewrite ? (
                        <span className="text-xs px-2 py-1 rounded bg-purple-500/10 text-purple-500 border border-purple-500/30">
                          ✋ {isZh ? '手动运行' : 'Manual'}
                        </span>
                      ) : t.active ? (
                        <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">
                          ⏰ {isZh ? '定时运行' : 'Scheduled'}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-800 text-gray-500">
                          {isZh ? '待命' : 'Standby'}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Persona snippet — first line so users can quickly tell which voice
                      this task is using without opening detail page. */}
                  {personaSnippet && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 truncate">
                      👤 {personaSnippet}
                    </div>
                  )}
                  {/* Config details */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    {isLinkRewrite ? (
                      <>
                        <div>{isZh ? '推文链接' : 'Tweet URLs'}: {taskUrls.length} {isZh ? '条' : ''}</div>
                        {taskUrls.slice(0, 3).map((u, i) => (
                          <div key={i} className="truncate text-[11px] text-gray-400">{i + 1}. {u}</div>
                        ))}
                      </>
                    ) : (
                      <div>
                        {isZh ? '频次: ' : 'Frequency: '}
                        ⏰ {scheduleLabel(t)} · {t.daily_count} {isZh ? '条/次' : '/run'}
                      </div>
                    )}
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

      {/* x_link_rewrite quick-create modal (mirrors XHS link-mode UX).
          Click outside DOES NOT dismiss — pasted URL lists are long, easy to
          mis-click and lose. Cancel button only. */}
      {linkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
            <h3 className="text-lg font-bold dark:text-white mb-2">
              ✍️ {isZh ? '指定推文仿写' : 'Tweet Rewrite (URL)'}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              {isZh
                ? '粘贴 1-5 条推文链接（x.com / twitter.com /<handle>/status/<id>）。AI 会解构每条钩子+结构，仿原推语言和风格写一条新推（不抄袭），逐条间隔 10-30 分钟发布。'
                : 'Paste 1-5 tweet URLs. AI deconstructs hook + structure, rewrites in source language/style (no copying), posts with 10-30 min spacing.'}
            </p>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {isZh ? '推文链接（每行 1 条）' : 'Tweet URLs (one per line)'}
            </label>
            <textarea
              value={linksText}
              onChange={e => setLinksText(e.target.value)}
              placeholder={'https://x.com/handle/status/12345...\nhttps://x.com/handle/status/67890...'}
              rows={8}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/50 resize-y min-h-[180px] break-all"
              disabled={linkSubmitting}
            />

            <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
              {isZh ? '生成后的处理' : 'After rewriting'}
            </label>
            <div className="space-y-2">
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${linkAutoUpload ? 'border-violet-500 bg-violet-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="x_link_auto_upload" checked={linkAutoUpload} onChange={() => setLinkAutoUpload(true)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {isZh ? '🚀 自动发布到推特' : '🚀 Auto-post to Twitter'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {isZh ? '逐条间隔 10-30 分钟随机发布。⚠️ 推文一旦发布无法撤回。' : 'Posts with 10-30 min jitter. ⚠️ Tweets cannot be unposted.'}
                  </div>
                </div>
              </label>
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!linkAutoUpload ? 'border-violet-500 bg-violet-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                <input type="radio" name="x_link_auto_upload" checked={!linkAutoUpload} onChange={() => setLinkAutoUpload(false)} className="mt-0.5" disabled={linkSubmitting} />
                <div className="flex-1 text-xs leading-relaxed">
                  <div className="font-semibold dark:text-white mb-0.5">
                    {isZh ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {isZh ? '存盘后人工审核挑选。' : 'Saved locally for manual review.'}
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
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleLinkSubmit}
                disabled={linkSubmitting}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50"
              >
                {linkSubmitting
                  ? (isZh ? '创建中...' : 'Creating...')
                  : '🚀 ' + (isZh ? '立即开始仿写' : 'Start Rewriting Now')}
              </button>
            </div>
          </div>
        </div>
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
  isZh: boolean;
};

const ScenarioCard: React.FC<ScenarioCardProps> = ({
  color, emoji, badge, titleZh, titleEn, descZh, descEn, ctaZh, ctaEn,
  loading, scenario, existingTasks, runningTaskIds, onOpenTask, onConfigure,
  isZh,
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

        {/* Existing task running indicator (only when active) — drop the
            "每日随机时间" pill per user feedback. The card already shows the
            scenario summary, the schedule isn't useful here. */}
        {firstTask && isRunning && (
          <div className="text-left rounded-lg border border-green-500/50 bg-green-500/5 p-2 mb-2 text-[11px]">
            <span className="inline-flex items-center gap-1 text-green-600">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {isZh ? '运行中' : 'Running'}
            </span>
          </div>
        )}
        {/* Allow click to open task details */}
        {firstTask && (
          <button
            type="button"
            onClick={() => onOpenTask(firstTask.id)}
            className="text-left text-[11px] text-gray-500 dark:text-gray-400 underline-offset-2 hover:underline mb-2 self-start"
          >
            {isZh ? '查看任务详情 →' : 'View task details →'}
          </button>
        )}

        <button
          type="button"
          onClick={onConfigure}
          disabled={loading || !scenario}
          className={`w-full px-4 py-2.5 text-sm font-bold rounded-xl ${c.btn} disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg ${c.shadow} transition-all active:scale-95`}
        >
          {emoji} {isZh ? ctaZh : ctaEn} →
        </button>
      </div>
    </div>
  );
};
