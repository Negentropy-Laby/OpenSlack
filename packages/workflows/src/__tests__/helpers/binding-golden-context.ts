import type { WorkflowRunnerAuthorityControlDeliveryValidationContext } from '../../workflow-runner-authority-binding-contract.js';
import type { Golden } from './binding-golden-types.js';

/** Fixture wiring failures are configuration errors, never expected contract rejections. */
export function bindingGoldenContext(fixture: Golden, kind: string) {
  const deliveries = fixture.positive.controlDelivery;
  if (!Object.hasOwn(deliveries.byKind, kind)) throw new Error('Unknown boundary control kind.');
  const artifact = deliveries.artifacts[deliveries.byKind[kind as keyof typeof deliveries.byKind]];
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
