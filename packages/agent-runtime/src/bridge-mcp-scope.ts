/**
 * Bridge MCP Scope — discovers MCP servers from launcher config, includes in
 * session init envelope. External runtime reports which MCP servers it provides.
 * Validates required MCP availability before session start.
 *
 * MCP tool namespacing: mcp.<server>.<tool>
 *
 * AR-2.6: MCP Runtime Scope
 */

import type { BridgeMcpServerDescriptor } from './bridge-contract.js';
import { AgentUnavailableError } from './types.js';

export interface McpServerNegotiationResult {
  /** Servers that are available and matched. */
  available: BridgeMcpServerDescriptor[];
  /** Servers that are required but missing. */
  missing: BridgeMcpServerDescriptor[];
  /** All MCP tool names with mcp.<server>.<tool> namespace. */
  namespacedTools: string[];
}

/**
 * Negotiate MCP server availability between requested and available servers.
 *
 * @param requested - MCP servers requested by the agent/config.
 * @param available - MCP servers provided by the bridge runtime.
 * @returns Negotiation result with available, missing, and namespaced tools.
 */
export function negotiateMcpServers(
  requested: BridgeMcpServerDescriptor[],
  available: string[],
): McpServerNegotiationResult {
  if (requested.length === 0) {
    return { available: [], missing: [], namespacedTools: [] };
  }

  const matched: BridgeMcpServerDescriptor[] = [];
  const missing: BridgeMcpServerDescriptor[] = [];
  const namespacedTools: string[] = [];

  for (const server of requested) {
    if (available.includes(server.name)) {
      matched.push(server);
      // Generate namespaced tools
      if (server.tools && server.tools.length > 0) {
        for (const tool of server.tools) {
          namespacedTools.push(`mcp.${server.name}.${tool}`);
        }
      }
    } else {
      missing.push(server);
    }
  }

  return { available: matched, missing, namespacedTools };
}

/**
 * Validate that all required MCP servers are available.
 * Throws AgentUnavailableError if any required server is missing.
 */
export function validateRequiredMcpServers(
  requested: BridgeMcpServerDescriptor[],
  available: string[],
): void {
  const result = negotiateMcpServers(requested, available);

  const requiredMissing = result.missing.filter((s) => s.required !== false);
  if (requiredMissing.length > 0) {
    throw new AgentUnavailableError(requiredMissing.map((s) => s.name));
  }
}

/**
 * Parse MCP tool names from a permission profile's allowedTools list.
 * Returns tools that match the mcp.<server>.<tool> pattern.
 */
export function extractMcpToolsFromProfile(allowedTools: string[]): {
  mcpTools: string[];
  nonMcpTools: string[];
} {
  const mcpTools: string[] = [];
  const nonMcpTools: string[] = [];

  for (const tool of allowedTools) {
    if (tool.startsWith('mcp.')) {
      mcpTools.push(tool);
    } else {
      nonMcpTools.push(tool);
    }
  }

  return { mcpTools, nonMcpTools };
}

/**
 * Validate that namespaced MCP tools reference available servers.
 */
export function validateMcpToolNamespace(
  mcpTools: string[],
  availableServers: string[],
): {
  valid: string[];
  invalid: Array<{ tool: string; reason: string }>;
} {
  const valid: string[] = [];
  const invalid: Array<{ tool: string; reason: string }> = [];

  for (const tool of mcpTools) {
    const parts = tool.split('.');
    // Expected format: mcp.<server>.<tool>
    if (parts.length < 3) {
      invalid.push({ tool, reason: 'Invalid MCP tool namespace format' });
      continue;
    }

    // Reject degenerate names like 'mcp..tool' (empty server) or 'mcp.server.' (empty tool)
    if (!parts[1] || !parts[2]) {
      invalid.push({ tool, reason: 'Empty server or tool name in namespace' });
      continue;
    }

    const serverName = parts[1];
    if (!availableServers.includes(serverName)) {
      invalid.push({
        tool,
        reason: `MCP server "${serverName}" is not available`,
      });
    } else {
      valid.push(tool);
    }
  }

  return { valid, invalid };
}

/**
 * Build BridgeMcpServerDescriptor list from string names.
 */
export function buildMcpServerDescriptors(
  serverNames: string[],
  options?: { required?: boolean; version?: string },
): BridgeMcpServerDescriptor[] {
  return serverNames.map((name) => ({
    name,
    required: options?.required ?? true,
    version: options?.version,
  }));
}
