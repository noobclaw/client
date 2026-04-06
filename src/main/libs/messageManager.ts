/**
 * Message Manager — handles message array construction, normalization,
 * and tool_use/tool_result pairing for the Anthropic Messages API.
 *
 * Ported from OpenClaw (Claude Code) src/utils/messages.ts
 */

import type { MessageParam, ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from './anthropicClient';
import { coworkLog } from './coworkLogger';

// ── Constants ──

/** Max characters for a single tool result before truncation */
export const TOOL_RESULT_MAX_CHARS = 120_000;

/** Max characters for streaming text content */
export const STREAMING_TEXT_MAX_CHARS = 120_000;

/** Max characters for streaming thinking content */
export const STREAMING_THINKING_MAX_CHARS = 60_000;

// ── Message construction helpers ──

/**
 * Build a user message with text content and optional image attachments.
 */
export function buildUserMessage(
  text: string,
  images?: Array<{ mimeType: string; base64Data: string }>
): MessageParam {
  if (!images || images.length === 0) {
    return { role: 'user', content: text };
  }

  const content: ContentBlockParam[] = [];

  if (text.trim()) {
    content.push({ type: 'text', text });
  }

  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: img.base64Data,
      },
    });
  }

  return { role: 'user', content };
}

/**
 * Build an assistant message from content blocks.
 */
export function buildAssistantMessage(
  contentBlocks: Array<{ type: string; [key: string]: unknown }>
): MessageParam {
  return {
    role: 'assistant',
    content: contentBlocks as unknown as ContentBlockParam[],
  };
}

/**
 * Build a tool_result user message from executed tool results.
 * Reference: OpenClaw — every tool_use must have a matching tool_result.
 */
export function buildToolResultMessage(
  results: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>
): MessageParam {
  const content: ToolResultBlockParam[] = results.map(r => ({
    type: 'tool_result' as const,
    tool_use_id: r.tool_use_id,
    content: r.content,
    is_error: r.is_error,
  }));

  return { role: 'user', content };
}

// ── Normalization ──

/**
 * Ensure every tool_use in assistant messages has a matching tool_result,
 * and every tool_result has a matching tool_use.
 *
 * Orphaned tool_use: inserts fixup user message RIGHT AFTER the assistant
 * message containing it (not at the end).
 * Orphaned tool_result: removes the orphaned block entirely.
 *
 * Reference: OpenClaw src/utils/messages.ts ensureToolResultPairing()
 */
export function ensureToolResultPairing(messages: MessageParam[]): MessageParam[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // Pass 1: collect all IDs
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block === 'string') continue;
      const b = block as unknown as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUseIds.add(b.id);
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // Find orphaned tool_use IDs (no matching tool_result)
  const orphanedUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUseIds.add(id);
  }

  // Find orphaned tool_result IDs (no matching tool_use)
  const orphanedResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResultIds.add(id);
  }

  if (orphanedUseIds.size === 0 && orphanedResultIds.size === 0) return messages;

  if (orphanedUseIds.size > 0) {
    coworkLog('WARN', 'messageManager', `Found ${orphanedUseIds.size} orphaned tool_use blocks, inserting fixup tool_results`);
  }
  if (orphanedResultIds.size > 0) {
    coworkLog('WARN', 'messageManager', `Found ${orphanedResultIds.size} orphaned tool_result blocks, removing them`);
  }

  // Pass 2: build fixed message array
  const result: MessageParam[] = [];

  for (const msg of messages) {
    // Remove orphaned tool_result blocks from user messages
    if (orphanedResultIds.size > 0 && msg.role === 'user' && Array.isArray(msg.content)) {
      const filtered = (msg.content as any[]).filter((block: any) => {
        if (typeof block === 'string') return true;
        if (block.type === 'tool_result' && orphanedResultIds.has(block.tool_use_id)) return false;
        return true;
      });
      if (filtered.length === 0) continue; // skip entirely empty message
      result.push({ role: msg.role, content: filtered });
    } else {
      result.push(msg);
    }

    // After each assistant message, check if it has orphaned tool_use blocks
    if (orphanedUseIds.size > 0 && msg.role === 'assistant' && Array.isArray(msg.content)) {
      const orphansInThis: string[] = [];
      for (const block of msg.content) {
        if (typeof block === 'string') continue;
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string' && orphanedUseIds.has(b.id)) {
          orphansInThis.push(b.id);
        }
      }
      if (orphansInThis.length > 0) {
        // Insert fixup user message right after this assistant message
        const fixupResults: ToolResultBlockParam[] = orphansInThis.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: '[Tool execution was interrupted]',
          is_error: true,
        }));
        result.push({ role: 'user', content: fixupResults });
      }
    }
  }

  return result;
}

/**
 * Merge consecutive messages from the same role.
 * The API requires alternating user/assistant messages.
 * Reference: OpenClaw src/utils/messages.ts
 */
export function mergeConsecutiveMessages(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= 1) return messages;

  const result: MessageParam[] = [];

  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge into previous message
      const prevContent = normalizeContent(prev.content);
      const currContent = normalizeContent(msg.content);
      prev.content = [...prevContent, ...currContent];
    } else {
      // Deep copy to avoid mutating originals
      result.push({
        role: msg.role,
        content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
      });
    }
  }

  return result;
}

function normalizeContent(content: MessageParam['content']): ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content as ContentBlockParam[];
  }
  return [];
}

/**
 * Prepare messages for API call — full normalization pipeline.
 * Reference: OpenClaw src/utils/messages.ts normalizeMessagesForAPI()
 */
export function normalizeMessagesForAPI(messages: MessageParam[]): MessageParam[] {
  let result = [...messages];

  // 1. Ensure tool_use/tool_result pairing
  result = ensureToolResultPairing(result);

  // 2. Merge consecutive same-role messages
  result = mergeConsecutiveMessages(result);

  // 3. Ensure first message is from user (API requirement)
  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: '(continue)' });
  }

  return result;
}

// ── Content extraction helpers ──

/**
 * Extract tool_use blocks from an assistant message.
 */
export function extractToolUseBlocks(message: MessageParam): ToolUseBlock[] {
  if (typeof message.content === 'string') return [];
  if (!Array.isArray(message.content)) return [];

  return message.content.filter(
    (block: any): block is ToolUseBlock =>
      typeof block === 'object' && block !== null && block.type === 'tool_use'
  );
}

/**
 * Extract text content from an assistant message.
 */
export function extractTextContent(message: MessageParam): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  return message.content
    .filter((block: any): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text'
    )
    .map((block: any) => block.text)
    .join('');
}

/**
 * Truncate text to max chars with indicator.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[Content truncated — exceeded maximum length]';
}
