/**
 * TaskDetailPage — layer 3 inside a specific configured task.
 *
 * Shows run stats, run-now button, pause/resume/delete, and the
 * pending-drafts review queue with push-to-draft-box action.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';

// Track ID → display name lookup
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

interface Props {
  task: Task;
  scenario: Scenario | null;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
}

function formatRelative(ts: number | null | undefined): string {
  if (!ts) return i18nService.t('scenarioTaskStatNeverRun');
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.round(hrs / 24);
  return `${days} 天前`;
}

function reasonText(key: string): string {
  const map: Record<string, string> = {
    disabled: 'scenarioTaskReasonDisabled',
    daily_cap_reached: 'scenarioTaskReasonDailyCap',
    interval_not_met: 'scenarioTaskReasonInterval',
    weekly_rest_enforced: 'scenarioTaskReasonWeeklyRest',
    cooldown_active: 'scenarioTaskReasonCooldown',
    another_task_running: 'scenarioTaskReasonAnotherRunning',
  };
  return i18nService.t(map[key] || 'scenarioTaskRunFailed').replace('{reason}', key);
}

export const TaskDetailPage: React.FC<Props> = ({ task, scenario, onBack, onEdit, onChanged }) => {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof scenarioService.getTaskStats>> | null>(null);
  const [running, setRunning] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [pushingDraft, setPushingDraft] = useState<string | null>(null);
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [d, s, r] = await Promise.all([
      scenarioService.listDrafts(task.id),
      scenarioService.getTaskStats(task.id),
      scenarioService.getRunningTaskId(),
    ]);
    setDrafts(d);
    setStats(s);
    setRunningTaskId(r);
    // If THIS task is currently running, keep running state
    if (r === task.id) setRunning(true);
  }, [task.id]);

  useEffect(() => {
    void refresh();
    // Poll running state every 3s while page is open
    const timer = setInterval(async () => {
      const r = await scenarioService.getRunningTaskId();
      setRunningTaskId(r);
      if (r === task.id) {
        setRunning(true);
      } else if (running && !r) {
        // Task just finished
        setRunning(false);
        void refresh(); // Refresh to show new drafts
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = (kind: 'ok' | 'warn' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 5000);
  };

  const executeRun = async () => {
    if (running) return;
    setRunning(true);
    try {
      const outcome = await scenarioService.runTaskNow(task.id);
      if (outcome.status === 'ok') {
        showToast(
          'ok',
          i18nService
            .t('scenarioTaskRunSuccess')
            .replace('{c}', String(outcome.collected_count ?? 0))
            .replace('{d}', String(outcome.draft_count ?? 0))
        );
      } else if (outcome.status === 'skipped') {
        showToast('warn', i18nService.t('scenarioTaskRunSkipped').replace('{reason}', reasonText(outcome.reason || '')));
      } else {
        showToast('err', i18nService.t('scenarioTaskRunFailed').replace('{reason}', outcome.reason || 'unknown'));
      }
      await refresh();
      await onChanged();
    } finally {
      setRunning(false);
    }
  };

  const handleRunNow = async () => {
    if (running) return;
    // Check if another task is already running
    if (runningTaskId && runningTaskId !== task.id) {
      showToast('warn', '有另一个任务正在运行，请等它完成后再试');
      return;
    }
    // Show login modal — user must confirm they're logged in
    setLoginModalReason('check');
  };

  const handleLoginConfirmed = async () => {
    setLoginModalReason(null);
    await executeRun();
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const handleDelete = async () => {
    if (!confirmingDelete) {
      // First click — show "确定？" state, auto-reset after 3s
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 3000);
      return;
    }
    // Second click within 3s — actually delete
    setConfirmingDelete(false);
    await scenarioService.deleteTask(task.id);
    onBack();
    await onChanged();
  };

  const handlePushDraft = async (draftId: string) => {
    if (pushingDraft) return;
    setPushingDraft(draftId);
    try {
      const res = await scenarioService.pushDraft(draftId);
      if (res.status === 'ready_for_user') {
        showToast('ok', i18nService.t('scenarioDraftReadyForUser'));
      } else {
        const reason = res.error || '';
        if (reason === 'not_logged_in') {
          showToast('warn', i18nService.t('scenarioDraftNotLoggedIn'));
        } else {
          showToast('err', i18nService.t('scenarioDraftPushFailed').replace('{reason}', reason));
        }
      }
      await refresh();
    } finally {
      setPushingDraft(null);
    }
  };

  const handleIgnoreDraft = async (draftId: string) => {
    await scenarioService.markDraftIgnored(draftId);
    await refresh();
  };

  const handleDeleteDraft = async (draftId: string) => {
    await scenarioService.deleteDraft(draftId);
    await refresh();
  };

  const pendingDrafts = drafts.filter(d => d.status === 'pending');

  const cooldownHoursLeft =
    stats && stats.cooldown_ends_at > Date.now()
      ? Math.ceil((stats.cooldown_ends_at - Date.now()) / 3_600_000)
      : 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          ← {i18nService.t('scenarioTaskBack')}
        </button>
        <div className="flex items-center gap-2">
          {/* Active toggle */}
          {task.active ? (
            <span className="px-3 py-2 text-xs font-semibold rounded-lg bg-green-500/10 text-green-500 border border-green-500/30">
              ● 定时运行
            </span>
          ) : (
            <button
              type="button"
              onClick={async () => {
                await scenarioService.setActiveTask(task.id);
                await onChanged();
              }}
              className="px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors"
            >
              🎯 设为定时运行
            </button>
          )}
          <button
            type="button"
            onClick={handleRunNow}
            disabled={running}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {running ? i18nService.t('scenarioTaskRunningNow') : '▶ ' + i18nService.t('scenarioTaskRunNow')}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {i18nService.t('scenarioTaskEdit')}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
              confirmingDelete
                ? 'border-red-500 bg-red-500 text-white'
                : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
            }`}
          >
            {confirmingDelete ? '确定删除？' : i18nService.t('scenarioTaskDelete')}
          </button>
        </div>
      </div>

      {/* Config summary (matches the task card display on the list page) */}
      <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1.5">
          <div><span className="text-gray-400">赛道:</span> <span className="dark:text-white font-medium">{TRACK_NAMES[task.track] || task.track || scenario?.name_zh || task.scenario_id}</span></div>
          <div><span className="text-gray-400">关键词:</span> <span className="dark:text-gray-200">{task.keywords.join(' · ')}</span></div>
          <div className="truncate"><span className="text-gray-400">Persona:</span> <span className="dark:text-gray-200">{task.persona}</span></div>
          <div><span className="text-gray-400">频次:</span> <span className="dark:text-gray-200">⏰ {task.daily_time || '08:00'} · {task.daily_count} 条/天 · {task.variants_per_post} 份仿写</span></div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label={i18nService.t('scenarioTaskStatCollected')} value={stats?.runs.reduce((sum, r) => sum + (r.collected_count || 0), 0) ?? 0} />
        <StatCard label={i18nService.t('scenarioTaskStatDraftsGenerated')} value={stats?.draft_count ?? 0} />
        <StatCard label={i18nService.t('scenarioTaskStatDraftsPushed')} value={stats?.pushed_draft_count ?? 0} />
        <StatCard label={i18nService.t('scenarioTaskStatLastRun')} value={formatRelative(stats?.last_run_at || null)} small />
      </div>

      {/* Running indicator panel */}
      {running && (
        <div className="mb-6 rounded-xl border border-green-500/30 bg-green-500/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-semibold text-green-500">正在运行</span>
            </div>
            <button
              type="button"
              onClick={() => {
                // TODO: implement proper stop via scenarioManager
                showToast('warn', '任务将在当前步骤完成后停止');
              }}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
            >
              ⏹ 停止
            </button>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <div>🔍 正在浏览小红书发现页，寻找符合关键词的爆款...</div>
            <div className="text-[11px] text-gray-400">运行期间请保持 Chrome 打开且小红书已登录</div>
          </div>
        </div>
      )}

      {cooldownHoursLeft > 0 && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
          ⏳ {i18nService.t('scenarioTaskCooldownActive').replace('{hours}', String(cooldownHoursLeft))}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`mb-6 rounded-xl px-4 py-3 text-sm ${
            toast.kind === 'ok'
              ? 'bg-green-500/10 border border-green-500/30 text-green-500'
              : toast.kind === 'warn'
                ? 'bg-amber-500/10 border border-amber-500/30 text-amber-500'
                : 'bg-red-500/10 border border-red-500/30 text-red-500'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Drafts */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
          ✍️ 爆款改写结果
          {pendingDrafts.length > 0 && (
            <span className="ml-2 text-xs font-normal text-amber-500">
              {i18nService.t('scenarioCardTaskDraftCount').replace('{n}', String(pendingDrafts.length))}
            </span>
          )}
        </h2>

        {drafts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {i18nService.t('scenarioDraftsEmpty')}
          </div>
        ) : (
          <div className="space-y-4">
            {drafts.map(draft => (
              <DraftCard
                key={draft.id}
                draft={draft}
                pushing={pushingDraft === draft.id}
                onPush={() => handlePushDraft(draft.id)}
                onIgnore={() => handleIgnoreDraft(draft.id)}
                onDelete={() => handleDeleteDraft(draft.id)}
              />
            ))}
          </div>
        )}
      </section>

      {loginModalReason && (
        <LoginRequiredModal
          onCancel={() => setLoginModalReason(null)}
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

interface DraftCardProps {
  draft: Draft;
  pushing: boolean;
  onPush: () => void;
  onIgnore: () => void;
  onDelete: () => void;
}

const DraftCard: React.FC<DraftCardProps> = ({ draft, pushing, onPush, onIgnore, onDelete }) => {
  const { variant, source_post, status } = draft;
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            {i18nService.t('scenarioDraftSourceFrom')}: {source_post.title?.slice(0, 50) || '(untitled)'} · 👍{' '}
            {source_post.metrics?.likes ?? 0}
          </div>
          <div className="font-semibold dark:text-white line-clamp-1">{variant.title}</div>
        </div>
        {status === 'pushed' && (
          <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 shrink-0">
            {i18nService.t('scenarioDraftPushed')}
          </span>
        )}
        {status === 'ignored' && (
          <span className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 shrink-0">
            {i18nService.t('scenarioDraftIgnored')}
          </span>
        )}
      </div>

      <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed mb-3 line-clamp-5">
        {variant.body}
      </div>

      {variant.hashtags && variant.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {variant.hashtags.map((tag, i) => (
            <span
              key={i}
              className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-3">
        <span>
          {i18nService.t('scenarioDraftVariantRoute')}: <span className="text-green-500 font-medium">{variant.route}</span>
        </span>
        <span className="line-clamp-1 ml-4 text-right">{variant.notes_for_user}</span>
      </div>

      {status === 'pending' && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPush}
            disabled={pushing}
            className="flex-1 px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
          >
            🚀 {pushing ? i18nService.t('scenarioDraftPushingBtn') : i18nService.t('scenarioDraftPushBtn')}
          </button>
          <button
            type="button"
            onClick={onIgnore}
            className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {i18nService.t('scenarioDraftIgnoreBtn')}
          </button>
        </div>
      )}

      {status !== 'pending' && (
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-red-500 hover:underline"
        >
          {i18nService.t('scenarioDraftDeleteBtn')}
        </button>
      )}
    </div>
  );
};

export default TaskDetailPage;
