import type {
  PRBranchCleanupAuditEvent,
  PRBranchCleanupResult,
  PRBranchCleanupInput,
} from './cleanup-types.js';
import type { CleanupBrokerResponse } from './cleanup-broker-client.js';

type CleanupEventType =
  | 'pr.cleanup_branch.blocked'
  | 'pr.cleanup_branch.previewed'
  | 'pr.cleanup_branch.requested'
  | 'pr.cleanup_branch.executed'
  | 'pr.cleanup_branch.already_absent'
  | 'pr.cleanup_branch.reconciliation_required';

export function projectPRBranchCleanupEvent(event: PRBranchCleanupAuditEvent) {
  let type: CleanupEventType = 'pr.cleanup_branch.blocked';
  if (event.mode === 'preview' && event.state === 'CLEANUP_READY')
    type = 'pr.cleanup_branch.previewed';
  else if (event.phase === 'requested') type = 'pr.cleanup_branch.requested';
  else if (event.state === 'DELETED') type = 'pr.cleanup_branch.executed';
  else if (event.state === 'ALREADY_ABSENT') type = 'pr.cleanup_branch.already_absent';
  else if (['RECONCILIATION_REQUIRED', 'ABSENT_AFTER_ATTEMPT'].includes(event.state)) {
    type = 'pr.cleanup_branch.reconciliation_required';
  }
  return {
    type,
    // human-cli denotes an explicit calling mode, not proof of a human login.
    actor: {
      id: event.executor,
      kind: event.executor === 'human-cli' ? ('system' as const) : ('agent' as const),
      provider: 'cli' as const,
    },
    object: { kind: 'pr' as const, id: String(event.prNumber) },
    source: { kind: 'prms' as const, ref: 'pr.cleanup-branch' },
    summary: `PR #${event.prNumber} branch cleanup: ${event.phase} / ${event.state}`,
    visibility: 'local' as const,
    redacted: false as const,
    containsSensitiveData: false as const,
    correlationId: event.operationId,
    metadata: {
      operation_id: event.operationId,
      repository: event.repository,
      pr_number: event.prNumber,
      branch: event.branch,
      expected_sha: event.expectedSha,
      observed_sha: event.observedSha,
      observed_ref_state: event.observedRefState,
      outcome: event.state,
      attempted: event.attempted,
      executor: event.executor,
      authorization_source: event.authorizationSource,
      evidence_timestamp: event.evidenceTimestamp,
      transport_identity: 'github_app_installation',
    },
  };
}

/** Acceptance is distinct from completion; uncertainty always requires reconciliation. */
export function evaluateCleanupBrokerResult(result: CleanupBrokerResponse): {
  exitCode: 0 | 1;
  notice?: string;
  completed: boolean;
} {
  const failure =
    result.auditStatus === 'FAILED' ||
    ['unknown', 'expired', 'revoked'].includes(result.permitState) ||
    result.permitState === 'reconciliation_required' ||
    ['RECONCILIATION_REQUIRED', 'ABSENT_AFTER_ATTEMPT', 'OPERATION_NOT_FOUND', 'FAILED'].includes(
      result.state,
    );
  if (failure)
    return {
      exitCode: 1,
      completed: false,
      notice:
        result.mode === 'preview'
          ? 'Preview refused or unresolved. Execution is not authorized.'
          : 'Operation unresolved. Query --operation-status with the same operation ID; do not repeat execute.',
    };
  if (
    result.mode !== 'preview' &&
    result.state === 'OPERATION_IN_PROGRESS' &&
    result.permitState === 'reserved'
  )
    return {
      exitCode: 0,
      completed: false,
      notice:
        'Operation accepted and still running; cleanup has not completed. Query --operation-status with the same operation ID; do not repeat execute.',
    };
  const completed =
    result.mode !== 'preview' &&
    ['DELETED', 'ALREADY_ABSENT'].includes(result.state) &&
    result.permitState === 'consumed' &&
    result.auditStatus === 'RECORDED';
  const success =
    result.mode === 'preview'
      ? result.permitState === 'issued' &&
        ['CLEANUP_READY', 'ALREADY_ABSENT'].includes(result.state)
      : completed;
  return { exitCode: success ? 0 : 1, completed };
}

export function evaluatePRBranchCleanupResult(
  result: PRBranchCleanupResult,
  execute: boolean,
): 0 | 1 {
  if (result.auditStatus === 'FAILED') return 1;
  return (execute ? ['DELETED', 'ALREADY_ABSENT'] : ['CLEANUP_READY', 'ALREADY_ABSENT']).includes(
    result.state,
  )
    ? 0
    : 1;
}

/** Same fields and authorization semantics for fallback notifications and durable intent/outcome. */
export function createPRBranchCleanupAuditEvent(
  input: Pick<PRBranchCleanupInput, 'execute' | 'context'>,
  result: PRBranchCleanupResult,
  phase: 'requested' | 'outcome',
): PRBranchCleanupAuditEvent {
  const context = input.context;
  const executor =
    context?.kind === 'human-cli'
      ? 'human-cli'
      : context?.kind === 'agent' &&
          /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context.principal?.registry_id ?? '')
        ? context.principal.registry_id
        : 'unknown';
  return {
    mode: input.execute ? 'execute' : 'preview',
    phase,
    operationId: result.operationId,
    repository: result.repository,
    prNumber: result.prNumber,
    branch: result.branch,
    expectedSha: result.expectedSha,
    observedSha: result.observedSha,
    observedRefState: result.observedRefState,
    state: result.state,
    attempted: result.attempted,
    executor,
    authorizationSource: !input.execute
      ? 'preview-only'
      : executor === 'human-cli'
        ? 'human-cli:--execute'
        : 'registry:pr.cleanup_branch',
    evidenceTimestamp: result.evidenceTimestamp,
  };
}
