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
import { parseJsonSafe } from './localExtractor';
import { getNoobClawAuthToken } from '../claudeSettings';
import * as fs from 'fs';
import * as path from 'path';
import { writeTaskArtifacts, getTaskOutputDir } from './artifactWriter';
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
  finishProgress: (status: 'done' | 'error' | 'partial', error?: string) => void;
  isAbortRequested: () => boolean;
  /** v2.4.35+: accumulate AI token usage per task so the run record
   *  can surface cost. Called after every successful aiCall with:
   *    - tokensDelta: raw total_tokens from this single call
   *    - costDeltaUsd: server-precomputed USD cost for this call (from
   *      _noobclaw.costUsd, i.e. billable_tokens × system_config's
   *      token_price_per_million). Precomputed server-side so the
   *      client doesn't hardcode a rate. */
  addTokensUsed?: (tokensDelta: number, costDeltaUsd: number) => void;
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

// ── Quality gate (v2.4.58+) ──
//
// Deterministic post-AI checks. Used by post-creator orchestrators (XHS,
// Twitter, Binance) via opts.qualityGate in aiCall. Catches:
//   - Banned phrases (platform-specific shill / hype / faux-compliance)
//   - AI-grammar openers ("In the world of..." / "在...的浪潮中" etc.)
//   - Length bounds
//   - Missing un-round numbers (when content needs data density)
//   - Excess emoji
//
// On fail, aiCall augments user message with the failure list and retries.
// Defaults are conservative — most checks only run when caller opts in.

const AI_GRAMMAR_OPENERS = [
  /^\s*在.*的浪潮中/,
  /^\s*让我们(来)?(聊聊|看看|讨论|分析)/,
  /^\s*综上所述/,
  /^\s*总(的)?来说/,
  /^\s*众所周知/,
  /^\s*不可否认/,
  /^\s*毫无疑问/,
  /^\s*in the world of/i,
  /^\s*let'?s dive into/i,
  /^\s*it'?s no secret that/i,
  /^\s*in conclusion/i,
  /^\s*needless to say/i,
  /^\s*at the end of the day/i,
];

export interface QualityGateOpts {
  minLen?: number;
  maxLen?: number;
  bannedPhrases?: string[];
  requireUnRoundNumber?: boolean;
  maxRetries?: number;
}

export function checkQuality(
  text: string,
  opts: QualityGateOpts,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const t = String(text || '').trim();

  // Length bounds
  if (opts.minLen && t.length < opts.minLen) {
    failures.push(`太短 (${t.length} < ${opts.minLen})`);
  }
  if (opts.maxLen && t.length > opts.maxLen) {
    failures.push(`太长 (${t.length} > ${opts.maxLen})`);
  }

  // Banned phrases — case-insensitive substring match
  if (opts.bannedPhrases && opts.bannedPhrases.length > 0) {
    const lowerT = t.toLowerCase();
    for (const phrase of opts.bannedPhrases) {
      if (!phrase) continue;
      if (lowerT.includes(phrase.toLowerCase())) {
        failures.push(`命中禁词: "${phrase}"`);
      }
    }
  }

  // AI-grammar openers
  for (const re of AI_GRAMMAR_OPENERS) {
    if (re.test(t)) {
      failures.push(`AI 腔开场: "${t.slice(0, 25)}..."`);
      break; // one is enough to fail
    }
  }

  // Excess emoji (universal — > 5 always looks like content mill)
  const emojiCount = (t.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F100}-\u{1F1FF}]/gu) || []).length;
  if (emojiCount > 5) {
    failures.push(`emoji 过多 (${emojiCount} > 5)`);
  }

  // Un-round number requirement (e.g. "92.3" / "0.043%" / "73 signups")
  // Triggered for content posts that should have data density.
  // Match: any number with decimal, or 万/亿/K/M/B units, or 2+ digit specific number
  if (opts.requireUnRoundNumber) {
    const hasUnRound = /\d+\.\d+|\d+(?:\.\d+)?\s*[万亿KMB]|\b\d{2,}\b/i.test(t);
    if (!hasUnRound) {
      failures.push('缺少具体数字 (需要至少一个不圆滑数据点)');
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Build the ctx object ──

function buildContext(
  pack: ScenarioPack,
  task: ScenarioTask,
  seenPostIds: Set<string>,
  progress: ProgressFns,
): Record<string, any> {
  const { manifest, scripts, config } = pack;

  // ⭐ Multi-tab routing (Twitter v1): if the scenario manifest declares
  // a tab_url_pattern, every sendBrowserCommand call gets the pattern as
  // a routing hint so the chrome-extension dispatches to the matching
  // tab instead of the active one. Backward compatible — old manifests
  // omit the field, the option object is empty, behavior unchanged.
  const tabPattern = (manifest as any).tab_url_pattern as string | undefined;
  const bridgeOpts = tabPattern ? { tabPattern } : undefined;

  // All drafts collected during this run (for saveDrafts)
  const allDrafts: Draft[] = [];

  const ctx: Record<string, any> = {
    // ── Data ──
    task,
    config,
    manifest,
    seenPostIds,

    // ── Progress ──
    // Track current step so ctx.report() logs to the right panel
    _currentStep: 1,
    report: (msg: string) => progress.stepLog(ctx._currentStep || 1, 'running', msg),
    stepStart: (step: number) => { ctx._currentStep = step; progress.stepStart(step); },
    stepLog: (step: number, status: string, msg: string) => progress.stepLog(step, status as any, msg),
    stepDone: (step: number) => progress.stepDone(step),
    finish: (status: string, error?: string) => progress.finishProgress(status as any, error),
    aborted: () => progress.isAbortRequested(),

    // ── Browser commands — ALL Chrome extension primitives ──
    // Generic passthrough: orchestrator can call any extension command
    // Abortable: polls abort flag during wait
    browser: async (command: string, params?: any, timeout?: number) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      const t = timeout || 10000;
      return Promise.race([
        sendBrowserCommand(command, params || {}, t, bridgeOpts),
        new Promise<never>((_, reject) => {
          const check = setInterval(() => {
            if (progress.isAbortRequested()) {
              clearInterval(check);
              reject(new Error('user_stopped'));
            }
          }, 300);
          setTimeout(() => clearInterval(check), t + 1000);
        }),
      ]);
    },

    // Convenience shortcuts for common operations
    navigate: async (url: string) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      await sendBrowserCommand('navigate', { url }, 30000, bridgeOpts);
    },

    scroll: async (amount?: number) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      await sendBrowserCommand('scroll', { direction: 'down', amount: amount || randInt(2, 4) }, 3000, bridgeOpts);
    },

    sleep: async (min: number, max?: number) => {
      // Interruptible sleep — checks abort every 200ms (was 500ms)
      const total = max ? randInt(min, max) : min;
      const start = Date.now();
      while (Date.now() - start < total) {
        if (progress.isAbortRequested()) throw new Error('user_stopped');
        await sleep(Math.min(200, total - (Date.now() - start)));
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
        const res = await sendBrowserCommand('javascript', { code: script }, 8000, bridgeOpts);
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
      await sendBrowserCommand('click', { coordinate: [x, y] }, 3000, bridgeOpts);
    },

    // Debug log (visible in sidecar console, not in UI)
    log: (msg: string) => {
      coworkLog('INFO', 'orchestrator', msg);
    },

    checkAnomaly: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('check_anomaly', {}, 5000, bridgeOpts);
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
        const res = await sendBrowserCommand('read_feed_cards', {}, 8000, bridgeOpts);
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
        const res = await sendBrowserCommand('read_detail_page', {}, 8000, bridgeOpts);
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

    // AI call — sends prompt as-is, no extra system prompt added, saves tokens
    // promptNameOrRaw: prompt name from pack.prompts, or '__raw__' for direct prompt string
    // When __raw__: promptOrInput = the complete prompt, rawInput = user message
    aiCall: async (
      promptNameOrRaw: string,
      promptOrInput: any,
      rawInput?: string,
      opts?: {
        model?: 'noobclawai-chat' | 'noobclawai-reasoner';
        // v2.4.58+: quality gate — when set, runs deterministic checks on
        // the AI's output (banned phrases / AI-grammar openers / length /
        // un-round number requirement). On failure, augments the user
        // message with the specific failure list and retries up to
        // maxRetries times. Reply scenarios omit this; post composers use it.
        qualityGate?: {
          minLen?: number;
          maxLen?: number;
          bannedPhrases?: string[];     // platform-specific (banned snippets)
          requireUnRoundNumber?: boolean;
          maxRetries?: number;          // default 2 (so total attempts ≤ 3)
        };
        // Internal — used by the recursive retry. Callers should NOT set this.
        _attempt?: number;
      }
    ) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');

      let prompt: string;
      let userMessage: string;

      if (promptNameOrRaw === '__raw__') {
        prompt = String(promptOrInput);
        userMessage = String(rawInput || '');
      } else {
        const promptText = pack.prompts?.[promptNameOrRaw];
        if (!promptText) throw new Error('Missing prompt: ' + promptNameOrRaw);
        prompt = promptText.trim();
        userMessage = typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput);
      }

      // Model selection (v2.4.56+):
      //   - noobclawai-chat      (default) — reply / engagement / parsing,
      //                            optimized for speed + JSON obedience.
      //   - noobclawai-reasoner  — post composition (original / rewrite)
      //                            where we want deeper reasoning to craft
      //                            high-quality content with hook + structure.
      // Orchestrator picks via `opts.model`. Reply scenarios just omit it.
      const chosenModel = (opts && opts.model) || 'noobclawai-chat';
      const attempt = (opts && opts._attempt) || 1;
      const maxRetries = (opts && opts.qualityGate && opts.qualityGate.maxRetries) ?? 2;

      // Scenario rewrite must ALWAYS go through our NoobClaw proxy with
      // model=noobclawai-chat, regardless of the user's current default
      // provider. Rationale:
      //   - We bill scenario usage against the user's NoobClaw balance,
      //     not their personal Qwen/Kimi/DeepSeek-direct key. Using a
      //     third-party provider here would route the cost to them
      //     (surprise invoice) AND skip our metering / token ledger.
      //   - The rewrite prompt is tuned for deepseek-chat's JSON
      //     behaviour; swapping to reasoner/qwen/etc. regresses output
      //     quality or outright breaks JSON parsing.
      //   - Support is simpler when every scenario run uses the same
      //     upstream.
      //
      // So we build our own HTTP request to /api/ai/chat/completions,
      // independent of the user's settings. The Anthropic SDK is NOT
      // reusable here because it authenticates with x-api-key, while our
      // backend authMiddleware requires Authorization: Bearer <JWT>.
      // Simpler to just do a direct fetch in OpenAI-compat format.
      const nbAuthToken = getNoobClawAuthToken();
      if (!nbAuthToken) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');

      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        ctx.report('AI 仍在生成中... (' + elapsedSec + 's)');
      }, 10000);

      const controller = new AbortController();
      const abortPoll = setInterval(() => {
        if (progress.isAbortRequested()) {
          controller.abort();
        }
      }, 500);

      try {
        const resp = await fetch('https://api.noobclaw.com/api/ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${nbAuthToken}`,
          },
          body: JSON.stringify({
            model: chosenModel,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: userMessage },
            ],
            stream: false,
            max_tokens: 8000,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          if (resp.status === 401) throw new Error('AI_AUTH_FAILED — NoobClaw 登录态失效，请重新登录');
          if (resp.status === 402) throw new Error('CREDITS_INSUFFICIENT — 积分余额不足，请前往钱包充值');
          const errText = await resp.text().catch(() => '');
          throw new Error(`AI API ${resp.status}: ${errText.slice(0, 200)}`);
        }
        const json = await resp.json() as any;
        const raw = json?.choices?.[0]?.message?.content || '';
        if (!raw) {
          coworkLog('WARN', 'phaseRunner', 'AI returned empty content', { json });
          throw new Error('AI_EMPTY_RESPONSE — AI 返回空内容');
        }
        // v2.4.36: capture token usage + server-authoritative USD cost.
        // Backend's /api/ai/chat/completions now returns:
        //   response._noobclaw = {
        //     remainingTokens, tokensUsed,
        //     priceUsdPerMillion, costUsd   ← new in v4.20.1 backend
        //   }
        // costUsd is precomputed server-side from system_config.token_price_
        // per_million × billableTokens (after cache-hit discount), so the
        // client never hardcodes a rate. Falls back to raw total_tokens
        // only when the server doesn't include the NoobClaw extension
        // (backward compat with old backends).
        try {
          const nb = json?._noobclaw;
          const total = Number(json?.usage?.total_tokens) || 0;
          const cost = Number(nb?.costUsd) || 0;
          if (total > 0 && progress.addTokensUsed) progress.addTokensUsed(total, cost);
        } catch { /* non-fatal */ }
        // Parse the JSON rewrite payload. Retry parse once if it fails —
        // cheap and catches the occasional 'almost-JSON' response.
        const parsed = parseJsonSafe(raw);
        if (!parsed) {
          coworkLog('WARN', 'phaseRunner', 'AI response not JSON', { rawHead: raw.slice(0, 300) });
          throw new Error('AI_PARSE_FAIL — AI 返回非 JSON: ' + raw.slice(0, 200).replace(/[\n\r]/g, ' '));
        }

        // v2.4.58+ Quality gate (post composers opt in via opts.qualityGate)
        // Runs deterministic regex/length/banned-phrase checks on the AI text
        // and retries up to maxRetries with augmented user message on fail.
        if (opts && opts.qualityGate) {
          const text = (parsed && (parsed.text || parsed.content)) || (typeof parsed === 'string' ? parsed : '');
          const gate = checkQuality(String(text), opts.qualityGate);
          if (!gate.passed) {
            if (attempt <= maxRetries) {
              coworkLog('WARN', 'phaseRunner', 'Quality gate failed, retrying', {
                attempt, failures: gate.failures, textHead: String(text).slice(0, 100),
              });
              ctx.report('   ⚠️ 质量门未过(' + gate.failures.join(' / ') + '),第 ' + attempt + ' 次尝试,重写中...');
              // Augment user message with explicit fix instructions
              const feedback = '\n\n⚠️ 上次输出在以下维度不合格,这次必须修正:\n'
                + gate.failures.map(f => '  • ' + f).join('\n')
                + '\n\n重新写一次,严格修正上述问题。';
              const newRawInput = (rawInput || userMessage) + feedback;
              // For non-__raw__ calls, push feedback into promptOrInput as
              // serialized JSON tail (so the placeholder substitution in
              // prompt template still works on next call's system message).
              if (promptNameOrRaw === '__raw__') {
                return await ctx.aiCall(promptNameOrRaw, prompt, newRawInput, {
                  ...opts, _attempt: attempt + 1,
                });
              } else {
                return await ctx.aiCall(promptNameOrRaw, userMessage + feedback, undefined, {
                  ...opts, _attempt: attempt + 1,
                });
              }
            } else {
              // Out of retries — log loud and return last attempt anyway
              coworkLog('WARN', 'phaseRunner', 'Quality gate exhausted retries, returning last attempt', {
                attempts: attempt, failures: gate.failures,
              });
              ctx.report('   ⚠️ 质量门 ' + (maxRetries + 1) + ' 次都未过,使用最后一次输出。失败项: ' + gate.failures.join(' / '));
            }
          } else if (attempt > 1) {
            ctx.report('   ✅ 质量门第 ' + attempt + ' 次尝试通过');
          }
        }

        return parsed;
      } catch (err: any) {
        if (err?.name === 'AbortError' || progress.isAbortRequested()) {
          throw new Error('user_stopped');
        }
        throw err;
      } finally {
        clearInterval(heartbeat);
        clearInterval(abortPoll);
      }
    },

    // ── State management ──
    recordSeen: (postIds: string[]) => {
      taskStore.recordSeen(task.id, postIds);
    },

    // Call backend API (e.g. image generation) — includes auth token,
    // abortable via progress.isAbortRequested() every 300ms.
    //
    // Pass `body` for POST (default). Omit body (or pass undefined) to
    // issue a GET — used by the async image-job polling flow which hits
    // /api/image/status/:job_id.
    apiCall: async (endpoint: string, body?: any) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      const baseUrl = 'https://api.noobclaw.com';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const authToken = getNoobClawAuthToken();
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const method = body === undefined ? 'GET' : 'POST';

      // AbortController so we can cancel the fetch mid-flight when the user
      // hits stop — without this, the client blocks for up to a minute on
      // long-running image generation.
      const controller = new AbortController();
      const abortPoll = setInterval(() => {
        if (progress.isAbortRequested()) {
          controller.abort();
          clearInterval(abortPoll);
        }
      }, 300);

      // Heartbeat only for long-running POSTs (not short GET polls).
      // /status/:id polls come back in <100ms each, a heartbeat would
      // flood the log.
      const started = Date.now();
      const heartbeat = method === 'POST'
        ? setInterval(() => {
            const secs = Math.round((Date.now() - started) / 1000);
            if (secs >= 8) ctx.report('仍在生成中... (' + secs + 's)');
          }, 8000)
        : null;

      try {
        const resp = await fetch(baseUrl + endpoint, {
          method,
          headers,
          body: method === 'POST' ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        if (!resp.ok) {
          if (resp.status === 402) {
            throw new Error('TOKEN_INSUFFICIENT — 积分不足，请充值后重试');
          }
          const errText = await resp.text().catch(() => '');
          throw new Error('API ' + resp.status + ': ' + errText.slice(0, 200));
        }
        return await resp.json();
      } catch (err: any) {
        if (err?.name === 'AbortError' || progress.isAbortRequested()) {
          throw new Error('user_stopped');
        }
        throw err;
      } finally {
        clearInterval(abortPoll);
        if (heartbeat) clearInterval(heartbeat);
      }
    },

    // Generic file-write into the task's output dir. Used by scenarios
    // that produce a free-form report (e.g. auto_reply's run summary)
    // instead of structured drafts. Returns the absolute path so the
    // orchestrator can log it.
    writeReport: async (filename: string, content: string) => {
      try {
        // Resolve platform from the manifest so Twitter tasks' outputs
        // land in "推特/<task>/..." not "小红书/<task>/...". Before the
        // v2.4.23 fix, getTaskOutputDir defaulted to 'xhs' which put
        // every Twitter report under the XHS folder.
        const platform = (manifest as any).platform || 'xhs';
        const dir = getTaskOutputDir(task, platform);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        // sanitize: strip path separators, keep CJK + alnum + safe punctuation
        const safeName = String(filename || 'report.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, String(content), 'utf8');
        coworkLog('INFO', 'phaseRunner', 'writeReport ok', { path: filePath, bytes: Buffer.byteLength(String(content), 'utf8') });
        return { ok: true, path: filePath, dir };
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'writeReport failed', { err: String(err) });
        return { ok: false, reason: String(err && (err as any).message ? (err as any).message : err) };
      }
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
        // preserve images field so artifactWriter can save them as PNG files
        ...(d.images ? { images: d.images } : {}),
      } as Draft & { images?: any[] }));
      taskStore.addDrafts(drafts);
      allDrafts.push(...drafts);
      try {
        const platform = (manifest as any).platform || 'xhs';
        const result = await writeTaskArtifacts(task, drafts, platform);
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
  options?: { scriptOverride?: string; targetDraft?: any },
): Promise<RunResult> {
  const orchestratorCode = options?.scriptOverride || pack.orchestrator;
  if (!orchestratorCode) {
    return { status: 'failed', reason: 'no_orchestrator_in_pack' };
  }

  const ctx = buildContext(pack, task, seenPostIds, progress);
  // Inject target draft for the upload_draft.js path
  if (options?.targetDraft) {
    (ctx as any)._targetDraft = options.targetDraft;
  }

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
