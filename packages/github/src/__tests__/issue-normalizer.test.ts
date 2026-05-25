import { describe, it, expect } from 'vitest';
import { normalizeIssueEvent, matchesRepoConfig } from '../issue-normalizer.js';
import type { NormalizedIssueEvent } from '../issue-normalizer.js';
import type { GitHubWatchRepo } from '../watch-config.js';

const basePayload = {
  action: 'opened',
  issue: {
    number: 42,
    title: 'Fix failing setup',
    html_url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
    body: 'The setup command fails on Windows.',
    updated_at: '2026-05-25T10:00:00Z',
    labels: [
      { name: 'openslack:task', id: 1 },
      { name: 'openslack:ready', id: 2 },
    ],
  },
  repository: {
    name: 'OpenSlack',
    owner: { login: 'Negentropy-Laby' },
  },
  sender: { login: 'contributor' },
};

const baseHeaders = {
  'x-github-delivery': 'abc-123-def',
  'x-github-event': 'issues',
};

describe('normalizeIssueEvent', () => {
  it('normalizes an issues.opened payload', () => {
    const result = normalizeIssueEvent(basePayload, baseHeaders);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('opened');
    expect(result!.owner).toBe('Negentropy-Laby');
    expect(result!.repo).toBe('OpenSlack');
    expect(result!.issueNumber).toBe(42);
    expect(result!.title).toBe('Fix failing setup');
    expect(result!.labels).toEqual(['openslack:task', 'openslack:ready']);
    expect(result!.deliveryId).toBe('abc-123-def');
  });

  it('normalizes an issues.reopened payload', () => {
    const result = normalizeIssueEvent({ ...basePayload, action: 'reopened' }, baseHeaders);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('reopened');
  });

  it('normalizes an issues.labeled payload with all current labels', () => {
    const payload = {
      ...basePayload,
      action: 'labeled',
      label: { name: 'openslack:ready' },
    };
    const result = normalizeIssueEvent(payload, baseHeaders);
    expect(result).not.toBeNull();
    expect(result!.labels).toEqual(['openslack:task', 'openslack:ready']);
  });

  it('returns null for non-object payload', () => {
    expect(normalizeIssueEvent('not an object', baseHeaders)).toBeNull();
    expect(normalizeIssueEvent(null, baseHeaders)).toBeNull();
  });

  it('returns null for missing issue', () => {
    expect(normalizeIssueEvent({ action: 'opened', repository: basePayload.repository }, baseHeaders)).toBeNull();
  });

  it('returns null for missing repository', () => {
    expect(normalizeIssueEvent({ action: 'opened', issue: basePayload.issue }, baseHeaders)).toBeNull();
  });
});

describe('matchesRepoConfig', () => {
  const repoConfig: GitHubWatchRepo = {
    owner: 'Negentropy-Laby',
    repo: 'OpenSlack',
    events: ['issues.opened', 'issues.reopened', 'issues.labeled'],
    labels: { include: ['openslack:task'], exclude: ['blocked'] },
  };

  const baseEvent: NormalizedIssueEvent = {
    action: 'opened',
    owner: 'Negentropy-Laby',
    repo: 'OpenSlack',
    issueNumber: 42,
    title: 'Test',
    url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
    labels: ['openslack:task', 'openslack:ready'],
    body: '',
    senderLogin: 'bot',
    deliveryId: 'abc',
    updatedAt: '2026-05-25T10:00:00Z',
  };

  it('matches when owner, repo, event, and labels match', () => {
    expect(matchesRepoConfig(baseEvent, repoConfig)).toBe(true);
  });

  it('rejects wrong owner', () => {
    expect(matchesRepoConfig({ ...baseEvent, owner: 'other' }, repoConfig)).toBe(false);
  });

  it('rejects wrong repo', () => {
    expect(matchesRepoConfig({ ...baseEvent, repo: 'other' }, repoConfig)).toBe(false);
  });

  it('rejects unconfigured event action', () => {
    expect(matchesRepoConfig({ ...baseEvent, action: 'closed' }, repoConfig)).toBe(false);
  });

  it('rejects when no include label is present', () => {
    expect(matchesRepoConfig({ ...baseEvent, labels: ['bug'] }, repoConfig)).toBe(false);
  });

  it('rejects when exclude label is present', () => {
    expect(matchesRepoConfig({ ...baseEvent, labels: ['openslack:task', 'blocked'] }, repoConfig)).toBe(false);
  });

  it('matches when no label filters configured', () => {
    const noFilters: GitHubWatchRepo = { ...repoConfig, labels: undefined };
    expect(matchesRepoConfig(baseEvent, noFilters)).toBe(true);
  });
});
