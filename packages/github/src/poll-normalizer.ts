import type { NormalizedIssueEvent } from './issue-normalizer.js';
import type { GitHubApiIssue } from './watch-poller.js';

export function normalizePollIssue(
  issue: GitHubApiIssue,
  owner: string,
  repo: string,
): NormalizedIssueEvent {
  const labels: string[] = [];
  if (Array.isArray(issue.labels)) {
    for (const label of issue.labels) {
      if (typeof label === 'object' && label !== null) {
        const name = (label as Record<string, unknown>).name;
        if (typeof name === 'string') labels.push(name);
      } else if (typeof label === 'string') {
        labels.push(label);
      }
    }
  }

  return {
    action: 'opened',
    owner,
    repo,
    issueNumber: issue.number,
    title: issue.title ?? '',
    url: issue.html_url ?? '',
    labels,
    body: issue.body ?? '',
    senderLogin: issue.user?.login ?? '',
    deliveryId: '',
    updatedAt: issue.updated_at,
  };
}
