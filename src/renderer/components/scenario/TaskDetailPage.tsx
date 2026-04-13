/**
 * TaskDetailPage — two-mode layout based on running state.
 *
 * IDLE mode:  config summary + stats + "直接运行/编辑/删除" buttons
 *             + 3-step "运行明细" all showing "等待"
 *
 * RUNNING mode: config summary + "停止" button only
 *               + 3-step "运行明细" with live progress logs
 *               + active step has blinking "..." on the running line
 */

import React, { useCallback, useEffect, useState } from 'react';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import type { ScenarioRunProgress } from '../../types/scenario';

// Track ID → display name
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

interface Props {
  task: Task;
  scenario: Scenario | null;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
}

const STEP_NAMES = [
  '通过关键词浏览阅读。请勿关闭 Chrome 和小红书。',
  '分析爆款，拆解逻辑',
  '改写图文，并输出结果，本地保存一份，上传到您小红书账号一份',
];

export const TaskDetailPage: React.FC<Props> = ({ task, onBack, onEdit, onChanged }) => {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof scenarioService.getTaskStats>> | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ScenarioRunProgress | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const refresh = useCallback(async () => {
    const [d, s] = await Promise.all([
      scenarioService.listDrafts(task.id),
      scenarioService.getTaskStats(task.id),
    ]);
    setDrafts(d);
    setStats(s);
  }, [task.id]);

  // Poll progress every 2s
  useEffect(() => {
    void refresh();
    const timer = setInterval(async () => {
      const [rid, prog] = await Promise.all([
        scenarioService.getRunningTaskId(),
        scenarioService.getRunProgress(),
      ]);
      const isRunning = rid === task.id;
      setRunning(isRunning);
      if (prog && prog.taskId === task.id) {
        setProgress(prog);
      }
      if (!isRunning && running) {
        // Just finished
        void refresh();
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = (kind: 'ok' | 'warn' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 5000);
  };

  const executeRun = async () => {
    if (running) return;
    setRunning(true);
    setProgress(null);
    try {
      const outcome = await scenarioService.runTaskNow(task.id);
      if (outcome.status === 'ok') {
        showToast('ok', `运行完成：采集 ${outcome.collected_count ?? 0} 条，生成 ${outcome.draft_count ?? 0} 份草稿`);
      } else if (outcome.status === 'skipped') {
        showToast('warn', outcome.reason === 'another_task_running' ? '有另一个任务正在运行，请等它完成后再试' : `已跳过: ${outcome.reason}`);
      } else {
        const reason = outcome.reason || '';
        const friendlyReason = reason === 'scenario_pack_not_found' ? '场景包未找到，请检查网络连接'
          : reason === 'another_task_running' ? '有另一个任务正在运行'
          : reason === 'user_stopped' ? '已手动停止'
          : reason.includes('BROWSER_NOT_CONNECTED') ? '浏览器插件未连接'
          : reason.includes('ANTHROPIC_API_KEY_MISSING') ? 'AI 密钥未设置，请在设置中配置'
          : reason || '未知错误，请查看控制台日志';
        showToast('err', `运行失败: ${friendlyReason}`);
      }
      await refresh();
      await onChanged();
    } finally {
      setRunning(false);
    }
  };

  const handleRunNow = () => {
    if (running) return;
    setLoginModalOpen(true);
  };

  const handleLoginConfirmed = () => {
    setLoginModalOpen(false);
    void executeRun();
  };

  const handleStop = async () => {
    await scenarioService.requestAbort();
    showToast('warn', '已请求停止，当前步骤完成后将终止');
  };

  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 3000);
      return;
    }
    setConfirmingDelete(false);
    await scenarioService.deleteTask(task.id);
    onBack();
    await onChanged();
  };

  const trackName = TRACK_NAMES[task.track] || task.track || task.scenario_id;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back */}
      <button type="button" onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
        ← 返回
      </button>

      {/* Config summary + action buttons */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <div><span className="text-gray-400">赛道:</span> <span className="dark:text-white font-medium">{trackName}</span></div>
            <div>关键词: {task.keywords.join(' · ')}</div>
            <div className="truncate">Persona: {task.persona}</div>
            <div>频次: ⏰ {task.daily_time || '08:00'} · {task.daily_count} 条/天 · {task.variants_per_post} 份仿写</div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {running ? (
              <>
                <span className="text-sm font-semibold text-green-500">运行中</span>
                <button type="button" onClick={handleStop}
                  className="px-3 py-2 text-sm rounded-lg border border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10 transition-colors">
                  停止
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
        }`}>
          {toast.text}
        </div>
      )}

      {/* 运行明细 — 3-step panel */}
      <h2 className="text-base font-bold dark:text-white mb-4">运行明细</h2>

      <div className="space-y-4">
        {STEP_NAMES.map((name, idx) => {
          const stepNum = idx + 1;
          const stepProgress = progress?.steps?.[idx];
          const stepStatus = stepProgress?.status || 'waiting';
          const logs = stepProgress?.logs || [];
          const isActive = stepStatus === 'running';
          const isDone = stepStatus === 'done';
          const isError = stepStatus === 'error';

          return (
            <div key={idx}>
              {/* Step header */}
              <div className={`text-sm font-medium mb-2 ${
                isActive ? 'text-green-500' : isDone ? 'text-green-600 dark:text-green-400' : isError ? 'text-red-500' : 'dark:text-gray-300'
              }`}>
                {stepNum}.{name}
              </div>

              {/* Step body */}
              <div className={`rounded-xl border p-4 min-h-[60px] ${
                isActive ? 'border-green-500/30 bg-green-500/5'
                  : isDone ? 'border-green-500/20 bg-green-500/5'
                  : isError ? 'border-red-500/20 bg-red-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                {logs.length > 0 ? (
                  <div className="space-y-1.5">
                    {logs.map((log, li) => (
                      <div key={li} className="text-xs flex items-start gap-2">
                        <span className={`shrink-0 ${
                          log.status === 'done' ? 'text-green-500' : log.status === 'error' ? 'text-red-500' : 'text-amber-500'
                        }`}>
                          {log.status === 'done' ? '已完成:' : log.status === 'error' ? '错误:' : '进行中:'}
                        </span>
                        <span className="dark:text-gray-300 flex-1">
                          {log.message}
                          {log.status === 'running' && (
                            <span className="inline-block ml-2 animate-pulse text-green-500">......</span>
                          )}
                        </span>
                        <span className="text-gray-500 shrink-0 tabular-nums">{log.time}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400 text-center py-2">
                    {stepNum === 1 && !running
                      ? `等待每日 ${task.daily_time || '08:00'} 定时运行`
                      : '等待前一步'
                    }
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Drafts section (below the 3 steps) */}
      {drafts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-bold dark:text-white mb-4">
            ✍️ 爆款改写结果
            <span className="ml-2 text-xs font-normal text-amber-500">
              {drafts.filter(d => d.status === 'pending').length} 条待审
            </span>
          </h2>
          <div className="text-xs text-gray-400">
            （草稿审核和推送功能开发中）
          </div>
        </section>
      )}

      {/* Login modal */}
      {loginModalOpen && (
        <LoginRequiredModal
          onCancel={() => setLoginModalOpen(false)}
          onConfirmed={handleLoginConfirmed}
        />
      )}
    </div>
  );
};

// ── Sub-components ──

const StatCard: React.FC<{ label: string; value: string | number; small?: boolean }> = ({ label, value, small }) => (
  <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
    <div className={`font-bold dark:text-white ${small ? 'text-sm' : 'text-2xl'}`}>{value}</div>
  </div>
);

export default TaskDetailPage;
