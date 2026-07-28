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

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const RUNTIME_PROVIDERS = new Set<AgentRuntimeIdentity['provider']>([
  'cli',
  'slack',
  'github',
  'webhook',
]);

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validateRuntimeIdentity(value: unknown): AgentRuntimeIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    data.schema !== 'openslack.agent_runtime_identity.v1' ||
    typeof data.agent_id !== 'string' ||
    !SAFE_AGENT_ID.test(data.agent_id) ||
    typeof data.agent_uid !== 'string' ||
    !SAFE_RUNTIME_ID.test(data.agent_uid) ||
    typeof data.run_id !== 'string' ||
    !SAFE_RUNTIME_ID.test(data.run_id) ||
    typeof data.provider !== 'string' ||
    !RUNTIME_PROVIDERS.has(data.provider as AgentRuntimeIdentity['provider']) ||
    !canonicalTimestamp(data.started_at) ||
    !(
      data.public_key_jwk === null ||
      (typeof data.public_key_jwk === 'object' && !Array.isArray(data.public_key_jwk))
    ) ||
    !(data.key_id === null || typeof data.key_id === 'string') ||
    !(data.key_generated_at === null || canonicalTimestamp(data.key_generated_at))
  ) {
    return null;
  }
  if (data.authenticated_github_identity !== undefined) {
    const github = data.authenticated_github_identity;
    if (
      !github ||
      typeof github !== 'object' ||
      Array.isArray(github) ||
      typeof (github as Record<string, unknown>).login !== 'string' ||
      typeof (github as Record<string, unknown>).is_bot !== 'boolean'
    ) {
      return null;
    }
  }
  return data as unknown as AgentRuntimeIdentity;
}

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
  if (!SAFE_AGENT_ID.test(agentId)) return null;
  const identityPath = join(root, '.openslack.local', 'agents', agentId, 'identity.yaml');
  if (!existsSync(identityPath)) return null;

  try {
    return parseRuntimeIdentityText(readFileSync(identityPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function parseRuntimeIdentityText(raw: string): AgentRuntimeIdentity | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) return null;
  try {
    return validateRuntimeIdentity(parseYaml(raw));
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
  if (
    !SAFE_AGENT_ID.test(agentId) ||
    !RUNTIME_PROVIDERS.has(provider as AgentRuntimeIdentity['provider'])
  ) {
    return { error: 'Agent reference or runtime provider is invalid' };
  }

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
  if (
    registry.agent_id !== agentId ||
    runtimeIdentity.agent_id !== agentId ||
    runtimeIdentity.agent_uid !== registry.identity.uid ||
    runtimeIdentity.provider !== provider
  ) {
    return {
      error: `Runtime identity for agent "${agentId}" does not match the active registry binding`,
    };
  }

  const snapshot = resolvePermissionSnapshot({ registry, runtimeIdentity });
  if (!snapshot) {
    return { error: `Failed to resolve permission snapshot for agent "${agentId}"` };
  }

  // Correct the source to reflect the original registry version
  const parsed = registry as ParsedAgentRegistryEntry;
  const effectiveSnapshot =
    parsed._source_schema === 'openslack.agent_registry.v1'
      ? Object.freeze({ ...snapshot, source: 'registry_v1' as const })
      : snapshot;

  return { principal: effectiveSnapshot.principal, snapshot: effectiveSnapshot };
}
