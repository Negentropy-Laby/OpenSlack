import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ResolvedAgentConfig } from './types.js';
import { isAbyRuntime } from './bridge-runtime-resolver.js';

export interface AgentRuntimeRegistryEntry {
  agentId: string;
  sourcePath: string;
  runtime?: string;
  provider?: string;
  bridgeMode?: ResolvedAgentConfig['bridgeMode'];
  mcpServers: string[];
  requiredMcpServers: string[];
}

export function listAgentRuntimeRegistryEntries(rootDir = process.cwd()): AgentRuntimeRegistryEntry[] {
  const registryDir = join(rootDir, '.openslack', 'agents', 'registry');
  if (!existsSync(registryDir)) return [];

  const entries: AgentRuntimeRegistryEntry[] = [];
  for (const file of readdirSync(registryDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const sourcePath = join(registryDir, file);
    const parsed = parseRegistryEntry(sourcePath);
    if (parsed) entries.push(parsed);
  }

  return entries.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function listAbyRuntimeAgents(rootDir = process.cwd()): AgentRuntimeRegistryEntry[] {
  return listAgentRuntimeRegistryEntries(rootDir).filter((entry) =>
    isAbyRuntime({
      agentId: entry.agentId,
      source: 'openslack-registry',
      runtime: entry.runtime,
      provider: entry.provider,
    }),
  );
}

export function findAgentRuntimeRegistryEntry(
  agentId: string,
  rootDir = process.cwd(),
): AgentRuntimeRegistryEntry | null {
  return listAgentRuntimeRegistryEntries(rootDir).find((entry) => entry.agentId === agentId) ?? null;
}

function parseRegistryEntry(sourcePath: string): AgentRuntimeRegistryEntry | null {
  let data: unknown;
  try {
    data = parseYaml(readFileSync(sourcePath, 'utf-8'));
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const agentId = readString(record.agent_id) ?? readString(record.agentId);
  if (!agentId) return null;

  const vendor = isRecord(record.vendor) ? record.vendor : {};
  const runtimeBlock = isRecord(record.runtime) ? record.runtime : {};
  const mcpBlock = isRecord(record.mcp) ? record.mcp : {};

  return {
    agentId,
    sourcePath,
    provider: readString(vendor.provider) ?? readString(record.provider),
    runtime: readString(vendor.runtime) ?? readString(record.runtime),
    bridgeMode: readBridgeMode(runtimeBlock.bridgeMode ?? record.bridgeMode),
    mcpServers: readStringList(
      record.mcpServers ??
        record.mcp_servers ??
        mcpBlock.available ??
        mcpBlock.servers ??
        runtimeBlock.mcpServers,
    ),
    requiredMcpServers: readStringList(
      record.requiredMcpServers ??
        record.required_mcp_servers ??
        mcpBlock.required ??
        runtimeBlock.requiredMcpServers,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      names.add(item.trim());
      continue;
    }
    if (isRecord(item)) {
      const named = readString(item.name);
      if (named) {
        names.add(named);
        continue;
      }
      for (const key of Object.keys(item)) {
        if (key.trim()) names.add(key.trim());
      }
    }
  }
  return [...names].sort();
}

function readBridgeMode(value: unknown): ResolvedAgentConfig['bridgeMode'] | undefined {
  return value === 'local' || value === 'external-command' || value === 'process' || value === 'fake'
    ? value
    : undefined;
}
