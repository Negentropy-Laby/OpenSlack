import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '../client.js';
import {
  fetchRepositoryEventLiveState,
  RepositoryLiveStateError,
} from '../repository-live-state.js';
import {
  canonicalizeRepositoryName,
  toPersistableRepositoryEvent,
  type CheckRunRepositoryEvent,
  type PullRequestReviewRepositoryEvent,
} from '../repository-event.js';

function repository() {
  const value = canonicalizeRepositoryName('Acme', 'Project');
  if (!value) throw new Error('Expected repository');
  return value;
}

function reviewEvent(): PullRequestReviewRepositoryEvent {
  return {
    kind: 'pull_request_review',
    eventKey: 'pull_request_review.submitted',
    action: 'submitted',
    repository: repository(),
    object: {
      kind: 'pull_request_review',
      id: 'acme/project#42:review:9001',
      number: 42,
    },
    source: 'webhook',
    deliveryId: 'review-delivery',
    observedAt: '2026-07-17T00:00:00.000Z',
    metadata: { informational: true, senderLogin: 'untrusted-reviewer' },
    pullRequestNumber: 42,
    pullRequestTitle: 'Webhook title is stale',
    pullRequestUrl: 'https://github.com/Acme/Project/pull/42',
    headSha: 'stale-webhook-head',
    reviewId: 9001,
    reviewState: 'approved',
    reviewUrl: 'https://github.com/Acme/Project/pull/42#pullrequestreview-9001',
    reviewerLogin: 'untrusted-reviewer',
    commitId: 'stale-webhook-head',
    submittedAt: '2026-07-17T00:00:00.000Z',
  };
}

function checkEvent(pullRequestNumbers: number[] = []): CheckRunRepositoryEvent {
  return {
    kind: 'check_run',
    eventKey: 'check_run.completed',
    action: 'completed',
    repository: repository(),
    object: { kind: 'check_run', id: 'acme/project:check-run:7001' },
    source: 'webhook',
    deliveryId: 'check-delivery',
    observedAt: '2026-07-17T00:00:00.000Z',
    metadata: { informational: true, senderLogin: 'github-actions' },
    checkRunId: 7001,
    name: 'test',
    url: 'https://github.com/Acme/Project/actions/runs/7001',
    status: 'completed',
    conclusion: 'success',
    headSha: 'check-head',
    completedAt: '2026-07-17T00:00:00.000Z',
    pullRequestNumbers,
  };
}

function mockClient(
  overrides: {
    owner?: string;
    repo?: string;
    pullsGet?: ReturnType<typeof vi.fn>;
    listReviews?: ReturnType<typeof vi.fn>;
    listForRef?: ReturnType<typeof vi.fn>;
  } = {},
): GitHubClient {
  return {
    owner: overrides.owner ?? 'Acme',
    repo: overrides.repo ?? 'Project',
    authMode: 'github_app_installation',
    isDryRun: false,
    octokit: {
      pulls: {
        get:
          overrides.pullsGet ??
          vi.fn().mockResolvedValue({
            data: {
              number: 42,
              title: 'Current live title',
              html_url: 'https://github.com/Acme/Project/pull/42',
              state: 'open',
              draft: false,
              merged: false,
              head: { sha: 'current-live-head' },
              base: { sha: 'current-base' },
              updated_at: '2026-07-17T00:05:00.000Z',
            },
          }),
        listReviews:
          overrides.listReviews ??
          vi.fn().mockResolvedValue({
            data: [
              {
                state: 'APPROVED',
                body: 'review prose must not enter the snapshot',
                user: { login: 'reviewer-handle' },
              },
              { state: 'CHANGES_REQUESTED' },
            ],
          }),
      },
      checks: {
        listForRef:
          overrides.listForRef ??
          vi.fn().mockResolvedValue({
            data: {
              check_runs: [
                {
                  id: 7001,
                  name: 'test',
                  status: 'completed',
                  conclusion: 'success',
                  html_url: 'https://github.com/Acme/Project/actions/runs/7001',
                },
                {
                  id: 7002,
                  name: 'lint',
                  status: 'in_progress',
                  conclusion: null,
                  html_url: 'https://github.com/Acme/Project/actions/runs/7002',
                },
              ],
            },
          }),
      },
    } as unknown as GitHubClient['octokit'],
  };
}

describe('fetchRepositoryEventLiveState', () => {
  it('refreshes PR, review, and check state through one explicitly bound client', async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        title: 'Current live title',
        html_url: 'https://github.com/Acme/Project/pull/42',
        state: 'open',
        draft: false,
        merged: false,
        head: { sha: 'current-live-head' },
        base: { sha: 'current-base' },
        updated_at: '2026-07-17T00:05:00.000Z',
      },
    });
    const listReviews = vi.fn().mockResolvedValue({ data: [{ state: 'APPROVED' }] });
    const listForRef = vi.fn().mockResolvedValue({
      data: { check_runs: [] },
    });
    const live = await fetchRepositoryEventLiveState(
      mockClient({ pullsGet, listReviews, listForRef }),
      toPersistableRepositoryEvent(reviewEvent()),
      { now: () => new Date('2026-07-17T00:06:00.000Z') },
    );

    expect(pullsGet).toHaveBeenCalledWith({
      owner: 'Acme',
      repo: 'Project',
      pull_number: 42,
    });
    expect(listReviews).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'Acme', repo: 'Project', pull_number: 42 }),
    );
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Acme',
        repo: 'Project',
        ref: 'current-live-head',
      }),
    );
    expect(live).toMatchObject({
      fetchedAt: '2026-07-17T00:06:00.000Z',
      triggerHeadSha: 'stale-webhook-head',
      authority: {
        humanApproval: 'not_evaluated',
        mergeReadiness: 'not_evaluated',
      },
      informational: true,
      pullRequests: [
        {
          headSha: 'current-live-head',
          reviews: {
            approvedObserved: 1,
            informational: true,
            authoritativeApproval: false,
          },
        },
      ],
    });
  });

  it('omits review prose and reviewer identities from the live projection', async () => {
    const live = await fetchRepositoryEventLiveState(
      mockClient(),
      toPersistableRepositoryEvent(reviewEvent()),
    );
    const serialized = JSON.stringify(live);

    expect(serialized).not.toContain('review prose');
    expect(serialized).not.toContain('reviewer-handle');
    expect(serialized).not.toContain('"approved":true');
    expect(live.pullRequests[0]?.reviews).toMatchObject({
      total: 2,
      approvedObserved: 1,
      changesRequestedObserved: 1,
      authoritativeApproval: false,
    });
  });

  it('fetches check state for the event head without guessing a pull request', async () => {
    const pullsGet = vi.fn();
    const listForRef = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 7001,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            html_url: '',
          },
        ],
      },
    });
    const live = await fetchRepositoryEventLiveState(
      mockClient({ pullsGet, listForRef }),
      toPersistableRepositoryEvent(checkEvent()),
    );

    expect(pullsGet).not.toHaveBeenCalled();
    expect(listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'check-head' }));
    expect(live.pullRequests).toEqual([]);
    expect(live.headChecks).toMatchObject({
      total: 1,
      successful: 1,
    });
  });

  it('paginates reviews and checks without silently truncating evidence', async () => {
    const firstReviews = Array.from({ length: 100 }, () => ({ state: 'COMMENTED' }));
    const listReviews = vi
      .fn()
      .mockResolvedValueOnce({ data: firstReviews })
      .mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });
    const firstChecks = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `check-${index}`,
      status: 'completed',
      conclusion: 'success',
      html_url: '',
    }));
    const listForRef = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: firstChecks } })
      .mockResolvedValueOnce({ data: { check_runs: [] } });

    const live = await fetchRepositoryEventLiveState(
      mockClient({ listReviews, listForRef }),
      toPersistableRepositoryEvent(reviewEvent()),
    );

    expect(live.pullRequests[0]?.reviews.total).toBe(101);
    expect(live.pullRequests[0]?.checks.total).toBe(100);
    expect(listReviews).toHaveBeenCalledTimes(2);
    expect(listForRef).toHaveBeenCalledTimes(2);
  });

  it('fails before querying when the client belongs to another repository', async () => {
    const pullsGet = vi.fn();
    await expect(
      fetchRepositoryEventLiveState(
        mockClient({ owner: 'WorkspaceOrg', repo: 'WorkspaceRepo', pullsGet }),
        toPersistableRepositoryEvent(reviewEvent()),
      ),
    ).rejects.toMatchObject({
      code: 'LIVE_STATE_INVALID',
      retryable: false,
    });
    expect(pullsGet).not.toHaveBeenCalled();
  });

  it('fails closed instead of converting missing PR evidence to an empty snapshot', async () => {
    const pullsGet = vi.fn().mockRejectedValue({ status: 404 });
    await expect(
      fetchRepositoryEventLiveState(
        mockClient({ pullsGet }),
        toPersistableRepositoryEvent(reviewEvent()),
      ),
    ).rejects.toMatchObject({
      code: 'LIVE_STATE_NOT_FOUND',
      retryable: false,
    });
  });

  it('rejects an unbounded check-to-PR fanout', async () => {
    await expect(
      fetchRepositoryEventLiveState(
        mockClient(),
        toPersistableRepositoryEvent(
          checkEvent(Array.from({ length: 21 }, (_, index) => index + 1)),
        ),
        { maxPullRequests: 20 },
      ),
    ).rejects.toBeInstanceOf(RepositoryLiveStateError);
  });
});
