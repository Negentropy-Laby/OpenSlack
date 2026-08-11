import type { RunStatusState } from './types.js';

export type WorkflowRunnerRunDisposition = 'initialize' | 'resume';

export class WorkflowRunnerRunStateError extends Error {
  readonly code = 'WORKFLOW_RUNNER_RECOVERY_REQUIRED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunnerRunStateError';
  }
}

/** Pure fail-closed routing used after an advancing lease-accept receipt. */
export function classifyWorkflowRunnerRunState(
  runId: string,
  exists: boolean,
  status: RunStatusState | null,
): WorkflowRunnerRunDisposition {
  if (!exists) return 'initialize';
  if (status === null) {
    throw new WorkflowRunnerRunStateError(
      `Workflow run ${runId} exists without readable status and requires operator recovery.`,
    );
  }
  if (['paused', 'paused_waiting_approval', 'resuming'].includes(status)) return 'resume';
  throw new WorkflowRunnerRunStateError(
    `Workflow run ${runId} cannot resume from status "${status}" and requires operator recovery.`,
  );
}
