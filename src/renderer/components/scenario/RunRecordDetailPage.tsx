/**
 * RunRecordDetailPage — read-only view of a single historical run.
 *
 * What it shows:
 *   - Header badges (platform + scenario type) — same style as MyTasks
 *   - Status pill + duration
 *   - Result counts (collected / produced / posted)
 *   - Output dir link (click → opens in OS file manager)
 *   - Full step-by-step log timeline (every step + every message)
 *   - Snapshotted task config at run time
 *
 * Per user request: NO edit / re-run / delete operations. Records are
 * immutable history — those operations live on the Task itself, not
 * on the record. Only "view" and "open output dir" are surfaced.
 */

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService } from '../../services/scenario';

interface Props {
  recordId: string;
  onBack: () => void;
  /** Click "查看任务" to jump back to the live task detail (only if
   *  the task still exists — if the user deleted it, this is hidden). */
  onOpenTask?: (task_id: string) => void;
}

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

function fullTime(ts: number, isZh: boolean): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

export const RunRecordDetailPage: React.FC<Props> = ({ recordId, onBack, onOpenTask }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [rec, setRec] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await scenarioService.getRunRecord(recordId);
      if (!cancelled) {
        setRec(r as RunRecord);
        setLoading(false);
      }
    };
    void tick();
    // Refresh while record is still running so the user sees live step logs
    const h = setInterval(() => {
      if (rec?.status === 'running') void tick();
    }, 2000);
    return () => { cancelled = true; clearInterval(h); };
  }, [recordId, rec?.status]);

  const openOutputDir = async () => {
    if (!rec?.output_dir) return;
    try {
      // Reuse the same IPC the task detail page uses — via the platform shell open.
      const w = window as any;
      if (w.electron?.shell?.openPath) {
        await w.electron.shell.openPath(rec.output_dir);
      } else if (w.__TAURI__?.shell?.open) {
        await w.__TAURI__.shell.open(rec.output_dir);
      } else {
        // Fallback: copy path to clipboard so user can navigate manually
        await navigator.clipboard.writeText(rec.output_dir);
        alert((isZh ? '已复制路径到剪贴板：\n' : 'Path copied to clipboard:\n') + rec.output_dir);
      }
    } catch (e) {
      console.error('[RunRecordDetail] openOutputDir failed:', e);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <button type="button" onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← {isZh ? '返回' : 'Back'}
        </button>
        <div className="text-sm text-gray-400 py-6">{isZh ? '加载中...' : 'Loading...'}</div>
      </div>
    );
  }

  if (!rec) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <button type="button" onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← {isZh ? '返回' : 'Back'}
        </button>
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-sm text-gray-500">
          {isZh ? '未找到该运行记录' : 'Run record not found'}
        </div>
      </div>
    );
  }

  const sc = rec.scenario_snapshot;
  const platform = sc.platform === 'x' ? (isZh ? '推特' : 'Twitter')
    : sc.platform === 'xhs' ? (isZh ? '小红书' : 'Xiaohongshu')
    : (sc.platform || '');
  // Same TRACK_ICONS + type-badge logic as MyTasksPage / RunHistoryPage so
  // the detail page header matches the row the user clicked on. Inlined
  // (not imported) to keep this component self-contained — they're tiny.
  const TRACK_ICONS_INLINE: Record<string, { icon: string; name_zh: string }> = {
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
  const trackId = (rec.task_snapshot && rec.task_snapshot.track) || '';
  const trackInfo = TRACK_ICONS_INLINE[trackId];
  const taskName = trackInfo ? trackInfo.name_zh : ((isZh ? sc.name_zh : sc.name_en) || sc.id);
  const taskIcon = trackInfo?.icon || sc.icon || '🤖';
  // Type label
  const typeBadge = (() => {
    const sid = sc.id;
    const wf = sc.workflow_type;
    const taskUrls = (rec.task_snapshot && rec.task_snapshot.urls) || [];
    const isXhsLinkMode = (rec.task_snapshot && rec.task_snapshot.track === 'link_mode')
      || (Array.isArray(taskUrls) && taskUrls.length > 0 && sc.platform === 'xhs');
    if (sid === 'x_auto_engage')   return { icon: '🐦', label: isZh ? '推特自动互动' : 'Twitter Auto Engage', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
    if (sid === 'x_post_creator')  return { icon: '📝', label: isZh ? '推特自动发推' : 'Twitter Auto Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (sid === 'x_link_rewrite')  return { icon: '✍️', label: isZh ? '指定推文仿写' : 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (isXhsLinkMode)             return { icon: '🔗', label: isZh ? '指定链接 · 小红书爆款仿写' : 'XHS Rewrite (URL)', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
    if (wf === 'auto_reply')       return { icon: '💬', label: isZh ? '小红书自动互动' : 'XHS Auto Engage', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    return { icon: '🔥', label: isZh ? '自动批量 · 小红书爆款批量仿写' : 'XHS Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
  })();

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

  // Group step logs by step number for cleaner rendering
  const stepGroups: Record<number, RunRecord['step_logs']> = {};
  for (const log of rec.step_logs) {
    if (!stepGroups[log.step]) stepGroups[log.step] = [];
    stepGroups[log.step].push(log);
  }
  const stepNumbers = Object.keys(stepGroups).map(Number).sort((a, b) => a - b);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button type="button" onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white inline-flex items-center gap-1">
        ← {isZh ? '返回运行记录' : 'Back to history'}
      </button>

      {/* Read-only banner */}
      <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
        🔒 {isZh
          ? '这是历史运行记录的只读快照。要重新运行 / 编辑 / 删除任务，请去对应的任务详情页。'
          : 'Read-only snapshot of a historical run. To re-run / edit / delete the task, go to its task detail page.'}
      </div>

      {/* Header badges */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
          {sc.platform === 'x' ? '🐦' : '📕'} {platform}
        </span>
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${typeBadge.color}`}>
          {typeBadge.icon} {typeBadge.label}
        </span>
        <span className="text-base">{taskIcon}</span>
        <span className="font-bold text-base dark:text-white">{taskName}</span>
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${statusPill.color}`}>
          {statusPill.icon} {statusPill.label}
        </span>
      </div>
      {/* IDs row — both task id and this record's id, in mono font, so
          users can copy/paste them to disambiguate runs in support chat. */}
      <div className="flex items-center gap-3 mb-3 text-[11px] text-gray-500 dark:text-gray-500 font-mono">
        <span>{isZh ? '任务id:' : 'task:'} #{rec.task_id.slice(0, 8)}</span>
        <span>·</span>
        <span>{isZh ? '记录id:' : 'record:'} #{rec.id.slice(0, 8)}</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label={isZh ? '开始' : 'Started'} value={fullTime(rec.started_at, isZh)} />
        <Stat label={isZh ? '结束' : 'Finished'} value={rec.finished_at ? fullTime(rec.finished_at, isZh) : (isZh ? '运行中' : 'Running')} />
        <Stat
          label={isZh ? '耗时' : 'Duration'}
          value={rec.finished_at ? formatDuration(rec.finished_at - rec.started_at, isZh) : '-'}
        />
        <Stat label={isZh ? '日志条目' : 'Log entries'} value={rec.step_logs.length} />
      </div>

      {/* Result + output dir */}
      {(rec.result || rec.output_dir || rec.error) && (
        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-2 text-sm">
          {rec.error && (
            <div className="text-red-500">
              <strong>{isZh ? '错误: ' : 'Error: '}</strong>{rec.error}
            </div>
          )}
          {rec.result && (
            <div className="flex flex-wrap gap-3 text-xs">
              {typeof rec.result.collected_count === 'number' && (
                <span className="text-gray-600 dark:text-gray-300">
                  {isZh ? '采集' : 'Collected'}: <strong>{rec.result.collected_count}</strong>
                </span>
              )}
              {typeof rec.result.draft_count === 'number' && (
                <span className="text-gray-600 dark:text-gray-300">
                  {isZh ? '产出草稿' : 'Drafts'}: <strong>{rec.result.draft_count}</strong>
                </span>
              )}
              {typeof rec.result.posted === 'number' && (
                <span className="text-gray-600 dark:text-gray-300">
                  {isZh ? '已发布' : 'Posted'}: <strong>{rec.result.posted}</strong>
                </span>
              )}
              {typeof (rec.result as any).tokens_used === 'number' && (rec.result as any).tokens_used > 0 && (
                <span className="text-gray-600 dark:text-gray-300" title={isZh ? 'tokens × $/M ≈ USD' : ''}>
                  🪙 Tokens: <strong>{((rec.result as any).tokens_used).toLocaleString()}</strong>
                  {' '}· <strong>≈ ${((rec.result as any).cost_usd || 0).toFixed(4)}</strong></span>
              )}
            </div>
          )}
          {rec.output_dir && (
            <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 pt-1">
              <span>{isZh ? '输出目录:' : 'Output:'}</span>
              <button
                type="button"
                onClick={openOutputDir}
                className="text-blue-500 hover:underline truncate max-w-md text-left"
                title={rec.output_dir}
              >
                📂 {rec.output_dir}
              </button>
            </div>
          )}
          {onOpenTask && (
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => onOpenTask(rec.task_id)}
                className="text-xs text-blue-500 hover:underline"
              >
                → {isZh ? '查看任务详情（编辑 / 重新运行）' : 'Open task detail (edit / re-run)'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step-by-step log timeline */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
        <h3 className="text-sm font-bold dark:text-white mb-3">
          {isZh ? '完整运行明细' : 'Full Run Log'}
        </h3>
        {stepNumbers.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">
            {isZh ? '暂无日志' : 'No logs yet'}
          </div>
        ) : (
          <div className="space-y-4">
            {stepNumbers.map(stepNum => {
              const logs = stepGroups[stepNum];
              const lastStatus = logs[logs.length - 1]?.status || 'running';
              const stepIcon = lastStatus === 'done' ? '✅' : lastStatus === 'error' ? '❌' : '⏳';
              return (
                <div key={stepNum}>
                  <div className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-1.5">
                    {stepIcon} {isZh ? '步骤' : 'Step'} {stepNum}
                  </div>
                  <div className="space-y-1 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                    {logs.map((log, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="text-gray-400 font-mono shrink-0">{log.time}</span>
                        <span className={`shrink-0 ${
                          log.status === 'done' ? 'text-green-500'
                            : log.status === 'error' ? 'text-red-500'
                            : 'text-gray-500'
                        }`}>
                          {log.status === 'done' ? '✓' : log.status === 'error' ? '✗' : '·'}
                        </span>
                        <span className="text-gray-700 dark:text-gray-300 break-all">{log.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2">
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-0.5">{label}</div>
    <div className="text-sm font-semibold dark:text-white truncate" title={String(value)}>{value}</div>
  </div>
);
