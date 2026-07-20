import type { Octokit } from '@octokit/rest';
import type { RepoCursor } from './watch-cursor.js';

export interface GitHubApiIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name?: string; id?: number } | string>;
  updated_at: string;
  created_at: string;
  user: { login: string } | null;
}

export interface PollResult {
  repoKey: string;
  issues: GitHubApiIssue[];
  newCursor: RepoCursor;
  dryRun: boolean;
  error?: string;
}

export async function pollRepoIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  since?: string,
  options?: { perPage?: number },
): Promise<PollResult> {
  const repoKey = `${owner}/${repo}`;
  const perPage = options?.perPage ?? 100;

  try {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      since,
      sort: 'updated',
      direction: 'asc',
      per_page: perPage,
      state: 'all',
    });

    // GitHub Issues API returns PR-shaped items too; filter them out
    const issues = (data as unknown as Array<GitHubApiIssue & { pull_request?: unknown }>).filter(
      (item) => !item.pull_request,
    ) as unknown as GitHubApiIssue[];

    let newCursor: RepoCursor;
    if (issues.length > 0) {
      const last = issues[issues.length - 1];
      newCursor = {
        lastSeenAt: last.updated_at,
        lastIssueNumber: last.number,
      };
    } else if (since) {
      newCursor = { lastSeenAt: since, lastIssueNumber: 0 };
    } else {
      newCursor = { lastSeenAt: new Date().toISOString(), lastIssueNumber: 0 };
    }

    return { repoKey, issues, newCursor, dryRun: false };
  } catch (err) {
    return {
      repoKey,
      issues: [],
      newCursor: { lastSeenAt: since ?? new Date().toISOString(), lastIssueNumber: 0 },
      dryRun: false,
      error: `GitHub API error for ${repoKey}: ${(err as Error).message}`,
    };
  }
}
