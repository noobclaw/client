/**
 * RunHistoryPage — unified timeline of every run across every task.
 *
 * Source: scenarioRiskGuard records each run start / success / failure /
 * skipped. We aggregate those across tasks and show them newest-first
 * with platform filter (XHS / Twitter sub-tabs).
 *
 * Each row shows:
 *   - Started timestamp (relative + absolute)
 *   - Task display name (resolved from task list + scenario list)
 *   - Status pill (✅ 成功 / ❌ 失败 / ⏭️ 跳过 / ⏳ 运行中)
 *   - Duration (if finished)
 *   - Result summary (collected_count / draft_count for posting tasks)
 *   - Click → open the task's detail page
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task } from '../../services/scenario';

interface RunRow {
  task_id: string;
  started_at: number;
  finished_at?: number;
  status: 'success' | 'failure' | 'skipped' | 'running';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
}

interface Props {
  /** Pre-filtered tasks for the active platform (parent handles the
   *  platform sub-tab and re-filters). */
  tasks: Task[];
  scenarios: Scenario[];
  platformLabel: string;
  onOpenTask: (task_id: string) => void;
}

function formatDuration(ms: number, isZh: boolean): string {
  if (ms < 1000) return ms + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + (isZh ? '秒' : 's');
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}${isZh ? '分' : 'm'}${remS > 0 ? `${remS}${isZh ? '秒' : 's'}` : ''}`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}${isZh ? '时' : 'h'}${remM > 0 ? `${remM}${isZh ? '分' : 'm'}` : ''}`;
}

function formatTime(ts: number, isZh: boolean): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

export const RunHistoryPage: React.FC<Props> = ({ tasks, scenarios, platformLabel, onOpenTask }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [allRuns, setAllRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const runs = await scenarioService.getAllRuns();
      if (!cancelled) {
        setAllRuns(runs as RunRow[]);
        setLoading(false);
      }
    };
    void tick();
    // Refresh every 5s — runs can be added at any time by scheduled tasks.
    const h = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(h); };
  }, []);

  // Build a quick task lookup. Then filter runs to only those whose task
  // belongs to this platform. Tasks that have been deleted still show
  // their runs with a "(已删除)" label — historical record is preserved.
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const scenarioById = useMemo(() => new Map(scenarios.map(s => [s.id, s])), [scenarios]);
  const platformTaskIds = useMemo(() => new Set(tasks.map(t => t.id)), [tasks]);

  const platformRuns = useMemo(() => {
    return allRuns.filter(r => platformTaskIds.has(r.task_id));
  }, [allRuns, platformTaskIds]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <section className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold dark:text-white">
              📊 {isZh ? `${platformLabel}运行记录` : `${platformLabel} Run History`}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {isZh
                ? `共 ${platformRuns.length} 条记录，最新在上`
                : `${platformRuns.length} run(s), newest first`}
            </p>
          </div>
        </div>

        {loading && platformRuns.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {isZh ? '加载中...' : 'Loading...'}
          </div>
        ) : platformRuns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <div className="text-4xl mb-2">📜</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {isZh ? `没有${platformLabel}运行记录` : `No ${platformLabel} runs yet`}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500">
              {isZh ? '任务运行后这里会自动出现历史记录' : 'Run history appears here after a task executes'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {platformRuns.map((run, idx) => {
              const task = taskById.get(run.task_id);
              const scenario = task ? scenarioById.get(task.scenario_id) : null;
              const taskDisplayName = (() => {
                if (!task) return (isZh ? '已删除任务' : 'Deleted task') + ' #' + run.task_id.slice(0, 8);
                if (scenario?.name_zh && isZh) return scenario.name_zh;
                if (scenario?.name_en) return scenario.name_en;
                return task.scenario_id;
              })();
              const duration = run.finished_at
                ? formatDuration(run.finished_at - run.started_at, isZh)
                : null;
              const statusPill = (() => {
                switch (run.status) {
                  case 'success':
                    return { icon: '✅', label: isZh ? '成功' : 'Success', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  case 'failure':
                    return { icon: '❌', label: isZh ? '失败' : 'Failed', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                  case 'skipped':
                    return { icon: '⏭️', label: isZh ? '跳过' : 'Skipped', color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
                  case 'running':
                    return { icon: '⏳', label: isZh ? '运行中' : 'Running', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  default:
                    return { icon: '❓', label: run.status, color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
                }
              })();
              const taskExists = !!task;

              return (
                <button
                  key={`${run.task_id}-${run.started_at}-${idx}`}
                  type="button"
                  onClick={() => taskExists && onOpenTask(run.task_id)}
                  disabled={!taskExists}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    taskExists
                      ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-green-500/50 cursor-pointer'
                      : 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 cursor-not-allowed opacity-70'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusPill.color}`}>
                        {statusPill.icon} {statusPill.label}
                      </span>
                      <span className="font-medium dark:text-white truncate">
                        {taskDisplayName}
                      </span>
                      <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
                        #{run.task_id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0">
                      <span>⏱️ {formatTime(run.started_at, isZh)}</span>
                      {duration && <span>· {duration}</span>}
                    </div>
                  </div>
                  {/* Reason / result summary */}
                  {(run.reason || run.collected_count || run.draft_count) && (
                    <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                      {run.reason && (
                        <span className="text-amber-600 dark:text-amber-400 mr-2">
                          {run.reason}
                        </span>
                      )}
                      {typeof run.collected_count === 'number' && run.collected_count > 0 && (
                        <span className="mr-2">
                          {isZh ? `采集 ${run.collected_count} 条` : `Collected ${run.collected_count}`}
                        </span>
                      )}
                      {typeof run.draft_count === 'number' && run.draft_count > 0 && (
                        <span>
                          {isZh ? `产出 ${run.draft_count} 条` : `Produced ${run.draft_count}`}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
