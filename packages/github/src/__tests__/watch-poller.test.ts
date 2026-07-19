import { describe, it, expect, vi } from 'vitest';
import { pollRepoIssues } from '../watch-poller.js';

function mockOctokit(issues: unknown[] = []) {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: issues }),
    },
  } as unknown as Parameters<typeof pollRepoIssues>[0];
}

describe('pollRepoIssues', () => {
  it('returns issues from the API', async () => {
    const issues = [
      {
        number: 1,
        title: 'First',
        html_url: 'https://github.com/o/r/issues/1',
        body: '',
        state: 'open',
        labels: [],
        updated_at: '2026-05-25T10:00:00Z',
        created_at: '2026-05-25T10:00:00Z',
        user: { login: 'dev' },
      },
      {
        number: 2,
        title: 'Second',
        html_url: 'https://github.com/o/r/issues/2',
        body: '',
        state: 'open',
        labels: [],
        updated_at: '2026-05-25T11:00:00Z',
        created_at: '2026-05-25T11:00:00Z',
        user: { login: 'dev' },
      },
    ];
    const octokit = mockOctokit(issues);
    const result = await pollRepoIssues(octokit, 'owner', 'repo', '2026-05-25T09:00:00Z');
    expect(result.repoKey).toBe('owner/repo');
    expect(result.issues).toHaveLength(2);
    expect(result.dryRun).toBe(false);
    expect(result.newCursor.lastSeenAt).toBe('2026-05-25T11:00:00Z');
    expect(result.newCursor.lastIssueNumber).toBe(2);
  });

  it('returns empty issues when none found', async () => {
    const octokit = mockOctokit([]);
    const result = await pollRepoIssues(octokit, 'owner', 'repo', '2026-05-25T09:00:00Z');
    expect(result.issues).toHaveLength(0);
    expect(result.newCursor.lastSeenAt).toBe('2026-05-25T09:00:00Z');
  });

  it('passes since parameter to the API call', async () => {
    const octokit = mockOctokit([]);
    await pollRepoIssues(octokit, 'owner', 'repo', '2026-05-25T09:00:00Z');
    expect(octokit.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ since: '2026-05-25T09:00:00Z' }),
    );
  });

  it('returns error on API failure', async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockRejectedValue(new Error('rate limited')),
      },
    } as unknown as Parameters<typeof pollRepoIssues>[0];
    const result = await pollRepoIssues(octokit, 'owner', 'repo');
    expect(result.issues).toHaveLength(0);
    expect(result.error).toContain('rate limited');
  });

  it('uses default cursor when no since provided and no issues', async () => {
    const octokit = mockOctokit([]);
    const result = await pollRepoIssues(octokit, 'owner', 'repo');
    expect(result.newCursor.lastIssueNumber).toBe(0);
    expect(new Date(result.newCursor.lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('filters out PR-shaped items with pull_request field', async () => {
    const items = [
      {
        number: 1,
        title: 'Real Issue',
        html_url: 'https://github.com/o/r/issues/1',
        body: '',
        state: 'open',
        labels: [],
        updated_at: '2026-05-25T10:00:00Z',
        created_at: '2026-05-25T10:00:00Z',
        user: { login: 'dev' },
      },
      {
        number: 2,
        title: 'A Pull Request',
        html_url: 'https://github.com/o/r/pull/2',
        body: '',
        state: 'open',
        labels: [],
        updated_at: '2026-05-25T11:00:00Z',
        created_at: '2026-05-25T11:00:00Z',
        user: { login: 'dev' },
        pull_request: { url: 'https://api.github.com/repos/o/r/pulls/2' },
      },
    ];
    const octokit = mockOctokit(items);
    const result = await pollRepoIssues(octokit, 'owner', 'repo', '2026-05-25T09:00:00Z');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].number).toBe(1);
    expect(result.issues[0].title).toBe('Real Issue');
  });
});
