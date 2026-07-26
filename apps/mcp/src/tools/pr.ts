import type { OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg, stringArg } from './shared.js';

export async function getPrReadiness(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<OpenSlackMcpResult> {
  const prNumber = numberArg(input, 'prNumber', 0);
  const data = await context.readers.prReadiness({
    prNumber,
    repo: stringArg(input, 'repo'),
    signal,
  });
  return completedProjection(`Current-head PRMS readiness for PR #${prNumber} is ready.`, data);
}
