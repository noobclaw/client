/**
 * phaseRunner.ts — generic orchestrator executor.
 *
 * Downloads orchestrator.js from the server skill pack, constructs a
 * sandboxed `ctx` object with tool methods, and executes the orchestrator
 * via `new AsyncFunction('ctx', code)`.
 *
 * This is the ONLY file that needs to exist in the client for scenario
 * execution. All business logic (what to search, how to filter, which
 * AI prompts to use) lives on the server and is hot-updatable.
 */

import crypto from 'crypto';
import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand } from '../browserBridge';
import * as riskGuard from './riskGuard';
import * as taskStore from './taskStore';
import * as localExtractor from './localExtractor';
import { writeTaskArtifacts } from './artifactWriter';
import type {
  Draft,
  ScenarioPack,
  ScenarioTask,
} from './types';

// ── Progress helpers (imported from scenarioManager at call time) ──

export interface ProgressFns {
  stepStart: (step: number) => void;
  stepLog: (step: number, status: 'done' | 'running' | 'error', message: string) => void;
  stepDone: (step: number) => void;
  stepError: (step: number, error: string) => void;
  finishProgress: (status: 'done' | 'error', error?: string) => void;
  isAbortRequested: () => boolean;
}

export interface RunResult {
  status: 'ok' | 'failed';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
}

// ── Utilities ──

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(minMs: number, maxMs?: number): Promise<void> {
  const ms = maxMs ? randInt(minMs, maxMs) : minMs;
  return new Promise(r => setTimeout(r, ms));
}

function parseLikes(text: string): number {
  if (!text) return 0;
  const s = String(text).trim();
  const match = s.match(/([\d.]+)\s*([万wW千kK]*)/);
  if (!match) return parseInt(s, 10) || 0;
  const n = parseFloat(match[1]);
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(n * 1000);
  return Math.round(n);
}

function keywordMatch(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return keywords.some(k => lowered.includes(k.toLowerCase()));
}

// ── Build the ctx object ──

function buildContext(
  pack: ScenarioPack,
  task: ScenarioTask,
  seenPostIds: Set<string>,
  progress: ProgressFns,
): Record<string, any> {
  const { manifest, scripts, config } = pack;

  // All drafts collected during this run (for saveDrafts)
  const allDrafts: Draft[] = [];

  const ctx: Record<string, any> = {
    // ── Data ──
    task,
    config,
    manifest,
    seenPostIds,

    // ── Progress ──
    report: (msg: string) => progress.stepLog(1, 'running', msg),
    stepStart: (step: number) => progress.stepStart(step),
    stepLog: (step: number, status: string, msg: string) => progress.stepLog(step, status as any, msg),
    stepDone: (step: number) => progress.stepDone(step),
    finish: (status: string, error?: string) => progress.finishProgress(status as any, error),
    aborted: () => progress.isAbortRequested(),

    // ── Browser commands ──
    navigate: async (url: string) => {
      await sendBrowserCommand('navigate', { url }, 30000);
    },

    scroll: async (amount?: number) => {
      await sendBrowserCommand('scroll', { direction: 'down', amount: amount || randInt(2, 4) }, 3000);
    },

    sleep: async (min: number, max?: number) => {
      await sleep(min, max);
    },

    // ── Script injection ──
    runScript: async (name: string) => {
      const script = scripts[name];
      if (!script) {
        coworkLog('WARN', 'phaseRunner', `script "${name}" not found in pack`);
        return null;
      }
      try {
        const res = await sendBrowserCommand('javascript', { code: script }, 8000);
        const raw = res?.result;
        if (typeof raw === 'string') {
          try { return JSON.parse(raw); } catch { return raw; }
        }
        return raw;
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', `runScript("${name}") failed`, { err: String(err) });
        return null;
      }
    },

    clickByText: async (text: string, pauseRange?: [number, number]) => {
      const script = scripts.click_by_text;
      if (!script) return 'no_script';
      const code = script.replace(/__TARGET__/g, text.replace(/'/g, "\\'"));
      try {
        // Step 1: Find element coordinates via injected JS
        const res = await sendBrowserCommand('javascript', { code }, 5000);
        const raw = res?.result;
        if (!raw) return 'not_found';
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!info.found) {
          coworkLog('DEBUG', 'phaseRunner', `clickByText("${text}") → not_found`);
          return 'not_found';
        }
        // Step 2: Real mouse click at coordinates via Chrome extension
        await sendBrowserCommand('click', { x: info.x, y: info.y }, 3000);
        coworkLog('DEBUG', 'phaseRunner', `clickByText("${text}") → clicked ${info.tag}.${info.cls} at (${info.x},${info.y})`);
        if (pauseRange) {
          await sleep(pauseRange[0], pauseRange[1]);
        }
        return 'clicked';
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', `clickByText("${text}") failed`, { err: String(err) });
        return 'error';
      }
    },

    checkAnomaly: async () => {
      const script = scripts.check_anomaly;
      if (!script) return;
      try {
        const res = await sendBrowserCommand('javascript', { code: script }, 5000);
        const raw = res?.result || 'ok';
        if (raw === 'captcha' || raw === 'login_wall' || raw === 'rate_limited' || raw === 'account_flag') {
          riskGuard.recordAnomaly(task.id, raw as any, manifest.risk_caps);
          ctx.report('检测到异常: ' + raw);
          throw new Error('anomaly:' + raw);
        }
      } catch (err) {
        if (String(err).startsWith('Error: anomaly:')) throw err;
        // Non-anomaly errors are ignored
      }
    },

    // ── AI calls ──
    aiCall: async (promptName: string, input: any) => {
      const promptText = pack.prompts?.[promptName];
      if (!promptText) throw new Error('Missing prompt: ' + promptName);

      const apiConfig = localExtractor.getApiConfig();
      if (!apiConfig.apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING');

      const response = await localExtractor.callAI(promptText.trim(), JSON.stringify(input));
      return response;
    },

    // ── State management ──
    recordSeen: (postIds: string[]) => {
      taskStore.recordSeen(task.id, postIds);
    },

    saveDrafts: async (rawDrafts: any[]) => {
      const drafts: Draft[] = rawDrafts.map(d => ({
        id: crypto.randomUUID(),
        task_id: task.id,
        source_post: d.source_post,
        extraction: d.extraction,
        variant: d.variant,
        status: 'pending' as const,
        created_at: Date.now(),
      }));
      taskStore.addDrafts(drafts);
      allDrafts.push(...drafts);
      try {
        await writeTaskArtifacts(task, drafts);
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'artifact save failed', { err: String(err) });
      }
    },

    // ── Utilities ──
    parseLikes,
    keywordMatch,
    randInt,

    // ── Internal: access to accumulated drafts ──
    _getAllDrafts: () => allDrafts,
  };

  return ctx;
}

// ── Main entry ──

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function runOrchestrator(
  pack: ScenarioPack,
  task: ScenarioTask,
  seenPostIds: Set<string>,
  progress: ProgressFns,
): Promise<RunResult> {
  const orchestratorCode = pack.orchestrator;
  if (!orchestratorCode) {
    return { status: 'failed', reason: 'no_orchestrator_in_pack' };
  }

  const ctx = buildContext(pack, task, seenPostIds, progress);

  try {
    const fn = new AsyncFunction('ctx', orchestratorCode);
    const result = await fn(ctx);
    // If orchestrator returned a result, use it
    if (result && typeof result === 'object' && result.status) {
      return result as RunResult;
    }
    // Otherwise construct from state
    const drafts = ctx._getAllDrafts();
    return {
      status: 'ok',
      collected_count: 0,
      draft_count: drafts.length,
    };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    coworkLog('ERROR', 'phaseRunner', 'orchestrator threw', { err: msg });
    if (msg.includes('user_stopped')) {
      return { status: 'failed', reason: 'user_stopped' };
    }
    return { status: 'failed', reason: msg };
  }
}
