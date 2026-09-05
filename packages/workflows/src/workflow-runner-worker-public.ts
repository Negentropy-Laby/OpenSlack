/**
 * Closed public surface for the sealed Go-authority workflow worker.
 *
 * Qualification helpers, local projection stores, authority adapters, and
 * execution seams remain package-internal so callers cannot compose a second
 * TypeScript workflow writer.
 */
export {
  WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED_ENV,
  WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ENABLED_ENV,
  WorkflowRunnerWorkerConfigError,
  loadWorkflowRunnerV2WorkerConfig,
  runWorkflowRunnerV2Worker,
  type WorkflowRunnerV2WorkerConfig,
} from './workflow-runner-worker.js';
