/**
 * Anthropic API Client — direct @anthropic-ai/sdk integration.
 *
 * Replaces the claude-agent-sdk's black-box query() with direct
 * messages.create() streaming calls, giving us full control over
 * the agent loop, tool execution, and error recovery.
 *
 * Ported from OpenClaw (Claude Code) src/services/api/client.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';

// ── Types re-exported for convenience ──
// In @anthropic-ai/sdk, types are namespaced under Anthropic.*

export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
export type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type TextBlock = Anthropic.Messages.TextBlock;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type MessageStreamEvent = Anthropic.Messages.MessageStreamEvent;
export type Message = Anthropic.Messages.Message;
export type Tool = Anthropic.Messages.Tool;

export interface ApiConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  thinkingBudget?: number;
}

// ── Client singleton ──

let clientInstance: Anthropic | null = null;
let currentApiKey = '';
let currentBaseUrl = '';

export function getAnthropicClient(config: ApiConfig): Anthropic {
  // Reuse client if config hasn't changed
  if (clientInstance && config.apiKey === currentApiKey && (config.baseUrl || '') === currentBaseUrl) {
    return clientInstance;
  }

  currentApiKey = config.apiKey;
  currentBaseUrl = config.baseUrl || '';

  const options: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: config.apiKey,
    maxRetries: 3,
    timeout: 600_000, // 10 minutes
    defaultHeaders: {
      'x-app': 'noobclaw',
    },
  };

  if (config.baseUrl) {
    options.baseURL = config.baseUrl;
  }

  clientInstance = new Anthropic(options);
  coworkLog('INFO', 'anthropicClient', 'Created new Anthropic client', {
    baseUrl: config.baseUrl || '(default)',
    hasApiKey: !!config.apiKey,
  });

  return clientInstance;
}

// ── Streaming API call ──

export interface CreateMessageParams {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  messages: MessageParam[];
  tools: Tool[];
  maxTokens: number;
  thinkingBudget?: number;
  signal?: AbortSignal;
}

/**
 * Call messages.create() with streaming enabled.
 * Returns the raw Stream object for the caller to iterate.
 *
 * Reference: OpenClaw src/services/api/claude.ts line 1822
 */
export async function createMessageStream(params: CreateMessageParams) {
  const {
    client,
    model,
    systemPrompt,
    messages,
    tools,
    maxTokens,
    thinkingBudget,
    signal,
  } = params;

  const requestId = uuidv4();

  coworkLog('INFO', 'createMessageStream', 'Starting API request', {
    requestId,
    model,
    messageCount: messages.length,
    toolCount: tools.length,
    maxTokens,
    thinkingBudget: thinkingBudget || 'none',
  });

  // Build request parameters with multi-level prompt caching
  // Reference: OpenClaw src/services/api/claude.ts — granular cache_control placement
  //
  // Cache strategy (3 breakpoints for maximum reuse):
  //   1. System prompt: cached (stable across all turns)
  //   2. Tool definitions: cached on last tool (stable unless tools change)
  //   3. Last user message: cached (conversation prefix reuse across retries)

  const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' },
  }];

  // Add cache_control to the last user message for conversation prefix caching
  const cachedMessages = messages.map((msg, i) => {
    if (i === messages.length - 1 && msg.role === 'user') {
      // Cache the last user message — enables prefix reuse on retries and
      // multi-turn conversations where only the latest assistant response changes
      if (typeof msg.content === 'string') {
        return {
          ...msg,
          content: [{ type: 'text' as const, text: msg.content, cache_control: { type: 'ephemeral' as const } }],
        };
      }
      if (Array.isArray(msg.content)) {
        const blocks = [...msg.content];
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && typeof lastBlock === 'object' && 'type' in lastBlock) {
          blocks[blocks.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } } as any;
        }
        return { ...msg, content: blocks };
      }
    }
    return msg;
  });

  const requestParams: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: cachedMessages,
    stream: true,
  };

  // Add tools with cache_control on the last tool (tool list is stable across turns)
  if (tools.length > 0) {
    const toolsWithCache = tools.map((t, i) => {
      if (i === tools.length - 1) {
        return { ...t, cache_control: { type: 'ephemeral' } };
      }
      return t;
    });
    requestParams.tools = toolsWithCache;
  }

  // Add thinking if configured
  if (thinkingBudget && thinkingBudget > 0) {
    requestParams.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    };
  }

  const stream = client.messages.stream(requestParams as any, {
    signal,
    headers: {
      'x-client-request-id': requestId,
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
  });

  return stream;
}

/**
 * Non-streaming API call for compaction and other one-shot requests.
 */
export async function createMessage(params: Omit<CreateMessageParams, 'signal'> & { signal?: AbortSignal }) {
  const { client, model, systemPrompt, messages, tools, maxTokens, signal } = params;

  const requestParams: Anthropic.MessageCreateParams = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
    stream: false,
  };

  if (tools.length > 0) {
    requestParams.tools = tools;
  }

  const response = await client.messages.create(requestParams, { signal });
  return response;
}

// ── Reset ──

export function resetClient(): void {
  clientInstance = null;
  currentApiKey = '';
  currentBaseUrl = '';
}
