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

/** v4.31.38: race 用 abort 哨兵 —— 所有 ctx.* 浏览器操作 race 它,abort flag
 *  设置后立即 reject('user_stopped'),不等浏览器响应。每 200ms 轮询一次。
 *  调用方负责清理 setInterval(通过 finally 或 race 完成自动 GC)。 */
function abortPoll(isAbortRequested: () => boolean): Promise<never> {
  return new Promise<never>((_, reject) => {
    const check = setInterval(() => {
      if (isAbortRequested()) {
        clearInterval(check);
        reject(new Error('user_stopped'));
      }
    }, 200);
    // 30 分钟兜底自动 GC,防 setInterval 永不退出泄漏
    setTimeout(() => clearInterval(check), 30 * 60 * 1000);
  });
}

/** v4.31.39: 所有 ctx.* 调 sendBrowserCommand 的统一入口 —— 调用前 check
 *  abort + race(sendBrowserCommand vs abortPoll)。task 停了浏览器侧立即
 *  throw user_stopped 不再 click/scroll/navigate。需要 closure 捕获 progress
 *  + getBridgeOpts,所以放进 buildContext 内做工厂。 */

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

  // ⭐ Multi-tab routing: if manifest declares a tab_url_pattern, every
  // sendBrowserCommand call gets that pattern so the chrome-extension
  // dispatches to the matching tab instead of the active one.
  //
  // v4.25+ cross-tab scenarios (binance_from_x_repost): manifest can also
  // declare `secondary_tab_url_pattern`. Orchestrator calls
  // `ctx.setActiveTab('primary' | 'secondary')` to swap routing target
  // mid-run — needed when one scenario touches both X and Binance tabs.
  // Back-compat: single-tab scenarios never call setActiveTab and behave
  // as before (bridgeOpts bound to primary pattern).
  const primaryPattern = (manifest as any).tab_url_pattern as string | undefined;
  const secondaryPattern = (manifest as any).secondary_tab_url_pattern as string | undefined;
  let activePattern: string | undefined = primaryPattern;
  const getBridgeOpts = () => activePattern ? { tabPattern: activePattern } : undefined;

  // v4.31.39: 统一 abortable browser command —— 所有 ctx.* 浏览器操作经此入口,
  //   abort flag 设置后立即 throw 'user_stopped',不等浏览器响应。
  const abortableCmd = async (command: string, params: any, timeout: number): Promise<any> => {
    if (progress.isAbortRequested()) throw new Error('user_stopped');
    return Promise.race([
      sendBrowserCommand(command, params, timeout, getBridgeOpts()),
      abortPoll(progress.isAbortRequested),
    ]);
  };

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
    // v4.31.34: stepStart 同时写一条启动 log,UI 立刻能看到这一步在跑,
    //   不再卡"正在启动…(后端流式日志稍候)"。orchestrator 第一次 stepLog
    //   之前可能有数秒的浏览器交互(get_url / navigate),这段时间用户原本
    //   只能看到空 logs。
    stepStart: (step: number) => {
      ctx._currentStep = step;
      progress.stepStart(step);
      progress.stepLog(step, 'running', '▶ 步骤 ' + step + ' 开始');
    },
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
        sendBrowserCommand(command, params || {}, t, getBridgeOpts()),
        new Promise<never>((_, reject) => {
          const check = setInterval(() => {
            if (progress.isAbortRequested()) {
              clearInterval(check);
              reject(new Error('user_stopped'));
            }
          }, 300);
          // v4.31.34: race 第二个 promise 之前只在 abort 时 reject,timer 仅
          //   clearInterval。如果 sendBrowserCommand 内部的 setTimeout 因某种
          //   原因没 fire(扩展 half-open / 进程被挂起 等),整个 await 永远
          //   pending,orchestrator 卡在第一个 ctx.browser 上,后续 stepLog
          //   永远不调,UI 卡 "正在启动…"。这里改成 t+2s 后强制 reject 兜底。
          setTimeout(() => {
            clearInterval(check);
            reject(new Error('browser command "' + command + '" hard-timeout after ' + (t + 2000) + 'ms'));
          }, t + 2000);
        }),
      ]);
    },

    // v4.25+ cross-tab routing: swap which tab pattern ctx.browser/navigate/
    // scroll route to. Only used by scenarios declaring secondary_tab_url_pattern
    // (currently only binance_from_x_repost). No-op for single-tab scenarios.
    setActiveTab: (key: 'primary' | 'secondary') => {
      if (key === 'secondary') {
        if (!secondaryPattern) {
          coworkLog('WARN', 'phaseRunner', 'setActiveTab("secondary") called but no secondary_tab_url_pattern in manifest');
          return;
        }
        activePattern = secondaryPattern;
      } else {
        activePattern = primaryPattern;
      }
    },
    getActiveTabKey: () => (activePattern === secondaryPattern ? 'secondary' : 'primary'),

    // Convenience shortcuts for common operations
    // v4.31.38/39: 所有 ctx.* 浏览器操作走 abortableCmd —— race
    //   (sendBrowserCommand vs abortPoll),用户停 task 后浏览器侧立即 throw
    //   不再操作。之前只 navigate/scroll 加了,click/runScript 漏了 → 发推
    //   按钮的最后一击 click 不 abort,task 停了还能发出去。这里抽 helper
    //   统一加固。
    navigate: async (url: string) => {
      await abortableCmd('navigate', { url }, 30000);
    },

    scroll: async (amount?: number) => {
      await abortableCmd('scroll', { direction: 'down', amount: amount || randInt(2, 4) }, 3000);
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
      if (params) {
        for (const [key, val] of Object.entries(params)) {
          script = script.replace(new RegExp(`__${key.toUpperCase()}__`, 'g'), String(val).replace(/'/g, "\\'"));
        }
      }
      try {
        const res = await abortableCmd('javascript', { code: script }, 8000);
        const raw = res?.result;
        if (typeof raw === 'string') {
          try { return JSON.parse(raw); } catch { return raw; }
        }
        return raw;
      } catch (err) {
        if (String(err && (err as any).message || err).includes('user_stopped')) throw err;
        coworkLog('WARN', 'phaseRunner', `runScript("${name}") failed`, { err: String(err) });
        return null;
      }
    },

    // Atomic click at coordinates — used by orchestrator's clickByText().
    // v4.31.39: 加 abortableCmd —— click 是发推/发帖按钮的最后一击,task 停
    //   了不 abort 浏览器还会真的点出去,造成用户报告"任务停了还在自动发文"。
    click: async (x: number, y: number) => {
      await abortableCmd('click', { coordinate: [x, y] }, 3000);
    },

    // Debug log (visible in sidecar console, not in UI)
    log: (msg: string) => {
      coworkLog('INFO', 'orchestrator', msg);
    },

    checkAnomaly: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('check_anomaly', {}, 5000, getBridgeOpts());
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
        const res = await sendBrowserCommand('read_feed_cards', {}, 8000, getBridgeOpts());
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
        const res = await sendBrowserCommand('read_detail_page', {}, 8000, getBridgeOpts());
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
        // v4.31.3 架构清理:expectJson=false → 纯文本模式,跳过 JSON.parse,
        // qualityGate 直接验 raw 字符串,返回字符串。配合 prompt 里写 "只输出正文
        // 不要 JSON 包" 的场景。默认 true 维持老行为(老 orchestrator 不动)。
        expectJson?: boolean;
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

      // v4.31.4: 用 DeepSeek 原生 response_format 锁格式 — JSON 模式下后端
      // 保证 content 字符串是合法 JSON,纯文本模式直接返回字符串。
      //
      // ⚠️ 文档警告:json_object 模式必须 prompt 里含 "json" 字眼,否则 DeepSeek
      // 会无限输出空白直到 token 用完(stuck 请求)。所以下面做了保护性校验:
      // expectJson 默认为 true(老行为),但只在 prompt 真的提到 "json/JSON" 时
      // 才传 response_format,否则 fallback 到 text 模式 + 我方 JSON.parse 兜底。
      const wantJson = opts?.expectJson !== false;
      const promptMentionsJson = /json/i.test(prompt) || /json/i.test(userMessage);
      const requestBody: Record<string, unknown> = {
        model: chosenModel,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
        max_tokens: 8000,
      };
      if (wantJson && promptMentionsJson) {
        requestBody.response_format = { type: 'json_object' };
      } else if (!wantJson) {
        requestBody.response_format = { type: 'text' };
      }
      // 其余情况(wantJson 但 prompt 没说 json)— 不传,用 DeepSeek 默认 text,
      // 我方 JSON.parse 失败时仍然走 expectJson:true 的兜底路径(parse 失败抛 +
      // err.rawText 挂全文)。

      // v4.31.6: fetch 网络错误一次性重试。'fetch failed' 通常是瞬时网络抖动
       // (WiFi 切换 / VPN 重连 / 服务侧短暂 502),首次失败后等 3s 重试一次。
       // 不重试 5xx / abort / 业务错(401/402)— 那些是确定性失败。
      const fetchWithRetry = async (): Promise<Response> => {
        const doFetch = () => fetch('https://api.noobclaw.com/api/ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${nbAuthToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        try {
          return await doFetch();
        } catch (err: any) {
          if (err?.name === 'AbortError' || progress.isAbortRequested()) throw err;
          coworkLog('WARN', 'phaseRunner', 'fetch failed, retrying once', { err: String(err).slice(0, 200) });
          ctx.report('   ⚠️ 网络异常,3 秒后重试一次');
          await new Promise(r => setTimeout(r, 3000));
          return await doFetch(); // 第二次失败就让它抛
        }
      };

      try {
        const resp = await fetchWithRetry();
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
        // v4.31.3 架构清理:两条返回路径 — JSON 模式 vs 纯文本模式 —
        // 都走同一个 qualityGate 重试逻辑。
        const isTextMode = opts?.expectJson === false;

        // ── 决定可被 qualityGate 校验的 text + 最终 return value ──
        let textForGate: string;
        let returnValue: any;
        if (isTextMode) {
          // 纯文本模式 — 不解析,直接用 raw,return string
          textForGate = raw;
          returnValue = raw;
        } else {
          // JSON 模式 — 严格 parse,失败抛 AI_PARSE_FAIL(原文挂 err.rawText)
          const parsed = parseJsonSafe(raw);
          if (!parsed) {
            coworkLog('WARN', 'phaseRunner', 'AI response not JSON', { rawHead: raw.slice(0, 300) });
            const err: any = new Error('AI_PARSE_FAIL — AI 返回非 JSON: ' + raw.slice(0, 200).replace(/[\n\r]/g, ' '));
            err.rawText = raw;
            err.code = 'AI_PARSE_FAIL';
            throw err;
          }
          textForGate = (parsed && (parsed.text || parsed.content)) || (typeof parsed === 'string' ? parsed : '');
          returnValue = parsed;
        }

        // v2.4.58+ Quality gate(post composers opt in via opts.qualityGate)
        // 不论 JSON / text 模式都跑同一套校验 + 重试。
        if (opts && opts.qualityGate) {
          const gate = checkQuality(String(textForGate), opts.qualityGate);
          if (!gate.passed) {
            if (attempt <= maxRetries) {
              coworkLog('WARN', 'phaseRunner', 'Quality gate failed, retrying', {
                attempt, failures: gate.failures, textHead: String(textForGate).slice(0, 100),
              });
              ctx.report('   ⚠️ 质量门未过(' + gate.failures.join(' / ') + '),第 ' + attempt + ' 次尝试,重写中...');
              const feedback = '\n\n⚠️ 上次输出在以下维度不合格,这次必须修正:\n'
                + gate.failures.map(f => '  • ' + f).join('\n')
                + '\n\n重新写一次,严格修正上述问题。';
              const newRawInput = (rawInput || userMessage) + feedback;
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
              coworkLog('WARN', 'phaseRunner', 'Quality gate exhausted retries, returning last attempt', {
                attempts: attempt, failures: gate.failures,
              });
              ctx.report('   ⚠️ 质量门 ' + (maxRetries + 1) + ' 次都未过,使用最后一次输出。失败项: ' + gate.failures.join(' / '));
            }
          } else if (attempt > 1) {
            ctx.report('   ✅ 质量门第 ' + attempt + ' 次尝试通过');
          }
        }

        return returnValue;
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
    // v4.25.36: 暴露读取 seen 列表 — binance_from_x_repost 等需要跨 run 跳过
    // 已经搬运过的源推文。返回 Set<string>(orchestrator 自己 .has() 判断)。
    getSeenIds: (): Set<string> => {
      return taskStore.getSeenPostIds(task.id);
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

    // v2.4.90: Binary asset write — decodes base64 and saves to task's
    // output dir. Unlike writeReport (utf8-only), this handles images /
    // audio / any binary. Used by x_link_rewrite to save source tweet
    // images next to the markdown report for user audit.
    // opts.subdir: optional subdirectory inside task dir (e.g. '原文').
    // Single-level only, stripped of path separators / parent refs for safety.
    writeAsset: async (
      filename: string,
      base64: string,
      opts?: { subdir?: string; compress?: boolean; maxSizeKB?: number; maxDimension?: number }
    ) => {
      try {
        const platform = (manifest as any).platform || 'xhs';
        const dir = getTaskOutputDir(task, platform);
        let targetDir = dir;
        if (opts && typeof opts.subdir === 'string' && opts.subdir.trim()) {
          // v4.25.2: 允许嵌套("原文/career_side_hustle"),但每层 segment 单独 sanitize
          // 防 path traversal:任何带 .. 的 segment 直接丢
          const segments = opts.subdir.split(/[\\/]+/).map(s =>
            s.replace(/[:*?"<>|]/g, '_').replace(/^\.+$/, '').slice(0, 80).trim()
          ).filter(s => s.length > 0 && s !== '..');
          if (segments.length > 0) targetDir = path.join(dir, ...segments);
        }
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
        const safeNameRaw = String(filename || 'asset.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);

        let buf = Buffer.from(String(base64 || ''), 'base64');
        let safeName = safeNameRaw;

        // v4.25+: opt-in 图片压缩 — orchestrator 设 { compress: true } 就把图压
        // 到 ≤maxSizeKB(默认 300KB)。jpeg + 长边 ≤maxDimension(默认 1600).
        // 用 sharp(client deps 已带);非图片或 sharp 解码失败就 fallback 写原 buffer。
        if (opts && opts.compress && buf.length > 0) {
          const targetKB = opts.maxSizeKB || 300;
          const maxDim = opts.maxDimension || 1600;
          if (buf.length > targetKB * 1024) {
            try {
              // dynamic require 避免 sharp 没装(开发时)整个 phaseRunner 起不来
              const sharp = require('sharp');
              let pipeline = sharp(buf, { failOn: 'error' }).rotate();
              const meta = await pipeline.metadata().catch((): any => null);
              if (meta && meta.width && meta.height) {
                const longest = Math.max(meta.width, meta.height);
                if (longest > maxDim) {
                  pipeline = pipeline.resize({
                    width: meta.width >= meta.height ? maxDim : undefined,
                    height: meta.height > meta.width ? maxDim : undefined,
                    fit: 'inside', withoutEnlargement: true,
                  });
                }
                // 二分逼近 quality
                let qLo = 30, qHi = 90;
                let best: Buffer | null = null;
                for (let it = 0; it < 6; it++) {
                  const q = Math.round((qLo + qHi) / 2);
                  const out = await pipeline.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
                  if (out.length <= targetKB * 1024) { best = out; qLo = q + 1; }
                  else qHi = q - 1;
                  if (qLo > qHi) break;
                }
                if (!best) best = await pipeline.clone().jpeg({ quality: 30, mozjpeg: true }).toBuffer();
                buf = Buffer.from(best);
                // 强制扩展名为 .jpg(压缩后是 jpeg)
                safeName = safeNameRaw.replace(/\.(png|webp|gif|bmp|tiff?)$/i, '.jpg');
                if (!/\.jpe?g$/i.test(safeName)) safeName = safeName.replace(/\.[^.]*$/, '') + '.jpg';
              }
            } catch (compressErr) {
              coworkLog('WARN', 'phaseRunner', 'writeAsset compress failed, falling back to original', {
                err: String(compressErr).slice(0, 200),
              });
            }
          }
        }

        const filePath = path.join(targetDir, safeName);
        fs.writeFileSync(filePath, buf);
        coworkLog('INFO', 'phaseRunner', 'writeAsset ok', { path: filePath, bytes: buf.length });
        return { ok: true, path: filePath, dir: targetDir, bytes: buf.length };
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'writeAsset failed', { err: String(err) });
        return { ok: false, reason: String(err && (err as any).message ? (err as any).message : err) };
      }
    },

    // v4.25.2: 拉服务端下发的爆文库配置(max_per_run / max_image_size_kb / max_image_count)。
    // 缓存到 ctx 上避免每次都打一遍 GET — 同一次 run 内只取一次。
    // 取不到就用代码里的默认值兜底(5/300/4),保证旧服务端兼容。
    getViralConfig: async () => {
      if ((ctx as any)._viralConfigCache) return (ctx as any)._viralConfigCache;
      const fallback: any = {
        max_per_run: 100,
        max_image_size_kb: 300,
        max_image_count: 4,
        // v4.27: 兜底阈值跟服务端 VIRAL_THRESHOLDS 一致。新服务端会下发,
        // 老服务端拿不到也能用这套默认值。
        thresholds: {
          // 字段在三平台对齐 — 缺失维度服务端可挂 null,helper 会跳过。
          // XHS 的 min_views 填值但实际抓不到(平台不公开),仅为 schema 对齐。
          xhs:     { min_likes: 500, min_comments: 20, min_views: 1000, min_match: 1 },
          x:       { min_likes: 500, min_comments: 20, min_views: 5000, min_match: 1 },
          binance: { min_likes: 500, min_comments: 20, min_views: 5000, min_match: 1 },
        },
      };
      try {
        const baseUrl = 'https://api.noobclaw.com';
        const resp = await fetch(baseUrl + '/api/viral/library/config');
        if (!resp.ok) {
          (ctx as any)._viralConfigCache = fallback;
          return fallback;
        }
        const data = await resp.json();
        const merged: any = {
          max_per_run: typeof data.max_per_run === 'number' && data.max_per_run > 0 ? data.max_per_run : fallback.max_per_run,
          max_image_size_kb: typeof data.max_image_size_kb === 'number' && data.max_image_size_kb > 0 ? data.max_image_size_kb : fallback.max_image_size_kb,
          max_image_count: typeof data.max_image_count === 'number' && data.max_image_count > 0 ? data.max_image_count : fallback.max_image_count,
          thresholds: (data.thresholds && typeof data.thresholds === 'object') ? data.thresholds : fallback.thresholds,
        };
        (ctx as any)._viralConfigCache = merged;
        return merged;
      } catch (_) {
        (ctx as any)._viralConfigCache = fallback;
        return fallback;
      }
    },

    // v4.28 把已识别的爆款队列(ctx._viralFlushQueue)批量发到爆文库,清空队列。
    // 每个动作间隔调一次 — 任务被中断时不至于一次丢光所有识别的爆款。
    // 返 { ok, accepted, inserted, updated, dup_skip, failed, ... } — 服务端
    // 准确反馈每条入库的状态。
    flushViralQueue: async (platform: string): Promise<any> => {
      const queue = (ctx as any)._viralFlushQueue;
      if (!Array.isArray(queue) || queue.length === 0) {
        return { ok: false, reason: 'empty', queue_size: 0 };
      }
      const items = queue.splice(0); // 取出 + 同步清空,防 reentry 重复发
      try {
        const res = await (ctx as any).pushToViralLibrary({ platform, items });
        // 累计 ingest 计数到 viralStats,reportViralStatus 末尾打总结时用
        if (res && (res.ok || res.accepted || res.queued)) {
          if (!(ctx as any)._viralStats) (ctx as any)._viralStats = {};
          const s = (ctx as any)._viralStats;
          s.ingested = (s.ingested || 0) + (res.accepted || res.queued || 0);
        }
        return res || { ok: false, reason: 'no_response' };
      } catch (err: any) {
        // push 失败:把 items 放回队尾,下次 flush 重试
        queue.unshift(...items);
        return { ok: false, reason: 'push_failed:' + String(err && err.message || err).slice(0, 80) };
      }
    },

    // v4.27 评估候选帖是否过爆款阈值。post 字段名按平台 normalize 取(orchestrator
    // 里 metric 字段命名各异:likes / likes_count / comment_count / replies_count …)。
    // 任一阈值字段命中算 1 hit;hit 数 ≥ min_match 即合格。字段缺失不参与评估。
    //
    // 返回 boolean。这是判"该帖是否值得入爆文库"的唯一真理来源 — 跟"该帖是否
    // 被选去回复"完全独立。
    //
    // v4.25.12 副作用:每次调用累加 ctx._viralStats(供 reportViralStatus 在 run 末
    // 打总结)。让用户看到"本次评估 N 篇,M 篇过门槛,实际入库 K 条"的可见性。
    passViralThreshold: async (post: any, platform: string): Promise<boolean> => {
      if (!(ctx as any)._viralStats) (ctx as any)._viralStats = {
        evaluated: 0, passed: 0, missed_likes: 0, missed_comments: 0, missed_views: 0,
        no_threshold: 0, no_post_data: 0,
      };
      const stats = (ctx as any)._viralStats;
      if (!post || !platform) {
        stats.no_post_data++;
        return false;
      }
      const cfg = await (ctx as any).getViralConfig();
      const t = cfg && cfg.thresholds && cfg.thresholds[platform];
      if (!t) {
        stats.no_threshold++;
        return false;
      }
      stats.evaluated++;
      const likes = Number(post.likes_count ?? post.likes ?? 0) || 0;
      const comments = Number(
        post.comments_count ?? post.replies_count ?? post.comment_count
        ?? post.comments ?? post.replies ?? 0
      ) || 0;
      const views = Number(post.views_count ?? post.views ?? 0) || 0;
      let hits = 0;
      if (t.min_likes != null    && likes    >= t.min_likes)    hits++;
      else if (t.min_likes != null) stats.missed_likes++;
      if (t.min_comments != null && comments >= t.min_comments) hits++;
      else if (t.min_comments != null) stats.missed_comments++;
      if (t.min_views != null    && views    >= t.min_views)    hits++;
      else if (t.min_views != null) stats.missed_views++;
      const need = (typeof t.min_match === 'number' && t.min_match > 0) ? t.min_match : 1;
      const pass = hits >= need;
      if (pass) stats.passed++;
      return pass;
    },

    // v4.25.12 在 run 末尾汇总打一条总结 — 不管是否有爆款入库,用户都能看到
    // "本次爆文库到底干了啥"。每个 orchestrator 在 step 3 写报告前调一次。
    reportViralStatus: async (platform: string, stepNum?: number): Promise<void> => {
      const stats = (ctx as any)._viralStats;
      const step = (stepNum && stepNum > 0) ? stepNum : (ctx._currentStep || 3);
      // 拉服务端阈值显示出来,让用户看到门槛是多少
      let thresholdLine = '';
      try {
        const cfg = await (ctx as any).getViralConfig();
        const t = cfg && cfg.thresholds && cfg.thresholds[platform];
        if (t) {
          const parts: string[] = [];
          if (t.min_likes != null) parts.push('赞≥' + t.min_likes);
          if (t.min_comments != null) parts.push('评论≥' + t.min_comments);
          if (t.min_views != null) parts.push('浏览≥' + t.min_views);
          thresholdLine = '门槛: ' + parts.join(' OR ') + ' (任 ' + (t.min_match || 1) + ' 项)';
        }
      } catch (_) {}

      if (!stats || stats.evaluated === 0) {
        progress.stepLog(step, 'running',
          '📊 爆文库[' + platform + ']: 本次未评估任何候选(可能 feed 没读到帖子或 metric 全缺)'
          + (thresholdLine ? ' · ' + thresholdLine : ''));
        return;
      }
      progress.stepLog(step, 'running',
        '📊 爆文库[' + platform + ']: 评估 ' + stats.evaluated + ' 篇 · 过门槛 ' + stats.passed + ' 篇'
        + (thresholdLine ? ' · ' + thresholdLine : ''));
      if (stats.passed === 0 && stats.evaluated > 0) {
        // 帮用户理解为啥都没过
        const missLines: string[] = [];
        if (stats.missed_likes > 0) missLines.push('赞不够 ' + stats.missed_likes + ' 篇');
        if (stats.missed_comments > 0) missLines.push('评论不够 ' + stats.missed_comments + ' 篇');
        if (stats.missed_views > 0) missLines.push('浏览不够 ' + stats.missed_views + ' 篇');
        if (missLines.length > 0) {
          progress.stepLog(step, 'running', '   原因: ' + missLines.join(' / '));
        }
      }
    },

    // v4.25+: ingest 当次抓到的原文 + 原图到爆文库(三平台共享池)。
    // payload 形式:
    //   ctx.pushToViralLibrary({ platform: 'x'|'xhs'|'binance', items: [
    //     {
    //       source_id: string,        // 必填,平台内唯一(tweet_id / note_id / post_id)
    //       source_url: string,
    //       title?: string,           // 推特/币安没有标题,可省
    //       content: string,          // 必填,正文
    //       author?: string,          // 显示名
    //       author_handle?: string,   // @handle / 个人页 slug
    //       image_base64s?: string[], // 后端会用 sharp 压到 ≤300KB 再传 R2
    //       posted_at?: number|string,
    //       views?: number, likes?: number, replies?: number,
    //     }
    //   ]})
    // 后端会:
    //   - 过滤政治/暴力/血腥/色情命中条目
    //   - sanitize + 参数化入库防注入
    //   - 单条最多 4 张图,每张压到 ≤300KB
    //   - 一次最多 ingest 5 条(配置在 /api/viral/library/config)
    //   - 重复 source_id 只更新 metrics 不覆盖正文/图
    pushToViralLibrary: async (payload: { platform: 'x' | 'xhs' | 'binance'; items: any[] }) => {
      if (!payload || !payload.platform || !Array.isArray(payload.items) || payload.items.length === 0) {
        return { ok: false, reason: 'invalid_payload' };
      }
      const authToken = getNoobClawAuthToken();
      if (!authToken) {
        coworkLog('INFO', 'phaseRunner', 'pushToViralLibrary skipped (no auth token)');
        return { ok: false, reason: 'no_auth_token' };
      }

      // v4.25.3 (C):客户端预压缩 base64 — 把每张图压到 ≤300KB 再上传,
      // body 体积 5-20x 缩水(慢网用户上传时间从分钟级降到秒级)。
      // 服务端 sharp 检测 buf.length 已 ≤target 会跳过二次压缩。
      try {
        const sharp = require('sharp');
        const TARGET_KB = 300;
        const MAX_DIM = 1600;
        for (const item of payload.items) {
          if (!Array.isArray(item.image_base64s)) continue;
          for (let bi = 0; bi < item.image_base64s.length; bi++) {
            const b64 = item.image_base64s[bi];
            if (typeof b64 !== 'string' || b64.length === 0) continue;
            try {
              const buf = Buffer.from(b64, 'base64');
              if (buf.length <= TARGET_KB * 1024) continue; // 已经够小
              let pipeline = sharp(buf, { failOn: 'error' }).rotate();
              const meta = await pipeline.metadata().catch((): any => null);
              if (!meta || !meta.width || !meta.height) continue;
              const longest = Math.max(meta.width, meta.height);
              if (longest > MAX_DIM) {
                pipeline = pipeline.resize({
                  width: meta.width >= meta.height ? MAX_DIM : undefined,
                  height: meta.height > meta.width ? MAX_DIM : undefined,
                  fit: 'inside', withoutEnlargement: true,
                });
              }
              let qLo = 30, qHi = 90;
              let best: Buffer | null = null;
              for (let it = 0; it < 6; it++) {
                const q = Math.round((qLo + qHi) / 2);
                const out = await pipeline.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
                if (out.length <= TARGET_KB * 1024) { best = out; qLo = q + 1; }
                else qHi = q - 1;
                if (qLo > qHi) break;
              }
              if (!best) best = await pipeline.clone().jpeg({ quality: 30, mozjpeg: true }).toBuffer();
              item.image_base64s[bi] = Buffer.from(best).toString('base64');
            } catch (perItemErr) {
              // 单张压缩失败保留原 base64,服务端会再尝试压
              coworkLog('WARN', 'phaseRunner', 'preCompress single image failed', {
                err: String(perItemErr).slice(0, 100),
              });
            }
          }
        }
      } catch (compressErr) {
        // sharp 不可用 — 保留原 base64,服务端兜底压缩
        coworkLog('INFO', 'phaseRunner', 'preCompress unavailable, sending raw', {
          err: String(compressErr).slice(0, 100),
        });
      }

      // v4.25.3 (B):AbortController 30s 超时 — 弱网用户最坏 30s 而不是无限 hang
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const baseUrl = 'https://api.noobclaw.com';
        const resp = await fetch(baseUrl + '/api/viral/library/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            platform: payload.platform,
            items: payload.items,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        // v4.25.3 (A):服务端现在异步处理,立即返回 202 + queued 数。
        // 200(老服务端)和 202(新服务端)都视为 OK。
        if (!resp.ok && resp.status !== 202) {
          const errText = await resp.text().catch(() => '');
          coworkLog('WARN', 'phaseRunner', 'pushToViralLibrary http error', {
            status: resp.status, body: errText.slice(0, 200),
          });
          return { ok: false, reason: 'http_' + resp.status };
        }
        const data = await resp.json().catch(() => ({}));
        coworkLog('INFO', 'phaseRunner', 'pushToViralLibrary ok', {
          accepted: data.accepted, queued: data.queued, items: data.items?.length,
        });
        return {
          ok: true,
          accepted: data.accepted || 0,
          queued: data.queued || 0,
          items: data.items || [],
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError' ? 'timeout_30s' : String(err).slice(0, 200);
        coworkLog('WARN', 'phaseRunner', 'pushToViralLibrary failed', { err: msg });
        return { ok: false, reason: msg };
      }
    },

    // v4.25.4: 50% 概率从爆文库挑文章给 post_creator 改写。
    // 服务端按当前钱包过滤,排除已用过的(基于 viral_library.used_by_wallets 数组)。
    // 返回 { ok: true, item: {...} } 或 { ok: false, reason: '...' }
    pickFromViralLibrary: async (
      platform: 'x' | 'xhs' | 'binance',
      opts?: { category?: string }
    ) => {
      const authToken = getNoobClawAuthToken();
      if (!authToken) return { ok: false, reason: 'no_auth_token' };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const baseUrl = 'https://api.noobclaw.com';
        const qs = new URLSearchParams({ platform });
        if (opts?.category) qs.set('category', opts.category);
        const resp = await fetch(baseUrl + '/api/viral/library/pick?' + qs.toString(), {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${authToken}` },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) return { ok: false, reason: 'http_' + resp.status };
        const data = await resp.json().catch(() => ({}));
        return data;
      } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError' ? 'timeout_15s' : String(err).slice(0, 200);
        coworkLog('WARN', 'phaseRunner', 'pickFromViralLibrary failed', { err: msg });
        return { ok: false, reason: msg };
      }
    },

    // v4.25.6: 推特视频搬运 — 通过 Twitter Syndication API 拿真链 mp4
    // 端点 https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<rand>
    // 是 Twitter 给第三方 embed 用的公开端点,无需 cookie / 无需登录。
    // 返回 mediaDetails[].video_info.variants 含多档 mp4 直链。
    //
    // 实测(2026-04-27): tweet 2048339856938696725 拿到 720x1280 mp4,
    // 1 MB 文件 0.6s 下完。
    //
    // 不存任何 binary,只存到任务输出目录。caller 拿 filePath 后自己决定干啥
    // (本地审计 / 上传到币安/推特 / 走爆文库等)。
    fetchTweetVideo: async (
      tweetUrl: string,
      opts?: { outputDir?: string; preferQuality?: 'highest' | 'lowest' | 'medium' }
    ) => {
      try {
        // 1) 抽 status_id
        const m = String(tweetUrl || '').match(/(?:twitter|x)\.com\/[^\/]+\/status\/(\d+)/i);
        if (!m) return { ok: false, reason: 'invalid_tweet_url' };
        const statusId = m[1];

        // 2) 调 syndication API,加重试 —— Twitter 端偶发 503 / rate-limit / 网络瞬断,
        //    用户报"有时候又行"。3 次重试 + 指数退避 (1s/2s/4s) 把成功率从 ~50% 提到 95%+。
        //    每次失败的 status code / 错误打 log 方便用户在 cowork.log 里看根因。
        let meta: any = null;
        let lastErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          const token = Math.random().toString(36).slice(2, 14);
          const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${token}`;
          const apiCtl = new AbortController();
          const apiTo = setTimeout(() => apiCtl.abort(), 8000); // 8s/次,3 次共 ~24s + 退避
          try {
            const apiResp = await fetch(apiUrl, {
              method: 'GET',
              headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0', 'Accept': 'application/json' },
              signal: apiCtl.signal,
            });
            clearTimeout(apiTo);
            if (!apiResp.ok) {
              lastErr = 'http_' + apiResp.status;
              coworkLog('WARN', 'phaseRunner', `fetchTweetVideo Syndication 失败 attempt=${attempt}/3 status=${apiResp.status} statusId=${statusId}`);
              if (apiResp.status >= 500 || apiResp.status === 429) {
                if (attempt < 3) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
              }
              return { ok: false, reason: 'syndication_http_' + apiResp.status };
            }
            meta = await apiResp.json().catch(() => null);
            if (meta) break;
            lastErr = 'json_parse_failed';
          } catch (e: any) {
            clearTimeout(apiTo);
            lastErr = String(e?.message || e).slice(0, 80);
            coworkLog('WARN', 'phaseRunner', `fetchTweetVideo Syndication 网络异常 attempt=${attempt}/3 err=${lastErr} statusId=${statusId}`);
            if (attempt < 3) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
            return { ok: false, reason: 'syndication_failed:' + lastErr };
          }
        }
        if (!meta) return { ok: false, reason: 'syndication_no_meta:' + lastErr };
        if (meta.__typename === 'TweetTombstone') {
          return { ok: false, reason: 'tweet_unavailable' };
        }

        // 3) 找视频 + 选 mp4 variant
        const mediaList: any[] = Array.isArray(meta.mediaDetails) ? meta.mediaDetails : [];
        const videoMedia = mediaList.find((it: any) => it && it.type === 'video');
        if (!videoMedia) return { ok: false, reason: 'no_video' };

        const variants: Array<{ content_type: string; bitrate?: number; url: string }>
          = videoMedia.video_info?.variants || [];
        const mp4Variants = variants
          .filter(v => v && v.content_type === 'video/mp4' && typeof v.url === 'string')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4Variants.length === 0) {
          return { ok: false, reason: 'no_mp4_variant', hls_url: variants.find(v => v.content_type === 'application/x-mpegURL')?.url };
        }

        const pref = opts?.preferQuality || 'highest';
        const chosen = pref === 'highest' ? mp4Variants[0]
          : pref === 'lowest' ? mp4Variants[mp4Variants.length - 1]
          : mp4Variants[Math.floor(mp4Variants.length / 2)];

        // 4) 下载视频字节
        const dlCtl = new AbortController();
        const dlTo = setTimeout(() => dlCtl.abort(), 5 * 60 * 1000); // 5 min for big videos
        let videoBuf: Buffer;
        try {
          const vResp = await fetch(chosen.url, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0' },
            signal: dlCtl.signal,
          });
          clearTimeout(dlTo);
          if (!vResp.ok) return { ok: false, reason: 'video_download_http_' + vResp.status };
          const ab = await vResp.arrayBuffer();
          videoBuf = Buffer.from(ab);
        } catch (e: any) {
          clearTimeout(dlTo);
          return { ok: false, reason: 'video_download_failed:' + String(e?.message || e).slice(0, 80) };
        }

        // 5) 写本地 — 默认任务目录,subdir = '原文'
        const dir = opts?.outputDir || path.join(getTaskOutputDir(task, manifest.platform as any), '原文');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const videoFile = path.join(dir, `源视频_${statusId}.mp4`);
        fs.writeFileSync(videoFile, videoBuf);

        // 6) 顺手下封面图(poster) — 失败不阻塞
        let posterFile: string | null = null;
        const posterUrl = videoMedia.media_url_https || '';
        if (posterUrl) {
          try {
            const pResp = await fetch(posterUrl, { method: 'GET' });
            if (pResp.ok) {
              const pAb = await pResp.arrayBuffer();
              const ext = posterUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || 'jpg';
              posterFile = path.join(dir, `源视频封面_${statusId}.${ext}`);
              fs.writeFileSync(posterFile, Buffer.from(pAb));
            }
          } catch { /* poster 失败不阻塞 */ }
        }

        const orig = videoMedia.original_info || {};
        coworkLog('INFO', 'phaseRunner', 'fetchTweetVideo ok', {
          statusId, size: videoBuf.length, bitrate: chosen.bitrate, file: videoFile,
        });
        return {
          ok: true,
          statusId,
          filePath: videoFile,
          posterPath: posterFile,
          videoUrl: chosen.url,                       // 原始 mp4 直链(给爆文库存)
          posterUrl: posterUrl || null,
          size: videoBuf.length,
          duration: videoMedia.video_info?.duration_millis || 0,
          width: orig.width || 0,
          height: orig.height || 0,
          bitrate: chosen.bitrate || 0,
          contentType: 'video/mp4',
        };
      } catch (err: any) {
        coworkLog('WARN', 'phaseRunner', 'fetchTweetVideo unexpected error', { err: String(err) });
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // v4.25.6 Phase 2: 推特视频搬运 — 上传链路
    //
    // 把本地 mp4 文件通过 sidecar 临时 HTTP 端点喂给浏览器扩展,扩展 fetch
    // 拿到 blob 后构造 File 对象注入到 input[type=file]。整个流程不走
    // native messaging base64 IPC,大文件(几十 MB 视频)无压力。
    //
    // 内部用法:registerFile() → upload_file_from_url 命令 → unregister。
    // 上层应封装 publishVideoToBinance / publishVideoToTwitter 两个 helper
    // 包含完整的 modal 流程。
    uploadVideoFromDisk: async (
      filePath: string,
      opts: {
        targetSelector: string;       // file input CSS selector
        fileName?: string;
        mimeType?: string;
        ttlMs?: number;
      }
    ) => {
      try {
        const { registerFile, buildUrl, unregister } = require('../localFileServer');
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
          return { ok: false, reason: 'file_not_found' };
        }
        const fileName = opts.fileName || require('path').basename(filePath);
        const token = registerFile(filePath, {
          mimeType: opts.mimeType,
          fileName,
          ttlMs: opts.ttlMs || 5 * 60 * 1000,
        });
        // sidecar 端口 — 跟 sidecar-server.ts 里的 PORT 同步,默认 18800
        const port = parseInt(process.env.NOOBCLAW_SIDECAR_PORT || '18800', 10);
        const fileUrl = buildUrl(token, port);
        try {
          // v1.2.17 bug fix: 老代码把 getBridgeOpts() 当 timeoutMs 传(setTimeout
          // 拿到对象 → 立刻触发"timed out after [object Object]ms")。
          // 现在显式传 ttlMs(默认 5 min)做 timeout,getBridgeOpts() 走第 4 参 options。
          const uploadTimeout = opts.ttlMs || 5 * 60 * 1000;
          const r = await sendBrowserCommand('upload_file_from_url', {
            selector: opts.targetSelector,
            fileUrl,
            fileName,
            mimeType: opts.mimeType,
          }, uploadTimeout, getBridgeOpts());
          // 不 unregister(让 TTL 兜底),浏览器有时会重 fetch
          return r;
        } catch (err: any) {
          unregister(token); // 失败时立即清掉
          return { ok: false, reason: 'upload_command_failed:' + String(err?.message || err).slice(0, 100) };
        }
      } catch (err: any) {
        coworkLog('WARN', 'phaseRunner', 'uploadVideoFromDisk failed', { err: String(err) });
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // v4.25.6 Phase 2: 完整发视频帖到币安广场 — 整合 modal 流程。
    // 跟图片帖完全不同:点视频图标 → 弹 quote-mode modal → 在 modal 内
    // upload + 写正文 → 发文。
    //
    // 用户实测 DOM:
    //   - 工具栏视频图标 SVG path d 头部 "M8.6 8.883" (用 :has 锁)
    //   - 弹出 modal class: .short-editor-inner.quote-mode
    //   - modal 内 file input: accept 含 mp4 的 input
    //   - modal 内 ProseMirror: 正文输入
    //   - 发文按钮: button 含 "发文" 文本,默认带 .inactive 类
    //
    // 限制(币安实测): 时长 ≤ 10 min, 大小 ≤ 200 MB,11 种格式
    //
    // 调用前提: 当前 active tab 已经在 binance.com/square 且 inline 编辑器可见
    publishVideoToBinance: async (videoFilePath: string, content: string, opts?: {
      uploadTimeoutMs?: number;       // 视频上传等待上限,默认 3 min
      publishRetries?: number;         // "发文"按钮 polling 重试,默认 6
    }) => {
      const log = (msg: string) => ctx.report('   ' + msg);
      const uploadTimeout = opts?.uploadTimeoutMs || 3 * 60 * 1000;
      const publishRetries = opts?.publishRetries || 6;

      try {
        // ── Step 1: 点工具栏视频图标 → 等 modal 出现 ──
        log('🎬 点视频图标 → 等弹出 modal...');
        const videoIconSel = '.icon-box:has(svg path[d^="M8.6 8.883"])';
        try {
          await sendBrowserCommand('main_world_click', { selector: videoIconSel }, getBridgeOpts());
        } catch (e: any) {
          return { ok: false, reason: 'video_icon_click_failed:' + String(e?.message || e).slice(0, 80) };
        }
        // 等 modal 出现 (最多 6 秒)
        const modalSel = '.short-editor-inner.quote-mode';
        let modalReady = false;
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const r = await sendBrowserCommand('query_selector', { selector: modalSel, limit: 1 }, getBridgeOpts());
            const els = (r && (r as any).elements) || ((r as any)?.data?.elements) || [];
            if (els.length > 0) { modalReady = true; break; }
          } catch { /* keep polling */ }
        }
        if (!modalReady) return { ok: false, reason: 'modal_not_appearing' };
        log('✓ modal 出现');

        // ── Step 2: 上传视频文件到 modal 内的 input ──
        const fileInputSel = '.short-editor-inner.quote-mode input[type="file"][accept*="mp4"]';
        log('📤 上传视频文件 ' + videoFilePath.split(/[/\\]/).pop());
        const upR: any = await (ctx.uploadVideoFromDisk as any)(videoFilePath, {
          targetSelector: fileInputSel,
          mimeType: 'video/mp4',
        });
        if (!upR || !upR.ok) {
          return { ok: false, reason: 'video_upload_failed:' + (upR?.reason || upR?.error || 'unknown') };
        }
        log('✓ 视频字节已注入 input,等币安处理...');

        // ── Step 3: polling 等"发文"按钮变 active(视频上传 + 转码完成的信号) ──
        const publishBtnSel = '.short-editor-inner.quote-mode button';
        let publishReady = false;
        const startWait = Date.now();
        let lastBtnTexts = '';
        while (Date.now() - startWait < uploadTimeout) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const r = await sendBrowserCommand('query_selector', {
              selector: publishBtnSel, limit: 5, attrs: 'class',
            }, getBridgeOpts());
            const els = (r && (r as any).elements) || ((r as any)?.data?.elements) || [];
            const btns = els as Array<{ text?: string; class?: string }>;
            lastBtnTexts = btns.map(b => `[${b.text || ''}|${(b.class || '').slice(0, 30)}]`).join(' ');
            // 找文本为"发文"且 class 不含 inactive 的
            const ready = btns.find(b => /^发文$/.test((b.text || '').trim()) && !/inactive/.test(b.class || ''));
            if (ready) { publishReady = true; break; }
          } catch { /* keep polling */ }
          // 心跳
          if ((Date.now() - startWait) % 30000 < 1500) {
            log('⏳ 等视频处理中... ' + Math.round((Date.now() - startWait) / 1000) + 's');
          }
        }
        if (!publishReady) {
          return { ok: false, reason: 'publish_btn_never_active', detail: '上传超时 / 视频处理失败 / 按钮文案变了 — 末次按钮: ' + lastBtnTexts.slice(0, 200) };
        }
        log('✓ 视频处理完成,发文按钮已激活');

        // ── Step 4: 写正文到 modal 内 ProseMirror ──
        const editorSel = '.short-editor-inner.quote-mode .ProseMirror[contenteditable="true"]';
        log('✏️ 写入正文(' + content.length + ' 字符)...');
        try {
          await sendBrowserCommand('main_world_click', { selector: editorSel }, getBridgeOpts());
          await new Promise(r => setTimeout(r, 400));
          const ir: any = await sendBrowserCommand('editor_insert_text', {
            selector: editorSel, text: content,
          }, getBridgeOpts());
          if (!ir || (!ir.ok && ir.error)) {
            return { ok: false, reason: 'editor_insert_failed:' + (ir?.error || 'unknown') };
          }
        } catch (e: any) {
          return { ok: false, reason: 'editor_failed:' + String(e?.message || e).slice(0, 80) };
        }

        // ── Step 5: 点"发文"按钮 ──
        // 用 click_with_text 在 modal 容器范围内精准匹配 "发文" 文本
        log('🚀 点击 [发文] ...');
        let published = false;
        for (let attempt = 0; attempt < publishRetries; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
          try {
            const r: any = await sendBrowserCommand('click_with_text', {
              containerSel: modalSel,
              acceptedTexts: ['发文', '发布', 'Post', 'Publish'],
              opts: { fuzzy: true, skipInactive: true, returnDebug: true },
            }, getBridgeOpts());
            if (r?.ok) { published = true; break; }
            if (r?.error && !/inactive/.test(r.error)) break;
          } catch { /* retry */ }
        }
        if (!published) {
          return { ok: false, reason: 'publish_click_failed' };
        }

        // ── Step 6: 等 modal 关闭(发文成功的信号) ──
        let modalClosed = false;
        const closeWait = Date.now();
        while (Date.now() - closeWait < 15000) {
          await new Promise(r => setTimeout(r, 800));
          try {
            const r = await sendBrowserCommand('query_selector', { selector: modalSel, limit: 1 }, getBridgeOpts());
            const els = (r && (r as any).elements) || ((r as any)?.data?.elements) || [];
            if (els.length === 0) { modalClosed = true; break; }
          } catch { /* keep polling */ }
        }
        if (!modalClosed) {
          // 假设成功 — modal 偶尔残留,日志里 warn
          coworkLog('WARN', 'phaseRunner', 'publishVideoToBinance: modal lingered after publish click');
        }
        return { ok: true, modalClosed };
      } catch (err: any) {
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // v4.25.6 Phase 3: 直接 mp4 URL → 落本地任务目录。给 viral 库 pick
    // 路径用(库里存的就是 syndication 拿到的 mp4 直链,不需要再过一次
    // syndication API)。
    //
    // 跟 fetchTweetVideo 区别:那个吃 tweet URL,内部走 syndication;
    // 这个吃直接 mp4 URL,纯 fetch + 写盘。
    downloadVideoToDisk: async (
      videoUrl: string,
      opts?: { outputDir?: string; fileName?: string; posterUrl?: string }
    ) => {
      try {
        if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
          return { ok: false, reason: 'invalid_video_url' };
        }
        const dlCtl = new AbortController();
        const dlTo = setTimeout(() => dlCtl.abort(), 5 * 60 * 1000);
        let videoBuf: Buffer;
        try {
          const vResp = await fetch(videoUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0' },
            signal: dlCtl.signal,
          });
          clearTimeout(dlTo);
          if (!vResp.ok) return { ok: false, reason: 'video_http_' + vResp.status };
          const ab = await vResp.arrayBuffer();
          videoBuf = Buffer.from(ab);
        } catch (e: any) {
          clearTimeout(dlTo);
          return { ok: false, reason: 'video_fetch_failed:' + String(e?.message || e).slice(0, 80) };
        }
        const dir = opts?.outputDir || path.join(getTaskOutputDir(task, manifest.platform as any), '原文');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const baseName = opts?.fileName
          || ('viral_video_' + Date.now() + '.mp4');
        const filePath = path.join(dir, baseName);
        fs.writeFileSync(filePath, videoBuf);
        // 顺手下封面图(如有)
        let posterFile: string | null = null;
        if (opts?.posterUrl) {
          try {
            const pResp = await fetch(opts.posterUrl);
            if (pResp.ok) {
              const pAb = await pResp.arrayBuffer();
              const ext = (opts.posterUrl.split('.').pop() || 'jpg').split('?')[0].toLowerCase();
              posterFile = filePath.replace(/\.mp4$/, '_poster.' + ext);
              fs.writeFileSync(posterFile, Buffer.from(pAb));
            }
          } catch { /* poster 失败不阻塞 */ }
        }
        return { ok: true, filePath, posterPath: posterFile, size: videoBuf.length };
      } catch (err: any) {
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // v4.25.6 Phase 2: 推特 compose 视频上传 — 比币安简单,
    // [data-testid="fileInput"] 同时接图和视频(mp4 直接传)。
    //
    // 调用前提: 当前 active tab 已经在 x.com/compose/post 或 inline reply
    // 编辑器已展开,SEL_COMPOSE_TEXTAREA 已 focused/已写正文。
    //
    // 这个 helper 只管"上传视频字节 + 等转码完成",不管点提交按钮(交给
    // 调用方 — orchestrator 已经有自己的提交按钮 polling 逻辑)。
    uploadVideoToTwitter: async (videoFilePath: string, opts?: {
      processingWaitMs?: number;       // 等推特处理视频的时间,默认 60s
    }) => {
      const log = (msg: string) => ctx.report('   ' + msg);
      const waitMs = opts?.processingWaitMs || 60000;

      try {
        // Twitter compose 的 file input,既接图又接视频
        const fileInputSel = 'input[data-testid="fileInput"], input[type="file"][accept*="image"], input[type="file"]';
        log('📤 上传视频到推特 compose ...');
        const upR: any = await (ctx.uploadVideoFromDisk as any)(videoFilePath, {
          targetSelector: fileInputSel,
          mimeType: 'video/mp4',
        });
        if (!upR || !upR.ok) {
          return { ok: false, reason: 'video_upload_failed:' + (upR?.reason || upR?.error || 'unknown') };
        }

        // 等推特服务端转码 — 简单 wait,推特没有显眼的"处理完成"DOM 信号,
        // 比起在 DOM 里 polling 不如等一段固定时间(视频越大越久)。
        log('⏳ 等推特处理视频 ' + Math.round(waitMs / 1000) + 's...');
        await new Promise(r => setTimeout(r, waitMs));
        return { ok: true };
      } catch (err: any) {
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // 发文成功后调,服务端把当前钱包追加到 viral_library.used_by_wallets,
    // 下次同钱包不会再选中这篇。
    markViralUsed: async (viralId: string) => {
      const authToken = getNoobClawAuthToken();
      if (!authToken) return { ok: false, reason: 'no_auth_token' };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const baseUrl = 'https://api.noobclaw.com';
        const resp = await fetch(baseUrl + '/api/viral/library/mark-used', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ viral_id: viralId }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) return { ok: false, reason: 'http_' + resp.status };
        return await resp.json().catch(() => ({ ok: true }));
      } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError' ? 'timeout_10s' : String(err).slice(0, 200);
        coworkLog('WARN', 'phaseRunner', 'markViralUsed failed', { err: msg });
        return { ok: false, reason: msg };
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
