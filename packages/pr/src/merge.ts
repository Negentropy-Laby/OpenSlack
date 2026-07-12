import { mergePR } from '@openslack/github';
import type { PRReviewReport, PRReviewPolicy, PRReviewState } from './types.js';
import type { AgentPrincipal, AgentPermissionSnapshot } from '@openslack/kernel';
import { authorizeAgentAction } from '@openslack/kernel';
import { diagnosePR } from './doctor.js';
import { parseCODEOWNERS, resolveCodeowners } from './codeowners.js';
import { getCODEOWNERS } from '@openslack/github';

export interface MergeStewardResult {
  merged: boolean;
  decision: PRReviewState;
  reason: string;
  sha?: string;
  message: string;
}

export async function mergeIfReady(
  prNumber: number,
  policy: PRReviewPolicy,
  options: {
    method?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
    commitMessage?: string;
    skipConfirm?: boolean;
    principal?: AgentPrincipal;
    snapshot?: AgentPermissionSnapshot;
  } = {},
): Promise<MergeStewardResult> {
  // Reuse Phase 1.14A diagnostic pipeline
  const { fetchPRDetails } = await import('./fetch.js');
  const { classifyPRReport } = await import('./classify.js');
  const report = await fetchPRDetails(prNumber, { requireLive: true, strictEvidence: true });
  const classified = classifyPRReport(report);

  const codeownersContent = await getCODEOWNERS(classified.baseRef);
  const codeownersEntries = codeownersContent ? parseCODEOWNERS(codeownersContent) : [];
  const codeowners = resolveCodeowners(classified.changedFiles, codeownersEntries);

  const diagnosed = diagnosePR(classified, policy, codeowners);

  if (diagnosed.decision !== 'READY_TO_MERGE') {
    return {
      merged: false,
      decision: diagnosed.decision,
      reason: diagnosed.reason,
      message: `Merge blocked: ${diagnosed.decision}\n${diagnosed.reason}\nRecommendation: ${diagnosed.recommendation}`,
    };
  }

  // Authorization gate — if snapshot provided, enforce
  if (options.snapshot) {
    const auth = authorizeAgentAction({ snapshot: options.snapshot, action: 'github.merge' });
    if (auth.decision !== 'allow') {
      return {
        merged: false,
        decision: 'BLOCKED_AUTHORIZATION',
        reason: auth.evidence.reason,
        message: auth.decision === 'ask'
          ? `Merge requires authorization confirmation: ${auth.evidence.reason}`
          : `Merge denied: ${auth.evidence.reason}`,
      };
    }
  }

  // All gates passed — execute merge
  const mergeResult = await mergePR(prNumber, {
    method: options.method,
    commitTitle: options.commitTitle,
    commitMessage: options.commitMessage,
  });

  return {
    merged: mergeResult.merged,
    decision: diagnosed.decision,
    reason: diagnosed.reason,
    sha: mergeResult.sha,
    message: mergeResult.message,
  };
}
