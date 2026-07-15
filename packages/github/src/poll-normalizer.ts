import type { NormalizedIssueRepositoryEvent } from './issue-normalizer.js';
import type { GitHubApiIssue } from './watch-poller.js';
import { canonicalizeRepositoryName } from './repository-event.js';

export function normalizePollIssue(
  issue: GitHubApiIssue,
  owner: string,
  repo: string,
): NormalizedIssueRepositoryEvent {
  const repository = canonicalizeRepositoryName(owner, repo);
  if (!repository) {
    throw new Error(`Invalid repository name: ${owner}/${repo}`);
  }

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
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository,
    object: {
      kind: 'issue',
      id: `${repository.canonicalFullName}#${issue.number}`,
      number: issue.number,
    },
    source: 'poll',
    observedAt: issue.updated_at,
    metadata: { informational: false, senderLogin: issue.user?.login ?? '' },
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
