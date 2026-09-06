import {
  createBlockedMcpResult,
  createOpenSlackMcpResult,
  type OpenSlackMcpResult,
} from '@openslack/qoder-adapter';
import { WorkflowRunReadError } from '@openslack/workflows';
import { workflowReadMetadata } from '../workflow-read-metadata.js';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, stringArg } from './shared.js';

export async function getWorkflowProgress(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const runId = stringArg(input, 'runId')!;
  const data = await context.readers.workflowProgress({ runId });
  if (data === null || data === undefined) {
    return createBlockedMcpResult(`Workflow run ${runId} was not found.`, 'WORKFLOW_RUN_NOT_FOUND');
  }
  const metadata = workflowReadMetadata(data);
  if (metadata.provenance?.selection === 'comparison') {
    const diagnostics = metadata.readDiagnostics;
    const error = new WorkflowRunReadError(
      diagnostics.length
        ? diagnostics
        : [{ scope: 'run', runId, code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED' }],
    );
    return createOpenSlackMcpResult({
      status: 'blocked',
      summary: error.message,
      error: { code: error.code, message: error.message },
      governance: { blocker: error.code },
      data,
    });
  }
  return completedProjection(`Workflow run ${runId} progress is ready.`, data);
}
