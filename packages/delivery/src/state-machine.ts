import { DeliveryError } from './errors.js';
import type { DeliveryState } from './types.js';

const ALLOWED: Record<DeliveryState, DeliveryState[]> = {
  PREPARED: ['PUSHED'],
  PUSHED: ['PR_CREATED', 'PR_UPDATED'],
  PR_CREATED: ['HEAD_SYNCHRONIZED'],
  PR_UPDATED: ['HEAD_SYNCHRONIZED'],
  HEAD_SYNCHRONIZED: ['AWAITING_GATES'],
  AWAITING_GATES: [],
};

export function advanceDeliveryState(
  history: readonly DeliveryState[],
  next: DeliveryState,
): DeliveryState[] {
  const current = history.at(-1);
  if (!current || !ALLOWED[current].includes(next)) {
    throw new DeliveryError(
      'DELIVERY_PR_FAILED',
      `Invalid delivery transition ${current ?? '(none)'} -> ${next}.`,
      false,
    );
  }
  return [...history, next];
}
