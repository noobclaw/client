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
import { getCurrentApiConfig } from '../claudeSettings';
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

    // ── Browser commands — ALL Chrome extension primitives ──
    // Generic passthrough: orchestrator can call any extension command
    browser: async (command: string, params?: any, timeout?: number) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      return sendBrowserCommand(command, params || {}, timeout || 10000);
    },

    // Convenience shortcuts for common operations
    navigate: async (url: string) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      await sendBrowserCommand('navigate', { url }, 30000);
    },

    scroll: async (amount?: number) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      await sendBrowserCommand('scroll', { direction: 'down', amount: amount || randInt(2, 4) }, 3000);
    },

    sleep: async (min: number, max?: number) => {
      // Interruptible sleep — checks abort every 500ms
      const total = max ? randInt(min, max) : min;
      const start = Date.now();
      while (Date.now() - start < total) {
        if (progress.isAbortRequested()) throw new Error('user_stopped');
        await sleep(Math.min(500, total - (Date.now() - start)));
      }
    },

    // ── Script injection ──
    // Runs a server-hosted script, optionally replacing __PLACEHOLDERS__
    runScript: async (name: string, params?: Record<string, string>) => {
      let script = scripts[name];
      if (!script) {
        coworkLog('WARN', 'phaseRunner', `script "${name}" not found in pack`);
        return null;
      }
      // Replace __KEY__ placeholders with param values
      if (params) {
        for (const [key, val] of Object.entries(params)) {
          script = script.replace(new RegExp(`__${key.toUpperCase()}__`, 'g'), String(val).replace(/'/g, "\\'"));
        }
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

    // Atomic click at coordinates — used by orchestrator's clickByText()
    click: async (x: number, y: number) => {
      await sendBrowserCommand('click', { coordinate: [x, y] }, 3000);
    },

    // Debug log (visible in sidecar console, not in UI)
    log: (msg: string) => {
      coworkLog('DEBUG', 'orchestrator', msg);
    },

    checkAnomaly: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('check_anomaly', {}, 5000);
        const data = res?.data || res || {};
        const status = data.status || 'ok';
        if (status === 'captcha' || status === 'login_wall' || status === 'rate_limited' || status === 'account_flag') {
          riskGuard.recordAnomaly(task.id, status as any, manifest.risk_caps);
          ctx.report('检测到异常: ' + status);
          throw new Error('anomaly:' + status);
        }
      } catch (err) {
        if (String(err).startsWith('Error: anomaly:')) throw err;
      }
    },

    // Read feed cards via extension's built-in command (CSP-safe)
    readCards: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('read_feed_cards', {}, 8000);
        const data = res?.data || res || {};
        return data.cards || [];
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'readCards failed', { err: String(err) });
        return [];
      }
    },

    // Read detail page via extension's built-in command (CSP-safe)
    readDetail: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('read_detail_page', {}, 8000);
        return res?.data || res || null;
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'readDetail failed', { err: String(err) });
        return null;
      }
    },

    // ── AI calls ──
    // Get a prompt template by name (for orchestrator to fill variables)
    getPrompt: (name: string) => {
      const text = pack.prompts?.[name];
      if (!text) throw new Error('Missing prompt: ' + name);
      return text;
    },

    // AI call — supports named prompts or raw prompt string (__raw__)
    aiCall: async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');

      let systemPrompt: string;
      let userMessage: string;

      if (promptNameOrRaw === '__raw__') {
        // Raw mode: promptOrInput is the full system prompt, rawInput is user message
        systemPrompt = String(promptOrInput);
        userMessage = String(rawInput || '');
      } else {
        // Named mode: look up prompt by name
        const promptText = pack.prompts?.[promptNameOrRaw];
        if (!promptText) throw new Error('Missing prompt: ' + promptNameOrRaw);
        systemPrompt = promptText.trim();
        userMessage = typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput);
      }

      const apiCfg = getCurrentApiConfig();
      if (!apiCfg || !apiCfg.apiKey) throw new Error('AI_NOT_CONFIGURED — 请在设置中连接 AI 服务');

      const response = await localExtractor.callAIWithConfig(
        apiCfg, systemPrompt, userMessage
      );
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
        const result = await writeTaskArtifacts(task, drafts);
        return { dir: result.dir, files: result.files };
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'artifact save failed', { err: String(err) });
        return { dir: '', files: [] };
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
