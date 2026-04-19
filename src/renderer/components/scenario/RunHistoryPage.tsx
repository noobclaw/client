/**
 * RunHistoryPage — unified timeline of every run across every task.
 *
 * v2.4.22+ reads from the new `runRecords` persistent store (full task
 * snapshot + step logs + output dir + result counts). Older lightweight
 * "runs" from riskGuard are no longer surfaced — only runs that started
 * with the new schema show up. (Per user request: 老的 if 没记录就算了.)
 *
 * Each row links to RunRecordDetailPage which is a READ-ONLY view of
 * what happened in that single run. Records are immutable — no
 * edit/run/delete buttons (those operations belong to the Task itself,
 * which lives separately).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task } from '../../services/scenario';

interface RunRecord {
  id: string;
  task_id: string;
  task_snapshot: any;
  scenario_snapshot: { id: string; platform: string; name_zh?: string; name_en?: string; icon?: string; workflow_type?: string };
  started_at: number;
  finished_at?: number;
  status: 'running' | 'done' | 'error' | 'stopped';
  error?: string;
  step_logs: Array<{ time: string; step: number; status: 'done' | 'running' | 'error'; message: string }>;
  result?: { collected_count?: number; draft_count?: number; posted?: number; [k: string]: any };
  output_dir?: string;
}

interface Props {
  /** Pre-filtered tasks for the active platform (parent handles the
   *  platform sub-tab and re-filters). */
  tasks: Task[];
  scenarios: Scenario[];
  /** Current platform — used to filter the records list down to
   *  records whose scenario_snapshot.platform matches. */
  platformId: string;
  platformLabel: string;
  /** Click on a record row → opens RunRecordDetailPage. Optional;
   *  no-op when navigation isn't wired up. */
  onOpenRecord?: (record_id: string) => void;
  /** Optional task filter (set when entering history from a specific
   *  task's "查看历史运行记录" button). */
  filterByTaskId?: string | null;
  onClearFilter?: () => void;
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

export const RunHistoryPage: React.FC<Props> = ({
  tasks: _tasks,
  scenarios: _scenarios,
  platformId,
  platformLabel,
  onOpenRecord,
  filterByTaskId,
  onClearFilter,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const recs = await scenarioService.listRunRecords({
        platform: platformId,
        task_id: filterByTaskId || undefined,
      });
      if (cancelled) return;
      setRecords(recs as RunRecord[]);
      setLoading(false);
    };
    void tick();
    // Refresh every 5s — running records will tick their step logs
    const h = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(h); };
  }, [platformId, filterByTaskId]);

  const filteredTaskName = useMemo(() => {
    if (!filterByTaskId) return null;
    // Get the snapshot from the most recent record for that task
    const rec = records.find(r => r.task_id === filterByTaskId);
    if (!rec) return null;
    const sc = rec.scenario_snapshot;
    return (isZh ? sc.name_zh : sc.name_en) || sc.id;
  }, [filterByTaskId, records, isZh]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <section className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold dark:text-white">
              📊 {filterByTaskId
                ? (isZh ? `任务 #${filterByTaskId.slice(0, 8)} 的运行记录` : `Run History · #${filterByTaskId.slice(0, 8)}`)
                : (isZh ? `${platformLabel}运行记录` : `${platformLabel} Run History`)}
            </h2>
            {filterByTaskId && onClearFilter && (
              <button
                type="button"
                onClick={onClearFilter}
                className="mt-1 text-xs text-blue-500 hover:underline"
              >
                ← {isZh ? '查看所有' : 'Show all'}{platformLabel}{isZh ? '运行记录' : 'runs'}
              </button>
            )}
            {filteredTaskName && (
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {isZh ? '任务: ' : 'Task: '}{filteredTaskName}
              </div>
            )}
          </div>
        </div>

        {loading && records.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
            <span className="h-4 w-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
            {isZh ? '加载中...' : 'Loading...'}
          </div>
        ) : records.length === 0 ? (
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
            {records.map(rec => {
              const sc = rec.scenario_snapshot;
              const taskName = (isZh ? sc.name_zh : sc.name_en) || sc.id;
              const duration = rec.finished_at
                ? formatDuration(rec.finished_at - rec.started_at, isZh)
                : null;
              const statusPill = (() => {
                switch (rec.status) {
                  case 'done':    return { icon: '✅', label: isZh ? '成功' : 'Success', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  case 'error':   return { icon: '❌', label: isZh ? '失败' : 'Failed',  color: 'text-red-500 bg-red-500/10 border-red-500/30' };
                  case 'stopped': return { icon: '⏹️', label: isZh ? '已停止' : 'Stopped', color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
                  case 'running': return { icon: '⏳', label: isZh ? '运行中' : 'Running', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  default:        return { icon: '❓', label: rec.status, color: 'text-gray-500 bg-gray-500/10 border-gray-500/30' };
                }
              })();

              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => onOpenRecord && onOpenRecord(rec.id)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    rec.status === 'running'
                      ? 'border-green-500/50 bg-white dark:bg-gray-900 noobclaw-running-glow hover:border-green-500'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-green-500/50'
                  } cursor-pointer`}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusPill.color}`}>
                        {statusPill.icon} {statusPill.label}
                      </span>
                      <span className="text-base shrink-0">{sc.icon || '🤖'}</span>
                      <span className="font-medium dark:text-white truncate">{taskName}</span>
                      <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
                        #{rec.task_id.slice(0, 8)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0">
                      <span>⏱️ {formatTime(rec.started_at, isZh)}</span>
                      {duration && <span>· {duration}</span>}
                    </div>
                  </div>
                  {/* Result summary + error reason */}
                  {(rec.error || rec.result) && (
                    <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                      {rec.error && (
                        <span className="text-amber-600 dark:text-amber-400 mr-2">
                          {rec.error.length > 100 ? rec.error.slice(0, 100) + '...' : rec.error}
                        </span>
                      )}
                      {rec.result && typeof rec.result.collected_count === 'number' && rec.result.collected_count > 0 && (
                        <span className="mr-2">
                          {isZh ? `采集 ${rec.result.collected_count} 条` : `Collected ${rec.result.collected_count}`}
                        </span>
                      )}
                      {rec.result && typeof rec.result.draft_count === 'number' && rec.result.draft_count > 0 && (
                        <span className="mr-2">
                          {isZh ? `产出 ${rec.result.draft_count} 条` : `Produced ${rec.result.draft_count}`}
                        </span>
                      )}
                      {rec.result && typeof rec.result.posted === 'number' && rec.result.posted > 0 && (
                        <span className="mr-2">
                          {isZh ? `发布 ${rec.result.posted} 条` : `Posted ${rec.result.posted}`}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-400">
                        {isZh ? `· ${rec.step_logs.length} 条日志` : `· ${rec.step_logs.length} log entries`}
                      </span>
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
