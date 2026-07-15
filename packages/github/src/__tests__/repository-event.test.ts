import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GITHUB_WATCH_EVENT_KEYS,
  GITHUB_WEBHOOK_EVENT_NAMES,
  canonicalWatchRouteKey,
  canonicalizeRepositoryName,
  githubWebhookEventKey,
  isGitHubWebhookEventName,
  repositoriesMatch,
  repositoryEventStableKey,
  repositoryIdentityFromPayload,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
  type PullRequestReviewRepositoryEvent,
} from '../repository-event.js';

const watchSchema = JSON.parse(
  readFileSync(new URL('../github-watch.schema.json', import.meta.url), 'utf8'),
) as {
  properties: {
    repositories: {
      items: {
        properties: { events: { items: { enum: string[] } } };
      };
    };
  };
};

describe('repository event registry', () => {
  it('keeps the runtime and JSON schema event allowlists byte-for-byte ordered', () => {
    const schemaEvents = watchSchema.properties.repositories.items.properties.events.items.enum;
    expect(schemaEvents).toEqual(GITHUB_WATCH_EVENT_KEYS);
    expect(GITHUB_WATCH_EVENT_KEYS).toHaveLength(13);
    expect(GITHUB_WATCH_EVENT_KEYS).toContain('push');
  });

  it.each([
    ['issues', 'opened', 'issues.opened'],
    ['issues', 'reopened', 'issues.reopened'],
    ['issues', 'labeled', 'issues.labeled'],
    ['push', undefined, 'push'],
    ['pull_request', 'opened', 'pull_request.opened'],
    ['pull_request', 'synchronize', 'pull_request.synchronize'],
    ['pull_request', 'reopened', 'pull_request.reopened'],
    ['pull_request', 'closed', 'pull_request.closed'],
    ['pull_request', 'ready_for_review', 'pull_request.ready_for_review'],
    ['pull_request_review', 'submitted', 'pull_request_review.submitted'],
    ['pull_request_review', 'dismissed', 'pull_request_review.dismissed'],
    ['check_run', 'completed', 'check_run.completed'],
    ['check_suite', 'completed', 'check_suite.completed'],
  ] as const)('maps %s/%s to %s', (eventName, action, expected) => {
    expect(githubWebhookEventKey(eventName, action)).toBe(expected);
  });

  it('fails closed for unknown event names and actions', () => {
    expect(githubWebhookEventKey('pull_request', 'edited')).toBeNull();
    expect(githubWebhookEventKey('pull_request_review', 'approved')).toBeNull();
    expect(githubWebhookEventKey('check_run', 'created')).toBeNull();
    expect(githubWebhookEventKey('repository', 'created')).toBeNull();
    expect(githubWebhookEventKey('push', 'opened')).toBeNull();
    expect(githubWebhookEventKey('constructor', 'prototype')).toBeNull();
    expect(githubWebhookEventKey('toString', 'call')).toBeNull();
    expect(githubWebhookEventKey('issues', 'constructor')).toBeNull();
  });

  it('exposes the six canonical GitHub webhook header names through one guard', () => {
    expect(GITHUB_WEBHOOK_EVENT_NAMES).toEqual([
      'issues',
      'push',
      'pull_request',
      'pull_request_review',
      'check_run',
      'check_suite',
    ]);
    for (const eventName of GITHUB_WEBHOOK_EVENT_NAMES) {
      expect(isGitHubWebhookEventName(eventName)).toBe(true);
    }
    expect(isGitHubWebhookEventName('repository')).toBe(false);
    expect(isGitHubWebhookEventName(undefined)).toBe(false);
  });
});

describe('repository canonicalization', () => {
  it('preserves display spelling while matching owner/repo case-insensitively', () => {
    expect(canonicalizeRepositoryName(' Negentropy-Laby ', ' OpenSlack ')).toEqual({
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      fullName: 'Negentropy-Laby/OpenSlack',
      canonicalFullName: 'negentropy-laby/openslack',
    });
    expect(
      repositoriesMatch(
        { owner: 'NEGENTROPY-LABY', repo: 'OpenSlack' },
        { owner: 'negentropy-laby', repo: 'openslack' },
      ),
    ).toBe(true);
  });

  it('rejects invalid GitHub owner and repository name segments', () => {
    expect(canonicalizeRepositoryName('', 'repo')).toBeNull();
    expect(canonicalizeRepositoryName('owner/team', 'repo')).toBeNull();
    expect(canonicalizeRepositoryName('owner', 'bad repo')).toBeNull();
    expect(canonicalizeRepositoryName('-owner', 'repo')).toBeNull();
    expect(canonicalizeRepositoryName('owner-', 'repo')).toBeNull();
    expect(canonicalizeRepositoryName('a--b', 'repo')).toBeNull();
    expect(canonicalizeRepositoryName('owner', 'bad|repo')).toBeNull();
    expect(canonicalizeRepositoryName('owner', 'bad\0repo')).toBeNull();
    expect(canonicalizeRepositoryName('owner', '.github')).not.toBeNull();
  });

  it('uses repository.full_name and rejects conflicting repository fields', () => {
    expect(
      repositoryIdentityFromPayload({
        repository: {
          full_name: 'Acme/Project',
          name: 'project',
          owner: { login: 'acme' },
        },
      })?.canonicalFullName,
    ).toBe('acme/project');

    expect(
      repositoryIdentityFromPayload({
        repository: {
          full_name: 'Acme/Project',
          name: 'other',
          owner: { login: 'acme' },
        },
      }),
    ).toBeNull();
  });

  it('builds stable route identities without requiring a new route id', () => {
    const repo = canonicalizeRepositoryName('Acme', 'Project')!;
    const first = canonicalWatchRouteKey(repo, {
      sink: 'Slack',
      name: ' Primary ',
      channel: ' #Release ',
    });
    const second = canonicalWatchRouteKey(
      { owner: 'acme', repo: 'project' },
      { sink: 'slack', name: 'primary', channel: '#release' },
    );
    expect(first).toBe(second);
    expect(first).toBe('acme/project|slack|name=primary|channel=%23release');
  });
});

describe('safe repository event persistence', () => {
  const repository = canonicalizeRepositoryName('Acme', 'Project')!;

  it('builds deterministic stable keys independently of delivery id', () => {
    const event: IssueRepositoryEvent = {
      kind: 'issue',
      eventKey: 'issues.opened',
      action: 'opened',
      repository,
      object: { kind: 'issue', id: 'acme/project#42', number: 42 },
      source: 'webhook',
      deliveryId: 'delivery-one',
      observedAt: '2026-07-15T10:00:00Z',
      metadata: { informational: false, senderLogin: 'octocat' },
      issueNumber: 42,
      title: 'Sensitive title',
      url: 'https://github.com/Acme/Project/issues/42',
      labels: ['bug'],
      body: 'SECRET_ISSUE_BODY',
      senderLogin: 'octocat',
      updatedAt: '2026-07-15T10:00:00Z',
    };
    expect(repositoryEventStableKey(event)).toBe(
      'github:issues.opened:acme/project:issue:42:2026-07-15T10:00:00Z',
    );
    expect(repositoryEventStableKey({ ...event, deliveryId: 'delivery-two' })).toBe(
      repositoryEventStableKey(event),
    );
  });

  it('whitelists persistable fields and drops bodies and arbitrary raw payload data', () => {
    const event = {
      kind: 'issue',
      eventKey: 'issues.opened',
      action: 'opened',
      repository: { ...repository, token: 'SECRET_REPOSITORY_TOKEN' },
      object: {
        kind: 'issue',
        id: 'acme/project#42',
        number: 42,
        body: 'SECRET_NESTED_OBJECT_BODY',
      },
      source: 'webhook',
      deliveryId: 'delivery-one',
      observedAt: '2026-07-15T10:00:00Z',
      metadata: { informational: false, senderLogin: 'octocat' },
      issueNumber: 42,
      title: 'SECRET_TITLE',
      url: 'https://github.com/Acme/Project/issues/42',
      labels: ['private-label'],
      body: 'SECRET_ISSUE_BODY',
      senderLogin: 'octocat',
      updatedAt: '2026-07-15T10:00:00Z',
      rawPayload: { arbitrary: 'SECRET_RAW_FIELD' },
    } as unknown as IssueRepositoryEvent & { rawPayload: unknown };

    const persisted = toPersistableRepositoryEvent(event);
    expect(Object.keys(persisted).sort()).toEqual([
      'action',
      'deliveryId',
      'eventKey',
      'issueNumber',
      'kind',
      'metadata',
      'object',
      'observedAt',
      'repository',
      'schema',
      'source',
      'stableKey',
      'updatedAt',
    ]);
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('SECRET_ISSUE_BODY');
    expect(serialized).not.toContain('SECRET_TITLE');
    expect(serialized).not.toContain('private-label');
    expect(serialized).not.toContain('SECRET_RAW_FIELD');
    expect(serialized).not.toContain('SECRET_REPOSITORY_TOKEN');
    expect(serialized).not.toContain('SECRET_NESTED_OBJECT_BODY');
    expect(serialized).not.toContain('octocat');
  });

  it('keeps review observations informational while omitting review prose and state', () => {
    expectTypeOf<PullRequestReviewRepositoryEvent['source']>().toEqualTypeOf<'webhook'>();
    expectTypeOf<IssueRepositoryEvent['source']>().toEqualTypeOf<'webhook' | 'poll'>();
    const event = {
      kind: 'pull_request_review',
      eventKey: 'pull_request_review.submitted',
      action: 'submitted',
      repository,
      object: { kind: 'pull_request_review', id: 'acme/project#7:review:91', number: 7 },
      source: 'webhook',
      deliveryId: 'review-delivery',
      observedAt: '2026-07-15T11:00:00Z',
      metadata: { informational: true, senderLogin: 'reviewer' },
      pullRequestNumber: 7,
      pullRequestTitle: 'SECRET_PR_TITLE',
      pullRequestUrl: 'https://github.com/Acme/Project/pull/7',
      headSha: 'abc123',
      reviewId: 91,
      reviewState: 'approved',
      reviewUrl: 'https://github.com/Acme/Project/pull/7#pullrequestreview-91',
      reviewerLogin: 'reviewer',
      commitId: 'abc123',
      submittedAt: '2026-07-15T11:00:00Z',
      body: 'SECRET_REVIEW_BODY',
    } as PullRequestReviewRepositoryEvent & { body: string };

    const persisted = toPersistableRepositoryEvent(event);
    expect(persisted.metadata.informational).toBe(true);
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('SECRET_REVIEW_BODY');
    expect(serialized).not.toContain('SECRET_PR_TITLE');
    expect(serialized).not.toContain('approved');
    expect(serialized).not.toContain('reviewer');
  });

  it('forces informational metadata for review DTOs at the runtime boundary', () => {
    const event = {
      kind: 'pull_request_review',
      eventKey: 'pull_request_review.submitted',
      action: 'submitted',
      repository,
      object: { kind: 'pull_request_review', id: 'acme/project#7:review:91', number: 7 },
      source: 'webhook',
      deliveryId: 'review-delivery',
      observedAt: '2026-07-15T11:00:00Z',
      metadata: { informational: false, senderLogin: 'malicious-cast' },
      pullRequestNumber: 7,
      pullRequestTitle: 'PR title',
      pullRequestUrl: 'https://github.com/Acme/Project/pull/7',
      headSha: 'abc123',
      reviewId: 91,
      reviewState: 'approved',
      reviewUrl: 'https://github.com/Acme/Project/pull/7#pullrequestreview-91',
      reviewerLogin: 'reviewer',
      commitId: 'abc123',
      submittedAt: '2026-07-15T11:00:00Z',
    } as unknown as PullRequestReviewRepositoryEvent;

    expect(toPersistableRepositoryEvent(event).metadata.informational).toBe(true);
  });
});
