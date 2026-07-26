import { createBlockedMcpResult, type OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection, numberArg, stringArg } from './shared.js';

export async function getWorkRoom(
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
): Promise<OpenSlackMcpResult> {
  const roomId = stringArg(input, 'roomId')!;
  const data = await context.readers.workRoom({
    roomId,
    limit: numberArg(input, 'limit', 20),
  });
  if (data === null || data === undefined) {
    return createBlockedMcpResult(
      `No recorded OpenSlack room was found for ${roomId}.`,
      'WORK_ROOM_NOT_FOUND',
    );
  }
  return completedProjection(`OpenSlack room ${roomId} is ready.`, data);
}
