import type { PRReviewReport, PRReviewState } from './types.js';
import {
  summarizePRDecision,
  type PRBlockerCategory,
  type PRDecisionOwner,
} from './decision-summary.js';

export interface PRChatSummary {
  prNumber: number;
  title: string;
  decision: PRReviewState;
  canMerge: boolean;
  blocker?: string;
  blockerCategory?: PRBlockerCategory;
  owner?: PRDecisionOwner;
  why: string;
  next: string;
  zone: string;
}

const BLOCKED_DECISIONS: PRReviewState[] = [
  'BLOCKED_DRAFT',
  'BLOCKED_POLICY',
  'BLOCKED_BLACK_ZONE',
  'BLOCKED_SELF_REVIEW',
  'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER',
  'BLOCKED_SINGLE_MAINTAINER',
  'CHECKS_PENDING',
  'CHECKS_FAILED',
  'NEEDS_HUMAN_APPROVAL',
  'NEEDS_CODEOWNER_APPROVAL',
  'NEEDS_CHANGES',
  'BOT_APPROVAL_IGNORED',
];

function isBlocked(decision: PRReviewState): boolean {
  return BLOCKED_DECISIONS.includes(decision);
}

function getBlockerLabel(decision: PRReviewState): string {
  switch (decision) {
    case 'BLOCKED_DRAFT':
      return 'PR is in draft state';
    case 'BLOCKED_POLICY':
      return 'Policy violation';
    case 'BLOCKED_BLACK_ZONE':
      return 'Black Zone — never mergeable';
    case 'BLOCKED_SELF_REVIEW':
      return 'Self-review detected';
    case 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER':
      return 'Author is sole CODEOWNER';
    case 'BLOCKED_SINGLE_MAINTAINER':
      return 'Single maintainer deadlock';
    case 'CHECKS_PENDING':
      return 'Checks still running';
    case 'CHECKS_FAILED':
      return 'Checks failed';
    case 'NEEDS_HUMAN_APPROVAL':
      return 'Missing valid human approval';
    case 'NEEDS_CODEOWNER_APPROVAL':
      return 'Missing CODEOWNER approval';
    case 'NEEDS_CHANGES':
      return 'Changes requested';
    case 'BOT_APPROVAL_IGNORED':
      return 'Bot approval ignored';
    default:
      return 'Cannot merge';
  }
}

function getNextAction(decision: PRReviewState): string {
  switch (decision) {
    case 'BLOCKED_DRAFT':
      return 'Mark the PR as ready for review.';
    case 'BLOCKED_POLICY':
      return 'Resolve the policy issue (state, conflicts).';
    case 'BLOCKED_BLACK_ZONE':
      return 'Close the PR. Black Zone changes are prohibited.';
    case 'BLOCKED_SELF_REVIEW':
      return 'Remove self-approval. Another reviewer must approve.';
    case 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER':
      return 'Recreate this as a bot/agent-authored PR, then request human CODEOWNER approval on GitHub.';
    case 'BLOCKED_SINGLE_MAINTAINER':
      return 'Use a bot/agent-authored Red Zone PR with human CODEOWNER approval, or add a second human CODEOWNER.';
    case 'CHECKS_PENDING':
      return 'Wait for all checks to complete.';
    case 'CHECKS_FAILED':
      return 'Fix failing checks before merge.';
    case 'NEEDS_HUMAN_APPROVAL':
    case 'BOT_APPROVAL_IGNORED':
      return 'Request review from an independent human reviewer on GitHub.';
    case 'NEEDS_CODEOWNER_APPROVAL':
      return 'Request review from CODEOWNERS on GitHub.';
    case 'NEEDS_CHANGES':
      return 'Address the requested changes.';
    default:
      return 'Review the PR on GitHub, then ask OpenSlack to merge.';
  }
}

export function summarizePRForChat(report: PRReviewReport): PRChatSummary {
  const blocked = isBlocked(report.decision);
  const decision = summarizePRDecision(report);

  return {
    prNumber: report.prNumber,
    title: report.title,
    decision: report.decision,
    canMerge: report.decision === 'READY_TO_MERGE',
    blocker: blocked ? getBlockerLabel(report.decision) : undefined,
    blockerCategory: decision.blockerCategory,
    owner: decision.owner,
    why: report.reason,
    next: blocked ? decision.nextAction || getNextAction(report.decision) : decision.nextAction,
    zone: report.riskZone,
  };
}

export function formatPRChatSummary(summary: PRChatSummary): string {
  const lines: string[] = [];

  lines.push(`*PR #${summary.prNumber} — ${summary.title}*`);

  if (summary.canMerge) {
    lines.push(`✅ *Ready to merge* (${summary.zone} zone)`);
  } else {
    lines.push(`🚫 *Cannot merge*`);
    if (summary.blocker) {
      lines.push(`Blocker: ${summary.blocker}`);
    }
    if (summary.owner) {
      lines.push(`Owner: ${summary.owner}`);
    }
  }

  lines.push('');
  lines.push(`Why: ${summary.why}`);
  lines.push('');
  lines.push(`Next: ${summary.next}`);

  if (
    !summary.canMerge &&
    (summary.decision === 'NEEDS_HUMAN_APPROVAL' ||
      summary.decision === 'BOT_APPROVAL_IGNORED' ||
      summary.decision === 'NEEDS_CODEOWNER_APPROVAL')
  ) {
    lines.push('');
    lines.push(
      '_Slack confirmation is not a GitHub approval. GitHub CODEOWNER review remains the only valid approval source._',
    );
  }

  return lines.join('\n');
}
