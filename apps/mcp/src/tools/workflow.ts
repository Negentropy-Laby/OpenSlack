import { createBlockedMcpResult, type OpenSlackMcpResult } from '@openslack/qoder-adapter';
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
  return completedProjection(`Workflow run ${runId} progress is ready.`, data);
}
