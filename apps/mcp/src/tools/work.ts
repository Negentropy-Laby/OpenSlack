import type { OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg, stringArg } from './shared.js';

export async function listWorkItems(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const data = await context.readers.workItems({
    status: stringArg(input, 'status'),
    sinceHours: numberArg(input, 'sinceHours', 168),
    limit: numberArg(input, 'limit', 50),
  });
  return completedProjection('The bounded OpenSlack work-item projection is ready.', data);
}
