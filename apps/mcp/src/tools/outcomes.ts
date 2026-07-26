import { createBlockedMcpResult, type OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, stringArg } from './shared.js';

export async function getBusinessOutcomes(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  if (!context.readers.businessOutcomes) {
    return createBlockedMcpResult(
      'Business outcomes are unavailable because the QW1 projection reader is not bound.',
      'OUTCOMES_READER_NOT_BOUND',
    );
  }
  const data = await context.readers.businessOutcomes({
    rootDir: context.workspaceRoot,
    from: stringArg(input, 'from'),
    to: stringArg(input, 'to'),
    scenarioId: stringArg(input, 'scenarioId'),
  });
  return completedProjection('Evidence-labelled business outcomes are ready.', data);
}
