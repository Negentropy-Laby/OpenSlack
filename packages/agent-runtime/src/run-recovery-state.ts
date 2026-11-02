import type { AgentRunEvent, AgentRunState } from './types.js';

/** Private, format-preserving projection shared by publication headroom and
 * authorized repair. These bytes never supply maintenance authority. */
export function failedRunRecoveryState(original: AgentRunState, target: {
  now: string; transactionId: string; previousTransactionId: string;
  inspectionSha256: string; revision: number; transcriptBytes: number;
}): { state: AgentRunState; event: AgentRunEvent } {
  const summary = 'Storage publication was incomplete; preserve evidence and reconcile without replay.';
  const event: AgentRunEvent = { timestamp: target.now, type: 'fail', data: {
    failureCode: 'EXECUTION_FAILED', errorSummary: summary, storageRecovery: target.inspectionSha256,
  } };
  const state: AgentRunState = { ...original, status: 'failed', completedAt: target.now,
    failureCode: 'EXECUTION_FAILED', errorSummary: summary, error: summary,
    ...(original.harnessExecution ? { harnessExecution: { ...original.harnessExecution,
      acceptance: 'indeterminate', summary, stopRequestedAt: target.now,
      lifecycle: original.harnessExecution.lifecycle ? { ...original.harnessExecution.lifecycle, phase: 'indeterminate' } : undefined,
    } } : {}),
    persistence: { ...original.persistence!, transactionId: target.transactionId, revision: target.revision,
      transcriptBytes: target.transcriptBytes, recovery: { inspectionSha256: target.inspectionSha256,
        previousTransactionId: target.previousTransactionId, outcome: 'indeterminate' } },
  };
  return { state, event };
}

/** Keep the existing 512 KiB reader bound. The same recovery encoder provides
 * a conservative upper bound before any ordinary intent is published. */
export function failedRunRecoveryEncodingBound(state: AgentRunState): number {
  const projected = failedRunRecoveryState(state, { now: '+275760-09-13T00:00:00.000Z',
    transactionId: 'f'.repeat(36), previousTransactionId: 'f'.repeat(36), inspectionSha256: 'f'.repeat(64),
    revision: Number.MAX_SAFE_INTEGER, transcriptBytes: 64 * 1024 * 1024 });
  return Buffer.byteLength(JSON.stringify(projected.state, null, 2));
}

/** Every writer preserves the fixed metadata expansion of already-authorized
 * results. This is capacity prediction only: no digest or settled result is
 * written, no pending call is granted, and the input remains untouched. */
export function runPublicationEncodingBound(state: AgentRunState): number {
  let projected = state;
  const binding = state.harnessExecution, evidence = binding?.evidence;
  if (binding && evidence) {
    const calls = Object.fromEntries(Object.entries(evidence.calls).map(([id, call]) => [id,
      !call.resultDigest && call.phase !== 'not_dispatched' ? { ...call, resultDigest: 'f'.repeat(64) } : call] as const));
    // Keep the longer pre-result phase and reservedBytes representation. Actual
    // settlement changes phase to settled and only reduces outstanding bytes.
    projected = { ...state, harnessExecution: { ...binding, evidence: { ...evidence, calls } } };
  }
  return Math.max(Buffer.byteLength(JSON.stringify(projected, null, 2)), failedRunRecoveryEncodingBound(projected));
}
