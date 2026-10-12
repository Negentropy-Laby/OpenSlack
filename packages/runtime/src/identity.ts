import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseAgentRegistry, parseRuntimeIdentityText } from '@openslack/workspace';
export { parseRuntimeIdentityText } from '@openslack/workspace';
import type { ParsedAgentRegistryEntry } from '@openslack/workspace';
import { resolvePermissionSnapshot } from '@openslack/kernel';
import type {
  AgentRuntimeIdentity,
  AgentPrincipal,
  AgentPermissionSnapshot,
} from '@openslack/kernel';

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUNTIME_PROVIDERS = new Set<AgentRuntimeIdentity['provider']>([
  'cli',
  'slack',
  'github',
  'webhook',
]);

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

interface AgentBindingInput {
  root: string;
  agentId: string;
  provider?: string;
}
function readAgentBinding(
  { root, agentId, provider = 'cli' }: AgentBindingInput,
  requireActive: boolean,
) {
  if (
    !SAFE_AGENT_ID.test(agentId) ||
    !RUNTIME_PROVIDERS.has(provider as AgentRuntimeIdentity['provider'])
  )
    return { error: 'Agent reference or runtime provider is invalid' };
  const registry = parseAgentRegistry(root, agentId);
  if (!registry) return { error: `Agent "${agentId}" not found in registry` };
  if (requireActive && registry.identity.status !== 'active')
    return {
      error: `Agent "${agentId}" identity status is "${registry.identity.status}", expected "active"`,
    };
  const runtimeIdentity = loadRuntimeIdentity(root, agentId);
  if (!runtimeIdentity)
    return {
      error: `No runtime identity for agent "${agentId}". Run: openslack agent bootstrap --agent-id ${agentId}`,
    };
  if (
    registry.agent_id !== agentId ||
    runtimeIdentity.agent_id !== agentId ||
    runtimeIdentity.agent_uid !== registry.identity.uid ||
    runtimeIdentity.provider !== provider
  )
    return {
      error: `Runtime identity for agent "${agentId}" does not match the active registry binding`,
    };
  return { registry, runtimeIdentity };
}

/** Historical query claims only: no admission, snapshot or bootstrap. */
export function resolveAgentStatusBinding(
  args: AgentBindingInput,
): { principal: AgentPrincipal; principalId: string; snapshot?: never } | { error: string } {
  const binding = readAgentBinding(args, false);
  if ('error' in binding) return { error: binding.error! };
  return {
    principalId: binding.registry.identity.principal_id,
    principal: {
      registry_id: binding.registry.agent_id,
      runtime_uid: binding.runtimeIdentity.agent_uid,
      run_id: binding.runtimeIdentity.run_id,
      provider: binding.runtimeIdentity.provider,
    },
  };
}

export function resolveAgentPrincipal(
  args: AgentBindingInput,
):
  | { principal: AgentPrincipal; principalId: string; snapshot: AgentPermissionSnapshot }
  | { error: string } {
  const binding = readAgentBinding(args, true);
  if ('error' in binding) return { error: binding.error! };
  const { registry, runtimeIdentity } = binding;
  const { agentId } = args;

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

  return {
    principal: effectiveSnapshot.principal,
    principalId: registry.identity.principal_id,
    snapshot: effectiveSnapshot,
  };
}
