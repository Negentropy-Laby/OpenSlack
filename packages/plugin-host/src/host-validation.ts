import type {
  ActivationAuthorizationDecision,
  ActivationEvidence,
  HostPolicyDecision,
  PluginCapability,
  PluginProviderKind,
} from '@openslack/plugin-api';

const PROVIDER_KINDS = new Set<PluginProviderKind>(['built-in', 'bundled', 'workspace', 'plugin']);
const ACTOR_KINDS = new Set(['human', 'agent', 'system', 'application']);
const CAPABILITIES = new Set<PluginCapability>([
  'host.actions.read',
  'host.workflows.read',
  'workspace.read',
  'github.issues.read',
  'github.pull_requests.read',
  'github.checks.read',
  'collaboration.read',
  'host.actions.plan',
  'host.workflows.contribute',
  'prms.blockers.append',
  'github.issues.write',
  'github.pull_requests.comment',
  'github.pull_requests.merge.request',
  'collaboration.write',
  'workflow.execute',
]);
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export class HostInputValidationError extends Error {
  readonly code:
    | 'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID'
    | 'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH'
    | 'PLUGIN_HOST_POLICY_DECISION_INVALID'
    | 'PLUGIN_HOST_VERSION_INCOMPATIBLE';
  readonly path: string;

  constructor(code: HostInputValidationError['code'], path: string, message: string) {
    super(message);
    this.name = 'HostInputValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: HostInputValidationError['code'], path: string, message: string): never {
  throw new HostInputValidationError(code, path, message);
}

function dataObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID', path, 'Expected a plain data object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      path,
      'Custom prototypes are forbidden.',
    );
  }
  const allowed = new Set([...required, ...optional]);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return fail(
        'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
        path,
        'Evidence contains an unknown or symbol field.',
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(
        'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
        `${path}/${key}`,
        'Evidence fields must be enumerable data properties.',
      );
    }
    output[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key)) {
      return fail(
        'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
        `${path}/${key}`,
        'Required evidence field is missing.',
      );
    }
  }
  return output;
}

function boundedString(value: unknown, path: string, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Array.from(value).length > max ||
    !SAFE_TEXT.test(value)
  ) {
    return fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      path,
      'Expected bounded control-free text.',
    );
  }
  return value;
}

function stringArray(value: unknown, path: string, maxItems = 32): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    return fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      path,
      'Expected a bounded evidence reference array.',
    );
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((item, index) => {
      const text = boundedString(item, `${path}/${index}`);
      if (seen.has(text))
        fail(
          'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
          `${path}/${index}`,
          'Duplicate evidence reference.',
        );
      seen.add(text);
      return text;
    }),
  );
}

export interface DeclarativeEvidenceExpectation {
  readonly id: string;
  readonly version: string;
  readonly providerKind: 'workspace' | 'plugin';
  readonly sourceRef: string;
  readonly manifestSha256: string;
  readonly lockManifestSha256: string;
}

export interface BundledEvidenceExpectation {
  readonly id: string;
  readonly version: string;
  readonly providerKind: 'bundled';
  readonly compositionId: string;
}

export type ActivationEvidenceExpectation =
  | DeclarativeEvidenceExpectation
  | BundledEvidenceExpectation;

export function normalizeActivationEvidence(
  value: unknown,
  expected: ActivationEvidenceExpectation,
): ActivationEvidence {
  const root = dataObject(value, '', [
    'schema',
    'plugin',
    'observedAt',
    'actor',
    'humanApproval',
    'providerKind',
    'source',
  ]);
  if (root.schema !== 'openslack.plugin_activation_evidence.v1') {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      '/schema',
      'Activation evidence schema is unsupported.',
    );
  }
  if (
    !PROVIDER_KINDS.has(root.providerKind as PluginProviderKind) ||
    root.providerKind !== expected.providerKind
  ) {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH',
      '/providerKind',
      'Provider kind does not match the host-owned plugin record.',
    );
  }
  const plugin = dataObject(root.plugin, '/plugin', ['id', 'version']);
  const pluginId = boundedString(plugin.id, '/plugin/id', 64);
  const pluginVersion = boundedString(plugin.version, '/plugin/version', 128);
  if (pluginId !== expected.id || pluginVersion !== expected.version) {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH',
      '/plugin',
      'Plugin identity does not match the host-owned plugin record.',
    );
  }
  const observedAt = boundedString(root.observedAt, '/observedAt', 64);
  if (!Number.isFinite(Date.parse(observedAt))) {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      '/observedAt',
      'Observed time must be an ISO-compatible timestamp.',
    );
  }
  const actor = dataObject(root.actor, '/actor', ['id', 'kind', 'provider']);
  const actorId = boundedString(actor.id, '/actor/id', 128);
  if (!ACTOR_KINDS.has(actor.kind as string))
    fail('PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID', '/actor/kind', 'Unknown actor kind.');
  const actorProvider = boundedString(actor.provider, '/actor/provider', 64);

  const approval = dataObject(root.humanApproval, '/humanApproval', [
    'required',
    'satisfied',
    'evidenceRefs',
  ]);
  if (typeof approval.required !== 'boolean' || typeof approval.satisfied !== 'boolean') {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      '/humanApproval',
      'Approval flags must be boolean.',
    );
  }
  const approvalRefs = stringArray(approval.evidenceRefs, '/humanApproval/evidenceRefs');
  if (approval.required && approval.satisfied && approvalRefs.length === 0) {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      '/humanApproval/evidenceRefs',
      'A claimed human approval requires evidence references.',
    );
  }

  const base = {
    schema: 'openslack.plugin_activation_evidence.v1' as const,
    plugin: Object.freeze({ id: pluginId, version: pluginVersion }),
    observedAt,
    actor: Object.freeze({ id: actorId, kind: actor.kind, provider: actorProvider }),
    humanApproval: Object.freeze({
      required: approval.required,
      satisfied: approval.satisfied,
      evidenceRefs: approvalRefs,
    }),
  };

  if (expected.providerKind === 'bundled') {
    const source = dataObject(root.source, '/source', [
      'kind',
      'compositionId',
      'reviewEvidenceRefs',
    ]);
    if (source.kind !== 'bundled' || source.compositionId !== expected.compositionId) {
      fail(
        'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH',
        '/source',
        'Bundled source does not match the sealed host composition.',
      );
    }
    return Object.freeze({
      ...base,
      providerKind: 'bundled' as const,
      source: Object.freeze({
        kind: 'bundled' as const,
        compositionId: boundedString(source.compositionId, '/source/compositionId', 128),
        reviewEvidenceRefs: stringArray(source.reviewEvidenceRefs, '/source/reviewEvidenceRefs'),
      }),
    }) as ActivationEvidence;
  }

  const source = dataObject(root.source, '/source', [
    'kind',
    'sourceRef',
    'manifestSha256',
    'lockManifestSha256',
    'integrityMatched',
  ]);
  if (
    source.kind !== 'locked_manifest' ||
    source.sourceRef !== expected.sourceRef ||
    source.manifestSha256 !== expected.manifestSha256 ||
    source.lockManifestSha256 !== expected.lockManifestSha256 ||
    source.integrityMatched !== true
  ) {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH',
      '/source',
      'Activation evidence does not match the integrity-verified byte snapshot.',
    );
  }
  if (
    !HASH.test(source.manifestSha256 as string) ||
    !HASH.test(source.lockManifestSha256 as string)
  ) {
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      '/source',
      'Manifest hashes must be lowercase SHA-256 values.',
    );
  }
  return Object.freeze({
    ...base,
    providerKind: expected.providerKind,
    source: Object.freeze({
      kind: 'locked_manifest' as const,
      sourceRef: boundedString(source.sourceRef, '/source/sourceRef', 512),
      manifestSha256: source.manifestSha256,
      lockManifestSha256: source.lockManifestSha256,
      integrityMatched: true,
    }),
  }) as ActivationEvidence;
}

function capabilityArray(value: unknown, path: string): readonly PluginCapability[] {
  if (!Array.isArray(value) || value.length > 32) {
    return fail(
      'PLUGIN_HOST_POLICY_DECISION_INVALID',
      path,
      'Policy capabilities must be a bounded array.',
    );
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((item, index) => {
      if (
        typeof item !== 'string' ||
        !CAPABILITIES.has(item as PluginCapability) ||
        seen.has(item)
      ) {
        fail(
          'PLUGIN_HOST_POLICY_DECISION_INVALID',
          `${path}/${index}`,
          'Policy returned an unknown or duplicate capability.',
        );
      }
      seen.add(item);
      return item as PluginCapability;
    }),
  );
}

export function normalizeActivationDecision(value: unknown): ActivationAuthorizationDecision {
  const common = dataObject(
    value,
    '/policyDecision',
    ['outcome', 'code', 'reason', 'evidenceRefs'],
    ['hostAllowedCapabilities', 'actorAllowedCapabilities'],
  );
  if (common.outcome !== 'allow' && common.outcome !== 'ask' && common.outcome !== 'deny') {
    fail(
      'PLUGIN_HOST_POLICY_DECISION_INVALID',
      '/policyDecision/outcome',
      'Policy outcome is invalid.',
    );
  }
  const code = boundedString(common.code, '/policyDecision/code', 128);
  const reason = boundedString(common.reason, '/policyDecision/reason', 512);
  const evidenceRefs = stringArray(common.evidenceRefs, '/policyDecision/evidenceRefs');
  if (common.outcome === 'allow') {
    if (code !== 'PLUGIN_ACTIVATION_ALLOWED')
      fail(
        'PLUGIN_HOST_POLICY_DECISION_INVALID',
        '/policyDecision/code',
        'Allow decision code is invalid.',
      );
    if (
      !Object.hasOwn(common, 'hostAllowedCapabilities') ||
      !Object.hasOwn(common, 'actorAllowedCapabilities')
    ) {
      fail(
        'PLUGIN_HOST_POLICY_DECISION_INVALID',
        '/policyDecision',
        'Allow decision is missing capability bounds.',
      );
    }
    return Object.freeze({
      outcome: 'allow' as const,
      code: 'PLUGIN_ACTIVATION_ALLOWED' as const,
      reason,
      hostAllowedCapabilities: capabilityArray(
        common.hostAllowedCapabilities,
        '/policyDecision/hostAllowedCapabilities',
      ),
      actorAllowedCapabilities: capabilityArray(
        common.actorAllowedCapabilities,
        '/policyDecision/actorAllowedCapabilities',
      ),
      evidenceRefs,
    });
  }
  if (
    Object.hasOwn(common, 'hostAllowedCapabilities') ||
    Object.hasOwn(common, 'actorAllowedCapabilities')
  ) {
    fail(
      'PLUGIN_HOST_POLICY_DECISION_INVALID',
      '/policyDecision',
      'Non-allow decisions cannot grant capabilities.',
    );
  }
  return Object.freeze({
    outcome: common.outcome,
    code,
    reason,
    evidenceRefs,
  }) as ActivationAuthorizationDecision;
}

export function normalizeHostPolicyDecision(value: unknown): HostPolicyDecision {
  const decision = dataObject(value, '/policyDecision', [
    'outcome',
    'code',
    'reason',
    'evidenceRefs',
  ]);
  if (decision.outcome !== 'allow' && decision.outcome !== 'ask' && decision.outcome !== 'deny') {
    fail(
      'PLUGIN_HOST_POLICY_DECISION_INVALID',
      '/policyDecision/outcome',
      'Policy outcome is invalid.',
    );
  }
  return Object.freeze({
    outcome: decision.outcome,
    code: boundedString(decision.code, '/policyDecision/code', 128),
    reason: boundedString(decision.reason, '/policyDecision/reason', 512),
    evidenceRefs: stringArray(decision.evidenceRefs, '/policyDecision/evidenceRefs'),
  }) as HostPolicyDecision;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): Version | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  const match = /^(\^|~|>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const target = { major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
  const comparison = compareVersion(version, target);
  if (operator === '=') return comparison === 0;
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '<=') return comparison <= 0;
  if (comparison < 0) return false;
  const upper =
    operator === '~'
      ? { major: target.major, minor: target.minor + 1, patch: 0 }
      : target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0 }
        : target.minor > 0
          ? { major: 0, minor: target.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: target.patch + 1 };
  return compareVersion(version, upper) < 0;
}

export function assertCompatibleOpenSlackVersion(hostVersion: string, range: string): void {
  const version = parseVersion(hostVersion);
  if (
    !version ||
    !range.split(' ').every((part) => part.length > 0 && satisfiesComparator(version, part))
  ) {
    fail(
      'PLUGIN_HOST_VERSION_INCOMPATIBLE',
      '/requires/openslack',
      `OpenSlack ${hostVersion} does not satisfy ${range}.`,
    );
  }
}

export function assertHostIdentifier(value: unknown, path: string, max = 128): string {
  const result = boundedString(value, path, max);
  if (!ID.test(result))
    fail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      path,
      'Identifier is outside the host namespace grammar.',
    );
  return result;
}
