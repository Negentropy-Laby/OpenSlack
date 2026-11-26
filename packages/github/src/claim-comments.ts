import type { GitHubClient } from './client.js';

export interface ClaimComment {
  body?: string | null;
  id?: number;
  created_at?: string;
}

export class ClaimEvidenceScanIncompleteError extends Error {
  constructor() {
    super('CLAIM_EVIDENCE_SCAN_INCOMPLETE');
  }
}

/** Keep lifecycle records, but follow the comment ledger past full pages. */
export async function readClaimComments(
  client: GitHubClient,
  issueNumber: number,
  signal?: AbortSignal,
): Promise<{ comments: ClaimComment[]; serverTime?: number }> {
  const deadline = AbortSignal.timeout(60_000);
  const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const comments: ClaimComment[] = [];
  let serverTime: number | undefined;
  let priorPageIds: string | undefined;

  for (let page = 1; ; page++) {
    if (deadline.aborted) throw new ClaimEvidenceScanIncompleteError();
    requestSignal.throwIfAborted();
    try {
      const response = await client.octokit.issues.listComments({
        owner: client.owner,
        repo: client.repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
        request: { signal: requestSignal },
      });
      requestSignal.throwIfAborted();
      const date = Date.parse(response.headers?.date ?? '');
      if (Number.isFinite(date)) serverTime = date;
      comments.push(
        ...response.data.filter((comment) =>
          /<!--\s*openslack-(?:claim|heartbeat)\b/u.test(comment.body ?? ''),
        ),
      );
      if (response.data.length < 100) return { comments, serverTime };
      const ids = response.data.map((comment) => comment.id).join(',');
      if (ids === priorPageIds) throw new ClaimEvidenceScanIncompleteError();
      priorPageIds = ids;
    } catch (error) {
      if (deadline.aborted) throw new ClaimEvidenceScanIncompleteError();
      throw error;
    }
  }
}
