import { fetchPRDetails } from './fetch.js';
import { classifyPRReport } from './classify.js';
import { checkMergeReadiness } from './readiness.js';
import { loadPRReviewPolicy } from './policy.js';
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
    const ready = checkMergeReadiness(classified, policy);
    lastDecision = ready.decision;
    lastReason = ready.reason;

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[${elapsed}s] ${ready.decision}: ${ready.reason}`);

    if (ready.decision === 'READY_TO_MERGE') {
      return { finalState: ready.decision, reason: ready.reason, elapsedMs: Date.now() - start, polls };
    }

    if (ready.decision === 'BLOCKED_BLACK_ZONE' || ready.decision === 'BLOCKED_DRAFT') {
      return { finalState: ready.decision, reason: ready.reason, elapsedMs: Date.now() - start, polls };
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
