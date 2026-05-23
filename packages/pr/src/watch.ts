import { getCODEOWNERS } from '@openslack/github';
import { fetchPRDetails } from './fetch.js';
import { classifyPRReport } from './classify.js';
import { loadPRReviewPolicy } from './policy.js';
import { parseCODEOWNERS, resolveCodeowners } from './codeowners.js';
import { diagnosePR } from './doctor.js';
import type { PRReviewState } from './types.js';

export interface WatchOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
}

export interface WatchResult {
  finalState: PRReviewState;
  reason: string;
  elapsedMs: number;
  polls: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function watchPR(
  prNumber: number,
  options: WatchOptions = {},
): Promise<WatchResult> {
  const timeout = (options.timeoutSeconds ?? 60) * 1000;
  const interval = (options.intervalSeconds ?? 10) * 1000;
  const policy = loadPRReviewPolicy();
  const start = Date.now();
  let polls = 0;
  let lastDecision: PRReviewState = 'CHECKS_PENDING';
  let lastReason = 'Waiting for first poll';

  console.log(`Watching PR #${prNumber} (timeout: ${options.timeoutSeconds ?? 60}s, interval: ${options.intervalSeconds ?? 10}s)`);

  while (Date.now() - start < timeout) {
    polls++;
    const report = await fetchPRDetails(prNumber);
    const classified = classifyPRReport(report);

    const codeownersContent = await getCODEOWNERS(classified.baseRef);
    const codeownersEntries = codeownersContent ? parseCODEOWNERS(codeownersContent) : [];
    const codeowners = resolveCodeowners(classified.changedFiles, codeownersEntries);

    const diagnosed = diagnosePR(classified, policy, codeowners);
    lastDecision = diagnosed.decision;
    lastReason = diagnosed.reason;

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[${elapsed}s] ${diagnosed.decision}: ${diagnosed.reason}`);

    if (diagnosed.decision === 'READY_TO_MERGE') {
      return { finalState: diagnosed.decision, reason: diagnosed.reason, elapsedMs: Date.now() - start, polls };
    }

    if (
      diagnosed.decision === 'BLOCKED_BLACK_ZONE' ||
      diagnosed.decision === 'BLOCKED_DRAFT' ||
      diagnosed.decision === 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER' ||
      diagnosed.decision === 'BLOCKED_SINGLE_MAINTAINER'
    ) {
      return { finalState: diagnosed.decision, reason: diagnosed.reason, elapsedMs: Date.now() - start, polls };
    }

    if (Date.now() - start + interval >= timeout) {
      break;
    }
    await sleep(interval);
  }

  return {
    finalState: lastDecision,
    reason: `Timed out after ${Math.round((Date.now() - start) / 1000)}s: ${lastReason}`,
    elapsedMs: Date.now() - start,
    polls,
  };
}
