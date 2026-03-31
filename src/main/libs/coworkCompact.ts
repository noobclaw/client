/**
 * Context compaction module — ported from Claude Code's compact system.
 *
 * When a conversation exceeds a token threshold, this module summarizes the
 * entire history into a structured summary using the same model, then replaces
 * the old messages with the summary so the conversation can continue without
 * losing important context.
 */

import { coworkLog } from './coworkLogger';

// ── Compact prompt (ported verbatim from Claude Code prompts.ts) ──────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const POST_COMPACT_USER_MESSAGE = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.`;

// ── Rough token estimation ────────────────────────────────────────────────

/**
 * Estimate token count from a string.
 * Rough heuristic: ~4 chars per token for English, ~2 for CJK.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4 + cjkCount / 1.5);
}

function estimateMessagesTokens(messages: Array<{ content?: string; type?: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || '');
    total += 4; // message framing overhead
  }
  return total;
}

// ── Compact summary formatting ────────────────────────────────────────────

/**
 * Strip the <analysis> scratchpad block from the compact result,
 * keeping only the <summary> content.
 */
function formatCompactSummary(rawOutput: string): string {
  // Remove <analysis>...</analysis> block
  let cleaned = rawOutput.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  // Extract content from <summary> tags if present
  const summaryMatch = cleaned.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    cleaned = summaryMatch[1].trim();
  }
  return cleaned;
}

// ── Compaction trigger check ──────────────────────────────────────────────

export interface CompactConfig {
  /** Context window size in tokens (default: model-dependent, fallback 128000) */
  contextWindowSize?: number;
  /** Max output tokens reserved (default: 16384) */
  maxOutputTokens?: number;
  /** Buffer before triggering compact (default: 13000) */
  bufferTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 16_384;
const DEFAULT_BUFFER = 13_000;

/**
 * Check whether compaction should be triggered based on estimated token usage.
 */
export function shouldCompact(
  messages: Array<{ content?: string; type?: string }>,
  config: CompactConfig = {}
): boolean {
  const contextWindow = config.contextWindowSize || DEFAULT_CONTEXT_WINDOW;
  const maxOutput = config.maxOutputTokens || DEFAULT_MAX_OUTPUT;
  const buffer = config.bufferTokens || DEFAULT_BUFFER;

  const currentTokens = estimateMessagesTokens(messages);
  const threshold = contextWindow - maxOutput - buffer;

  coworkLog('INFO', 'shouldCompact', `tokens≈${currentTokens} threshold=${threshold}`);
  return currentTokens > threshold;
}

// ── Build compact request ─────────────────────────────────────────────────

export interface CompactRequest {
  systemPrompt: string;
  userMessage: string;
}

/**
 * Build the prompt pair for a compaction API call.
 * The conversation history should be passed as prior assistant/user messages
 * in the API call; this function returns the final user message that triggers
 * the summary.
 */
export function buildCompactRequest(): CompactRequest {
  return {
    systemPrompt: 'You are a helpful assistant that summarizes conversations accurately and thoroughly.',
    userMessage: NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT,
  };
}

// ── Format the compacted summary for injection ────────────────────────────

/**
 * Given the raw model output from a compact call, produce a clean summary
 * string suitable for injection as conversation history.
 */
export function processCompactResult(rawOutput: string): string {
  const summary = formatCompactSummary(rawOutput);
  return `${POST_COMPACT_USER_MESSAGE}\n\nSummary:\n${summary}`;
}

// ── Perform compaction via direct Anthropic API call ───────────────────────

export interface CompactOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  config?: CompactConfig;
}

/**
 * Execute a compaction call using the Anthropic Messages API.
 * Returns the formatted summary string, or null on failure.
 *
 * Circuit breaker: caller should track consecutive failures and stop
 * retrying after 3.
 */
export async function executeCompact(options: CompactOptions): Promise<string | null> {
  const { apiKey, model, baseURL, messages } = options;

  if (!apiKey || !messages || messages.length === 0) {
    coworkLog('WARN', 'executeCompact', 'Missing apiKey or messages');
    return null;
  }

  const compactReq = buildCompactRequest();

  // Build the API request: conversation history + compact instruction
  const apiMessages = [
    ...messages,
    { role: 'user' as const, content: compactReq.userMessage },
  ];

  try {
    coworkLog('INFO', 'executeCompact', `Compacting ${messages.length} messages with model ${model}`);

    const url = `${baseURL || 'https://api.anthropic.com'}/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: compactReq.systemPrompt,
        messages: apiMessages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      coworkLog('ERROR', 'executeCompact', `API error: ${response.status} ${errorText.slice(0, 500)}`);
      return null;
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text;
    if (!rawText) {
      coworkLog('ERROR', 'executeCompact', 'No text in API response');
      return null;
    }

    const result = processCompactResult(rawText);
    coworkLog('INFO', 'executeCompact', `Compact complete: ${estimateTokens(result)} tokens summary`);
    return result;
  } catch (error) {
    coworkLog('ERROR', 'executeCompact', `Compact failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// Re-exports for convenience
export { estimateTokens, estimateMessagesTokens, POST_COMPACT_USER_MESSAGE };
