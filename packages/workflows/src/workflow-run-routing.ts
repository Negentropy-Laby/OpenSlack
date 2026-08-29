import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';

import {
  acquireOwnerJournalLock,
  assertOwnerDirectory,
  ensureOwnerDirectory,
  productionJournalSecurity,
  readOwnerFile,
  syncDirectory,
  writeExclusive,
  type WorkflowControlShadowJournalSecurityDependencies,
} from './workflow-control-shadow.js';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  validateWorkflowControlAuthorityRoute,
  type WorkflowControlAuthorityRoute,
} from './workflow-control-authority-contract.js';

export const WORKFLOW_RUN_ROUTING_POLICY_SCHEMA =
  'openslack.workflow_run_routing_policy.v1' as const;
export const WORKFLOW_RUN_ROUTE_RECEIPT_SCHEMA = 'openslack.workflow_run_route_receipt.v1' as const;

export const WORKFLOW_RUN_ROUTING_LIMITS = Object.freeze({
  maxWorkflowAllowlist: 64,
  maxRunAllowlist: 256,
  maxReceiptBytes: 64 * 1024,
  maxJournalEntries: 4_096,
} as const);

export interface WorkflowRunRoutingPolicy {
  readonly schema: typeof WORKFLOW_RUN_ROUTING_POLICY_SCHEMA;
  readonly workspaceId: string;
  readonly backend: 'ts-local' | 'go';
  readonly authority: 'typescript' | 'workflow-control';
  readonly routingEpoch: number;
  readonly authorityBuildHash: string;
  readonly qualificationEnvironmentId: string;
  readonly workflowAllowlist: readonly string[];
  readonly runAllowlist: readonly string[];
  readonly expiresAt: string;
}

export interface WorkflowRunRouteReceipt {
  readonly schema: typeof WORKFLOW_RUN_ROUTE_RECEIPT_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly route: WorkflowControlAuthorityRoute;
  readonly policyHash: string;
  readonly correlationId: string;
  readonly qualificationEnvironmentId: string;
  readonly selectedAt: string;
  readonly expiresAt: string;
}

export interface SelectWorkflowRunRouteInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly correlationId: string;
  readonly selectedAt: string;
}

export class WorkflowRunRoutingError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUN_ROUTING_POLICY_INVALID'
      | 'WORKFLOW_RUN_ROUTING_POLICY_EXPIRED'
      | 'WORKFLOW_RUN_ROUTING_NOT_ALLOWLISTED'
      | 'WORKFLOW_RUN_ROUTE_RECEIPT_INVALID'
      | 'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT'
      | 'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE'
      | 'WORKFLOW_RUN_ROUTE_JOURNAL_FULL',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunRoutingError';
  }
}

type JsonRecord = Record<string, unknown>;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROUTE_FILE = /^[0-9a-f]{64}\.json$/u;

function fail(
  code: WorkflowRunRoutingError['code'],
  message: string,
  options?: ErrorOptions,
): never {
  throw new WorkflowRunRoutingError(code, message, options);
}

function plainRecord(value: unknown, label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} must be a plain data object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} contains active fields.`);
    }
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} has missing or unknown fields.`);
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} is invalid.`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} is not canonical UTC.`);
  }
  return value;
}

function safeEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', 'routingEpoch must be positive.');
  }
  return value as number;
}

function allowlist(value: unknown, maximum: number, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', `${label} exceeds its bound.`);
  }
  const entries = value.map((entry, index) => id(entry, `${label}[${index}]`));
  if (
    new Set(entries).size !== entries.length ||
    entries.some((entry, index) => index > 0 && entries[index - 1]! >= entry)
  ) {
    return fail(
      'WORKFLOW_RUN_ROUTING_POLICY_INVALID',
      `${label} must be unique and bytewise sorted.`,
    );
  }
  return Object.freeze(entries);
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

export function validateWorkflowRunRoutingPolicy(value: unknown): WorkflowRunRoutingPolicy {
  const root = plainRecord(value, 'Workflow run routing policy');
  exactKeys(
    root,
    [
      'schema',
      'workspaceId',
      'backend',
      'authority',
      'routingEpoch',
      'authorityBuildHash',
      'qualificationEnvironmentId',
      'workflowAllowlist',
      'runAllowlist',
      'expiresAt',
    ],
    'Workflow run routing policy',
  );
  if (root.schema !== WORKFLOW_RUN_ROUTING_POLICY_SCHEMA) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', 'Routing policy schema is invalid.');
  }
  const backend = root.backend;
  const authority = root.authority;
  if (
    (backend !== 'ts-local' && backend !== 'go') ||
    (authority !== 'typescript' && authority !== 'workflow-control') ||
    (backend === 'ts-local' && authority !== 'typescript') ||
    (backend === 'go' && authority !== 'workflow-control')
  ) {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', 'Routing backend and authority disagree.');
  }
  const workflowAllowlist = allowlist(
    root.workflowAllowlist,
    WORKFLOW_RUN_ROUTING_LIMITS.maxWorkflowAllowlist,
    'workflowAllowlist',
  );
  const runAllowlist = allowlist(
    root.runAllowlist,
    WORKFLOW_RUN_ROUTING_LIMITS.maxRunAllowlist,
    'runAllowlist',
  );
  if (backend === 'go' && workflowAllowlist.length === 0 && runAllowlist.length === 0) {
    return fail(
      'WORKFLOW_RUN_ROUTING_POLICY_INVALID',
      'Go routing requires a bounded workflow or run allowlist.',
    );
  }
  return immutable({
    schema: WORKFLOW_RUN_ROUTING_POLICY_SCHEMA,
    workspaceId: id(root.workspaceId, 'workspaceId'),
    backend,
    authority,
    routingEpoch: safeEpoch(root.routingEpoch),
    authorityBuildHash: hash(root.authorityBuildHash, 'authorityBuildHash'),
    qualificationEnvironmentId: id(root.qualificationEnvironmentId, 'qualificationEnvironmentId'),
    workflowAllowlist,
    runAllowlist,
    expiresAt: timestamp(root.expiresAt, 'expiresAt'),
  } satisfies WorkflowRunRoutingPolicy);
}

export function hashWorkflowRunRoutingPolicy(value: unknown): string {
  const policy = validateWorkflowRunRoutingPolicy(value);
  return createHash('sha256')
    .update('openslack.workflow-run-routing.policy.v1\0', 'utf8')
    .update(canonicalWorkflowEffectJson(policy), 'utf8')
    .digest('hex');
}

export function validateWorkflowRunRouteReceipt(value: unknown): WorkflowRunRouteReceipt {
  let canonical: unknown;
  try {
    canonical = parseWorkflowEffectJson(Buffer.from(canonicalWorkflowEffectJson(value), 'utf8'));
  } catch (error) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt is not canonical data.', {
      cause: error,
    });
  }
  const root = plainRecord(canonical, 'Workflow run route receipt');
  try {
    exactKeys(
      root,
      [
        'schema',
        'workspaceId',
        'runId',
        'workflowId',
        'workflowVersion',
        'workflowSourceHash',
        'manifestHash',
        'inputHash',
        'route',
        'policyHash',
        'correlationId',
        'qualificationEnvironmentId',
        'selectedAt',
        'expiresAt',
      ],
      'Workflow run route receipt',
    );
  } catch (error) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt is not closed.', {
      cause: error,
    });
  }
  if (root.schema !== WORKFLOW_RUN_ROUTE_RECEIPT_SCHEMA) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt schema is invalid.');
  }
  let route: WorkflowControlAuthorityRoute;
  try {
    route = validateWorkflowControlAuthorityRoute(root.route, '$/route');
  } catch (error) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt authority is invalid.', {
      cause: error,
    });
  }
  const selectedAt = timestamp(root.selectedAt, 'selectedAt');
  const expiresAt = timestamp(root.expiresAt, 'expiresAt');
  if (Date.parse(selectedAt) >= Date.parse(expiresAt)) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt lifetime is invalid.');
  }
  const workflowVersion = root.workflowVersion;
  if (typeof workflowVersion !== 'string' || !SEMVER.test(workflowVersion)) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'workflowVersion is invalid.');
  }
  const result = immutable({
    schema: WORKFLOW_RUN_ROUTE_RECEIPT_SCHEMA,
    workspaceId: id(root.workspaceId, 'workspaceId'),
    runId: id(root.runId, 'runId'),
    workflowId: id(root.workflowId, 'workflowId'),
    workflowVersion,
    workflowSourceHash: hash(root.workflowSourceHash, 'workflowSourceHash'),
    manifestHash: hash(root.manifestHash, 'manifestHash'),
    inputHash: hash(root.inputHash, 'inputHash'),
    route,
    policyHash: hash(root.policyHash, 'policyHash'),
    correlationId: id(root.correlationId, 'correlationId'),
    qualificationEnvironmentId: id(root.qualificationEnvironmentId, 'qualificationEnvironmentId'),
    selectedAt,
    expiresAt,
  } satisfies WorkflowRunRouteReceipt);
  if (
    Buffer.byteLength(canonicalWorkflowEffectJson(result), 'utf8') >
    WORKFLOW_RUN_ROUTING_LIMITS.maxReceiptBytes
  ) {
    return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt exceeds its byte limit.');
  }
  return result;
}

/** A process-scoped immutable selector. It never retries with another backend. */
export class WorkflowRunRouter {
  readonly #policy: WorkflowRunRoutingPolicy;
  readonly #policyHash: string;

  constructor(value: unknown) {
    this.#policy = validateWorkflowRunRoutingPolicy(value);
    this.#policyHash = hashWorkflowRunRoutingPolicy(this.#policy);
  }

  get policy(): WorkflowRunRoutingPolicy {
    return this.#policy;
  }

  select(input: SelectWorkflowRunRouteInput): WorkflowRunRouteReceipt {
    if (input.workspaceId !== this.#policy.workspaceId) {
      return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', 'Routing workspace does not match.');
    }
    const selectedAt = timestamp(input.selectedAt, 'selectedAt');
    if (Date.parse(selectedAt) >= Date.parse(this.#policy.expiresAt)) {
      return fail('WORKFLOW_RUN_ROUTING_POLICY_EXPIRED', 'Routing policy is expired.');
    }
    if (this.#policy.backend === 'go') {
      const workflowMatched = this.#policy.workflowAllowlist.includes(input.workflowId);
      const runMatched = this.#policy.runAllowlist.includes(input.runId);
      if (!workflowMatched && !runMatched) {
        return fail(
          'WORKFLOW_RUN_ROUTING_NOT_ALLOWLISTED',
          'Run is not present in the explicit Go canary allowlist.',
        );
      }
    }
    return validateWorkflowRunRouteReceipt({
      schema: WORKFLOW_RUN_ROUTE_RECEIPT_SCHEMA,
      workspaceId: input.workspaceId,
      runId: input.runId,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      workflowSourceHash: input.workflowSourceHash,
      manifestHash: input.manifestHash,
      inputHash: input.inputHash,
      route: {
        backend: this.#policy.backend,
        authority: this.#policy.authority,
        routingEpoch: this.#policy.routingEpoch,
        authorityBuildHash: this.#policy.authorityBuildHash,
      },
      policyHash: this.#policyHash,
      correlationId: input.correlationId,
      qualificationEnvironmentId: this.#policy.qualificationEnvironmentId,
      selectedAt,
      expiresAt: this.#policy.expiresAt,
    });
  }
}

function routeFileName(runId: string): string {
  id(runId, 'runId');
  return `${createHash('sha256')
    .update('openslack.workflow-run-route.journal.v1\0', 'utf8')
    .update(runId, 'utf8')
    .digest('hex')}.json`;
}

export class WorkflowRunRouteJournal {
  #root: string;
  #locks = '';
  readonly #security: WorkflowControlShadowJournalSecurityDependencies;
  #initialized = false;

  constructor(
    root: string,
    security: WorkflowControlShadowJournalSecurityDependencies = productionJournalSecurity(),
  ) {
    if (!isAbsolute(root) || resolve(root) !== root || root.includes('\0')) {
      fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal root must be absolute.');
    }
    this.#root = root;
    this.#security = security;
  }

  async initialize(): Promise<void> {
    this.#root = await ensureOwnerDirectory(this.#root, this.#security);
    const entries = await readdir(this.#root, { withFileTypes: true });
    if (
      entries.filter((entry) => ROUTE_FILE.test(entry.name)).length >
        WORKFLOW_RUN_ROUTING_LIMITS.maxJournalEntries ||
      entries.some(
        (entry) =>
          entry.isSymbolicLink() ||
          (entry.name === '.locks'
            ? !entry.isDirectory()
            : !entry.isFile() || !ROUTE_FILE.test(entry.name)),
      )
    ) {
      fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal contains unsafe entries.');
    }
    this.#locks = await ensureOwnerDirectory(
      join(this.#root, '.locks'),
      this.#security,
      this.#root,
    );
    this.#initialized = true;
  }

  async commit(value: unknown): Promise<WorkflowRunRouteReceipt> {
    const receipt = validateWorkflowRunRouteReceipt(value);
    await this.#ready();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireOwnerJournalLock(this.#locks, 'routing-policy', this.#security);
      const existing = await this.load(receipt.runId);
      if (existing) {
        if (canonicalWorkflowEffectJson(existing) === canonicalWorkflowEffectJson(receipt)) {
          return existing;
        }
        return fail(
          'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT',
          'Run already owns a different immutable route receipt.',
        );
      }
      const entries = (await readdir(this.#root)).filter((entry) => ROUTE_FILE.test(entry));
      if (entries.length >= WORKFLOW_RUN_ROUTING_LIMITS.maxJournalEntries) {
        fail('WORKFLOW_RUN_ROUTE_JOURNAL_FULL', 'Route journal has reached its entry limit.');
      }
      let maximumEpoch = 0;
      let activePolicyHash: string | undefined;
      for (const entry of entries) {
        const prior = await this.#readPath(join(this.#root, entry));
        if (prior.route.routingEpoch > maximumEpoch) {
          maximumEpoch = prior.route.routingEpoch;
          activePolicyHash = prior.policyHash;
        } else if (
          prior.route.routingEpoch === maximumEpoch &&
          activePolicyHash !== prior.policyHash
        ) {
          fail(
            'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE',
            'Route journal contains conflicting policies for its highest epoch.',
          );
        }
      }
      if (receipt.route.routingEpoch < maximumEpoch) {
        fail(
          'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT',
          'A new run cannot lower the durable routing epoch.',
        );
      }
      if (
        receipt.route.routingEpoch === maximumEpoch &&
        activePolicyHash !== undefined &&
        receipt.policyHash !== activePolicyHash
      ) {
        fail(
          'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT',
          'One routing epoch cannot publish more than one policy.',
        );
      }
      const path = join(this.#root, routeFileName(receipt.runId));
      await writeExclusive(path, `${canonicalWorkflowEffectJson(receipt)}\n`, this.#security);
      await syncDirectory(this.#root);
      return receipt;
    } finally {
      await release?.();
    }
  }

  async load(runId: string): Promise<WorkflowRunRouteReceipt | null> {
    await this.#ready();
    const path = join(this.#root, routeFileName(runId));
    try {
      const receipt = await this.#readPath(path);
      if (receipt.runId !== runId) {
        return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt bytes do not bind run.');
      }
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async #ready(): Promise<void> {
    if (!this.#initialized) await this.initialize();
    else {
      await assertOwnerDirectory(this.#root, this.#security);
      await assertOwnerDirectory(this.#locks, this.#security, this.#root);
    }
  }

  async #readPath(path: string): Promise<WorkflowRunRouteReceipt> {
    const exact = await readOwnerFile(
      path,
      this.#security,
      WORKFLOW_RUN_ROUTING_LIMITS.maxReceiptBytes,
    );
    if (!exact.endsWith('\n') || exact.includes('\r')) {
      return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt framing is invalid.');
    }
    const value = parseWorkflowEffectJson(Buffer.from(exact.slice(0, -1), 'utf8'));
    const receipt = validateWorkflowRunRouteReceipt(value);
    if (`${canonicalWorkflowEffectJson(receipt)}\n` !== exact) {
      return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt bytes are not exact.');
    }
    return receipt;
  }
}
