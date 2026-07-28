import { randomBytes, randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  canonicalizeGovernedJson,
  createCanonicalGovernedPlan,
  hashGovernedValue,
  hashOpaqueValue,
  opaqueHashesEqual,
  validateGovernedPlanRecord,
  type CanonicalGovernedPlan,
  type CreateCanonicalGovernedPlanInput,
  type GovernedActionOutcome,
  type GovernedJsonValue,
  type GovernedPlanRecord,
  type GovernedPlanState,
} from './governed-plan.js';
import {
  isGovernedActionExecutionRegistry,
  type GovernedActionExecutionRegistry,
} from './action-execution-registry.js';
import {
  GovernedPlanStoreError,
  isGovernedPlanStore,
  type GovernedPlanStore,
} from './governed-plan-store.js';

export interface GovernedPlanHostAuthority {
  readonly actorId: string;
  readonly workspaceId: string;
}

export interface GovernedPlanBindingSnapshot {
  readonly sourceVersions: unknown;
  readonly permissionSnapshot: unknown;
  readonly buildNonce: string;
}

export interface GovernedPlanBindingContext {
  readonly phase: 'preview' | 'confirm';
  readonly canonicalPlan: CanonicalGovernedPlan;
  readonly authority: GovernedPlanHostAuthority;
}

export type GovernedPlanAuditEventType =
  | 'plan.previewed'
  | 'plan.confirmed'
  | 'plan.confirmation_rejected'
  | 'plan.cancelled'
  | 'plan.expired'
  | 'plan.execution_started'
  | 'plan.execution_completed'
  | 'plan.execution_blocked'
  | 'plan.execution_failed'
  | 'plan.reconciliation_required'
  | 'workflow.approval_decided';

export interface GovernedPlanAuditEvent {
  readonly schema: 'openslack.governed_plan_audit.v1';
  readonly eventId: string;
  readonly type: GovernedPlanAuditEventType;
  readonly occurredAt: string;
  readonly planId: string;
  readonly kind: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly state: GovernedPlanState;
  readonly revision: number;
  readonly evidenceRefs: readonly string[];
  readonly details?: GovernedJsonValue;
}

export type GovernedPlanAuditSink = (event: GovernedPlanAuditEvent) => void | Promise<void>;

export interface GovernedPlanServiceOptions {
  readonly store: GovernedPlanStore;
  readonly registry: GovernedActionExecutionRegistry;
  readonly getBindingSnapshot: (
    context: GovernedPlanBindingContext,
  ) => GovernedPlanBindingSnapshot | Promise<GovernedPlanBindingSnapshot>;
  readonly audit: GovernedPlanAuditSink;
  readonly defaultTtlMs?: number;
  readonly executionTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface GovernedPlanCompilationContext {
  readonly correlationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

declare const GOVERNED_PLAN_COMPILER: unique symbol;

export interface GovernedPlanCompiler {
  readonly [GOVERNED_PLAN_COMPILER]: true;
}

export type GovernedPlanCompile = (
  context: GovernedPlanCompilationContext,
) => CreateCanonicalGovernedPlanInput | Promise<CreateCanonicalGovernedPlanInput>;

export interface GovernedPlanExecutionControl {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
}

export interface GovernedPlanPreview {
  readonly record: GovernedPlanRecord;
  readonly confirmationToken: string;
  readonly correlationId: string;
}

export interface GovernedPlanConfirmation {
  readonly planId: string;
  readonly confirmationToken: string;
}

export interface GovernedPlanCancellation {
  readonly planId: string;
  readonly confirmationToken: string;
}

export interface GovernedPlanService {
  preview(
    compiler: GovernedPlanCompiler,
    authority: GovernedPlanHostAuthority,
  ): Promise<GovernedPlanPreview>;
  get(planId: string): Promise<GovernedPlanRecord | null>;
  confirm(
    request: GovernedPlanConfirmation,
    authority: GovernedPlanHostAuthority,
    control?: GovernedPlanExecutionControl,
  ): Promise<GovernedPlanRecord>;
  cancel(
    request: GovernedPlanCancellation,
    authority: GovernedPlanHostAuthority,
  ): Promise<GovernedPlanRecord>;
}

const SAFE_AUTHORITY = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/;
const SAFE_PLAN_ID = /^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[a-zA-Z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_EXECUTION_TIMEOUT_MS = 10;
const MAX_EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;
const COMPILERS = new WeakMap<object, GovernedPlanCompile>();
const SERVICES = new WeakSet<object>();

export class GovernedPlanServiceError extends Error {
  readonly code:
    | 'GOVERNED_PLAN_NOT_FOUND'
    | 'GOVERNED_PLAN_AUTHORITY_INVALID'
    | 'GOVERNED_PLAN_CONFIRMATION_INVALID'
    | 'GOVERNED_PLAN_BINDING_CHANGED'
    | 'GOVERNED_PLAN_STATE_INVALID'
    | 'GOVERNED_PLAN_EXECUTION_ACTIVE'
    | 'GOVERNED_PLAN_EXECUTION_ABORTED'
    | 'GOVERNED_PLAN_EXECUTION_UNCERTAIN'
    | 'GOVERNED_PLAN_CONFIGURATION_INVALID';

  constructor(code: GovernedPlanServiceError['code'], message: string) {
    super(message);
    this.name = 'GovernedPlanServiceError';
    this.code = code;
  }
}

export function createGovernedPlanCompiler(compile: GovernedPlanCompile): GovernedPlanCompiler {
  if (typeof compile !== 'function' || utilTypes.isProxy(compile)) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan compiler must be an inert host-owned function.',
    );
  }
  const compiler = Object.freeze(Object.create(null) as GovernedPlanCompiler);
  COMPILERS.set(compiler, compile);
  return compiler;
}

function getCompile(compiler: GovernedPlanCompiler): GovernedPlanCompile {
  if (
    !compiler ||
    typeof compiler !== 'object' ||
    utilTypes.isProxy(compiler) ||
    !COMPILERS.has(compiler)
  ) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan compiler is not host-created.',
    );
  }
  return COMPILERS.get(compiler)!;
}

function fail(code: GovernedPlanServiceError['code'], message: string): never {
  throw new GovernedPlanServiceError(code, message);
}

function validateAuthority(value: GovernedPlanHostAuthority): GovernedPlanHostAuthority {
  const sanitized = canonicalizeGovernedJson(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_INVALID',
      'Host-bound actor or workspace authority is invalid.',
    );
  }
  const object = sanitized as { readonly [key: string]: GovernedJsonValue };
  if (
    Object.keys(object).length !== 2 ||
    typeof object.actorId !== 'string' ||
    !SAFE_AUTHORITY.test(object.actorId) ||
    typeof object.workspaceId !== 'string' ||
    !SAFE_AUTHORITY.test(object.workspaceId)
  ) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_INVALID',
      'Host-bound actor or workspace authority is invalid.',
    );
  }
  return Object.freeze({
    actorId: object.actorId,
    workspaceId: object.workspaceId,
  });
}

function validatePlanTokenRequest(
  value: GovernedPlanConfirmation | GovernedPlanCancellation,
): GovernedPlanConfirmation {
  const sanitized = canonicalizeGovernedJson(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return fail('GOVERNED_PLAN_CONFIRMATION_INVALID', 'Plan confirmation request is invalid.');
  }
  const object = sanitized as { readonly [key: string]: GovernedJsonValue };
  if (
    Object.keys(object).length !== 2 ||
    typeof object.planId !== 'string' ||
    !SAFE_PLAN_ID.test(object.planId) ||
    typeof object.confirmationToken !== 'string' ||
    !TOKEN.test(object.confirmationToken)
  ) {
    return fail('GOVERNED_PLAN_CONFIRMATION_INVALID', 'Plan confirmation request is invalid.');
  }
  return Object.freeze({
    planId: object.planId,
    confirmationToken: object.confirmationToken,
  });
}

function nowIso(clock: () => Date): string {
  const date = clock();
  if (
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime()).toISOString() !== date.toISOString()
  ) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan clock returned an invalid date.',
    );
  }
  return date.toISOString();
}

function validateBindingSnapshot(value: unknown): {
  readonly sourceVersions: GovernedJsonValue;
  readonly permissionSnapshot: GovernedJsonValue;
  readonly buildNonce: string;
} {
  const sanitized = canonicalizeGovernedJson(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan binding snapshot is invalid.',
    );
  }
  const object = sanitized as { readonly [key: string]: GovernedJsonValue };
  if (
    Object.keys(object).length !== 3 ||
    !Object.hasOwn(object, 'sourceVersions') ||
    !Object.hasOwn(object, 'permissionSnapshot') ||
    typeof object.buildNonce !== 'string'
  ) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan binding snapshot is invalid.',
    );
  }
  // hashOpaqueValue performs the strict secret/nonce bounds check.
  hashOpaqueValue(object.buildNonce);
  return Object.freeze({
    sourceVersions: object.sourceVersions!,
    permissionSnapshot: object.permissionSnapshot!,
    buildNonce: object.buildNonce,
  });
}

function ownerIsProvablyDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function inspectServiceOptions(value: GovernedPlanServiceOptions): GovernedPlanServiceOptions {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan service options must be an inert host-owned object.',
    );
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan service options cannot be inspected safely.',
    );
  }
  const allowed = new Set([
    'store',
    'registry',
    'getBindingSnapshot',
    'audit',
    'defaultTtlMs',
    'executionTimeoutMs',
    'now',
  ]);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (
      typeof key !== 'string' ||
      !allowed.has(key) ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail(
        'GOVERNED_PLAN_CONFIGURATION_INVALID',
        'Governed plan service options must contain only inert known fields.',
      );
    }
  }
  const read = (key: string): unknown => descriptors[key]?.value;
  const store = read('store');
  const registry = read('registry');
  const getBindingSnapshot = read('getBindingSnapshot');
  const audit = read('audit');
  const now = read('now');
  if (
    !isGovernedPlanStore(store) ||
    !isGovernedActionExecutionRegistry(registry) ||
    typeof getBindingSnapshot !== 'function' ||
    utilTypes.isProxy(getBindingSnapshot) ||
    typeof audit !== 'function' ||
    utilTypes.isProxy(audit) ||
    (now !== undefined && (typeof now !== 'function' || utilTypes.isProxy(now)))
  ) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan service dependencies must come from host-owned boundaries.',
    );
  }
  return Object.freeze({
    store,
    registry,
    getBindingSnapshot: getBindingSnapshot as GovernedPlanServiceOptions['getBindingSnapshot'],
    audit: audit as GovernedPlanAuditSink,
    ...(read('defaultTtlMs') === undefined ? {} : { defaultTtlMs: read('defaultTtlMs') as number }),
    ...(read('executionTimeoutMs') === undefined
      ? {}
      : { executionTimeoutMs: read('executionTimeoutMs') as number }),
    ...(now === undefined ? {} : { now: now as () => Date }),
  });
}

function validateExecutionControl(
  value: GovernedPlanExecutionControl | undefined,
  now: number,
  serviceDeadline: number,
): { readonly signal?: AbortSignal; readonly deadline: number } {
  if (value === undefined) return Object.freeze({ deadline: serviceDeadline });
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Execution control must be a host-owned object.',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['signal', 'deadlineAt']);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (
      typeof key !== 'string' ||
      !allowed.has(key) ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail(
        'GOVERNED_PLAN_CONFIGURATION_INVALID',
        'Execution control must contain inert host-owned fields.',
      );
    }
  }
  const signal = descriptors.signal?.value;
  if (
    signal !== undefined &&
    (typeof AbortSignal === 'undefined' ||
      utilTypes.isProxy(signal) ||
      !(signal instanceof AbortSignal))
  ) {
    return fail('GOVERNED_PLAN_CONFIGURATION_INVALID', 'Execution control signal is invalid.');
  }
  const deadlineAt = descriptors.deadlineAt?.value;
  let deadline = serviceDeadline;
  if (deadlineAt !== undefined) {
    if (
      typeof deadlineAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deadlineAt) ||
      !Number.isFinite(Date.parse(deadlineAt))
    ) {
      return fail('GOVERNED_PLAN_CONFIGURATION_INVALID', 'Execution control deadline is invalid.');
    }
    deadline = Math.min(deadline, Date.parse(deadlineAt));
  }
  if (!Number.isFinite(deadline) || deadline < now - MAX_EXECUTION_TIMEOUT_MS) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Execution control deadline is outside allowed bounds.',
    );
  }
  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    deadline,
  });
}

function executionAborted(control: {
  readonly signal?: AbortSignal;
  readonly deadline: number;
}): boolean {
  return Boolean(control.signal?.aborted) || Date.now() >= control.deadline;
}

async function raceExecution<T>(
  promise: Promise<T>,
  control: { readonly signal?: AbortSignal; readonly deadline: number },
): Promise<T> {
  if (executionAborted(control)) {
    return fail(
      'GOVERNED_PLAN_EXECUTION_ABORTED',
      'Governed plan execution was aborted or exceeded its deadline.',
    );
  }
  return new Promise<T>((resolve, reject) => {
    const remaining = Math.max(0, control.deadline - Date.now());
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          new GovernedPlanServiceError(
            'GOVERNED_PLAN_EXECUTION_ABORTED',
            'Governed plan execution was aborted.',
          ),
        ),
      );
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new GovernedPlanServiceError(
              'GOVERNED_PLAN_EXECUTION_ABORTED',
              'Governed plan execution exceeded its deadline.',
            ),
          ),
        ),
      remaining,
    );
    control.signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

class GovernedPlanServiceImpl implements GovernedPlanService {
  readonly #store: GovernedPlanStore;
  readonly #registry: GovernedActionExecutionRegistry;
  readonly #getBindingSnapshot: GovernedPlanServiceOptions['getBindingSnapshot'];
  readonly #auditSink: GovernedPlanAuditSink;
  readonly #ttlMs: number;
  readonly #executionTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #processNonceHash: string;
  readonly #activePlans = new Set<string>();

  constructor(options: GovernedPlanServiceOptions) {
    const safe = inspectServiceOptions(options);
    const ttl = safe.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) {
      fail(
        'GOVERNED_PLAN_CONFIGURATION_INVALID',
        'Governed plan TTL is outside host-owned bounds.',
      );
    }
    const executionTimeout = safe.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(executionTimeout) ||
      executionTimeout < MIN_EXECUTION_TIMEOUT_MS ||
      executionTimeout > MAX_EXECUTION_TIMEOUT_MS
    ) {
      fail(
        'GOVERNED_PLAN_CONFIGURATION_INVALID',
        'Governed plan execution timeout is outside host-owned bounds.',
      );
    }
    this.#store = safe.store;
    this.#registry = safe.registry;
    this.#getBindingSnapshot = safe.getBindingSnapshot;
    this.#auditSink = safe.audit;
    this.#ttlMs = ttl;
    this.#executionTimeoutMs = executionTimeout;
    this.#clock = safe.now ?? (() => new Date());
    this.#processNonceHash = hashOpaqueValue(randomBytes(32).toString('base64url'));
  }

  async #bindingHashes(context: GovernedPlanBindingContext): Promise<{
    sourceVersionHash: string;
    permissionSnapshotHash: string;
    buildNonceHash: string;
  }> {
    const snapshot = validateBindingSnapshot(await this.#getBindingSnapshot(context));
    return {
      sourceVersionHash: hashGovernedValue(snapshot.sourceVersions),
      permissionSnapshotHash: hashGovernedValue(snapshot.permissionSnapshot),
      buildNonceHash: hashOpaqueValue(snapshot.buildNonce),
    };
  }

  async #audit(
    type: GovernedPlanAuditEventType,
    record: GovernedPlanRecord,
    details?: GovernedJsonValue,
  ): Promise<void> {
    const evidenceRefs = Object.freeze(
      record.execution?.outcomes.flatMap((outcome) => [...outcome.evidenceRefs]) ?? [],
    );
    const event = canonicalizeGovernedJson({
      schema: 'openslack.governed_plan_audit.v1',
      eventId: `GAUDIT-${randomUUID()}`,
      type,
      occurredAt: nowIso(this.#clock),
      planId: record.planId,
      kind: record.canonicalPlan.kind,
      actorId: record.bindings.actorId,
      workspaceId: record.bindings.workspaceId,
      correlationId: record.bindings.correlationId,
      state: record.state,
      revision: record.revision,
      evidenceRefs,
      ...(details === undefined ? {} : { details }),
    }) as unknown as GovernedPlanAuditEvent;
    await this.#auditSink(event);
  }

  async preview(
    compilerValue: GovernedPlanCompiler,
    authorityValue: GovernedPlanHostAuthority,
  ): Promise<GovernedPlanPreview> {
    const authority = validateAuthority(authorityValue);
    const compile = getCompile(compilerValue);
    const createdAt = nowIso(this.#clock);
    const expiresAt = new Date(Date.parse(createdAt) + this.#ttlMs).toISOString();
    const correlationId = `CORR-${randomUUID()}`;
    const compilationContext = Object.freeze({
      correlationId,
      createdAt,
      expiresAt,
    });
    const canonicalPlan = createCanonicalGovernedPlan(await compile(compilationContext));
    for (const action of canonicalPlan.actions) {
      if (!this.#registry.has(action.actionId)) {
        return fail(
          'GOVERNED_PLAN_CONFIGURATION_INVALID',
          `Canonical plan references unregistered action ${action.actionId}.`,
        );
      }
    }
    const bindingHashes = await this.#bindingHashes(
      Object.freeze({
        phase: 'preview',
        canonicalPlan,
        authority,
      }),
    );
    const confirmationToken = randomBytes(32).toString('base64url');
    const record = validateGovernedPlanRecord({
      schema: 'openslack.governed_plan.v1',
      revision: 1,
      planId: `GPLAN-${randomUUID()}`,
      state: 'pending',
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      canonicalPlan,
      bindings: {
        actorId: authority.actorId,
        workspaceId: authority.workspaceId,
        correlationId,
        inputHash: hashGovernedValue(canonicalPlan.input),
        planHash: hashGovernedValue(canonicalPlan),
        ...bindingHashes,
        actionCatalogHash: this.#registry.actionCatalogHash,
        executorBindingHash: this.#registry.executorBindingHash,
        processNonceHash: this.#processNonceHash,
      },
      confirmationTokenHash: hashOpaqueValue(confirmationToken),
    });
    const stored = await this.#store.create(record);
    await this.#audit('plan.previewed', stored, {
      planHash: stored.bindings.planHash,
      actionCount: stored.canonicalPlan.actions.length,
      effectCount: stored.canonicalPlan.effects.length,
    });
    return Object.freeze({
      record: stored,
      confirmationToken,
      correlationId,
    });
  }

  async get(planId: string): Promise<GovernedPlanRecord | null> {
    if (typeof planId !== 'string' || !SAFE_PLAN_ID.test(planId)) {
      return fail('GOVERNED_PLAN_NOT_FOUND', 'Governed plan was not found.');
    }
    const record = await this.#store.load(planId);
    if (
      record?.state === 'pending' &&
      Date.parse(record.expiresAt) <= Date.parse(nowIso(this.#clock))
    ) {
      try {
        const expired = await this.#store.expire({
          planId,
          expectedRevision: record.revision,
          updatedAt: nowIso(this.#clock),
        });
        await this.#audit('plan.expired', expired);
        return expired;
      } catch (error) {
        if (
          error instanceof GovernedPlanStoreError &&
          (error.code === 'GOVERNED_PLAN_STORE_BUSY' ||
            error.code === 'GOVERNED_PLAN_STORE_CAS_MISMATCH')
        ) {
          return this.#store.load(planId);
        }
        throw error;
      }
    }
    return record;
  }

  async #assertConfirmation(
    record: GovernedPlanRecord,
    request: GovernedPlanConfirmation,
    authority: GovernedPlanHostAuthority,
  ): Promise<void> {
    if (
      record.bindings.actorId !== authority.actorId ||
      record.bindings.workspaceId !== authority.workspaceId ||
      !opaqueHashesEqual(record.confirmationTokenHash, hashOpaqueValue(request.confirmationToken))
    ) {
      await this.#audit('plan.confirmation_rejected', record);
      return fail(
        'GOVERNED_PLAN_CONFIRMATION_INVALID',
        'Confirmation token or host-bound authority does not match the plan.',
      );
    }
  }

  async #assertCurrentBindings(record: GovernedPlanRecord): Promise<void> {
    const current = await this.#bindingHashes(
      Object.freeze({
        phase: 'confirm',
        canonicalPlan: record.canonicalPlan,
        authority: Object.freeze({
          actorId: record.bindings.actorId,
          workspaceId: record.bindings.workspaceId,
        }),
      }),
    );
    const unchanged =
      opaqueHashesEqual(record.bindings.sourceVersionHash, current.sourceVersionHash) &&
      opaqueHashesEqual(record.bindings.permissionSnapshotHash, current.permissionSnapshotHash) &&
      opaqueHashesEqual(record.bindings.buildNonceHash, current.buildNonceHash) &&
      opaqueHashesEqual(record.bindings.actionCatalogHash, this.#registry.actionCatalogHash) &&
      opaqueHashesEqual(record.bindings.executorBindingHash, this.#registry.executorBindingHash) &&
      opaqueHashesEqual(record.bindings.processNonceHash, this.#processNonceHash);
    if (!unchanged) {
      await this.#audit('plan.confirmation_rejected', record, {
        reason: 'binding_changed',
      });
      return fail(
        'GOVERNED_PLAN_BINDING_CHANGED',
        'Governed plan authority, source, executor, catalog, build, or process binding changed.',
      );
    }
  }

  async #handleExecuting(record: GovernedPlanRecord): Promise<GovernedPlanRecord> {
    if (this.#activePlans.has(record.planId) || !record.execution) {
      return fail('GOVERNED_PLAN_EXECUTION_ACTIVE', 'Governed plan execution is already active.');
    }
    if (!ownerIsProvablyDead(record.execution.ownerPid)) {
      return fail(
        'GOVERNED_PLAN_EXECUTION_ACTIVE',
        'Executing plan owner is live or cannot be proven dead.',
      );
    }
    const reconciled = await this.#store.requireReconciliation({
      planId: record.planId,
      expectedRevision: record.revision,
      executionId: record.execution.executionId,
      completedAt: nowIso(this.#clock),
      failure: 'Previous execution owner ended without a terminal record.',
    });
    await this.#audit('plan.reconciliation_required', reconciled);
    return reconciled;
  }

  async confirm(
    requestValue: GovernedPlanConfirmation,
    authorityValue: GovernedPlanHostAuthority,
    controlValue?: GovernedPlanExecutionControl,
  ): Promise<GovernedPlanRecord> {
    const control = validateExecutionControl(
      controlValue,
      Date.now(),
      Date.now() + this.#executionTimeoutMs,
    );
    const request = validatePlanTokenRequest(requestValue);
    const authority = validateAuthority(authorityValue);
    let record = await this.#store.load(request.planId);
    if (!record) {
      return fail('GOVERNED_PLAN_NOT_FOUND', 'Governed plan was not found.');
    }
    await this.#assertConfirmation(record, request, authority);
    if (record.state === 'executing') return this.#handleExecuting(record);
    if (record.state !== 'pending') {
      return fail(
        'GOVERNED_PLAN_STATE_INVALID',
        `Governed plan cannot execute from ${record.state}.`,
      );
    }
    const confirmedAt = nowIso(this.#clock);
    if (Date.parse(record.expiresAt) <= Date.parse(confirmedAt)) {
      record = await this.#store.expire({
        planId: record.planId,
        expectedRevision: record.revision,
        updatedAt: confirmedAt,
      });
      await this.#audit('plan.expired', record);
      return record;
    }
    await this.#assertCurrentBindings(record);
    if (executionAborted(control)) {
      return fail(
        'GOVERNED_PLAN_EXECUTION_ABORTED',
        'Governed plan execution was aborted before its atomic claim.',
      );
    }

    const executionId = `GEXEC-${randomUUID()}`;
    record = await this.#store.claimExecution({
      planId: record.planId,
      expectedRevision: record.revision,
      executionId,
      ownerPid: process.pid,
      startedAt: nowIso(this.#clock),
    });
    this.#activePlans.add(record.planId);
    const outcomes: GovernedActionOutcome[] = [];
    try {
      await raceExecution(this.#audit('plan.confirmed', record, { executionId }), control);
      await raceExecution(this.#audit('plan.execution_started', record), control);
      let terminal: 'succeeded' | 'blocked' | 'failed' = 'succeeded';
      for (let index = 0; index < record.canonicalPlan.actions.length; index += 1) {
        const outcome = await raceExecution(
          this.#registry.execute(
            record.canonicalPlan.actions[index]!,
            Object.freeze({
              planId: record.planId,
              executionId,
              actorId: record.bindings.actorId,
              workspaceId: record.bindings.workspaceId,
              correlationId: record.bindings.correlationId,
              actionIndex: index,
            }),
          ),
          control,
        );
        outcomes.push(outcome);
        if (outcome.status !== 'succeeded') {
          terminal = outcome.status;
          break;
        }
      }
      if (executionAborted(control)) {
        return fail(
          'GOVERNED_PLAN_EXECUTION_ABORTED',
          'Governed plan execution was aborted before terminal persistence.',
        );
      }
      const last = outcomes.at(-1);
      record = await this.#store.completeExecution({
        planId: record.planId,
        expectedRevision: record.revision,
        executionId,
        state: terminal,
        completedAt: nowIso(this.#clock),
        outcomes,
        ...(terminal === 'blocked' ? { blocker: last?.summary ?? 'Governed action blocked.' } : {}),
        ...(terminal === 'failed' ? { failure: last?.summary ?? 'Governed action failed.' } : {}),
      });
      const eventType =
        terminal === 'succeeded'
          ? 'plan.execution_completed'
          : terminal === 'blocked'
            ? 'plan.execution_blocked'
            : 'plan.execution_failed';
      await this.#audit(eventType, record);
      if (terminal === 'succeeded' && record.canonicalPlan.kind === 'workflow.approval.decide') {
        const input = record.canonicalPlan.input;
        const decision =
          input && typeof input === 'object' && !Array.isArray(input)
            ? (input as { readonly [key: string]: GovernedJsonValue }).decision
            : undefined;
        await this.#audit(
          'workflow.approval_decided',
          record,
          decision === undefined ? undefined : { decision },
        );
      }
      return record;
    } catch (error) {
      try {
        const current = await this.#store.load(record.planId);
        if (current?.state === 'executing' && current.execution?.executionId === executionId) {
          record = await this.#store.completeExecution({
            planId: current.planId,
            expectedRevision: current.revision,
            executionId,
            state: 'reconciliation_required',
            completedAt: nowIso(this.#clock),
            outcomes,
            failure: `Execution ended without a trusted terminal result: ${(error as Error).message}`,
          });
          await this.#audit('plan.reconciliation_required', record);
        }
      } catch {
        // An executing durable record is itself the fail-closed reconciliation marker.
      }
      throw error;
    } finally {
      this.#activePlans.delete(record.planId);
    }
  }

  async cancel(
    requestValue: GovernedPlanCancellation,
    authorityValue: GovernedPlanHostAuthority,
  ): Promise<GovernedPlanRecord> {
    const request = validatePlanTokenRequest(requestValue);
    const authority = validateAuthority(authorityValue);
    const record = await this.#store.load(request.planId);
    if (!record) {
      return fail('GOVERNED_PLAN_NOT_FOUND', 'Governed plan was not found.');
    }
    await this.#assertConfirmation(record, request, authority);
    if (record.state !== 'pending') {
      return fail(
        'GOVERNED_PLAN_STATE_INVALID',
        `Governed plan cannot be cancelled from ${record.state}.`,
      );
    }
    const now = nowIso(this.#clock);
    if (Date.parse(record.expiresAt) <= Date.parse(now)) {
      const expired = await this.#store.expire({
        planId: record.planId,
        expectedRevision: record.revision,
        updatedAt: now,
      });
      await this.#audit('plan.expired', expired);
      return expired;
    }
    const cancelled = await this.#store.cancel({
      planId: record.planId,
      expectedRevision: record.revision,
      updatedAt: now,
    });
    await this.#audit('plan.cancelled', cancelled);
    return cancelled;
  }
}

Object.freeze(GovernedPlanServiceImpl.prototype);

export function createGovernedPlanService(
  options: GovernedPlanServiceOptions,
): GovernedPlanService {
  const service = Object.freeze(new GovernedPlanServiceImpl(options));
  SERVICES.add(service);
  return service;
}

export function isGovernedPlanService(value: unknown): value is GovernedPlanService {
  return Boolean(
    value && typeof value === 'object' && !utilTypes.isProxy(value) && SERVICES.has(value),
  );
}

export function assertGovernedPlanService(value: unknown): GovernedPlanService {
  if (!isGovernedPlanService(value)) {
    return fail(
      'GOVERNED_PLAN_CONFIGURATION_INVALID',
      'Governed plan service must be created by the Operator composition boundary.',
    );
  }
  return value;
}
