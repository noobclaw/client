/**
 * Tool Orchestration — executes tool_use blocks from the model response,
 * partitioning them into concurrent and serial batches.
 *
 * Ported from OpenClaw (Claude Code) src/services/tools/toolOrchestration.ts
 */

import type { ToolUseBlock } from './anthropicClient';
import type { ToolDefinition, ToolResult, ToolContext, PermissionResult } from './toolSystem';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface ToolExecutionResult {
  toolUseId: string;
  toolName: string;
  result: ToolResult;
}

export type CanUseToolFn = (
  toolName: string,
  toolInput: unknown,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>;

/** Max concurrent tool executions (read-only tools) */
const MAX_TOOL_USE_CONCURRENCY = 10;

/** Default per-tool execution timeout in ms (5 minutes) */
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

// ── Batch partitioning ──
// Reference: OpenClaw src/services/tools/toolOrchestration.ts partitionToolCalls()

interface ToolBatch {
  isConcurrencySafe: boolean;
  blocks: ToolUseBlock[];
}

/**
 * Partition tool_use blocks into batches for execution.
 * Consecutive concurrency-safe tools go in one batch (parallel).
 * Non-safe tools get their own batch (serial).
 */
function partitionToolCalls(
  blocks: ToolUseBlock[],
  tools: ToolDefinition[]
): ToolBatch[] {
  const batches: ToolBatch[] = [];
  const toolMap = new Map(tools.map(t => [t.name, t]));

  for (const block of blocks) {
    const tool = toolMap.get(block.name);
    const isSafe = typeof tool?.isConcurrencySafe === 'function'
      ? tool.isConcurrencySafe(block.input)
      : (tool?.isConcurrencySafe ?? false);

    const lastBatch = batches[batches.length - 1];
    if (lastBatch && lastBatch.isConcurrencySafe && isSafe) {
      // Append to current concurrent batch
      lastBatch.blocks.push(block);
    } else {
      // Start a new batch
      batches.push({ isConcurrencySafe: isSafe, blocks: [block] });
    }
  }

  return batches;
}

// ── Execute a single tool ──

async function executeOneTool(
  block: ToolUseBlock,
  tools: ToolDefinition[],
  context: ToolContext,
  canUseTool: CanUseToolFn
): Promise<ToolExecutionResult> {
  const toolName = block.name;
  const toolInput = (block.input ?? {}) as Record<string, unknown>;
  const toolUseId = block.id;

  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    coworkLog('WARN', 'toolOrchestration', `Tool not found: "${toolName}"`);
    return {
      toolUseId,
      toolName,
      result: {
        content: [{ type: 'text', text: `Error: Tool "${toolName}" not found` }],
        isError: true,
      },
    };
  }

  // Permission check
  try {
    const permission = await canUseTool(toolName, toolInput, {
      signal: context.abortSignal ?? new AbortController().signal,
    });

    if (permission.behavior === 'deny') {
      coworkLog('INFO', 'toolOrchestration', `Tool "${toolName}" denied: ${permission.message}`);
      return {
        toolUseId,
        toolName,
        result: {
          content: [{ type: 'text', text: permission.message || 'Permission denied' }],
          isError: true,
        },
      };
    }

    // Use updated input if permission modified it
    const finalInput = permission.updatedInput
      ? { ...toolInput, ...permission.updatedInput }
      : toolInput;

    // Validate input with Zod schema
    let validatedInput: unknown;
    try {
      validatedInput = tool.inputSchema.parse(finalInput);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      coworkLog('WARN', 'toolOrchestration', `Tool "${toolName}" input validation failed: ${msg}`);
      return {
        toolUseId,
        toolName,
        result: {
          content: [{ type: 'text', text: `Input validation error: ${msg}` }],
          isError: true,
        },
      };
    }

    // Execute tool with timeout
    coworkLog('INFO', 'toolOrchestration', `Executing tool "${toolName}"`, { toolUseId });
    const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
    const result = await Promise.race([
      tool.call(validatedInput as any, context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      ),
    ]);
    coworkLog('INFO', 'toolOrchestration', `Tool "${toolName}" completed`, {
      toolUseId,
      isError: result.isError,
    });

    return { toolUseId, toolName, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    coworkLog('ERROR', 'toolOrchestration', `Tool "${toolName}" threw error: ${msg}`);
    return {
      toolUseId,
      toolName,
      result: {
        content: [{ type: 'text', text: `Tool execution error: ${msg}` }],
        isError: true,
      },
    };
  }
}

// ── Run a batch concurrently ──

async function runBatchConcurrently(
  blocks: ToolUseBlock[],
  tools: ToolDefinition[],
  context: ToolContext,
  canUseTool: CanUseToolFn
): Promise<ToolExecutionResult[]> {
  // Limit concurrency
  const results: ToolExecutionResult[] = [];
  const chunks: ToolUseBlock[][] = [];

  for (let i = 0; i < blocks.length; i += MAX_TOOL_USE_CONCURRENCY) {
    chunks.push(blocks.slice(i, i + MAX_TOOL_USE_CONCURRENCY));
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(block => executeOneTool(block, tools, context, canUseTool))
    );
    results.push(...chunkResults);
  }

  return results;
}

// ── Run a batch serially ──

async function runBatchSerially(
  blocks: ToolUseBlock[],
  tools: ToolDefinition[],
  context: ToolContext,
  canUseTool: CanUseToolFn
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];

  for (const block of blocks) {
    if (context.abortSignal?.aborted) {
      results.push({
        toolUseId: block.id,
        toolName: block.name,
        result: {
          content: [{ type: 'text', text: 'Execution aborted' }],
          isError: true,
        },
      });
      continue;
    }

    const result = await executeOneTool(block, tools, context, canUseTool);
    results.push(result);
  }

  return results;
}

// ── Main entry point ──
// Reference: OpenClaw src/services/tools/toolOrchestration.ts runTools()

/**
 * Execute all tool_use blocks, respecting concurrency safety.
 * Returns results in the same order as the input blocks.
 */
export async function runTools(
  toolUseBlocks: ToolUseBlock[],
  tools: ToolDefinition[],
  context: ToolContext,
  canUseTool: CanUseToolFn,
  onToolResult?: (result: ToolExecutionResult) => void
): Promise<ToolExecutionResult[]> {
  if (toolUseBlocks.length === 0) return [];

  const batches = partitionToolCalls(toolUseBlocks, tools);
  const allResults: ToolExecutionResult[] = [];

  coworkLog('INFO', 'toolOrchestration', `Running ${toolUseBlocks.length} tools in ${batches.length} batches`);

  let currentContext = context;

  for (const batch of batches) {
    const batchResults = batch.isConcurrencySafe
      ? await runBatchConcurrently(batch.blocks, tools, currentContext, canUseTool)
      : await runBatchSerially(batch.blocks, tools, currentContext, canUseTool);

    for (const result of batchResults) {
      allResults.push(result);
      if (onToolResult) {
        onToolResult(result);
      }
    }

    // Apply context modifiers after each batch completes
    // Reference: OpenClaw — context modifiers queued and applied after batch
    for (const result of batchResults) {
      if (result.result.contextModifier) {
        currentContext = result.result.contextModifier(currentContext);
        coworkLog('INFO', 'toolOrchestration', `Context modified by tool "${result.toolName}"`, {
          newCwd: currentContext.cwd,
        });
      }
    }
  }

  return allResults;
}
