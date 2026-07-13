import { listOpenPRs } from '@openslack/github';
import type { PRReviewReport, PRReviewState } from './types.js';
import { filterValidApprovals, isBotUser } from './approvals.js';
import { classifyPRReport } from './classify.js';
import { diagnosePR } from './doctor.js';
import { loadPRReviewPolicy } from './policy.js';
import { fetchPRDetails } from './fetch.js';
import { loadPRCodeownerEvidence } from './codeowners.js';

export type PRBlockerCategory =
  | 'none'
  | 'checks'
  | 'approvals'
  | 'risk_zone'
  | 'codeowners'
  | 'mergeability'
  | 'branch_policy'
  | 'deadlock'
  | 'draft'
  | 'state';

export type PRDecisionOwner = 'human' | 'agent' | 'github_admin' | 'codeowner' | 'none';

export interface PRDecisionSummary {
  prNumber: number;
  title: string;
  decision: PRReviewState;
  canMerge: boolean;
  blockerCategory: PRBlockerCategory;
  owner: PRDecisionOwner;
  nextAction: string;
  evidence: string[];
  rerunCommand: string;
}

export interface PRQueueItem extends PRDecisionSummary {
  riskZone: PRReviewReport['riskZone'];
  author: string;
}

function categoryFor(decision: PRReviewState): PRBlockerCategory {
  switch (decision) {
    case 'READY_TO_MERGE':
      return 'none';
    case 'CHECKS_PENDING':
    case 'CHECKS_FAILED':
      return 'checks';
    case 'NEEDS_HUMAN_APPROVAL':
    case 'BOT_APPROVAL_IGNORED':
    case 'BLOCKED_SELF_REVIEW':
      return 'approvals';
    case 'NEEDS_CODEOWNER_APPROVAL':
      return 'codeowners';
    case 'BLOCKED_BLACK_ZONE':
      return 'risk_zone';
    case 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER':
    case 'BLOCKED_SINGLE_MAINTAINER':
      return 'deadlock';
    case 'BLOCKED_DRAFT':
      return 'draft';
    case 'BLOCKED_POLICY':
      return 'mergeability';
    default:
      return 'state';
  }
}

function ownerFor(category: PRBlockerCategory, decision: PRReviewState): PRDecisionOwner {
  if (decision === 'READY_TO_MERGE') return 'human';
  if (category === 'checks') return 'agent';
  if (category === 'codeowners' || category === 'deadlock') return 'codeowner';
  if (category === 'approvals') return 'human';
  if (category === 'branch_policy') return 'github_admin';
  if (category === 'risk_zone') return 'human';
  return 'agent';
}

function nextActionFor(report: PRReviewReport, owner: PRDecisionOwner): string {
  if (report.decision === 'READY_TO_MERGE') {
    return `Run openslack pr merge ${report.prNumber}; PRMS will re-check gates before merge.`;
  }
  if (report.decision === 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER') {
    return 'Recreate as a bot/agent-authored PR, then request human CODEOWNER approval on GitHub.';
  }
  if (report.decision === 'BOT_APPROVAL_IGNORED') {
    return 'Request an independent human GitHub approval; bot approvals do not satisfy PRMS.';
  }
  if (report.decision === 'NEEDS_HUMAN_APPROVAL') {
    return 'Request an independent human GitHub approval; chat confirmation is not approval.';
  }
  if (report.decision === 'NEEDS_CODEOWNER_APPROVAL') {
    return 'Request CODEOWNER approval on GitHub.';
  }
  if (owner === 'github_admin') {
    return 'A GitHub repository admin must fix the branch policy or ruleset.';
  }
  return report.recommendation;
}

function evidenceFor(report: PRReviewReport, codeowners: string[]): string[] {
  const validApprovers = filterValidApprovals(report.reviews, report.author, report.headSha);
  const botApprovals = report.reviews.filter((r) => r.state === 'APPROVED' && isBotUser(r.user));
  const failedChecks = report.checks.filter((c) => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped');
  const pendingChecks = report.checks.filter((c) => c.status !== 'completed');
  const evidence: string[] = [
    `Risk zone: ${report.riskZone}`,
    `Author: @${report.author}`,
    `Valid human approvals: ${validApprovers.length}`,
  ];
  if (codeowners.length > 0) evidence.push(`CODEOWNERS: ${codeowners.join(', ')}`);
  if (botApprovals.length > 0) evidence.push(`Bot approvals ignored: ${botApprovals.map((r) => `@${r.user}`).join(', ')}`);
  if (pendingChecks.length > 0) evidence.push(`Pending checks: ${pendingChecks.map((c) => c.name).join(', ')}`);
  if (failedChecks.length > 0) evidence.push(`Failing checks: ${failedChecks.map((c) => c.name).join(', ')}`);
  if (report.mergeable === false) evidence.push('GitHub reports merge conflicts.');
  return evidence;
}

export function summarizePRDecision(report: PRReviewReport, codeowners: string[] = []): PRDecisionSummary {
  const blockerCategory = categoryFor(report.decision);
  const owner = ownerFor(blockerCategory, report.decision);
  return {
    prNumber: report.prNumber,
    title: report.title,
    decision: report.decision,
    canMerge: report.decision === 'READY_TO_MERGE',
    blockerCategory,
    owner,
    nextAction: nextActionFor(report, owner),
    evidence: evidenceFor(report, codeowners),
    rerunCommand: `openslack pr doctor ${report.prNumber}`,
  };
}

export function renderPRDecisionSummary(summary: PRDecisionSummary): string {
  const lines: string[] = [];
  lines.push('### Operational Decision');
  lines.push('');
  lines.push(`- Decision: ${summary.decision}`);
  lines.push(`- Blocker: ${summary.blockerCategory}`);
  lines.push(`- Owner: ${summary.owner}`);
  lines.push(`- Next action: ${summary.nextAction}`);
  lines.push(`- Rerun: \`${summary.rerunCommand}\``);
  lines.push('');
  lines.push('Evidence:');
  for (const item of summary.evidence) lines.push(`- ${item}`);
  return lines.join('\n');
}

async function diagnoseForQueue(prNumber: number): Promise<PRQueueItem> {
  const report = await fetchPRDetails(prNumber);
  const classified = classifyPRReport(report);
  const policy = loadPRReviewPolicy();
  const { owners: codeowners } = await loadPRCodeownerEvidence(classified);
  const diagnosed = diagnosePR(classified, policy, codeowners);
  return {
    ...summarizePRDecision(diagnosed, codeowners),
    riskZone: diagnosed.riskZone,
    author: diagnosed.author,
  };
}

function queueRank(item: PRQueueItem): number {
  if (item.canMerge) return 0;
  if (item.owner === 'human' || item.owner === 'codeowner') return 1;
  if (item.owner === 'github_admin') return 2;
  return 3;
}

export async function buildPRQueue(limit = 20): Promise<PRQueueItem[]> {
  const open = await listOpenPRs(limit);
  const items: PRQueueItem[] = [];
  for (const pr of open) {
    items.push(await diagnoseForQueue(pr.number));
  }
  return items.sort((a, b) => queueRank(a) - queueRank(b) || a.prNumber - b.prNumber);
}

export function renderPRQueue(items: PRQueueItem[]): string {
  const lines: string[] = [];
  lines.push('PR Queue');
  lines.push('========');
  if (items.length === 0) {
    lines.push('No open PRs found.');
    return lines.join('\n');
  }
  for (const item of items) {
    lines.push(`#${item.prNumber} ${item.title}`);
    lines.push(`  Decision: ${item.decision}`);
    lines.push(`  Owner: ${item.owner}`);
    lines.push(`  Blocker: ${item.blockerCategory}`);
    lines.push(`  Next: ${item.nextAction}`);
    lines.push(`  Rerun: ${item.rerunCommand}`);
  }
  return lines.join('\n');
}

