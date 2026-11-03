import {
  finalizeWorkflowPR,
  previewWorkflowFinalization,
  type FinalizeWorkflowPROpts,
  type FinalizeWorkflowPRResult,
  type GitHubClientOptions,
} from '@openslack/github';
import { loadPRCodeownerEvidence } from './codeowners.js';
import { fetchPRDetails } from './fetch.js';
import { evaluateWorkflowGate, touchesWorkflowFiles } from './workflow-gate.js';
import type { PRReviewReport, WorkflowGateResult } from './types.js';

export interface WorkflowFinalizationInput {
  prNumber: number;
  /** TUI governs bound artifacts; CLI may also name ordinary lifecycle targets. */
  mode: 'governance-only' | 'explicit-targets';
  governanceIssue?: number;
  proposalIssue?: number;
  reviewIssue?: number;
  phaseIssues?: number[];
  hash?: string;
  trust?: string;
}

export type WorkflowFinalizationResult =
  | { status: 'preview'; result: FinalizeWorkflowPRResult }
  | { status: 'not-required' }
  | { status: 'refused'; message: string }
  | { status: 'finalized'; result: FinalizeWorkflowPRResult };

function refuse(message: string): WorkflowFinalizationResult {
  return { status: 'refused', message };
}

function checkedGate(
  input: WorkflowFinalizationInput,
  report: PRReviewReport,
  gate: WorkflowGateResult,
): WorkflowFinalizationResult | undefined {
  if (gate.overall !== 'PASS')
    return refuse(`Cannot finalize Workflow artifact: gate is ${gate.overall}.`);
  if (
    !gate.evidenceHash ||
    !gate.trustDecision ||
    !gate.trustReviewer ||
    gate.trustReviewCommitOid !== report.headSha ||
    (gate.governanceRequired && !gate.verifiedGovernanceIssue)
  )
    return refuse(
      'Cannot finalize Workflow artifact: verified repository governance evidence is incomplete.',
    );
  if (input.hash !== undefined && input.hash !== gate.evidenceHash)
    return refuse('Cannot override the repository-derived workflow evidence hash.');
  if (input.trust !== undefined && input.trust !== gate.trustDecision)
    return refuse('Cannot override the current-head human Workflow-Trust review.');
  if (input.governanceIssue !== undefined && input.governanceIssue !== gate.verifiedGovernanceIssue)
    return refuse('Cannot override the governance issue bound to this workflow artifact change.');
  return undefined;
}

/**
 * Shared read/verify/finalize orchestration. Presentation chooses a policy, not
 * evidence. The publisher still performs its independent live merged/head/base check.
 */
export async function finalizeWorkflowLifecycle(
  input: WorkflowFinalizationInput,
  options?: GitHubClientOptions,
): Promise<WorkflowFinalizationResult> {
  // Own caller-controlled targets before the first credential or network await.
  input = { ...input, phaseIssues: input.phaseIssues ? [...input.phaseIssues] : undefined };
  const liveOptions: GitHubClientOptions = { ...options, requireLive: true, strictEvidence: true };
  if (
    !['governance-only', 'explicit-targets'].includes(input.mode) ||
    [
      input.prNumber,
      input.governanceIssue,
      input.proposalIssue,
      input.reviewIssue,
      ...(input.phaseIssues ?? []),
    ].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
  )
    return refuse('Finalization targets must be positive safe integers with an explicit policy.');
  // Keep this separate: absence of credentials must still permit a zero-query preview.
  const preview = await previewWorkflowFinalization(input.prNumber);
  if (preview) return { status: 'preview', result: preview };
  const report = await fetchPRDetails(input.prNumber, liveOptions);
  if (report.prNumber !== input.prNumber || !report.headSha || !report.baseSha)
    return refuse('Cannot finalize without the reviewed repository head and base for this PR.');
  const targets: FinalizeWorkflowPROpts =
    input.mode === 'explicit-targets'
      ? {
          proposalIssue: input.proposalIssue,
          reviewIssue: input.reviewIssue,
          phaseIssues: input.phaseIssues,
        }
      : {};
  if (!report.workflowEvidence) {
    if (
      input.mode === 'governance-only' ||
      touchesWorkflowFiles(report.changedFiles) ||
      input.governanceIssue !== undefined ||
      input.hash !== undefined ||
      input.trust !== undefined
    )
      return refuse(
        'Repository-derived Workflow artifact evidence is unavailable; evidence claims cannot be published.',
      );
  } else {
    const { owners: codeowners } = await loadPRCodeownerEvidence(report, liveOptions);
    const gate = evaluateWorkflowGate({
      prNumber: input.prNumber,
      changedFiles: report.changedFiles,
      body: report.body ?? '',
      author: report.author,
      baseSha: report.baseSha,
      headSha: report.headSha,
      reviews: report.reviews,
      workflowEvidence: report.workflowEvidence,
      governanceIssue: report.workflowGovernanceIssue,
      codeowners,
    });
    const refused = checkedGate(input, report, gate);
    if (refused) return refused;
    if (input.mode === 'governance-only' && !gate.governanceRequired)
      return { status: 'not-required' };
    Object.assign(targets, {
      governanceIssue: gate.verifiedGovernanceIssue,
      workflowHash: gate.evidenceHash,
      trustDecision: gate.trustDecision,
      trustReviewer: gate.trustReviewer,
      trustReviewCommitOid: gate.trustReviewCommitOid,
    });
  }
  const result = await finalizeWorkflowPR(
    input.prNumber,
    {
      ...targets,
      expectedHeadSha: report.headSha,
      expectedBaseSha: report.baseSha,
    },
    liveOptions,
  );
  return { status: 'finalized', result };
}
