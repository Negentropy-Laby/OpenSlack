import type { OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg } from './shared.js';

export async function listPendingApprovals(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const data = await context.readers.pendingApprovals({
    limit: numberArg(input, 'limit', 50),
  });
  return completedProjection(
    'Pending OpenSlack confirmations, workflow gates, and GitHub human reviews are separated.',
    data,
  );
}
