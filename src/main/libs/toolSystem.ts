/**
 * Tool System — defines the Tool interface and helpers for converting
 * between internal tool definitions and Anthropic API tool schemas.
 *
 * Ported from OpenClaw (Claude Code) src/Tool.ts + src/utils/api.ts
 */

import type { ZodType } from 'zod';
import { zodToJsonSchema } from './zodToJsonSchema';
import type { Tool as AnthropicTool } from './anthropicClient';
import { coworkLog } from './coworkLogger';

// ── Permission types (previously imported from claude-agent-sdk) ──

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
}

// ── Tool result ──

export interface ToolResultContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  /**
   * Optional context modifier — applied after tool execution to update
   * the execution context (e.g., change cwd after a cd command).
   * Reference: OpenClaw src/Tool.ts ToolResult.contextModifier
   */
  contextModifier?: (ctx: ToolContext) => ToolContext;
}

// ── Tool context passed to call() ──

export interface ToolContext {
  sessionId: string;
  cwd: string;
  abortSignal?: AbortSignal;
}

// ── Core Tool interface ──
// Reference: OpenClaw src/Tool.ts

export interface ToolDefinition<TInput = Record<string, unknown>> {
  /** Unique tool name, sent to the API */
  name: string;

  /**
   * Rich, pedagogical description for the model.
   * Should include: when to use, when NOT to use, parameter explanations,
   * common mistakes, and relationship to other tools.
   * Reference: OpenClaw src/tools/[tool]/prompt.ts
   */
  description: string;

  /** Zod schema for input validation */
  inputSchema: ZodType<TInput>;

  /** Execute the tool and return results */
  call(input: TInput, context: ToolContext): Promise<ToolResult>;

  /**
   * Whether this tool can safely run in parallel with other tools.
   * Can be a static boolean OR a function that inspects input.
   * Read-only tools (search, read) → true
   * Write tools (edit, bash, write) → false
   * Reference: OpenClaw src/services/tools/toolOrchestration.ts
   */
  isConcurrencySafe?: boolean | ((input: any) => boolean);

  /** Whether this tool only reads without side effects */
  isReadOnly?: boolean;

  /** Whether this tool can cause irreversible changes */
  isDestructive?: boolean;
}

// ── Convert Tool to Anthropic API schema ──
// Reference: OpenClaw src/utils/api.ts toolToAPISchema()

export function toolToApiSchema(tool: ToolDefinition): AnthropicTool {
  let jsonSchema: Record<string, unknown>;

  try {
    jsonSchema = zodToJsonSchema(tool.inputSchema);
  } catch (e) {
    coworkLog('WARN', 'toolToApiSchema', `Failed to convert Zod schema for tool "${tool.name}", using empty schema`, {
      error: e instanceof Error ? e.message : String(e),
    });
    jsonSchema = { type: 'object', properties: {} };
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema as AnthropicTool['input_schema'],
  };
}

/**
 * Convert an array of ToolDefinitions to API schemas.
 */
export function toolsToApiSchemas(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map(toolToApiSchema);
}

/**
 * Find a tool definition by name.
 */
export function findTool(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find(t => t.name === name);
}

/**
 * Build a simple tool definition from parts.
 * Convenience helper similar to the old SDK's tool() factory.
 */
export function buildTool(def: {
  name: string;
  description: string;
  inputSchema: ZodType<any>;
  call: (input: any, context: ToolContext) => Promise<ToolResult>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  isDestructive?: boolean;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    call: def.call,
    isConcurrencySafe: def.isConcurrencySafe ?? false,
    isReadOnly: def.isReadOnly ?? false,
    isDestructive: def.isDestructive ?? false,
  };
}
