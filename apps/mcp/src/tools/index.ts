import type { OpenSlackMcpResult, OpenSlackReadToolName } from '@openslack/qoder-adapter';
import type { OpenSlackMcpContext } from '../context.js';
import { getActivity } from './activity.js';
import { listPendingApprovals } from './approvals.js';
import { getNotificationStatus } from './notifications.js';
import { getBusinessOutcomes } from './outcomes.js';
import { getExecutiveOverview } from './overview.js';
import { getPrReadiness } from './pr.js';
import { getWorkRoom } from './room.js';
import { getWorkflowProgress } from './workflow.js';
import { listWorkItems } from './work.js';

export type OpenSlackReadToolHandler = (
  context: OpenSlackMcpContext,
  input: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<OpenSlackMcpResult>;

export const OPENSLACK_READ_TOOL_HANDLERS: Readonly<
  Record<OpenSlackReadToolName, OpenSlackReadToolHandler>
> = Object.freeze({
  openslack_get_executive_overview: getExecutiveOverview,
  openslack_list_work_items: listWorkItems,
  openslack_get_work_room: getWorkRoom,
  openslack_get_activity: getActivity,
  openslack_get_workflow_progress: getWorkflowProgress,
  openslack_get_pr_readiness: getPrReadiness,
  openslack_list_pending_approvals: listPendingApprovals,
  openslack_get_business_outcomes: getBusinessOutcomes,
  openslack_get_notification_status: getNotificationStatus,
});
