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
  status: 'running' | 'done' | 'partial' | 'error' | 'stopped';
  error?: string;
  step_logs: Array<{ time: string; step: number; status: 'done' | 'running' | 'error'; message: string }>;
  result?: { collected_count?: number; draft_count?: number; posted?: number; [k: string]: any };
  output_dir?: string;
}

// Same lookup as MyTasksPage so XHS records show "💼 副业" instead of
// the generic scenario name. Twitter web3 tracks + XHS niche tracks.
const TRACK_ICONS: Record<string, { icon: string; name_zh: string }> = {
  web3_alpha: { icon: '🎯', name_zh: 'Web3 · Alpha 猎人' },
  web3_defi: { icon: '🏛️', name_zh: 'Web3 · DeFi 用户' },
  web3_meme: { icon: '🎪', name_zh: 'Web3 · Meme 文化' },
  web3_builder: { icon: '🛠️', name_zh: 'Web3 · 建设者' },
  web3_zh_kol: { icon: '📢', name_zh: 'Web3 · 通用 KOL' },
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

function typeLabelForRecord(rec: RunRecord, isZh: boolean): { icon: string; label: string; color: string } {
  const sid = rec.scenario_snapshot.id;
  const wf = rec.scenario_snapshot.workflow_type;
  const taskUrls = (rec.task_snapshot && rec.task_snapshot.urls) || [];
  const isXhsLinkMode = (rec.task_snapshot && rec.task_snapshot.track === 'link_mode')
    || (Array.isArray(taskUrls) && taskUrls.length > 0 && rec.scenario_snapshot.platform === 'xhs');
  if (sid === 'x_auto_engage')   return { icon: '🐦', label: isZh ? '推特自动互动' : 'Twitter Auto Engage', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
  if (sid === 'x_post_creator')  return { icon: '📝', label: isZh ? '推特自动发推' : 'Twitter Auto Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
  if (sid === 'x_link_rewrite')  return { icon: '✍️', label: isZh ? '指定推文仿写' : 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
  if (isXhsLinkMode)             return { icon: '🔗', label: isZh ? '指定链接 · 小红书爆款仿写' : 'XHS Rewrite (URL)', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
  if (wf === 'auto_reply')       return { icon: '💬', label: isZh ? '小红书自动互动' : 'XHS Auto Engage', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
  return { icon: '🔥', label: isZh ? '自动批量 · 小红书爆款批量仿写' : 'XHS Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
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
  // ── Pagination (v2.4.27) ──
  // Run records max out at 500 server-side. With one heavy user
  // (multiple daily tasks × weeks of history) the unpaginated list
  // got long enough to scroll forever — added 20-per-page client-side
  // pagination. Reset to page 1 whenever filter / platform changes.
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [platformId, filterByTaskId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const recs = await scenarioService.listRunRecords({
        platform: platformId,
        task_id: filterByTaskId || undefined,
        // v2.4.35: ask for the lightweight payload — list page only
        // needs summary fields; full step_logs fetched by detail page.
        // Without this, 50+ records × 500 step_logs made each 2s poll
        // transfer multi-MB, which felt like "记录很久才出现".
        light: true,
      });
      if (cancelled) return;
      // History page shows ONLY completed records — per user request:
      // "历史记录中不放进行中的，只放有结果的". Live "running" tasks are
      // already visible (with the green pulse glow) on the My Tasks page.
      const finished = (recs as RunRecord[]).filter(r => r.status !== 'running');
      setRecords(finished);
      setLoading(false);
    };
    void tick();
    // Refresh every 2s (was 5s pre-2.4.34) — combined with backend
    // debounced-persist fix this gives near-instant "刚跑完的任务出现
    // 在历史" UX. listRunRecords IPC reads in-memory only so polling
    // faster is cheap (no extra disk I/O).
    const h = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(h); };
  }, [platformId, filterByTaskId]);

  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  // Clamp page in case the records list shrank below the current page
  // (e.g. user switched to a less-active platform).
  const safePage = Math.min(page, totalPages);
  const pagedRecords = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return records.slice(start, start + PAGE_SIZE);
  }, [records, safePage]);

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
            {pagedRecords.map(rec => {
              const sc = rec.scenario_snapshot;
              const trackId = (rec.task_snapshot && rec.task_snapshot.track) || '';
              const trackInfo = TRACK_ICONS[trackId];
              const typeBadge = typeLabelForRecord(rec, isZh);
              // Display name: prefer track (matches MyTasksPage), fall back to
              // generic scenario name, then to id.
              const displayName = trackInfo
                ? trackInfo.name_zh
                : ((isZh ? sc.name_zh : sc.name_en) || sc.id);
              const displayIcon = trackInfo?.icon || sc.icon || '🤖';
              const duration = rec.finished_at
                ? formatDuration(rec.finished_at - rec.started_at, isZh)
                : null;
              const statusPill = (() => {
                switch (rec.status) {
                  case 'done':    return { icon: '✅', label: isZh ? '成功' : 'Success', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
                  case 'partial': return { icon: '⚠️', label: isZh ? '部分成功' : 'Partial', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
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
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusPill.color}`}>
                        {statusPill.icon} {statusPill.label}
                      </span>
                      <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeBadge.color}`}>
                        {typeBadge.icon} {typeBadge.label}
                      </span>
                      <span className="text-base shrink-0">{displayIcon}</span>
                      <span className="font-medium dark:text-white truncate">{displayName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 flex-wrap">
                      <span>⏱️ {formatTime(rec.started_at, isZh)}</span>
                      {duration && <span>· {duration}</span>}
                      {/* v2.4.37: AI cost per run — ALWAYS show (was
                          gated on tokens_used > 0, which meant runs that
                          failed before calling AI had no cost column and
                          users thought the feature wasn't working).
                          Failed / no-AI runs now show "💎 —" with a
                          tooltip explaining no AI was called. */}
                      {(() => {
                        const tokens = Number(rec.result?.tokens_used) || 0;
                        const cost = Number((rec.result as any)?.cost_usd) || 0;
                        return (
                          <span title={isZh ? 'AI Token × 每百万单价 ≈ 美金' : 'tokens × $/M ≈ USD'}>
                            · 💎 {tokens.toLocaleString()} ≈ ${cost.toFixed(4)}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  {/* IDs row — both task id and record id so users can
                      tell separate runs of the same task apart. */}
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500 dark:text-gray-500 font-mono">
                    <span>{isZh ? '任务id:' : 'task:'} #{rec.task_id.slice(0, 8)}</span>
                    <span>·</span>
                    <span>{isZh ? '记录id:' : 'record:'} #{rec.id.slice(0, 8)}</span>
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
            {/* Pagination controls — only show when there's > 1 page.
                Shows: « 上一页 · "第 N / 总 页 (共 M 条)" · 下一页 » */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4 text-xs">
                <button
                  type="button"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-green-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  « {isZh ? '上一页' : 'Prev'}
                </button>
                <span className="text-gray-500 dark:text-gray-400 min-w-[120px] text-center">
                  {isZh
                    ? `第 ${safePage} / ${totalPages} 页（共 ${records.length} 条）`
                    : `Page ${safePage} / ${totalPages} (${records.length} total)`}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-green-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isZh ? '下一页' : 'Next'} »
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
