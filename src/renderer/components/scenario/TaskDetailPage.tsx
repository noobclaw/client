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

// v4.28.x: 之前只放了 XHS tracks,Twitter / Binance 的 web3_* track 没法在
// detail 页面被翻译,会回落到原始 ID(如 'web3_alpha'),用户看到「人设: web3_alpha」。
// MyTasksPage 列表那边的 TRACK_ICONS 是全的所以没问题,这里补齐 web3 系列保持一致。
const TRACK_NAMES: Record<string, string> = {
  // Twitter / Binance (web3) tracks
  web3_alpha: '🎯 Web3 · Alpha 猎人',
  web3_defi: '🏛️ Web3 · DeFi 用户',
  web3_meme: '🎪 Web3 · Meme 文化',
  web3_builder: '🛠️ Web3 · 建设者',
  web3_zh_kol: '📢 Web3 · 通用 KOL',
  // XHS tracks
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
// XHS Auto-reply: 3 steps. Step 2 contains the entire per-article loop
// v2.4.89: 所有步骤标题用**用户视角**的大白话,不再暴露内部实现细节
// (selector / retry / model name / CSP / React state 这些全藏起来)
const STEP_NAMES_AUTOREPLY_ZH = [
  '挑选要回复的文章',
  '逐篇生成评论并发布',
  '保存本次报告到本地',
];
const STEP_NAMES_AUTOREPLY_EN = [
  'Pick articles to reply to',
  'Generate and post comments per article',
  'Save this run report to disk',
];
const STEP_NAMES_X_AUTO_ENGAGE_ZH = [
  '准备本次动作清单',
  '逐个执行关注 / 回复 / 点赞',
  '保存本次报告到本地',
];
const STEP_NAMES_X_AUTO_ENGAGE_EN = [
  'Plan this run',
  'Execute follow / reply / like one by one',
  'Save this run report to disk',
];
const STEP_NAMES_X_POST_CREATOR_ZH = [
  '准备素材',
  '生成推文并发布',
  '保存本次报告到本地',
];
const STEP_NAMES_X_POST_CREATOR_EN = [
  'Prepare material',
  'Generate and post the tweet',
  'Save this run report to disk',
];
const STEP_NAMES_X_LINK_REWRITE_ZH = [
  '读取每条原推内容',
  '逐条仿写并发布',
  '保存本次报告到本地',
];
const STEP_NAMES_X_LINK_REWRITE_EN = [
  'Read each source tweet',
  'Rewrite and post each',
  'Save this run report to disk',
];
const STEP_NAMES_BINANCE_AUTO_ENGAGE_ZH = [
  '准备本次动作清单',
  '逐个执行关注 / 回复 / 点赞',
  '保存本次报告到本地',
];
const STEP_NAMES_BINANCE_AUTO_ENGAGE_EN = [
  'Plan this run',
  'Execute follow / reply / like one by one',
  'Save this run report to disk',
];
const STEP_NAMES_BINANCE_POST_CREATOR_ZH = [
  '选题(token + 方向)',
  'AI 生成内容',
  '打开发帖框 + 写入内容',
  '发布',
];
const STEP_NAMES_BINANCE_POST_CREATOR_EN = [
  'Pick topic (token + angle)',
  'AI generates the post',
  'Open composer and write',
  'Publish',
];
const STEP_NAMES_BINANCE_FROM_X_REPOST_ZH = [
  '校验双平台 + 从推特挑爆款',
  'AI 改写 + 下载原图/视频',
  '写入币安编辑器 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_X_REPOST_EN = [
  'Verify both tabs + pick viral tweet',
  'AI rewrite + download images/video',
  'Write to Binance + upload images/video',
  'Publish to Binance Square',
];
const STEP_NAMES_BINANCE_FROM_X_LINK_ZH = [
  '校验双平台 + 打开链接读取原推',
  'AI 改写为币安风格 + 下载原图/视频',
  '切到币安 · 写入正文 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_X_LINK_EN = [
  'Verify both tabs + open URL & read source tweet',
  'AI rewrite into Binance style + download images/video',
  'Switch to Binance · write content + upload images/video',
  'Publish to Binance Square',
];

interface Props {
  task: Task;
  scenario: Scenario | null;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
  /** Navigate to the Run History page filtered to this task's id.
   *  Wired up by ScenarioView. Optional so the renderer can no-op if
   *  history isn't available in the current view context. */
  onOpenHistory?: () => void;
}

export const TaskDetailPage: React.FC<Props> = ({ task, scenario, onBack, onEdit, onChanged, onOpenHistory }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  // 链接模式是一次性手动运行，没有"下次运行"的概念
  const isLinkModeForStats = task.track === 'link_mode'
    || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
  // Auto-reply tasks have a different step narrative and don't produce
  // local drafts (replies post directly), so the upload-mode badge and
  // the manual-upload step variant don't apply to them.
  const isAutoReplyTask = (scenario?.workflow_type as any) === 'auto_reply';
  // Platform detection — used for badge / step copy on the task detail page.
  // For Twitter scenarios (x_auto_engage / x_post_creator / x_link_rewrite)
  // we can't reuse XHS-specific copy like "直接发布到小红书".
  const isXTask = scenario?.platform === 'x';
  const isBinanceTask = scenario?.platform === 'binance';
  const platformLabelForTask = isXTask
    ? 'Twitter'
    : isBinanceTask
      ? (isZh ? '币安广场' : 'Binance Square')
      : (isZh ? '小红书' : 'Xiaohongshu');
  const STEP_LABELS = isZh ? STEP_LABELS_ZH : STEP_LABELS_EN;
  // Pick step names by scenario id first (Twitter has 3 distinct flavors),
  // then fall back to the legacy isAutoReply branch for XHS.
  const STEP_NAMES = (() => {
    const sid = scenario?.id;
    if (sid === 'x_auto_engage') return isZh ? STEP_NAMES_X_AUTO_ENGAGE_ZH : STEP_NAMES_X_AUTO_ENGAGE_EN;
    if (sid === 'x_post_creator') return isZh ? STEP_NAMES_X_POST_CREATOR_ZH : STEP_NAMES_X_POST_CREATOR_EN;
    if (sid === 'x_link_rewrite') return isZh ? STEP_NAMES_X_LINK_REWRITE_ZH : STEP_NAMES_X_LINK_REWRITE_EN;
    if (sid === 'binance_square_auto_engage') return isZh ? STEP_NAMES_BINANCE_AUTO_ENGAGE_ZH : STEP_NAMES_BINANCE_AUTO_ENGAGE_EN;
    if (sid === 'binance_square_post_creator') return isZh ? STEP_NAMES_BINANCE_POST_CREATOR_ZH : STEP_NAMES_BINANCE_POST_CREATOR_EN;
    if (sid === 'binance_from_x_repost') return isZh ? STEP_NAMES_BINANCE_FROM_X_REPOST_ZH : STEP_NAMES_BINANCE_FROM_X_REPOST_EN;
    if (sid === 'binance_from_x_link') return isZh ? STEP_NAMES_BINANCE_FROM_X_LINK_ZH : STEP_NAMES_BINANCE_FROM_X_LINK_EN;
    return isAutoReplyTask
      ? (isZh ? STEP_NAMES_AUTOREPLY_ZH : STEP_NAMES_AUTOREPLY_EN)
      : (isZh ? STEP_NAMES_ZH : STEP_NAMES_EN);
  })();
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
  // v2.4.38: fetch progress DIRECTLY instead of going through
  // getRunningTaskIds → setRunning → poll-effect → 2s wait → first
  // progress fetch. That chain had a ~2-3s blind window where users
  // landing on the detail page mid-run saw "等待前一步" and thought
  // progress didn't load. Now we populate `progress` on mount so the
  // step panel has real data before the user blinks.
  useEffect(() => {
    void refreshData();
    scenarioService.getRunProgress(task.id).then(prog => {
      if (!mountedRef.current) return;
      if (prog && prog.taskId === task.id) {
        setProgress(prog);
        if (prog.status === 'running') setRunning(true);
      }
    }).catch(() => {});
    // v2.4.67 fallback: getRunProgress() can return null even when the task
    // is genuinely running (e.g. progress channel hasn't pushed yet, runner
    // restarted while task was mid-flight, etc.). The list page reads
    // getRunningTaskIds() as ground truth — mirror that here so the detail
    // page doesn't show "等待前一步 / 24 小时后运行" while the list shows
    // the same task as 运行中. Polled every 3s to match list cadence.
    scenarioService.getRunningTaskIds().then(ids => {
      if (!mountedRef.current) return;
      if (Array.isArray(ids) && ids.indexOf(task.id) >= 0) setRunning(true);
    }).catch(() => {});
  }, [refreshData, task.id]);

  // v2.4.67: ongoing sync — if list-side reports our task as running but
  // local state thinks otherwise, flip running=true so the step panel
  // starts polling progress. Stops when local running already true.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    const tick = async () => {
      const ids = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
      if (cancelled || !mountedRef.current) return;
      if (Array.isArray(ids) && ids.indexOf(task.id) >= 0) setRunning(true);
    };
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [running, task.id]);

  // ── Poll progress logs every 2s (display only, NOT for running state) ──
  //
  // v2.4.38: also fires an IMMEDIATE fetch right when `running` flips to
  // true, not just on the first setInterval tick 2s later. Without this,
  // users entering a task detail page mid-run saw "等待前一步" in the
  // step panel for ~2 seconds before the first poll landed — looked like
  // the progress wasn't loading at all. Retry-and-reenter was their
  // workaround. Now progress shows up within ~50ms of `running=true`.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    // Defensive: if progress comes back null repeatedly while we think the
    // task is running, the in-memory progress entry was already cleaned up
    // (it's deleted 30s after the task finishes). Without this, the UI
    // would stay stuck on "正在启动…" / "等待前一步" placeholders forever
    // because nothing else flips running back to false.
    let nullStreak = 0;
    const NULL_STREAK_THRESHOLD = 3;  // 2s × 3 = 6s of consecutive nulls
    const doFetch = async () => {
      try {
        // Pass task.id so the main process returns THIS task's progress
        // even when another task (different platform) is also running.
        const prog = await scenarioService.getRunProgress(task.id).catch(() => null);
        if (cancelled || !mountedRef.current) return;
        if (!prog || prog.taskId !== task.id) {
          // Cross-check with the authoritative running list before downgrading
          // — getRunningTaskIds reads runningByResource which is updated
          // synchronously when the task finishes, so it's the safer signal.
          nullStreak++;
          if (nullStreak >= NULL_STREAK_THRESHOLD) {
            const ids = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
            if (cancelled || !mountedRef.current) return;
            if (!Array.isArray(ids) || ids.indexOf(task.id) < 0) {
              setRunning(false);
              setStopping(false);
              void refreshData();
            }
            nullStreak = 0;
          }
          return;
        }
        nullStreak = 0;
        if (prog && prog.taskId === task.id) {
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
                err.includes('anomaly:login_wall') ? `需要重新登录 ${platformLabelForTask}` :
                err.includes('anomaly:account_flag') ? `账号异常，请检查 ${platformLabelForTask} 账号状态` :
                err || '未知错误'
              }`);
            }
            void refreshData();
            void onChanged();
          }
        }
      } catch {}
    };
    // Immediate first fetch (don't wait 2s for setInterval to fire).
    void doFetch();
    const timer = setInterval(doFetch, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [running, task.id, refreshData]);

  // ── Actions ──
  const handleRunNow = async () => {
    if (running) return;

    // 1. Wallet check (sync — fast, no perceived lag).
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.openWebsiteLogin();
      return;
    }

    // 2. Open the pre-run modal IMMEDIATELY so the user sees instant
    //    visual feedback. Pre-2.4.30 we awaited getRunningTaskIds +
    //    listTasks + listScenarios BEFORE setLoginModalOpen, which on a
    //    slow IPC round-trip felt like "click did nothing" — users
    //    learned they had to double-click. The modal is the right place
    //    to be while these async checks resolve, since the user has to
    //    read it + click confirm anyway (plenty of time).
    setLoginModalOpen(true);

    // 3. Per-platform concurrency check, in the background. If we find
    //    another task on the same platform is already running, close the
    //    modal and surface the toast. Otherwise the user proceeds
    //    normally — no extra wait.
    try {
      const runningIds: string[] = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
      const otherRunning = runningIds.filter((id: string) => id !== task.id);
      if (otherRunning.length === 0) return; // nothing else running
      const [allTasks, allScenarios] = await Promise.all([
        scenarioService.listTasks().catch(() => [] as Task[]),
        scenarioService.listScenarios().catch(() => [] as Scenario[]),
      ]);
      if (!mountedRef.current) return;
      const scenarioById = new Map(allScenarios.map(s => [s.id, s]));
      const myPlatform = scenario?.platform;
      const samePlatformBusy = otherRunning.some(rid => {
        const otherTask = allTasks.find(t => t.id === rid);
        if (!otherTask) return false;
        const otherPlatform = scenarioById.get(otherTask.scenario_id)?.platform;
        return otherPlatform === myPlatform;
      });
      if (samePlatformBusy) {
        const platformLabel = myPlatform === 'x' ? '推特' : myPlatform === 'xhs' ? '小红书' : myPlatform === 'binance' ? '币安广场' : '该平台';
        // Close the just-opened modal — the user can't proceed anyway.
        setLoginModalOpen(false);
        showToast('warn', `${platformLabel}已有任务在运行，同平台同时只能跑一个。请先停掉另一个，或运行其它平台的任务。`);
      }
    } catch {}
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
        // v4.25.35: 资源被占用时拼一句人话给用户(平台名 + 占用任务名),
        // 而不是甩一坨 'resource_busy:tab:^https?://...' 的内部 key。
        const r = outcome.reason || '';
        if (r.startsWith('resource_busy:') && Array.isArray(outcome.busy_platforms) && outcome.busy_platforms.length) {
          const plats = outcome.busy_platforms.join(' + ');
          const holder = outcome.busy_task_name || '其他任务';
          showToast('warn', `该任务需要 ${plats} 都空闲。当前 "${holder}" 正在运行,请先停掉它再启动此任务。`);
        } else if (r === 'concurrency_limit_reached') {
          showToast('warn', '同时运行的任务已达上限,请先停掉一个再启动新任务。');
        } else {
          showToast('warn', `已跳过: ${r || '未知原因'}`);
        }
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
      // Pass task.id so we abort THIS task only — without it we'd kill
      // any other concurrent task (e.g. XHS) at the same time.
      await scenarioService.requestAbort(task.id);
      showToast('warn', '正在停止，请稍候...');
    } catch {
      showToast('err', '停止请求失败');
      setStopping(false);
    }
  };

  const handleDelete = async () => {
    // Check if THIS task is running. Use the plural getter — singleton
    // would miss us if a different concurrent task happens to iterate first.
    try {
      const ids: string[] = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
      if (ids.includes(task.id)) {
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

  // Reuse the same badge palette as MyTasksPage / XWorkflowsPage so the
  // task detail page visually matches what the user clicked from the list.
  const platformBadge = (() => {
    if (scenario?.platform === 'x') return { icon: '🐦', label: isZh ? '推特' : 'Twitter' };
    if (scenario?.platform === 'xhs') return { icon: '📕', label: isZh ? '小红书' : 'XHS' };
    if (scenario?.platform === 'binance') return { icon: '🔶', label: isZh ? '币安广场' : 'Binance Square' };
    return { icon: '🤖', label: scenario?.platform || '' };
  })();
  const isLinkModeForBadge = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
  const typeBadge = (() => {
    const sid = task.scenario_id;
    if (sid === 'x_auto_engage')                  return { icon: '🐦', label: isZh ? '推特 · 自动互动' : 'Twitter Auto Engage', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
    if (sid === 'x_post_creator')                 return { icon: '📝', label: isZh ? '推特 · 自动发推' : 'Twitter Auto Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (sid === 'x_link_rewrite')                 return { icon: '✍️', label: isZh ? '推特 · 指定链接仿写' : 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (sid === 'binance_square_auto_engage')     return { icon: '🤝', label: isZh ? '币安广场 · 自动互动' : 'Binance Square Auto Engage', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
    if (sid === 'binance_square_post_creator')    return { icon: '🔶', label: isZh ? '币安广场 · 自动发帖' : 'Binance Square Auto Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
    if (sid === 'binance_from_x_repost')          return { icon: '🔁', label: isZh ? '币安广场 · 推特批量搬运' : 'Binance · Repost from X (Batch)', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'binance_from_x_link')          return { icon: '🔗', label: isZh ? '币安广场 · 推特链接仿写' : 'Binance · From X Link', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (isLinkModeForBadge && !isXTask && !isBinanceTask) return { icon: '🔗', label: isZh ? '小红书 · 指定链接爆款仿写' : 'XHS Rewrite (URL)', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
    // workflow_type fallback — guard by platform so Binance auto_reply
    // doesn't get mis-labeled as XHS auto_reply.
    if ((scenario?.workflow_type as any) === 'auto_reply') {
      if (isBinanceTask) return { icon: '💬', label: isZh ? '币安广场 · 自动互动' : 'Binance Square Auto Engage', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
      return { icon: '💬', label: isZh ? '小红书 · 自动互动' : 'XHS Auto Engage', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    }
    if (isBinanceTask) return { icon: '🔶', label: isZh ? '币安广场发帖' : 'Binance Square Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
    if (isXTask)       return { icon: '🐦', label: isZh ? '推特任务' : 'Twitter Task', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    return { icon: '🔥', label: isZh ? '小红书 · 爆款批量仿写' : 'XHS Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
  })();

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button type="button" onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
        ← {isZh ? '返回' : 'Back'}
      </button>

      {/* Header: badges so the task detail page identifies itself the same
          way it appeared in the list — at a glance "this is the推特/自动互动
          task you clicked on". For Twitter scenarios we ALSO show the
          language pill so users immediately see whether their language
          choice (中文 / English / 中英混合) is registered for this task —
          without it users were confused why posts came out in English even
          though they picked Chinese. */}
      {(() => {
        const langCode = (task as any).language as ('zh' | 'en' | 'mixed') | undefined;
        const langPill = langCode === 'zh' ? { icon: '🇨🇳', label: isZh ? '中文' : 'Chinese', color: 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600' }
          : langCode === 'en' ? { icon: '🇺🇸', label: 'English', color: 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600' }
          : langCode === 'mixed' ? { icon: '🌐', label: isZh ? '中英混合' : 'zh+en mixed', color: 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600' }
          : null;
        return (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
              {platformBadge.icon} {platformBadge.label}
            </span>
            <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${typeBadge.color}`}>
              {typeBadge.icon} {typeBadge.label}
            </span>
            {/* Language pill — Twitter scenarios only (XHS doesn't have a
                language toggle; everything is Chinese by definition). */}
            {isXTask && langPill && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${langPill.color}`} title={isZh ? 'AI 输出语言（在配置时设置）' : 'Output language (set during config)'}>
                {langPill.icon} {langPill.label}
              </span>
            )}
            <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono">
              #{task.id.slice(0, 8)}
            </span>
          </div>
        );
      })()}

      {/* Config + actions */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            {(() => {
              const isLinkMode = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
              const taskUrls: string[] = (task as any).urls || [];
              return (
                <>
                  {/* v4.28.x: 链接仿写场景(XHS link mode / x_link_rewrite / binance_from_x_link)
                      隐藏「赛道/人设: 🔗 ...」整行 —— 上面已经有 type badge 标明任务类型,
                      这一行的 link-mode label 跟 badge 完全重复,#ID 也已在标题区显示;
                      用户根本没填 track / persona,展示出来纯属噪音。 */}
                  {!isLinkMode && (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400">
                        {(isXTask || /^binance/.test(task.scenario_id)) ? (isZh ? '人设:' : 'Persona:') : (isZh ? '赛道:' : 'Track:')}
                      </span>
                      <span className="dark:text-white font-medium">{trackName}</span>
                      <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
                    </div>
                  )}
                  {/* v4.28.x: 把 task.persona 文本展开显示在「人设: XXX」下面 ——
                      列表页(MyTasksPage)只截取首行 80 字,用户进到详情想看完整身份
                      描述只能去 wizard 编辑里翻,体验不好。这里展示完整 persona。
                      Link 模式没人设概念跳过。 */}
                  {!isLinkMode && (task.persona || '').trim() && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap pl-1">
                      👤 {(task.persona || '').trim()}
                    </div>
                  )}
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
                      {/* Keywords are XHS-only — Twitter scenarios don't search
                          by keyword (auto_engage uses KOL pool + Home feed,
                          post_creator uses topic_context, link_rewrite is
                          URL-driven). Hide on X to avoid showing a misleading
                          empty/default keyword list. */}
                      {!isXTask && (
                        <div>
                          {(/^binance/.test(task.scenario_id) ? (isZh ? 'Token tag' : 'Token tag') : (isZh ? '关键词' : 'Keywords'))}
                          : {task.keywords.join(' · ')}
                        </div>
                      )}
                      {/* v4.31.27: binance_from_x_repost 显示媒体类型 */}
                      {task.scenario_id === 'binance_from_x_repost' && (() => {
                        const mf = (task as any).media_filter;
                        const lab = mf === 'image_only' ? (isZh ? '仅图文' : 'Images only')
                          : mf === 'video_only' ? (isZh ? '仅视频(严格)' : 'Videos only (strict)')
                          : (isZh ? '全部(图文 + 视频)' : 'All (images + videos)');
                        return <div>{isZh ? '搬运类型' : 'Media filter'}: 🎞 {lab}</div>;
                      })()}
                      <div>{isZh ? '频次' : 'Schedule'}: ⏰ {(() => {
                        const intervalMap: Record<string, string> = isZh
                          ? { '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', 'daily': '每天 ' + (task.daily_time || '08:00'), 'daily_random': '每日随机时间一次', 'once': '不重复（手动触发）' }
                          : { '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h', 'daily': 'Daily ' + (task.daily_time || '08:00'), 'daily_random': 'Once daily (random time)', 'once': 'Once (manual)' };
                        const intervalLabel = intervalMap[(task as any).run_interval || 'daily'] || (isZh ? '每天 ' : 'Daily ') + (task.daily_time || '08:00');
                        // v2.4.60: 频次显示真实用户配置(min/max),不再写死 daily_count
                        const sid = task.scenario_id;
                        const t = task as any;
                        const fMin = t.daily_follow_min, fMax = t.daily_follow_max;
                        const rMin = t.daily_reply_min, rMax = t.daily_reply_max;
                        const lMin = t.daily_like_min, lMax = t.daily_like_max;
                        const cMin = t.daily_count_min, cMax = t.daily_count_max;
                        const pMin = t.daily_post_min, pMax = t.daily_post_max;
                        if (sid === 'x_auto_engage' || sid === 'binance_square_auto_engage') {
                          const fStr = (typeof fMin === 'number' && typeof fMax === 'number')
                            ? `${fMin}-${fMax}` : `0-${task.daily_count || 3}`;
                          const rStr = (typeof rMin === 'number' && typeof rMax === 'number')
                            ? `${rMin}-${rMax}` : `${task.daily_count || 1}`;
                          // v2.4.83: 点赞 — 仅 binance auto_engage 有,如果 task 上有就显示
                          const lStr = (typeof lMin === 'number' && typeof lMax === 'number')
                            ? `${lMin}-${lMax}` : null;
                          var summary = `${intervalLabel} · ${isZh ? '关注' : 'Follow'} ${fStr} · ${isZh ? '评论' : 'Reply'} ${rStr}`;
                          if (lStr) summary += ` · ${isZh ? '点赞' : 'Like'} ${lStr}`;
                          return summary;
                        }
                        // v4.31.27: binance_from_x_repost 也走 daily_post_min/max(批量搬运同样按"每次 N 条")
                        // v4.31.30: 频次摘要文案对齐 wizard step3 — 之前只有数字+"条/次",
                        //   旧任务 daily_post_min/max 缺失时回落 daily_count(常为 1),
                        //   显示"每30分钟 · 1 条/次",和 wizard 实时摘要不一致引发用户困惑。
                        //   现按场景给出和 wizard step3 同款描述,且 min===max 时只显示单值。
                        if (sid === 'binance_square_post_creator' || sid === 'x_post_creator' || sid === 'binance_from_x_repost') {
                          const hasRange = typeof pMin === 'number' && typeof pMax === 'number';
                          const pStr = hasRange
                            ? (pMin === pMax ? String(pMin) : `${pMin}-${pMax}`)
                            : String(task.daily_count || 1);
                          if (sid === 'x_post_creator') {
                            return isZh
                              ? `${intervalLabel} · 每次 ${pStr} 条推文（仿写 30% / 原创 30% / 引用 40% 随机）`
                              : `${intervalLabel} · ${pStr} tweets/run (30% rewrite / 30% original / 40% quote)`;
                          }
                          if (sid === 'binance_from_x_repost') {
                            return isZh
                              ? `${intervalLabel} · 每次 ${pStr} 条 · 推特爆款搬运到币安广场（原图/视频 + AI 改写）`
                              : `${intervalLabel} · ${pStr} repost(s)/run · X → Binance Square (original media + AI rewrite)`;
                          }
                          // binance_square_post_creator
                          return isZh
                            ? `${intervalLabel} · 每次 ${pStr} 条币安广场短评（100-300 字 + cashtag）`
                            : `${intervalLabel} · ${pStr} Binance Square notes/run (100-300 chars + cashtag)`;
                        }
                        if (typeof cMin === 'number' && typeof cMax === 'number') {
                          return `${intervalLabel} · ${cMin}-${cMax} ${isZh ? '篇/次' : 'articles/run'}`;
                        }
                        return `${intervalLabel} · ${task.daily_count || 1} ${isZh ? '条/次' : '/run'}`;
                      })()}</div>
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
            {isAutoReplyTask && task.persona && (() => {
              // Strip the Chinese prefix in EN mode so users on English UI
              // don't see "身份:" / "技术栈:" / etc. labels — body content
              // stays Chinese (it's user-editable copy, can't auto-xlate).
              const personaText = isZh ? task.persona : task.persona
                .replace(/(^|\n)身份[：:]\s*/g, (_, p) => p + 'Identity: ')
                .replace(/(^|\n)现在做的[：:]\s*/g, (_, p) => p + 'Currently doing: ')
                .replace(/(^|\n)真实状态[：:]\s*/g, (_, p) => p + 'Status: ')
                .replace(/(^|\n)技术栈[：:]\s*/g, (_, p) => p + 'Tech stack: ');
              return (
                <div className="text-[11px] text-gray-400 leading-relaxed">
                  <span className="text-gray-500">{isZh ? '人设:' : 'Persona:'}</span>{' '}
                  <span className="italic">{personaText.length > 120 ? personaText.slice(0, 120) + '...' : personaText}</span>
                </div>
              );
            })()}
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
                  {(() => {
                    const interval = (task as any).run_interval || 'daily';
                    // v2.4.62: 'once'(手动触发)就别说"自动运行"和"下次运行" — 没意义
                    if (interval === 'once' || isLinkModeForStats) {
                      return isZh ? '✋ 手动触发' : '✋ Manual trigger';
                    }
                    // v4.25.4: 不再依赖 task.active 判定 "待命" —— 现在所有
                    // enabled 任务都会自动跑(active 仅 UI 高亮用)。直接显示
                    // schedule label。
                    const map: Record<string, string> = isZh
                      ? { '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', 'daily': '每天 ' + (task.daily_time || '08:00'), 'daily_random': '每日随机时间一次' }
                      : { '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h', 'daily': 'Daily ' + (task.daily_time || '08:00'), 'daily_random': 'Once daily (random time)' };
                    return (map[interval] || (isZh ? '每天' : 'Daily')) + (isZh ? ' 自动运行' : ' Scheduled');
                  })()}
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

      {/* Stats — link-mode tasks AND run_interval='once' tasks are one-shot
           so the "下次运行" stat is meaningless; show only the first four. */}
      <div className={`grid grid-cols-2 ${(isLinkModeForStats || (task as any).run_interval === 'once') ? 'sm:grid-cols-3' : 'sm:grid-cols-4'} gap-3 mb-6`}>
        <StatCard label={isZh ? '累计采集' : 'Collected'} value={Array.isArray(stats?.runs) ? stats.runs.reduce((s: number, r: any) => s + (r.collected_count || 0), 0) : 0} />
        <StatCard label={isZh ? '生成草稿' : 'Drafts'} value={stats?.draft_count ?? 0} />
        <StatCard label={isZh ? '已推送' : 'Pushed'} value={stats?.pushed_draft_count ?? 0} />
        <StatCard
          label={isZh ? '上次运行' : 'Last Run'}
          value={formatRelative(stats?.last_run_at || null, isZh)}
          small
          // Click on the "上次运行" stat → jump to Run History filtered
          // to THIS task. Lets users review every previous run without
          // hunting through the global history page.
          onClick={onOpenHistory}
          actionLabel={isZh ? '查看历史运行记录 →' : 'View run history →'}
        />
        {!isLinkModeForStats && (task as any).run_interval !== 'once' && (
          <StatCard
            label={isZh ? '下次运行' : 'Next Run'}
            value={(() => {
              // v4.25.4: 不再因 active=false 显示 "待命" —— scheduler 现在
              // 会跑所有 enabled 任务,active 仅 UI 高亮。
              // Prefer the pre-picked timestamp from the scheduler (set
              // after each run + on the first scheduler tick). With
              // daily_random the random offset is already baked in, so
              // we can show the exact wall-clock time. Fallback to the
              // old "elapsed since last_run" estimate if missing
              // (older tasks pre-v2.4.25 might not have it yet).
              const planned = (task as any).next_planned_run_at as number | undefined;
              if (planned && planned > Date.now()) {
                const diff = planned - Date.now();
                const mins = Math.round(diff / 60000);
                let rel: string;
                if (mins < 60) rel = mins + (isZh ? ' 分钟后' : 'm');
                else if (mins < 24 * 60) rel = Math.round(mins / 60) + (isZh ? ' 小时后' : 'h');
                else rel = Math.round(mins / (60 * 24)) + (isZh ? ' 天后' : 'd');
                // Absolute time formatting:
                //   today    "今天 11:23"
                //   tomorrow "明天 11:23"
                //   else     "MM/DD 11:23"
                const d = new Date(planned);
                const sameDay = (a: Date, b: Date) =>
                  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
                const now = new Date();
                const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                const datePart = sameDay(d, now)      ? (isZh ? '今天' : 'today')
                              : sameDay(d, tomorrow)  ? (isZh ? '明天' : 'tmrw')
                              : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
                return `${rel} · ${datePart} ${hh}:${mm}`;
              }
              // Fallback: old heuristic for tasks without next_planned_run_at yet
              const interval = (task as any).run_interval || 'daily';
              const lastRun = stats?.last_run_at;
              if (!lastRun) return isZh ? '即将（计算中）' : 'Soon (calc)';
              const intervals: Record<string, number> = { '30min': 30*60*1000, '1h': 60*60*1000, '3h': 3*60*60*1000, '6h': 6*60*60*1000, 'daily': 24*60*60*1000, 'daily_random': 24*60*60*1000 };
              const ms = intervals[interval] || 24*60*60*1000;
              const next = lastRun + ms;
              if (next <= Date.now()) return isZh ? '即将' : 'Soon';
              const diff = next - Date.now();
              const mins = Math.round(diff / 60000);
              if (mins < 60) return mins + (isZh ? ' 分钟后' : ' min');
              return Math.round(mins / 60) + (isZh ? ' 小时后' : ' hr');
            })()}
            small
          />
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

      {/* 当前运行明细 — labeled "current" because it shows ONLY this run's
          live step logs. Historical runs live on the dedicated Run History
          page (linked above via the "📊 查看历史运行记录" button). */}
      {(() => {
        const autoUploadMode = (task as any).auto_upload !== false;
        // 发布模式 badge:三个 creator 场景都有 auto_upload 切换(见 ConfigWizard)。
        // 只有 auto_reply 场景没有这个概念(回复永远直接发)。
        // ⚠️ 文案按平台区分 —— "草稿箱"只适用 XHS(XHS 独有的"上传到小红书草稿箱"模型);
        // 推特/币安是"直接发到平台"模型,label 要写"发布到 推特/币安广场"。
        const showUploadBadge = !isAutoReplyTask;
        const isXhsViral = scenario?.platform === 'xhs';
        const autoUploadLabel = isXhsViral
          ? (isZh ? '📤 自动上传到草稿箱' : '📤 Auto-upload to drafts')
          : (isZh ? `🚀 自动发布到${platformLabelForTask}` : `🚀 Auto-post to ${platformLabelForTask}`);
        return (
          <>
            <div className="flex items-center justify-between mb-4 gap-3">
              <h2 className="text-base font-bold dark:text-white">{isZh ? '当前运行明细' : 'Current Run Details'}</h2>
              {showUploadBadge ? (
                <span className={`text-xs px-2.5 py-1 rounded-full border ${autoUploadMode ? 'bg-green-500/10 text-green-500 border-green-500/30' : 'bg-blue-500/10 text-blue-500 border-blue-500/30'}`}>
                  {autoUploadMode
                    ? autoUploadLabel
                    : (isZh ? '📁 仅生成保存本地' : '📁 Generate only')}
                </span>
              ) : (
                <span className="text-xs px-2.5 py-1 rounded-full border bg-cyan-500/10 text-cyan-500 border-cyan-500/30">
                  {isXTask
                    ? (isZh ? `🐦 直接发布到 ${platformLabelForTask}` : `🐦 Posts directly to ${platformLabelForTask}`)
                    : (isZh ? `💬 直接发布到 ${platformLabelForTask}` : `💬 Posts directly to ${platformLabelForTask}`)}
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

          // 仅生成模式的 step 4：不跑上传，替换为"打开本地目录 + 手动上传指引"。
          // ⚠️ 只适用 XHS viral_production:它的 auto_upload=false 是"图文存盘→
          // 用户打开文件夹→手动上传到草稿箱"。其他场景:
          //   - 推特 post_creator: 只有 3 步,没 stepNum===4
          //   - 币安 post_creator: step 4 是"发布";auto_upload=false 时 orchestrator
          //     已经把正文写进了页面编辑器,用户手动点"发文"即可,不需要"打开文件夹" UI
          const isManualUploadStep = isXhsViral && stepNum === 4 && !autoUploadMode;
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
                    {running ? (
                      // v2.4.67: 任务正在跑但这一步还没拿到 log 事件 — 区分
                      // step 1 (尚未启动 / 正在初始化) 和 step >1 (等前一步)
                      stepNum === 1
                        ? (isZh ? '⏳ 正在启动…(后端流式日志稍候)' : '⏳ Starting…')
                        : (isZh ? '等待前一步' : 'Waiting for previous step')
                    ) : stepNum === 1 ? (() => {
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
          platform={(scenario?.platform === 'x' ? 'x' : scenario?.platform === 'binance' ? 'binance' : 'xhs') as 'x' | 'xhs' | 'binance'}
          secondaryPlatform={(task.scenario_id === 'binance_from_x_repost' || task.scenario_id === 'binance_from_x_link') ? 'x' : undefined}
          onCancel={() => setLoginModalOpen(false)}
          onConfirmed={handleLoginConfirmed}
        />
      )}
    </div>
  );
};

const StatCard: React.FC<{
  label: string;
  value: string | number;
  small?: boolean;
  /** Optional click handler — turns the whole card into a button. Used
   *  for "上次运行" → opens the run history page filtered to this task. */
  onClick?: () => void;
  /** Tiny CTA shown at the bottom-right of the card when onClick is set,
   *  e.g. "查看历史运行记录 →". Helps the user know the card is clickable. */
  actionLabel?: string;
}> = ({ label, value, small, onClick, actionLabel }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`text-left w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 ${
        onClick ? 'hover:border-green-500/50 transition-colors cursor-pointer' : ''
      }`}
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className={`font-bold dark:text-white ${small ? 'text-sm' : 'text-2xl'}`}>{value}</div>
      {onClick && actionLabel && (
        <div className="text-[10px] text-green-500 dark:text-green-400 mt-1 truncate">{actionLabel}</div>
      )}
    </Tag>
  );
};

export default TaskDetailPage;
