/**
 * videoQueue — 「视频创作」大类(原创/二创/长转短/解说 4 张卡)的统一队列协调器。
 *
 * 背景:视频任务分散在两套互不感知的引擎——
 *   · 本地一键成片(原创/AI自动成片) → videoTaskStore(renderer,本地 ffmpeg pipeline)
 *   · 二创/长转短/解说          → scenario 系统(主进程 orchestrator,scenarioService)
 * 需求:这 4 类合成一个大类,【同时只跑 1 个】、列表【总数 ≤5(含已完成)】。
 *
 * 设计:本协调器是 4 张卡【唯一的开跑入口】,薄层、不搬数据(两边任务仍各存各的)。
 *   · 一个 async「泵」串行处理 pending 队列 → 自然保证同时只 1 个在跑:
 *       - local    → videoTaskStore.runTask(id),再等它 isAnyRunning 翻 false;
 *       - scenario → await scenarioService.runTaskNow(id)(主进程 runTaskNow 跑完才 resolve)。
 *   · 队列(含正在跑的那个,排在 pending[0])持久化到 localStorage,重启后续跑。
 *   · canCreate():统计 videoTaskStore + scenario('video') 总任务数,≥5 拒绝(含已完成)。
 *
 * 为何不直接进 scenarioManager 的调度:那套是【按平台资源并发】设计(推特+币安可并行),
 * 管不了「视频类同时只 1 个」;且本地 pipeline 根本不在它的体系里。统一锁只能放这一层。
 */

import { videoTaskStore } from './videoTaskStore';
import { scenarioService } from './scenario';

export type VideoJobKind = 'local' | 'scenario';

interface QueueJob {
  kind: VideoJobKind;
  refId: string;   // local: videoTaskStore taskId;scenario: scenario task id
  title: string;
  enqueuedAt: number;
}

const QKEY = 'noobclaw_video_queue';
/** 视频创作大类列表总上限(含已完成);超了拒绝新建,需先删旧的。 */
export const VIDEO_TASK_LIMIT = 5;

type Listener = () => void;

class VideoQueue {
  /** 待跑队列;正在跑的那个排在 pending[0](跑完才 shift),便于重启续跑。 */
  private pending: QueueJob[] = [];
  /** 正在跑的 refId(= pending[0].refId);空闲为 null。 */
  private currentRefId: string | null = null;
  private pumping = false;
  private listeners = new Set<Listener>();

  constructor() {
    this.load();
    // 让本地定时任务到点时也走队列(避免和协调器抢 → 破坏「同时只 1 个」)。
    // 用回调注入,避免 videoTaskStore 反向 import 形成循环依赖。
    try {
      videoTaskStore.onScheduleDue = (taskId: string) => {
        const t = videoTaskStore.getTask(taskId);
        this.enqueue('local', taskId, t?.title || '视频任务');
      };
    } catch { /* 老 store 没有该字段则忽略 */ }
    // 重启续跑:把上次残留的 pending 接着跑(running 中断的那条会被各 store 标 error,
    // 重跑相当于重试,可接受)。延后到下一拍,给各 store 完成 load。
    if (this.pending.length > 0) setTimeout(() => { void this.pump(); }, 1500);
  }

  // ── 持久化 ──────────────────────────────────────────────
  private load(): void {
    try {
      const raw = localStorage.getItem(QKEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.pending = arr.filter((j: any) => j && (j.kind === 'local' || j.kind === 'scenario') && typeof j.refId === 'string');
        }
      }
    } catch { this.pending = []; }
  }

  private persist(): void {
    try { localStorage.setItem(QKEY, JSON.stringify(this.pending)); } catch { /* 配额满忽略 */ }
  }

  // ── 订阅 ────────────────────────────────────────────────
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    this.persist();
    for (const l of this.listeners) { try { l(); } catch { /* ignore */ } }
  }

  // ── 额度(列表总数 ≤5,含已完成) ─────────────────────────
  /** 视频大类当前任务总数 = 本地任务 + scenario('video') 任务。 */
  async totalCount(): Promise<number> {
    const local = videoTaskStore.getTasks().length;
    let scenario = 0;
    try { scenario = (await scenarioService.listTasksFor('video')).length; } catch { /* ignore */ }
    return local + scenario;
  }

  /** 是否还能新建(总数 < 上限)。满了返回 false(上层提示先删旧的)。 */
  async canCreate(): Promise<boolean> {
    return (await this.totalCount()) < VIDEO_TASK_LIMIT;
  }

  // ── 队列查询(UI 用) ───────────────────────────────────
  /** 0 = 正在跑;1.. = 排队第 N 位;-1 = 不在队列(已完成/未入队)。 */
  getPosition(refId: string): number {
    const idx = this.pending.findIndex((j) => j.refId === refId);
    if (idx < 0) return -1;
    return idx; // pending[0] 正在跑 → 0;其后为排队位次
  }

  isRunning(refId: string): boolean {
    return this.currentRefId === refId;
  }

  isQueued(refId: string): boolean {
    const idx = this.pending.findIndex((j) => j.refId === refId);
    return idx > 0 || (idx === 0 && this.currentRefId !== refId);
  }

  // ── 入队 + 调度 ─────────────────────────────────────────
  /** 入队并触发调度。同一 refId 已在队列则忽略(防重复)。 */
  enqueue(kind: VideoJobKind, refId: string, title: string): void {
    if (this.pending.some((j) => j.refId === refId)) return;
    this.pending.push({ kind, refId, title: title || '视频任务', enqueuedAt: Date.now() });
    this.emit();
    void this.pump();
  }

  /** 取消一个【尚未开跑】的排队任务(正在跑的请用各自的 stop)。返回是否移除。 */
  cancel(refId: string): boolean {
    if (this.currentRefId === refId) return false; // 正在跑,不能从队列里直接取消
    const before = this.pending.length;
    this.pending = this.pending.filter((j) => j.refId === refId ? false : true);
    if (this.pending.length !== before) { this.emit(); return true; }
    return false;
  }

  /** 串行泵:一次只跑一个,跑完(含失败)再跑下一个 → 保证「同时只 1 个」。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending[0];
        this.currentRefId = job.refId;
        this.emit();
        try {
          if (job.kind === 'local') {
            const runId = videoTaskStore.runTask(job.refId);
            if (runId) await this.waitLocalDone(job.refId);
            // runId 为 null(任务已删 / store 忙):跳过,不阻塞队列。
          } else {
            // 主进程 runTaskNow 跑完才 resolve(返回 RunOutcome)。
            await scenarioService.runTaskNow(job.refId);
          }
        } catch { /* 单条失败不阻塞队列,继续下一条 */ }
        // 跑完出队(正在跑的始终是 pending[0])。
        this.pending.shift();
        this.currentRefId = null;
        this.emit();
      }
    } finally {
      this.pumping = false;
      this.currentRefId = null;
    }
  }

  /** 等本地任务跑完:订阅 videoTaskStore,任务终态 / 全局空闲即 resolve。 */
  private waitLocalDone(taskId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): boolean => {
        const t = videoTaskStore.getTask(taskId);
        // 任务已删、或不再 running、或全局空闲 → 视为结束。
        if (!t || t.lastStatus !== 'running' || !videoTaskStore.isAnyRunning()) return true;
        return false;
      };
      if (done()) { resolve(); return; }
      const unsub = videoTaskStore.subscribe(() => {
        if (done()) { unsub(); resolve(); }
      });
      // 兜底轮询(防订阅漏触发导致队列卡死)。
      const timer = setInterval(() => {
        if (done()) { clearInterval(timer); try { unsub(); } catch { /* ignore */ } resolve(); }
      }, 3000);
    });
  }
}

export const videoQueue = new VideoQueue();
