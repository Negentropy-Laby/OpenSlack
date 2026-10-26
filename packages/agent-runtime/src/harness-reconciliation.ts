import { readRunStateSnapshot } from './run-store.js';
import { assertHarnessRunStorage, hashHarnessTask, type ApprovedHarnessTask, type HarnessTaskHostOptions } from './harness-task-host.js';
import type { AgentRunState } from './types.js';

/** Read-only observations; an unknown process or artifact never authorizes a prompt or continuation. */
export interface HarnessRecoveryObservation {
  deployment: 'matched' | 'changed' | 'unknown';
  workspace: 'matched' | 'changed' | 'unknown';
  process: 'exited' | 'unknown';
}

export interface HarnessReconciliationOptions extends Pick<HarnessTaskHostOptions, 'identityRoot' | 'readTask' | 'authorize'> {
  /** Must perform only bounded reads and fixed read-only inspections; never construct an SDK or a writer. */
  inspect(task: ApprovedHarnessTask, state: AgentRunState): Promise<HarnessRecoveryObservation>;
}

/** No RunStore, Host, Session, lock repair, task replay, or record update is constructed by recovery inspection. */
export async function reconcileHarnessTask(options: HarnessReconciliationOptions, runId: string) {
  assertHarnessRunStorage(options.identityRoot, runId);
  const state = readRunStateSnapshot(runId, options.identityRoot);
  if (!state?.harnessExecution) return null;
  const binding = state.harnessExecution;
  let observation: HarnessRecoveryObservation = { deployment: 'unknown', workspace: 'unknown', process: 'unknown' };
  let authority: 'matched' | 'unavailable' | 'changed' = 'unavailable';
  try {
    const task = structuredClone(await options.readTask(binding.taskId));
    await options.authorize(structuredClone(task), 'accept');
    if (hashHarnessTask(task) !== binding.requestHash || task.principalHash !== binding.principalHash) authority = 'changed';
    else {
      authority = 'matched';
      observation = structuredClone(await options.inspect(task, structuredClone(state)));
    }
  } catch { /* Current authority or evidence is unavailable; historical bytes remain untouched. */ }
  return Object.freeze({ runId, taskId: binding.taskId, status: state.status, acceptance: binding.acceptance, authority,
    ...observation, disposition: binding.processExit === 'confirmed' && authority === 'matched' && observation.deployment === 'matched' && observation.workspace === 'matched' &&
      observation.process === 'exited' && state.status === 'completed' && binding.acceptance === 'verified'
      ? 'existing_verified_result' as const : 'preserve_and_reconcile' as const,
  });
}
