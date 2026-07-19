import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseAgentRegistry } from '@openslack/workspace';
import type { ParsedAgentRegistryEntry } from '@openslack/workspace';
import { resolvePermissionSnapshot } from '@openslack/kernel';
import type {
  AgentRuntimeIdentity,
  AgentPrincipal,
  AgentPermissionSnapshot,
} from '@openslack/kernel';

function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `RUN-${ts}-${rand}`;
}

export function generateRuntimeIdentity(args: {
  root: string;
  agentId: string;
  provider: string;
}): AgentRuntimeIdentity {
  const { root, agentId, provider } = args;
  const registry = parseAgentRegistry(root, agentId);
  const agentUid = registry?.identity.uid || agentId;
  const runId = generateRunId();

  const identity: AgentRuntimeIdentity = {
    schema: 'openslack.agent_runtime_identity.v1',
    agent_id: agentId,
    agent_uid: agentUid,
    run_id: runId,
    public_key_jwk: null,
    key_id: null,
    key_generated_at: null,
    provider: provider as AgentRuntimeIdentity['provider'],
    started_at: new Date().toISOString(),
  };

  // Merge into existing local identity file without clobbering credentials/paths/preferences
  const identityDir = join(root, '.openslack.local', 'agents', agentId);
  const identityPath = join(identityDir, 'identity.yaml');

  let existing: Record<string, unknown> = {};
  if (existsSync(identityPath)) {
    try {
      existing = (parseYaml(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>) || {};
    } catch {
      /* ignore parse errors */
    }
  }

  const merged = {
    ...existing,
    schema: identity.schema,
    agent_id: identity.agent_id,
    agent_uid: identity.agent_uid,
    run_id: identity.run_id,
    public_key_jwk: identity.public_key_jwk,
    key_id: identity.key_id,
    key_generated_at: identity.key_generated_at,
    provider: identity.provider,
    started_at: identity.started_at,
  };

  mkdirSync(identityDir, { recursive: true });
  writeFileSync(identityPath, stringifyYaml(merged, { lineWidth: 0 }), 'utf-8');

  return identity;
}

export function loadRuntimeIdentity(root: string, agentId: string): AgentRuntimeIdentity | null {
  const identityPath = join(root, '.openslack.local', 'agents', agentId, 'identity.yaml');
  if (!existsSync(identityPath)) return null;

  try {
    const data = parseYaml(readFileSync(identityPath, 'utf-8')) as Record<string, unknown>;
    if (!data || data.schema !== 'openslack.agent_runtime_identity.v1') return null;
    return data as unknown as AgentRuntimeIdentity;
  } catch {
    return null;
  }
}

export function resolveAgentPrincipal(args: {
  root: string;
  agentId: string;
  provider?: string;
}): { principal: AgentPrincipal; snapshot: AgentPermissionSnapshot } | { error: string } {
  const { root, agentId, provider = 'cli' } = args;

  const registry = parseAgentRegistry(root, agentId);
  if (!registry) {
    return { error: `Agent "${agentId}" not found in registry` };
  }

  if (registry.identity.status !== 'active') {
    return {
      error: `Agent "${agentId}" identity status is "${registry.identity.status}", expected "active"`,
    };
  }

  const runtimeIdentity = loadRuntimeIdentity(root, agentId);
  if (!runtimeIdentity) {
    return {
      error: `No runtime identity for agent "${agentId}". Run: openslack agent bootstrap --agent-id ${agentId}`,
    };
  }

  const snapshot = resolvePermissionSnapshot({ registry, runtimeIdentity });
  if (!snapshot) {
    return { error: `Failed to resolve permission snapshot for agent "${agentId}"` };
  }

  // Correct the source to reflect the original registry version
  const parsed = registry as ParsedAgentRegistryEntry;
  if (parsed._source_schema === 'openslack.agent_registry.v1') {
    (snapshot as { source: string }).source = 'registry_v1';
  }

  return { principal: snapshot.principal, snapshot };
}
