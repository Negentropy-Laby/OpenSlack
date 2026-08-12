import { types as nodeTypes } from 'node:util';
import {
  validateWorkflowCheckpointExecutionBinding,
  workflowCheckpointError,
  type WorkflowCheckpointExecutionBinding,
} from '../workflow-checkpoint-shadow-contract.js';

/** Opaque capability minted by WorkflowRunnerSession only after advancing lease_accept. */
export interface WorkflowCheckpointLeaseAuthority {
  readonly kind: 'accepted_workflow_runner_lease';
}

const AUTHORITIES = new WeakMap<object, WorkflowCheckpointExecutionBinding>();

export function createWorkflowCheckpointLeaseAuthority(
  binding: WorkflowCheckpointExecutionBinding,
): WorkflowCheckpointLeaseAuthority {
  const authority = Object.freeze({ kind: 'accepted_workflow_runner_lease' as const });
  try {
    AUTHORITIES.set(authority, validateWorkflowCheckpointExecutionBinding(binding));
  } catch (error) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_BINDING_INVALID',
      'Workflow checkpoint execution binding is invalid.',
      error,
    );
  }
  return authority;
}

export function workflowCheckpointBindingFromAuthority(
  value: WorkflowCheckpointLeaseAuthority,
): WorkflowCheckpointExecutionBinding {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_BINDING_INVALID',
      'Workflow checkpoint lease authority is invalid.',
    );
  }
  const binding = AUTHORITIES.get(value);
  if (!binding) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_BINDING_INVALID',
      'Workflow checkpoint lease authority is not host-minted.',
    );
  }
  return binding;
}
