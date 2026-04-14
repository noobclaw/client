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

let currentProgress: RunProgress | null = null;
let abortRequested = false;

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function initProgress(taskId: string): void {
  currentProgress = {
    taskId,
    status: 'running',
    currentStep: 0,
    steps: [
      { name: '采集爆款文章。请勿切换浏览器标签页。', status: 'waiting', logs: [] },
      { name: 'AI 改写标题和内容，保存到本地', status: 'waiting', logs: [] },
      { name: '上传到小红书草稿箱', status: 'waiting', logs: [] },
    ],
  };
  abortRequested = false;
}

function stepStart(step: number): void {
  if (!currentProgress) return;
  currentProgress.currentStep = step;
  currentProgress.steps[step - 1].status = 'running';
}

function stepLog(step: number, status: 'done' | 'running' | 'error', message: string): void {
  if (!currentProgress) return;
  const logs = currentProgress.steps[step - 1].logs;
  // Always append — UI shows a live timeline of what's happening.
  // Keep max 30 entries to avoid memory bloat on long runs.
  if (logs.length >= 30) logs.shift();
  logs.push({ time: now(), status, message });
}

function stepDone(step: number): void {
  if (!currentProgress) return;
  currentProgress.steps[step - 1].status = 'done';
}

function stepError(step: number, error: string): void {
  if (!currentProgress) return;
  currentProgress.steps[step - 1].status = 'error';
  stepLog(step, 'error', error);
}

function finishProgress(status: 'done' | 'error', error?: string): void {
  if (!currentProgress) return;
  currentProgress.status = status;
  if (error) currentProgress.error = error;
}

export function getRunProgress(): RunProgress | null {
  return currentProgress;
}

export function requestAbort(): void {
  abortRequested = true;
}

/** Called by xhsDriver inside its scroll loop to check if user hit stop. */
export function isAbortRequested(): boolean {
  return abortRequested;
}

// ── Global mutex ──

let runningTaskId: string | null = null;

export function getRunningTaskId(): string | null {
  return runningTaskId;
}

// ── Main entry ──

/**
 * @param manual — true when user clicks "直接运行". Manual runs bypass
 *   daily cap and interval checks (only mutex is enforced). Scheduled
 *   auto-runs pass false/undefined and are subject to all risk guards.
 */
export async function runTask(task: ScenarioTask, manual?: boolean): Promise<RunOutcome> {
  if (runningTaskId) {
    return { status: 'skipped', reason: 'another_task_running' };
  }
  runningTaskId = task.id;
  initProgress(task.id);

  try {
    return await _runTaskInner(task, manual);
  } finally {
    runningTaskId = null;
    // Keep progress around for 30s so UI can show final state
    setTimeout(() => {
      if (currentProgress?.taskId === task.id) currentProgress = null;
    }, 30000);
  }
}

async function _runTaskInner(task: ScenarioTask, manual?: boolean): Promise<RunOutcome> {
  const pack = await loadPack(task.scenario_id);
  if (!pack) {
    finishProgress('error', 'scenario_pack_not_found');
    return { status: 'failed', reason: 'scenario_pack_not_found' };
  }

  // Manual runs ("直接运行") bypass daily cap / interval / weekly rest.
  // Only scheduled auto-runs are subject to all risk guards.
  if (!manual) {
    const gate = riskGuard.canRunNow(task, pack.manifest.risk_caps);
    if (!gate.allowed) {
      riskGuard.markRunSkipped(task.id, gate.reason || 'gate');
      finishProgress('error', gate.reason);
      return { status: 'skipped', reason: gate.reason };
    }
  }

  riskGuard.markRunStart(task.id);

  try {
    // All orchestration logic now lives on the server (orchestrator.js).
    // We just provide the ctx tools and let it run.
    const seen = taskStore.getSeenPostIds(task.id);

    const result = await runOrchestrator(pack, task, seen, {
      stepStart,
      stepLog,
      stepDone,
      stepError,
      finishProgress,
      isAbortRequested: () => abortRequested,
    });

    if (result.status === 'ok') {
      riskGuard.markRunSuccess(task.id, result.collected_count || 0, result.draft_count || 0);
    } else {
      riskGuard.markRunFailure(task.id, result.reason || 'unknown');
    }

    return result;
  } catch (err) {
    let msg = String(err instanceof Error ? err.message : err);
    if (msg.includes('user_stopped')) msg = 'user_stopped';
    riskGuard.markRunFailure(task.id, msg);
    finishProgress('error', msg);
    return { status: 'failed', reason: msg };
  }
}
