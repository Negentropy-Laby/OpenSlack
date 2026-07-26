import type { OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg } from './shared.js';

export async function getExecutiveOverview(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const data = await context.readers.executiveOverview({
    sinceHours: numberArg(input, 'sinceHours', 24),
    limit: numberArg(input, 'limit', 20),
  });
  return completedProjection('OpenSlack executive overview is ready.', data);
}
