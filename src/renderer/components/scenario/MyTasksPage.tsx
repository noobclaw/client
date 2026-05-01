/**
 * MyTasksPage — unified list of ALL automation tasks across platforms.
 *
 * Replaces the per-platform task lists at the bottom of XhsWorkflowsPage
 * and XWorkflowsPage. Single source of truth for "what tasks do I have".
 *
 * Sorting:
 *   1. Currently-running tasks pinned to top (with green pulse glow)
 *   2. Then by created_at descending (newest first)
 *
 * Each row shows:
 *   - Platform tag (📕 小红书 / 🐦 推特)
 *   - Task type badge (e.g. 🔥 批量爆款 / 💬 自动回复 / 🐦 互动涨粉)
 *   - Track / scenario name
 *   - #ID hash + persona snippet
 *   - Status pill (运行中 / 定时 / 手动 / 待命)
 *   - Frequency line
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task } from '../../services/scenario';

interface Props {
  /** Tasks already filtered to a single platform by the parent. The parent
   *  switches between XHS / Twitter via a sub-tab and re-filters tasks. */
  tasks: Task[];
  scenarios: Scenario[];
  loading: boolean;
  /** Used in the empty-state hint and the section header label. */
  platformLabel: string;
  onOpenTask: (task_id: string) => void;
  /** Optional refresh callback — called on mount so freshly-edited tasks
   *  show up with the latest config (e.g. user changed track in detail
   *  page → comes back to My Tasks → list reflects the new track without
   *  needing the user to wait for the next periodic poll). */
  onRefresh?: () => void | Promise<void>;
  /** Jump to the Create section for the same platform sub-tab. Used by
   *  the empty state — instead of telling the user "click the L1 tab
   *  above", we give them a one-click button. */
  onGoCreate?: () => void;
  /** Internal id ('xhs' | 'x') of the current platform sub-tab — used
   *  to pick the right icon + label on the empty-state CTA button. The
   *  parent already filters tasks by this; we just need to know which
   *  one for display. */
  platformId?: 'xhs' | 'x' | 'binance';
}

// Platform pill label is locale-aware: Chinese when zh, English when en.
// Returns { icon, label } for whichever locale is active right now.
function platformMeta(platformId: string, isZh: boolean): { icon: string; label: string } {
  if (platformId === 'xhs')     return { icon: '📕', label: isZh ? '小红书' : 'Xiaohongshu' };
  if (platformId === 'x')       return { icon: '🐦', label: isZh ? '推特' : 'Twitter' };
  if (platformId === 'binance') return { icon: '🔶', label: isZh ? '币安广场' : 'Binance Square' };
  if (platformId === 'youtube') return { icon: '📺', label: 'YouTube' };
  if (platformId === 'tiktok')  return { icon: '🎵', label: 'TikTok' };
  if (platformId === 'douyin')  return { icon: '🎵', label: isZh ? '抖音' : 'Douyin' };
  return { icon: '🤖', label: platformId };
}

// Persona snippets are seeded from Chinese templates (the reply_persona_hint
// arrays in ConfigWizard) — they always start with "身份：" / "现在做的：" /
// "真实状态：" prefixes. In EN mode we translate the prefix so the user
// doesn't see Chinese labels (the body content stays Chinese — that's
// user-editable copy and we can't auto-translate it).
function localizePersonaPrefix(text: string, isZh: boolean): string {
  if (isZh) return text;
  return text
    .replace(/^身份[：:]\s*/, 'Identity: ')
    .replace(/^现在做的[：:]\s*/, 'Currently doing: ')
    .replace(/^真实状态[：:]\s*/, 'Status: ')
    .replace(/^技术栈[：:]\s*/, 'Tech stack: ')
    .replace(/^理财习惯[：:]\s*/, 'Finance habits: ')
    .replace(/^旅行风格[：:]\s*/, 'Travel style: ')
    .replace(/^饮食习惯[：:]\s*/, 'Food habits: ')
    .replace(/^穿搭习惯[：:]\s*/, 'Style: ')
    .replace(/^护肤路线[：:]\s*/, 'Skincare: ')
    .replace(/^饮食[：:]\s*/, 'Diet: ')
    .replace(/^偏好[：:]\s*/, 'Preferences: ');
}

const TRACK_ICONS: Record<string, { icon: string; name_zh: string }> = {
  // Twitter (web3) tracks
  web3_alpha: { icon: '🎯', name_zh: 'Web3 · Alpha 猎人' },
  web3_defi: { icon: '🏛️', name_zh: 'Web3 · DeFi 用户' },
  web3_meme: { icon: '🎪', name_zh: 'Web3 · Meme 文化' },
  web3_builder: { icon: '🛠️', name_zh: 'Web3 · 建设者' },
  web3_zh_kol: { icon: '📢', name_zh: 'Web3 · 通用 KOL' },
  // XHS tracks (mirrored from ConfigWizard's TRACK_PRESETS so the task list
  // can show the user's chosen track name instead of falling back to the
  // generic scenario name like "小红书自动回复")
  career_side_hustle: { icon: '💼', name_zh: '副业 · 打工人赚钱' },
  indie_dev: { icon: '👩‍💻', name_zh: '独立开发 · 程序员记录' },
  personal_finance: { icon: '💰', name_zh: '理财 · 记账攻略' },
  travel: { icon: '✈️', name_zh: '旅行 · 攻略分享' },
  food: { icon: '🍲', name_zh: '美食 · 探店做饭' },
  outfit: { icon: '👗', name_zh: '穿搭 · 风格分享' },
  beauty: { icon: '💄', name_zh: '美妆 · 产品测评' },
  fitness: { icon: '💪', name_zh: '健身 · 减脂日记' },
  reading: { icon: '📚', name_zh: '读书 · 书单笔记' },
  parenting: { icon: '🧸', name_zh: '育儿 · 亲子日常' },
  exam_prep: { icon: '🎓', name_zh: '考研 · 备考党' },
  pets: { icon: '🐱', name_zh: '宠物 · 猫狗日常' },
  home_decor: { icon: '🏠', name_zh: '家居 · 小屋布置' },
  study_method: { icon: '🏆', name_zh: '学习 · 效率工具' },
};

function scheduleLabel(task: Task, isZh: boolean): string {
  const interval = (task as any).run_interval || 'daily_random';
  const map: Record<string, string> = isZh
    ? {
        '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时',
        'daily': '每天 ' + (task.daily_time || '08:00'),
        'daily_random': '每日随机时间', 'once': '手动',
      }
    : {
        '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h',
        'daily': 'Daily ' + (task.daily_time || '08:00'),
        'daily_random': 'Once daily (random)', 'once': 'Manual',
      };
  return map[interval] || interval;
}

/** v4.31.43: 把 next_planned_run_at 渲染成简短的"还差多久 · 绝对时间",
 *  跟 detail page 的"下次运行"显示一致。运行中 / once / link_rewrite 不
 *  调用此函数(那些有专门的 pill)。 */
function nextRunLabel(task: Task, isZh: boolean): string {
  const planned = (task as any).next_planned_run_at as number | undefined;
  if (planned && planned > Date.now()) {
    const diff = planned - Date.now();
    const mins = Math.round(diff / 60000);
    let rel: string;
    if (mins < 60) rel = mins + (isZh ? ' 分钟后' : 'm');
    else if (mins < 24 * 60) rel = Math.round(mins / 60) + (isZh ? ' 小时后' : 'h');
    else rel = Math.round(mins / (60 * 24)) + (isZh ? ' 天后' : 'd');
    const d = new Date(planned);
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const datePart = sameDay(d, now) ? (isZh ? '今天' : 'today')
                  : sameDay(d, tomorrow) ? (isZh ? '明天' : 'tmrw')
                  : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    return `${rel} · ${datePart} ${hh}:${mm}`;
  }
  return isZh ? '即将' : 'Soon';
}

export const MyTasksPage: React.FC<Props> = ({ tasks, scenarios, loading, platformLabel, onOpenTask, onRefresh, onGoCreate, platformId }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());

  // Poll which tasks are actively running every 3s. Cheap IPC.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const ids = await scenarioService.getRunningTaskIds().catch(() => []);
      if (!cancelled) setRunningTaskIds(new Set(ids));
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, []);

  // Refresh tasks on mount so edits made in TaskDetailPage (e.g. user
  // changed track) propagate immediately when the user comes back to
  // the list — without this, the displayed task.track was stale until
  // the next refresh cycle.
  useEffect(() => {
    if (onRefresh) void onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scenarioById = useMemo(() => {
    return new Map(scenarios.map(s => [s.id, s]));
  }, [scenarios]);

  // Sort: running first, then by created_at desc. Stable inside each group.
  const sortedTasks = useMemo(() => {
    return [...tasks]
      .map((t, i) => ({ task: t, originalIdx: i, running: runningTaskIds.has(t.id) }))
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        const ca = a.task.created_at || 0;
        const cb = b.task.created_at || 0;
        if (ca !== cb) return cb - ca;
        return a.originalIdx - b.originalIdx;
      })
      .map(({ task }) => task);
  }, [tasks, runningTaskIds]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <section className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold dark:text-white">
            📋 {isZh ? `我的${platformLabel}任务` : `My ${platformLabel} Tasks`}
          </h2>
        </div>

        {loading && tasks.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {isZh ? '加载中...' : 'Loading...'}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <div className="text-4xl mb-2">📭</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {isZh ? `还没有${platformLabel}任务` : `No ${platformLabel} tasks yet`}
            </div>
            {/* v2.4.30: skip the "click the L1 tab above" hint — give the
                user a direct CTA button that jumps straight to Create
                section for the same platform sub-tab they're on. The
                button color matches the platform brand (green for XHS,
                sky for Twitter) so the visual cue ties back to the L2
                tab they came from. */}
            {onGoCreate && (
              <button
                type="button"
                onClick={onGoCreate}
                className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold transition-all active:scale-95 shadow-sm ${
                  platformId === 'x'
                    ? 'bg-sky-500 hover:bg-sky-600 shadow-sky-500/25'
                    : platformId === 'binance'
                      ? 'bg-yellow-500 hover:bg-yellow-600 shadow-yellow-500/25'
                      : 'bg-green-500 hover:bg-green-600 shadow-green-500/25'
                }`}
              >
                {platformId === 'x' ? '🐦' : platformId === 'binance' ? '🔶' : '📕'} {isZh ? `新建${platformLabel}任务` : `New ${platformLabel} task`}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {sortedTasks.map(task => {
              const scenario = scenarioById.get(task.scenario_id);
              const platformId = scenario?.platform || 'xhs';
              const platMeta = platformMeta(platformId, isZh);
              const isRunning = runningTaskIds.has(task.id);
              // Type badge per scenario id (Twitter has 3 distinct ones,
              // XHS has 2 distinct ones via workflow_type)
              const sid = task.scenario_id;
              const isLinkRewriteTwitter = sid === 'x_link_rewrite';
              const isXhsLinkMode = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0 && platformId === 'xhs');
              const isBinanceLinkRewrite = sid === 'binance_from_x_link';
              // v4.28.x: 任何"用户粘 URL 列表仿写"任务统一处理 —— 之前 binance_from_x_link
              // 没被算进去,导致它在列表里还显示 track 名 + persona 摘要(其实用户没填,
              // 是 wizard fallback 的默认人设),完全跟 X / XHS link 模式不一致。
              // 引入 isAnyLinkRewrite 后:隐藏 track 行 / 隐藏 persona snippet / 改显 URL 列表。
              const isAnyLinkRewrite = isLinkRewriteTwitter || isXhsLinkMode || isBinanceLinkRewrite;
              const taskUrls: string[] = (task as any).urls || [];
              // Type labels per user spec (v2.4.26):
              // Twitter: 推特 · 互动涨粉 / 推特 · 自动发推 / 指定链接仿写
              // XHS:     小红书 · 爆款批量仿写 / 小红书 · 指定链接爆款仿写 / 小红书 · 互动涨粉
              const typeLabel = (() => {
                if (sid === 'x_auto_engage')                  return { icon: '🐦', zh: '推特 · 互动涨粉', en: 'Twitter Engage & Grow', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
                if (sid === 'x_post_creator')                 return { icon: '📝', zh: '推特 · 自动发推', en: 'Twitter Auto Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if (sid === 'x_link_rewrite')                 return { icon: '✍️', zh: '推特 · 指定链接仿写', en: 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
                if (sid === 'binance_square_auto_engage')     return { icon: '🤝', zh: '币安广场 · 互动涨粉', en: 'Binance Square Engage & Grow', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
                if (sid === 'binance_square_post_creator')    return { icon: '🔶', zh: '币安广场 · 自动发帖', en: 'Binance Square Auto Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                if (sid === 'binance_from_x_repost')          return { icon: '🔁', zh: '币安广场 · 推特批量搬运', en: 'Binance · Repost from X (Batch)', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if (sid === 'binance_from_x_link')          return { icon: '🔗', zh: '币安广场 · 推特链接仿写', en: 'Binance · From X Link', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
                if (sid === 'youtube_auto_engage')          return { icon: '📺', zh: 'YouTube · 互动涨粉', en: 'YouTube Engage & Grow', color: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/30' };
                if (sid === 'tiktok_auto_engage')           return { icon: '🎵', zh: 'TikTok · 互动涨粉', en: 'TikTok Engage & Grow', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                if (sid === 'douyin_auto_engage')           return { icon: '🎵', zh: '抖音 · 互动涨粉', en: 'Douyin Engage & Grow', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
                if (isXhsLinkMode)                            return { icon: '🔗', zh: '小红书 · 指定链接爆款仿写', en: 'XHS Rewrite (URL)', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
                // workflow_type fallbacks — MUST check platform BEFORE labeling,
                // otherwise Binance / YouTube / TikTok / Douyin scenarios with
                // workflow_type='auto_reply' fall into the XHS branch and get
                // tagged 小红书 · 互动涨粉 (bug observed in 2.4.56). Platform-
                // first guard fixes it.
                const plat = scenario?.platform;
                if ((scenario?.workflow_type as any) === 'auto_reply') {
                  if (plat === 'binance') return { icon: '💬', zh: '币安广场 · 互动涨粉', en: 'Binance Square Engage & Grow', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
                  if ((plat as any) === 'youtube') return { icon: '💬', zh: 'YouTube · 互动涨粉', en: 'YouTube Engage & Grow', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                  if ((plat as any) === 'tiktok')  return { icon: '💬', zh: 'TikTok · 互动涨粉', en: 'TikTok Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                  if ((plat as any) === 'douyin')  return { icon: '💬', zh: '抖音 · 互动涨粉', en: 'Douyin Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                  return { icon: '💬', zh: '小红书 · 互动涨粉', en: 'XHS Engage & Grow', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                }
                if (plat === 'binance') return { icon: '🔶', zh: '币安广场发帖', en: 'Binance Square Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
                if (plat === 'x')       return { icon: '🐦', zh: '推特任务', en: 'Twitter Task', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if ((plat as any) === 'youtube') return { icon: '📺', zh: 'YouTube 任务', en: 'YouTube Task', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                if ((plat as any) === 'tiktok')  return { icon: '🎵', zh: 'TikTok 任务', en: 'TikTok Task', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                if ((plat as any) === 'douyin')  return { icon: '🎵', zh: '抖音任务', en: 'Douyin Task', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
                return { icon: '🔥', zh: '小红书 · 爆款批量仿写', en: 'XHS Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
              })();
              // Track / display name
              const track = TRACK_ICONS[task.track];
              const subTitle = (() => {
                if (isLinkRewriteTwitter) return isZh ? '指定推文链接' : 'Manual tweet URLs';
                if (isXhsLinkMode) return isZh ? '指定链接' : 'Manual XHS links';
                if (track) return track.name_zh;
                return scenario?.name_zh || task.scenario_id;
              })();
              const subIcon = track?.icon || (isXhsLinkMode || isLinkRewriteTwitter ? '🔗' : scenario?.icon || '🔥');
              const personaSnippet = (task.persona || '').trim().split('\n')[0].slice(0, 80);
              const interval = (task as any).run_interval || 'daily_random';

              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenTask(task.id)}
                  className={`w-full text-left rounded-xl border p-4 transition-colors relative ${
                    isRunning
                      ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow'
                      : 'border-gray-200 dark:border-gray-700 hover:border-green-500/50 dark:hover:border-green-500/50 bg-white dark:bg-gray-900'
                  }`}
                >
                  {/* Top row */}
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">
                        {platMeta.icon} {platMeta.label}
                      </span>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeLabel.color}`}>
                        {typeLabel.icon} {isZh ? typeLabel.zh : typeLabel.en}
                      </span>
                      {!isAnyLinkRewrite && (
                        <>
                          <span className="text-lg">{subIcon}</span>
                          <span className="font-medium dark:text-white truncate">{subTitle}</span>
                        </>
                      )}
                      <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
                        #{task.id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isRunning ? (
                        <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          {isZh ? '运行中' : 'Running'}
                        </span>
                      ) : interval === 'once' || isAnyLinkRewrite ? (
                        <span className="text-xs px-2 py-1 rounded bg-purple-500/10 text-purple-500 border border-purple-500/30">
                          ✋ {isZh ? '手动运行' : 'Manual'}
                        </span>
                      ) : (
                        // v4.31.43: 取代"定时运行"/"待命"二态显示 —— scheduler
                        // 实际不区分 active,所有 enabled 任务都到点跑,显示具体的
                        // 下次运行时间更直观。
                        <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">
                          ⏰ {nextRunLabel(task, isZh)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Persona snippet — strip Chinese prefix in EN mode.
                      v4.28.x: 链接仿写场景(x_link_rewrite / binance_from_x_link / XHS link mode)
                      用户根本没填 persona,只有 wizard fallback 默认值,展示出来反而误导
                      ("我没填怎么有身份"用户原话),所以这里跳过。 */}
                  {!isAnyLinkRewrite && personaSnippet && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 truncate">
                      👤 {localizePersonaPrefix(personaSnippet, isZh)}
                    </div>
                  )}
                  {/* Frequency / URL details */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    {isAnyLinkRewrite ? (
                      <>
                        <div>
                          {isZh ? '链接' : 'URLs'}: {taskUrls.length}
                          {isZh ? ' 条' : ''}
                        </div>
                        {taskUrls.slice(0, 2).map((u, i) => (
                          <div key={i} className="truncate text-[11px] text-gray-400">{i + 1}. {u}</div>
                        ))}
                      </>
                    ) : (
                      <div>
                        {isZh ? '频次: ' : 'Frequency: '}
                        {(() => {
                          // v2.4.60: 频次显示按场景类型展示真实用户配置,不再写死 "1 条/次"
                          const sid = task.scenario_id;
                          const t = task as any;
                          const fMin = t.daily_follow_min, fMax = t.daily_follow_max;
                          const rMin = t.daily_reply_min, rMax = t.daily_reply_max;
                          const cMin = t.daily_count_min, cMax = t.daily_count_max;
                          const pMin = t.daily_post_min, pMax = t.daily_post_max;
                          // auto_engage(X 或 Binance):follow + reply 双范围
                          if (sid === 'x_auto_engage' || sid === 'binance_square_auto_engage') {
                            const fStr = (typeof fMin === 'number' && typeof fMax === 'number')
                              ? `${fMin}-${fMax}` : `0-${task.daily_count || 3}`;
                            const rStr = (typeof rMin === 'number' && typeof rMax === 'number')
                              ? `${rMin}-${rMax}` : `${task.daily_count || 1}`;
                            return `⏰ ${scheduleLabel(task, isZh)} · ${isZh ? '关注' : 'Follow'} ${fStr} · ${isZh ? '评论' : 'Reply'} ${rStr}`;
                          }
                          // post_creator(Binance/X)+ binance_from_x_repost:daily_post_min/max
                          if (sid === 'binance_square_post_creator' || sid === 'x_post_creator' || sid === 'binance_from_x_repost') {
                            const pStr = (typeof pMin === 'number' && typeof pMax === 'number' && pMin !== pMax)
                              ? `${pMin}-${pMax}` : String(pMin || pMax || task.daily_count || 1);
                            return `⏰ ${scheduleLabel(task, isZh)} · ${pStr} ${isZh ? '条/次' : '/run'}`;
                          }
                          // XHS auto_reply:用 daily_count_min/max
                          if ((task as any).scenario_id?.includes('auto_reply') ||
                              (typeof cMin === 'number' && typeof cMax === 'number')) {
                            const cStr = (typeof cMin === 'number' && typeof cMax === 'number')
                              ? `${cMin}-${cMax}` : String(task.daily_count || 1);
                            return `⏰ ${scheduleLabel(task, isZh)} · ${cStr} ${isZh ? '篇/次' : 'articles/run'}`;
                          }
                          // 兜底:旧 daily_count 单值
                          return `⏰ ${scheduleLabel(task, isZh)} · ${task.daily_count || 1} ${isZh ? '条/次' : '/run'}`;
                        })()}
                      </div>
                    )}
                    <div className="text-[11px] text-gray-400">
                      {isZh ? '创建于 ' : 'Created '}
                      {new Date(task.created_at || 0).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
