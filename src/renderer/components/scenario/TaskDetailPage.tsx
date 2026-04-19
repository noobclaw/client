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
import { i18nService } from '../../services/i18n';
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

function formatRelative(ts: number | null | undefined, isZh: boolean): string {
  if (!ts) return isZh ? '尚未运行' : 'Not run yet';
  const diff = Date.now() - ts;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return isZh ? '刚刚' : 'Just now';
  if (mins < 60) return isZh ? `${mins} 分钟前` : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return isZh ? `${hrs} 小时前` : `${hrs} hr ago`;
  return isZh ? `${Math.round(hrs / 24)} 天前` : `${Math.round(hrs / 24)} d ago`;
}

const STEP_LABELS_ZH = ['步骤一', '步骤二', '步骤三', '步骤四'];
const STEP_LABELS_EN = ['Step 1', 'Step 2', 'Step 3', 'Step 4'];

// CSS for typing blink animation
const typingStyle = document.createElement('style');
typingStyle.textContent = `
  .typing-animation {
    display: inline;
  }
  .typing-animation::after {
    content: '▌';
    animation: blink 1s step-end infinite;
    color: #22c55e;
    margin-left: 2px;
  }
  @keyframes blink {
    50% { opacity: 0; }
  }
`;
if (!document.getElementById('typing-anim-style')) {
  typingStyle.id = 'typing-anim-style';
  document.head.appendChild(typingStyle);
}

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
const STEP_NAMES_ZH = [
  '采集爆款文章。请勿切换浏览器标签页。',
  'AI 改写标题和内容，保存到本地',
  'AI 生成图片，保存到本地',
  '上传到小红书草稿箱。请勿切换浏览器标签页。',
];
const STEP_NAMES_EN = [
  'Scrape trending articles. Do not switch browser tabs.',
  'AI rewrites titles & content, saved locally',
  'AI generates images, saved locally',
  'Upload to Xiaohongshu drafts. Do not switch browser tabs.',
];
// Auto-reply: 3 steps now. Step 2 contains the entire per-article loop
// (read → AI → post → next), step 3 saves the run report to disk.
const STEP_NAMES_AUTOREPLY_ZH = [
  '搜索关键词 + 应用筛选条件 (最多评论 / 一周内 / 不限文章类型) + 采集候选 URL',
  '逐篇闭环：进入文章 → 读标题/正文/Top3 高赞评论 → AI 生成 → 发文章评论 + 间歇逐条回复 → 全部发完才换下一篇',
  '生成 Markdown 报告（含每篇文章标题/链接/我发的评论与回复）保存到本地任务目录',
];
const STEP_NAMES_AUTOREPLY_EN = [
  'Search + apply filters (most-commented / last week / any type) + collect candidate URLs',
  'Per-article loop: enter article → read title/body/top-3 comments → AI → post note + replies (with jitter) → next',
  'Save Markdown report (titles, links, posted note + replies) to the local task folder',
];

interface Props {
  task: Task;
  scenario: Scenario | null;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
}

export const TaskDetailPage: React.FC<Props> = ({ task, scenario, onBack, onEdit, onChanged }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  // 链接模式是一次性手动运行，没有"下次运行"的概念
  const isLinkModeForStats = task.track === 'link_mode'
    || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
  // Auto-reply tasks have a different step narrative and don't produce
  // local drafts (replies post directly), so the upload-mode badge and
  // the manual-upload step variant don't apply to them.
  const isAutoReplyTask = (scenario?.workflow_type as any) === 'auto_reply';
  const STEP_LABELS = isZh ? STEP_LABELS_ZH : STEP_LABELS_EN;
  const STEP_NAMES = isAutoReplyTask
    ? (isZh ? STEP_NAMES_AUTOREPLY_ZH : STEP_NAMES_AUTOREPLY_EN)
    : (isZh ? STEP_NAMES_ZH : STEP_NAMES_EN);
  // ── Core state ──
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ScenarioRunProgress | null>(null);
  const [, setDrafts] = useState<Draft[]>([]);
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
        ← {isZh ? '返回' : 'Back'}
      </button>

      {/* Config + actions */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            {(() => {
              const isLinkMode = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
              const taskUrls: string[] = (task as any).urls || [];
              return (
                <>
                  <div className="flex items-center gap-3">
                    <span className="text-gray-400">{isZh ? '赛道:' : 'Track:'}</span>
                    <span className="dark:text-white font-medium">
                      {isLinkMode
                        ? (isZh ? '🔗 指定链接 · 小红书爆款仿写' : '🔗 Pick-your-links · XHS rewrite')
                        : trackName}
                    </span>
                    <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
                  </div>
                  {isLinkMode ? (
                    <>
                      <div>{isZh ? '原文链接' : 'Source URLs'}: {taskUrls.length} {isZh ? '个' : ''}</div>
                      {taskUrls.map((u, i) => (
                        <div key={i} className="flex items-start gap-2 pl-4 text-[11px]">
                          <span className="text-gray-500 shrink-0 pt-0.5">{i + 1}.</span>
                          {/* break-all so 长链接能换行展示而不是被截断 */}
                          <span className="text-gray-400 break-all flex-1 min-w-0">{u}</span>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(u);
                                showToast('ok', isZh ? '已复制链接' : 'Link copied');
                              } catch {
                                showToast('err', isZh ? '复制失败' : 'Copy failed');
                              }
                            }}
                            className="shrink-0 px-2 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-700 text-gray-500 hover:text-purple-500 hover:border-purple-500/50 transition-colors"
                            title={isZh ? '复制链接' : 'Copy URL'}
                          >
                            📋 {isZh ? '复制' : 'Copy'}
                          </button>
                        </div>
                      ))}
                      <div>{isZh ? '运行模式' : 'Mode'}: ✋ {isZh ? '一次性手动运行' : 'Manual one-shot'}</div>
                    </>
                  ) : (
                    <>
                      <div>{isZh ? '关键词' : 'Keywords'}: {task.keywords.join(' · ')}</div>
                      <div>{isZh ? '频次' : 'Schedule'}: ⏰ {(isZh ? { '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', 'daily': '每天 ' + (task.daily_time || '08:00'), 'daily_random': '每日随机时间一次' } : { '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h', 'daily': 'Daily ' + (task.daily_time || '08:00'), 'daily_random': 'Once daily (random time)' } as Record<string, string>)[(task as any).run_interval || 'daily'] || (isZh ? '每天 ' : 'Daily ') + (task.daily_time || '08:00')} · {task.daily_count} {isZh ? '条/次' : '/run'}</div>
                    </>
                  )}
                </>
              );
            })()}
            <div>{isZh ? '创建时间' : 'Created'}: {new Date(task.created_at).toLocaleString()}</div>
            {/* Output folder link — for auto_reply this contains the run-report
                Markdown; for viral_production this contains the rewrite drafts
                + images. Either way it's the place to look for what was produced. */}
            <div className="flex items-center gap-1">
              <span>{isZh ? '输出目录:' : 'Output:'}</span>
              <button type="button" onClick={async () => {
                try {
                  const res = await window.electron?.scenario?.getTaskDir?.(task.id);
                  const dir = typeof res === 'string' ? res : res?.dir;
                  if (dir) window.electron?.shell?.openPath?.(dir);
                } catch {}
              }} className="text-blue-500 hover:underline text-[11px]">
                {isZh
                  ? (isAutoReplyTask ? '📂 打开报告文件夹' : '📂 打开输出文件夹')
                  : '📂 Open folder'}
              </button>
            </div>
            {isAutoReplyTask && task.persona && (
              <div className="text-[11px] text-gray-400 leading-relaxed">
                <span className="text-gray-500">{isZh ? '人设:' : 'Persona:'}</span>{' '}
                <span className="italic">{task.persona.length > 120 ? task.persona.slice(0, 120) + '...' : task.persona}</span>
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {running ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-green-500">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {stopping ? (isZh ? '正在停止...' : 'Stopping...') : (isZh ? '运行中' : 'Running')}
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
                      {isZh ? '停止中' : 'Stopping'}
                    </span>
                  ) : (isZh ? '停止' : 'Stop')}
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-400">
                  {isLinkModeForStats
                    ? (isZh ? '✋ 一次性手动' : '✋ Manual one-shot')
                    : task.active ? (() => {
                        const interval = (task as any).run_interval || 'daily';
                        const map: Record<string, string> = isZh
                          ? { '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', 'daily': '每天 ' + (task.daily_time || '08:00'), 'daily_random': '每日随机时间一次' }
                          : { '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h', 'daily': 'Daily ' + (task.daily_time || '08:00'), 'daily_random': 'Once daily (random time)' };
                        return (map[interval] || (isZh ? '每天' : 'Daily')) + (isZh ? ' 自动运行' : ' Scheduled');
                      })() : (isZh ? '待命' : 'Standby')}
                </span>
                <button type="button" onClick={handleRunNow}
                  className="px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors">
                  {isZh ? '直接运行' : 'Run Now'}
                </button>
                <button type="button" onClick={onEdit}
                  className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                  {isZh ? '编辑' : 'Edit'}
                </button>
                <button type="button" onClick={handleDelete}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    confirmingDelete ? 'border-red-500 bg-red-500 text-white' : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
                  }`}>
                  {confirmingDelete ? (isZh ? '确定删除？' : 'Confirm?') : (isZh ? '删除' : 'Delete')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stats — link-mode tasks are one-shot so the "下次运行" stat is
           meaningless; show only the first four for them. */}
      <div className={`grid grid-cols-2 ${isLinkModeForStats ? 'sm:grid-cols-3' : 'sm:grid-cols-4'} gap-3 mb-6`}>
        <StatCard label={isZh ? '累计采集' : 'Collected'} value={Array.isArray(stats?.runs) ? stats.runs.reduce((s: number, r: any) => s + (r.collected_count || 0), 0) : 0} />
        <StatCard label={isZh ? '生成草稿' : 'Drafts'} value={stats?.draft_count ?? 0} />
        <StatCard label={isZh ? '已推送' : 'Pushed'} value={stats?.pushed_draft_count ?? 0} />
        <StatCard label={isZh ? '上次运行' : 'Last Run'} value={formatRelative(stats?.last_run_at || null, isZh)} small />
        {!isLinkModeForStats && (
          <StatCard label={isZh ? '下次运行' : 'Next Run'} value={(() => {
            if (!task.active) return isZh ? '待命' : 'Standby';
            const interval = (task as any).run_interval || 'daily';
            const lastRun = stats?.last_run_at;
            if (!lastRun) return isZh ? '即将' : 'Soon';
            const intervals: Record<string, number> = { '30min': 30*60*1000, '1h': 60*60*1000, '3h': 3*60*60*1000, '6h': 6*60*60*1000, 'daily': 24*60*60*1000, 'daily_random': 24*60*60*1000 };
            const ms = intervals[interval] || 24*60*60*1000;
            const next = lastRun + ms;
            if (next <= Date.now()) return isZh ? '即将' : 'Soon';
            const diff = next - Date.now();
            const mins = Math.round(diff / 60000);
            if (mins < 60) return mins + (isZh ? ' 分钟后' : ' min');
            return Math.round(mins / 60) + (isZh ? ' 小时后' : ' hr');
          })()} small />
        )}
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
      {(() => {
        const autoUploadMode = (task as any).auto_upload !== false;
        // Auto-reply mode has no draft/upload concept — skip the badge.
        const showUploadBadge = !isAutoReplyTask;
        return (
          <>
            <div className="flex items-center justify-between mb-4 gap-3">
              <h2 className="text-base font-bold dark:text-white">{isZh ? '运行明细' : 'Run Details'}</h2>
              {showUploadBadge ? (
                <span className={`text-xs px-2.5 py-1 rounded-full border ${autoUploadMode ? 'bg-green-500/10 text-green-500 border-green-500/30' : 'bg-blue-500/10 text-blue-500 border-blue-500/30'}`}>
                  {autoUploadMode
                    ? (isZh ? '📤 自动上传到草稿箱' : '📤 Auto-upload')
                    : (isZh ? '📁 仅生成保存本地' : '📁 Generate only')}
                </span>
              ) : (
                <span className="text-xs px-2.5 py-1 rounded-full border bg-cyan-500/10 text-cyan-500 border-cyan-500/30">
                  💬 {isZh ? '直接发布到小红书' : 'Posts directly to XHS'}
                </span>
              )}
            </div>
            <div className="space-y-4">
              {STEP_NAMES.map((n, i) => ({ name: n, idx: i })).map(({ name, idx }) => {
          const stepNum = idx + 1;
          const sp = progress?.steps?.[idx];
          const status = sp?.status || 'waiting';
          const logs = sp?.logs || [];
          const isActive = status === 'running';
          const isDone = status === 'done';
          const isError = status === 'error';

          // 仅生成模式的 step 4：不跑上传，替换为"手动上传指引 + 打开目录按钮"。
          // 自动回复模式没有草稿概念，永远不进入此分支。
          const isManualUploadStep = !isAutoReplyTask && stepNum === 4 && !autoUploadMode;
          const displayName = isManualUploadStep
            ? (isZh ? '请在本地手动上传到小红书草稿箱' : 'Manually upload from local folder')
            : name;
          return (
            <div key={idx}>
              <div className={`text-sm font-medium mb-2 ${
                isActive ? 'text-green-500' : isDone ? 'text-green-600 dark:text-green-400' : isError ? 'text-red-500' : 'dark:text-gray-300'
              }`}>
                {STEP_LABELS[idx]}. {displayName}
              </div>
              <div className={`rounded-xl border min-h-[60px] ${
                isManualUploadStep ? 'border-blue-500/30 bg-blue-500/5'
                  : isActive ? 'border-green-500/30 bg-green-500/5'
                  : isDone ? 'border-green-500/20 bg-green-500/5'
                  : isError ? 'border-red-500/20 bg-red-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                {isManualUploadStep ? (
                  <div className="p-4 text-xs dark:text-gray-300 space-y-2">
                    <p>{isZh ? '已生成的标题、正文、配图都保存在本地。打开下方文件夹，自己挑选文章并手动上传到小红书草稿箱（每篇 ≤3 篇/天可降低封号风险）。' : 'Generated titles, bodies and images are saved locally. Open the folder below and manually upload to XHS drafts (≤3/day to reduce ban risk).'}</p>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const res = await window.electron?.scenario?.getTaskDir?.(task.id);
                          const dir = typeof res === 'string' ? res : res?.dir;
                          if (dir) window.electron?.shell?.openPath?.(dir);
                        } catch {}
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                    >
                      📂 {isZh ? '打开本地文件夹' : 'Open folder'}
                    </button>
                  </div>
                ) : logs.length > 0 ? (
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
                            {isLast && log.status === 'running' ? (
                              <span className="typing-animation">{renderLogMessage(log.message)}</span>
                            ) : (
                              renderLogMessage(log.message)
                            )}
                          </span>
                          <span className="text-gray-500 dark:text-gray-600 shrink-0 tabular-nums text-[10px]">{log.time}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400 text-center py-4">
                    {stepNum === 1 && !running ? (() => {
                      const interval = (task as any).run_interval || 'daily';
                      // Calculate next run time
                      const lastRun = stats?.last_run_at;
                      const intervals: Record<string, number> = { '30min': 30*60*1000, '1h': 60*60*1000, '3h': 3*60*60*1000, '6h': 6*60*60*1000, 'daily': 24*60*60*1000, 'daily_random': 24*60*60*1000 };
                      const ms = intervals[interval] || 24*60*60*1000;
                      let nextRunStr = '';
                      if (lastRun) {
                        const next = lastRun + ms;
                        if (next <= Date.now()) {
                          nextRunStr = isZh ? '即将运行' : 'Running soon';
                        } else {
                          const diff = next - Date.now();
                          const mins = Math.round(diff / 60000);
                          nextRunStr = mins < 60
                            ? (isZh ? mins + ' 分钟后运行' : 'Run in ' + mins + ' min')
                            : (isZh ? Math.round(mins/60) + ' 小时后运行' : 'Run in ' + Math.round(mins/60) + 'h');
                        }
                      } else {
                        nextRunStr = isZh ? '点击"直接运行"开始' : 'Click "Run Now" to start';
                      }
                      return nextRunStr;
                    })() : (isZh ? '等待前一步' : 'Waiting for previous step')}
                  </div>
                )}
              </div>
            </div>
          );
        })}
            </div>
          </>
        );
      })()}


      {loginModalOpen && (
        <LoginRequiredModal
          mode="run"
          platform={(scenario?.platform === 'x' ? 'x' : 'xhs') as 'x' | 'xhs'}
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
