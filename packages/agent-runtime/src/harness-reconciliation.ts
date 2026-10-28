import { observeRun } from './run-store.js';
import { assertHarnessRunStorage, hashHarnessTask, type ApprovedHarnessTask, type HarnessTaskHostOptions } from './harness-task-host.js';
import type { AgentRunState } from './types.js';
import { readHarnessStopIntent } from './harness-stop.js';

/** Read-only observations; an unknown process or artifact never authorizes a prompt or continuation. */
export interface HarnessRecoveryObservation {
  deployment: 'matched' | 'changed' | 'unknown';
  workspace: 'matched' | 'changed' | 'unknown';
  process: 'exited' | 'unknown';
}

export interface HarnessReconciliationOptions extends Pick<HarnessTaskHostOptions, 'identityRoot' | 'readTask' | 'authorize'> {
  /** Current source/identity binding only, without the authority to execute or a live execution lease. */
  readTaskForReconciliation?: HarnessTaskHostOptions['readTask'];
  observeExecutionEligibility?(task: ApprovedHarnessTask): Promise<boolean>;
  /** Must perform only bounded reads and fixed read-only inspections; never construct an SDK or a writer. */
  inspect(task: ApprovedHarnessTask, state: AgentRunState): Promise<HarnessRecoveryObservation>;
}

/** No RunStore, Host, Session, lock repair, task replay, or record update is constructed by recovery inspection. */
export async function reconcileHarnessTask(options: HarnessReconciliationOptions, runId: string) {
  assertHarnessRunStorage(options.identityRoot, runId);
  const current = observeRun(runId, options.identityRoot);
  if (current.kind === 'unavailable') return Object.freeze({ runId, readStatus: 'unavailable' as const,
    reason: current.reason, disposition: 'preserve_and_reconcile' as const });
  const state = current.kind === 'ready' ? current.state : null;
  if (!state?.harnessExecution) return null;
  const binding = state.harnessExecution;
  let observation: HarnessRecoveryObservation = { deployment: 'unknown', workspace: 'unknown', process: 'unknown' };
  let authority: 'matched' | 'unavailable' | 'changed' = 'unavailable';
  let currentExecutionEligibility: 'eligible' | 'ineligible' | 'not_observed' = 'not_observed';
  try {
    const task = structuredClone(await (options.readTaskForReconciliation ?? options.readTask)(binding.taskId));
    if (!options.readTaskForReconciliation) await options.authorize(structuredClone(task), 'accept');
    if (hashHarnessTask(task) !== binding.requestHash || task.principalHash !== binding.principalHash) authority = 'changed';
    else {
      authority = 'matched';
      observation = structuredClone(await options.inspect(task, structuredClone(state)));
    }
    if (options.observeExecutionEligibility) currentExecutionEligibility = await options.observeExecutionEligibility(structuredClone(task)) ? 'eligible' : 'ineligible';
  } catch { /* Current authority or evidence is unavailable; historical bytes remain untouched. */ }
  const stopRequested = !!readHarnessStopIntent(options.identityRoot, runId);
  return Object.freeze({ runId, taskId: binding.taskId, status: state.status, acceptance: binding.acceptance, authority,
    currentExecutionEligibility, stopRequested,
    ...observation, disposition: !stopRequested && binding.processExit === 'confirmed' && authority === 'matched' && observation.deployment === 'matched' && observation.workspace === 'matched' &&
      observation.process === 'exited' && state.status === 'completed' && binding.acceptance === 'verified'
      ? 'existing_verified_result' as const : 'preserve_and_reconcile' as const,
  });
}
