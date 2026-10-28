import { types as utilTypes } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  assertGovernedPlanService,
  createGovernedPlanCompiler,
  type CreateCanonicalGovernedPlanInput,
  type GovernedPlanCompilationContext,
  type GovernedPlanHostAuthority,
  type GovernedPlanPreview,
  type GovernedPlanRecord,
  type GovernedPlanService,
} from '@openslack/operator';

export interface OpenSlackGovernedMutationInvocation {
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

export interface OpenSlackGovernedMutationPort {
  previewScenario(
    input: Readonly<Record<string, unknown>>,
    invocation: OpenSlackGovernedMutationInvocation,
  ): Promise<GovernedPlanPreview>;
  previewWorkflow(
    input: Readonly<Record<string, unknown>>,
    invocation: OpenSlackGovernedMutationInvocation,
  ): Promise<GovernedPlanPreview>;
  confirm(
    input: Readonly<Record<string, unknown>>,
    invocation: OpenSlackGovernedMutationInvocation,
  ): Promise<GovernedPlanRecord>;
  cancel(
    input: Readonly<Record<string, unknown>>,
    invocation: OpenSlackGovernedMutationInvocation,
  ): Promise<GovernedPlanRecord>;
  get(planId: string): Promise<GovernedPlanRecord | null>;
}

export interface OpenSlackGovernedPlanCompilerInput {
  readonly input: Readonly<Record<string, unknown>>;
  readonly authority: GovernedPlanHostAuthority;
  readonly compilation: GovernedPlanCompilationContext;
}

export interface CreateOpenSlackGovernedMutationPortOptions {
  readonly service: GovernedPlanService;
  readonly authority: GovernedPlanHostAuthority;
  readonly compileScenario: (
    input: OpenSlackGovernedPlanCompilerInput,
  ) => CreateCanonicalGovernedPlanInput | Promise<CreateCanonicalGovernedPlanInput>;
  readonly compileWorkflow: (
    input: OpenSlackGovernedPlanCompilerInput,
  ) => CreateCanonicalGovernedPlanInput | Promise<CreateCanonicalGovernedPlanInput>;
  /** Always observes durable readback after confirmation/cancellation, including partial failure. */
  readonly onConfirmationSettled?: (planId: string, outcome: Readonly<{ operation: 'confirm' | 'cancel'; attemptId: string; failed: boolean; failureCode?: string; aborted: boolean }>) => void | Promise<void>;
}

/** The effect is already durable. This error cannot authorize a retry or claim
 * that a task admission was released; it only carries immutable readback. */
export class GovernedMutationSettlementUnconfirmedError extends Error {
  readonly code = 'GOVERNED_MUTATION_SETTLEMENT_UNCONFIRMED';
  readonly durableRecord: GovernedPlanRecord;
  constructor(readonly operation: 'confirm' | 'cancel', record: GovernedPlanRecord, cause: unknown) {
    super('The governed result is durable but host settlement is unconfirmed; reconcile without replay.', { cause });
    this.name = 'GovernedMutationSettlementUnconfirmedError';
    const copy = structuredClone(record), pending: object[] = [copy];
    while (pending.length) {
      const value = pending.pop()!;
      for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) pending.push(child);
      Object.freeze(value);
    }
    this.durableRecord = copy;
  }
}

const mutationAttempts = new AsyncLocalStorage<string>();
/** Correlation only, never authority; available solely inside the host's actual service invocation. */
export function currentGovernedMutationAttempt(): string | undefined { return mutationAttempts.getStore(); }

const NOMINAL_PORTS = new WeakSet<object>();
const SAFE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function assertHostFunction(
  value: unknown,
  label: string,
): asserts value is CreateOpenSlackGovernedMutationPortOptions['compileScenario'] {
  if (typeof value !== 'function' || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a host-owned non-Proxy function.`);
  }
}

function authority(value: unknown): GovernedPlanHostAuthority {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('Governed mutation authority must be an inert host-owned object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !['actorId', 'workspaceId'].includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    throw new TypeError('Governed mutation authority has missing or unknown fields.');
  }
  const actorId = descriptors.actorId!.value;
  const workspaceId = descriptors.workspaceId!.value;
  if (
    typeof actorId !== 'string' ||
    !SAFE_AUTHORITY.test(actorId) ||
    typeof workspaceId !== 'string' ||
    !SAFE_AUTHORITY.test(workspaceId)
  ) {
    throw new TypeError('Governed mutation authority contains an invalid identifier.');
  }
  return Object.freeze({ actorId, workspaceId });
}

function invocation(
  value: OpenSlackGovernedMutationInvocation,
): OpenSlackGovernedMutationInvocation {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('Governed mutation invocation must be host-owned.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !['signal', 'deadlineAt'].includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    throw new TypeError('Governed mutation invocation has missing or unknown fields.');
  }
  const signal = descriptors.signal!.value;
  const deadlineAt = descriptors.deadlineAt!.value;
  if (
    utilTypes.isProxy(signal) ||
    !(signal instanceof AbortSignal) ||
    typeof deadlineAt !== 'string' ||
    !Number.isFinite(Date.parse(deadlineAt)) ||
    new Date(Date.parse(deadlineAt)).toISOString() !== deadlineAt
  ) {
    throw new TypeError('Governed mutation invocation contains invalid execution control.');
  }
  return Object.freeze({ signal, deadlineAt });
}

function businessInput(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('Governed mutation input must be validated inert data.');
  }
  return value;
}

function tokenInput(value: Readonly<Record<string, unknown>>): {
  readonly planId: string;
  readonly confirmationToken: string;
} {
  const input = businessInput(value);
  const planId = input.planId;
  const confirmationToken = input.confirmationToken;
  if (typeof planId !== 'string' || typeof confirmationToken !== 'string') {
    throw new TypeError('Governed mutation token input is invalid.');
  }
  return Object.freeze({ planId, confirmationToken });
}

export function createOpenSlackGovernedMutationPort(
  options: CreateOpenSlackGovernedMutationPortOptions,
): OpenSlackGovernedMutationPort {
  if (!options || typeof options !== 'object' || utilTypes.isProxy(options)) {
    throw new TypeError('Governed mutation port options must be host-owned.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const expected = ['authority', 'compileScenario', 'compileWorkflow', 'service',
    ...(Object.hasOwn(descriptors, 'onConfirmationSettled') ? ['onConfirmationSettled'] : [])];
  if (
    Reflect.ownKeys(descriptors).length !== expected.length ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !expected.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    throw new TypeError('Governed mutation port options have missing or unknown fields.');
  }
  const service = assertGovernedPlanService(descriptors.service!.value);
  const boundAuthority = authority(descriptors.authority!.value);
  const compileScenario = descriptors.compileScenario!.value;
  const compileWorkflow = descriptors.compileWorkflow!.value;
  assertHostFunction(compileScenario, 'compileScenario');
  assertHostFunction(compileWorkflow, 'compileWorkflow');
  const onSettled: CreateOpenSlackGovernedMutationPortOptions['onConfirmationSettled'] = descriptors.onConfirmationSettled?.value;
  if (onSettled !== undefined && (typeof onSettled !== 'function' || utilTypes.isProxy(onSettled))) throw new TypeError('onConfirmationSettled must be host-owned.');
  const settle = async (operation: 'confirm' | 'cancel', request: ReturnType<typeof tokenInput>, control: ReturnType<typeof invocation>,
    action: () => Promise<GovernedPlanRecord>): Promise<GovernedPlanRecord> => {
    const attemptId = randomUUID();
    let result: GovernedPlanRecord;
    try { result = await mutationAttempts.run(attemptId, action); }
    catch (error) {
      const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      try { await onSettled?.(request.planId, { operation, attemptId, failed: true, aborted: control.signal.aborted, ...(failureCode ? { failureCode } : {}) }); }
      catch (secondary) {
        const combined = new AggregateError([error, secondary], 'Governed execution and settlement both failed.', { cause: error });
        if (failureCode) Object.defineProperty(combined, 'code', { value: failureCode });
        throw combined;
      }
      throw error;
    }
    try { await onSettled?.(request.planId, { operation, attemptId, failed: false, aborted: control.signal.aborted }); }
    catch (secondary) { throw new GovernedMutationSettlementUnconfirmedError(operation, result, secondary); }
    return result;
  };

  const preview = async (
    inputValue: Readonly<Record<string, unknown>>,
    invocationValue: OpenSlackGovernedMutationInvocation,
    compile: CreateOpenSlackGovernedMutationPortOptions['compileScenario'],
  ): Promise<GovernedPlanPreview> => {
    const input = businessInput(inputValue);
    const control = invocation(invocationValue);
    if (control.signal.aborted || Date.now() >= Date.parse(control.deadlineAt)) {
      throw new Error('GOVERNED_MUTATION_ABORTED_BEFORE_PREVIEW');
    }
    return service.preview(
      createGovernedPlanCompiler((compilation) =>
        compile(
          Object.freeze({
            input,
            authority: boundAuthority,
            compilation,
          }),
        ),
      ),
      boundAuthority,
    );
  };

  const port: OpenSlackGovernedMutationPort = Object.freeze({
    previewScenario: (
      inputValue: Readonly<Record<string, unknown>>,
      invocationValue: OpenSlackGovernedMutationInvocation,
    ) => preview(inputValue, invocationValue, compileScenario),
    previewWorkflow: (
      inputValue: Readonly<Record<string, unknown>>,
      invocationValue: OpenSlackGovernedMutationInvocation,
    ) => preview(inputValue, invocationValue, compileWorkflow),
    confirm: (
      inputValue: Readonly<Record<string, unknown>>,
      invocationValue: OpenSlackGovernedMutationInvocation,
    ) => {
      const control = invocation(invocationValue);
      const request = tokenInput(inputValue);
      return settle('confirm', request, control, () => service.confirm(request, boundAuthority, control));
    },
    cancel: (
      inputValue: Readonly<Record<string, unknown>>,
      invocationValue: OpenSlackGovernedMutationInvocation,
    ) => {
      const control = invocation(invocationValue);
      if (control.signal.aborted || Date.now() >= Date.parse(control.deadlineAt)) {
        throw new Error('GOVERNED_MUTATION_ABORTED_BEFORE_CANCEL');
      }
      const request = tokenInput(inputValue);
      return settle('cancel', request, control, () => service.cancel(request, boundAuthority));
    },
    get: (planId: string) => service.get(planId),
  });
  NOMINAL_PORTS.add(port);
  return port;
}

export function assertOpenSlackGovernedMutationPort(value: unknown): OpenSlackGovernedMutationPort {
  if (
    !value ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !NOMINAL_PORTS.has(value)
  ) {
    throw new TypeError('Governed mutation port must be created by the MCP composition boundary.');
  }
  return value as OpenSlackGovernedMutationPort;
}
