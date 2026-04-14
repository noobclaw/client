/**
 * Local Extractor — runs the scenario's extractor.md and composer.md
 * prompts against the user's own Anthropic key.
 *
 * Every call is one-shot, non-streaming, fixed system prompt. No tools,
 * no streaming, no retries beyond the single recovery on JSON parse
 * failure. Token usage is bounded: extraction ~600 tok, composition ~1500 tok.
 */

import { coworkLog } from '../coworkLogger';
import { getAnthropicClient, createMessage, type ApiConfig } from '../anthropicClient';
import { configManager } from '../configManager';
import type {
  DiscoveredNote,
  ExtractionResult,
  ComposedVariant,
  ScenarioPack,
  ScenarioTask,
} from './types';

const DEFAULT_EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_COMPOSER_MODEL = 'claude-haiku-4-5-20251001';

function getConfig(): ApiConfig {
  return {
    apiKey: configManager.get('apiKey'),
    baseUrl: configManager.get('baseURL') || undefined,
    model: configManager.get('model'),
  };
}

function getCurrentModel(): string {
  return configManager.get('model') || DEFAULT_EXTRACTOR_MODEL;
}

function extractSystemPrompt(skillBody: string): string {
  // The SKILL.md files have a SYSTEM PROMPT (send as-is) section followed
  // by the prompt text up to the next `---` ruler. Parse it out.
  const m = skillBody.match(/## SYSTEM PROMPT[^\n]*\n([\s\S]*?)\n---/);
  if (!m) return skillBody.trim();
  return m[1].trim();
}

function extractTextFromResponse(response: any): string {
  if (!response?.content || !Array.isArray(response.content)) return '';
  for (const block of response.content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

function parseJsonSafe(raw: string): any | null {
  const trimmed = raw.trim();
  // Strip ```json fences if the model added them despite instructions
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // Last-ditch: find first '{' and last '}'
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(body.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── Extract ──

export async function extract(pack: ScenarioPack, note: DiscoveredNote): Promise<ExtractionResult | null> {
  const promptText = pack.prompts?.extractor;
  if (!promptText) throw new Error('Scenario pack missing extractor prompt');

  const systemPrompt = promptText.trim();
  const userPayload = {
    title: note.title,
    body: note.body,
    hashtags: note.hashtags,
    likes: note.metrics.likes,
    comments: note.metrics.comments,
  };

  const config = getConfig();
  if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING');

  const client = getAnthropicClient(config);

  async function callOnce(): Promise<ExtractionResult | null> {
    const response = await createMessage({
      client,
      model: config.model || DEFAULT_EXTRACTOR_MODEL,
      systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      tools: [],
      maxTokens: 700,
    });
    const raw = extractTextFromResponse(response);
    return parseJsonSafe(raw) as ExtractionResult | null;
  }

  let result = await callOnce();
  if (!result) {
    coworkLog('WARN', 'localExtractor', 'extract JSON parse failed, retrying once');
    result = await callOnce();
  }

  if (!result) {
    coworkLog('WARN', 'localExtractor', 'extract failed after retry, giving up on this note', {
      post_id: note.external_post_id,
    });
    return null;
  }

  return result;
}

// ── Compose ──

const MAX_BODY_SIMILARITY = 0.7;

export async function compose(
  pack: ScenarioPack,
  task: ScenarioTask,
  extraction: ExtractionResult,
  originalBody: string
): Promise<ComposedVariant[]> {
  const promptText = pack.prompts?.composer;
  if (!promptText) throw new Error('Scenario pack missing composer prompt');

  const systemPrompt = promptText.trim();
  const userPayload = {
    extraction,
    persona: task.persona,
    keywords: task.keywords,
    variants_per_post: task.variants_per_post,
  };

  const config = getConfig();
  if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING');

  const client = getAnthropicClient(config);

  async function callOnce(): Promise<ComposedVariant[] | null> {
    const response = await createMessage({
      client,
      model: config.model || DEFAULT_COMPOSER_MODEL,
      systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      tools: [],
      maxTokens: 2000,
    });
    const raw = extractTextFromResponse(response);
    const parsed = parseJsonSafe(raw);
    if (!parsed || !Array.isArray(parsed.variants)) return null;
    return parsed.variants as ComposedVariant[];
  }

  let variants = await callOnce();
  if (!variants) {
    coworkLog('WARN', 'localExtractor', 'compose JSON parse failed, retrying once');
    variants = await callOnce();
  }

  if (!variants) return [];

  // Similarity guard: variants too close to the original body are dropped.
  const kept = variants.filter(v => {
    const sim = similarity(v.body, originalBody);
    if (sim >= MAX_BODY_SIMILARITY) {
      coworkLog('WARN', 'localExtractor', 'variant rejected by similarity guard', { sim });
      return false;
    }
    return true;
  });
  return kept;
}

// ── Similarity (character 4-gram Jaccard) ──

function ngrams(text: string, n: number): Set<string> {
  const s = new Set<string>();
  const clean = text.replace(/\s+/g, '');
  for (let i = 0; i <= clean.length - n; i++) s.add(clean.slice(i, i + n));
  return s;
}

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = ngrams(a, 4);
  const B = ngrams(b, 4);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// Quick helper for logging/telemetry elsewhere.
export function getCurrentModelName(): string {
  return getCurrentModel();
}

// ── Generic AI call (used by phaseRunner) ──

export function getApiConfig() {
  return getConfig();
}

/**
 * Call AI with explicit config (supports NoobClaw AI, Anthropic, OpenAI-compat).
 * Used by phaseRunner when the user's configured provider may not be Anthropic.
 */
export async function callAIWithConfig(apiCfg: { apiKey: string; baseURL: string; model: string; apiType?: string; isOpenAICompat?: boolean }, systemPrompt: string, userMessage: string): Promise<any | null> {
  const isOpenAI = apiCfg.apiType === 'openai' || (apiCfg as any).isOpenAICompat;

  async function callOnce(): Promise<string> {
    if (isOpenAI) {
      // OpenAI-compatible API (NoobClaw AI, OpenAI, etc.)
      const resp = await fetch(apiCfg.baseURL.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiCfg.apiKey,
        },
        body: JSON.stringify({
          model: apiCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 2000,
          temperature: 0.7,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error('AI API error ' + resp.status + ': ' + errText.slice(0, 200));
      }
      const json = await resp.json();
      return json.choices?.[0]?.message?.content || '';
    } else {
      // Anthropic API
      const client = getAnthropicClient({
        apiKey: apiCfg.apiKey,
        baseUrl: apiCfg.baseURL,
        model: apiCfg.model,
      });
      const response = await createMessage({
        client,
        model: apiCfg.model || DEFAULT_EXTRACTOR_MODEL,
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [],
        maxTokens: 2000,
      });
      return extractTextFromResponse(response);
    }
  }

  let raw = await callOnce();
  let parsed = parseJsonSafe(raw);
  if (!parsed) {
    coworkLog('WARN', 'localExtractor', 'callAIWithConfig JSON parse failed, retrying', { raw: raw.slice(0, 200) });
    raw = await callOnce();
    parsed = parseJsonSafe(raw);
  }
  return parsed;
}

/**
 * Generic AI call — sends a system prompt + user message, returns parsed JSON.
 * Used by phaseRunner's ctx.aiCall().
 */
export async function callAI(systemPrompt: string, userMessage: string): Promise<any | null> {
  const config = getConfig();
  if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING');

  const client = getAnthropicClient(config);

  const response = await createMessage({
    client,
    model: config.model || DEFAULT_EXTRACTOR_MODEL,
    systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [],
    maxTokens: 2000,
  });
  const raw = extractTextFromResponse(response);
  const parsed = parseJsonSafe(raw);

  if (!parsed) {
    // Retry once
    coworkLog('WARN', 'localExtractor', 'callAI JSON parse failed, retrying once');
    const response2 = await createMessage({
      client,
      model: config.model || DEFAULT_EXTRACTOR_MODEL,
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [],
      maxTokens: 2000,
    });
    return parseJsonSafe(extractTextFromResponse(response2));
  }

  return parsed;
}
