import type { IntentKind } from './types.js';

/**
 * Single source of truth for every valid IntentKind value.
 * If a value exists in the IntentKind union but is missing from this array,
 * TypeScript will report a type error here — preventing drift.
 */
export const KNOWN_INTENTS = [
  'status',
  'doctor',
  'create_task',
  'claim_task',
  'checkout_task',
  'sync_task',
  'issue_done',
  'pr_status',
  'pr_doctor',
  'pr_review',
  'pr_queue',
  'pr_watch',
  'pr_merge',
  'github_repair_labels',
  'github_repair_claims',
  'task_repair_worktrees',
  'governance_audit',
  'workflow_recommended',
  'workflow_not_needed',
  'workflow_draft_required',
  'profile_sync',
  'unknown',
] as const satisfies readonly IntentKind[];
