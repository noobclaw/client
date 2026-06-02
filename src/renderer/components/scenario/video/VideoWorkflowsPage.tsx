/**
 * VideoWorkflowsPage — 「多平台视频创作」工作流页面.
 *
 * 本地合成工具,不走 backend scenario 任务体系,但交互对齐 scenario:
 *   - 顶部两个 L1 tab(我的视频任务 / 运行记录)由 ScenarioView 渲染,这里收 section。
 *   - section='tasks'   → 任务列表(发光卡片,展示赛道/人设/关键词/文案)
 *   - section='history' → 运行记录列表(每次「开始创作 / 重新跑」一条)
 *   - section='create'  → 创建流:选创作方式 → 弹出配置弹窗
 *   - 内部 detail 导航:点任务卡进【任务详情】(配置 + 本次运行 + 历史运行 + 重跑/编辑/删除),
 *     点运行记录进【运行记录详情】(只读快照 + 该次进度/日志/成片/消耗)。
 *
 * 任务状态由模块级 videoTaskStore 单例托管(页面切换不中断、日志不丢)。
 * 一期只做到「存本地不上传」,自动上传到抖音/小红书/币安先占位。
 */

import React, { useEffect, useRef, useState } from 'react';
import { i18nService } from '../../../services/i18n';
import { noobClawAuth } from '../../../services/noobclawAuth';
import {
  videoCreationService,
  type VideoCreationInput,
  type VideoCreationProgressStep,
  type VideoPublishTarget,
} from '../../../services/videoCreation';
import {
  videoTaskStore,
  type VideoTask,
  type VideoRunRecord,
  type VideoRunStatus,
} from '../../../services/videoTaskStore';

// 订阅 store 的 React hook:任意视图都能拿到最新任务列表 + 运行记录并自动重渲染。
function useVideoStore(): { tasks: VideoTask[]; runs: VideoRunRecord[] } {
  const [snap, setSnap] = useState(() => ({
    tasks: videoTaskStore.getTasks(),
    runs: videoTaskStore.getRuns(),
  }));
  useEffect(() => videoTaskStore.subscribe(() => setSnap({
    tasks: videoTaskStore.getTasks(),
    runs: videoTaskStore.getRuns(),
  })), []);
  return snap;
}

type VideoSection = 'tasks' | 'history' | 'create';
type DetailView =
  | { kind: 'list' }
  | { kind: 'task'; taskId: string }
  | { kind: 'record'; recordId: string };

interface VideoWorkflowsPageProps {
  /** 由 ScenarioView 的 section 决定:tasks=任务列表,history=运行记录,create=创建向导。 */
  section: VideoSection;
  /** 从落地页进入创建流(ScenarioView 把 section 切到 'create')。 */
  onGoCreate: () => void;
  /** 从创建流返回落地页(ScenarioView 把 section 切回 'tasks')。 */
  onBack: () => void;
  /** 进入/退出任务·运行记录详情时上报,供 ScenarioView 隐藏顶部 L1/L2 tab
   *  (对齐 scenario 详情页:详情态全屏,顶上不挂那么多 tab)。 */
  onDetailChange?: (inDetail: boolean) => void;
}

export const VideoWorkflowsPage: React.FC<VideoWorkflowsPageProps> = ({ section, onGoCreate, onBack, onDetailChange }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const { tasks, runs } = useVideoStore();
  const [detail, setDetail] = useState<DetailView>({ kind: 'list' });
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  // 创建完跳详情时,section 会从 create 变 tasks;别让下面的 effect 把 detail 清掉。
  const justCreatedRef = useRef(false);

  // 用户点 L1 tab / CTA 切 section 时,退出当前 detail 回到列表。
  useEffect(() => {
    if (justCreatedRef.current) { justCreatedRef.current = false; return; }
    setDetail({ kind: 'list' });
  }, [section]);

  // 详情态变化时上报给 ScenarioView(进详情=隐藏顶部 tab;离开本页时复位)。
  useEffect(() => {
    onDetailChange?.(detail.kind !== 'list');
  }, [detail.kind, onDetailChange]);
  useEffect(() => () => { onDetailChange?.(false); }, [onDetailChange]);

  const editingTask = editTaskId ? tasks.find((t) => t.id === editTaskId) : null;

  // ── detail 优先 ──
  if (detail.kind === 'task') {
    const task = tasks.find((t) => t.id === detail.taskId);
    if (!task) { setDetail({ kind: 'list' }); return null; }
    return (
      <>
        <VideoTaskDetail
          isZh={isZh}
          task={task}
          runs={videoTaskStore.getRunsForTask(task.id)}
          latestRun={videoTaskStore.getLatestRun(task.id)}
          onBack={() => setDetail({ kind: 'list' })}
          onOpenRecord={(rid) => setDetail({ kind: 'record', recordId: rid })}
          onEdit={() => setEditTaskId(task.id)}
        />
        {editingTask && (
          <VideoConfigModal
            isZh={isZh}
            editTask={editingTask}
            onClose={() => setEditTaskId(null)}
            onCreated={() => {}}
            onSaved={() => setEditTaskId(null)}
          />
        )}
      </>
    );
  }

  if (detail.kind === 'record') {
    const run = runs.find((r) => r.id === detail.recordId);
    if (!run) { setDetail({ kind: 'list' }); return null; }
    return <VideoRunRecordDetail isZh={isZh} run={run} onBack={() => setDetail({ kind: 'list' })} />;
  }

  if (section === 'create') {
    return (
      <VideoCreateFlow
        isZh={isZh}
        onCreated={(taskId) => {
          justCreatedRef.current = true;
          onBack();                              // section → tasks(L1 高亮回任务)
          setDetail({ kind: 'task', taskId });   // 直接进新任务详情
        }}
      />
    );
  }

  if (section === 'history') {
    return <VideoRunHistory isZh={isZh} runs={runs} tasks={tasks} onOpenRecord={(rid) => setDetail({ kind: 'record', recordId: rid })} />;
  }

  return <VideoLanding isZh={isZh} tasks={tasks} onGoCreate={onGoCreate} onOpenTask={(id) => setDetail({ kind: 'task', taskId: id })} />;
};

// ── 小工具 ──────────────────────────────────────────────────────────

const fmtNum = (n: number) => (n || 0).toLocaleString();

/** 紧凑数字:123→'123',9939→'9.94K',1.23M。对齐 scenario 详情页的 token 展示。 */
function compactNumber(n: number): string {
  const abs = Math.abs(n || 0);
  if (abs < 1000) return String(n || 0);
  if (abs < 1_000_000) return (n / 1_000).toFixed(abs < 10_000 ? 2 : 1) + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1_000_000_000).toFixed(2) + 'B';
}

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前,对齐 scenario「上次运行」。 */
function fmtRelative(ts: number | null | undefined, isZh: boolean): string {
  if (!ts) return isZh ? '尚未运行' : 'Not run yet';
  const mins = Math.round(Math.abs(Date.now() - ts) / 60_000);
  if (mins < 1) return isZh ? '刚刚' : 'Just now';
  if (mins < 60) return isZh ? `${mins} 分钟前` : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return isZh ? `${hrs} 小时前` : `${hrs} hr ago`;
  return isZh ? `${Math.round(hrs / 24)} 天前` : `${Math.round(hrs / 24)} d ago`;
}

/** 统计卡(对齐 scenario 详情页 StatCard:小标题 + 大值,可选点击跳转)。 */
const VStatCard: React.FC<{
  label: string;
  value: string | number;
  onClick?: () => void;
  actionLabel?: string;
}> = ({ label, value, onClick, actionLabel }) => {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`text-left w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 ${
        onClick ? 'hover:border-rose-500/50 transition-colors cursor-pointer' : ''
      }`}
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className="font-bold dark:text-white text-sm">{value}</div>
      {onClick && actionLabel && (
        <div className="text-[10px] text-rose-500 dark:text-rose-400 mt-1 truncate">{actionLabel}</div>
      )}
    </Tag>
  );
};

/** id 徽章:任务 / 运行记录用不同前缀,避免两种 id 混淆(都是 12 位 hex,展示前 8 位)。 */
const IdTag: React.FC<{ kind: 'task' | 'record'; id: string; isZh: boolean }> = ({ kind, id, isZh }) => (
  <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono shrink-0">
    {kind === 'task' ? (isZh ? '任务' : 'Task') : (isZh ? '记录' : 'Run')} #{id.slice(0, 8)}
  </span>
);

/** 视频创作教程入口(对齐币安 MyTasksPage 的「涨粉教程」胶囊:系统浏览器打开 docs)。 */
const VideoTutorialButton: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const url = isZh
    ? 'https://docs.noobclaw.com/zhong-wen-ban/shi-pin-chuang-zuo-jiao-cheng'
    : 'https://docs.noobclaw.com/english/video-creation';
  return (
    <button
      type="button"
      onClick={() => {
        try {
          (window as any).electron?.shell?.openExternal?.(url) ?? window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      }}
      className="group relative inline-flex items-center gap-1.5 text-xs font-medium
                 px-3.5 py-1.5 rounded-full
                 bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15
                 hover:from-amber-500/25 hover:via-orange-500/25 hover:to-rose-500/25
                 text-amber-700 dark:text-amber-300
                 border border-amber-500/30 hover:border-amber-500/60
                 shadow-sm hover:shadow-md hover:shadow-amber-500/20
                 transition-all duration-200 hover:-translate-y-0.5"
      title={isZh ? '查看视频创作教程' : 'Open video creation tutorial'}
    >
      <span className="text-sm leading-none">📖</span>
      <span>{isZh ? '视频创作教程' : 'Tutorial'}</span>
      <span className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200">→</span>
    </button>
  );
};

function statusOf(task: VideoTask): VideoRunStatus | 'idle' {
  return task.lastStatus || (task.runCount > 0 ? 'done' : 'idle');
}

/** 某任务已成功生成的视频条数(= done 状态的运行记录数)。 */
function doneVideoCount(taskId: string): number {
  return videoTaskStore.getRunsForTask(taskId).filter((r) => r.status === 'done').length;
}

const StatusPill: React.FC<{ isZh: boolean; status: VideoRunStatus | 'idle' }> = ({ isZh, status }) => {
  if (status === 'running') {
    return (
      <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        {isZh ? '生成中' : 'Running'}
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
        ✅ {isZh ? '已完成' : 'Done'}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 border border-red-500/30">
        ❌ {isZh ? '失败' : 'Failed'}
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-500 border border-gray-400/30">
      {isZh ? '未运行' : 'Idle'}
    </span>
  );
};

/** 平台 pill + 类型 badge(对齐 scenario 卡片头部)。 */
const HeadBadges: React.FC<{ isZh: boolean; size?: 'sm' | 'md' }> = ({ isZh, size = 'sm' }) => {
  const cls = size === 'md' ? 'text-xs px-2.5 py-1' : 'text-[11px] px-2 py-0.5';
  return (
    <>
      <span className={`shrink-0 inline-flex items-center gap-1 ${cls} font-semibold rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300`}>
        🎬 {isZh ? '视频创作' : 'Video'}
      </span>
      <span className={`shrink-0 inline-flex items-center gap-1 ${cls} font-semibold rounded-full border text-rose-500 bg-rose-500/10 border-rose-500/30`}>
        🎬 {isZh ? '单次成片' : 'One-shot'}
      </span>
    </>
  );
};

/** 关键词 chips(最多 n 个,超出显示 +N)。 */
const KeywordChips: React.FC<{ keywords: string[]; max?: number }> = ({ keywords, max = 6 }) => {
  const kws = (keywords || []).filter(Boolean);
  if (kws.length === 0) return <span className="text-gray-400">-</span>;
  const shown = kws.slice(0, max);
  const rest = kws.length - shown.length;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {shown.map((k, i) => (
        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
          {k}
        </span>
      ))}
      {rest > 0 && <span className="text-[10px] text-gray-400">+{rest}</span>}
    </span>
  );
};

function scriptSummary(input: VideoCreationInput, isZh: boolean): string {
  const s = (input.script || '').trim();
  if (!s) return isZh ? `AI 写稿 · ${input.targetSeconds ?? 45}s` : `AI script · ${input.targetSeconds ?? 45}s`;
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

// ── 落地页:有任务显示发光卡片列表,无任务显示占位框 ────────────────────

const VideoLanding: React.FC<{
  isZh: boolean;
  tasks: VideoTask[];
  onGoCreate: () => void;
  onOpenTask: (id: string) => void;
}> = ({ isZh, tasks, onGoCreate, onOpenTask }) => {
  if (tasks.length === 0) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <button
          type="button"
          onClick={onGoCreate}
          className="w-full rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center hover:border-rose-400 dark:hover:border-rose-500 transition-colors group"
        >
          <div className="text-5xl mb-3">🎬</div>
          <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
            {isZh ? '还没有视频创作任务' : 'No video tasks yet'}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-5 max-w-md mx-auto">
            {isZh
              ? '把选题变成配好音、带字幕、有视频画面的竖屏短视频,先存本地,满意后再发各平台。'
              : 'Turn a topic into a narrated, subtitled portrait short — saved locally first, publish later.'}
          </div>
          <span className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-rose-500 group-hover:bg-rose-600 text-white text-sm font-bold shadow-lg shadow-rose-500/25 transition-colors">
            ✨ {isZh ? '新建视频创作任务' : 'Create a video task'} →
          </span>
        </button>

        <section className="mt-6">
          <div className="flex flex-wrap gap-2 justify-center">
            {[
              { icon: '💻', zh: '本地合成 · 零服务器成本', en: 'Local synthesis · zero server cost' },
              { icon: '🎙️', zh: 'AI 写稿 + AI 配音 + 自动字幕', en: 'AI script + voiceover + subtitles' },
              { icon: '🎞️', zh: '在线视频素材 + 你的参考图', en: 'Stock video + your images' },
              { icon: '🚀', zh: '一键发抖音/小红书/币安', en: 'One-click to Douyin / XHS / Binance' },
            ].map((p, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-rose-500/20 bg-rose-500/5 text-gray-700 dark:text-gray-300"
              >
                {p.icon} {isZh ? p.zh : p.en}
              </span>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold dark:text-white">
          📋 {isZh ? '我的视频任务' : 'My Videos'}
        </h2>
        <VideoTutorialButton isZh={isZh} />
      </div>
      <div className="space-y-3">
        {tasks.map((t) => (
          <VideoTaskCard key={t.id} isZh={isZh} task={t} onClick={() => onOpenTask(t.id)} />
        ))}
      </div>
    </div>
  );
};

// ── 任务卡片(运行中发光,展示赛道/人设/关键词/文案) ─────────────────────

const VideoTaskCard: React.FC<{ isZh: boolean; task: VideoTask; onClick: () => void }> = ({ isZh, task, onClick }) => {
  const isRunning = statusOf(task) === 'running';
  const made = doneVideoCount(task.id);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-4 transition-colors relative ${
        isRunning
          ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow'
          : 'border-gray-200 dark:border-gray-700 hover:border-rose-500/50 dark:hover:border-rose-500/50 bg-white dark:bg-gray-900'
      }`}
    >
      {/* Top row — 平台 pill + 类型 badge + title + 任务#id */}
      <div className="flex items-center gap-2 mb-2 flex-wrap min-w-0">
        <HeadBadges isZh={isZh} />
        <span className="font-medium dark:text-white truncate">{task.title}</span>
        <IdTag kind="task" id={task.id} isZh={isZh} />
      </div>

      {/* 配置摘要:赛道 / 人设 / 关键词(全部展示) / 文案 */}
      <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
        <div className="flex items-start gap-1.5">
          <span className="text-gray-400 shrink-0">🎯 {isZh ? '赛道' : 'Track'}</span>
          <span className="truncate">{task.input.track || '-'}</span>
        </div>
        {task.input.persona && (
          <div className="flex items-start gap-1.5">
            <span className="text-gray-400 shrink-0">🧑 {isZh ? '人设' : 'Persona'}</span>
            <span className="truncate">{task.input.persona}</span>
          </div>
        )}
        <div className="flex items-start gap-1.5">
          <span className="text-gray-400 shrink-0">🏷️ {isZh ? '关键词' : 'Keywords'}</span>
          <KeywordChips keywords={task.input.keywords} max={99} />
        </div>
        <div className="flex items-start gap-1.5">
          <span className="text-gray-400 shrink-0">📝 {isZh ? '文案' : 'Script'}</span>
          <span className="truncate text-gray-500 dark:text-gray-400">{scriptSummary(task.input, isZh)}</span>
        </div>
      </div>

      {/* footer — 只展示「已生成 N 个视频」 */}
      <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          {isZh ? '已生成' : 'Made'}：🎬 <strong className="dark:text-white">{made}</strong> {isZh ? '个视频' : made === 1 ? 'video' : 'videos'}
        </span>
      </div>
    </button>
  );
};

// ── 运行记录列表 ──────────────────────────────────────────────────────

const VideoRunHistory: React.FC<{
  isZh: boolean;
  runs: VideoRunRecord[];
  tasks: VideoTask[];
  onOpenRecord: (id: string) => void;
}> = ({ isZh, runs, onOpenRecord }) => {
  if (runs.length === 0) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
            {isZh ? '还没有运行记录' : 'No run records yet'}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {isZh ? '每次「开始创作 / 重新跑」都会在这里留一条记录。' : 'Each generation run shows up here.'}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h2 className="text-base font-bold dark:text-white mb-4">
        {isZh ? '运行记录' : 'Run records'}
        <span className="ml-2 text-xs font-normal text-gray-400">{runs.length}</span>
      </h2>
      <div className="space-y-3">
        {runs.map((r) => (
          <VideoRunCard key={r.id} isZh={isZh} run={r} onClick={() => onOpenRecord(r.id)} />
        ))}
      </div>
    </div>
  );
};

/** 运行记录列表里单条时间戳:MM-DD HH:MM:SS,对齐币安 RunHistoryPage。 */
function fmtRecordTime(ts: number, isZh: boolean): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/**
 * 运行记录卡。布局对齐币安 RunHistoryPage 的行格式:
 *   顶行  状态pill + 类型badge + 标题  |  ⏱️时间 · 耗时 · 🎟️消耗
 *   次行  本次进度/本次完成(运行中给 step 进度,完成给"1 个视频")
 *   id行  任务id #xxx · 记录id #xxx
 *   尾行  最新进度/错误摘要 · N 条日志
 */
const VideoRunCard: React.FC<{ isZh: boolean; run: VideoRunRecord; onClick: () => void }> = ({ isZh, run, onClick }) => {
  const isRunning = run.status === 'running';
  const doneCount = run.steps.filter((s) => s.status === 'done').length;
  const totalSteps = run.steps.length;
  const durationSec = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-3 transition-colors cursor-pointer ${
        isRunning
          ? 'border-green-500/50 bg-white dark:bg-gray-900 noobclaw-running-glow hover:border-green-500'
          : run.status === 'error'
            ? 'border-red-400/60 dark:border-red-500/40 bg-white dark:bg-gray-900 hover:border-rose-500/50'
            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-rose-500/50'
      }`}
    >
      {/* 顶行:状态 + 类型 + 标题(左) | 时间 · 耗时 · 消耗(右) */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusPill isZh={isZh} status={run.status} />
          <HeadBadges isZh={isZh} />
          <span className="font-medium dark:text-white truncate">{run.title}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 shrink-0 flex-wrap">
          <span>⏱️ {fmtRecordTime(run.startedAt, isZh)}</span>
          {durationSec && <span>· {durationSec}{isZh ? '秒' : 's'}</span>}
          <span title={isZh ? '本次消耗的 DeepSeek token(TTS/合成免费)' : 'DeepSeek tokens this run (TTS/compose free)'}>
            · 🎟️ {run.tokensUsed > 0 ? compactNumber(run.tokensUsed) : '—'} tokens
          </span>
        </div>
      </div>

      {/* 次行:本次进度(运行中)/ 本次完成(完成) */}
      <div className="mt-1.5 flex items-center gap-3 text-xs flex-wrap">
        <span className={`text-[10px] ${isRunning ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500 dark:text-gray-500'}`}>
          {isZh ? (isRunning ? '本次进度' : '本次完成') : (isRunning ? 'Progress' : 'Result')}:
        </span>
        {isRunning && totalSteps > 0 ? (
          <span className="font-mono font-medium">
            🎬 <span className="text-green-600 dark:text-green-400">{doneCount}</span>
            <span className="text-gray-400 dark:text-gray-500">/{totalSteps}</span>{' '}
            <span className="text-gray-500 dark:text-gray-400 font-sans font-normal">{isZh ? '步' : 'steps'}</span>
          </span>
        ) : run.status === 'done' ? (
          <span className="font-mono font-medium">🎬 {isZh ? '1 个视频' : '1 video'}</span>
        ) : (
          <span className="text-gray-400">{isZh ? '未生成' : 'none'}</span>
        )}
      </div>

      {/* id 行:任务id + 记录id(区分同一任务的不同运行) */}
      <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500 dark:text-gray-500 font-mono">
        <span>{isZh ? '任务id:' : 'task:'} #{run.taskId.slice(0, 8)}</span>
        <span>·</span>
        <span>{isZh ? '记录id:' : 'record:'} #{run.id.slice(0, 8)}</span>
      </div>

      {/* 尾行:最新进度 / 错误摘要 · 日志条数 */}
      {(run.error || run.message) && (
        <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          {run.status === 'error' && run.error ? (
            <span className="text-amber-600 dark:text-amber-400 mr-2">
              {run.error.length > 100 ? run.error.slice(0, 100) + '…' : run.error}
            </span>
          ) : run.message ? (
            <span className="mr-2">
              {run.message.length > 100 ? run.message.slice(0, 100) + '…' : run.message}
            </span>
          ) : null}
          <span className="text-[10px] text-gray-400">
            {isZh ? `· ${run.logs.length} 条日志` : `· ${run.logs.length} log entries`}
          </span>
        </div>
      )}
    </button>
  );
};

// ── 配置卡片(详情页 / 运行记录详情共用,展示赛道/人设/关键词/文案) ──────────

const ConfigCard: React.FC<{ isZh: boolean; input: VideoCreationInput }> = ({ isZh, input }) => (
  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-2 text-xs">
    <Row label={`🎯 ${isZh ? '赛道' : 'Track'}`}>{input.track || '-'}</Row>
    <Row label={`🧑 ${isZh ? '人设' : 'Persona'}`}>{input.persona || '-'}</Row>
    <Row label={`🏷️ ${isZh ? '关键词' : 'Keywords'}`}><KeywordChips keywords={input.keywords} max={20} /></Row>
    <Row label={`📝 ${isZh ? '参考文案' : 'Script'}`}>
      {(input.script || '').trim()
        ? <span className="whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{input.script}</span>
        : <span className="text-gray-400">{isZh ? `留空 · AI 按 ${input.targetSeconds ?? 45}s 写稿` : `empty · AI writes for ${input.targetSeconds ?? 45}s`}</span>}
    </Row>
    <Row label={`🖼️ ${isZh ? '参考图' : 'Images'}`}>{(input.referenceImages || []).length}</Row>
    <Row label={`🎞️ ${isZh ? '画面' : 'Visuals'}`}>
      {input.useStockVideo !== false ? (isZh ? '在线视频素材 + 参考图' : 'stock video + images') : (isZh ? '仅图片' : 'images only')}
    </Row>
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-2">
    <span className="text-gray-400 shrink-0 w-20">{label}</span>
    <span className="flex-1 min-w-0 dark:text-gray-200">{children}</span>
  </div>
);

// ── 运行体(进度 step + 本次消耗 + 流式日志 + 成片操作) 详情/记录共用 ─────────

/** step 明细列表(详情/记录共用)。 */
const StepList: React.FC<{ steps: VideoCreationProgressStep[] }> = ({ steps }) => {
  if (!steps.length) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-1.5">
      {steps.map((s) => (
        <div key={s.key} className="flex items-center gap-2 text-xs">
          <span>{s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'error' ? '❌' : '○'}</span>
          <span className={s.status === 'running' ? 'text-green-600 dark:text-green-400 font-medium' : 'text-gray-600 dark:text-gray-300'}>
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
};

/**
 * 运行体:step 明细 + 流式日志 + 成片操作。
 * showProgressPill=true(运行记录详情)时额外渲染顶部「步骤 N/M + 本次消耗 + 状态」一行;
 * 任务详情页传 false —— 那边上方已有独立的「本次运行进度 / 本次消耗」绿卡对,避免重复。
 */
const RunBody: React.FC<{ isZh: boolean; run: VideoRunRecord | undefined; showProgressPill?: boolean }> = ({ isZh, run, showProgressPill = true }) => {
  const logRef = useRef<HTMLDivElement>(null);
  const logLen = run?.logs.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLen]);

  if (!run) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 text-sm text-gray-500 dark:text-gray-400">
        {isZh ? '尚未运行。点上方「开始创作 / 重新跑」启动一次。' : 'Not run yet. Start a run above.'}
      </div>
    );
  }

  const isRunning = run.status === 'running';
  const doneCount = run.steps.filter((s) => s.status === 'done').length;
  const totalSteps = run.steps.length;

  return (
    <>
      {showProgressPill ? (
        <div className={`rounded-xl border p-4 mb-4 ${
          isRunning ? 'border-green-500 ring-2 ring-green-500/30 noobclaw-running-glow bg-white dark:bg-gray-900' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
        }`}>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="flex items-center gap-3 flex-wrap text-xs">
              {totalSteps > 0 && (
                <span className={`rounded-lg px-3 py-1.5 inline-flex items-center gap-2 ${
                  isRunning ? 'border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10' : 'border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
                }`}>
                  <span className={`text-[10px] ${isRunning ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-gray-500'}`}>
                    {isRunning ? (isZh ? '本次运行进度' : 'Current Run') : (isZh ? '步骤' : 'Steps')}
                  </span>
                  <span className="font-mono">
                    🎬 <strong className={isRunning ? 'text-green-600 dark:text-green-400' : ''}>{doneCount}</strong>
                    <span className="text-gray-400">/{totalSteps}</span>
                  </span>
                </span>
              )}
              <span className="rounded-lg px-3 py-1.5 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 inline-flex items-center gap-2">
                <span className="text-[10px] text-gray-500">{isZh ? '本次消耗' : 'Cost'}</span>
                <span className="font-mono">🎟️ {fmtNum(run.tokensUsed)} <span className="text-[10px] text-gray-400 font-sans">tokens</span></span>
              </span>
            </div>
            <StatusPill isZh={isZh} status={run.status} />
          </div>
          <StepList steps={run.steps} />
        </div>
      ) : (
        totalSteps > 0 && <div className="mb-4"><StepList steps={run.steps} /></div>
      )}

      {/* 流式日志 */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
          {isZh ? '运行日志' : 'Logs'}
        </div>
        <div
          ref={logRef}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-900 text-gray-200 p-3 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed"
        >
          {run.logs.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-500 shrink-0">{l.time}</span>
              <span className="break-words whitespace-pre-wrap">{l.message}</span>
            </div>
          ))}
          {isRunning && <span className="text-green-400 animate-pulse">▋</span>}
        </div>
      </div>

      {/* 成片操作 / 错误 */}
      {run.status === 'done' && run.outputPath && (
        <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-4 mb-4">
          <div className="text-[11px] text-gray-500 dark:text-gray-400 break-all mb-2">{run.outputPath}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => videoCreationService.openFile(run.outputPath!)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-500 text-white hover:bg-rose-600"
            >
              ▶ {isZh ? '预览' : 'Preview'}
            </button>
            <button
              type="button"
              onClick={() => videoCreationService.revealInFolder(run.outputPath!)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              📂 {isZh ? '打开文件夹' : 'Open folder'}
            </button>
          </div>
        </div>
      )}
      {run.status === 'error' && run.error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 mb-4 text-xs text-red-500 break-words whitespace-pre-wrap">
          {run.error}
        </div>
      )}
    </>
  );
};

/** 输出目录条(详情页顶部)。优先用本次运行的目录,否则从成片路径推。 */
const OutputDirBar: React.FC<{ isZh: boolean; dir?: string }> = ({ isZh, dir }) => {
  if (!dir) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 mb-4 flex items-center gap-2 text-xs">
      <span className="text-gray-400 shrink-0">📁 {isZh ? '输出目录' : 'Output dir'}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-gray-600 dark:text-gray-300" title={dir}>{dir}</span>
      <button
        type="button"
        onClick={() => videoCreationService.revealInFolder(dir)}
        className="shrink-0 px-2 py-1 rounded text-[11px] border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        {isZh ? '打开' : 'Open'}
      </button>
    </div>
  );
};

function dirOf(p?: string): string | undefined {
  if (!p) return undefined;
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : undefined;
}

// ── 任务详情页:配置 + 本次运行 + 历史运行 + 重跑/编辑/删除 ─────────────────

const VideoTaskDetail: React.FC<{
  isZh: boolean;
  task: VideoTask;
  runs: VideoRunRecord[];
  latestRun: VideoRunRecord | undefined;
  onBack: () => void;
  onOpenRecord: (id: string) => void;
  onEdit: () => void;
}> = ({ isZh, task, runs, latestRun, onBack, onOpenRecord, onEdit }) => {
  const status = statusOf(task);
  const isRunning = status === 'running';
  const [actionError, setActionError] = useState<string | null>(null);

  const outDir = latestRun?.outputDir || dirOf(latestRun?.outputPath) || dirOf(task.lastOutputPath);

  const handleRerun = () => {
    setActionError(null);
    if (!noobClawAuth.hasEnoughBalanceForTask()) return;
    const rid = videoTaskStore.runTask(task.id);
    if (!rid) {
      setActionError(isZh ? '已有任务在生成中,请等它完成后再跑。' : 'A task is already running. Please wait.');
    }
  };

  const handleDelete = () => {
    if (videoTaskStore.deleteTask(task.id)) onBack();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        ← {isZh ? '返回' : 'Back'}
      </button>

      {/* Header — 平台/类型 badge + 任务#id(对齐币安详情页头部) */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <HeadBadges isZh={isZh} size="md" />
        <IdTag kind="task" id={task.id} isZh={isZh} />
      </div>
      <h2 className="text-lg font-bold dark:text-white mb-3">🎬 {task.title}</h2>

      {/* 配置 + 操作卡(运行中绿框发亮),放最上(对齐币安:先配置再统计) */}
      <div className={`rounded-xl border bg-white dark:bg-gray-900 p-4 mb-4 ${
        isRunning ? 'border-green-500 ring-2 ring-green-500/30 noobclaw-running-glow' : 'border-gray-200 dark:border-gray-700'
      }`}>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{isZh ? '任务配置' : 'Config'}</span>
          <StatusPill isZh={isZh} status={status} />
        </div>
        <ConfigCard isZh={isZh} input={task.input} />

        {/* 操作:重跑 / 编辑 / 删除 */}
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleRerun}
            disabled={isRunning}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
          >
            {task.runCount > 0 ? `🔁 ${isZh ? '重新跑' : 'Rerun'}` : `🎬 ${isZh ? '开始创作' : 'Start'}`}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={isRunning}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            ✏️ {isZh ? '编辑' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isRunning}
            className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-red-500 hover:bg-red-500/5 disabled:opacity-50"
          >
            🗑 {isZh ? '删除任务' : 'Delete'}
          </button>
        </div>
        {actionError && <div className="mt-2 text-xs text-red-500">{actionError}</div>}
      </div>

      {/* 运行中专属:本次运行进度 + 本次消耗(绿卡对,对齐币安 running-only pair) */}
      {isRunning && latestRun && (latestRun.steps.length > 0 || latestRun.tokensUsed > 0) && (
        <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10 noobclaw-running-glow px-4 py-3">
            <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {isZh ? '本次运行进度' : 'Current Run Progress'}
            </div>
            <div className="font-mono text-sm text-gray-700 dark:text-gray-200">
              🎬 <strong className="text-green-600 dark:text-green-400 text-base">{latestRun.steps.filter((s) => s.status === 'done').length}</strong>
              <span className="text-gray-400 dark:text-gray-500">/{latestRun.steps.length}</span>{' '}
              <span className="text-xs text-gray-500 dark:text-gray-400 font-sans">{isZh ? '步骤' : 'steps'}</span>
            </div>
          </div>
          <div className="rounded-xl border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10 noobclaw-running-glow px-4 py-3">
            <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {isZh ? '本次消耗' : 'Current Run Cost'}
            </div>
            <div className="flex items-baseline gap-2 font-mono text-sm text-gray-700 dark:text-gray-200">
              <span>🎟️</span>
              <strong className="text-green-600 dark:text-green-400 text-base">{compactNumber(latestRun.tokensUsed || 0)}</strong>
              <span className="text-xs text-gray-400 font-sans">tokens</span>
            </div>
          </div>
        </div>
      )}

      {/* 统计网格(对齐币安:累计完成/累计消耗/上次完成/上次消耗/上次运行)。
          视频是本地工具,消耗只有 DeepSeek token(无 USD/动作数),故用 🎟️ tokens。 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <VStatCard
          label={isZh ? '累计完成' : 'Total Done'}
          value={`🎬 ${doneVideoCount(task.id)} ${isZh ? '个视频' : 'videos'}`}
        />
        <VStatCard
          label={isZh ? '累计消耗' : 'Total Cost'}
          value={task.cumulativeTokens > 0 ? `🎟️ ${compactNumber(task.cumulativeTokens)}` : '-'}
        />
        <VStatCard
          label={isZh ? '上次完成' : 'Last Done'}
          value={latestRun ? (latestRun.status === 'done' ? `🎬 ${isZh ? '1 个视频' : '1 video'}` : (latestRun.status === 'running' ? (isZh ? '生成中…' : 'Running…') : (isZh ? '失败' : 'Failed'))) : '-'}
        />
        <VStatCard
          label={isZh ? '上次消耗' : 'Last Cost'}
          value={latestRun && latestRun.tokensUsed > 0 ? `🎟️ ${compactNumber(latestRun.tokensUsed)}` : '-'}
        />
        <VStatCard
          label={isZh ? '上次运行' : 'Last Run'}
          value={fmtRelative(task.lastRunAt, isZh)}
          onClick={latestRun ? () => onOpenRecord(latestRun.id) : undefined}
          actionLabel={latestRun ? (isZh ? '查看本次运行记录 →' : 'View run record →') : undefined}
        />
      </div>

      {/* 当前运行明细(对齐币安「当前运行明细」:输出目录 + step + 日志 + 成片) */}
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-base font-bold dark:text-white">{isZh ? '当前运行明细' : 'Current Run Details'}</h2>
        {latestRun && <IdTag kind="record" id={latestRun.id} isZh={isZh} />}
      </div>
      <OutputDirBar isZh={isZh} dir={outDir} />
      <RunBody isZh={isZh} run={latestRun} showProgressPill={false} />

      {/* 历史运行(>1 条时展示,点进运行记录详情) */}
      {runs.length > 1 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            {isZh ? '历史运行' : 'Run history'}
            <span className="ml-2 text-gray-400">{runs.length}</span>
          </div>
          <div className="space-y-2">
            {runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenRecord(r.id)}
                className="w-full text-left rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 hover:border-rose-500/50 transition-colors flex items-center gap-3 text-xs"
              >
                <IdTag kind="record" id={r.id} isZh={isZh} />
                <StatusPill isZh={isZh} status={r.status} />
                {r.tokensUsed > 0 && <span className="text-gray-400">🎟️ {fmtNum(r.tokensUsed)}</span>}
                <span className="ml-auto text-gray-400">{new Date(r.startedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ── 运行记录详情(只读快照) ──────────────────────────────────────────

const VideoRunRecordDetail: React.FC<{
  isZh: boolean;
  run: VideoRunRecord;
  onBack: () => void;
}> = ({ isZh, run, onBack }) => {
  const outDir = run.outputDir || dirOf(run.outputPath);
  const handleDelete = () => {
    if (videoTaskStore.deleteRun(run.id)) onBack();
  };
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        ← {isZh ? '返回运行记录' : 'Back to records'}
      </button>

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <HeadBadges isZh={isZh} size="md" />
        <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono">#{run.id.slice(0, 8)}</span>
      </div>
      <h2 className="text-lg font-bold dark:text-white mb-1">🎬 {run.title}</h2>
      <div className="text-xs text-gray-400 mb-3">
        {isZh ? '运行于 ' : 'Ran at '}{new Date(run.startedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
        {run.finishedAt && <> · {isZh ? '耗时' : 'took'} {Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))}s</>}
      </div>

      <OutputDirBar isZh={isZh} dir={outDir} />

      {/* 配置快照 */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 mb-4">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{isZh ? '本次配置' : 'Config snapshot'}</div>
        <ConfigCard isZh={isZh} input={run.input} />
      </div>

      <RunBody isZh={isZh} run={run} />

      {run.status !== 'running' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleDelete}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-red-500 hover:bg-red-500/5"
          >
            🗑 {isZh ? '删除此记录' : 'Delete record'}
          </button>
        </div>
      )}
    </div>
  );
};

// ── 创建流:先选创作方式,选「单次成片」弹出配置弹窗 ─────────────────────

const VideoCreateFlow: React.FC<{
  isZh: boolean;
  onCreated: (taskId: string) => void;
}> = ({ isZh, onCreated }) => {
  const [showConfig, setShowConfig] = useState(false);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <OriginalShortVideoCard isZh={isZh} onStart={() => setShowConfig(true)} />
        <DailyHotVideoCard isZh={isZh} />
      </section>

      {showConfig && (
        <VideoConfigModal
          isZh={isZh}
          onClose={() => setShowConfig(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
};

// ── 卡片 1:原创短视频 · 单次成片 ───────────────────────────────────

const OriginalShortVideoCard: React.FC<{ isZh: boolean; onStart: () => void }> = ({ isZh, onStart }) => (
  <div className="relative rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-500/10 via-orange-500/5 to-transparent p-5 overflow-hidden flex flex-col">
    <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-rose-500/10 blur-3xl pointer-events-none" />
    <div className="relative flex flex-col flex-1">
      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-500 mb-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
        {isZh ? '单次成片' : 'One-shot'}
      </div>
      <h3 className="text-base font-bold dark:text-white mb-1.5">
        🎬 {isZh ? '原创短视频 · 单次成片' : 'Original Short · One-shot'}
      </h3>
      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
        {isZh
          ? '选赛道自动带出人设和关键词,文案可自己写、也可让 AI 按目标时长写。AI 自动拆分镜、配音、配字幕,用在线视频素材 + 你的参考图凑画面,本地合成竖屏短视频。'
          : 'Pick a track to auto-fill persona & keywords. Write your own script or let AI write one for a target length. AI splits scenes, narrates, subtitles, and fills visuals from stock video + your images, composing a portrait short locally.'}
      </p>
      <button
        type="button"
        onClick={onStart}
        className="w-full px-4 py-2.5 text-sm font-bold rounded-xl bg-rose-500 hover:bg-rose-600 text-white shadow-lg shadow-rose-500/25 transition-all active:scale-95"
      >
        🎬 {isZh ? '开始创作' : 'Start'} →
      </button>
    </div>
  </div>
);

// ── 卡片 2:每日热点短视频 · 自动成片(占位,灰掉) ──────────────────

const DailyHotVideoCard: React.FC<{ isZh: boolean }> = ({ isZh }) => (
  <div className="relative rounded-2xl border border-gray-300/60 dark:border-gray-700/60 bg-gradient-to-br from-gray-500/5 to-transparent p-5 overflow-hidden flex flex-col opacity-70">
    <div className="relative flex flex-col flex-1">
      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 mb-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400" />
        {isZh ? '自动成片' : 'Auto'}
        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">
          {isZh ? '即将推出' : 'Coming Soon'}
        </span>
      </div>
      <h3 className="text-base font-bold text-gray-500 dark:text-gray-400 mb-1.5">
        🔥 {isZh ? '每日热点短视频 · 自动成片' : 'Daily Hot · Auto'}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-3 flex-1">
        {isZh
          ? '每天自动抓取你赛道下的当下热点选题,自动写稿、配音、配画面,按计划批量出片并定时分发。无需人工选题,全自动运转。'
          : 'Auto-fetches trending topics in your niche daily, writes / narrates / fills visuals, batch-produces and schedules distribution — fully hands-off.'}
      </p>
      <button
        type="button"
        disabled
        className="w-full px-4 py-2.5 text-sm font-bold rounded-xl bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed"
      >
        {isZh ? '敬请期待' : 'Coming Soon'}
      </button>
    </div>
  </div>
);

// ── 赛道预设库:选赛道自动带出人设 + 关键词(用户可改) ─────────────────

interface TrackPreset {
  id: string;
  zh: string;
  en: string;
  persona: { zh: string; en: string };
  keywords: { zh: string; en: string };
}

const TRACK_PRESETS: TrackPreset[] = [
  {
    id: 'overseas_life', zh: '🌏 海外生活 · 在日华人', en: 'Overseas Life',
    persona: { zh: '在东京生活 5 年的华人博主，30 岁，普通上班族。租房、通勤、超市囤货都自己搞，分享真实接地气的日本日常，不滤镜、不贩卖焦虑', en: 'An overseas-Chinese blogger who has lived in Tokyo for 5 years — real, down-to-earth daily life in Japan, no sugar-coating' },
    keywords: { zh: '东京生活 日本租房 在日华人 日本超市 省钱攻略 日本通勤 海外生活 日本签证', en: 'tokyo japan-life rent overseas-chinese supermarket save-money commute visa' },
  },
  {
    id: 'food', zh: '🍲 美食 · 探店做饭', en: 'Food',
    persona: { zh: '爱折腾吃喝的上班族，每天给自己做饭，也爱探店。说话热情、会种草，重点讲性价比和踩雷避坑，不浮夸', en: 'A food-loving office worker who cooks daily and explores restaurants — enthusiastic, focused on value and avoiding tourist traps' },
    keywords: { zh: '美食探店 一人食 家常菜 减脂餐 必吃榜 本地美食 空气炸锅 探店打卡', en: 'food restaurant home-cooking healthy-meal must-eat local airfryer foodie' },
  },
  {
    id: 'tech', zh: '💻 数码科技 · 测评', en: 'Tech',
    persona: { zh: '懂行的数码测评博主，自费买机、理性测评。技术名词直接说，优缺点都讲，绝不收钱吹，帮人避坑做选择', en: 'A knowledgeable gadget reviewer who buys his own gear — rational, names the pros and cons, no paid hype' },
    keywords: { zh: '数码测评 手机评测 笔记本 智能硬件 新品上手 科技 数码好物 选购指南', en: 'gadget review smartphone laptop smart-hardware hands-on tech buying-guide' },
  },
  {
    id: 'ai_tools', zh: '🤖 AI 工具 · 效率', en: 'AI Tools',
    persona: { zh: '天天用 AI 干活的效率党，把 ChatGPT / 各种 AI 工具用到飞起。讲人话、给可复制的实操，不空谈概念', en: 'A productivity nerd who uses AI daily — plain talk, copy-paste workflows, no empty hype' },
    keywords: { zh: 'AI工具 ChatGPT 效率提升 AI办公 提示词 自动化 AI神器 副业AI', en: 'ai-tools chatgpt productivity ai-office prompts automation ai-gems' },
  },
  {
    id: 'finance', zh: '💰 财经 · 理财科普', en: 'Finance',
    persona: { zh: '通俗讲钱的财经科普博主，冷静中立。只做知识科普,不荐股、不喊单、不给个性化投资建议,帮人建立常识', en: 'A finance explainer — calm and neutral, knowledge only, no stock tips, no personalized advice' },
    keywords: { zh: '财经科普 理财入门 攒钱方法 基金定投 经济趋势 记账 工资理财 钱生钱', en: 'finance personal-finance saving fund-investing economy budgeting salary money' },
  },
  {
    id: 'crypto', zh: '₿ 加密货币 · Web3', en: 'Crypto · Web3',
    persona: { zh: '把区块链讲清楚的 Web3 科普博主，客观中立。只讲原理和行业动态,不喊单、不带单、不预测价格,提示风险', en: 'A Web3 explainer who makes blockchain clear — objective, no shilling, no price calls, always flags risk' },
    keywords: { zh: '加密货币 区块链 web3 比特币 以太坊 行情解读 链上数据 钱包安全', en: 'crypto blockchain web3 bitcoin ethereum market-analysis on-chain wallet-security' },
  },
  {
    id: 'fitness', zh: '💪 健身 · 减脂日记', en: 'Fitness',
    persona: { zh: '边上班边坚持健身一年的过来人，167cm 从 130 减到 108 斤。正能量但不打鸡血，讲可执行的方法,反对极端节食', en: 'A 9-to-5 worker who lost weight over a year — positive, actionable, anti crash-dieting' },
    keywords: { zh: '居家健身 减脂打卡 增肌 体态矫正 减脂餐 HIIT 健身小白 拉伸', en: 'home-workout fat-loss muscle posture healthy-meal hiit beginner stretching' },
  },
  {
    id: 'travel', zh: '✈️ 旅行 · 攻略分享', en: 'Travel',
    persona: { zh: '爱说走就走的旅行爱好者，一年出去 6-8 次。分享性价比攻略和小众目的地，治愈、令人向往，重实操路线', en: 'A spontaneous traveler — value-focused guides and hidden gems, soothing and aspirational' },
    keywords: { zh: '旅行攻略 周末去哪 小众目的地 citywalk 自驾游 机票便宜 民宿推荐 旅行vlog', en: 'travel-guide weekend-trip hidden-gems citywalk road-trip cheap-flights homestay vlog' },
  },
  {
    id: 'outfit', zh: '👗 穿搭 · 风格分享', en: 'Outfit',
    persona: { zh: '小个子职场穿搭爱好者，155cm。分享通勤、约会、微胖显瘦的实穿搭配，精致但不端着，重点给平价替代', en: 'A petite office-wear blogger (155cm) — wearable commute/date looks, polished, affordable picks' },
    keywords: { zh: '小个子穿搭 通勤穿搭 OOTD 微胖穿搭 法式穿搭 显瘦 气质穿搭 平价单品', en: 'petite-outfit commute-wear ootd plus-size french-style slimming chic affordable' },
  },
  {
    id: 'beauty', zh: '💄 美妆 · 护肤测评', en: 'Beauty',
    persona: { zh: '敏感肌护肤爱好者，研究护肤 8 年、被坑过很多钱。成分党、只推真用过的，讲实测感受不夸大,帮新手避雷', en: 'A sensitive-skin skincare nerd of 8 years — ingredient-driven, only recommends what she has tested' },
    keywords: { zh: '平价护肤 敏感肌 成分党 粉底测评 口红试色 早C晚A 防晒 空瓶记', en: 'affordable-skincare sensitive-skin ingredients foundation lipstick vitamin-c sunscreen empties' },
  },
  {
    id: 'career', zh: '📈 职场 · 成长干货', en: 'Career',
    persona: { zh: '过来人式的职场博主，互联网公司中层。分享沟通、汇报、升职、跳槽的实操干货，实在不灌鸡汤,讲方法和案例', en: 'A been-there career blogger (mid-level in tech) — concrete tips on comms, promotion, job-hopping; no fluff' },
    keywords: { zh: '职场成长 沟通技巧 升职加薪 跳槽 简历 汇报 副业 效率工具', en: 'career-growth communication promotion job-hopping resume reporting side-hustle productivity' },
  },
  {
    id: 'side_hustle', zh: '💼 副业 · 打工人赚钱', en: 'Side Hustle',
    persona: { zh: '下班搞副业一年的普通打工人，杭州互联网运营。真诚不装,只分享自己真做过的副业、真实收入和踩过的坑,不卖课', en: 'A regular worker doing a side hustle after hours — honest, only shares what he actually tried, no course-selling' },
    keywords: { zh: '副业推荐 下班变现 0基础副业 AI副业 在家赚钱 自媒体 兼职 副业项目', en: 'side-hustle monetize beginner-friendly ai-side-hustle work-from-home creator part-time projects' },
  },
  {
    id: 'study_abroad', zh: '🎓 留学 · 申请经验', en: 'Study Abroad',
    persona: { zh: '过来人留学博主，自己申过、踩过坑。耐心细致地讲选校、文书、签证、落地生活，给可照做的清单,不贩卖焦虑', en: 'A study-abroad veteran — patient, detailed guidance on school choice, essays, visas, settling in' },
    keywords: { zh: '留学申请 选校 文书 签证 语言考试 留学生活 落地攻略 奖学金', en: 'study-abroad school-choice essays visa language-test student-life settling scholarship' },
  },
  {
    id: 'parenting', zh: '🧸 育儿 · 亲子日常', en: 'Parenting',
    persona: { zh: '理性育儿不焦虑的妈妈，娃 3 岁。分享科学育儿、绘本、辅食、亲子游戏，温和实在,讲方法不制造焦虑', en: 'A calm, science-minded mom of a 3-year-old — gentle, practical tips on early-ed, books, feeding' },
    keywords: { zh: '科学育儿 早教 绘本推荐 辅食 亲子游戏 母婴好物 新手妈妈 亲子阅读', en: 'parenting early-education picture-books baby-food games baby-gear new-mom reading' },
  },
  {
    id: 'reading', zh: '📚 读书 · 书单笔记', en: 'Reading',
    persona: { zh: '一年读 40-50 本书的普通读者，从事文化行业。分享书单、读后感、读书方法，安静走心,推荐真读过的书', en: 'A reader of ~45 books a year in the culture industry — book lists, reflections, reading methods' },
    keywords: { zh: '读书笔记 年度书单 好书推荐 读书打卡 小说推荐 非虚构 读书方法 书评', en: 'reading-notes annual-booklist recommendations reading-log fiction nonfiction methods reviews' },
  },
  {
    id: 'custom', zh: '✏️ 自定义', en: 'Custom',
    persona: { zh: '', en: '' },
    keywords: { zh: '', en: '' },
  },
];

// ── 配置弹窗(两步向导,模态;支持新建 + 编辑) ────────────────────────

type GenMode = 'stock' | 'pure_ai';
type OutputMode = 'local' | 'upload';
type Platform = 'douyin' | 'xhs' | 'binance';

const SCRIPT_MAX = 800;
const DURATION_OPTIONS = [30, 45, 60, 90];

const VideoConfigModal: React.FC<{
  isZh: boolean;
  onClose: () => void;
  onCreated: (taskId: string) => void;
  /** 传入则为【编辑】模式:预填该任务配置,保存走 updateTask(不立即跑)。 */
  editTask?: VideoTask;
  /** 编辑保存成功回调。 */
  onSaved?: () => void;
}> = ({ isZh, onClose, onCreated, editTask, onSaved }) => {
  const isEdit = !!editTask;
  const [step, setStep] = useState<1 | 2>(1);

  // 编辑模式:从已有任务的 input 反推预填值(赛道按 label 匹配 preset,匹配不到落 custom)。
  const initialTrackId = (() => {
    if (!editTask) return '';
    const t = editTask.input.track;
    const found = TRACK_PRESETS.find((p) => (isZh ? p.zh : p.en) === t);
    return found ? found.id : (t ? 'custom' : '');
  })();

  // 步骤 1:内容
  const [trackId, setTrackId] = useState(initialTrackId);
  const [persona, setPersona] = useState(editTask?.input.persona || '');
  const [keywords, setKeywords] = useState((editTask?.input.keywords || []).join(' '));
  const [script, setScript] = useState(editTask?.input.script || '');
  const [targetSeconds, setTargetSeconds] = useState(editTask?.input.targetSeconds ?? 45);
  const [refImages, setRefImages] = useState<string[]>(editTask?.input.referenceImages || []);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<GenMode>(editTask ? (editTask.input.useStockVideo === false ? 'pure_ai' : 'stock') : 'stock');

  // 步骤 2:出片去向
  const [outputMode, setOutputMode] = useState<OutputMode>('local');
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>({ douyin: true, xhs: true, binance: true });

  const [submitError, setSubmitError] = useState<string | null>(null);

  // 编辑模式:预填的参考图拉缩略图
  useEffect(() => {
    if (!editTask) return;
    for (const p of (editTask.input.referenceImages || [])) {
      videoCreationService.readImageDataUrl(p).then((url) => {
        if (url) setThumbs((prev) => ({ ...prev, [p]: url }));
      });
    }
  }, [editTask]);

  const onPickTrack = (id: string) => {
    setTrackId(id);
    const preset = TRACK_PRESETS.find((t) => t.id === id);
    if (preset && id !== 'custom') {
      setPersona(isZh ? preset.persona.zh : preset.persona.en);
      setKeywords(isZh ? preset.keywords.zh : preset.keywords.en);
    }
  };

  const pickImages = async () => {
    const remaining = 3 - refImages.length;
    if (remaining <= 0) return;
    const paths = await videoCreationService.pickReferenceImages(remaining);
    if (paths.length) {
      setRefImages((prev) => [...prev, ...paths].slice(0, 3));
      for (const p of paths) {
        videoCreationService.readImageDataUrl(p).then((url) => {
          if (url) setThumbs((prev) => ({ ...prev, [p]: url }));
        });
      }
    }
  };

  const removeImage = (idx: number) => setRefImages((prev) => prev.filter((_, i) => i !== idx));
  const togglePlatform = (p: Platform) => setPlatforms((prev) => ({ ...prev, [p]: !prev[p] }));

  const scriptLen = script.trim().length;
  // 文案【选填】:留空 = AI 按目标时长写;填了则不能超上限
  const scriptValid = scriptLen === 0 || scriptLen <= SCRIPT_MAX;
  const step1Valid = trackId !== '' && scriptValid;

  const trackLabel = TRACK_PRESETS.find((t) => t.id === trackId)?.[isZh ? 'zh' : 'en']
    || (trackId === 'custom' ? (editTask?.input.track || (isZh ? '自定义' : 'Custom')) : '');

  const buildTitle = (): string => {
    const kw = keywords.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean);
    const head = kw.slice(0, 2).join(' / ');
    const base = head || trackLabel || (isZh ? '视频创作' : 'Video');
    return scriptLen === 0 ? `${base}（AI 写稿 · ${targetSeconds}s）` : base;
  };

  const buildInput = (): VideoCreationInput => ({
    persona: persona.trim(),
    track: trackLabel,
    keywords: keywords.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean),
    script: script.trim(),
    referenceImages: refImages,
    aspect: '9:16',
    publishTarget: 'local' as VideoPublishTarget,
    targetSeconds,
    useStockVideo: mode === 'stock',
  });

  const handleSubmit = () => {
    const input = buildInput();
    if (isEdit && editTask) {
      // 编辑:保存配置,不立即跑(用户回详情页再点重跑)。
      const ok = videoTaskStore.updateTask(editTask.id, input, buildTitle());
      if (!ok) {
        setSubmitError(isZh ? '任务正在运行,无法编辑。' : 'Task is running, cannot edit.');
        return;
      }
      onSaved?.();
      return;
    }
    // 新建:创建并立即跑。
    if (videoTaskStore.isAnyRunning()) {
      setSubmitError(isZh ? '已有任务在生成中,请等它完成后再新建。' : 'A task is already running. Please wait.');
      return;
    }
    const id = videoTaskStore.createAndRun(input, buildTitle());
    if (!id) {
      setSubmitError(isZh ? '已有任务在生成中,请等它完成后再新建。' : 'A task is already running. Please wait.');
      return;
    }
    onCreated(id);
  };

  const selectedPlatformLabels = (Object.keys(platforms) as Platform[])
    .filter((p) => platforms[p])
    .map((p) => (p === 'douyin' ? (isZh ? '抖音' : 'Douyin') : p === 'xhs' ? (isZh ? '小红书' : 'XHS') : (isZh ? '币安' : 'Binance')));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* 弹窗主体 */}
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl">
        <div className="px-6 pt-6 pb-3 border-b border-gray-100 dark:border-gray-800 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold dark:text-white flex items-center gap-2">
              🎬 {isEdit ? (isZh ? '编辑视频任务' : 'Edit video task') : (isZh ? '原创短视频 · 单次成片' : 'Original Short · One-shot')}
            </h3>
            <div className="flex items-center gap-2 mt-3">
              <StepDot n={1} active={step === 1} done={step > 1} label={isZh ? '内容' : 'Content'} />
              <div className={`h-px w-16 ${step > 1 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={2} active={step === 2} done={false} label={isZh ? '出片' : 'Output'} />
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {step === 1 && (
            <>
              <Field label={isZh ? '赛道（必选）' : 'Track (required)'} hint={isZh ? '选完自动带出人设和关键词，可再改' : 'auto-fills persona & keywords, editable'}>
                <select
                  value={trackId}
                  onChange={(e) => onPickTrack(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                >
                  <option value="">{isZh ? '— 请选择赛道 —' : '— Select a track —'}</option>
                  {TRACK_PRESETS.map((t) => (
                    <option key={t.id} value={t.id}>{isZh ? t.zh : t.en}</option>
                  ))}
                </select>
              </Field>

              <Field label={isZh ? '人设' : 'Persona'} hint={isZh ? '你是谁、对谁说话、什么口吻' : 'who you are and your tone'}>
                <input
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  placeholder={isZh ? '选赛道后自动带出，可修改' : 'auto-filled after picking a track'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                />
              </Field>

              <Field label={isZh ? '关键词' : 'Keywords'} hint={isZh ? '空格分隔，用于搜画面素材' : 'space-separated, used to search stock'}>
                <input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder={isZh ? '选赛道后自动带出，可修改' : 'auto-filled after picking a track'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                />
              </Field>

              <Field
                label={isZh ? '口播文案（选填）' : 'Script (optional)'}
                hint={isZh ? '留空则由 AI 按目标时长自动写稿' : 'leave empty to let AI write it'}
              >
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  rows={5}
                  placeholder={isZh ? `自己写就粘进来,留空让 AI 写…（≤${SCRIPT_MAX} 字）` : `Paste your own, or leave empty for AI… (≤${SCRIPT_MAX} chars)`}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y min-h-[100px]"
                />
                <div className={`mt-1 text-[11px] text-right ${scriptLen > SCRIPT_MAX ? 'text-red-500' : 'text-gray-400'}`}>
                  {scriptLen}/{SCRIPT_MAX}
                  {scriptLen > SCRIPT_MAX && (isZh ? '（超出上限）' : ' (over limit)')}
                </div>
              </Field>

              {/* 目标时长(AI 写稿时按此控制长度) */}
              <Field
                label={isZh ? '目标时长' : 'Target length'}
                hint={isZh ? 'AI 写稿时按此控制(自己写文案则以文案为准)' : 'used when AI writes the script'}
              >
                <div className="flex gap-2">
                  {DURATION_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setTargetSeconds(s)}
                      className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                        targetSeconds === s
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      {s}s
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <Field label={isZh ? '视频参考图（选填，最多 3 张）' : 'Reference images (optional, max 3)'}>
                <div className="flex flex-wrap items-center gap-2">
                  {refImages.map((p, i) => (
                    <div key={i} className="relative group">
                      <div className="w-16 h-16 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
                        {thumbs[p] ? (
                          <img src={thumbs[p]} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[10px] text-gray-500 px-1 text-center break-all">{p.split(/[\\/]/).pop()}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-800 text-white text-xs flex items-center justify-center hover:bg-red-500"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {refImages.length < 3 && (
                    <button
                      type="button"
                      onClick={pickImages}
                      className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-2xl text-gray-400 hover:border-rose-400 hover:text-rose-400 transition-colors"
                    >
                      +
                    </button>
                  )}
                </div>
              </Field>

              <Field label={isZh ? '生成模式' : 'Generation mode'}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <ModeOption
                    active={mode === 'stock'}
                    onClick={() => setMode('stock')}
                    title={isZh ? 'AI 分镜 + 在线视频素材' : 'AI scenes + stock video'}
                    desc={isZh ? '在线视频素材 + 参考图凑画面,便宜快' : 'stock video + your images, cheap & fast'}
                  />
                  <ModeOption
                    active={mode === 'pure_ai'}
                    disabled
                    onClick={() => {}}
                    title={isZh ? '纯 AI 原创' : 'Pure AI original'}
                    desc={isZh ? '画面全 AI 生成（即将推出）' : 'fully AI-generated (coming soon)'}
                    soon={isZh ? '即将推出' : 'Soon'}
                  />
                </div>
              </Field>

              <Field label={isZh ? '出片后' : 'After generation'}>
                <div className="space-y-2">
                  <RadioCard
                    active={outputMode === 'local'}
                    onClick={() => setOutputMode('local')}
                    title={isZh ? '存本地不上传' : 'Save locally, no upload'}
                    desc={isZh ? '只在本机生成 mp4，自己看 / 手动发都行' : 'just produce an mp4 on this machine'}
                  />
                  <RadioCard
                    active={outputMode === 'upload'}
                    onClick={() => setOutputMode('upload')}
                    title={isZh ? '上传到各大平台' : 'Upload to platforms'}
                    desc={isZh ? '出片后自动发到选中的平台' : 'auto-publish to selected platforms after'}
                    soon={isZh ? '即将推出' : 'Soon'}
                  />
                </div>
              </Field>

              {outputMode === 'upload' && (
                <Field label={isZh ? '发布平台（可多选）' : 'Target platforms (multi-select)'}>
                  <div className="flex flex-wrap gap-2">
                    <PlatformCheck checked={platforms.douyin} onClick={() => togglePlatform('douyin')} label={isZh ? '抖音' : 'Douyin'} />
                    <PlatformCheck checked={platforms.xhs} onClick={() => togglePlatform('xhs')} label={isZh ? '小红书' : 'XHS'} />
                    <PlatformCheck checked={platforms.binance} onClick={() => togglePlatform('binance')} label={isZh ? '币安' : 'Binance'} />
                  </div>
                  <div className="mt-2 text-[11px] text-amber-500">
                    {isZh
                      ? `⚠️ 上传功能即将上线，本次仍会先存到本地${selectedPlatformLabels.length ? `（已记下要发：${selectedPlatformLabels.join(' / ')}）` : ''}。`
                      : 'Upload is coming soon — this run still saves locally first.'}
                  </div>
                </Field>
              )}

              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 text-[11px] text-gray-500 dark:text-gray-400 space-y-1">
                <div>🎯 {isZh ? '赛道' : 'Track'}：{trackLabel || '-'}</div>
                <div>📝 {isZh ? '文案' : 'Script'}：{scriptLen === 0 ? (isZh ? `AI 写稿 · ${targetSeconds}s` : `AI · ${targetSeconds}s`) : `${scriptLen} ${isZh ? '字' : 'chars'}`}</div>
                <div>🖼️ {isZh ? '参考图' : 'Images'}：{refImages.length}</div>
              </div>

              {submitError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-500">{submitError}</div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          {step === 1 ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!trackId) { setSubmitError(isZh ? '请先选择赛道' : 'Please pick a track'); return; }
                  if (!scriptValid) { setSubmitError(isZh ? `文案不能超过 ${SCRIPT_MAX} 字` : `Script must be ≤ ${SCRIPT_MAX} chars`); return; }
                  setSubmitError(null);
                  setStep(2);
                }}
                disabled={!step1Valid}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
              >
                {isZh ? '下一步' : 'Next'} →
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                ← {isZh ? '上一步' : 'Back'}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600"
              >
                {isEdit ? `💾 ${isZh ? '保存' : 'Save'}` : `🎬 ${isZh ? '开始创作' : 'Start'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ── 小组件 ──────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="text-sm font-medium dark:text-gray-200 mb-1.5 flex items-center gap-2">
      {label}
      {hint && <span className="text-[11px] font-normal text-gray-400">{hint}</span>}
    </label>
    {children}
  </div>
);

const StepDot: React.FC<{ n: number; active: boolean; done: boolean; label: string }> = ({ n, active, done, label }) => (
  <div className="flex items-center gap-1.5">
    <span
      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
        active ? 'bg-rose-500 text-white' : done ? 'bg-rose-500/20 text-rose-500' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
      }`}
    >
      {done ? '✓' : n}
    </span>
    <span className={`text-xs font-medium ${active ? 'text-rose-500' : 'text-gray-500'}`}>{label}</span>
  </div>
);

const ModeOption: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  soon?: string;
}> = ({ active, disabled, onClick, title, desc, soon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`text-left rounded-lg border p-3 transition-colors ${
      active ? 'border-rose-500 bg-rose-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-rose-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <div className="text-sm font-semibold dark:text-white flex items-center gap-1.5">
      {title}
      {soon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">{soon}</span>}
    </div>
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{desc}</div>
  </button>
);

const RadioCard: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  soon?: string;
}> = ({ active, disabled, onClick, title, desc, soon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors ${
      active ? 'border-rose-500 bg-rose-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-rose-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? 'border-rose-500' : 'border-gray-400'}`}>
      {active && <span className="w-2 h-2 rounded-full bg-rose-500" />}
    </span>
    <span>
      <span className="text-sm font-semibold dark:text-white flex items-center gap-1.5">
        {title}
        {soon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">{soon}</span>}
      </span>
      <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{desc}</span>
    </span>
  </button>
);

const PlatformCheck: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}> = ({ checked, disabled, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-lg border transition-colors ${
      checked
        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-rose-300'}`}
  >
    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${checked ? 'bg-rose-500 border-rose-500 text-white' : 'border-gray-400'}`}>
      {checked ? '✓' : ''}
    </span>
    {label}
  </button>
);
