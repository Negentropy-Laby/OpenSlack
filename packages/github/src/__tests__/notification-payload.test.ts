import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createNotificationPayload,
  formatNotification,
  normalizeIssueEvent,
  type CheckRunRepositoryEvent,
  type IssueNotificationPayload,
  type IssueRepositoryEvent,
  type NotificationPayload,
  type PullRequestRepositoryEvent,
  type PullRequestReviewRepositoryEvent,
  type PushRepositoryEvent,
  type RepositoryIdentity,
} from '../index.js';

const repository: RepositoryIdentity = {
  owner: 'Negentropy-Laby',
  repo: 'OpenSlack',
  fullName: 'Negentropy-Laby/OpenSlack',
  canonicalFullName: 'negentropy-laby/openslack',
};

const common = {
  repository,
  source: 'webhook' as const,
  deliveryId: 'delivery-1',
  metadata: { informational: true as const, senderLogin: 'observer' },
};

describe('notification projections', () => {
  it('projects issue fields only into the issue variant', () => {
    const event: IssueRepositoryEvent = {
      ...common,
      kind: 'issue',
      eventKey: 'issues.opened',
      action: 'opened',
      object: { kind: 'issue', id: 'negentropy-laby/openslack#7', number: 7 },
      observedAt: '2026-07-15T10:00:00Z',
      metadata: { informational: false, senderLogin: 'reporter' },
      issueNumber: 7,
      title: 'Issue title',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/7',
      labels: ['bug'],
      body: 'untrusted issue body',
      senderLogin: 'reporter',
      updatedAt: '2026-07-15T10:00:00Z',
    };
    const payload = createNotificationPayload(event);
    expect(payload).toMatchObject({
      objectKind: 'issue',
      issueNumber: 7,
      labels: ['bug'],
      informational: false,
    });
    expect(payload).not.toHaveProperty('pullRequestNumber');
    expect(payload).not.toHaveProperty('body');

    const normalized = normalizeIssueEvent(
      {
        action: 'opened',
        issue: {
          number: 7,
          title: 'Issue title',
          html_url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/7',
          updated_at: '2026-07-15T10:00:00Z',
          labels: [{ name: 'bug' }],
        },
        repository: {
          full_name: 'Negentropy-Laby/OpenSlack',
          name: 'OpenSlack',
          owner: { login: 'Negentropy-Laby' },
        },
        sender: { login: 'reporter' },
      },
      {},
    )!;
    expectTypeOf(createNotificationPayload(normalized)).toEqualTypeOf<IssueNotificationPayload>();
  });

  it('projects PR observations without issue-only optional fields', () => {
    const event: PullRequestRepositoryEvent = {
      ...common,
      kind: 'pull_request',
      eventKey: 'pull_request.synchronize',
      action: 'synchronize',
      object: { kind: 'pull_request', id: 'negentropy-laby/openslack#42', number: 42 },
      observedAt: '2026-07-15T10:01:00Z',
      pullRequestNumber: 42,
      title: 'PR title',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
      state: 'open',
      draft: false,
      merged: false,
      headSha: 'head-42',
      baseSha: 'base-42',
      authorLogin: 'author',
      updatedAt: '2026-07-15T10:01:00Z',
    };
    const payload = createNotificationPayload(event);
    expect(payload).toMatchObject({
      objectKind: 'pull_request',
      pullRequestNumber: 42,
      action: 'synchronize',
      headSha: 'head-42',
    });
    expect(payload).not.toHaveProperty('issueNumber');
    expect(payload).not.toHaveProperty('labels');
  });

  it('makes review state explicitly informational rather than approval evidence', () => {
    const event: PullRequestReviewRepositoryEvent = {
      ...common,
      kind: 'pull_request_review',
      eventKey: 'pull_request_review.submitted',
      action: 'submitted',
      object: {
        kind: 'pull_request_review',
        id: 'negentropy-laby/openslack#42:review:9001',
        number: 42,
      },
      observedAt: '2026-07-15T10:02:00Z',
      pullRequestNumber: 42,
      pullRequestTitle: 'PR title',
      pullRequestUrl: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
      headSha: 'head-42',
      reviewId: 9001,
      reviewState: 'approved',
      reviewUrl: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42#pullrequestreview-9001',
      reviewerLogin: 'reviewer',
      commitId: 'head-42',
      submittedAt: '2026-07-15T10:02:00Z',
    };
    const payload = createNotificationPayload(event);
    expect(payload).toMatchObject({
      objectKind: 'review',
      reviewState: 'approved',
      informational: true,
    });
    expect(formatNotification(payload)).toContain('informational only');
  });

  it('projects check and push variants with their own required fields', () => {
    const check: CheckRunRepositoryEvent = {
      ...common,
      kind: 'check_run',
      eventKey: 'check_run.completed',
      action: 'completed',
      object: { kind: 'check_run', id: 'negentropy-laby/openslack:check-run:70' },
      observedAt: '2026-07-15T10:03:00Z',
      checkRunId: 70,
      name: 'test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/actions/runs/70',
      status: 'completed',
      conclusion: 'success',
      headSha: 'head-42',
      completedAt: '2026-07-15T10:03:00Z',
      pullRequestNumbers: [42],
    };
    const push: PushRepositoryEvent = {
      ...common,
      kind: 'push',
      eventKey: 'push',
      action: 'push',
      object: { kind: 'push', id: 'negentropy-laby/openslack@after' },
      observedAt: '2026-07-15T10:04:00Z',
      metadata: { informational: false, senderLogin: 'pusher' },
      ref: 'refs/heads/main',
      before: 'before',
      after: 'after',
      pusher: 'pusher',
      commits: [
        {
          id: 'after',
          message: 'Update',
          added: [],
          modified: ['posts/a.md'],
          removed: [],
          timestamp: '2026-07-15T10:04:00Z',
        },
      ],
    };

    expect(createNotificationPayload(check)).toMatchObject({
      objectKind: 'check',
      checkKind: 'run',
      checkId: 70,
      pullRequestNumbers: [42],
    });
    expect(createNotificationPayload(push)).toMatchObject({
      objectKind: 'push',
      commitCount: 1,
      after: 'after',
    });
  });

  it('exports a closed discriminated union', () => {
    expectTypeOf<NotificationPayload['objectKind']>().toEqualTypeOf<
      'issue' | 'push' | 'pull_request' | 'review' | 'check'
    >();
  });
});
