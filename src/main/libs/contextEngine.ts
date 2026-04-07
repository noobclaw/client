/**
 * Context Engine — manages token budget allocation and tool deferred loading.
 * Prevents 85+ tool descriptions from overwhelming the context window.
 *
 * Reference: OpenClaw src/context-engine/ (registry.ts, types.ts, delegate.ts)
 *
 * Token budget allocation:
 *   System prompt: 15% | Tools: 25% | Messages: 50% | Output: 10%
 *
 * Tool deferred loading (when total tools > DEFER_THRESHOLD):
 *   - Top-N frequently used tools: full description
 *   - Other tools: name + one-line summary only
 *   - tool_search tool: lets model request full description on demand
 */

import { coworkLog } from './coworkLogger';
import type { ToolDefinition } from './toolSystem';
import type { Tool as AnthropicTool } from './anthropicClient';
import { toolToApiSchema } from './toolSystem';

// ── Configuration ──

export interface ContextBudget {
  totalTokens: number;
  systemPromptTokens: number;
  toolDescriptionTokens: number;
  messageTokens: number;
  outputTokens: number;
}

export interface ContextEngineConfig {
  contextWindowSize: number;      // Model context window (default: 200K)
  systemPromptRatio: number;      // Default: 0.15
  toolDescriptionRatio: number;   // Default: 0.25
  messageRatio: number;           // Default: 0.50
  outputRatio: number;            // Default: 0.10
  deferThreshold: number;         // Tools > this count triggers deferred loading (default: 30)
  topToolCount: number;           // Number of tools to load fully (default: 20)
  maxToolDescriptionChars: number;// Truncate individual tool descriptions (default: 2048)
}

const DEFAULT_CONFIG: ContextEngineConfig = {
  contextWindowSize: 200_000,
  systemPromptRatio: 0.15,
  toolDescriptionRatio: 0.25,
  messageRatio: 0.50,
  outputRatio: 0.10,
  deferThreshold: 30,
  topToolCount: 20,
  maxToolDescriptionChars: 2048,
};

// ── State ──

let config = { ...DEFAULT_CONFIG };
const toolUsageCount = new Map<string, number>(); // Track how often each tool is used

// ── Configure ──

export function configureContextEngine(custom?: Partial<ContextEngineConfig>): void {
  if (custom) config = { ...config, ...custom };
  coworkLog('INFO', 'contextEngine', `Configured: window=${config.contextWindowSize}, deferThreshold=${config.deferThreshold}`);
}

// ── Token Budget Computation ──

export function computeBudget(contextWindowOverride?: number): ContextBudget {
  const total = contextWindowOverride ?? config.contextWindowSize;
  return {
    totalTokens: total,
    systemPromptTokens: Math.floor(total * config.systemPromptRatio),
    toolDescriptionTokens: Math.floor(total * config.toolDescriptionRatio),
    messageTokens: Math.floor(total * config.messageRatio),
    outputTokens: Math.floor(total * config.outputRatio),
  };
}

/**
 * Estimate token count from text (rough: ~4 chars/token for English, ~2 for CJK).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  const nonCjk = text.length - cjkCount;
  return Math.ceil(nonCjk / 4 + cjkCount / 1.5);
}

// ── Tool Deferred Loading ──

export interface DeferredToolSet {
  /** Tools with full descriptions (top-N + always-load) */
  fullTools: AnthropicTool[];
  /** Tools with truncated descriptions (name + one-liner) */
  deferredTools: AnthropicTool[];
  /** All tools combined (full + deferred) for API */
  allApiTools: AnthropicTool[];
  /** Original tool definitions (for tool_search lookups) */
  originalTools: ToolDefinition[];
  /** Whether deferred loading was applied */
  isDeferred: boolean;
  /** Token estimate for tool descriptions */
  estimatedToolTokens: number;
}

/**
 * Build the tool set with optional deferred loading.
 * When tools > deferThreshold, only top-N tools get full descriptions.
 */
export function buildDeferredToolSet(tools: ToolDefinition[]): DeferredToolSet {
  const budget = computeBudget();

  if (tools.length <= config.deferThreshold) {
    // Under threshold — load all tools fully
    const apiTools = tools.map(t => {
      const schema = toolToApiSchema(t);
      schema.description = truncateDescription(schema.description || '', config.maxToolDescriptionChars);
      return schema;
    });

    const tokenEstimate = apiTools.reduce((sum, t) =>
      sum + estimateTokens(t.name) + estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema)), 0);

    return {
      fullTools: apiTools,
      deferredTools: [],
      allApiTools: apiTools,
      originalTools: tools,
      isDeferred: false,
      estimatedToolTokens: tokenEstimate,
    };
  }

  // Over threshold — defer less-used tools
  coworkLog('INFO', 'contextEngine', `${tools.length} tools > threshold ${config.deferThreshold}, enabling deferred loading`);

  // Sort by usage frequency (most used first)
  const sorted = [...tools].sort((a, b) => {
    const usageA = toolUsageCount.get(a.name) ?? 0;
    const usageB = toolUsageCount.get(b.name) ?? 0;
    return usageB - usageA;
  });

  // Always-load tools (core tools that should never be deferred)
  const alwaysLoad = new Set([
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'spawn_subagent', 'delegate_to_agent', 'tool_search',
    'browser_navigate', 'browser_screenshot', 'browser_observe',
    'desktop_screenshot', 'desktop_click', 'desktop_type',
    'memory_recall', 'memory_store',
  ]);

  const fullToolDefs: ToolDefinition[] = [];
  const deferredToolDefs: ToolDefinition[] = [];

  for (const tool of sorted) {
    if (alwaysLoad.has(tool.name) || fullToolDefs.length < config.topToolCount) {
      fullToolDefs.push(tool);
    } else {
      deferredToolDefs.push(tool);
    }
  }

  // Convert to API schemas
  const fullApiTools = fullToolDefs.map(t => {
    const schema = toolToApiSchema(t);
    schema.description = truncateDescription(schema.description || '', config.maxToolDescriptionChars);
    return schema;
  });

  // Deferred tools are NOT sent to the API at all — saves ~2000 tokens/request.
  // The model discovers them via tool_search when needed.
  // This follows Claude Code's defer_loading pattern where deferred tools
  // are invisible until ToolSearchTool reveals them.

  const tokenEstimate = fullApiTools.reduce((sum, t) =>
    sum + estimateTokens(t.name) + estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema)), 0);

  coworkLog('INFO', 'contextEngine', `Tool set: ${fullApiTools.length} sent to API + ${deferredToolDefs.length} hidden (available via tool_search) (~${tokenEstimate} tokens)`);

  return {
    fullTools: fullApiTools,
    deferredTools: [],  // Not sent to API — hidden, discoverable via tool_search
    allApiTools: fullApiTools,  // Only full tools sent to API
    originalTools: tools,
    isDeferred: true,
    estimatedToolTokens: tokenEstimate,
  };
}

// ── Tool Usage Tracking ──

export function recordToolUsage(toolName: string): void {
  toolUsageCount.set(toolName, (toolUsageCount.get(toolName) ?? 0) + 1);
}

export function getToolUsageStats(): Map<string, number> {
  return new Map(toolUsageCount);
}

// ── Tool Search (used by contextTools.ts) ──

/**
 * Search for tools by keyword and return full descriptions.
 * Used when deferred loading is active and model needs a tool's full schema.
 */
export function searchTools(query: string, tools: ToolDefinition[], maxResults: number = 5): Array<{
  name: string; description: string; inputSchema: Record<string, unknown>;
}> {
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);

  const scored = tools.map(tool => {
    const name = tool.name.toLowerCase();
    const desc = tool.description.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (name.includes(kw)) score += 3;
      if (desc.includes(kw)) score += 1;
    }
    return { tool, score };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(s => {
    const schema = toolToApiSchema(s.tool);
    return {
      name: schema.name,
      description: schema.description || '',
      inputSchema: schema.input_schema as Record<string, unknown>,
    };
  });
}

// ── Context Pressure Monitoring ──

export interface ContextPressure {
  estimatedTokens: number;
  budgetTokens: number;
  usagePercent: number;
  isOverBudget: boolean;
}

export function checkContextPressure(
  systemPromptChars: number,
  toolDescriptionTokens: number,
  messageChars: number,
): ContextPressure {
  const budget = computeBudget();
  const estimated = estimateTokens(' '.repeat(systemPromptChars)) + toolDescriptionTokens + estimateTokens(' '.repeat(messageChars));
  const budgetTokens = budget.systemPromptTokens + budget.toolDescriptionTokens + budget.messageTokens;

  return {
    estimatedTokens: estimated,
    budgetTokens,
    usagePercent: Math.round((estimated / budgetTokens) * 100),
    isOverBudget: estimated > budgetTokens,
  };
}

// ── Helpers ──

function truncateDescription(desc: string, maxChars: number): string {
  if (desc.length <= maxChars) return desc;
  return desc.slice(0, maxChars - 50) + '\n\n[Description truncated. Use tool_search for full details.]';
}

function getOneLiner(desc: string): string {
  // Extract first sentence or first line
  const firstLine = desc.split('\n')[0].trim();
  const firstSentence = firstLine.split(/\.\s/)[0];
  return firstSentence.slice(0, 120);
}
