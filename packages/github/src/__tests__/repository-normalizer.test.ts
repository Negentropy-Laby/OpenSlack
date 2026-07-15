import { describe, expect, it } from 'vitest';
import {
  normalizeCheckRunEvent,
  normalizeCheckSuiteEvent,
  normalizePullRequestEvent,
  normalizePullRequestReviewEvent,
  normalizeRepositoryEvent,
} from '../repository-normalizer.js';
import { repositoryEventStableKey } from '../repository-event.js';

const headers = { 'x-github-delivery': 'delivery-123' };
const repository = {
  id: 1,
  name: 'OpenSlack',
  full_name: 'Negentropy-Laby/OpenSlack',
  owner: { login: 'Negentropy-Laby' },
};

function pullRequestPayload(action = 'opened') {
  return {
    action,
    repository,
    sender: { login: 'maintainer' },
    pull_request: {
      number: 42,
      title: 'Add repository event watch',
      html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
      state: action === 'closed' ? 'closed' : 'open',
      draft: action !== 'ready_for_review',
      merged: false,
      updated_at: '2026-07-15T10:00:00Z',
      user: { login: 'contributor' },
      head: { sha: 'head-sha-42' },
      base: { sha: 'base-sha-42' },
    },
  };
}

function reviewPayload(action = 'submitted') {
  return {
    action,
    repository,
    sender: { login: 'reviewer' },
    pull_request: {
      number: 42,
      title: 'Add repository event watch',
      html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
      head: { sha: 'head-sha-42' },
    },
    review: {
      id: 9001,
      state: action === 'dismissed' ? 'dismissed' : 'approved',
      html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42#pullrequestreview-9001',
      user: { login: 'reviewer' },
      commit_id: 'head-sha-42',
      submitted_at: '2026-07-15T10:05:00Z',
      body: 'review prose must not enter the safe DTO',
    },
  };
}

function checkRunPayload() {
  return {
    action: 'completed',
    repository,
    sender: { login: 'github-actions[bot]' },
    check_run: {
      id: 7001,
      name: 'test',
      html_url: 'https://github.com/Negentropy-Laby/OpenSlack/actions/runs/7001',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-sha-42',
      completed_at: '2026-07-15T10:10:00Z',
      pull_requests: [{ number: 42 }, { number: 42 }, { number: 7 }],
      output: { text: 'raw check output must not be normalized' },
    },
  };
}

function checkSuitePayload() {
  return {
    action: 'completed',
    repository,
    sender: { login: 'github-actions[bot]' },
    check_suite: {
      id: 8001,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-sha-42',
      head_branch: 'feature/repository-events',
      updated_at: '2026-07-15T10:11:00Z',
      pull_requests: [{ number: 42 }],
    },
  };
}

describe('pull request webhook normalization', () => {
  it.each(['opened', 'synchronize', 'reopened', 'closed', 'ready_for_review'] as const)(
    'normalizes pull_request.%s with live-refresh identifiers',
    (action) => {
      const event = normalizePullRequestEvent(pullRequestPayload(action), headers);
      expect(event).not.toBeNull();
      expect(event).toMatchObject({
        kind: 'pull_request',
        eventKey: `pull_request.${action}`,
        action,
        pullRequestNumber: 42,
        headSha: 'head-sha-42',
        baseSha: 'base-sha-42',
        deliveryId: 'delivery-123',
        metadata: { informational: true, senderLogin: 'maintainer' },
      });
      expect(event?.repository.canonicalFullName).toBe('negentropy-laby/openslack');
      expect(event?.object).toEqual({
        kind: 'pull_request',
        id: 'negentropy-laby/openslack#42',
        number: 42,
      });
    },
  );

  it('rejects unknown actions and structurally incomplete PR payloads', () => {
    expect(normalizePullRequestEvent(pullRequestPayload('edited'), headers)).toBeNull();
    const missingHead = pullRequestPayload();
    delete (missingHead.pull_request as Partial<typeof missingHead.pull_request>).head;
    expect(normalizePullRequestEvent(missingHead, headers)).toBeNull();
  });
});

describe('pull request review webhook normalization', () => {
  it.each(['submitted', 'dismissed'] as const)(
    'normalizes pull_request_review.%s as informational',
    (action) => {
      const event = normalizePullRequestReviewEvent(reviewPayload(action), headers);
      expect(event).not.toBeNull();
      expect(event).toMatchObject({
        kind: 'pull_request_review',
        eventKey: `pull_request_review.${action}`,
        action,
        pullRequestNumber: 42,
        reviewId: 9001,
        headSha: 'head-sha-42',
        commitId: 'head-sha-42',
        metadata: { informational: true, senderLogin: 'reviewer' },
      });
      expect(repositoryEventStableKey(event!)).toBe(
        `github:pull_request_review.${action}:negentropy-laby/openslack:pr:42:review:9001:head-sha-42`,
      );
    },
  );

  it('does not infer an approval action from review.state', () => {
    const payload = reviewPayload('submitted');
    payload.review.state = 'approved';
    const event = normalizePullRequestReviewEvent(payload, headers);
    expect(event?.action).toBe('submitted');
    expect(event?.eventKey).toBe('pull_request_review.submitted');
    expect(event?.metadata.informational).toBe(true);
  });

  it('rejects an unknown review action or missing commit identity', () => {
    expect(normalizePullRequestReviewEvent(reviewPayload('edited'), headers)).toBeNull();
    const missingCommit = reviewPayload();
    delete (missingCommit.review as Partial<typeof missingCommit.review>).commit_id;
    expect(normalizePullRequestReviewEvent(missingCommit, headers)).toBeNull();
  });
});

describe('check webhook normalization', () => {
  it('normalizes a completed check run and canonicalizes associated PR numbers', () => {
    const event = normalizeCheckRunEvent(checkRunPayload(), headers);
    expect(event).toMatchObject({
      kind: 'check_run',
      eventKey: 'check_run.completed',
      checkRunId: 7001,
      headSha: 'head-sha-42',
      pullRequestNumbers: [7, 42],
      metadata: { informational: true },
    });
    expect(repositoryEventStableKey(event!)).toBe(
      'github:check_run.completed:negentropy-laby/openslack:check-run:7001:head-sha-42:2026-07-15T10:10:00Z',
    );
  });

  it('normalizes a completed check suite', () => {
    const event = normalizeCheckSuiteEvent(checkSuitePayload(), headers);
    expect(event).toMatchObject({
      kind: 'check_suite',
      eventKey: 'check_suite.completed',
      checkSuiteId: 8001,
      headSha: 'head-sha-42',
      headBranch: 'feature/repository-events',
      pullRequestNumbers: [42],
      metadata: { informational: true },
    });
  });

  it('rejects non-completed actions, mismatched status, and missing check IDs', () => {
    expect(normalizeCheckRunEvent({ ...checkRunPayload(), action: 'created' }, headers)).toBeNull();
    const queued = checkSuitePayload();
    queued.check_suite.status = 'queued';
    expect(normalizeCheckSuiteEvent(queued, headers)).toBeNull();
    const missingId = checkRunPayload();
    delete (missingId.check_run as Partial<typeof missingId.check_run>).id;
    expect(normalizeCheckRunEvent(missingId, headers)).toBeNull();
  });
});

describe('repository event dispatcher', () => {
  it.each([
    ['pull_request', pullRequestPayload(), 'pull_request'],
    ['pull_request_review', reviewPayload(), 'pull_request_review'],
    ['check_run', checkRunPayload(), 'check_run'],
    ['check_suite', checkSuitePayload(), 'check_suite'],
  ] as const)('dispatches %s to its strict normalizer', (eventName, payload, kind) => {
    expect(normalizeRepositoryEvent(eventName, payload, headers)?.kind).toBe(kind);
  });

  it('normalizes existing issue and push events into the shared contract', () => {
    const issue = normalizeRepositoryEvent(
      'issues',
      {
        action: 'opened',
        repository,
        sender: { login: 'reporter' },
        issue: {
          number: 10,
          title: 'Issue title',
          html_url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/10',
          body: 'Issue body',
          updated_at: '2026-07-15T09:00:00Z',
          labels: [{ name: 'bug' }],
        },
      },
      headers,
    );
    expect(issue).toMatchObject({
      kind: 'issue',
      eventKey: 'issues.opened',
      source: 'webhook',
      issueNumber: 10,
    });

    const push = normalizeRepositoryEvent(
      'push',
      {
        repository,
        ref: 'refs/heads/main',
        before: 'before-sha',
        after: 'after-sha',
        pusher: { name: 'writer' },
        commits: [
          {
            id: 'commit-1',
            message: 'Add post',
            added: ['posts/new.md'],
            modified: [],
            removed: [],
            timestamp: '2026-07-15T09:05:00Z',
          },
        ],
      },
      headers,
    );
    expect(push).toMatchObject({ kind: 'push', eventKey: 'push', after: 'after-sha' });
  });

  it('returns null for unknown event/action combinations and inconsistent repository identity', () => {
    expect(
      normalizeRepositoryEvent('pull_request', pullRequestPayload('edited'), headers),
    ).toBeNull();
    expect(normalizeRepositoryEvent('repository', { action: 'created' }, headers)).toBeNull();
    const conflicting = pullRequestPayload();
    conflicting.repository = {
      ...repository,
      full_name: 'Other/Repository',
    };
    expect(normalizeRepositoryEvent('pull_request', conflicting, headers)).toBeNull();
  });
});
