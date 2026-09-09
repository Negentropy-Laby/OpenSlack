import type { WorkflowRunnerAuthorityControlDeliveryValidationContext } from '../../workflow-runner-authority-binding-contract.js';

interface Value {
  readonly value: unknown;
}
interface Exchange {
  readonly stage: Value;
  readonly stageReceipt: Value;
  readonly resolution: Value;
  readonly resolutionReceipt: Value;
}
interface Artifact {
  readonly operation: string;
  readonly message: unknown;
  readonly receipt: Value;
  readonly priorEventDeliveryRef: string | null;
  readonly budgetSourceResult: unknown;
}
interface Fixture {
  readonly positive: {
    readonly operations: Readonly<Record<string, Exchange>>;
    readonly semanticVariants: Readonly<Record<string, Exchange>>;
    readonly controlDelivery: {
      readonly byKind: Readonly<Record<string, string>>;
      readonly artifacts: Readonly<Record<string, Artifact>>;
      readonly priorEventDeliveries: Readonly<
        Record<string, { readonly message: unknown; readonly receipt: Value }>
      >;
      readonly messages: { readonly accepted: Readonly<Record<string, unknown>> };
      readonly accepted: Readonly<Record<string, Value>>;
    };
  };
}

/** Fixture wiring failures are configuration errors, never expected contract rejections. */
export function bindingGoldenContext(fixture: Fixture, kind: string) {
  const deliveries = fixture.positive.controlDelivery;
  const artifact = deliveries.artifacts[deliveries.byKind[kind]];
  if (!artifact) throw new Error('Missing boundary control artifact.');
  const exchange =
    kind === 'budget_authorization'
      ? fixture.positive.semanticVariants.budgetReserveGoAuthority
      : fixture.positive.operations[artifact.operation];
  if (
    !exchange?.stage ||
    !exchange.stageReceipt ||
    !exchange.resolution ||
    !exchange.resolutionReceipt
  )
    throw new Error('Missing boundary operation context.');
  const prior = artifact.priorEventDeliveryRef
    ? deliveries.priorEventDeliveries[artifact.priorEventDeliveryRef]
    : null;
  if (artifact.priorEventDeliveryRef && !prior) throw new Error('Missing boundary prior delivery.');
  if (
    !prior &&
    kind !== 'event_receipt' &&
    (!deliveries.messages.accepted[artifact.operation] || !deliveries.accepted[artifact.operation])
  )
    throw new Error('Missing boundary accepted prior delivery.');
  const context: WorkflowRunnerAuthorityControlDeliveryValidationContext = {
    stage: exchange.stage.value,
    stageReceipt: exchange.stageReceipt.value,
    resolution: exchange.resolution.value,
    resolutionReceipt: exchange.resolutionReceipt.value,
    priorEventDelivery: prior
      ? { message: prior.message, receipt: prior.receipt.value }
      : kind === 'event_receipt'
        ? null
        : {
            message: deliveries.messages.accepted[artifact.operation],
            receipt: deliveries.accepted[artifact.operation].value,
          },
    budgetSourceResult: artifact.budgetSourceResult,
  };
  return { artifact, context };
}
