import type {
  WorkflowControlAuthorityPort,
  WorkflowControlAuthorityRunRead,
} from '../workflow-control-authority-client.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import { WorkflowRunReadError } from '../workflow-run-read-errors.js';
import type { WorkflowRunnerV2ExecutionDescriptor } from '../workflow-runner-v2-descriptor.js';

const accepted = new WeakMap<object, WorkflowControlAuthorityRunRead>();
export interface AcceptedWorkflowRunProof {
  readonly kind: 'accepted-workflow-run';
}

/** Read authority, rather than treating a descriptor or missing cache as acceptance. */
export async function verifyAcceptedWorkflowRun(
  authority: WorkflowControlAuthorityPort,
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
): Promise<AcceptedWorkflowRunProof> {
  const head = await authority.readIfExists(descriptor.workflowRunId, descriptor.authorityRoute);
  const record = head && {
    schema: 'openslack.workflow_control_authority_run_record.v2',
    workspaceId: descriptor.workspaceId,
    runId: descriptor.workflowRunId,
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.workflowVersion,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
    route: descriptor.authorityRoute,
    state: head.state,
    revision: head.revision,
    currentPhaseId: head.currentPhaseId,
    currentPhaseIndex: head.currentPhaseIndex,
    resumeGeneration: head.resumeGeneration,
  };
  if (
    !head ||
    head.schema !== 'openslack.workflow_control_authority_read.v2' ||
    canonical(head.record) !== canonical(record) ||
    head.workspaceId !== descriptor.workspaceId ||
    head.runId !== descriptor.workflowRunId ||
    head.workflowId !== descriptor.workflowId ||
    head.workflowVersion !== descriptor.workflowVersion ||
    head.workflowSourceHash !== descriptor.workflowSourceHash ||
    head.manifestHash !== descriptor.manifestHash ||
    head.inputHash !== descriptor.inputHash ||
    canonical(head.route) !== canonical(descriptor.authorityRoute) ||
    (head.state !== 'created' && head.state !== 'running') ||
    head.resumeGeneration !== 0 ||
    !Number.isSafeInteger(head.revision) ||
    head.revision < 1 ||
    (head.state === 'created' && head.revision !== 1)
  ) {
    throw new WorkflowRunReadError([
      {
        code: 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
        scope: 'run',
        backend: 'go',
        runId: descriptor.workflowRunId,
      },
    ]);
  }
  const proof = Object.freeze({ kind: 'accepted-workflow-run' as const });
  accepted.set(proof, structuredClone(head));
  return proof;
}

/** A proof is consumed once and cannot authorize a different projection identity. */
export function consumeAcceptedWorkflowRunProof(
  proof: AcceptedWorkflowRunProof,
  runId: string,
  workflowName: string,
  workflowSourceHash: string,
  inputHash: string,
): void {
  const head = accepted.get(proof);
  accepted.delete(proof);
  if (
    !head ||
    head.runId !== runId ||
    head.workflowId !== workflowName ||
    head.workflowSourceHash !== workflowSourceHash ||
    head.inputHash !== inputHash
  )
    throw new WorkflowRunReadError([
      { code: 'WORKFLOW_RUN_EVIDENCE_INVALID', scope: 'run', backend: 'go', runId },
    ]);
}
