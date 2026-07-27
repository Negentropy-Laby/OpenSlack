import type { OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg, stringArg } from './shared.js';

export async function getActivity(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const data = await context.readers.activity({
    sinceHours: numberArg(input, 'sinceHours', 24),
    objectKind: stringArg(input, 'objectKind'),
    objectId: stringArg(input, 'objectId'),
    limit: numberArg(input, 'limit', 50),
  });
  return completedProjection('The bounded OpenSlack activity projection is ready.', data);
}
