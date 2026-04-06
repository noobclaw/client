/**
 * Query Engine — the core agent loop that replaces claude-agent-sdk's
 * black-box query() function.
 *
 * Implements: while(true) { API call → stream → detect tool_use → execute → loop }
 *
 * Ported from OpenClaw (Claude Code) src/query.ts
 */

import type { MessageParam, ToolUseBlock, MessageStreamEvent, ContentBlock } from './anthropicClient';
import {
  getAnthropicClient,
  createMessageStream,
  createMessage,
  type ApiConfig,
} from './anthropicClient';
import type { ToolDefinition, PermissionResult, ToolContext } from './toolSystem';
import { toolsToApiSchemas } from './toolSystem';
import { executeCompact, microcompactMessages, shouldCompact } from './coworkCompact';
import { StreamingToolExecutor } from './streamingToolExecutor';
import {
  buildUserMessage,
  buildToolResultMessage,
  extractToolUseBlocks,
  normalizeMessagesForAPI,
  truncateText,
  TOOL_RESULT_MAX_CHARS,
} from './messageManager';
import { runTools, type CanUseToolFn, type ToolExecutionResult } from './toolOrchestration';
import { coworkLog } from './coworkLogger';

// ── Types ──

/** Reasons the agent loop can terminate */
export type TerminalReason =
  | 'completed'          // Model finished without tool_use
  | 'max_turns'          // Hit turn limit
  | 'aborted'            // User/signal aborted
  | 'error'              // Unrecoverable API error
  | 'prompt_too_long';   // Context overflow, recovery failed

export interface Terminal {
  reason: TerminalReason;
  error?: string;
}

/** Events yielded by the query engine to the caller (UI layer) */
export type QueryEvent =
  | { type: 'stream_event'; event: MessageStreamEvent }
  | { type: 'assistant'; message: MessageParam }
  | { type: 'tool_use'; toolUseId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError: boolean }
  | { type: 'turn_start'; turnCount: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };

/** Parameters for the query engine */
export interface QueryParams {
  /** Initial user prompt (text) */
  prompt: string;

  /** Optional image attachments */
  images?: Array<{ name: string; mimeType: string; base64Data: string }>;

  /** System prompt */
  systemPrompt: string;

  /** Prior conversation messages (for continue/multi-turn) */
  priorMessages?: MessageParam[];

  /** Available tools */
  tools: ToolDefinition[];

  /** API configuration */
  apiConfig: ApiConfig;

  /** Working directory */
  cwd: string;

  /** Session ID */
  sessionId: string;

  /** Abort signal */
  abortSignal?: AbortSignal;

  /** Permission callback */
  canUseTool: CanUseToolFn;

  /** Max turns before stopping (default: 100) */
  maxTurns?: number;

  /** Callback when a tool result is ready (for real-time UI) */
  onToolResult?: (result: ToolExecutionResult) => void;
}

// ── Internal state ──
// Reference: OpenClaw src/query.ts State type

interface QueryState {
  messages: MessageParam[];
  turnCount: number;
  maxOutputTokensRecoveryCount: number;
}

// ── Constants ──

const DEFAULT_MAX_TURNS = 100;
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const DEFAULT_MAX_TOKENS = 16384;
const ESCALATED_MAX_TOKENS = 65536;

// ── Main query loop ──

/**
 * The core agent loop (non-streaming version).
 * @deprecated Use queryLoopStreaming instead — this version does not yield stream events.
 */
export async function* queryLoop(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const {
    prompt,
    images,
    systemPrompt,
    priorMessages,
    tools,
    apiConfig,
    cwd,
    sessionId,
    abortSignal,
    canUseTool,
    onToolResult,
  } = params;

  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const client = getAnthropicClient(apiConfig);
  const apiTools = toolsToApiSchemas(tools);

  // Initialize state
  const userMessage = buildUserMessage(prompt, images?.map(i => ({
    mimeType: i.mimeType,
    base64Data: i.base64Data,
  })));

  let state: QueryState = {
    messages: [...(priorMessages || []), userMessage],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
  };

  coworkLog('INFO', 'queryEngine', 'Starting agent loop', {
    sessionId,
    model: apiConfig.model,
    toolCount: tools.length,
    maxTurns,
    priorMessageCount: priorMessages?.length || 0,
  });

  // ── Main loop ──
  // Reference: OpenClaw src/query.ts line 307 while(true)

  while (true) {
    // Check abort
    if (abortSignal?.aborted) {
      coworkLog('INFO', 'queryEngine', 'Aborted before API call');
      return { reason: 'aborted' };
    }

    // Check max turns
    if (state.turnCount >= maxTurns) {
      coworkLog('WARN', 'queryEngine', `Max turns reached: ${maxTurns}`);
      return { reason: 'max_turns' };
    }

    state.turnCount++;
    yield { type: 'turn_start', turnCount: state.turnCount };

    coworkLog('INFO', 'queryEngine', `Turn ${state.turnCount}: ${state.messages.length} messages, calling API`);

    // ── Phase 1: Normalize messages ──
    const messagesForQuery = normalizeMessagesForAPI(state.messages);

    // ── Phase 2: API call with streaming ──
    // Reference: OpenClaw src/query.ts line 659

    let assistantContentBlocks: Array<Record<string, unknown>> = [];
    let toolUseBlocks: ToolUseBlock[] = [];
    let needsFollowUp = false;
    let stopReason: string | null = null;
    let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;

    const maxTokens = state.maxOutputTokensRecoveryCount > 0
      ? ESCALATED_MAX_TOKENS
      : (apiConfig.maxTokens ?? DEFAULT_MAX_TOKENS);

    try {
      const stream = await createMessageStream({
        client,
        model: apiConfig.model,
        systemPrompt,
        messages: messagesForQuery,
        tools: apiTools,
        maxTokens,
        thinkingBudget: apiConfig.thinkingBudget,
        signal: abortSignal,
      });

      // ── Phase 3: Stream processing ──
      // Reference: OpenClaw src/query.ts line 659-863

      // Use the stream's event emitter pattern
      const finalMessage = await stream.finalMessage();

      // Extract content blocks from the final message
      for (const block of finalMessage.content) {
        assistantContentBlocks.push(block as unknown as Record<string, unknown>);

        if (block.type === 'tool_use') {
          toolUseBlocks.push(block as ToolUseBlock);
          needsFollowUp = true;
        }
      }

      stopReason = finalMessage.stop_reason;
      usage = finalMessage.usage as typeof usage;

      // Yield streaming events for UI
      // We forward the raw stream events so the existing handleStreamEvent can process them
      // But since we consumed the stream via finalMessage(), we emit the assembled result
      // The caller should use the 'assistant' event type for the complete message

    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      // Check for abort
      if (abortSignal?.aborted) {
        return { reason: 'aborted' };
      }

      // ── Phase 4: Error recovery ──
      // Reference: OpenClaw src/query.ts lines 1062-1242

      // Prompt too long (413)
      if (errMsg.includes('prompt is too long') || errMsg.includes('413') || errMsg.includes('prompt_too_long')) {
        coworkLog('ERROR', 'queryEngine', 'Prompt too long error', { messageCount: messagesForQuery.length });
        // TODO: Implement context compaction and retry
        // For now, return error
        return { reason: 'prompt_too_long', error: errMsg };
      }

      // Rate limit — if we reach here, SDK retries were exhausted
      if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
        coworkLog('ERROR', 'queryEngine', 'Rate limit error (SDK retries exhausted)');
      }

      coworkLog('ERROR', 'queryEngine', `API error: ${errMsg}`);
      return { reason: 'error', error: errMsg };
    }

    // Yield usage info
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      };
    }

    // Build the assistant message for conversation history
    const assistantMessage: MessageParam = {
      role: 'assistant',
      content: assistantContentBlocks as any,
    };

    // Yield the complete assistant message
    yield { type: 'assistant', message: assistantMessage };

    // Yield individual tool_use events for UI
    for (const block of toolUseBlocks) {
      yield {
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: (block.input ?? {}) as Record<string, unknown>,
      };
    }

    // ── Check: max_tokens recovery ──
    // Reference: OpenClaw src/query.ts lines 1188-1256
    if (stopReason === 'max_tokens' && !needsFollowUp) {
      if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        coworkLog('WARN', 'queryEngine', `max_tokens hit, recovery attempt ${state.maxOutputTokensRecoveryCount + 1}`);
        state.maxOutputTokensRecoveryCount++;
        // Add assistant message + a user nudge to continue
        state.messages = [
          ...messagesForQuery,
          assistantMessage,
          { role: 'user', content: 'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.' },
        ];
        continue;
      }
    }

    // ── Phase 5: No tool_use → completed ──
    if (!needsFollowUp) {
      coworkLog('INFO', 'queryEngine', `Turn ${state.turnCount}: completed (stop_reason=${stopReason})`);
      return { reason: 'completed' };
    }

    // ── Phase 6: Execute tools ──
    // Reference: OpenClaw src/query.ts lines 1384-1443

    const toolContext: ToolContext = {
      sessionId,
      cwd,
      abortSignal,
    };

    const toolResults = await runTools(
      toolUseBlocks,
      tools,
      toolContext,
      canUseTool,
      (result) => {
        // Yield tool_result events for real-time UI
        const content = result.result.content.map(c => c.text).join('\n');
        // Note: we use a synchronous callback here; the yield happens below
        if (onToolResult) onToolResult(result);
      }
    );

    // Check abort after tool execution
    if (abortSignal?.aborted) {
      return { reason: 'aborted' };
    }

    // Yield tool results for UI
    for (const tr of toolResults) {
      const content = tr.result.content.map(c => c.text).join('\n');
      yield {
        type: 'tool_result',
        toolUseId: tr.toolUseId,
        toolName: tr.toolName,
        content: truncateText(content, TOOL_RESULT_MAX_CHARS),
        isError: tr.result.isError ?? false,
      };
    }

    // Build tool_result message for conversation history
    const toolResultMessage = buildToolResultMessage(
      toolResults.map(tr => ({
        tool_use_id: tr.toolUseId,
        content: truncateText(
          tr.result.content.map(c => c.text).join('\n'),
          TOOL_RESULT_MAX_CHARS
        ),
        is_error: tr.result.isError,
      }))
    );

    // ── Phase 7: Update state, continue loop ──
    // Reference: OpenClaw src/query.ts lines 1714-1728

    state = {
      messages: [...messagesForQuery, assistantMessage, toolResultMessage],
      turnCount: state.turnCount,
      maxOutputTokensRecoveryCount: 0,
    };

    coworkLog('INFO', 'queryEngine', `Turn ${state.turnCount}: ${toolUseBlocks.length} tools executed, continuing loop`);
  }
}

// ── Convenience wrapper that also handles streaming ──

/**
 * Higher-level wrapper that runs queryLoop and also provides
 * streaming text/thinking deltas for the UI.
 *
 * This version uses the stream's event iterator instead of finalMessage()
 * for true real-time streaming.
 */
export async function* queryLoopStreaming(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const {
    prompt,
    images,
    systemPrompt,
    priorMessages,
    tools,
    apiConfig,
    cwd,
    sessionId,
    abortSignal,
    canUseTool,
    onToolResult,
  } = params;

  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const client = getAnthropicClient(apiConfig);
  const apiTools = toolsToApiSchemas(tools);

  const userMessage = buildUserMessage(prompt, images?.map(i => ({
    mimeType: i.mimeType,
    base64Data: i.base64Data,
  })));

  let state: QueryState = {
    messages: [...(priorMessages || []), userMessage],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
  };

  let hasAttemptedReactiveCompact = false;

  while (true) {
    if (abortSignal?.aborted) return { reason: 'aborted' as const };
    if (state.turnCount >= maxTurns) return { reason: 'max_turns' as const };

    state.turnCount++;
    yield { type: 'turn_start', turnCount: state.turnCount };

    // Note: micro-compact runs on store messages in coworkRunner.maybeCompactSession,
    // not here (API messages lack toolName metadata needed for selective clearing).

    const messagesForQuery = normalizeMessagesForAPI(state.messages);
    const maxTokens = state.maxOutputTokensRecoveryCount > 0
      ? ESCALATED_MAX_TOKENS
      : (apiConfig.maxTokens ?? DEFAULT_MAX_TOKENS);

    let assistantContentBlocks: Array<Record<string, unknown>> = [];
    let toolUseBlocks: ToolUseBlock[] = [];
    let needsFollowUp = false;
    let stopReason: string | null = null;
    let usage: any = null;

    // ── StreamingToolExecutor: start executing tools during streaming ──
    // Reference: OpenClaw src/services/tools/StreamingToolExecutor.ts
    const toolContext: ToolContext = { sessionId, cwd, abortSignal };
    const streamingExecutor = new StreamingToolExecutor(tools, toolContext, canUseTool);
    let streamingFailed = false;

    try {
      const stream = await createMessageStream({
        client,
        model: apiConfig.model,
        systemPrompt,
        messages: messagesForQuery,
        tools: apiTools,
        maxTokens,
        thinkingBudget: apiConfig.thinkingBudget,
        signal: abortSignal,
      });

      // ── Streaming loop with pipelined tool execution ──
      // Reference: OpenClaw src/query.ts lines 659-863

      // Accumulate content blocks during streaming (instead of finalMessage)
      let currentToolUseBlock: { id: string; name: string; inputJson: string } | null = null;
      let currentTextContent = '';
      let currentThinkingContent = '';

      for await (const event of stream) {
        // Forward stream events for UI rendering
        yield { type: 'stream_event', event };

        // Accumulate content blocks from stream events
        if (event.type === 'content_block_start') {
          const cb = (event as any).content_block;
          if (cb?.type === 'tool_use') {
            currentToolUseBlock = { id: cb.id, name: cb.name, inputJson: '' };
          } else if (cb?.type === 'text') {
            currentTextContent = cb.text || '';
          } else if (cb?.type === 'thinking') {
            currentThinkingContent = cb.thinking || '';
          }
        } else if (event.type === 'content_block_delta') {
          const delta = (event as any).delta;
          if (delta?.type === 'input_json_delta' && currentToolUseBlock) {
            currentToolUseBlock.inputJson += delta.partial_json || '';
          } else if (delta?.type === 'text_delta') {
            currentTextContent += delta.text || '';
          } else if (delta?.type === 'thinking_delta') {
            currentThinkingContent += delta.thinking || '';
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolUseBlock) {
            // Tool block fully streamed — add to blocks and start execution
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = currentToolUseBlock.inputJson
                ? JSON.parse(currentToolUseBlock.inputJson)
                : {};
            } catch { /* partial JSON — use empty */ }

            const toolBlock: ToolUseBlock = {
              type: 'tool_use',
              id: currentToolUseBlock.id,
              name: currentToolUseBlock.name,
              input: parsedInput,
            };
            assistantContentBlocks.push(toolBlock as unknown as Record<string, unknown>);
            toolUseBlocks.push(toolBlock);
            needsFollowUp = true;
            streamingExecutor.addTool(toolBlock);
            currentToolUseBlock = null;
          } else if (currentTextContent) {
            assistantContentBlocks.push({ type: 'text', text: currentTextContent });
            currentTextContent = '';
          } else if (currentThinkingContent) {
            assistantContentBlocks.push({ type: 'thinking', thinking: currentThinkingContent });
            currentThinkingContent = '';
          }
        } else if (event.type === 'message_delta') {
          const md = (event as any).delta;
          if (md?.stop_reason) stopReason = md.stop_reason;
        } else if (event.type === 'message_start') {
          const msg = (event as any).message;
          if (msg?.usage) usage = msg.usage;
        } else if (event.type === 'message_stop') {
          // Final usage update if available
          const msg = (event as any).message;
          if (msg?.usage) usage = msg.usage;
        }

        // Yield any tools that completed while streaming
        for (const result of streamingExecutor.getCompletedResults()) {
          if (onToolResult) onToolResult(result);
          const content = result.result.content.map(c => c.text).join('\n');
          yield {
            type: 'tool_result',
            toolUseId: result.toolUseId,
            toolName: result.toolName,
            content: truncateText(content, TOOL_RESULT_MAX_CHARS),
            isError: result.result.isError ?? false,
          };
        }
      }

      // No finalMessage() needed — we accumulated everything during streaming

    } catch (e) {
      if (abortSignal?.aborted) {
        streamingExecutor.discard();
        return { reason: 'aborted' as const };
      }

      const errMsg = e instanceof Error ? e.message : String(e);

      // ── Streaming fallback: retry without streaming ──
      // Reference: OpenClaw src/query.ts FallbackTriggeredError
      if (errMsg.includes('stream') || errMsg.includes('SSE') || errMsg.includes('network')) {
        if (!streamingFailed) {
          streamingFailed = true;
          streamingExecutor.discard();
          coworkLog('WARN', 'queryEngine', 'Streaming failed, retrying with non-streaming fallback');

          try {
            const response = await createMessage({
              client,
              model: apiConfig.model,
              systemPrompt,
              messages: messagesForQuery,
              tools: apiTools,
              maxTokens,
              signal: abortSignal,
            });

            for (const block of response.content) {
              assistantContentBlocks.push(block as unknown as Record<string, unknown>);
              if (block.type === 'tool_use') {
                toolUseBlocks.push(block as ToolUseBlock);
                needsFollowUp = true;
              }
            }
            stopReason = response.stop_reason;
            usage = response.usage;
            // Fall through to normal post-processing below
          } catch (fallbackErr) {
            const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            coworkLog('ERROR', 'queryEngine', `Non-streaming fallback also failed: ${fbMsg}`);
            return { reason: 'error' as const, error: fbMsg };
          }
        }
      }

      // ── Prompt-too-long recovery ──
      // Reference: OpenClaw src/query.ts lines 1065-1183
      if (!streamingFailed && (errMsg.includes('prompt is too long') || errMsg.includes('413') || errMsg.includes('prompt_too_long'))) {
        streamingExecutor.discard();
        coworkLog('WARN', 'queryEngine', 'Prompt too long — attempting reactive compact', {
          messageCount: messagesForQuery.length,
          hasAttemptedReactiveCompact,
        });

        if (!hasAttemptedReactiveCompact) {
          hasAttemptedReactiveCompact = true;
          try {
            const compactMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
            for (const msg of state.messages) {
              const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
              if (content.trim()) compactMessages.push({ role: msg.role, content });
            }

            if (compactMessages.length > 4) {
              const summary = await executeCompact({
                apiKey: apiConfig.apiKey,
                model: apiConfig.model,
                baseURL: apiConfig.baseUrl,
                messages: compactMessages,
              });

              if (summary) {
                coworkLog('INFO', 'queryEngine', 'Reactive compact succeeded, retrying');
                const recentCount = Math.min(4, state.messages.length);
                state.messages = [
                  { role: 'user', content: summary },
                  { role: 'assistant', content: 'I understand the context. Continuing from where we left off.' },
                  ...state.messages.slice(-recentCount),
                ];
                state.turnCount--;
                continue;
              }
            }
          } catch (compactErr) {
            coworkLog('ERROR', 'queryEngine', `Reactive compact failed: ${compactErr}`);
          }
        }
        return { reason: 'prompt_too_long' as const, error: errMsg };
      }

      if (!streamingFailed) {
        streamingExecutor.discard();
        if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
          coworkLog('ERROR', 'queryEngine', 'Rate limit error (SDK retries exhausted)');
        }
        coworkLog('ERROR', 'queryEngine', `API error: ${errMsg}`);
        return { reason: 'error' as const, error: errMsg };
      }
    }

    // ── Post-stream processing ──

    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      };
    }

    const assistantMessage: MessageParam = { role: 'assistant', content: assistantContentBlocks as any };
    yield { type: 'assistant', message: assistantMessage };

    for (const block of toolUseBlocks) {
      yield {
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: (block.input ?? {}) as Record<string, unknown>,
      };
    }

    // max_tokens recovery
    if (stopReason === 'max_tokens' && !needsFollowUp) {
      if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        state.maxOutputTokensRecoveryCount++;
        state.messages = [
          ...messagesForQuery,
          assistantMessage,
          { role: 'user', content: 'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.' },
        ];
        continue;
      }
    }

    if (!needsFollowUp) return { reason: 'completed' as const };

    // ── Execute remaining tools (non-safe tools queued during streaming) ──
    for await (const result of streamingExecutor.getRemainingResults()) {
      if (onToolResult) onToolResult(result);
      const content = result.result.content.map(c => c.text).join('\n');
      yield {
        type: 'tool_result',
        toolUseId: result.toolUseId,
        toolName: result.toolName,
        content: truncateText(content, TOOL_RESULT_MAX_CHARS),
        isError: result.result.isError ?? false,
      };
    }

    if (abortSignal?.aborted) return { reason: 'aborted' as const };

    // Use getAllResults() to get COMPLETE list (streaming-completed + remaining)
    const allToolResults = streamingExecutor.getAllResults();

    const toolResultMessage = buildToolResultMessage(
      allToolResults.map(tr => ({
        tool_use_id: tr.toolUseId,
        content: truncateText(tr.result.content.map(c => c.text).join('\n'), TOOL_RESULT_MAX_CHARS),
        is_error: tr.result.isError,
      }))
    );

    state = {
      messages: [...messagesForQuery, assistantMessage, toolResultMessage],
      turnCount: state.turnCount,
      maxOutputTokensRecoveryCount: 0,
    };
  }
}
