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

import crypto from 'crypto';
import { coworkLog } from '../coworkLogger';
import * as riskGuard from './riskGuard';
import * as taskStore from './taskStore';
import * as viralPoolClient from './viralPoolClient';
import * as localExtractor from './localExtractor';
import { discoverXhsNotes } from './xhsDriver';
import { writeTaskArtifacts } from './artifactWriter';
import type {
  DiscoveredNote,
  Draft,
  ExtractionResult,
  ScenarioManifest,
  ScenarioPack,
  ScenarioTask,
} from './types';

const packCache = new Map<string, ScenarioPack>();

async function loadPack(scenario_id: string): Promise<ScenarioPack | null> {
  if (packCache.has(scenario_id)) return packCache.get(scenario_id)!;
  const raw = await viralPoolClient.fetchScenarioPack(scenario_id);
  if (!raw || !raw.manifest) return null;
  const pack: ScenarioPack = {
    manifest: raw.manifest as ScenarioManifest,
    skills: raw.skills || {},
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
      { name: '通过关键词浏览阅读。请勿关闭 Chrome 和小红书。', status: 'waiting', logs: [] },
      { name: '分析爆款，拆解逻辑', status: 'waiting', logs: [] },
      { name: '改写图文，并输出结果，本地保存一份，上传到您小红书账号一份', status: 'waiting', logs: [] },
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
  // Replace the last "running" entry if this is an update
  const logs = currentProgress.steps[step - 1].logs;
  if (logs.length > 0 && logs[logs.length - 1].status === 'running') {
    logs[logs.length - 1] = { time: now(), status, message };
  } else {
    logs.push({ time: now(), status, message });
  }
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
    // ── STEP 1: Discovery ──
    stepStart(1);
    stepLog(1, 'running', `通过关键词"${task.keywords[0] || ''}"查找文章`);

    if (abortRequested) { finishProgress('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped' }; }

    const seen = taskStore.getSeenPostIds(task.id);
    let notes: DiscoveredNote[] = [];

    if (pack.manifest.platform === 'xhs') {
      notes = await discoverXhsNotes({ task, manifest: pack.manifest, seenPostIds: seen });
    } else {
      stepError(1, '平台暂未支持');
      finishProgress('error', 'platform_not_implemented');
      return { status: 'failed', reason: 'platform_not_implemented' };
    }

    taskStore.recordSeen(task.id, notes.map(n => n.external_post_id));
    stepLog(1, 'done', `发现 ${notes.length} 条符合条件的爆款`);
    stepDone(1);

    if (notes.length === 0) {
      finishProgress('done');
      riskGuard.markRunSuccess(task.id, 0, 0);
      return { status: 'ok', collected_count: 0, draft_count: 0, drafts: [] };
    }

    if (abortRequested) { finishProgress('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped' }; }

    // ── STEP 2: Extraction ──
    stepStart(2);
    const drafts: Draft[] = [];
    const extractions: Array<{ note: DiscoveredNote; extraction: ExtractionResult }> = [];

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (abortRequested) { finishProgress('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped' }; }

      stepLog(2, 'running', `拆解第 ${i + 1}/${notes.length} 篇: "${(note.title || '').slice(0, 30)}"`);

      try {
        const extraction = await extractWithCache(pack, note);
        if (extraction) {
          extractions.push({ note, extraction });
          stepLog(2, 'done', `已拆解: "${(note.title || '').slice(0, 30)}"`);
        }
      } catch (err) {
        coworkLog('WARN', 'scenarioManager', 'extraction failed', { post_id: note.external_post_id, err: String(err) });
        stepLog(2, 'error', `拆解失败: "${(note.title || '').slice(0, 20)}" — ${String(err).slice(0, 50)}`);
      }
    }
    stepDone(2);

    if (abortRequested) { finishProgress('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped' }; }

    // ── STEP 3: Composition + Save ──
    stepStart(3);

    for (let i = 0; i < extractions.length; i++) {
      const { note, extraction } = extractions[i];
      if (abortRequested) { finishProgress('error', 'user_stopped'); return { status: 'failed', reason: 'user_stopped' }; }

      stepLog(3, 'running', `改写第 ${i + 1}/${extractions.length} 篇: "${(note.title || '').slice(0, 30)}"`);

      try {
        const variants = await localExtractor.compose(pack, task, extraction, note.body);
        for (const variant of variants) {
          drafts.push({
            id: crypto.randomUUID(),
            task_id: task.id,
            source_post: note,
            extraction,
            variant,
            status: 'pending',
            created_at: Date.now(),
          });
        }
        stepLog(3, 'done', `已生成 ${variants.length} 份仿写: "${(note.title || '').slice(0, 25)}"`);
      } catch (err) {
        coworkLog('WARN', 'scenarioManager', 'compose failed', { post_id: note.external_post_id, err: String(err) });
        stepLog(3, 'error', `改写失败: ${String(err).slice(0, 50)}`);
      }
    }

    if (drafts.length > 0) {
      taskStore.addDrafts(drafts);
      stepLog(3, 'running', '保存结果到本地...');
      try {
        await writeTaskArtifacts(task, drafts);
        stepLog(3, 'done', `已保存 ${drafts.length} 份草稿到本地`);
      } catch (err) {
        coworkLog('WARN', 'scenarioManager', 'artifact save failed', { err: String(err) });
      }
    }

    stepDone(3);
    finishProgress('done');
    riskGuard.markRunSuccess(task.id, notes.length, drafts.length);

    return {
      status: 'ok',
      collected_count: notes.length,
      draft_count: drafts.length,
      drafts,
    };
  } catch (err) {
    const msg = String(err);
    riskGuard.markRunFailure(task.id, msg);
    finishProgress('error', msg);
    return { status: 'failed', reason: msg };
  }
}

// ── Helpers ──

async function extractWithCache(pack: ScenarioPack, note: DiscoveredNote): Promise<ExtractionResult | null> {
  const cached = await viralPoolClient.lookup(
    pack.manifest.platform,
    note.external_post_id,
    pack.manifest.version
  );
  if (cached?.extraction?.result) return cached.extraction.result;

  const extraction = await localExtractor.extract(pack, note);
  if (!extraction) return null;

  viralPoolClient
    .submit({ manifest: pack.manifest, note, extraction, ai_model: localExtractor.getCurrentModelName() })
    .catch(err => coworkLog('WARN', 'scenarioManager', 'pool submit failed', { err: String(err) }));

  return extraction;
}
