import type { Intent, RiskLevel } from './types.js';

const HIGH_RISK_INTENTS = new Set([
  'pr_merge',
  'sync_task',
  'issue_done',
]);

const MEDIUM_RISK_INTENTS = new Set([
  'pr_watch',
  'claim_task',
  'checkout_task',
]);

const SIDE_EFFECT_INTENTS = new Set([
  'pr_merge',
  'sync_task',
  'issue_done',
  'create_task',
  'claim_task',
  'checkout_task',
]);

export function assessRisk(intent: Intent): { level: RiskLevel; explanation?: string } {
  if (HIGH_RISK_INTENTS.has(intent.kind)) {
    const prNumber = intent.slots.prNumber as number | undefined;
    const issueNumber = intent.slots.issueNumber as number | undefined;

    if (intent.kind === 'pr_merge' && prNumber) {
      return {
        level: 'high',
        explanation: `This will merge PR #${prNumber} into main. This is irreversible and may affect production code.`,
      };
    }
    if (intent.kind === 'sync_task' && issueNumber) {
      return {
        level: 'high',
        explanation: `This will commit changes for issue #${issueNumber} and create a draft PR. Git history will be modified.`,
      };
    }
    if (intent.kind === 'issue_done' && issueNumber) {
      return {
        level: 'high',
        explanation: `This will mark issue #${issueNumber} as done and clean up its claim ref. The task will be considered complete.`,
      };
    }
    return { level: 'high', explanation: 'This action modifies external state and cannot be undone easily.' };
  }

  if (MEDIUM_RISK_INTENTS.has(intent.kind)) {
    return { level: 'medium', explanation: 'This action creates or modifies workspace state.' };
  }

  if (intent.kind === 'doctor' || intent.kind === 'governance_audit') {
    return { level: 'low' };
  }

  return { level: 'none' };
}

export function hasSideEffects(intent: Intent): boolean {
  return SIDE_EFFECT_INTENTS.has(intent.kind);
}
