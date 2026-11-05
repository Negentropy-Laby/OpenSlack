import { join } from 'node:path';

/** Layout only: no filesystem access or approval/decision authority. */
export function resolveWorkflowEffectApprovalRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals');
}
