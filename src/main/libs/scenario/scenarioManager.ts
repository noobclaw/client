/**
 * Scenario Manager — top-level orchestrator for a scenario task run.
 *
 * Pipeline (3 visible steps):
 *   Step 1 · Discovery  — scroll XHS, find viral posts matching keywords
 *   Step 2 · Extraction — AI breaks down each post's structure
 *   Step 3 · Composition — AI rewrites in user's persona + save to disk
 *
 * Each step emits progress logs that the renderer polls via getRunProgress().
 */

import { coworkLog } from '../coworkLogger';
import * as riskGuard from './riskGuard';
import * as taskStore from './taskStore';
import * as viralPoolClient from './viralPoolClient';
import { runOrchestrator } from './phaseRunner';
import type {
  Draft,
  ScenarioManifest,
  ScenarioPack,
  ScenarioTask,
} from './types';

const packCache = new Map<string, ScenarioPack>();

async function loadPack(scenario_id: string): Promise<ScenarioPack | null> {
  // Always fetch fresh from backend — scripts, prompts, config
  // can be hot-updated on the server without client rebuild.
  viralPoolClient.clearScenarioPackCache();
  const raw = await viralPoolClient.fetchScenarioPack(scenario_id);
  if (!raw || !raw.manifest) return null;
  const pack: ScenarioPack = {
    manifest: raw.manifest as ScenarioManifest,
    scripts: raw.scripts || {},
    prompts: raw.prompts || {},
    config: raw.config || {},
    orchestrator: raw.orchestrator || '',
    upload_draft_script: raw.upload_draft_script || '',
    draft_uploader: raw.draft_uploader || null,
  };
  packCache.set(scenario_id, pack);
  return pack;
}

export function clearPackCache(): void {
  packCache.clear();
  viralPoolClient.clearScenarioPackCache();
}

export interface RunOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  drafts?: Draft[];
}

// ── Progress tracking ──

export interface ProgressLog {
  time: string;         // "10:44:56"
  status: 'done' | 'running' | 'error';
  message: string;
}

export interface StepProgress {
  name: string;
  status: 'waiting' | 'running' | 'done' | 'error';
  logs: ProgressLog[];
}

export interface RunProgress {
  taskId: string;
  status: 'idle' | 'running' | 'done' | 'error';
  currentStep: number;   // 0=not started, 1/2/3
  steps: StepProgress[];
  error?: string;
}

// Per-task progress + abort flag.
//
// PRE-Twitter v1 these were single globals — fine when only one task ran at
// a time. With cross-platform concurrency (an XHS task and a Twitter task
// targeting different browser tabs running in parallel), the second
// initProgress() would clobber the first's state, the renderer's poll
// would see the wrong task's progress in BOTH detail pages, and stop on
// task A would also abort task B. Switching to per-task Maps fixes all of
// that — every task has its own RunProgress + its own abort flag.
const progressByTaskId: Map<string, RunProgress> = new Map();
const abortByTaskId: Map<string, boolean> = new Map();
// Per-task run record id (the row in scenario_run_records.json that we're
// currently appending step logs to). Set by startTaskRecord() right after
// initProgress(), read by stepLog/finishProgress to mirror updates into
// the persistent record. Cleared on task end.
const recordIdByTaskId: Map<string, string> = new Map();

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function initProgress(taskId: string): void {
  progressByTaskId.set(taskId, {
    taskId,
    status: 'running',
    currentStep: 0,
    steps: [
      { name: '采集爆款文章。请勿切换浏览器标签页。', status: 'waiting', logs: [] },
      { name: 'AI 改写标题和内容，保存到本地', status: 'waiting', logs: [] },
      { name: 'AI 生成配图', status: 'waiting', logs: [] },
      { name: '上传到小红书草稿箱。请勿切换浏览器标签页。', status: 'waiting', logs: [] },
    ],
  });
  abortByTaskId.set(taskId, false);
}

function stepStart(taskId: string, step: number): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.currentStep = step;
  p.steps[step - 1].status = 'running';
}

function stepLog(taskId: string, step: number, status: 'done' | 'running' | 'error', message: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  const logs = p.steps[step - 1].logs;
  // Always append — UI shows a live timeline of what's happening.
  // Keep max 30 entries to avoid memory bloat on long runs.
  if (logs.length >= 30) logs.shift();
  const time = now();
  logs.push({ time, status, message });
  // Mirror into the persistent run record so historical viewing has the
  // full step log timeline (the in-memory progress is capped at 30 lines
  // and gets dropped 30s after task end; runRecords keeps everything).
  const recordId = recordIdByTaskId.get(taskId);
  if (recordId) {
    try {
      const runRecords = require('./runRecords');
      runRecords.appendStepLog(recordId, { time, step, status, message });
    } catch { /* non-fatal */ }
  }
}

function stepDone(taskId: string, step: number): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.steps[step - 1].status = 'done';
}

function stepError(taskId: string, step: number, error: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.steps[step - 1].status = 'error';
  stepLog(taskId, step, 'error', error);
}

function finishProgress(taskId: string, status: 'done' | 'error', error?: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  p.status = status;
  if (error) p.error = error;
  // Mirror into the persistent run record. user_stopped → 'stopped' so
  // the history page can distinguish "I cancelled it" from "it errored".
  const recordId = recordIdByTaskId.get(taskId);
  if (recordId) {
    try {
      const runRecords = require('./runRecords');
      const recStatus = status === 'done'
        ? 'done'
        : (error === 'user_stopped' ? 'stopped' : 'error');
      runRecords.finishRecord(recordId, { status: recStatus, error });
    } catch { /* non-fatal */ }
  }
}

/** Open a new run record entry for this task and remember its id so
 *  later stepLog/finish calls can mirror into the persistent log.
 *  Called from runTask AFTER initProgress + pack load. Idempotent —
 *  safe to call when no scenario yet (just won't record). */
function startTaskRecord(task: ScenarioTask, scenario: any): void {
  try {
    const runRecords = require('./runRecords');
    const { getTaskOutputDir } = require('./artifactWriter');
    let outputDir: string | undefined;
    try { outputDir = getTaskOutputDir(task); } catch { /* ignore */ }
    const recordId = runRecords.startRecord({
      task,
      scenario: scenario ? {
        id: scenario.id,
        platform: scenario.platform || '',
        name_zh: scenario.name_zh,
        name_en: scenario.name_en,
        icon: scenario.icon,
        workflow_type: scenario.workflow_type,
      } : null,
      output_dir: outputDir,
    });
    if (recordId) recordIdByTaskId.set(task.id, recordId);
  } catch (e) {
    coworkLog('WARN', 'scenarioManager', 'startTaskRecord failed', { err: String(e) });
  }
}

/** Update the run record's result counts at task end (collected/draft etc.) */
function updateTaskRecordResult(taskId: string, result: any): void {
  const recordId = recordIdByTaskId.get(taskId);
  if (!recordId) return;
  try {
    const runRecords = require('./runRecords');
    runRecords.finishRecord(recordId, {
      // Don't change status here — finishProgress already set it. We're
      // just adding the result counts.
      status: undefined as any,
      result: {
        collected_count: result.collected_count,
        draft_count: result.draft_count,
        posted: result.posted,
        ...result,
      },
    });
  } catch { /* non-fatal */ }
}

/**
 * Returns progress for a specific task. If `taskId` omitted (legacy callers),
 * returns the first running task's progress as a back-compat fallback —
 * but new callers should always pass taskId so the renderer's two open
 * detail pages each see their own task's state.
 */
export function getRunProgress(taskId?: string): RunProgress | null {
  if (taskId) return progressByTaskId.get(taskId) || null;
  // Back-compat: prefer a task that's still running
  for (const p of progressByTaskId.values()) {
    if (p.status === 'running') return p;
  }
  // Fall through to any (could be a recently-finished one we kept around)
  const first = progressByTaskId.values().next();
  return first.done ? null : first.value;
}

/** Per-task abort. Stop button on Task A no longer also kills Task B. */
export function requestAbort(taskId?: string): void {
  if (taskId) {
    abortByTaskId.set(taskId, true);
    coworkLog('INFO', 'scenarioManager', `requestAbort scoped to ONE task`, {
      taskId,
      otherRunningTasks: Array.from(abortByTaskId.keys()).filter(k => k !== taskId),
    });
    return;
  }
  // Back-compat path (caller didn't pass taskId — should be rare now,
  // every UI path passes task.id). We log loudly because aborting all
  // tasks is a much bigger deal than aborting one.
  coworkLog('WARN', 'scenarioManager', `requestAbort with NO taskId — aborting ALL ${abortByTaskId.size} running tasks`, {
    affectedTaskIds: Array.from(abortByTaskId.keys()),
  });
  for (const id of abortByTaskId.keys()) abortByTaskId.set(id, true);
}

/** Called by orchestrator inside loops to check if user hit stop. */
export function isAbortRequested(taskId?: string): boolean {
  if (taskId) return abortByTaskId.get(taskId) === true;
  // Back-compat: ANY task aborted? (Old callers without per-task scope)
  for (const v of abortByTaskId.values()) if (v) return true;
  return false;
}

// ── Concurrency control (Twitter v1: per-tab-resource gating) ─────────────
//
// Pre-Twitter we had a single `runningTaskId` global mutex — only one task
// at a time, period. With multi-tab routing landed in Sprint 1.2, an XHS
// task and a Twitter task can target different Chrome tabs, so they don't
// actually compete for the same browser surface and CAN run in parallel.
//
// Resource keys:
//   'tab:default'                        — scenarios with no tab_url_pattern
//                                          (legacy XHS scenarios). Stay
//                                          serial because they all target
//                                          whatever the active tab is.
//   'tab:<pack.manifest.tab_url_pattern>' — scenarios with a pattern. Two
//                                          tasks on the same pattern still
//                                          serialize (same browser tab); two
//                                          tasks on different patterns run
//                                          concurrently.
//
// MAX_CONCURRENT_TASKS bounds the total — even with N different patterns,
// we won't melt the user's machine. Default 2 keeps headroom.

const MAX_CONCURRENT_TASKS = 2;

/** resource key → taskId currently occupying it */
const runningByResource = new Map<string, string>();

function resourceKeyForPack(pack: { manifest?: { tab_url_pattern?: string } } | null | undefined): string {
  const pattern = pack?.manifest?.tab_url_pattern;
  return pattern ? `tab:${pattern}` : 'tab:default';
}

function isResourceBusy(key: string): boolean {
  return runningByResource.has(key);
}

function atConcurrencyLimit(): boolean {
  return runningByResource.size >= MAX_CONCURRENT_TASKS;
}

function markResourceBusy(key: string, taskId: string): void {
  runningByResource.set(key, taskId);
}

function releaseResource(key: string): void {
  runningByResource.delete(key);
}

/**
 * Legacy singleton accessor — returns the first running task (if any)
 * for backwards-compat with UI code that assumed at most 1 task ran at
 * a time. New callers should prefer getRunningTaskIds().
 */
export function getRunningTaskId(): string | null {
  const first = runningByResource.values().next();
  return first.done ? null : first.value;
}

/** All currently-running task ids. Lets the UI light up multiple "running"
 *  badges when XHS task + Twitter task are in flight at the same time. */
export function getRunningTaskIds(): string[] {
  return Array.from(runningByResource.values());
}

// ── Main entry ──

/**
 * @param manual — true when user clicks "直接运行". Manual runs bypass
 *   daily cap and interval checks (only mutex is enforced). Scheduled
 *   auto-runs pass false/undefined and are subject to all risk guards.
 */
/**
 * Upload ONE specific already-generated draft to XHS draft box.
 * Used by TaskDetailPage "📤 上传" per-draft button when the task was
 * created with auto_upload=false (safer mode).
 * Reads the cover/content images back from disk (they were saved by
 * artifactWriter during the original run), reconstructs the draft
 * payload, and runs the pack's upload_draft.js orchestrator.
 */
export async function uploadOneDraft(taskId: string, draftId: string): Promise<RunOutcome> {
  const task = taskStore.getTask(taskId);
  if (!task) return { status: 'failed', reason: 'task_not_found' };
  const draft = taskStore.getDraft(draftId);
  if (!draft) return { status: 'failed', reason: 'draft_not_found' };

  // Load pack first so we know the resource key before claiming the mutex.
  const pack = await loadPack(task.scenario_id);
  if (!pack) {
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }

  // Per-resource concurrency: same-platform tasks still serialize, but a
  // Twitter upload won't block an XHS scheduled run (and vice versa).
  const resource = resourceKeyForPack(pack);
  if (isResourceBusy(resource)) {
    return { status: 'skipped', reason: 'resource_busy:' + resource };
  }
  if (atConcurrencyLimit()) {
    return { status: 'skipped', reason: 'concurrency_limit_reached' };
  }
  markResourceBusy(resource, task.id);
  initProgress(task.id);
  // Manual single-draft upload also creates a run record so the user can
  // review what was uploaded later from the history page.
  startTaskRecord(task, pack.manifest);

  try {
    const script = pack.upload_draft_script;
    if (!script) {
      finishProgress(task.id, 'error', 'no_upload_script');
      return { status: 'failed', reason: 'no_upload_script' };
    }

    // Reload images from disk (saved by artifactWriter during original run).
    // Path: <taskOutputDir>/改写/配图-<rewriteTitle>/{cover,content}_N.{jpg,png}
    const fs = await import('fs');
    const path = await import('path');
    const { getTaskOutputDir } = await import('./artifactWriter');
    const batchDir = getTaskOutputDir(task);
    // Search the most recent batch that has this draft's images
    const rewritesDir = path.join(batchDir, '改写');
    const imagesReloaded: { type: string; base64: string; mimeType: string }[] = [];
    try {
      const rewriteTitle = (draft.variant?.title || '').slice(0, 80);
      // sanitize to match artifactWriter's folder name rule
      const sanitize = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
      const imgDirName = '配图-' + sanitize(rewriteTitle);
      const imgDir = path.join(rewritesDir, imgDirName);
      if (fs.existsSync(imgDir)) {
        const files = fs.readdirSync(imgDir).sort();
        for (const f of files) {
          const filePath = path.join(imgDir, f);
          const ext = path.extname(f).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
          const type = f.startsWith('cover') ? 'cover' : 'content';
          try {
            const buf = fs.readFileSync(filePath);
            imagesReloaded.push({ type, base64: buf.toString('base64'), mimeType: mime });
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      coworkLog('WARN', 'scenarioManager', 'uploadOneDraft: image reload failed', { err: String(e) });
    }

    if (imagesReloaded.length === 0) {
      finishProgress(task.id, 'error', 'no_local_images');
      return { status: 'failed', reason: 'no_local_images' };
    }

    const targetDraft = {
      id: draft.id,
      variant: draft.variant,
      images: imagesReloaded,
    };

    const seen = taskStore.getSeenPostIds(task.id);
    // Per-task callbacks: each closure captures THIS task's id so concurrent
    // runs don't bleed into each other's progress map.
    const tid = task.id;
    const result = await runOrchestrator(pack, task, seen, {
      stepStart: (step) => stepStart(tid, step),
      stepLog: (step, status, message) => stepLog(tid, step, status, message),
      stepDone: (step) => stepDone(tid, step),
      stepError: (step, error) => stepError(tid, step, error),
      finishProgress: (status, error) => finishProgress(tid, status, error),
      isAbortRequested: () => isAbortRequested(tid),
    }, { scriptOverride: script, targetDraft });

    // Update draft status on successful upload
    const cur = progressByTaskId.get(tid);
    if (result.status === 'ok') {
      taskStore.updateDraft(draft.id, { status: 'pushed', pushed_at: Date.now() });
      if (cur?.status === 'running') finishProgress(tid, 'done');
    } else {
      if (cur?.status === 'running') finishProgress(tid, 'error', result.reason || 'upload_failed');
    }

    updateTaskRecordResult(task.id, result);
    return result;
  } finally {
    releaseResource(resource);
    abortByTaskId.delete(task.id);
    recordIdByTaskId.delete(task.id);
    setTimeout(() => {
      progressByTaskId.delete(task.id);
    }, 30000);
  }
}

export async function runTask(task: ScenarioTask, manual?: boolean): Promise<RunOutcome> {
  // Per-resource concurrency: load pack first to derive its tab pattern,
  // then check the resource. Tasks targeting the same tab serialize; tasks
  // targeting different tabs (XHS vs Twitter) can run in parallel.
  const pack = await loadPack(task.scenario_id);
  if (!pack) {
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }
  const resource = resourceKeyForPack(pack);
  if (isResourceBusy(resource)) {
    return { status: 'skipped', reason: 'resource_busy:' + resource };
  }
  if (atConcurrencyLimit()) {
    return { status: 'skipped', reason: 'concurrency_limit_reached' };
  }
  markResourceBusy(resource, task.id);
  initProgress(task.id);
  startTaskRecord(task, pack.manifest);

  try {
    const outcome = await _runTaskInner(task, manual, pack);
    // Patch the run record with result counts now that we have them
    // (status was already set by finishProgress mirror).
    updateTaskRecordResult(task.id, outcome);
    return outcome;
  } finally {
    releaseResource(resource);
    abortByTaskId.delete(task.id);
    recordIdByTaskId.delete(task.id);
    // Keep progress around for 30s so UI can show final state
    setTimeout(() => {
      progressByTaskId.delete(task.id);
    }, 30000);
  }
}

async function _runTaskInner(task: ScenarioTask, manual?: boolean, prefetchedPack?: ScenarioPack): Promise<RunOutcome> {
  // Avoid double-loading: caller (runTask) already loads the pack to derive
  // the resource key for concurrency gating. If supplied, reuse it.
  const pack = prefetchedPack || await loadPack(task.scenario_id);
  if (!pack) {
    finishProgress(task.id, 'error', 'scenario_pack_not_found');
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }

  // Manual runs ("直接运行") bypass daily cap / interval / weekly rest.
  // Only scheduled auto-runs are subject to all risk guards.
  if (!manual) {
    const gate = riskGuard.canRunNow(task, pack.manifest.risk_caps);
    if (!gate.allowed) {
      riskGuard.markRunSkipped(task.id, gate.reason || 'gate');
      finishProgress(task.id, 'error', gate.reason);
      return { status: 'skipped', reason: gate.reason };
    }
  }

  riskGuard.markRunStart(task.id);

  // Release batch dir cache so this run gets a fresh numbered folder
  // (1, 2, 3, ...). Without this, multiple manual runs on the same day
  // all pile into the first batch dir and overwrite each other.
  try {
    const { startNewBatch } = await import('./artifactWriter');
    startNewBatch(task.id);
  } catch (e) {
    coworkLog('WARN', 'scenarioManager', 'startNewBatch failed', { err: String(e) });
  }

  try {
    // All orchestration logic now lives on the server (orchestrator.js).
    // We just provide the ctx tools and let it run.
    const seen = taskStore.getSeenPostIds(task.id);
    // Per-task callbacks: each closure captures THIS task's id so concurrent
    // runs don't bleed into each other's progress map.
    const tid = task.id;

    const result = await runOrchestrator(pack, task, seen, {
      stepStart: (step) => stepStart(tid, step),
      stepLog: (step, status, message) => stepLog(tid, step, status, message),
      stepDone: (step) => stepDone(tid, step),
      stepError: (step, error) => stepError(tid, step, error),
      finishProgress: (status, error) => finishProgress(tid, status, error),
      isAbortRequested: () => isAbortRequested(tid),
    });

    const cur = progressByTaskId.get(tid);
    if (result.status === 'ok') {
      riskGuard.markRunSuccess(task.id, result.collected_count || 0, result.draft_count || 0);
      // 保证 UI 最终收到 done 状态（orchestrator 里大多数路径已经调过，
      // 但 orchestrator 抛异常经 phaseRunner catch 返回时没调，这里兜底）
      if (cur?.status === 'running') finishProgress(tid, 'done');
    } else {
      riskGuard.markRunFailure(task.id, result.reason || 'unknown');
      // 关键修复：orchestrator 抛 user_stopped → phaseRunner catch → 这里。
      // 之前没调 finishProgress，UI 永远看不到 error 状态，一直显示"停止中"。
      if (cur?.status === 'running') finishProgress(tid, 'error', result.reason || 'unknown');
    }

    return result;
  } catch (err) {
    let msg = String(err instanceof Error ? err.message : err);
    if (msg.includes('user_stopped')) msg = 'user_stopped';
    riskGuard.markRunFailure(task.id, msg);
    finishProgress(task.id, 'error', msg);
    return { status: 'failed', reason: msg };
  }
}

// ── Scheduler: check every 60s if any task should auto-run ──

const INTERVAL_MS: Record<string, number> = {
  '30min': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  // daily_random = 24h elapsed but no fixed-hour pin; XHS auto-reply uses
  // this so the comment burst hits a different wall-clock time each day.
  'daily_random': 24 * 60 * 60 * 1000,
};

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setInterval(async () => {
    // Twitter v1: instead of bailing when ANY task is running, scan all
    // eligible tasks each tick and start every one whose target tab
    // resource is free. The atConcurrencyLimit() / isResourceBusy() guards
    // are inside runTask itself, so the worst case here is "we tried to
    // start, runTask returned skipped" — cheap.
    if (atConcurrencyLimit()) return;

    try {
      const allTasks = taskStore.listTasks();
      if (!Array.isArray(allTasks)) return;

      for (const task of allTasks) {
        if (!task.active || !task.enabled) continue;
        if (atConcurrencyLimit()) break;

        const interval = (task as any).run_interval || 'daily';
        if (interval === 'once') continue; // 不重复：仅手动触发
        const ms = INTERVAL_MS[interval] || INTERVAL_MS.daily;

        // Check last run time
        const runs = riskGuard.getRuns(task.id);
        const lastRun = runs.length > 0 ? Math.max(...runs.map((r: any) => r.started_at || 0)) : 0;
        const elapsed = Date.now() - lastRun;

        // For daily: also check if current time is near daily_time
        if (interval === 'daily') {
          const [hh, mm] = (task.daily_time || '08:00').split(':').map(Number);
          const now = new Date();
          const targetMin = hh * 60 + mm;
          const currentMin = now.getHours() * 60 + now.getMinutes();
          // Run if within ±15 min window and hasn't run today
          if (Math.abs(currentMin - targetMin) > 15) continue;
          if (elapsed < 20 * 60 * 60 * 1000) continue; // Already ran in last 20h
        } else if (interval === 'daily_random') {
          // Wait at least 24h since last run, then trigger with a small per-tick
          // probability so the actual hour of day drifts each day. With p=1/180
          // and tick=60s, after the 24h mark we expect to fire within ~3h on
          // average — enough randomness to avoid a fixed-hour pattern. (Anti
          // risk-control: XHS flags accounts that comment at the same wall-clock
          // hour every day.)
          if (elapsed < ms) continue;
          if (Math.random() > 1 / 180) continue;
        } else {
          // For interval-based (30min / 1h / 3h / 6h):
          // Wait at least `ms` since last run, then add an additional 0-10
          // minute random jitter so consecutive runs don't fire on a perfect
          // clock. Implementation: once the threshold is crossed, fire on
          // each 60s tick with probability 1/10 → average ~5 min extra delay,
          // bounded ~10 min. (Anti risk-control: a task firing exactly every
          // 60.0 minutes is a giveaway bot pattern.)
          //
          // Daily picker (above) already has its own ±15 min jitter so it
          // doesn't need this branch.
          if (elapsed < ms) continue;
          if (Math.random() > 1 / 10) continue;
        }

        coworkLog('INFO', 'scheduler', `Auto-running task ${task.id} (interval: ${interval})`);
        runTask(task, false).catch(err => {
          coworkLog('ERROR', 'scheduler', `Auto-run failed: ${err}`);
        });
        // Do NOT break — keep scanning. If two tasks on different tabs are
        // both due, we want to start them both this tick (subject to the
        // atConcurrencyLimit guard at the top of the loop body).
      }
    } catch (err) {
      coworkLog('ERROR', 'scheduler', `Scheduler check failed: ${err}`);
    }
  }, 60 * 1000); // Check every 60 seconds
}
