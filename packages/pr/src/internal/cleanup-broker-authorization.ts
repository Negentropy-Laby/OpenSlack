import { Ajv2020 } from 'ajv/dist/2020.js';
import { isAlias, isScalar, parseDocument, visit } from 'yaml';
import { agentRegistryV2Schema, parseAgentRegistryText } from '@openslack/workspace';
import { authorizeAgentAction } from '@openslack/kernel';

const action = 'pr.cleanup_branch_scoped.v1' as const;
const legacy = 'pr.cleanup_branch';
const validateSchema = new Ajv2020({
  strict: false,
  allErrors: false,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
}).compile(agentRegistryV2Schema);

export interface CleanupBrokerRegistryExpectation {
  agentId: string;
  principalId: string;
  runtimeUid: string;
  runId: string;
  repository: string;
}

export class CleanupBrokerRegistryError extends Error {
  readonly code = 'BLOCKED_AUTHORIZATION';
  constructor() {
    super('CLEANUP_BROKER_REGISTRY_REJECTED');
    this.name = 'CleanupBrokerRegistryError';
  }
}

function reject(): never {
  throw new CleanupBrokerRegistryError();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}

function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const o = object(value);
  if (Object.keys(o).some((key) => !fields.includes(key))) reject();
  return o;
}

/**
 * Validate broker-acquired registry bytes, not their provenance. The caller must
 * already bind these exact bytes to the fixed authority and the expected
 * subject to authenticated OS peer evidence. This pure result is NOT a permit,
 * reservation, claim, or reusable authorization ticket; repeat at final send.
 */
export function validateCleanupBrokerRegistry(
  registryBytes: string,
  expected: CleanupBrokerRegistryExpectation,
): Readonly<CleanupBrokerRegistryExpectation & { action: typeof action }> {
  try {
    if (
      typeof registryBytes !== 'string' ||
      Buffer.byteLength(registryBytes, 'utf8') > 65_536 ||
      Buffer.from(registryBytes, 'utf8').toString('utf8') !== registryBytes ||
      !expected ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(expected.agentId) ||
      ![expected.principalId, expected.runtimeUid, expected.runId].every(
        (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v),
      ) ||
      typeof expected.repository !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(expected.repository)
    )
      reject();

    const document = parseDocument(registryBytes, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) reject();
    // There is one interpretation: no aliases, merge keys, anchors or custom
    // tags, including features the broad workspace parser normally permits.
    visit(document, (_key, node) => {
      if (isAlias(node)) reject();
      if (node && typeof node === 'object') {
        if (('anchor' in node && node.anchor) || ('tag' in node && node.tag)) reject();
        if ('key' in node && isScalar(node.key) && node.key.value === '<<') reject();
      }
    });
    const raw: unknown = document.toJS({ maxAliasCount: 0 });
    if (!validateSchema(raw)) reject();
    const data = object(raw);
    if (data.schema !== 'openslack.agent_registry.v2' || data.agent_id !== expected.agentId)
      reject();

    const identity = closed(data.identity, [
      'uid',
      'principal_id',
      'public_key_jwk',
      'key_id',
      'key_rotation',
      'status',
    ]);
    if (
      identity.status !== 'active' ||
      identity.principal_id !== expected.principalId ||
      identity.uid !== expected.runtimeUid
    )
      reject();
    closed(data.vendor, ['provider', 'runtime', 'model']);
    const employment = closed(data.employment, [
      'status',
      'hired_at',
      'hired_by',
      'department',
      'role',
      'manager',
    ]);
    if (employment.status !== 'active') reject();
    const repositories = closed(data.repositories, ['workspace_repo', 'allowed_product_repos']);
    const repo = closed(repositories.workspace_repo, ['owner', 'repo', 'default_branch']);
    if (`${repo.owner}/${repo.repo}` !== expected.repository || repo.default_branch !== 'main')
      reject();
    const permissions = closed(data.permissions, ['paths', 'actions', 'github', 'max_risk_zone']);
    closed(permissions.paths, ['allow', 'deny']);
    const github = closed(permissions.github, [
      'can_create_pr',
      'can_comment',
      'can_approve',
      'can_merge',
    ]);
    // The workspace parser forces these false; reject contradictory source
    // instead of silently normalizing elevated authority away.
    if (github.can_approve !== false || github.can_merge !== false) reject();
    const actions = object(permissions.actions);
    if (actions[action] !== 'allow' || actions[legacy] !== 'deny') reject();
    const rules = closed(data.approval_rules, ['require_human_approval_for']);
    const required = rules.require_human_approval_for as string[];
    if (required.includes(action) || required.includes('*')) reject();

    // The schema established every authority-sensitive field before invoking
    // the shared parser: neither v1 normalization nor missing-field defaults
    // can supply permission in this path.
    const registry = parseAgentRegistryText(registryBytes, expected.agentId);
    if (!registry || registry._source_schema !== 'openslack.agent_registry.v2') reject();
    const result = authorizeAgentAction({
      action,
      riskZone: 'yellow',
      snapshot: {
        principal: {
          registry_id: expected.agentId,
          runtime_uid: expected.runtimeUid,
          run_id: expected.runId,
          provider: 'cli',
        },
        registry_entry_agent_id: registry.agent_id,
        permissions: registry.permissions,
        source: 'registry_v2',
        resolved_at: '1970-01-01T00:00:00.000Z',
      },
    });
    if (result.decision !== 'allow') reject();
    return Object.freeze({
      agentId: expected.agentId,
      principalId: expected.principalId,
      runtimeUid: expected.runtimeUid,
      runId: expected.runId,
      repository: expected.repository,
      action,
    });
  } catch {
    // Do not surface YAML source snippets or parsed permission contents.
    throw new CleanupBrokerRegistryError();
  }
}
