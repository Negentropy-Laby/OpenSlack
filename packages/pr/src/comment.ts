import { commentOnPR } from '@openslack/github';
import type { PRReviewReport } from './types.js';
import { generateReviewReport } from './report.js';

export async function postReviewComment(prNumber: number, report: PRReviewReport): Promise<void> {
  const body = generateReviewReport(report);
  await commentOnPR(prNumber, body);
}
