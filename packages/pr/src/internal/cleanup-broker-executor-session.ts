import { parseAgentRegistryText } from '@openslack/workspace';
import { validateCleanupBrokerRegistry } from './cleanup-broker-authorization.js';
import {
  authorizeAgentAction,
  resolvePermissionSnapshot,
  type AgentPermissionSnapshot,
  type AgentPrincipal,
} from '@openslack/kernel';
import {
  isCleanupBrokerChannel,
  type CleanupBrokerChannel,
} from '../../../delivery/dist/internal/cleanup-broker-channel.js';
import type { CleanupBrokerSendBinding } from '../../../delivery/dist/internal/cleanup-broker-transport.js';

const sessions = new WeakMap<
  object,
  {
    binding: CleanupBrokerSendBinding;
    principal: AgentPrincipal;
    snapshot: AgentPermissionSnapshot;
  }
>();
export type CleanupBrokerSession = object;
function deny(): never {
  throw new Error('CLEANUP_BROKER_REGISTRY_DENIED');
}

/** Only private bundle composition supplies a real inherited broker channel.
 * The handle denotes process ownership, not independent OS authentication. */
export function createCleanupBrokerSession(
  channel: CleanupBrokerChannel,
  registryText: string,
  agentId: string,
  subject: { principalId: string; runtimeUid: string; runId: string },
  binding: CleanupBrokerSendBinding,
): CleanupBrokerSession {
  if (
    !isCleanupBrokerChannel(channel) ||
    typeof registryText !== 'string' ||
    Buffer.byteLength(registryText) > 65536
  )
    deny();
  validateCleanupBrokerRegistry(registryText, {
    agentId,
    ...subject,
    repository: binding.target.repository,
  });
  const registry = parseAgentRegistryText(registryText, agentId);
  if (
    !registry ||
    registry.schema !== 'openslack.agent_registry.v2' ||
    registry._source_schema !== 'openslack.agent_registry.v2' ||
    registry.agent_id !== agentId ||
    registry.identity.status !== 'active' ||
    registry.employment.status !== 'active' ||
    registry.identity.uid !== subject.runtimeUid ||
    registry.identity.principal_id !== subject.principalId ||
    registry.permissions.actions['pr.cleanup_branch'] !== 'deny' ||
    registry.permissions.actions['pr.cleanup_branch_scoped.v1'] !== 'allow'
  )
    deny();
  const snapshot = resolvePermissionSnapshot({
    registry,
    runtimeIdentity: {
      schema: 'openslack.agent_runtime_identity.v1',
      agent_id: agentId,
      agent_uid: subject.runtimeUid,
      run_id: subject.runId,
      provider: 'cli',
      public_key_jwk: null,
      key_id: null,
      key_generated_at: null,
      started_at: new Date().toISOString(),
    },
  });
  if (
    !snapshot ||
    authorizeAgentAction({ snapshot, action: 'pr.cleanup_branch_scoped.v1', riskZone: 'yellow' })
      .decision !== 'allow'
  )
    deny();
  const token = Object.freeze({});
  sessions.set(token, {
    binding: structuredClone(binding),
    principal: snapshot.principal,
    snapshot,
  });
  return token;
}
export function brokerSessionContext(session: CleanupBrokerSession) {
  const entry = sessions.get(session);
  if (!entry) deny();
  return { kind: 'agent' as const, principal: entry.principal, snapshot: entry.snapshot };
}
export function matchesBrokerSession(
  session: CleanupBrokerSession,
  input: { owner: string; repo: string; prNumber: number; context: unknown },
): boolean {
  const entry = sessions.get(session);
  if (!entry) return false;
  const target = entry.binding.target;
  const c = input.context as { kind?: string; principal?: AgentPrincipal };
  return (
    input.owner + '/' + input.repo === target.repository &&
    input.prNumber === target.prNumber &&
    c?.kind === 'agent' &&
    c.principal?.registry_id === entry.principal.registry_id &&
    c.principal?.runtime_uid === entry.principal.runtime_uid &&
    c.principal?.run_id === entry.principal.run_id
  );
}
export function brokerSessionTarget(
  session: CleanupBrokerSession,
): CleanupBrokerSendBinding['target'] {
  const entry = sessions.get(session);
  if (!entry) deny();
  return structuredClone(entry.binding.target);
}
