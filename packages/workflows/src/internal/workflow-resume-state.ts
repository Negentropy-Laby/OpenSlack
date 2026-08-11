import type { RunStatusState } from '../types.js';

export type WorkflowResumeStatus = Extract<
  RunStatusState,
  'paused' | 'paused_waiting_approval' | 'resuming'
>;

const WORKFLOW_RESUME_STATES = new Set<RunStatusState>([
  'paused',
  'paused_waiting_approval',
  'resuming',
]);

/** Single fail-closed state rule shared by CLI checks, workers, and execution. */
export function isWorkflowResumeStatus(value: RunStatusState): value is WorkflowResumeStatus {
  return WORKFLOW_RESUME_STATES.has(value);
}
