import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export const WORKFLOW_START_PLAN_SCHEMA = 'openslack.workflow_start_plan.v1' as const;
export const WORKFLOW_START_EFFECT_SCHEMA = 'openslack.workflow_start_effect.v1' as const;

export type WorkflowPlanRisk = 'low' | 'medium' | 'high';
export type WorkflowAuthorityProvider = 'github' | 'openslack' | 'dingtalk' | 'crm' | 'erp' | 'hr';

export interface WorkflowAuthorityRequirement {
  readonly provider: WorkflowAuthorityProvider;
  readonly objectType: string;
  readonly credentialRequired: boolean;
}

export interface WorkflowPlanResolverEntry {
  readonly id: string;
  readonly version: string;
  readonly adapterId: string;
  readonly executorId: string;
  readonly workflowHash: string;
  readonly risk: WorkflowPlanRisk;
  readonly capabilityIds: readonly string[];
  readonly authorityRequirements: readonly WorkflowAuthorityRequirement[];
}

export interface WorkflowAuthorityBinding {
  readonly provider: WorkflowAuthorityProvider;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string;
  readonly observedAt: string;
  readonly credentialBindingId: string | null;
}

export interface WorkflowStartEffect {
  readonly schema: typeof WORKFLOW_START_EFFECT_SCHEMA;
  readonly effectId: string;
  readonly kind: 'workflow.start';
  readonly executorId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowHash: string;
  readonly adapterId: string;
  readonly correlationId: string;
  readonly normalizedInput: unknown;
  readonly inputHash: string;
  readonly authorityBindings: readonly WorkflowAuthorityBinding[];
  readonly capabilityIds: readonly string[];
  readonly risk: WorkflowPlanRisk;
}

export interface WorkflowStartPlan {
  readonly schema: typeof WORKFLOW_START_PLAN_SCHEMA;
  readonly planId: string;
  readonly planHash: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly workflow: WorkflowPlanResolverEntry;
  readonly normalizedInput: unknown;
  readonly inputHash: string;
  readonly authorityBindings: readonly WorkflowAuthorityBinding[];
  readonly effect: WorkflowStartEffect;
  readonly risk: WorkflowPlanRisk;
  readonly requiresConfirmation: true;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateSealedWorkflowPlanResolverInput {
  readonly entries: readonly WorkflowPlanResolverEntry[];
}

export interface CompileWorkflowStartPlanInput {
  readonly resolver: SealedWorkflowPlanResolver;
  readonly workflowId: string;
  readonly input: unknown;
  readonly authorityBindings: readonly WorkflowAuthorityBinding[];
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class WorkflowPlanError extends Error {
  readonly code:
    | 'WORKFLOW_PLAN_RESOLVER_INVALID'
    | 'WORKFLOW_PLAN_RESOLVER_SEALED_REQUIRED'
    | 'WORKFLOW_PLAN_TARGET_MISSING'
    | 'WORKFLOW_PLAN_INPUT_INVALID'
    | 'WORKFLOW_PLAN_AUTHORITY_INVALID'
    | 'WORKFLOW_PLAN_EXPIRED';

  constructor(code: WorkflowPlanError['code'], message: string) {
    super(message);
    this.name = 'WorkflowPlanError';
    this.code = code;
  }
}

type DataRecord = Record<string, unknown>;

const SEALED_RESOLVERS = new WeakSet<object>();
const IDENTIFIER = /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)*$/;
const RUNTIME_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HASH = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ACTIVE_CONTENT = /(?:https?:\/\/|javascript:|data:text\/html|<\s*script\b|<\s*iframe\b)/i;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{12,})/i;
const FORBIDDEN_INPUT_KEYS = new Set([
  'allowunattended',
  'confirmstep',
  'path',
  'module',
  'modulepath',
  'entrypoint',
  'command',
  'shell',
  'url',
  'repo',
  'repository',
  'githubrepo',
  'owner',
  'auth',
  'authentication',
  'token',
  'credential',
  'credentialbindingid',
]);
const FORBIDDEN_CAPABILITIES = new Set([
  'github.pr.approve',
  'github.pr.merge',
  'github.prs.approve',
  'github.prs.merge',
  'shell.run',
  'command.run',
]);
const PROVIDERS = new Set<WorkflowAuthorityProvider>([
  'github',
  'openslack',
  'dingtalk',
  'crm',
  'erp',
  'hr',
]);

function isForbiddenInputKey(value: string): boolean {
  const normalized = value.replaceAll('-', '').replaceAll('_', '').toLowerCase();
  return (
    FORBIDDEN_INPUT_KEYS.has(normalized) ||
    normalized.includes('path') ||
    normalized.includes('module') ||
    normalized.includes('entrypoint') ||
    normalized.includes('command') ||
    normalized.includes('shell') ||
    normalized.includes('credential') ||
    normalized.includes('token') ||
    normalized.includes('authentication') ||
    normalized.endsWith('repo') ||
    normalized.endsWith('repository') ||
    normalized === 'cwd' ||
    normalized === 'workdir'
  );
}

function fail(code: WorkflowPlanError['code'], message: string): never {
  throw new WorkflowPlanError(code, message);
}

function assertNotProxy(value: unknown, label: string, code: WorkflowPlanError['code']): void {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) fail(code, `${label} cannot be a Proxy.`);
  }
}

function closedRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
  code: WorkflowPlanError['code'],
): DataRecord {
  assertNotProxy(value, label, code);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(code, `${label} must be an inert data object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(code, `${label} has missing or unknown fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail(code, `${label} must contain only enumerable data fields.`);
    }
  }
  return value as DataRecord;
}

function own(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(
  value: unknown,
  label: string,
  max: number,
  code: WorkflowPlanError['code'],
): readonly unknown[] {
  assertNotProxy(value, label, code);
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  ) {
    return fail(code, `${label} must be a bounded dense array.`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(code, `${label} must contain only data values.`);
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
    return fail(code, `${label} cannot contain named or symbol fields.`);
  }
  return value;
}

function text(
  value: unknown,
  label: string,
  maxBytes: number,
  code: WorkflowPlanError['code'],
  pattern?: RegExp,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    CONTROL.test(value) ||
    ACTIVE_CONTENT.test(value) ||
    SECRET_VALUE.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fail(code, `${label} is invalid.`);
  }
  return value;
}

function bool(value: unknown, label: string, code: WorkflowPlanError['code']): boolean {
  if (typeof value !== 'boolean') return fail(code, `${label} must be boolean.`);
  return value;
}

function timestamp(value: unknown, label: string, code: WorkflowPlanError['code']): string {
  const result = text(value, label, 64, code);
  const millis = Date.parse(result);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== result) {
    return fail(code, `${label} must be canonical RFC3339.`);
  }
  return result;
}

function strings(
  value: unknown,
  label: string,
  max: number,
  code: WorkflowPlanError['code'],
): readonly string[] {
  const result = denseArray(value, label, max, code).map((item, index) =>
    text(item, `${label}/${index}`, 128, code, IDENTIFIER),
  );
  if (new Set(result).size !== result.length) fail(code, `${label} contains duplicates.`);
  return Object.freeze(result.sort());
}

function cloneInertInput(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): unknown {
  assertNotProxy(value, path, 'WORKFLOW_PLAN_INPUT_INVALID');
  state.nodes += 1;
  if (depth > 12 || state.nodes > 5_000) {
    return fail('WORKFLOW_PLAN_INPUT_INVALID', 'Workflow input exceeds structural limits.');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail('WORKFLOW_PLAN_INPUT_INVALID', `${path} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 8_192 || SECRET_VALUE.test(value)) {
      return fail(
        'WORKFLOW_PLAN_INPUT_INVALID',
        `${path} contains an oversized or credential-like value.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    const source = denseArray(value, path, 200, 'WORKFLOW_PLAN_INPUT_INVALID');
    return source.map((item, index) => cloneInertInput(item, `${path}/${index}`, depth + 1, state));
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_PLAN_INPUT_INVALID', `${path} must be inert JSON data.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) {
    return fail('WORKFLOW_PLAN_INPUT_INVALID', `${path} has too many fields.`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || isForbiddenInputKey(key)) {
      return fail(
        'WORKFLOW_PLAN_INPUT_INVALID',
        `${path} contains a host-owned or execution-control field.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail('WORKFLOW_PLAN_INPUT_INVALID', `${path}/${key} must be a data field.`);
    }
    Object.defineProperty(result, key, {
      value: cloneInertInput(descriptor.value, `${path}/${key}`, depth + 1, state),
      enumerable: true,
    });
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as DataRecord)[key])}`)
      .join(',')}}`;
  }
  return fail('WORKFLOW_PLAN_INPUT_INVALID', 'Value is not canonical JSON data.');
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function normalizeRequirement(value: unknown, index: number): WorkflowAuthorityRequirement {
  const record = closedRecord(
    value,
    ['provider', 'objectType', 'credentialRequired'],
    `authorityRequirements/${index}`,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
  );
  const provider = text(
    own(record, 'provider'),
    `authorityRequirements/${index}/provider`,
    32,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
  ) as WorkflowAuthorityProvider;
  if (!PROVIDERS.has(provider)) {
    return fail('WORKFLOW_PLAN_RESOLVER_INVALID', 'Authority provider is unsupported.');
  }
  const objectType = text(
    own(record, 'objectType'),
    `authorityRequirements/${index}/objectType`,
    128,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
    IDENTIFIER,
  );
  const credentialRequired = bool(
    own(record, 'credentialRequired'),
    `authorityRequirements/${index}/credentialRequired`,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
  );
  if (provider === 'github' && (objectType !== 'repository' || !credentialRequired)) {
    return fail(
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      'GitHub workflows require an explicit repository and credential binding.',
    );
  }
  return Object.freeze({ provider, objectType, credentialRequired });
}

function normalizeResolverEntry(value: unknown, index: number): WorkflowPlanResolverEntry {
  const record = closedRecord(
    value,
    [
      'id',
      'version',
      'adapterId',
      'executorId',
      'workflowHash',
      'risk',
      'capabilityIds',
      'authorityRequirements',
    ],
    `entries/${index}`,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
  );
  const risk = own(record, 'risk');
  if (!['low', 'medium', 'high'].includes(risk as string)) {
    return fail('WORKFLOW_PLAN_RESOLVER_INVALID', `entries/${index}/risk is invalid.`);
  }
  const capabilityIds = strings(
    own(record, 'capabilityIds'),
    `entries/${index}/capabilityIds`,
    128,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
  );
  if (capabilityIds.some((capability) => FORBIDDEN_CAPABILITIES.has(capability))) {
    return fail(
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      'Direct approval, merge, shell, and command capabilities cannot be planned.',
    );
  }
  const authorityRequirements = denseArray(
    own(record, 'authorityRequirements'),
    `entries/${index}/authorityRequirements`,
    16,
    'WORKFLOW_PLAN_RESOLVER_INVALID',
  )
    .map(normalizeRequirement)
    .sort((left, right) =>
      `${left.provider}\0${left.objectType}`.localeCompare(
        `${right.provider}\0${right.objectType}`,
        'en',
      ),
    );
  const authorityKeys = authorityRequirements.map(
    (requirement) => `${requirement.provider}\0${requirement.objectType}`,
  );
  if (new Set(authorityKeys).size !== authorityKeys.length) {
    return fail(
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      'Authority requirements contain duplicate provider/object pairs.',
    );
  }
  if (
    capabilityIds.some((capability) => capability.startsWith('github.')) &&
    !authorityRequirements.some(
      (requirement) => requirement.provider === 'github' && requirement.objectType === 'repository',
    )
  ) {
    return fail(
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      'GitHub capabilities require an explicit repository authority requirement.',
    );
  }
  return Object.freeze({
    id: text(
      own(record, 'id'),
      `entries/${index}/id`,
      128,
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      IDENTIFIER,
    ),
    version: text(
      own(record, 'version'),
      `entries/${index}/version`,
      128,
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      SEMVER,
    ),
    adapterId: text(
      own(record, 'adapterId'),
      `entries/${index}/adapterId`,
      128,
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      IDENTIFIER,
    ),
    executorId: text(
      own(record, 'executorId'),
      `entries/${index}/executorId`,
      128,
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      IDENTIFIER,
    ),
    workflowHash: text(
      own(record, 'workflowHash'),
      `entries/${index}/workflowHash`,
      64,
      'WORKFLOW_PLAN_RESOLVER_INVALID',
      HASH,
    ),
    risk: risk as WorkflowPlanRisk,
    capabilityIds,
    authorityRequirements: Object.freeze(authorityRequirements),
  });
}

export class SealedWorkflowPlanResolver {
  readonly #entries: ReadonlyMap<string, WorkflowPlanResolverEntry>;

  private constructor(entries: readonly WorkflowPlanResolverEntry[]) {
    this.#entries = new Map(entries.map((entry) => [entry.id, entry]));
    SEALED_RESOLVERS.add(this);
    Object.freeze(this);
  }

  static seal(inputValue: CreateSealedWorkflowPlanResolverInput): SealedWorkflowPlanResolver {
    const input = closedRecord(
      inputValue,
      ['entries'],
      'workflow plan resolver',
      'WORKFLOW_PLAN_RESOLVER_INVALID',
    );
    const entries = denseArray(
      own(input, 'entries'),
      'entries',
      256,
      'WORKFLOW_PLAN_RESOLVER_INVALID',
    ).map(normalizeResolverEntry);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      return fail('WORKFLOW_PLAN_RESOLVER_INVALID', 'Workflow resolver contains duplicate IDs.');
    }
    return new SealedWorkflowPlanResolver(entries);
  }

  static assertSealed(value: unknown): asserts value is SealedWorkflowPlanResolver {
    assertNotProxy(value, 'workflow resolver', 'WORKFLOW_PLAN_RESOLVER_SEALED_REQUIRED');
    if (
      typeof value !== 'object' ||
      value === null ||
      !(value instanceof SealedWorkflowPlanResolver) ||
      !SEALED_RESOLVERS.has(value)
    ) {
      fail(
        'WORKFLOW_PLAN_RESOLVER_SEALED_REQUIRED',
        'A host-created sealed workflow resolver is required.',
      );
    }
  }

  resolve(id: string): WorkflowPlanResolverEntry | undefined {
    return this.#entries.get(id);
  }
}

export function createSealedWorkflowPlanResolver(
  input: CreateSealedWorkflowPlanResolverInput,
): SealedWorkflowPlanResolver {
  return SealedWorkflowPlanResolver.seal(input);
}

export function resolveSealedWorkflowPlanTarget(
  resolver: SealedWorkflowPlanResolver,
  workflowId: string,
): WorkflowPlanResolverEntry {
  SealedWorkflowPlanResolver.assertSealed(resolver);
  const id = text(workflowId, 'workflowId', 128, 'WORKFLOW_PLAN_TARGET_MISSING', IDENTIFIER);
  const entry = resolver.resolve(id);
  if (entry === undefined) {
    return fail(
      'WORKFLOW_PLAN_TARGET_MISSING',
      `Workflow ${id} is not present in the sealed host resolver.`,
    );
  }
  return entry;
}

export function normalizeWorkflowPlanInput(value: unknown): unknown {
  const result = deepFreeze(cloneInertInput(value, '/input', 1, { nodes: 0 }));
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > 256 * 1024) {
    return fail('WORKFLOW_PLAN_INPUT_INVALID', 'Workflow input exceeds byte limits.');
  }
  return result;
}

function normalizeAuthorityBinding(value: unknown, index: number): WorkflowAuthorityBinding {
  const record = closedRecord(
    value,
    ['provider', 'objectType', 'objectId', 'version', 'observedAt', 'credentialBindingId'],
    `authorityBindings/${index}`,
    'WORKFLOW_PLAN_AUTHORITY_INVALID',
  );
  const provider = text(
    own(record, 'provider'),
    `authorityBindings/${index}/provider`,
    32,
    'WORKFLOW_PLAN_AUTHORITY_INVALID',
  ) as WorkflowAuthorityProvider;
  if (!PROVIDERS.has(provider)) {
    return fail('WORKFLOW_PLAN_AUTHORITY_INVALID', 'Authority provider is unsupported.');
  }
  const objectType = text(
    own(record, 'objectType'),
    `authorityBindings/${index}/objectType`,
    128,
    'WORKFLOW_PLAN_AUTHORITY_INVALID',
    IDENTIFIER,
  );
  const objectId = text(
    own(record, 'objectId'),
    `authorityBindings/${index}/objectId`,
    512,
    'WORKFLOW_PLAN_AUTHORITY_INVALID',
  );
  if (objectId.includes('\\')) {
    return fail(
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
      'Authority object IDs cannot contain filesystem separators.',
    );
  }
  if (
    provider === 'github' &&
    (objectType !== 'repository' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(objectId) ||
      objectId.split('/').some((part) => part === '.' || part === '..'))
  ) {
    return fail(
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
      'GitHub authority must name one explicit owner/repository.',
    );
  }
  const credentialValue = own(record, 'credentialBindingId');
  const credentialBindingId =
    credentialValue === null
      ? null
      : text(
          credentialValue,
          `authorityBindings/${index}/credentialBindingId`,
          128,
          'WORKFLOW_PLAN_AUTHORITY_INVALID',
          IDENTIFIER,
        );
  const version = text(
    own(record, 'version'),
    `authorityBindings/${index}/version`,
    512,
    'WORKFLOW_PLAN_AUTHORITY_INVALID',
  );
  if (version.includes('\\')) {
    return fail(
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
      'Authority versions cannot contain filesystem separators.',
    );
  }
  return Object.freeze({
    provider,
    objectType,
    objectId,
    version,
    observedAt: timestamp(
      own(record, 'observedAt'),
      `authorityBindings/${index}/observedAt`,
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
    ),
    credentialBindingId,
  });
}

function exactCompilerInput(value: CompileWorkflowStartPlanInput): DataRecord {
  return closedRecord(
    value,
    [
      'resolver',
      'workflowId',
      'input',
      'authorityBindings',
      'actorId',
      'workspaceId',
      'correlationId',
      'createdAt',
      'expiresAt',
    ],
    'workflow plan compiler input',
    'WORKFLOW_PLAN_INPUT_INVALID',
  );
}

/**
 * Compile one deterministic workflow.start effect. This function has no executor, filesystem,
 * network, GitHub, authentication, approval, or confirmation callback and therefore cannot cause
 * a side effect. A host-owned action registry must map `executorId` after governed confirmation.
 */
export function compileWorkflowStartPlan(
  inputValue: CompileWorkflowStartPlanInput,
): WorkflowStartPlan {
  const input = exactCompilerInput(inputValue);
  const resolver = own(input, 'resolver');
  SealedWorkflowPlanResolver.assertSealed(resolver);
  const workflow = resolveSealedWorkflowPlanTarget(
    resolver,
    text(own(input, 'workflowId'), 'workflowId', 128, 'WORKFLOW_PLAN_TARGET_MISSING', IDENTIFIER),
  );
  const normalizedInput = normalizeWorkflowPlanInput(own(input, 'input'));
  const inputHash = hash(normalizedInput);
  const actorId = text(
    own(input, 'actorId'),
    'actorId',
    512,
    'WORKFLOW_PLAN_INPUT_INVALID',
    RUNTIME_IDENTIFIER,
  );
  const workspaceId = text(
    own(input, 'workspaceId'),
    'workspaceId',
    512,
    'WORKFLOW_PLAN_INPUT_INVALID',
    RUNTIME_IDENTIFIER,
  );
  const correlationId = text(
    own(input, 'correlationId'),
    'correlationId',
    512,
    'WORKFLOW_PLAN_INPUT_INVALID',
    RUNTIME_IDENTIFIER,
  );
  const createdAt = timestamp(own(input, 'createdAt'), 'createdAt', 'WORKFLOW_PLAN_INPUT_INVALID');
  const expiresAt = timestamp(own(input, 'expiresAt'), 'expiresAt', 'WORKFLOW_PLAN_INPUT_INVALID');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    return fail('WORKFLOW_PLAN_EXPIRED', 'Workflow plan expiry must follow creation time.');
  }
  const authorityBindings = Object.freeze(
    denseArray(
      own(input, 'authorityBindings'),
      'authorityBindings',
      16,
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
    )
      .map(normalizeAuthorityBinding)
      .sort((left, right) =>
        `${left.provider}\0${left.objectType}`.localeCompare(
          `${right.provider}\0${right.objectType}`,
          'en',
        ),
      ),
  );
  const authorityKeys = authorityBindings.map(
    (binding) => `${binding.provider}\0${binding.objectType}`,
  );
  if (new Set(authorityKeys).size !== authorityKeys.length) {
    return fail(
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
      'Authority bindings contain duplicate provider/object pairs.',
    );
  }
  const requirementKeys = workflow.authorityRequirements.map(
    (requirement) => `${requirement.provider}\0${requirement.objectType}`,
  );
  if (canonicalJson(authorityKeys) !== canonicalJson(requirementKeys)) {
    return fail(
      'WORKFLOW_PLAN_AUTHORITY_INVALID',
      'Authority bindings must exactly satisfy the sealed workflow requirements.',
    );
  }
  for (const requirement of workflow.authorityRequirements) {
    const binding = authorityBindings.find(
      (candidate) =>
        candidate.provider === requirement.provider &&
        candidate.objectType === requirement.objectType,
    )!;
    if (requirement.credentialRequired && binding.credentialBindingId === null) {
      return fail(
        'WORKFLOW_PLAN_AUTHORITY_INVALID',
        `${requirement.provider}/${requirement.objectType} requires a credential binding.`,
      );
    }
  }

  const effectUnsigned = {
    schema: WORKFLOW_START_EFFECT_SCHEMA,
    kind: 'workflow.start' as const,
    executorId: workflow.executorId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    workflowHash: workflow.workflowHash,
    adapterId: workflow.adapterId,
    correlationId,
    normalizedInput,
    inputHash,
    authorityBindings,
    capabilityIds: workflow.capabilityIds,
    risk: workflow.risk,
  };
  const effect = deepFreeze({
    ...effectUnsigned,
    effectId: `workflow-effect:sha256:${hash(effectUnsigned)}`,
  });
  const unsigned = {
    schema: WORKFLOW_START_PLAN_SCHEMA,
    actorId,
    workspaceId,
    correlationId,
    workflow,
    normalizedInput,
    inputHash,
    authorityBindings,
    effect,
    risk: workflow.risk,
    requiresConfirmation: true as const,
    createdAt,
    expiresAt,
  };
  const planHash = hash(unsigned);
  return deepFreeze({
    ...unsigned,
    planId: `workflow-plan:sha256:${planHash}`,
    planHash,
  });
}

/** Compatibility alias for the host-side governed action-plan compiler. */
export const compileGovernedWorkflowPlan = compileWorkflowStartPlan;
