import type { RunRecorder } from './recorder.js';

export class AgentRunCancelledError extends Error {
  readonly runId: string;
  readonly reason: string;

  constructor(runId: string, reason: string) {
    super(`Agent run ${runId} cancelled: ${reason}`);
    this.name = 'AgentRunCancelledError';
    this.runId = runId;
    this.reason = reason;
  }
}

export interface ActiveAgentRunControl {
  runId: string;
  abortController: AbortController;
  recorder: RunRecorder;
  startedAt: string;
}

export interface AgentRunCancelResult {
  runId: string;
  status: 'cancelled' | 'not_found' | 'already_cancelled';
  message: string;
}

const activeRuns = new Map<string, ActiveAgentRunControl>();

export function registerActiveAgentRunControl(handle: ActiveAgentRunControl): () => void {
  activeRuns.set(handle.runId, handle);
  return () => {
    if (activeRuns.get(handle.runId) === handle) {
      activeRuns.delete(handle.runId);
    }
  };
}

export function getActiveAgentRunControl(runId: string): ActiveAgentRunControl | undefined {
  return activeRuns.get(runId);
}

export function requestAgentRunCancellation(
  runId: string,
  reason = 'workflow control requested cancellation',
): AgentRunCancelResult {
  const handle = activeRuns.get(runId);
  if (!handle) {
    return {
      runId,
      status: 'not_found',
      message: `No live agent runtime handle found for ${runId}.`,
    };
  }
  if (handle.abortController.signal.aborted) {
    return {
      runId,
      status: 'already_cancelled',
      message: `Agent run ${runId} is already cancelling.`,
    };
  }
  handle.recorder.progress(runId, {
    step: 'agent_cancel_requested',
    reason,
  });
  handle.abortController.abort(new AgentRunCancelledError(runId, reason));
  return {
    runId,
    status: 'cancelled',
    message: `Cancellation requested for live agent run ${runId}.`,
  };
}
