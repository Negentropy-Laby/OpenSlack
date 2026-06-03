import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { discoverSubagents } from '@openslack/workspace';
import type { SubagentDefinition } from '@openslack/kernel';
import type { ResolvedAgentConfig } from '@openslack/agent-runtime';

/**
 * Cache for discoverSubagents results to avoid repeated directory scans.
 */
let cache: { agents: SubagentDefinition[]; ts: number; rootDir: string } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

function discoverSubagentsCached(rootDir: string): SubagentDefinition[] {
  const now = Date.now();
  if (cache && cache.rootDir === rootDir && now - cache.ts < CACHE_TTL) return cache.agents;
  const agents = discoverSubagents(rootDir);
  cache = { agents, ts: now, rootDir };
  return agents;
}

/**
 * Clear the subagent discovery cache. Exported for testing only.
 */
export function clearSubagentCache(): void {
  cache = null;
}

export type { ResolvedAgentConfig } from '@openslack/agent-runtime';

/**
 * Read YAML files from a directory (non-recursive).
 */
function readYamlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return [];
  }
}

/**
 * Parse an OpenSlack registry YAML file and extract fields relevant
 * to agent execution.
 */
function parseRegistryYaml(
  content: string,
  filePath: string,
): { agentId: string; model?: string; bridgeMode?: string } | null {
  let data: Record<string, unknown>;
  try {
    data = parseYaml(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.schema !== 'openslack.agent_registry.v1') return null;

  const agentId = data.agent_id as string | undefined;
  if (!agentId || typeof agentId !== 'string') return null;

  const vendor = data.vendor as Record<string, unknown> | undefined;
  const model = vendor?.model as string | undefined;
  const runtime = vendor?.runtime as string | undefined;
  const provider = vendor?.provider as string | undefined;

  // Map bridge hint from runtime/provider fields
  let bridgeMode: ResolvedAgentConfig['bridgeMode'] | undefined;
  if (runtime === 'aby_assistant' || provider === 'aby') {
    bridgeMode = 'process';
  }

  return {
    agentId,
    model: model === 'default' ? undefined : model,
    bridgeMode,
  };
}

/**
 * Look for agentType in the OpenSlack registry (.openslack/agents/registry/).
 * Returns a partial ResolvedAgentConfig if found, or null.
 */
function lookupOpenSlackRegistry(agentType: string, rootDir: string): ResolvedAgentConfig | null {
  const registryDir = join(rootDir, '.openslack', 'agents', 'registry');
  if (!existsSync(registryDir)) return null;

  const files = readYamlFiles(registryDir);
  for (const file of files) {
    const fullPath = join(registryDir, file);
    const content = readFileSync(fullPath, 'utf-8');
    const parsed = parseRegistryYaml(content, fullPath);
    if (parsed && parsed.agentId === agentType) {
      return {
        agentId: parsed.agentId,
        source: 'openslack-registry',
        model: parsed.model,
        bridgeMode: parsed.bridgeMode as ResolvedAgentConfig['bridgeMode'],
      };
    }
  }

  return null;
}

/**
 * Resolve an agent type string to a concrete agent configuration.
 *
 * Resolution order:
 * 1. OpenSlack registry: `.openslack/agents/registry/*.yaml`
 * 2. Claude Code subagents: `.claude/agents/*.md` (project-level, then user-level)
 *
 * Returns null if the agentType is not found anywhere.
 * Does NOT throw for unknown agent types.
 */
export function resolveAgentType(agentType: string, rootDir: string): ResolvedAgentConfig | null {
  // 1. OpenSlack registry
  const registryMatch = lookupOpenSlackRegistry(agentType, rootDir);
  if (registryMatch) return registryMatch;

  // 2. Claude Code subagents (project-level > user-level priority)
  const all = discoverSubagentsCached(rootDir);
  const projectMatch = all.find((d) => d.id === agentType && d.source === 'claude-project');
  const subagent =
    projectMatch || all.find((d) => d.id === agentType && d.source === 'claude-user');
  if (subagent) {
    return {
      agentId: subagent.id,
      source: subagent.source,
      model: subagent.model,
      tools: subagent.tools,
      disallowedTools: subagent.disallowedTools,
      permissionMode: subagent.permissionMode,
      isolation: subagent.isolation,
      prompt: subagent.prompt,
      effort: subagent.effort,
      hooks: subagent.hooks,
      initialPrompt: subagent.initialPrompt,
      background: subagent.background,
      requiredMcpServers: subagent.requiredMcpServers,
      criticalSystemReminder: subagent.criticalSystemReminder,
      remote: subagent.remote,
      bridgeMode: subagent.bridgeMode,
    };
  }

  return null;
}
