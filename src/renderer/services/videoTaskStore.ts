/**
 * videoTaskStore — 渲染端「视频创作任务」的轻量持久化 store(模块级单例)。
 *
 * 为什么不复用 scenario 任务体系:scenario 那套(scenarioManager / taskStore /
 * runRecords + 主进程 2s 轮询)是为【浏览器自动化 + 定时调度】设计的,视频创作是
 * 纯本地 ffmpeg 流水线,塞进去得改一大堆主进程代码且没法单测。这里用一个 store
 * 单例镜像它的【交互体验】(发光卡片 / 详情页 / 流式日志),底层仍走现成的
 * videoCreationService.generate + onProgress(主进程零改动)。
 *
 * 设计要点:
 *   - store 是模块级单例,生命周期 = 整个渲染进程,所以页面间切换(卸载组件)
 *     不会中断正在跑的任务,日志也不丢(订阅活在 store 里,不在组件里)。
 *   - 任务列表持久化到 localStorage;重启后还能看到历史成片。重启时把上次残留的
 *     'running' 标成 'error(已中断)'(主进程那次 job 已随刷新丢失)。
 *   - 一次只允许跑一个任务(本地 ffmpeg 很吃资源,且单任务时 onProgress 事件路由
 *     无歧义)。已有任务在跑时 createAndRun 直接拒绝。
 */

import {
  videoCreationService,
  type VideoCreationInput,
  type VideoCreationProgress,
  type VideoCreationProgressStep,
} from './videoCreation';

const STORAGE_KEY = 'noobclaw_video_tasks';
const MAX_TASKS = 50;       // 列表上限,超了丢最旧的
const MAX_LOGS = 400;       // 每个任务的日志条数上限

export type VideoTaskStatus = 'running' | 'done' | 'error';

export interface VideoTaskLog {
  /** "HH:MM:SS" */
  time: string;
  message: string;
}

export interface VideoTask {
  id: string;
  /** 列表/详情页标题(由赛道 + 关键词派生)。 */
  title: string;
  input: VideoCreationInput;
  status: VideoTaskStatus;
  steps: VideoCreationProgressStep[];
  logs: VideoTaskLog[];
  /** 最近一条进度文案(卡片副标题用)。 */
  message?: string;
  outputPath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

type Listener = () => void;

function nowHms(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function genId(): string {
  return `vtask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

class VideoTaskStore {
  private tasks: VideoTask[] = [];
  private listeners = new Set<Listener>();
  private running = false;

  constructor() {
    this.load();
  }

  // ── 持久化 ──────────────────────────────────────────────
  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.tasks = parsed.map((t: VideoTask) => {
            // 重启后上次跑到一半的任务已无主进程 job 续命,标记为中断
            if (t.status === 'running') {
              return {
                ...t,
                status: 'error' as const,
                error: t.error || '应用重启,该任务已中断',
              };
            }
            return t;
          });
        }
      }
    } catch {
      this.tasks = [];
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tasks.slice(0, MAX_TASKS)));
    } catch { /* 配额满 / 隐私模式,忽略 */ }
  }

  // ── 订阅 ────────────────────────────────────────────────
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit() {
    this.persist();
    for (const l of this.listeners) {
      try { l(); } catch { /* 单个订阅者抛错不影响其它 */ }
    }
  }

  // ── 读取 ────────────────────────────────────────────────
  getTasks(): VideoTask[] {
    // 新的在前
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  getTask(id: string): VideoTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  isAnyRunning(): boolean {
    return this.running;
  }

  // ── 写入 ────────────────────────────────────────────────
  private patch(id: string, fn: (t: VideoTask) => void) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    t.updatedAt = Date.now();
    this.emit();
  }

  private appendLog(t: VideoTask, message: string) {
    const last = t.logs[t.logs.length - 1];
    if (last && last.message === message) return; // 去重连续重复
    t.logs.push({ time: nowHms(), message });
    if (t.logs.length > MAX_LOGS) t.logs = t.logs.slice(-MAX_LOGS);
  }

  deleteTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    // 正在跑的任务不允许删(避免 onProgress 回调写已删任务)
    if (this.tasks[idx].status === 'running') return;
    this.tasks.splice(idx, 1);
    this.emit();
  }

  /**
   * 创建并启动一个视频任务。返回 taskId;若已有任务在跑则返回 null(上层提示)。
   * 进度/日志通过 videoCreationService.generate 的 onProgress 实时写回该任务。
   */
  createAndRun(input: VideoCreationInput, title: string): string | null {
    if (this.running) return null;

    const id = genId();
    const task: VideoTask = {
      id,
      title: title || '视频创作任务',
      input,
      status: 'running',
      steps: [],
      logs: [{ time: nowHms(), message: '任务已创建,开始生成…' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.unshift(task);
    if (this.tasks.length > MAX_TASKS) this.tasks = this.tasks.slice(0, MAX_TASKS);
    this.running = true;
    this.emit();

    const onProgress = (p: VideoCreationProgress) => {
      this.patch(id, (t) => {
        if (t.status !== 'running') return;
        if (Array.isArray(p.steps)) t.steps = p.steps;
        if (p.message) {
          t.message = p.message;
          this.appendLog(t, p.message);
        }
      });
    };

    // fire-and-forget;store 单例持有 promise,组件卸载不影响
    void videoCreationService
      .generate(input, onProgress)
      .then((res) => {
        this.patch(id, (t) => {
          if (res.ok && res.outputPath) {
            t.status = 'done';
            t.outputPath = res.outputPath;
            this.appendLog(t, '✅ 生成完成');
          } else {
            t.status = 'error';
            t.error = res.error || '生成失败';
            this.appendLog(t, `❌ ${t.error}`);
          }
        });
      })
      .catch((e) => {
        this.patch(id, (t) => {
          t.status = 'error';
          t.error = String(e).slice(0, 200);
          this.appendLog(t, `❌ ${t.error}`);
        });
      })
      .finally(() => {
        this.running = false;
        this.emit();
      });

    return id;
  }
}

export const videoTaskStore = new VideoTaskStore();
