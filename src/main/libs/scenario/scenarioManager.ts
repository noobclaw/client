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

// v2.4.35+: accumulated AI usage per task. phaseRunner's aiCall reports
// per-call tokens + server-precomputed USD cost after each successful
// call; we sum both and write into the run record at task end so the
// history page can show "Tokens 12,345 · ≈ $0.025".
//
// Both values come from the real backend: tokens = usage.total_tokens,
// cost = _noobclaw.costUsd (backend multiplies billable_tokens by
// system_config.token_price_per_million — authoritative, no client-side
// hardcoded rate).
const tokensByTaskId: Map<string, number> = new Map();
const costUsdByTaskId: Map<string, number> = new Map();

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

/**
 * Finalize the in-memory progress + mirror to persistent run record.
 *
 * `status` from the orchestrator can be:
 *   'done'    — everything the task tried to do succeeded
 *   'partial' — task ran to completion but some sub-items failed (e.g.
 *               2/5 tweets posted, 3/5 hit AI_PARSE_FAIL). Pre-v2.4.26
 *               this case was bucketed as 'done' and the user couldn't
 *               tell a half-broken run from a fully-successful one in
 *               the history list.
 *   'error'   — task aborted before producing anything useful, or a
 *               hard infra error (no_urls / anomaly / scenario_not_found
 *               / user_stopped — the latter remaps to 'stopped').
 *
 * The in-memory RunProgress only has 'done'/'error' (UI uses a green
 * check vs red X badge for the live progress panel). 'partial' is
 * recorded as 'done' there but as 'partial' in the persistent record,
 * which is what the History page reads.
 */
function finishProgress(taskId: string, status: 'done' | 'error' | 'partial', error?: string): void {
  const p = progressByTaskId.get(taskId);
  if (!p) return;
  // Map 'partial' → 'done' for the live progress panel (it only knows
  // happy/sad). The history record below preserves the distinction.
  p.status = status === 'error' ? 'error' : 'done';
  if (error) p.error = error;
  // Mirror into the persistent run record. user_stopped → 'stopped' so
  // the history page can distinguish "I cancelled it" from "it errored".
  const recordId = recordIdByTaskId.get(taskId);
  if (recordId) {
    try {
      const runRecords = require('./runRecords');
      let recStatus: 'done' | 'partial' | 'error' | 'stopped';
      if (status === 'done') recStatus = 'done';
      else if (status === 'partial') recStatus = 'partial';
      else if (error === 'user_stopped') recStatus = 'stopped';
      else recStatus = 'error';
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
    const { getUserDataPath } = require('../platformAdapter');
    // ⭐ v4.22.x defensive init. Bug from user 2026-04-22: a freshly-
    // created task's runs hit riskGuard (累计采集 visible) but never
    // appeared in runRecords history. Root cause hypothesis: the
    // sidecar bootstrap path that calls scenarioRunRecords.initRunRecords
    // hadn't run yet (e.g. another runTask started concurrently before
    // bootstrap finished, or the user's app session was a hot-reload
    // that skipped bootstrap). startRecord then no-ops because _loaded
    // is false → silent data loss.
    //
    // Defense: ALWAYS call initRunRecords() here. It's idempotent
    // (gated by _initOnce internally) — second call is a no-op except
    // for setting _loaded=true if it slipped through.
    try {
      runRecords.initRunRecords(getUserDataPath());
    } catch (initErr) {
      coworkLog('WARN', 'scenarioManager', 'startTaskRecord: init failed', { err: String(initErr) });
    }
    let outputDir: string | undefined;
    // Pass platform so Twitter tasks land in 推特/, not 小红书/.
    const platform = scenario?.platform || 'xhs';
    try { outputDir = getTaskOutputDir(task, platform); } catch { /* ignore */ }
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
    if (recordId) {
      recordIdByTaskId.set(task.id, recordId);
      coworkLog('INFO', 'scenarioManager', 'runRecord created', {
        taskId: task.id, recordId, platform, scenarioId: scenario?.id,
      });
    } else {
      // recordId === '' means runRecords._loaded was false → data loss.
      // Loud warning so this stops being silent.
      coworkLog('ERROR', 'scenarioManager', 'startTaskRecord: startRecord returned EMPTY id — runRecords not loaded? Task run will NOT appear in history.', {
        taskId: task.id, platform, scenarioId: scenario?.id,
      });
    }
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
    // v2.4.35+: attach accumulated token usage + USD cost. Both summed
    // from per-call values the backend reports (cost uses real
    // system_config price — no hardcoded rate on the client).
    const tokens = tokensByTaskId.get(taskId) || 0;
    const costUsd = costUsdByTaskId.get(taskId) || 0;
    runRecords.finishRecord(recordId, {
      // Don't change status here — finishProgress already set it. We're
      // just adding the result counts.
      status: undefined as any,
      result: {
        collected_count: result.collected_count,
        draft_count: result.draft_count,
        posted: result.posted,
        tokens_used: tokens,
        cost_usd: costUsd,
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
// we won't melt the user's machine. v4.23.x bumps this from 2 → 3 so
// users can run XHS + X + Binance Square in parallel (one task per
// platform), since each platform has a distinct tab_url_pattern and
// therefore its own resource lane. If we add a 4th text-content
// platform in the future, bump again.

const MAX_CONCURRENT_TASKS = 3;

/** resource key → taskId currently occupying it */
const runningByResource = new Map<string, string>();

// v4.25+ cross-tab scenarios (binance_from_x_repost) touch multiple tabs
// in one run, so they claim ALL the tab resources they'll use. If any of
// them is already busy, the run is rejected up front — avoids the nasty
// case where e.g. a Twitter post_creator task starts mid-run through a
// binance_from_x_repost run and they stomp on each other's tab focus.
//
// Single-tab scenarios (the common case) get a single-entry array and
// behave identically to the pre-4.25 single-string key flow.
function resourceKeysForPack(
  pack: {
    manifest?: {
      tab_url_pattern?: string;
      additional_tab_patterns?: string[];
      secondary_tab_url_pattern?: string;
    };
  } | null | undefined
): string[] {
  const keys: string[] = [];
  const primary = pack?.manifest?.tab_url_pattern;
  keys.push(primary ? `tab:${primary}` : 'tab:default');
  // v4.25+ cross-tab scenarios can declare extra tabs they'll touch via
  // either `additional_tab_patterns` (array, the canonical field) or
  // `secondary_tab_url_pattern` (single string, used by binance_from_x_repost).
  // We read both — manifests historically have one or the other.
  const additional = pack?.manifest?.additional_tab_patterns;
  if (Array.isArray(additional)) {
    for (const p of additional) {
      if (typeof p === 'string' && p) keys.push(`tab:${p}`);
    }
  }
  const secondary = pack?.manifest?.secondary_tab_url_pattern;
  if (typeof secondary === 'string' && secondary) {
    const sk = `tab:${secondary}`;
    if (keys.indexOf(sk) < 0) keys.push(sk);
  }
  return keys;
}

/** Returns the first busy key (for error message) or null if all free. */
function findBusyResource(keys: string[]): string | null {
  for (const k of keys) if (runningByResource.has(k)) return k;
  return null;
}

function atConcurrencyLimit(): boolean {
  return runningByResource.size >= MAX_CONCURRENT_TASKS;
}

function markResourcesBusy(keys: string[], taskId: string): void {
  for (const k of keys) runningByResource.set(k, taskId);
}

function releaseResources(keys: string[]): void {
  for (const k of keys) runningByResource.delete(k);
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
  const resources = resourceKeysForPack(pack);
  const busyKey = findBusyResource(resources);
  if (busyKey) {
    return { status: 'skipped', reason: 'resource_busy:' + busyKey };
  }
  if (atConcurrencyLimit()) {
    return { status: 'skipped', reason: 'concurrency_limit_reached' };
  }
  markResourcesBusy(resources, task.id);
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
      addTokensUsed: (tokensDelta, costDeltaUsd) => {
        tokensByTaskId.set(tid, (tokensByTaskId.get(tid) || 0) + tokensDelta);
        costUsdByTaskId.set(tid, (costUsdByTaskId.get(tid) || 0) + (costDeltaUsd || 0));
      },
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
    releaseResources(resources);
    abortByTaskId.delete(task.id);
    recordIdByTaskId.delete(task.id);
    tokensByTaskId.delete(task.id);
    costUsdByTaskId.delete(task.id);
    // v4.25.4: 同 runTask 的修复 — 防误杀 30s 内重新启动的同 task progress
    setTimeout(() => {
      const cur = progressByTaskId.get(task.id);
      if (cur && cur.status !== 'running') {
        progressByTaskId.delete(task.id);
      }
    }, 30000);
  }
}

export async function runTask(task: ScenarioTask, manual?: boolean): Promise<RunOutcome> {
  // v4.25.4: 立即清除上一次 run 的所有 per-task 状态残留 — 防止"用户停掉旧任务,
  // 立刻直接运行,UI 还显示旧进度 / token 累加上一次"。
  // loadPack() 可能 200-500ms,这个窗口里 renderer 的轮询会 fetch 到老
  // progress 然后渲染上去。先清掉,渲染层显示空步骤(loading 态)。
  // 同时 tokens/cost 累加器也要重置 —— 之前 runTask finally 漏了删,
  // 同任务跑两次成本就翻倍记录。
  progressByTaskId.delete(task.id);
  abortByTaskId.delete(task.id);
  tokensByTaskId.delete(task.id);
  costUsdByTaskId.delete(task.id);

  // Per-resource concurrency: load pack first to derive its tab pattern(s),
  // then check the resource. Tasks targeting the same tab serialize; tasks
  // targeting different tabs (XHS vs Twitter) can run in parallel.
  // v4.25+: cross-tab scenarios declare additional_tab_patterns and must
  // acquire ALL declared tab resources (else rejected up front).
  const pack = await loadPack(task.scenario_id);
  if (!pack) {
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }
  const resources = resourceKeysForPack(pack);
  // v4.25.34 diag: 打印申请/已占资源,方便调试"为啥 dual-tab 锁没拦住"。
  // runningByResource 是内存 Map,任务正常结束/中断/app 重启都会清。
  coworkLog('INFO', 'scenarioManager',
    `[runTask] task=${task.id} scenario=${task.scenario_id} `
    + `requesting=${JSON.stringify(resources)} `
    + `currentlyBusy=${JSON.stringify(Array.from(runningByResource.entries()))}`);
  const busyKey = findBusyResource(resources);
  if (busyKey) {
    return { status: 'skipped', reason: 'resource_busy:' + busyKey };
  }
  if (atConcurrencyLimit()) {
    return { status: 'skipped', reason: 'concurrency_limit_reached' };
  }
  markResourcesBusy(resources, task.id);
  initProgress(task.id);
  startTaskRecord(task, pack.manifest);

  try {
    const outcome = await _runTaskInner(task, manual, pack);
    // Patch the run record with result counts now that we have them
    // (status was already set by finishProgress mirror).
    updateTaskRecordResult(task.id, outcome);
    // Pre-pick the NEXT scheduled run wall-clock time so the UI can
    // show it (e.g. "明天 11:23" instead of "约 24-27 小时后") AND so
    // the scheduler honors a deterministic fire time across app
    // restarts. Always set, regardless of run outcome — even a failed
    // run still wants a follow-up scheduled.
    setNextPlannedRun(task, Date.now());
    return outcome;
  } finally {
    releaseResources(resources);
    abortByTaskId.delete(task.id);
    recordIdByTaskId.delete(task.id);
    // v4.25.4: 之前 runTask 漏了清 tokens/cost,同任务跑两次成本翻倍记录。
    tokensByTaskId.delete(task.id);
    costUsdByTaskId.delete(task.id);
    // Keep progress around for 30s so UI can show final state.
    // v4.25.4: 之前 setTimeout 无脑 delete,如果 30s 内用户又跑了一次同一个 task,
    // initProgress 已经把 entry 换成新 run 的状态(status='running'),这个 setTimeout
    // 还是会把它删了 → 新 run 的 progress 凭空消失。检查 status 防误杀。
    setTimeout(() => {
      const cur = progressByTaskId.get(task.id);
      if (cur && cur.status !== 'running') {
        progressByTaskId.delete(task.id);
      }
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
      addTokensUsed: (tokensDelta, costDeltaUsd) => {
        tokensByTaskId.set(tid, (tokensByTaskId.get(tid) || 0) + tokensDelta);
        costUsdByTaskId.set(tid, (costUsdByTaskId.get(tid) || 0) + (costDeltaUsd || 0));
      },
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
// (INTERVAL_MS lookup table removed in v2.4.25 — replaced by
//  computeNextPlannedRun which encodes the per-interval base + jitter
//  and stores the resulting wall-clock fire time on the task itself.)

/**
 * Pre-pick the next-run wall-clock timestamp for a task, applying the
 * appropriate per-interval random jitter UPFRONT (instead of rolling
 * dice every scheduler tick after the threshold). Two reasons we want
 * pre-picking:
 *
 *   1. The user can SEE exactly when the next run will fire — the
 *      task detail page shows "下次运行: 明天 11:23" instead of "约
 *      24-27h 后".
 *   2. The fire time is stable across app restarts. With per-tick dice,
 *      restarting the app reset the random state and the actual fire
 *      time drifted unpredictably.
 *
 * v2.4.32 — `isFirstRun` flag distinguishes:
 *   - true:  task just created OR interval just edited → first fire
 *            should happen INSIDE the FIRST time bucket (else "我刚
 *            建好的 30min 任务为啥要等 30 分钟才跑第一次？")
 *   - false: regular post-run reschedule → fromTs + base + jitter
 *
 * Jitter rules per interval:
 *   30min/1h/3h/6h:
 *     isFirstRun=true   → fromTs + rand(0..base)             (first bucket)
 *     isFirstRun=false  → fromTs + base + rand(0..10 min)    (steady-state)
 *   daily (HH:MM fixed):
 *     today HH:MM if not yet passed, else tomorrow ± 15 min  (no special case)
 *   daily_random:
 *     isFirstRun=true   → random in (now, today 23:59:59)    (today's slot)
 *     isFirstRun=false  → random in (next-day 00:00, next-day 23:59:59)
 *                         (full natural-day window, 凌晨 2 点也可能跑 — 用户确认 OK)
 *   once:
 *     never (Number.MAX_SAFE_INTEGER)
 */
export function computeNextPlannedRun(
  interval: string,
  daily_time: string,
  fromTs: number,
  isFirstRun: boolean = false,
): number {
  const day = 24 * 60 * 60 * 1000;
  if (interval === 'once') return Number.MAX_SAFE_INTEGER;

  if (interval === 'daily_random') {
    if (isFirstRun) {
      // First fire: random in (fromTs, today 23:59:59).
      const todayEnd = new Date(fromTs);
      todayEnd.setHours(23, 59, 59, 999);
      const remainingMs = todayEnd.getTime() - fromTs;
      if (remainingMs <= 0) {
        // Edge: created right at midnight — fall through to "next day"
        // computation so we don't pick a time in the past.
      } else {
        return fromTs + Math.floor(Math.random() * remainingMs);
      }
    }
    // Subsequent fire (or first-fire when created at 23:59:59+): pick
    // a random time anywhere in the NEXT calendar day's full 00:00~23:59.
    const tomorrow = new Date(fromTs);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime() + Math.floor(Math.random() * day);
  }

  if (interval === 'daily') {
    const [hh, mm] = (daily_time || '08:00').split(':').map(Number);
    const next = new Date(fromTs);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= fromTs) next.setTime(next.getTime() + day);
    // ±15 min jitter
    const jitter = Math.floor((Math.random() - 0.5) * 30 * 60 * 1000);
    return next.getTime() + jitter;
  }

  const intervals: Record<string, number> = {
    '30min': 30 * 60 * 1000,
    '1h':    60 * 60 * 1000,
    '3h': 3 * 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
  };
  const base = intervals[interval] || day;
  if (isFirstRun) {
    // First fire: random anywhere within the first bucket — could be
    // seconds from now, could be near the end of the bucket.
    return fromTs + Math.floor(Math.random() * base);
  }
  return fromTs + base + Math.floor(Math.random() * 10 * 60 * 1000);
}

/** Persist the next planned run for a task, computed off the given
 *  reference timestamp. Called in runTask's finally and from the
 *  scheduler when a task hasn't been planned yet. Failure to persist
 *  is non-fatal (scheduler will recompute next tick). */
function setNextPlannedRun(task: ScenarioTask, fromTs: number, isFirstRun: boolean = false): void {
  try {
    const interval = (task as any).run_interval || 'daily';
    const planned = computeNextPlannedRun(interval, task.daily_time, fromTs, isFirstRun);
    taskStore.updateTask(task.id, { next_planned_run_at: planned } as any);
  } catch (e) {
    coworkLog('WARN', 'scenarioManager', 'setNextPlannedRun failed', { err: String(e) });
  }
}

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

        // v2.4.25+ scheduler: every active task has a pre-picked
        // next_planned_run_at on disk. The pre-picking applies the
        // jitter UPFRONT (see computeNextPlannedRun) so:
        //   1. UI can show the exact wall-clock fire time
        //   2. Restarting the app doesn't reroll the random offset
        //   3. Scheduler is just "if now >= planned, fire" — no per-tick
        //      probability rolls in this loop
        let planned = (task as any).next_planned_run_at as number | undefined;
        if (!planned) {
          // First scheduler tick after the task was created (or after
          // upgrading from an older app version that didn't track this).
          // Backfill based on the last run if any, else from now.
          const runs = riskGuard.getRuns(task.id);
          const hasRealRuns = runs.length > 0;
          const fromTs = hasRealRuns
            ? Math.max(...runs.map((r: any) => r.started_at || 0))
            : Date.now();
          // hasRealRuns=false means this is the first-ever schedule for
          // this task → use the "first bucket" / "today's slot" picks
          // so the task fires soon, not 一个完整周期后.
          setNextPlannedRun(task, fromTs, !hasRealRuns);
          // Re-fetch to get the freshly-stored value
          const refreshed = taskStore.getTask(task.id);
          planned = (refreshed as any)?.next_planned_run_at;
          if (!planned) continue;
        }
        if (Date.now() < planned) continue;

        coworkLog('INFO', 'scheduler', `Auto-running task ${task.id} (interval: ${interval}, planned: ${new Date(planned).toISOString()})`);
        // v4.25.4: 之前 runTask 返回 skipped(资源忙/并发上限)直接吞掉,用户
        // 看到"到点了不运行"完全没线索。现在所有结局都打 log,失败/跳过附原因。
        runTask(task, false)
          .then(out => {
            if (!out) return;
            if (out.status === 'skipped') {
              coworkLog('WARN', 'scheduler',
                `Auto-run SKIPPED for task ${task.id}: ${out.reason || 'unknown'} `
                + `— scheduler 会在下一 tick(60s)再试`);
            } else if (out.status === 'failed') {
              coworkLog('WARN', 'scheduler',
                `Auto-run FAILED for task ${task.id}: ${out.reason || 'unknown'}`);
            } else {
              coworkLog('INFO', 'scheduler',
                `Auto-run finished for task ${task.id}: ${out.status}`);
            }
          })
          .catch(err => {
            coworkLog('ERROR', 'scheduler', `Auto-run threw for task ${task.id}: ${err}`);
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
