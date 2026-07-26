import type { OpenSlackMcpResult } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { completedProjection } from './shared.js';

export async function getNotificationStatus(
  context: OpenSlackMcpContext,
): Promise<OpenSlackMcpResult> {
  const data = await context.readers.notificationStatus();
  return completedProjection(
    'Notification route and payload-blind lifecycle status is ready.',
    data,
  );
}
