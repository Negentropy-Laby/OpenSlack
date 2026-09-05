import { createHash } from 'node:crypto';
import { isWorkflowRunId } from './internal/workflow-run-identity.js';
import { lstat, readdir, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';

import {
  acquireOwnerJournalLock,
  assertOwnerDirectory,
  assertOwnerFile,
  atomicWrite,
  ensureOwnerDirectory,
  productionJournalSecurity,
  readOwnerFile,
  syncDirectory,
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
      | 'WORKFLOW_RUN_ROUTE_JOURNAL_FULL'
      | 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunRoutingError';
  }
}

type JsonRecord = Record<string, unknown>;
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
  if (!isWorkflowRunId(value)) {
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
  if (backend !== 'ts-local' && backend !== 'go') {
    return fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', 'Routing backend is invalid.');
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
    if (this.#policy.backend !== 'go') {
      fail('WORKFLOW_RUN_ROUTING_POLICY_INVALID', 'New TypeScript workflow routing is retired.');
    }
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
        authority: this.#policy.backend === 'go' ? 'workflow-control' : 'typescript',
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

interface WorkflowRunRouteJournalInventory {
  identity: string;
  active: Map<string, number>;
  activeBytes: number;
  maximumEpoch: number;
  activePolicyHash?: string;
}

interface WorkflowRunRouteJournalPolicyState {
  readonly maximumEpoch: number;
  readonly policyHash?: string;
}

export function createWorkflowRunRouteJournal(workspaceRoot: string): WorkflowRunRouteJournal {
  return new WorkflowRunRouteJournal(
    resolve(workspaceRoot, '.openslack.local', 'workflows', 'routes'),
  );
}

export class WorkflowRunRouteJournal {
  #root: string;
  #active = '';
  #closed = '';
  #quarantine = '';
  #policies = '';
  #locks = '';
  readonly #security: WorkflowControlShadowJournalSecurityDependencies;
  #initialized = false;
  #inventory: WorkflowRunRouteJournalInventory | undefined;
  readonly #quarantinedRouteNames = new Set<string>();

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
    [this.#active, this.#closed, this.#quarantine, this.#policies, this.#locks] = await Promise.all(
      [
        ensureOwnerDirectory(join(this.#root, 'active'), this.#security, this.#root),
        ensureOwnerDirectory(join(this.#root, 'closed'), this.#security, this.#root),
        ensureOwnerDirectory(join(this.#root, 'quarantine'), this.#security, this.#root),
        ensureOwnerDirectory(join(this.#root, 'policies'), this.#security, this.#root),
        ensureOwnerDirectory(join(this.#root, 'locks'), this.#security, this.#root),
      ],
    );
    await this.#normalizeRootEntries();
    this.#initialized = true;
    await this.#loadInventory(true);
  }

  async commit(value: unknown): Promise<WorkflowRunRouteReceipt> {
    const receipt = validateWorkflowRunRouteReceipt(value);
    if (receipt.route.backend !== 'go') {
      return fail(
        'WORKFLOW_RUN_ROUTING_POLICY_INVALID',
        'TypeScript route receipts are historical evidence and cannot be committed.',
      );
    }
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
      const inventory = await this.#loadInventory();
      if (inventory.active.size >= WORKFLOW_RUN_ROUTING_LIMITS.maxJournalEntries) {
        fail('WORKFLOW_RUN_ROUTE_JOURNAL_FULL', 'Route journal has reached its entry limit.');
      }
      if (receipt.route.routingEpoch < inventory.maximumEpoch) {
        fail(
          'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT',
          'A new run cannot lower the durable routing epoch.',
        );
      }
      if (
        receipt.route.routingEpoch === inventory.maximumEpoch &&
        inventory.activePolicyHash !== undefined &&
        receipt.policyHash !== inventory.activePolicyHash
      ) {
        fail(
          'WORKFLOW_RUN_ROUTE_RECEIPT_CONFLICT',
          'One routing epoch cannot publish more than one policy.',
        );
      }
      const name = routeFileName(receipt.runId);
      if (this.#quarantinedRouteNames.has(name)) {
        fail(
          'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
          'Run route receipt is quarantined and requires operator reconciliation.',
        );
      }
      const path = join(this.#active, name);
      const body = `${canonicalWorkflowEffectJson(receipt)}\n`;
      await atomicWrite(path, body, this.#security);
      inventory.active.set(name, Buffer.byteLength(body, 'utf8'));
      inventory.activeBytes += Buffer.byteLength(body, 'utf8');
      if (receipt.route.routingEpoch > inventory.maximumEpoch) {
        inventory.maximumEpoch = receipt.route.routingEpoch;
        inventory.activePolicyHash = receipt.policyHash;
      }
      await this.#writePolicyState(inventory);
      inventory.identity = await this.#inventoryIdentity();
      return receipt;
    } finally {
      await release?.();
    }
  }

  async load(runId: string): Promise<WorkflowRunRouteReceipt | null> {
    return (await this.locate(runId))?.receipt ?? null;
  }

  /**
   * Resolve one immutable receipt without initializing, migrating, repairing,
   * quarantining, or otherwise changing the journal. GS9-H inspection and
   * retired TypeScript execution checks must use this path.
   */
  async locateReadOnly(runId: string): Promise<WorkflowRunRouteJournalEntry | null> {
    return this.createReadOnlyQuery().locateReadOnly(runId);
  }

  /** A request-local reader. Discard it after the list/inspection finishes. */
  createReadOnlyQuery(): Pick<WorkflowRunRouteJournal, 'locateReadOnly'> {
    let quarantine: Promise<ReadonlySet<string>> | undefined;
    return {
      locateReadOnly: (runId) =>
        this.#locateReadOnly(runId, () => (quarantine ??= this.#readQuarantineNames())),
    };
  }

  async #readQuarantineNames(): Promise<ReadonlySet<string>> {
    const directory = join(this.#root, 'quarantine');
    try {
      await assertOwnerDirectory(directory, this.#security, this.#root);
      const before = await lstat(directory, { bigint: true });
      const entries = await readdir(directory);
      await assertOwnerDirectory(directory, this.#security, this.#root);
      const after = await lstat(directory, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs
      ) {
        throw new TypeError('Route quarantine changed during enumeration.');
      }
      // Quarantine suffixes describe the incident; the first 69 bytes identify the route.
      return new Set(
        entries
          .map((entry) => entry.match(/^[0-9a-f]{64}\.json(?=\.|$)/)?.[0])
          .filter((name): name is string => name !== undefined),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
  }

  async #locateReadOnly(
    runId: string,
    readQuarantine: () => Promise<ReadonlySet<string>>,
  ): Promise<WorkflowRunRouteJournalEntry | null> {
    if (!(await this.#rootExists())) return null;
    await assertOwnerDirectory(this.#root, this.#security);
    const name = routeFileName(runId);
    try {
      const quarantine = await readQuarantine();
      if (quarantine.has(name)) {
        return fail(
          'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
          'Requested run route receipt is quarantined and requires operator reconciliation.',
        );
      }
      return await this.#resolveReceipt(runId, {
        legacyPath: join(this.#root, name),
        activePath: join(this.#root, 'active', name),
        closedPath: join(this.#root, 'closed', name.slice(0, 2), name),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (
        error instanceof WorkflowRunRoutingError &&
        error.code === 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED'
      ) {
        throw error;
      }
      return fail(
        'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
        'Requested run route receipt cannot be proved safe without mutation.',
        { cause: error },
      );
    }
  }

  async locate(runId: string): Promise<WorkflowRunRouteJournalEntry | null> {
    if (!(await this.#rootExists())) return null;
    await this.#ready();
    const name = routeFileName(runId);
    if (this.#quarantinedRouteNames.has(name)) {
      return fail(
        'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
        'Requested run route receipt is quarantined and requires operator reconciliation.',
      );
    }
    const activePath = join(this.#active, name);
    const closedPath = this.#closedPath(name);
    try {
      return await this.#resolveReceipt(runId, { activePath, closedPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof WorkflowRunRoutingError) throw error;
      return fail(
        'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
        'Requested run route receipt cannot be proved safe.',
        { cause: error },
      );
    }
  }

  async #resolveReceipt(
    runId: string,
    paths: {
      readonly legacyPath?: string;
      readonly activePath: string;
      readonly closedPath: string;
    },
  ): Promise<WorkflowRunRouteJournalEntry | null> {
    const [legacy, active, closed] = await Promise.all([
      paths.legacyPath ? this.#readOptional(paths.legacyPath) : Promise.resolve(null),
      this.#readOptional(paths.activePath),
      this.#readOptional(paths.closedPath),
    ]);
    if (legacy) {
      return fail(
        'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
        'Legacy flat route receipt requires explicit operator repair before use.',
      );
    }
    if (active && closed) {
      return fail(
        'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
        'Run route receipt exists in both active and closed journals.',
      );
    }
    const receipt = active ?? closed;
    if (!receipt) return null;
    if (receipt.runId !== runId) {
      return fail('WORKFLOW_RUN_ROUTE_RECEIPT_INVALID', 'Route receipt bytes do not bind run.');
    }
    return Object.freeze({ receipt, state: active ? 'active' : 'closed' });
  }

  async close(runId: string): Promise<WorkflowRunRouteReceipt | null> {
    await this.#ready();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireOwnerJournalLock(this.#locks, 'routing-policy', this.#security);
      const receipt = await this.load(runId);
      if (!receipt) return null;
      const name = routeFileName(runId);
      const activePath = join(this.#active, name);
      const closedPath = this.#closedPath(name);
      if (await this.#pathExists(closedPath)) return receipt;
      await ensureOwnerDirectory(
        join(this.#closed, name.slice(0, 2)),
        this.#security,
        this.#closed,
      );
      await rename(activePath, closedPath);
      await Promise.all([
        syncDirectory(this.#active),
        syncDirectory(join(this.#closed, name.slice(0, 2))),
      ]);
      const inventory = await this.#loadInventory();
      const size = inventory.active.get(name);
      if (size !== undefined) {
        inventory.active.delete(name);
        inventory.activeBytes -= size;
      }
      await this.#writePolicyState(inventory);
      inventory.identity = await this.#inventoryIdentity();
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await release?.();
    }
  }

  async inspect(): Promise<WorkflowRunRouteJournalInspection> {
    if (!(await this.#rootExists())) {
      return Object.freeze({ active: 0, closed: 0, quarantined: 0, capacity: 0, unsafe: 0 });
    }
    await this.#ready();
    let closed = 0;
    for (const shard of await readdir(this.#closed, { withFileTypes: true })) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[0-9a-f]{2}$/u.test(shard.name)) {
        continue;
      }
      closed += (await readdir(join(this.#closed, shard.name))).filter((name) =>
        ROUTE_FILE.test(name),
      ).length;
    }
    const inventory = await this.#loadInventory();
    const quarantined = (await readdir(this.#quarantine)).length;
    return Object.freeze({
      active: inventory.active.size,
      closed,
      quarantined,
      capacity: WORKFLOW_RUN_ROUTING_LIMITS.maxJournalEntries - inventory.active.size,
      unsafe: 0,
    });
  }

  async repair(
    options: WorkflowRunRouteJournalRepairOptions = {},
  ): Promise<WorkflowRunRouteJournalRepairResult> {
    await this.#ready();
    const closeable: string[] = [];
    for (const name of (await readdir(this.#active)).filter((entry) => ROUTE_FILE.test(entry))) {
      const receipt = await this.#readPath(join(this.#active, name)).catch(() => null);
      if (receipt && (await options.canClose?.(receipt)) === true) closeable.push(receipt.runId);
    }
    if (options.apply) {
      for (const runId of closeable) await this.close(runId);
    }
    const inspection = await this.inspect();
    return Object.freeze({
      ...inspection,
      closeable: Object.freeze(closeable),
      applied: options.apply === true,
    });
  }

  async #ready(): Promise<void> {
    if (!this.#initialized) await this.initialize();
    else {
      await assertOwnerDirectory(this.#root, this.#security);
      await assertOwnerDirectory(this.#active, this.#security, this.#root);
      await assertOwnerDirectory(this.#closed, this.#security, this.#root);
      await assertOwnerDirectory(this.#quarantine, this.#security, this.#root);
      await assertOwnerDirectory(this.#policies, this.#security, this.#root);
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

  async #readOptional(path: string): Promise<WorkflowRunRouteReceipt | null> {
    try {
      return await this.#readPath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  #closedPath(name: string): string {
    return join(this.#closed, name.slice(0, 2), name);
  }

  async #rootExists(): Promise<boolean> {
    try {
      const stat = await lstat(this.#root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal root is unsafe.');
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async #pathExists(path: string): Promise<boolean> {
    try {
      await assertOwnerFile(path, this.#security);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async #normalizeRootEntries(): Promise<void> {
    const known = new Set(['active', 'closed', 'quarantine', 'policies', 'locks']);
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (known.has(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal contains unsafe directories.');
        }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal contains an unsafe object.');
      }
      const source = join(this.#root, entry.name);
      await assertOwnerFile(source, this.#security);
      if (ROUTE_FILE.test(entry.name)) {
        try {
          const receipt = await this.#readPath(source);
          if (routeFileName(receipt.runId) !== entry.name) {
            throw new TypeError('Legacy route file name does not bind its receipt.');
          }
          const activeTarget = join(this.#active, entry.name);
          if (
            (await this.#pathExists(activeTarget)) ||
            (await this.#pathExists(this.#closedPath(entry.name)))
          ) {
            fail(
              'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
              'Legacy route receipt conflicts with the partitioned journal.',
            );
          }
          await rename(source, activeTarget);
          continue;
        } catch (error) {
          if (
            error instanceof WorkflowRunRoutingError &&
            (error.code === 'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE' ||
              error.code === 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED')
          ) {
            throw error;
          }
          const stat = await assertOwnerFile(source, this.#security);
          const target = join(
            this.#quarantine,
            `${entry.name}.${createHash('sha256')
              .update(`${entry.name}\0${stat.dev}\0${stat.ino}\0${stat.size}`)
              .digest('hex')}.entry`,
          );
          await rename(source, target);
          this.#quarantinedRouteNames.add(entry.name);
          continue;
        }
      }
      const target = join(
        this.#quarantine,
        `unknown.${createHash('sha256').update(`${entry.name}\0${Date.now()}`).digest('hex')}.entry`,
      );
      await rename(source, target);
    }
    for (const name of await readdir(this.#quarantine)) {
      const match = /^(?<route>[0-9a-f]{64}\.json)\.[0-9a-f]{64}\.entry$/u.exec(name);
      if (match?.groups?.route) this.#quarantinedRouteNames.add(match.groups.route);
    }
    await Promise.all([
      syncDirectory(this.#root),
      syncDirectory(this.#active),
      syncDirectory(this.#quarantine),
    ]);
  }

  async #loadInventory(force = false): Promise<WorkflowRunRouteJournalInventory> {
    const identity = await this.#inventoryIdentity();
    if (!force && this.#inventory?.identity === identity) return this.#inventory;
    const active = new Map<string, number>();
    let activeBytes = 0;
    const policyState = await this.#readPolicyState();
    let maximumEpoch = policyState.maximumEpoch;
    let activePolicyHash = policyState.policyHash;
    for (const entry of await readdir(this.#active, { withFileTypes: true })) {
      const path = join(this.#active, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail(
          'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE',
          'Active route journal contains an unsafe object.',
        );
      }
      if (!ROUTE_FILE.test(entry.name)) {
        await this.#quarantinePath(path, entry.name);
        continue;
      }
      try {
        const receipt = await this.#readPath(path);
        if (routeFileName(receipt.runId) !== entry.name)
          throw new TypeError('Route file name mismatch.');
        const size = Number((await assertOwnerFile(path, this.#security)).size);
        active.set(entry.name, size);
        activeBytes += size;
        if (receipt.route.routingEpoch > maximumEpoch) {
          maximumEpoch = receipt.route.routingEpoch;
          activePolicyHash = receipt.policyHash;
        } else if (
          receipt.route.routingEpoch === maximumEpoch &&
          activePolicyHash !== receipt.policyHash
        ) {
          fail(
            'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE',
            'Highest routing epoch has conflicting policies.',
          );
        }
      } catch (error) {
        if (
          error instanceof WorkflowRunRoutingError &&
          error.code === 'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE'
        )
          throw error;
        await this.#quarantinePath(path, entry.name);
      }
    }
    if (active.size > WORKFLOW_RUN_ROUTING_LIMITS.maxJournalEntries) {
      fail('WORKFLOW_RUN_ROUTE_JOURNAL_FULL', 'Active route journal exceeds its entry limit.');
    }
    this.#inventory = { identity, active, activeBytes, maximumEpoch, activePolicyHash };
    if (maximumEpoch !== policyState.maximumEpoch || activePolicyHash !== policyState.policyHash) {
      await this.#writePolicyState(this.#inventory);
    }
    this.#inventory.identity = await this.#inventoryIdentity();
    return this.#inventory;
  }

  async #quarantinePath(path: string, name: string): Promise<void> {
    const stat = await assertOwnerFile(path, this.#security);
    const safeName = ROUTE_FILE.test(name) ? name : 'unknown';
    const target = join(
      this.#quarantine,
      `${safeName}.${createHash('sha256').update(`${name}\0${stat.dev}\0${stat.ino}\0${stat.size}`).digest('hex')}.entry`,
    );
    await rename(path, target);
    if (ROUTE_FILE.test(name)) this.#quarantinedRouteNames.add(name);
    await Promise.all([syncDirectory(this.#active), syncDirectory(this.#quarantine)]);
  }

  async #inventoryIdentity(): Promise<string> {
    const stat = await lstat(this.#active);
    let policyIdentity = 'missing';
    try {
      const policy = await lstat(join(this.#policies, 'state.json'));
      policyIdentity = [policy.dev, policy.ino, policy.size, policy.mtimeMs, policy.ctimeMs].join(
        ':',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, policyIdentity].join(':');
  }

  async #writePolicyState(inventory: WorkflowRunRouteJournalInventory): Promise<void> {
    await atomicWrite(
      join(this.#policies, 'state.json'),
      `${canonicalWorkflowEffectJson({
        schema: 'openslack.workflow_run_route_journal_state.v1',
        maximumEpoch: inventory.maximumEpoch,
        policyHash: inventory.activePolicyHash ?? null,
        active: inventory.active.size,
        activeBytes: inventory.activeBytes,
      })}\n`,
      this.#security,
    );
  }

  async #readPolicyState(): Promise<WorkflowRunRouteJournalPolicyState> {
    const path = join(this.#policies, 'state.json');
    let exact: string;
    try {
      exact = await readOwnerFile(path, this.#security, 4096);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return Object.freeze({ maximumEpoch: 0 });
      }
      throw error;
    }
    if (!exact.endsWith('\n') || exact.includes('\r')) {
      fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal policy state is malformed.');
    }
    const value = parseWorkflowEffectJson(Buffer.from(exact.slice(0, -1), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal policy state is invalid.');
    }
    const state = value as Record<string, unknown>;
    const keys = Object.keys(state).sort();
    if (
      keys.join('\0') !==
        ['active', 'activeBytes', 'maximumEpoch', 'policyHash', 'schema'].sort().join('\0') ||
      state.schema !== 'openslack.workflow_run_route_journal_state.v1' ||
      !Number.isSafeInteger(state.maximumEpoch) ||
      (state.maximumEpoch as number) < 0 ||
      (state.policyHash !== null &&
        (typeof state.policyHash !== 'string' || !HASH.test(state.policyHash))) ||
      !Number.isSafeInteger(state.active) ||
      (state.active as number) < 0 ||
      !Number.isSafeInteger(state.activeBytes) ||
      (state.activeBytes as number) < 0 ||
      `${canonicalWorkflowEffectJson(state)}\n` !== exact
    ) {
      fail('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'Route journal policy state is invalid.');
    }
    return Object.freeze({
      maximumEpoch: state.maximumEpoch as number,
      ...(state.policyHash === null ? {} : { policyHash: state.policyHash as string }),
    });
  }
}

export interface WorkflowRunRouteJournalInspection {
  readonly active: number;
  readonly closed: number;
  readonly quarantined: number;
  readonly capacity: number;
  readonly unsafe: number;
}

export interface WorkflowRunRouteJournalEntry {
  readonly receipt: WorkflowRunRouteReceipt;
  readonly state: 'active' | 'closed';
}

export interface WorkflowRunRouteJournalRepairOptions {
  readonly apply?: boolean;
  readonly canClose?: (receipt: WorkflowRunRouteReceipt) => boolean | Promise<boolean>;
}

export interface WorkflowRunRouteJournalRepairResult extends WorkflowRunRouteJournalInspection {
  readonly closeable: readonly string[];
  readonly applied: boolean;
}
