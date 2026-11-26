import { GitHubEvidenceUnavailableError } from '@openslack/github';
import type { GitHubClientOptions } from '@openslack/github';
import { fetchPRDetails } from './fetch.js';
import { classifyPRReport } from './classify.js';
import { loadPRReviewPolicy } from './policy.js';
import { loadPRCodeownerEvidence } from './codeowners.js';
import { diagnoseLivePR } from './doctor.js';
import { evaluatePRBasePolicy } from './base-policy.js';
import type { PRReviewReport, PRReviewState } from './types.js';

export interface WatchOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
  clientOptions?: GitHubClientOptions;
}

export interface WatchResult {
  finalState: PRReviewState;
  reason: string;
  claimReviewIssue?: PRReviewReport['claimReviewIssue'];
  elapsedMs: number;
  polls: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function watchPR(prNumber: number, options: WatchOptions = {}): Promise<WatchResult> {
  const timeout = (options.timeoutSeconds ?? 60) * 1000;
  const interval = (options.intervalSeconds ?? 10) * 1000;
  const policy = loadPRReviewPolicy();
  const signal = AbortSignal.timeout(Math.max(1, timeout));
  const upstreamSignal = options.clientOptions?.signal;
  const clientOptions = {
    ...options.clientOptions,
    requireLive: true,
    strictEvidence: true,
    signal: upstreamSignal ? AbortSignal.any([signal, upstreamSignal]) : signal,
  };
  const start = Date.now();
  let polls = 0;
  let lastDecision: PRReviewState = 'CHECKS_PENDING';
  let lastReason = 'Waiting for first poll';
  let claimReviewIssue: WatchResult['claimReviewIssue'];

  console.log(
    `Watching PR #${prNumber} (timeout: ${options.timeoutSeconds ?? 60}s, interval: ${options.intervalSeconds ?? 10}s)`,
  );

  while (!clientOptions.signal.aborted && Date.now() - start < timeout) {
    polls++;
    try {
      const classified = classifyPRReport(await fetchPRDetails(prNumber, clientOptions));
      const baseViolation = evaluatePRBasePolicy(classified, policy);
      const codeowners = baseViolation
        ? []
        : (await loadPRCodeownerEvidence(classified, clientOptions)).owners;
      const diagnosed = await diagnoseLivePR(classified, policy, codeowners, clientOptions);
      lastDecision = diagnosed.decision;
      lastReason = diagnosed.reason;
      claimReviewIssue = diagnosed.claimReviewIssue;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !(
          error instanceof GitHubEvidenceUnavailableError ||
          [
            'GITHUB_EVIDENCE_ABORTED',
            'PR_EVIDENCE_SNAPSHOT_UNAVAILABLE',
            'PR_EVIDENCE_SNAPSHOT_CHANGED',
          ].includes(error.message)
        )
      )
        throw error;
      lastDecision = 'EVIDENCE_UNAVAILABLE';
      lastReason = error.message;
      claimReviewIssue = undefined;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[${elapsed}s] ${lastDecision}: ${lastReason}`);

    if (
      lastDecision === 'READY_TO_MERGE' ||
      lastDecision === 'BLOCKED_CLAIM_REVIEW' ||
      lastDecision === 'BLOCKED_BLACK_ZONE' ||
      lastDecision === 'BLOCKED_BASE_BRANCH' ||
      lastDecision === 'BLOCKED_DRAFT' ||
      lastDecision === 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER' ||
      lastDecision === 'BLOCKED_SINGLE_MAINTAINER'
    ) {
      return {
        finalState: lastDecision,
        reason: lastReason,
        ...(claimReviewIssue ? { claimReviewIssue } : {}),
        elapsedMs: Date.now() - start,
        polls,
      };
    }

    if (Date.now() - start + interval >= timeout) {
      break;
    }
    await sleep(interval);
  }

  return {
    finalState: upstreamSignal?.aborted ? 'EVIDENCE_UNAVAILABLE' : lastDecision,
    reason: upstreamSignal?.aborted
      ? 'GITHUB_EVIDENCE_ABORTED'
      : `Watch stopped after ${Math.round((Date.now() - start) / 1000)}s: ${lastReason}`,
    ...(!upstreamSignal?.aborted && claimReviewIssue ? { claimReviewIssue } : {}),
    elapsedMs: Date.now() - start,
    polls,
  };
}
