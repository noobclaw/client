/**
 * TaskDetailPage — two-mode layout (idle vs running).
 *
 * State management is simple:
 * - On mount: ask sidecar "is anything running?" → set running state
 * - User clicks "直接运行": ask sidecar → if nothing running, start + set running=true
 * - Poll every 2s: fetch progress logs (for display only, NOT for running state)
 * - When IPC returns (task done): set running=false + show toast
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scenarioService, type Task, type Draft, type Scenario } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';
import type { ScenarioRunProgress } from '../../types/scenario';

const TRACK_NAMES: Record<string, string> = {
  career_side_hustle: '💼 副业 · 打工人赚钱',
  indie_dev: '👩‍💻 独立开发 · 程序员记录',
  personal_finance: '💰 理财 · 记账攻略',
  travel: '✈️ 旅行 · 攻略分享',
  food: '🍲 美食 · 探店做饭',
  outfit: '👗 穿搭 · 风格分享',
  beauty: '💄 美妆 · 产品测评',
  fitness: '💪 健身 · 减脂日记',
  reading: '📚 读书 · 书单笔记',
  parenting: '🧸 育儿 · 亲子日常',
  exam_prep: '🎓 考研 · 备考党',
  pets: '🐱 宠物 · 猫狗日常',
  home_decor: '🏠 家居 · 小屋布置',
  study_method: '🏆 学习 · 效率工具',
  career_growth: '🎯 职场 · 升级打怪',
  emotional_wellness: '🧘 情感 · 心理疗愈',
  photography: '📷 摄影 · 日常记录',
  crafts: '🎨 手工 · DIY',
};

function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '尚未运行';
  const diff = Date.now() - ts;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return `${Math.round(hrs / 24)} 天前`;
}

const STEP_LABELS = ['步骤一', '步骤二'];

// Render log message — make file paths clickable
function renderLogMessage(message: string) {
  // Match paths like /Users/.../NoobClaw/... or C:\Users\...\NoobClaw\...
  const pathMatch = message.match(/(→\s*)([/\\].*NoobClaw[/\\][^\s]*|[A-Z]:[/\\].*NoobClaw[/\\][^\s]*)/);
  if (pathMatch) {
    const before = message.slice(0, message.indexOf(pathMatch[0]));
    const arrow = pathMatch[1];
    const filePath = pathMatch[2];
    return (
      <>
        {before}{arrow}
        <button
          type="button"
          className="text-blue-500 hover:underline cursor-pointer"
          onClick={() => {
            try { window.electron?.shell?.openPath?.(filePath); } catch {}
          }}
        >
          📂 {filePath.split(/[/\\]/).slice(-3).join('/')}
        </button>
      </>
    );
  }
  return message;
}
const STEP_NAMES = [
  '采集爆款文章。请勿切换浏览器标签页。',
  'AI 改写标题和内容，保存到本地',
];

interface Props {
  task: Task;
  scenario: Scenario | null;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
}

export const TaskDetailPage: React.FC<Props> = ({ task, onBack, onEdit, onChanged }) => {
  // ── Core state ──
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ScenarioRunProgress | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const showToast = (kind: 'ok' | 'warn' | 'err', text: string) => {
    if (!mountedRef.current) return;
    setToast({ kind, text });
    setTimeout(() => { if (mountedRef.current) setToast(null); }, 5000);
  };

  // ── Load data on mount ──
  const refreshData = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        scenarioService.listDrafts(task.id).catch(() => []),
        scenarioService.getTaskStats(task.id).catch(() => null),
      ]);
      if (mountedRef.current) { setDrafts(Array.isArray(d) ? d : []); setStats(s); }
    } catch {}
  }, [task.id]);

  // ── Check running state on mount (ONE TIME) ──
  useEffect(() => {
    void refreshData();
    // Check if this task or any task is already running
    scenarioService.getRunningTaskId().then(rid => {
      if (mountedRef.current && rid === task.id) setRunning(true);
    }).catch(() => {});
  }, [refreshData, task.id]);

  // ── Poll progress logs every 2s (display only, NOT for running state) ──
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const prog = await scenarioService.getRunProgress().catch(() => null);
        if (mountedRef.current && prog && prog.taskId === task.id) {
          setProgress(prog);
          // If progress says "done" or "error", task has finished
          if (prog.status === 'done') {
            setRunning(false);
            setStopping(false);
            // Count results from step logs
            const step3Logs = prog.steps[2]?.logs || [];
            const draftLog = step3Logs.find((l: any) => l.message?.includes('已保存'));
            showToast('ok', draftLog?.message || '运行完成');
            void refreshData();
            void onChanged();
          } else if (prog.status === 'error') {
            setRunning(false);
            setStopping(false);
            const err = prog.error || '';
            if (err === 'user_stopped') {
              // User explicitly hit stop — confirm it worked.
              showToast('ok', '已停止运行');
            } else {
              showToast('err', `运行失败: ${
                err.includes('scenario_pack') ? '场景包未找到' :
                err.includes('anomaly:captcha') ? '遇到验证码，请手动处理后重试' :
                err.includes('anomaly:rate_limited') ? '操作过于频繁，请稍后再试' :
                err.includes('anomaly:login_wall') ? '需要重新登录小红书' :
                err.includes('anomaly:account_flag') ? '账号异常，请检查小红书账号状态' :
                err || '未知错误'
              }`);
            }
            void refreshData();
            void onChanged();
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [running, task.id, refreshData]);

  // ── Actions ──
  const handleRunNow = async () => {
    if (running) return;

    // 1. Wallet check
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }

    // 2. Check if ANOTHER task is already running
    try {
      const rid = await scenarioService.getRunningTaskId().catch(() => null);
      if (rid && rid !== task.id) {
        showToast('warn', '有另一个任务正在运行，请先停掉再运行这个');
        return;
      }
    } catch {}

    // 3. Show login check modal
    setLoginModalOpen(true);
  };

  const handleLoginConfirmed = () => {
    setLoginModalOpen(false);
    // 4. Start! Set running IMMEDIATELY — don't wait for IPC
    setRunning(true);
    setProgress(null);

    // 5. Fire IPC — returns immediately with { status: 'started' }.
    //    The actual task runs in the sidecar background; we track it via
    //    getRunProgress polling (already running every 2s while running=true).
    //    When progress.status becomes 'done' or 'error', we stop running.
    scenarioService.runTaskNow(task.id).then(async (outcome) => {
      if (!mountedRef.current) return;
      if (outcome.status === 'started' || outcome.status === 'ok') {
        // Task launched (or finished instantly) — progress polling handles the rest
        return;
      } else if (outcome.status === 'skipped') {
        showToast('warn', `已跳过: ${outcome.reason}`);
        setRunning(false);
      } else {
        const r = outcome.reason || '';
        showToast('err', `运行失败: ${
          r.includes('scenario_pack') ? '场景包未找到' :
          r.includes('task_not_found') ? '任务未找到' :
          r.includes('BROWSER') ? '浏览器插件未连接' :
          r.includes('API_KEY') ? 'AI 密钥未设置' :
          r || '未知错误'
        }`);
        setRunning(false);
      }
    }).catch(() => {
      if (mountedRef.current) { showToast('err', '运行异常'); setRunning(false); }
    });
  };

  const [stopping, setStopping] = useState(false);
  const handleStop = async () => {
    setStopping(true);
    try {
      await scenarioService.requestAbort();
      showToast('warn', '正在停止，请稍候...');
    } catch {
      showToast('err', '停止请求失败');
      setStopping(false);
    }
  };

  const handleDelete = async () => {
    // Check if THIS task is running
    try {
      const rid = await scenarioService.getRunningTaskId().catch(() => null);
      if (rid === task.id) {
        showToast('warn', '该任务正在运行中，请先停止再删除');
        return;
      }
    } catch {}
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => { if (mountedRef.current) setConfirmingDelete(false); }, 3000);
      return;
    }
    setConfirmingDelete(false);
    await scenarioService.deleteTask(task.id);
    onBack();
    await onChanged();
  };

  const trackName = TRACK_NAMES[task.track] || task.track || task.scenario_id;

  // ── Render ──
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button type="button" onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
        ← 返回
      </button>

      {/* Config + actions */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <div className="flex items-center gap-3">
              <span className="text-gray-400">赛道:</span>
              <span className="dark:text-white font-medium">{trackName}</span>
              <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
            </div>
            <div>关键词: {task.keywords.join(' · ')}</div>
            <div className="truncate">Persona: {task.persona}</div>
            <div>频次: ⏰ {task.daily_time || '08:00'} · {task.daily_count} 条/天 · {task.variants_per_post} 份仿写</div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {running ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-green-500">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {stopping ? '正在停止...' : '运行中'}
                </span>
                <button type="button" onClick={handleStop}
                  disabled={stopping}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    stopping
                      ? 'border-gray-300 dark:border-gray-700 text-gray-400 cursor-not-allowed'
                      : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
                  }`}>
                  {stopping ? (
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-3 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" />
                      停止中
                    </span>
                  ) : '停止'}
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-400">
                  {task.active ? `每日 ${task.daily_time || '08:00'} 定时运行` : '待命'}
                </span>
                <button type="button" onClick={handleRunNow}
                  className="px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors">
                  直接运行
                </button>
                <button type="button" onClick={onEdit}
                  className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                  编辑
                </button>
                <button type="button" onClick={handleDelete}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    confirmingDelete ? 'border-red-500 bg-red-500 text-white' : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
                  }`}>
                  {confirmingDelete ? '确定删除？' : '删除'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="累计采集" value={Array.isArray(stats?.runs) ? stats.runs.reduce((s: number, r: any) => s + (r.collected_count || 0), 0) : 0} />
        <StatCard label="生成草稿" value={stats?.draft_count ?? 0} />
        <StatCard label="已推送" value={stats?.pushed_draft_count ?? 0} />
        <StatCard label="上次运行" value={formatRelative(stats?.last_run_at || null)} small />
      </div>

      {/* Toast */}
      {toast && (
        <div className={`mb-4 rounded-xl px-4 py-3 text-sm ${
          toast.kind === 'ok' ? 'bg-green-500/10 border border-green-500/30 text-green-500'
            : toast.kind === 'warn' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-500'
            : 'bg-red-500/10 border border-red-500/30 text-red-500'
        }`}>{toast.text}</div>
      )}

      {/* 运行明细 */}
      <h2 className="text-base font-bold dark:text-white mb-4">运行明细</h2>
      <div className="space-y-4">
        {STEP_NAMES.map((name, idx) => {
          const stepNum = idx + 1;
          const sp = progress?.steps?.[idx];
          const status = sp?.status || 'waiting';
          const logs = sp?.logs || [];
          const isActive = status === 'running';
          const isDone = status === 'done';
          const isError = status === 'error';

          return (
            <div key={idx}>
              <div className={`text-sm font-medium mb-2 ${
                isActive ? 'text-green-500' : isDone ? 'text-green-600 dark:text-green-400' : isError ? 'text-red-500' : 'dark:text-gray-300'
              }`}>
                {STEP_LABELS[idx]}. {name}
              </div>
              <div className={`rounded-xl border min-h-[60px] ${
                isActive ? 'border-green-500/30 bg-green-500/5'
                  : isDone ? 'border-green-500/20 bg-green-500/5'
                  : isError ? 'border-red-500/20 bg-red-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                {logs.length > 0 ? (
                  <div
                    className="overflow-y-auto p-3 space-y-1"
                    style={{ maxHeight: '160px' }}
                    ref={(el) => { if (el && isActive) el.scrollTop = el.scrollHeight; }}
                  >
                    {logs.map((log, li) => {
                      const isLast = li === logs.length - 1 && isActive;
                      return (
                        <div key={li} className="text-xs flex items-start gap-2">
                          <span className={`shrink-0 font-medium ${
                            log.status === 'done' ? 'text-green-500' : log.status === 'error' ? 'text-red-500' : 'text-amber-500'
                          }`}>
                            {log.status === 'done' ? '✓' : log.status === 'error' ? '✗' : '›'}
                          </span>
                          <span className={`flex-1 ${log.status === 'done' ? 'text-gray-500 dark:text-gray-400' : 'dark:text-gray-300'}`}>
                            {renderLogMessage(log.message)}
                            {isLast && log.status === 'running' && (
                              <span className="inline-block ml-1 text-green-500 animate-pulse">...</span>
                            )}
                          </span>
                          <span className="text-gray-500 dark:text-gray-600 shrink-0 tabular-nums text-[10px]">{log.time}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400 text-center py-4">
                    {stepNum === 1 && !running ? `等待每日 ${task.daily_time || '08:00'} 定时运行` : '等待前一步'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Drafts */}
      {drafts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-bold dark:text-white mb-4">
            ✍️ 爆款改写结果
            <span className="ml-2 text-xs font-normal text-amber-500">
              {drafts.filter(d => d.status === 'pending').length} 条待审
            </span>
          </h2>
          <div className="text-xs text-gray-400">（草稿审核和推送功能开发中）</div>
        </section>
      )}

      {loginModalOpen && (
        <LoginRequiredModal
          onCancel={() => setLoginModalOpen(false)}
          onConfirmed={handleLoginConfirmed}
        />
      )}
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: string | number; small?: boolean }> = ({ label, value, small }) => (
  <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
    <div className={`font-bold dark:text-white ${small ? 'text-sm' : 'text-2xl'}`}>{value}</div>
  </div>
);

export default TaskDetailPage;
