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
 *   - Task type badge (e.g. 🔥 批量爆款 / 💬 自动回复 / 🐦 自动互动)
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
}

const PLATFORM_META: Record<string, { icon: string; label: string }> = {
  xhs: { icon: '📕', label: '小红书' },
  x: { icon: '🐦', label: '推特' },
};

const WEB3_TRACK_ICONS: Record<string, { icon: string; name_zh: string }> = {
  web3_alpha: { icon: '🎯', name_zh: 'Web3 · Alpha 猎人' },
  web3_defi: { icon: '🏛️', name_zh: 'Web3 · DeFi 用户' },
  web3_meme: { icon: '🎪', name_zh: 'Web3 · Meme 文化' },
  web3_builder: { icon: '🛠️', name_zh: 'Web3 · 建设者' },
  web3_zh_kol: { icon: '📢', name_zh: 'Web3 · 通用 KOL' },
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

export const MyTasksPage: React.FC<Props> = ({ tasks, scenarios, loading, platformLabel, onOpenTask }) => {
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
          <div>
            <h2 className="text-lg font-bold dark:text-white">
              📋 {isZh ? `我的${platformLabel}任务` : `My ${platformLabel} Tasks`}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {isZh
                ? `共 ${tasks.length} 个${platformLabel}任务${runningTaskIds.size > 0 ? `（${runningTaskIds.size} 个运行中）` : ''}，按创建时间排序，运行中置顶`
                : `${tasks.length} ${platformLabel} task(s)${runningTaskIds.size > 0 ? `, ${runningTaskIds.size} running` : ''}; sorted by created date, running pinned to top`}
            </p>
          </div>
        </div>

        {loading && tasks.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {isZh ? '加载中...' : 'Loading...'}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <div className="text-4xl mb-2">📭</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {isZh ? '还没有任务' : 'No tasks yet'}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500">
              {isZh ? '点上面的「✨ 创建自动化运营任务」开始' : 'Click "Create Task" above to start'}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedTasks.map(task => {
              const scenario = scenarioById.get(task.scenario_id);
              const platformId = scenario?.platform || 'xhs';
              const platformMeta = PLATFORM_META[platformId] || { icon: '🤖', label: platformId };
              const isRunning = runningTaskIds.has(task.id);
              // Type badge per scenario id (Twitter has 3 distinct ones,
              // XHS has 2 distinct ones via workflow_type)
              const sid = task.scenario_id;
              const isLinkRewriteTwitter = sid === 'x_link_rewrite';
              const isXhsLinkMode = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0 && platformId === 'xhs');
              const taskUrls: string[] = (task as any).urls || [];
              const typeLabel = (() => {
                if (sid === 'x_auto_engage') return { icon: '🐦', zh: '自动互动', en: 'Auto Engage', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
                if (sid === 'x_post_creator') return { icon: '📝', zh: '每日发推', en: 'Daily Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
                if (sid === 'x_link_rewrite') return { icon: '✍️', zh: '指定推文仿写', en: 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
                if (isXhsLinkMode) return { icon: '🔗', zh: '指定链接改写', en: 'Pick-your-links', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
                if ((scenario?.workflow_type as any) === 'auto_reply') return { icon: '💬', zh: '自动回复', en: 'Auto Reply', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
                return { icon: '🔥', zh: '批量爆款改写', en: 'Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
              })();
              // Track / display name
              const track = WEB3_TRACK_ICONS[task.track];
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
                        {platformMeta.icon} {platformMeta.label}
                      </span>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeLabel.color}`}>
                        {typeLabel.icon} {isZh ? typeLabel.zh : typeLabel.en}
                      </span>
                      {!isLinkRewriteTwitter && (
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
                      ) : interval === 'once' || isLinkRewriteTwitter || isXhsLinkMode ? (
                        <span className="text-xs px-2 py-1 rounded bg-purple-500/10 text-purple-500 border border-purple-500/30">
                          ✋ {isZh ? '手动运行' : 'Manual'}
                        </span>
                      ) : task.active ? (
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
                  {/* Persona snippet */}
                  {personaSnippet && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1 truncate">
                      👤 {personaSnippet}
                    </div>
                  )}
                  {/* Frequency / URL details */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    {isLinkRewriteTwitter || isXhsLinkMode ? (
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
                        ⏰ {scheduleLabel(task, isZh)} · {task.daily_count} {isZh ? '条/次' : '/run'}
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
