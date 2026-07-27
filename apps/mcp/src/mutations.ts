import { types as utilTypes } from 'node:util';
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
}

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
  const expected = ['authority', 'compileScenario', 'compileWorkflow', 'service'];
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
      return service.confirm(tokenInput(inputValue), boundAuthority, control);
    },
    cancel: (
      inputValue: Readonly<Record<string, unknown>>,
      invocationValue: OpenSlackGovernedMutationInvocation,
    ) => {
      const control = invocation(invocationValue);
      if (control.signal.aborted || Date.now() >= Date.parse(control.deadlineAt)) {
        throw new Error('GOVERNED_MUTATION_ABORTED_BEFORE_CANCEL');
      }
      return service.cancel(tokenInput(inputValue), boundAuthority);
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
