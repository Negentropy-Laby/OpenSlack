import type { GovernedPlanRecord, GovernedPlanService } from '@openslack/operator';
import type { HarnessTaskHost } from '@openslack/agent-runtime/internal/harness';
import type { GovernedMutationSettlementOutcome } from './mutations.js';
import { fileURLToPath } from 'node:url';

export const GOVERNED_CONFIRMATION_SOURCE = fileURLToPath(import.meta.url);

type Settlement =
  | { kind: 'committed'; record: GovernedPlanRecord }
  | { kind: 'rejected'; record: GovernedPlanRecord }
  | { kind: 'pending' }
  | { kind: 'unresolved' };

/** Deliberately exhaustive: a new persisted state needs an explicit disposition. */
function classify(record: GovernedPlanRecord | null, returned: boolean): Settlement {
  if (!record) return { kind: 'unresolved' };
  const state = record.state;
  switch (state) {
    case 'succeeded': return returned ? { kind: 'committed', record } : { kind: 'unresolved' };
    case 'blocked': case 'failed': case 'cancelled': case 'expired': return { kind: 'rejected', record };
    case 'pending': case 'executing': return { kind: 'pending' };
    case 'reconciliation_required': return { kind: 'unresolved' };
    default: { const unhandled: never = state; throw new TypeError(`Unsupported governed state: ${unhandled}`); }
  }
}

async function observe(service: GovernedPlanService, planId: string): Promise<GovernedPlanRecord | null> {
  for (let attempt = 0; ; attempt++) {
    try { return await service.get(planId); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (attempt >= 2 || !['EBUSY', 'EPERM', 'GOVERNED_PLAN_STORE_BUSY', 'GOVERNED_PLAN_STORE_FILE_CHANGED'].includes(String(code))) return null;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
}

/** Host-only observer; uncertain reads hold admission and never replay confirmation. */
export function createHarnessConfirmationObserver(host: HarnessTaskHost, service: GovernedPlanService) {
  return async (planId: string, outcome: GovernedMutationSettlementOutcome): Promise<void> => {
    const record = outcome.failed ? await observe(service, planId) : outcome.record;
    const result = classify(record?.planId === planId ? record : null, !outcome.failed);
    switch (result.kind) {
      case 'pending': case 'unresolved': return;
      case 'committed': case 'rejected':
        host.settleConfirmedAdmissions(planId, { state: result.record.state, confirmationAttemptId: outcome.attemptId,
          ...(result.record.execution?.executionId ? { executionId: result.record.execution.executionId } : {}) });
    }
  };
}
