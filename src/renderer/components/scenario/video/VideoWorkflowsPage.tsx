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
  type VideoAspect,
  type SubtitlePosition,
} from '../../../services/videoCreation';
import {
  videoTaskStore,
  type VideoTask,
  type VideoRunRecord,
  type VideoRunStatus,
  type VideoTaskLog,
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

/** 紧凑数字:123→'123',9939→'9.94K',1.23M。对齐 scenario 详情页的 token 展示。 */
function compactNumber(n: number): string {
  const abs = Math.abs(n || 0);
  if (abs < 1000) return String(n || 0);
  if (abs < 1_000_000) return (n / 1_000).toFixed(abs < 10_000 ? 2 : 1) + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1_000_000_000).toFixed(2) + 'B';
}

/**
 * 消耗 = 积分(credits)+ 美元,对齐币安详情页 `💎 N ≈ $X`。
 * credits 用消耗的 DeepSeek token 数;costUsd 是服务端按 token_price_per_million
 * 算好的权威美元成本。老记录 / 老后端拿不到 costUsd 时只显 💎 token(不显 $)。
 */
function formatCreditsCost(credits: number, costUsd: number): string {
  if (!credits || credits <= 0) return '-';
  const c = Math.round(credits);
  const usd = Number(costUsd) || 0;
  return usd > 0 ? `💎 ${compactNumber(c)} ≈ $${usd.toFixed(4)}` : `💎 ${compactNumber(c)}`;
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
  const mode = input.scriptMode || (s ? 'strict' : 'ai');
  if (mode === 'ai') {
    const prefix = isZh ? `AI 写稿 · ${input.targetSeconds ?? 45}s` : `AI script · ${input.targetSeconds ?? 45}s`;
    if (!s) return prefix;
    return `${prefix}｜${isZh ? '参考' : 'ref'}: ${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
  }
  // strict:逐字朗读
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
          <span title={isZh ? '本次消耗的 AI 积分(≈ 美元;TTS/合成免费)' : 'AI credits this run (≈ USD; TTS/compose free)'}>
            · {run.tokensUsed > 0 ? formatCreditsCost(run.tokensUsed, run.costUsd || 0) : '—'}
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
    <Row label={`📝 ${isZh ? '视频文案' : 'Script'}`}>
      {(() => {
        const s = (input.script || '').trim();
        const mode = input.scriptMode || (s ? 'strict' : 'ai');
        const tag = mode === 'strict'
          ? (isZh ? '严格逐字' : 'verbatim')
          : (isZh ? 'AI 写稿' : 'AI script');
        return (
          <div className="space-y-1">
            <span className="inline-block rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{tag}</span>
            {s
              ? <div className="whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{input.script}</div>
              : <div className="text-gray-400">{isZh ? `留空 · AI 按 ${input.targetSeconds ?? 45}s 写稿` : `empty · AI writes for ${input.targetSeconds ?? 45}s`}</div>}
          </div>
        );
      })()}
    </Row>
    <Row label={`🎞️ ${isZh ? '画面' : 'Visuals'}`}>
      {(input.localVideos && input.localVideos.length > 0)
        ? (isZh ? `本地素材 ${input.localVideos.length} 个` : `${input.localVideos.length} local clips`)
        : input.useStockVideo !== false
          ? (isZh ? '在线视频素材 + 图片' : 'stock video + images')
          : (isZh ? '仅图片' : 'images only')}
    </Row>
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-2">
    <span className="text-gray-400 shrink-0 w-20">{label}</span>
    <span className="flex-1 min-w-0 dark:text-gray-200">{children}</span>
  </div>
);

/**
 * 扁平配置文本行(任务详情页用)。对齐币安详情卡:左列就是一串纯文本字段,
 * 没有内嵌灰框、没有「任务配置」小标题 —— 跟 TaskDetailPage 的 persona/频次/
 * 创建时间块同一种排版。运行记录详情仍用上面带框的 ConfigCard。
 */
const ConfigRows: React.FC<{ isZh: boolean; input: VideoCreationInput }> = ({ isZh, input }) => {
  const kw = (input.keywords || []).filter(Boolean).join(' · ');
  const s = (input.script || '').trim();
  const mode = input.scriptMode || (s ? 'strict' : 'ai');
  const scriptTag = mode === 'strict' ? (isZh ? '严格逐字' : 'verbatim') : (isZh ? 'AI 写稿' : 'AI script');
  const scriptBody = s || (isZh ? `留空 · AI 按 ${input.targetSeconds ?? 45}s 写稿` : `empty · AI writes for ${input.targetSeconds ?? 45}s`);
  const visuals = (input.localVideos && input.localVideos.length > 0)
    ? (isZh ? `本地素材 ${input.localVideos.length} 个` : `${input.localVideos.length} local clips`)
    : input.useStockVideo !== false
      ? (isZh ? '在线视频素材 + 图片' : 'stock video + images')
      : (isZh ? '仅图片' : 'images only');
  return (
    <>
      <div>🎯 {isZh ? '赛道' : 'Track'}：{input.track || '-'}</div>
      <div>🧑 {isZh ? '人设' : 'Persona'}：{input.persona || '-'}</div>
      <div>🏷️ {isZh ? '关键词' : 'Keywords'}：{kw || '-'}</div>
      <div className="break-words whitespace-pre-wrap">
        📝 {isZh ? '视频文案' : 'Script'}：<span className="text-gray-400">[{scriptTag}]</span> {scriptBody}
      </div>
      <div>🎞️ {isZh ? '画面' : 'Visuals'}：{visuals}</div>
    </>
  );
};

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

/** 一段流式日志行(终端风格,自动滚到底)。供每步内联日志框 / 合并日志框共用。 */
const LogLines: React.FC<{ logs: VideoTaskLog[]; active?: boolean }> = ({ logs, active }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  return (
    <div
      ref={ref}
      className="max-h-48 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-gray-700 dark:text-gray-200"
    >
      {logs.map((l, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-gray-400 shrink-0">{l.time}</span>
          <span className="break-words whitespace-pre-wrap">{l.message}</span>
        </div>
      ))}
      {active && <span className="text-green-500 noobclaw-blink text-sm font-bold">▋</span>}
    </div>
  );
};

/**
 * 「当前运行明细」—— 每个步骤一个标题 + 内联流式日志框(对齐币安 StepLogBox:
 * 日志就贴在它所属的步骤里,而不是底部一整段)。日志按 log.step 归到对应步骤。
 * 没有任何 step 标记的旧记录 → 退化成「步骤列表 + 一个合并日志框」。
 */
const StepLogList: React.FC<{ isZh: boolean; steps: VideoCreationProgressStep[]; logs: VideoTaskLog[] }> = ({ isZh, steps, logs }) => {
  const hasStepTag = logs.some((l) => typeof l.step === 'number');
  if (steps.length === 0) {
    // 还没拿到步骤(刚开跑)→ 只显已有日志
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <LogLines logs={logs} active />
      </div>
    );
  }
  if (!hasStepTag) {
    // 旧记录:日志没打 step 标记 → 步骤列表 + 合并日志框(不丢日志)
    return (
      <>
        <div className="mb-3"><StepList steps={steps} /></div>
        {logs.length > 0 && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <LogLines logs={logs} />
          </div>
        )}
      </>
    );
  }
  return (
    <div className="space-y-4">
      {steps.map((s, idx) => {
        const stepLogs = logs.filter((l) => (typeof l.step === 'number' ? l.step : 0) === idx);
        const active = s.status === 'running';
        const done = s.status === 'done';
        const error = s.status === 'error';
        return (
          <div key={s.key}>
            <div className={`text-sm font-medium mb-2 flex items-center gap-1.5 ${
              active ? 'text-green-500' : done ? 'text-green-600 dark:text-green-400' : error ? 'text-red-500' : 'dark:text-gray-300'
            }`}>
              <span>{done ? '✅' : active ? '⏳' : error ? '❌' : '○'}</span>
              <span>{idx + 1}. {s.label}</span>
            </div>
            <div className={`rounded-xl border min-h-[44px] ${
              active ? 'border-green-500/30 bg-green-500/5'
                : done ? 'border-green-500/20 bg-green-500/5'
                : error ? 'border-red-500/20 bg-red-500/5'
                : 'border-gray-200 dark:border-gray-700'
            }`}>
              {stepLogs.length > 0 ? (
                <LogLines logs={stepLogs} active={active} />
              ) : (
                <div className="text-xs text-gray-400 dark:text-gray-500 text-center py-3">
                  {active ? (isZh ? '运行中…' : 'Running…') : (isZh ? '暂无日志' : 'No logs')}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** 把毫秒格式化成 mm:ss(超过 1 小时则 h:mm:ss)。 */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 运行中每秒重渲染一次,驱动实时计时;停跑后不再 tick(省渲染)。 */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

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
  // 运行中每秒 tick,让下方 ⏱️ 计时实时走字;hook 必须在 early return 前无条件调用。
  useTicker(run?.status === 'running');

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
  // 计时:运行中 = now - startedAt(每秒 tick 走字);已结束 = finishedAt - startedAt 定格。
  const elapsedLabel = fmtDuration((run.finishedAt ?? Date.now()) - run.startedAt);

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
                <span className="font-mono">{formatCreditsCost(run.tokensUsed, run.costUsd || 0)}</span>
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
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 flex items-center gap-2">
          <span>{isZh ? '运行日志' : 'Logs'}</span>
          <span className={`font-mono text-[11px] inline-flex items-center gap-1 ${isRunning ? 'text-green-500' : 'text-gray-400'}`}>
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-green-500 noobclaw-blink" />}
            ⏱️ {elapsedLabel}
          </span>
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
          {isRunning && <span className="text-green-400 noobclaw-blink text-sm font-bold">▋</span>}
        </div>
      </div>

      {/* 成片操作 / 错误 */}
      {run.status === 'done' && run.outputPath && (
        <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-4 mb-4">
          <div className="text-sm font-semibold text-green-600 dark:text-green-400 mb-1">
            ✅ {isZh ? '合成完成 · 成片已保存' : 'Done · video saved'}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 break-all mb-3">{run.outputPath}</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => videoCreationService.openFile(run.outputPath!)}
              className="px-4 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 transition-colors"
            >
              ▶ {isZh ? '预览成片' : 'Preview'}
            </button>
            <button
              type="button"
              onClick={() => openFolder(dirOf(run.outputPath))}
              className="px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              📂 {isZh ? '打开输出目录' : 'Open folder'}
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
        onClick={() => openFolder(dir)}
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

/**
 * 打开文件夹 —— 走币安详情页同款 shell.openPath(直接在资源管理器/访达里打开目录)。
 * 旧的 videoCreationService.revealInFolder 走主进程 explorer /select,<dir>,对“目录”
 * 参数在 Tauri sidecar 下经常没反应(/select 是给文件高亮用的);openPath 是币安那边
 * 验证可用的同一条路,这里统一改用它,保证“打开输出目录”按钮真的能打开。
 */
function openFolder(dir?: string): void {
  if (!dir) return;
  try { (window as any).electron?.shell?.openPath?.(dir); } catch { /* ignore */ }
}

// ── 任务详情页:配置 + 本次运行 + 历史运行 + 重跑/编辑/删除 ─────────────────

const VideoTaskDetail: React.FC<{
  isZh: boolean;
  task: VideoTask;
  latestRun: VideoRunRecord | undefined;
  onBack: () => void;
  onOpenRecord: (id: string) => void;
  onEdit: () => void;
}> = ({ isZh, task, latestRun, onBack, onOpenRecord, onEdit }) => {
  const status = statusOf(task);
  const isRunning = status === 'running';
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // 输出目录:优先本次运行的目录,否则从成片路径推(配置卡「输出目录」链接用)。
  const outDir = latestRun?.outputDir || dirOf(latestRun?.outputPath) || dirOf(task.lastOutputPath);

  const handleRerun = async () => {
    setActionError(null);
    // 「重新跑」对齐向导首跑的资金安全预检:模式一(在线素材,无本地上传)成片后会扣
    // 平台基础费 + AI token,这里先刷新余额并用 VIDEO_MODE1_MIN_BALANCE 高门槛校验,
    // 避免重跑也「生成完才发现没钱」(此前重跑只用默认弱阈值 + 旧缓存余额,已补齐)。
    const isStock = !(task.input.localVideos && task.input.localVideos.length > 0);
    if (isStock) {
      setChecking(true);
      try { await noobClawAuth.refreshBalance(); } catch { /* 网络失败退回用本地缓存余额判断,不阻塞 */ }
      setChecking(false);
      if (!noobClawAuth.hasEnoughBalanceForTask(VIDEO_MODE1_MIN_BALANCE)) return;
    } else if (!noobClawAuth.hasEnoughBalanceForTask()) {
      // 本地上传任务不收平台费,但 AI 写稿仍可能实时扣 token → 保留一次轻量余额校验。
      return;
    }
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

      {/* Header — 平台/类型 badge + 任务#id(对齐币安详情页头部:只有徽章 + #id,
          不挂大标题。任务名已在配置行 / 列表里有,顶上再来个大标题就跟币安不一致)。 */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <HeadBadges isZh={isZh} size="md" />
        <IdTag kind="task" id={task.id} isZh={isZh} />
      </div>

      {/* 配置 + 操作卡(运行中绿框发亮)。对齐币安任务详情:左=扁平配置文字行(无嵌套
          边框、无「任务配置」标题),右=横排操作按钮;运行中状态做成右侧绿色「生成中」胶囊。 */}
      <div className={`rounded-xl border bg-white dark:bg-gray-900 p-4 mb-4 ${
        isRunning ? 'border-green-500 ring-2 ring-green-500/30 noobclaw-running-glow' : 'border-gray-200 dark:border-gray-700'
      }`}>
        <div className="flex items-start justify-between gap-4">
          {/* 左:扁平配置文字行 + 创建时间 + 输出目录(与币安详情同款,无嵌套框) */}
          <div className="flex-1 min-w-0 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <ConfigRows isZh={isZh} input={task.input} />
            <div>{isZh ? '创建时间' : 'Created'}：{new Date(task.createdAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</div>
            {outDir && (
              <div className="flex items-center gap-1">
                <span>{isZh ? '输出目录' : 'Output'}：</span>
                <button
                  type="button"
                  onClick={() => openFolder(outDir)}
                  className="text-blue-500 hover:underline text-[11px]"
                >
                  📂 {isZh ? '打开输出文件夹' : 'Open folder'}
                </button>
              </div>
            )}
          </div>

          {/* 右:横排操作(逐字对齐币安任务详情的操作行)。
              运行中 → 只显示绿色「生成中」胶囊(无停止:本地出片不可中断);
              空闲   → 手动触发提示 + 直接运行(绿) + 编辑 + 删除。 */}
          <div className="shrink-0 flex items-center gap-2">
            {isRunning ? (
              <span className="flex items-center gap-1.5 text-sm font-semibold text-green-500">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                {isZh ? '生成中' : 'Running'}
              </span>
            ) : (
              <>
                <span className="text-xs text-gray-400">{isZh ? '✋ 手动触发' : '✋ Manual'}</span>
                <button
                  type="button"
                  onClick={handleRerun}
                  disabled={checking}
                  className="px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
                >
                  {checking
                    ? (isZh ? '校验余额…' : 'Checking…')
                    : task.runCount > 0 ? (isZh ? '🔁 重新跑' : '🔁 Rerun') : (isZh ? '🎬 开始创作' : '🎬 Start')}
                </button>
                <button
                  type="button"
                  onClick={onEdit}
                  className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  {isZh ? '编辑' : 'Edit'}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="px-3 py-2 text-sm rounded-lg border border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  {isZh ? '删除' : 'Delete'}
                </button>
              </>
            )}
          </div>
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
            <div className="flex items-baseline gap-2 font-mono text-base text-green-600 dark:text-green-400 font-bold">
              {formatCreditsCost(latestRun.tokensUsed || 0, latestRun.costUsd || 0)}
            </div>
          </div>
        </div>
      )}

      {/* 统计网格(对齐币安:累计完成/累计消耗/上次完成/上次消耗/上次运行)。
          消耗换算成积分 + 美元(💎 N ≈ $X),跟币安同口径:credits=消耗 token,
          $ = 服务端按 token_price_per_million 算好的权威成本。 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <VStatCard
          label={isZh ? '累计完成' : 'Total Done'}
          value={`🎬 ${doneVideoCount(task.id)} ${isZh ? '个视频' : 'videos'}`}
        />
        <VStatCard
          label={isZh ? '累计消耗' : 'Total Cost'}
          value={formatCreditsCost(task.cumulativeTokens, task.cumulativeCostUsd || 0)}
        />
        <VStatCard
          label={isZh ? '上次完成' : 'Last Done'}
          value={latestRun ? (latestRun.status === 'done' ? `🎬 ${isZh ? '1 个视频' : '1 video'}` : (latestRun.status === 'running' ? (isZh ? '生成中…' : 'Running…') : (isZh ? '失败' : 'Failed'))) : '-'}
        />
        <VStatCard
          label={isZh ? '上次消耗' : 'Last Cost'}
          value={latestRun ? formatCreditsCost(latestRun.tokensUsed, latestRun.costUsd || 0) : '-'}
        />
        <VStatCard
          label={isZh ? '上次运行' : 'Last Run'}
          value={fmtRelative(task.lastRunAt, isZh)}
          onClick={latestRun ? () => onOpenRecord(latestRun.id) : undefined}
          actionLabel={latestRun ? (isZh ? '查看本次运行记录 →' : 'View run record →') : undefined}
        />
      </div>

      {/* 当前运行明细 —— 每步一个标题 + 内联流式日志框(对齐币安任务详情的
          StepLogBox:日志贴在所属步骤里)。完整成片预览 / 报错明细仍在
          「运行记录详情」看,通过下面的「查看本次运行明细 →」点进去。 */}
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-base font-bold dark:text-white">{isZh ? '当前运行明细' : 'Current Run Details'}</h2>
        {latestRun && (
          <button
            type="button"
            onClick={() => onOpenRecord(latestRun.id)}
            className="text-xs font-medium text-rose-500 hover:text-rose-600 transition-colors"
          >
            {isZh ? '查看本次运行明细 →' : 'View run details →'}
          </button>
        )}
      </div>
      {latestRun ? (
        <StepLogList isZh={isZh} steps={latestRun.steps} logs={latestRun.logs} />
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 text-sm text-gray-500 dark:text-gray-400">
          {isZh ? '尚未运行。点上方「开始创作 / 重新跑」启动一次。' : 'Not run yet. Start a run above.'}
        </div>
      )}

      {/* 历史运行不再内嵌在任务详情里(对齐币安:详情页只看「当前运行明细」,
          往期记录走侧栏「运行记录」tab)。「上次运行」卡片可点进最近一条记录。 */}
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
// 严格模式:视频文案逐字朗读,直接决定时长 → 必填且不少于此字数。
const SCRIPT_MIN_STRICT = 200;
// 中文配音约 4.5 字/秒;严格模式据此把字数实时换算成预估时长展示给用户。
const CHARS_PER_SEC = 4.5;
const DURATION_OPTIONS = [30, 45, 60, 90, 120, 180, 240];

// ── MPT 风格出片参数选项 ──
const ASPECT_OPTIONS: { id: VideoAspect; zh: string; en: string; icon: string }[] = [
  { id: '9:16', zh: '竖屏 9:16', en: 'Portrait 9:16', icon: '📱' },
  { id: '16:9', zh: '横屏 16:9', en: 'Landscape 16:9', icon: '🖥️' },
  { id: '1:1', zh: '方形 1:1', en: 'Square 1:1', icon: '🔲' },
];

// edge-tts 常用中文音色(name 直传 sidecar)。
const VOICE_OPTIONS: { id: string; zh: string; en: string }[] = [
  { id: 'zh-CN-XiaoxiaoNeural', zh: '晓晓 · 女声(温柔)', en: 'Xiaoxiao · female (gentle)' },
  { id: 'zh-CN-XiaoyiNeural', zh: '晓伊 · 女声(活泼)', en: 'Xiaoyi · female (lively)' },
  { id: 'zh-CN-YunxiNeural', zh: '云希 · 男声(阳光)', en: 'Yunxi · male (sunny)' },
  { id: 'zh-CN-YunjianNeural', zh: '云健 · 男声(浑厚)', en: 'Yunjian · male (deep)' },
  { id: 'zh-CN-YunyangNeural', zh: '云扬 · 男声(播音)', en: 'Yunyang · male (anchor)' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', zh: '晓北 · 东北女声', en: 'Xiaobei · NE female' },
  { id: 'zh-HK-HiuGaaiNeural', zh: '晓佳 · 粤语女声', en: 'HiuGaai · Cantonese' },
  { id: 'en-US-JennyNeural', zh: 'Jenny · 英文女声', en: 'Jenny · EN female' },
  { id: 'en-US-GuyNeural', zh: 'Guy · 英文男声', en: 'Guy · EN male' },
];

// 本地内置背景音乐(随包 bundle 在 resources/bgm/,来源 MoneyPrinterTurbo 免版税曲库)。
// value 用 builtin:<id> token 传给主进程,bgm.ts 还原成 resources/bgm/<id>.mp3。
// id 必须与 client/resources/bgm/<id>.mp3 文件名(去扩展名)一致。
const BUILTIN_BGM_PREFIX = 'builtin:';
const BUILTIN_BGM: { id: string; zh: string; en: string }[] = [
  { id: 'bgm-01', zh: '内置曲目 1', en: 'Track 1' },
  { id: 'bgm-02', zh: '内置曲目 2', en: 'Track 2' },
  { id: 'bgm-03', zh: '内置曲目 3', en: 'Track 3' },
  { id: 'bgm-04', zh: '内置曲目 4', en: 'Track 4' },
  { id: 'bgm-05', zh: '内置曲目 5', en: 'Track 5' },
  { id: 'bgm-06', zh: '内置曲目 6', en: 'Track 6' },
  { id: 'bgm-07', zh: '内置曲目 7', en: 'Track 7' },
  { id: 'bgm-08', zh: '内置曲目 8', en: 'Track 8' },
];

// 云端曲库:本地只存 8 首,其余放服务端清单(我们手动传 R2 后把中英标题+下载链接配进
// manifest.json)。用户选中后,合成时主进程才按需下载并缓存(见 bgm.ts)。
// value 用 remote:<url> token 传给主进程。清单 URL 走 CDN(static.noobclaw.com),
// 加 ?t= 绕缓存;清单还没上线时 fetch 失败 → 云端列表为空,只展示本地 8 首。
const REMOTE_BGM_PREFIX = 'remote:';
const REMOTE_BGM_MANIFEST_URL = 'https://static.noobclaw.com/bgm/manifest.json';
interface RemoteBgm { id: string; zh: string; en: string; url: string }

/** 把 bgmPath(''/builtin:/remote:/绝对路径)显示成人类可读的名字。 */
function bgmDisplayName(bgmPath: string, isZh: boolean, remote: RemoteBgm[] = []): string {
  if (!bgmPath) return isZh ? '无' : 'none';
  if (bgmPath.startsWith(BUILTIN_BGM_PREFIX)) {
    const id = bgmPath.slice(BUILTIN_BGM_PREFIX.length);
    const item = BUILTIN_BGM.find((b) => b.id === id);
    return item ? (isZh ? item.zh : item.en) : (isZh ? '内置音乐' : 'built-in');
  }
  if (bgmPath.startsWith(REMOTE_BGM_PREFIX)) {
    const url = bgmPath.slice(REMOTE_BGM_PREFIX.length);
    const item = remote.find((b) => b.url === url);
    if (item) return `${isZh ? item.zh : item.en}${isZh ? '（云端）' : ' (cloud)'}`;
    return (url.split('/').pop() || (isZh ? '云端音乐' : 'cloud')) + (isZh ? '（云端）' : ' (cloud)');
  }
  return bgmPath.split(/[\\/]/).pop() || (isZh ? '已选' : 'set');
}

const RATE_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: -25, zh: '慢', en: 'Slow' },
  { v: -10, zh: '稍慢', en: 'Slower' },
  { v: 0, zh: '正常', en: 'Normal' },
  { v: 15, zh: '稍快', en: 'Faster' },
  { v: 30, zh: '快', en: 'Fast' },
];

const SUB_POSITION_OPTIONS: { id: SubtitlePosition; zh: string; en: string }[] = [
  { id: 'top', zh: '顶部', en: 'Top' },
  { id: 'center', zh: '居中', en: 'Center' },
  { id: 'bottom', zh: '底部', en: 'Bottom' },
];

const SUB_FONTSIZE_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: 42, zh: '小', en: 'S' },
  { v: 52, zh: '中', en: 'M' },
  { v: 64, zh: '大', en: 'L' },
];

// 换镜节奏:每段素材最长秒数,越小切得越快。
const PACE_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: 2.5, zh: '快切', en: 'Fast cuts' },
  { v: 4, zh: '适中', en: 'Medium' },
  { v: 6, zh: '舒缓', en: 'Slow' },
];

// BGM 音量档(0~1),混在旁白之下,默认中等。
const BGM_VOLUME_OPTIONS: { v: number; zh: string; en: string }[] = [
  { v: 0.1, zh: '轻', en: 'Soft' },
  { v: 0.18, zh: '中', en: 'Medium' },
  { v: 0.3, zh: '强', en: 'Loud' },
];

// 画面来源:在线素材库自动搜 vs 用户上传本地视频素材拼接。
type MaterialSource = 'stock' | 'local';
const MAX_LOCAL_VIDEOS = 20;

// 模式一(AI 分镜 + 在线素材)生成前的余额门槛:积分 > 此值才放行。
// 一条 1 分钟成片平台基础费约 $0.09~$0.18(≈9~18 万积分,token_price=1.0 口径),
// 加上 DeepSeek 写稿(Pro reasoner ×3)的 token,200000 ≈ 1~2 条 buffer,确保不会
// "生成到一半余额扣穿"。模式二(纯 AI / Seedance)门槛 200 万,本期未开放暂不用。
const VIDEO_MODE1_MIN_BALANCE = 200000;

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
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  // 编辑模式:从已有任务的 input 反推预填值(赛道按 label 匹配 preset,匹配不到落 custom)。
  const initialTrackId = (() => {
    if (!editTask) return '';
    const t = editTask.input.track;
    const found = TRACK_PRESETS.find((p) => (isZh ? p.zh : p.en) === t);
    return found ? found.id : (t ? 'custom' : '');
  })();

  // 步骤 1:文案
  const [trackId, setTrackId] = useState(initialTrackId);
  const [persona, setPersona] = useState(editTask?.input.persona || '');
  const [keywords, setKeywords] = useState((editTask?.input.keywords || []).join(' '));
  const [script, setScript] = useState(editTask?.input.script || '');
  // 文案模式:strict 严格逐字 / ai 参考再创作。编辑老任务时按 input 推断(无字段则有文案=strict)。
  const [scriptMode, setScriptMode] = useState<'strict' | 'ai'>(
    editTask?.input.scriptMode || ((editTask?.input.script || '').trim() ? 'strict' : 'ai'),
  );
  const [targetSeconds, setTargetSeconds] = useState(editTask?.input.targetSeconds ?? 90);

  // 步骤 2:画面(素材来源 / 在线模式 / 本地素材 / 画幅 / 换镜)
  const [materialSource, setMaterialSource] = useState<MaterialSource>(
    (editTask?.input.localVideos && editTask.input.localVideos.length > 0) ? 'local' : 'stock',
  );
  const [localVideos, setLocalVideos] = useState<string[]>(editTask?.input.localVideos || []);
  const [mode, setMode] = useState<GenMode>(editTask ? (editTask.input.useStockVideo === false ? 'pure_ai' : 'stock') : 'stock');
  const [aspect, setAspect] = useState<VideoAspect>(editTask?.input.aspect || '9:16');
  const [maxClipSeconds, setMaxClipSeconds] = useState<number>(editTask?.input.maxClipSeconds ?? 4);

  // 步骤 3:音频(音色 / 语速 / 背景音乐 / BGM 音量)
  const [voice, setVoice] = useState<string>(editTask?.input.voice || 'zh-CN-XiaoxiaoNeural');
  const [voiceRate, setVoiceRate] = useState<number>(editTask?.input.voiceRate ?? 0);
  const [bgmPath, setBgmPath] = useState<string>(editTask?.input.bgmPath || '');
  const [bgmVolume, setBgmVolume] = useState<number>(editTask?.input.bgmVolume ?? 0.18);
  // 云端曲库清单(从 CDN 拉;失败/未上线时为空,只显示本地 8 首)。
  const [remoteBgm, setRemoteBgm] = useState<RemoteBgm[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`${REMOTE_BGM_MANIFEST_URL}?t=${Date.now()}`);
        if (!resp.ok) return;
        const json: any = await resp.json();
        const arr: any[] = Array.isArray(json) ? json : json?.tracks;
        if (!alive || !Array.isArray(arr)) return;
        setRemoteBgm(
          arr
            .filter((x) => x && typeof x.url === 'string' && x.url)
            .map((x) => ({
              id: String(x.id || x.url),
              zh: String(x.zh || x.title || x.name || '云端音乐'),
              en: String(x.en || x.title || x.name || 'Cloud track'),
              url: String(x.url),
            })),
        );
      } catch { /* 清单未上线 / 网络失败:静默,仅用本地曲库 */ }
    })();
    return () => { alive = false; };
  }, []);

  // 步骤 4:字幕 + 出片
  const [subtitleEnabled, setSubtitleEnabled] = useState<boolean>(editTask?.input.subtitleEnabled !== false);
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(editTask?.input.subtitleFontSize ?? 52);
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition>(editTask?.input.subtitlePosition || 'bottom');
  const [outputMode, setOutputMode] = useState<OutputMode>('local');
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>({ douyin: true, xhs: true, binance: true });

  const [submitError, setSubmitError] = useState<string | null>(null);

  const onPickTrack = (id: string) => {
    setTrackId(id);
    const preset = TRACK_PRESETS.find((t) => t.id === id);
    if (preset && id !== 'custom') {
      setPersona(isZh ? preset.persona.zh : preset.persona.en);
      setKeywords(isZh ? preset.keywords.zh : preset.keywords.en);
    }
  };

  // 本地视频素材:可多选追加,封顶 MAX_LOCAL_VIDEOS。
  const pickLocalVideos = async () => {
    const remaining = MAX_LOCAL_VIDEOS - localVideos.length;
    if (remaining <= 0) return;
    const paths = await videoCreationService.pickVideos(remaining);
    if (paths.length) setLocalVideos((prev) => [...prev, ...paths].slice(0, MAX_LOCAL_VIDEOS));
  };
  const removeLocalVideo = (idx: number) => setLocalVideos((prev) => prev.filter((_, i) => i !== idx));

  // 背景音乐:选一首本地音频;再点一次「移除」清空。
  const pickBgm = async () => {
    const p = await videoCreationService.pickBgm();
    if (p) setBgmPath(p);
  };

  // BGM 试听:点一下播、再点停;切歌 / 卸载自动停。token 可为 builtin:/remote:/绝对路径,
  // 云端曲目首次试听时由主进程下载并缓存(resolveBgmPath),既能听又顺带焐热出片缓存。
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  // 每次 stop / 新请求都自增,用来作废「在途的 previewBgm」:云端下载可能耗时数秒,
  // 期间若用户关向导或切歌,resolve 回来时 reqId 已变 → 丢弃,绝不再 new Audio 播放
  // (否则会出现「关了向导音乐还在响」「切了歌却放旧曲」的孤儿播放)。
  const previewReqRef = useRef(0);
  const [previewToken, setPreviewToken] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const stopPreview = () => {
    previewReqRef.current++; // 作废任何在途的 previewBgm
    const a = bgmAudioRef.current;
    if (a) { try { a.pause(); } catch { /* noop */ } a.src = ''; }
    bgmAudioRef.current = null;
    setPreviewToken('');
  };
  const togglePreview = async (token: string) => {
    if (!token) return;
    if (previewToken === token) { stopPreview(); return; } // 正在播这首 → 停
    stopPreview(); // 切到别的曲目 → 先停旧的(并自增 reqId)
    const myReq = previewReqRef.current; // 取「停旧」之后的最新值作为本次请求号
    setPreviewLoading(true);
    try {
      const dataUrl = await videoCreationService.previewBgm(token);
      // 在途期间被 stop(关向导 / 切歌 / 卸载)→ reqId 已变 → 丢弃,不播放。
      if (!dataUrl || previewReqRef.current !== myReq) return;
      const audio = new Audio(dataUrl);
      audio.onended = () => { if (bgmAudioRef.current === audio) stopPreview(); };
      bgmAudioRef.current = audio;
      setPreviewToken(token);
      await audio.play().catch(() => { /* 自动播放被拦时静默 */ });
    } catch {
      /* 试听失败静默,不打断向导 */
    } finally {
      setPreviewLoading(false);
    }
  };
  // 切换曲目时停掉正在播的试听;组件卸载时也停。
  useEffect(() => { stopPreview(); }, [bgmPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopPreview(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlatform = (p: Platform) => setPlatforms((prev) => ({ ...prev, [p]: !prev[p] }));

  // BGM 三态:'' = 无;builtin:/remote: = 曲库(本地内置+云端);其它绝对路径 = 用户上传。
  const bgmIsBuiltin = bgmPath.startsWith(BUILTIN_BGM_PREFIX);
  const bgmIsRemote = bgmPath.startsWith(REMOTE_BGM_PREFIX);
  const bgmIsLibrary = bgmIsBuiltin || bgmIsRemote;
  const bgmIsUpload = !!bgmPath && !bgmIsLibrary;
  // 编辑老任务时,选的云端曲目可能还没在已拉到的清单里 → 补一个占位 option,避免下拉空白。
  const bgmInLibraryList = bgmIsBuiltin
    ? BUILTIN_BGM.some((b) => `${BUILTIN_BGM_PREFIX}${b.id}` === bgmPath)
    : bgmIsRemote
      ? remoteBgm.some((b) => `${REMOTE_BGM_PREFIX}${b.url}` === bgmPath)
      : true;

  const scriptLen = script.trim().length;
  // 严格模式据字数预估时长(向上取整,中文约 4.5 字/秒)。
  const strictEstSec = Math.max(1, Math.round(scriptLen / CHARS_PER_SEC));
  // 文案校验:
  //   strict 严格逐字:必填、≥SCRIPT_MIN_STRICT 字、≤SCRIPT_MAX 字(直接决定时长)。
  //   ai 参考:选填,填了则不超上限。
  const scriptValid = scriptMode === 'strict'
    ? (scriptLen >= SCRIPT_MIN_STRICT && scriptLen <= SCRIPT_MAX)
    : (scriptLen === 0 || scriptLen <= SCRIPT_MAX);
  const scriptStepValid = trackId !== '' && scriptValid;
  // 画面:选了本地上传却没传素材时挡一下
  const visualStepValid = materialSource === 'stock' || localVideos.length > 0;

  const trackLabel = TRACK_PRESETS.find((t) => t.id === trackId)?.[isZh ? 'zh' : 'en']
    || (trackId === 'custom' ? (editTask?.input.track || (isZh ? '自定义' : 'Custom')) : '');

  const buildTitle = (): string => {
    const kw = keywords.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean);
    const head = kw.slice(0, 2).join(' / ');
    const base = head || trackLabel || (isZh ? '视频创作' : 'Video');
    if (scriptMode === 'strict') return `${base}（${isZh ? '严格文案' : 'strict'} · ${scriptLen}${isZh ? '字' : 'ch'}）`;
    return `${base}（AI ${isZh ? '写稿' : 'script'} · ${targetSeconds}s）`;
  };

  const buildInput = (): VideoCreationInput => ({
    persona: persona.trim(),
    track: trackLabel,
    keywords: keywords.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean),
    script: script.trim(),
    scriptMode,
    referenceImages: [], // 参考图已弃用,保留字段向后兼容
    // 用户上传的本地视频素材:有就带上(在线模式下会和在线空镜混拼;
    // 老的纯本地任务 useStockVideo=false 则只用本地)。
    localVideos: localVideos.length > 0 ? localVideos : undefined,
    aspect,
    publishTarget: 'local' as VideoPublishTarget,
    targetSeconds,
    // 在线模式(stock)= 用在线素材库(本地素材作为叠加混拼);老的纯本地任务保持不搜在线。
    useStockVideo: materialSource === 'local' ? false : (mode === 'stock'),
    voice,
    voiceRate,
    bgmPath: bgmPath || undefined,
    bgmVolume,
    subtitleEnabled,
    subtitleFontSize,
    subtitlePosition,
    maxClipSeconds,
  });

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
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
    // 模式一(AI 分镜 + 在线素材)pre-flight:成片成功后会扣平台基础费 + AI token,
    // 这里先拉最新余额校验 > 200000 积分才放行,避免"视频已生成才发现没钱"。
    // 不足时 hasEnoughBalanceForTask 会派发 token-insufficient 事件 → 全局充值弹窗。
    if (materialSource === 'stock') {
      setSubmitting(true);
      try {
        await noobClawAuth.refreshBalance();
      } catch { /* 网络失败时退回用本地缓存余额判断,不阻塞 */ }
      setSubmitting(false);
      if (!noobClawAuth.hasEnoughBalanceForTask(VIDEO_MODE1_MIN_BALANCE)) {
        onClose();
        return;
      }
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
              <StepDot n={1} active={step === 1} done={step > 1} label={isZh ? '模式' : 'Mode'} />
              <div className={`h-px w-6 ${step > 1 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={2} active={step === 2} done={step > 2} label={isZh ? '文案' : 'Script'} />
              <div className={`h-px w-6 ${step > 2 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={3} active={step === 3} done={step > 3} label={isZh ? '画面' : 'Visuals'} />
              <div className={`h-px w-6 ${step > 3 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={4} active={step === 4} done={step > 4} label={isZh ? '音频' : 'Audio'} />
              <div className={`h-px w-6 ${step > 4 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
              <StepDot n={5} active={step === 5} done={false} label={isZh ? '字幕·出片' : 'Output'} />
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* ── 步骤 1:生成模式(先定这条视频怎么做)── */}
          {step === 1 && (
            <>
              <Field label={isZh ? '生成模式' : 'Generation mode'} hint={isZh ? '先选这条视频怎么做' : 'how this video is made'}>
                <div className="grid grid-cols-1 gap-2">
                  <ModeOption
                    active={materialSource === 'stock' && mode === 'stock'}
                    onClick={() => { setMaterialSource('stock'); setMode('stock'); }}
                    title={isZh ? 'AI 分镜 + 在线素材' : 'AI scenes + stock'}
                    desc={isZh ? '只适合无真人出镜口播类（知识科普 / 资讯解说 / 好物种草）；AI 按文案自动搜在线空镜拼接，也可叠加你自己的视频素材混拼' : 'voice-over only, no real person; AI auto-searches stock B-roll by your script, and can mix in your own clips'}
                    cost={isZh ? '约 $0.1~$0.2/每条' : '~$0.1~$0.2 each'}
                    costTag={isZh ? '性价比高 · 推荐' : 'Best value'}
                  />
                  <ModeOption
                    active={mode === 'pure_ai'}
                    disabled
                    onClick={() => {}}
                    title={isZh ? '纯 AI 生成' : 'Pure AI'}
                    desc={isZh ? '适合各个场景，由 Seedance 支持' : 'any scene, powered by Seedance'}
                    soon={isZh ? '即将推出' : 'Soon'}
                  />
                </div>
              </Field>
            </>
          )}

          {/* ── 步骤 2:文案 ── */}
          {step === 2 && (
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

              {/* 文案模式:严格逐字 vs AI 参考再创作 */}
              <Field label={isZh ? '文案模式' : 'Script mode'} hint={isZh ? '决定视频文案怎么用' : 'how your script is used'}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <ModeOption
                    active={scriptMode === 'strict'}
                    onClick={() => setScriptMode('strict')}
                    title={isZh ? '严格按我的视频文案' : 'Use my script verbatim'}
                    desc={isZh ? '逐字朗读，文案长度直接决定视频长度' : 'read verbatim; length sets video length'}
                  />
                  <ModeOption
                    active={scriptMode === 'ai'}
                    onClick={() => setScriptMode('ai')}
                    title={isZh ? 'AI 参考我的文案' : 'AI writes (reference mine)'}
                    desc={isZh ? 'AI 写稿，你的文案仅作参考（可不填）' : 'AI writes; your text is just a reference'}
                  />
                </div>
              </Field>

              <Field
                label={isZh ? '视频文案' : 'Script'}
                hint={scriptMode === 'strict'
                  ? (isZh ? `逐字朗读，不少于 ${SCRIPT_MIN_STRICT} 字；字数越多视频越长` : `read verbatim; at least ${SCRIPT_MIN_STRICT} chars`)
                  : (isZh ? '选填，留空则由 AI 按目标时长写稿；填了 AI 会参考' : 'optional; AI writes for target length, uses yours as reference')}
              >
                <textarea
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  rows={5}
                  placeholder={scriptMode === 'strict'
                    ? (isZh ? `把要逐字朗读的视频文案粘进来…（${SCRIPT_MIN_STRICT}~${SCRIPT_MAX} 字）` : `Paste the exact narration… (${SCRIPT_MIN_STRICT}~${SCRIPT_MAX} chars)`)
                    : (isZh ? `给 AI 的参考方向，可留空…（≤${SCRIPT_MAX} 字）` : `Reference for AI, can be empty… (≤${SCRIPT_MAX} chars)`)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y min-h-[100px]"
                />
                <div className={`mt-1 text-[11px] text-right ${!scriptValid ? 'text-red-500' : 'text-gray-400'}`}>
                  {scriptLen}/{SCRIPT_MAX}
                  {scriptMode === 'strict' && scriptLen > 0 && scriptLen < SCRIPT_MIN_STRICT
                    && (isZh ? `（还需 ${SCRIPT_MIN_STRICT - scriptLen} 字）` : ` (need ${SCRIPT_MIN_STRICT - scriptLen} more)`)}
                  {scriptLen > SCRIPT_MAX && (isZh ? '（超出上限）' : ' (over limit)')}
                </div>
              </Field>

              {scriptMode === 'strict' ? (
                /* 严格模式:不选目标时长,实时按字数预估时长展示 */
                <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/20 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
                  {scriptLen >= SCRIPT_MIN_STRICT
                    ? (isZh
                        ? `⏱️ 预估视频时长约 ${strictEstSec}s（按中文 ${CHARS_PER_SEC} 字/秒朗读估算，实际以配音为准）`
                        : `⏱️ Estimated ~${strictEstSec}s (at ${CHARS_PER_SEC} chars/sec; actual depends on TTS)`)
                    : (isZh
                        ? `⏱️ 填够 ${SCRIPT_MIN_STRICT} 字后这里显示预估时长（按 ${CHARS_PER_SEC} 字/秒）`
                        : `⏱️ Estimate shows after ${SCRIPT_MIN_STRICT} chars`)}
                </div>
              ) : (
                /* AI 模式:目标时长选择(AI 据此控制字数) */
                <Field
                  label={isZh ? '目标时长' : 'Target length'}
                  hint={isZh ? 'AI 写稿时按此控制长度' : 'used when AI writes the script'}
                >
                  <div className="flex flex-wrap gap-2">
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
                        {s >= 120 ? (isZh ? `${s / 60}分钟` : `${s / 60}min`) : `${s}s`}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
            </>
          )}

          {/* ── 步骤 3:画面 ── */}
          {step === 3 && (
            <>
              {/* 本地视频素材:老的纯本地任务为必填;在线模式下为选填(和在线空镜混拼)。 */}
              <Field
                label={materialSource === 'local'
                  ? (isZh ? `本地视频素材（最多 ${MAX_LOCAL_VIDEOS} 个）` : `Local videos (max ${MAX_LOCAL_VIDEOS})`)
                  : (isZh ? `也用我的视频素材（选填，最多 ${MAX_LOCAL_VIDEOS} 个）` : `Also use my videos (optional, max ${MAX_LOCAL_VIDEOS})`)}
                hint={materialSource === 'local'
                  ? (isZh ? '可多选，按换镜节奏循环切' : 'multi-select, looped by pacing')
                  : (isZh ? '选填：和在线空镜混着拼；留空则全部用在线素材（仅 mp4/mov/webm 等，单个 ≤200MB）' : 'optional: mixed with online stock; empty = all stock (≤200MB each)')}
              >
                <div className="space-y-1.5">
                    {localVideos.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-1.5">
                        <span className="text-sm">🎞️</span>
                        <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{p.split(/[\\/]/).pop()}</span>
                        <button
                          type="button"
                          onClick={() => removeLocalVideo(i)}
                          className="w-5 h-5 rounded-full bg-gray-300 dark:bg-gray-600 text-white text-xs flex items-center justify-center hover:bg-red-500 shrink-0"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {localVideos.length < MAX_LOCAL_VIDEOS && (
                      <button
                        type="button"
                        onClick={pickLocalVideos}
                        className="w-full py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-sm text-gray-500 hover:border-rose-400 hover:text-rose-400 transition-colors"
                      >
                        ＋ {isZh ? '添加本地视频' : 'Add videos'}
                      </button>
                    )}
                  </div>
              </Field>

              {/* 画幅比例 */}
              <Field label={isZh ? '视频比例' : 'Aspect ratio'} hint={isZh ? '决定成片尺寸与素材搜索方向' : 'sets output size & stock orientation'}>
                <div className="flex gap-2">
                  {ASPECT_OPTIONS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAspect(a.id)}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${
                        aspect === a.id
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      <span className="mr-1">{a.icon}</span>{isZh ? a.zh : a.en}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 换镜节奏 */}
              <Field label={isZh ? '换镜节奏' : 'Clip pacing'} hint={isZh ? '每段素材最长时长，越快画面越动感' : 'shorter = more dynamic cuts'}>
                <div className="flex gap-2">
                  {PACE_OPTIONS.map((p) => (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => setMaxClipSeconds(p.v)}
                      className={`flex-1 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                        maxClipSeconds === p.v
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      {isZh ? p.zh : p.en}<span className="ml-1 text-[10px] opacity-60">{p.v}s</span>
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}

          {/* ── 步骤 4:音频 ── */}
          {step === 4 && (
            <>
              {/* 配音音色 + 语速 */}
              <Field label={isZh ? '配音音色' : 'Voice'} hint={isZh ? 'edge-tts 在线合成，免费' : 'edge-tts, free'}>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                >
                  {VOICE_OPTIONS.map((v) => (
                    <option key={v.id} value={v.id}>{isZh ? v.zh : v.en}</option>
                  ))}
                </select>
                <div className="flex gap-2 mt-2">
                  {RATE_OPTIONS.map((r) => (
                    <button
                      key={r.v}
                      type="button"
                      onClick={() => setVoiceRate(r.v)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                        voiceRate === r.v
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                      }`}
                    >
                      {isZh ? r.zh : r.en}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 背景音乐(选填):无 / 内置曲库 / 自定义上传 */}
              <Field label={isZh ? '背景音乐（选填）' : 'Background music (optional)'} hint={isZh ? '混在旁白下方，出片末尾自动淡出' : 'mixed under narration, fades out'}>
                {/* 三选一来源 */}
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setBgmPath('')}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                      !bgmPath
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {isZh ? '无' : 'None'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (!bgmIsLibrary) setBgmPath(BUILTIN_BGM_PREFIX + BUILTIN_BGM[0].id); }}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                      bgmIsLibrary
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {isZh ? '曲库' : 'Library'}
                  </button>
                  <button
                    type="button"
                    onClick={pickBgm}
                    className={`px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                      bgmIsUpload
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {isZh ? '上传' : 'Upload'}
                  </button>
                </div>

                {/* 曲库:下拉选具体曲目(本地内置 + 云端)。value 直接是 builtin:/remote: token。 */}
                {bgmIsLibrary && (
                  <>
                    <select
                      value={bgmPath}
                      onChange={(e) => setBgmPath(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                    >
                      {!bgmInLibraryList && (
                        <option value={bgmPath}>🎵 {bgmDisplayName(bgmPath, isZh, remoteBgm)}</option>
                      )}
                      <optgroup label={isZh ? '本地内置' : 'Built-in'}>
                        {BUILTIN_BGM.map((b) => (
                          <option key={b.id} value={`${BUILTIN_BGM_PREFIX}${b.id}`}>🎵 {isZh ? b.zh : b.en}</option>
                        ))}
                      </optgroup>
                      {remoteBgm.length > 0 && (
                        <optgroup label={isZh ? '云端曲库（首次需下载）' : 'Cloud (downloads on first use)'}>
                          {remoteBgm.map((b) => (
                            <option key={b.url} value={`${REMOTE_BGM_PREFIX}${b.url}`}>☁️ {isZh ? b.zh : b.en}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    {bgmIsRemote && (
                      <div className="mt-1 text-[11px] text-gray-400">
                        {isZh ? '☁️ 云端曲目首次合成时自动下载并缓存，之后复用不再下载。' : '☁️ Cloud track downloads on first compose, then cached.'}
                      </div>
                    )}
                  </>
                )}

                {/* 用户上传:显示文件名 + 更换/移除 */}
                {bgmIsUpload && (
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-2">
                    <span className="text-sm">🎵</span>
                    <span className="flex-1 text-xs text-gray-600 dark:text-gray-300 truncate">{bgmPath.split(/[\\/]/).pop()}</span>
                    <button type="button" onClick={pickBgm} className="text-xs text-rose-500 hover:underline shrink-0">{isZh ? '更换' : 'Change'}</button>
                    <button type="button" onClick={() => setBgmPath('')} className="text-xs text-gray-400 hover:text-red-500 shrink-0">{isZh ? '移除' : 'Remove'}</button>
                  </div>
                )}
                {/* 试听:本地/上传直接放;云端首次点会下载并缓存(随后出片复用不再下载)。 */}
                {bgmPath && (
                  <button
                    type="button"
                    onClick={() => togglePreview(bgmPath)}
                    disabled={previewLoading}
                    className={`mt-2 w-full px-3 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-60 ${
                      previewToken === bgmPath
                        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                    }`}
                  >
                    {previewLoading && previewToken !== bgmPath
                      ? (isZh ? (bgmIsRemote ? '⏳ 下载中…' : '⏳ 加载中…') : (bgmIsRemote ? 'Downloading…' : 'Loading…'))
                      : previewToken === bgmPath
                        ? (isZh ? '⏹ 停止试听' : '⏹ Stop')
                        : (isZh ? '▶ 试听' : '▶ Preview')}
                  </button>
                )}
                {bgmPath && (
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs text-gray-500 self-center">{isZh ? 'BGM 音量' : 'BGM volume'}</span>
                    {BGM_VOLUME_OPTIONS.map((b) => (
                      <button
                        key={b.v}
                        type="button"
                        onClick={() => setBgmVolume(b.v)}
                        className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-colors ${
                          bgmVolume === b.v
                            ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                            : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                        }`}
                      >
                        {isZh ? b.zh : b.en}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </>
          )}

          {/* ── 步骤 5:字幕 + 出片 ── */}
          {step === 5 && (
            <>
              {/* 字幕样式 + 开关 */}
              <Field label={isZh ? '字幕' : 'Subtitles'} hint={isZh ? '开启时用 edge-tts 词边界对齐时间轴' : 'edge-tts word-boundary timing when on'}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600 dark:text-gray-300">{isZh ? '烧录字幕' : 'Burn subtitles'}</span>
                  <button
                    type="button"
                    onClick={() => setSubtitleEnabled((v) => !v)}
                    className={`relative w-11 h-6 rounded-full transition-colors ${subtitleEnabled ? 'bg-rose-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${subtitleEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                {subtitleEnabled && (
                  <div className="flex gap-2">
                    <div className="flex gap-1">
                      {SUB_FONTSIZE_OPTIONS.map((f) => (
                        <button
                          key={f.v}
                          type="button"
                          onClick={() => setSubtitleFontSize(f.v)}
                          className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            subtitleFontSize === f.v
                              ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                              : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                          }`}
                        >
                          {isZh ? f.zh : f.en}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      {SUB_POSITION_OPTIONS.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setSubtitlePosition(s.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                            subtitlePosition === s.id
                              ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
                              : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-rose-300'
                          }`}
                        >
                          {isZh ? s.zh : s.en}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
                <div>📝 {isZh ? '文案' : 'Script'}：{scriptMode === 'strict'
                  ? (isZh ? `严格逐字 · ${scriptLen} 字 ≈ ${strictEstSec}s` : `verbatim · ${scriptLen} ch ≈ ${strictEstSec}s`)
                  : (scriptLen === 0
                      ? (isZh ? `AI 写稿 · ${targetSeconds}s` : `AI · ${targetSeconds}s`)
                      : (isZh ? `AI 写稿 · ${targetSeconds}s（参考 ${scriptLen} 字）` : `AI · ${targetSeconds}s (ref ${scriptLen} ch)`))}</div>
                <div>🎬 {isZh ? '画面' : 'Visuals'}：{materialSource === 'local'
                  ? (isZh ? `本地素材 ${localVideos.length} 个` : `${localVideos.length} local clips`)
                  : (isZh
                      ? `在线素材库${localVideos.length > 0 ? ` + 本地 ${localVideos.length} 个` : ''}`
                      : `online stock${localVideos.length > 0 ? ` + ${localVideos.length} local` : ''}`)}</div>
                <div>🎵 {isZh ? '背景音乐' : 'BGM'}：{bgmDisplayName(bgmPath, isZh, remoteBgm)}</div>
                <div>💬 {isZh ? '字幕' : 'Subtitles'}：{subtitleEnabled ? (isZh ? '开' : 'on') : (isZh ? '关' : 'off')}</div>
              </div>

              {submitError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-500">{submitError}</div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          <button
            type="button"
            onClick={() => (step === 1 ? onClose() : setStep((s) => (s - 1) as 1 | 2 | 3 | 4 | 5))}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {step === 1 ? (isZh ? '取消' : 'Cancel') : `← ${isZh ? '上一步' : 'Back'}`}
          </button>
          {step < 5 ? (
            <button
              type="button"
              onClick={() => {
                if (step === 2) {
                  if (!trackId) { setSubmitError(isZh ? '请先选择赛道' : 'Please pick a track'); return; }
                  if (!scriptValid) {
                    if (scriptMode === 'strict' && scriptLen < SCRIPT_MIN_STRICT) {
                      setSubmitError(isZh ? `严格模式下视频文案不少于 ${SCRIPT_MIN_STRICT} 字（当前 ${scriptLen} 字）` : `Verbatim mode needs ≥ ${SCRIPT_MIN_STRICT} chars (now ${scriptLen})`);
                    } else {
                      setSubmitError(isZh ? `文案不能超过 ${SCRIPT_MAX} 字` : `Script must be ≤ ${SCRIPT_MAX} chars`);
                    }
                    return;
                  }
                }
                if (step === 3 && !visualStepValid) {
                  setSubmitError(isZh ? '选了本地上传,请至少添加一个视频素材' : 'Please add at least one local video');
                  return;
                }
                setSubmitError(null);
                setStep((s) => (s + 1) as 1 | 2 | 3 | 4 | 5);
              }}
              disabled={(step === 2 && !scriptStepValid) || (step === 3 && !visualStepValid)}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
            >
              {isZh ? '下一步' : 'Next'} →
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
            >
              {submitting
                ? (isZh ? '校验余额…' : 'Checking balance…')
                : isEdit ? `💾 ${isZh ? '保存' : 'Save'}` : `🎬 ${isZh ? '开始创作' : 'Start'}`}
            </button>
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
  /** 成本提示行(如「≈$0.1/分钟起」),带高亮底色显示。 */
  cost?: string;
  /** 成本行右侧小标签(如「推荐」)。 */
  costTag?: string;
}> = ({ active, disabled, onClick, title, desc, soon, cost, costTag }) => (
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
    {cost && (
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">{cost}</span>
        {costTag && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 font-medium">{costTag}</span>}
      </div>
    )}
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
