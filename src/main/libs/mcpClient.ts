/**
 * MCP Client — connects to external MCP servers via stdio/sse/http
 * and materializes their tools as ToolDefinition objects.
 *
 * Ported from OpenClaw (Claude Code) src/services/mcp/client.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// SSE transport may not be available in all SDK versions; use dynamic import
import { z } from 'zod';
import { spawn } from 'child_process';
import { coworkLog } from './coworkLogger';
import { buildTool, type ToolDefinition, type ToolResult } from './toolSystem';

// ── Types ──

export interface McpServerConfig {
  name: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpConnection {
  name: string;
  client: Client;
  transport: any;
  tools: ToolDefinition[];
}

// ── Active connections ──

const activeConnections = new Map<string, McpConnection>();

// ── Connect to an MCP server and materialize tools ──

/**
 * Connect to a single MCP server and return its tools as ToolDefinition[].
 * The connection stays alive until disconnectMcpServer() is called.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  timeoutMs: number = 30_000
): Promise<ToolDefinition[]> {
  // Reuse existing connection if already connected
  const existing = activeConnections.get(config.name);
  if (existing) {
    coworkLog('INFO', 'mcpClient', `Reusing existing connection to "${config.name}"`);
    return existing.tools;
  }

  coworkLog('INFO', 'mcpClient', `Connecting to MCP server "${config.name}" (${config.transportType})`);

  const client = new Client({
    name: `noobclaw-${config.name}`,
    version: '1.0.0',
  });

  let transport: any;

  try {
    switch (config.transportType) {
      case 'stdio': {
        if (!config.command) {
          throw new Error(`MCP server "${config.name}": stdio transport requires a command`);
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
        });
        break;
      }

      case 'sse':
      case 'http': {
        if (!config.url) {
          throw new Error(`MCP server "${config.name}": ${config.transportType} transport requires a url`);
        }
        // Use SSE transport for both sse and http
        // Dynamic import since SSE transport may vary by SDK version
        try {
          const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
          transport = new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          } as any);
        } catch {
          // Fallback: try StreamableHTTP transport
          try {
            const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
            transport = new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: config.headers ? { headers: config.headers } : undefined,
            } as any);
          } catch {
            throw new Error(`MCP server "${config.name}": no SSE or HTTP transport available in MCP SDK`);
          }
        }
        break;
      }

      default:
        throw new Error(`MCP server "${config.name}": unknown transport type "${config.transportType}"`);
    }

    // Connect with timeout
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Connection to "${config.name}" timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    coworkLog('INFO', 'mcpClient', `Connected to "${config.name}", listing tools`);

    // List tools from the server
    const toolsResult = await client.listTools();
    const mcpTools = toolsResult.tools || [];

    coworkLog('INFO', 'mcpClient', `"${config.name}" exposes ${mcpTools.length} tools`);

    // Materialize each MCP tool as a ToolDefinition
    const toolDefs: ToolDefinition[] = mcpTools.map(mcpTool => {
      const toolName = `mcp__${config.name}__${mcpTool.name}`;

      // Convert JSON Schema to a permissive Zod schema
      // The actual validation is done server-side by the MCP server
      const inputSchema = z.record(z.string(), z.unknown());

      return buildTool({
        name: toolName,
        description: mcpTool.description
          ? `[MCP: ${config.name}] ${mcpTool.description}`
          : `[MCP: ${config.name}] ${mcpTool.name}`,
        inputSchema,
        call: async (input: Record<string, unknown>): Promise<ToolResult> => {
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: input,
            });

            // Convert MCP tool result to our ToolResult format
            const content = Array.isArray(result.content)
              ? result.content.map((c: any) => {
                  if (c.type === 'text') return { type: 'text' as const, text: c.text || '' };
                  if (c.type === 'image') return { type: 'text' as const, text: `[Image: ${c.mimeType || 'image'}]` };
                  return { type: 'text' as const, text: JSON.stringify(c) };
                })
              : [{ type: 'text' as const, text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }];

            return {
              content,
              isError: result.isError === true,
            };
          } catch (e) {
            return {
              content: [{ type: 'text', text: `MCP tool error (${config.name}/${mcpTool.name}): ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
        isConcurrencySafe: true, // MCP tools are generally safe to run concurrently
        isReadOnly: false, // We can't know — be conservative
      });
    });

    // Store the connection
    activeConnections.set(config.name, {
      name: config.name,
      client,
      transport,
      tools: toolDefs,
    });

    return toolDefs;

  } catch (e) {
    coworkLog('ERROR', 'mcpClient', `Failed to connect to "${config.name}": ${e instanceof Error ? e.message : String(e)}`);
    // Clean up on failure
    try { await client.close(); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Connect to multiple MCP servers in parallel.
 * Returns all tools from all servers, skipping servers that fail to connect.
 */
export async function connectAllMcpServers(
  configs: McpServerConfig[],
  timeoutMs: number = 30_000
): Promise<ToolDefinition[]> {
  if (configs.length === 0) return [];

  const results = await Promise.allSettled(
    configs.map(c => connectMcpServer(c, timeoutMs))
  );

  const allTools: ToolDefinition[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allTools.push(...result.value);
    } else {
      coworkLog('WARN', 'mcpClient', `MCP server "${configs[i].name}" failed: ${result.reason?.message || result.reason}`);
    }
  }

  coworkLog('INFO', 'mcpClient', `Connected ${results.filter(r => r.status === 'fulfilled').length}/${configs.length} MCP servers, ${allTools.length} total tools`);
  return allTools;
}

/**
 * Disconnect a single MCP server.
 */
export async function disconnectMcpServer(name: string): Promise<void> {
  const conn = activeConnections.get(name);
  if (!conn) return;

  try {
    await conn.client.close();
    coworkLog('INFO', 'mcpClient', `Disconnected from "${name}"`);
  } catch (e) {
    coworkLog('WARN', 'mcpClient', `Error disconnecting "${name}": ${e instanceof Error ? e.message : String(e)}`);
  }
  activeConnections.delete(name);
}

/**
 * Disconnect all MCP servers.
 */
export async function disconnectAllMcpServers(): Promise<void> {
  const names = Array.from(activeConnections.keys());
  await Promise.allSettled(names.map(n => disconnectMcpServer(n)));
}

/**
 * Get currently connected server names.
 */
export function getConnectedServers(): string[] {
  return Array.from(activeConnections.keys());
}
