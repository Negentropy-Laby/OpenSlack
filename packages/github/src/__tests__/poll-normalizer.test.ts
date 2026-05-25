import { describe, it, expect } from 'vitest';
import { normalizePollIssue } from '../poll-normalizer.js';
import type { GitHubApiIssue } from '../watch-poller.js';

const baseIssue: GitHubApiIssue = {
  number: 42,
  title: 'Fix failing setup',
  html_url: 'https://github.com/owner/repo/issues/42',
  body: 'Test body',
  state: 'open',
  labels: [{ name: 'openslack:task' }, { name: 'bug' }],
  updated_at: '2026-05-25T10:00:00Z',
  created_at: '2026-05-25T09:59:00Z',
  user: { login: 'contributor' },
};

describe('normalizePollIssue', () => {
  it('normalizes a fresh issue with action opened', () => {
    const result = normalizePollIssue(baseIssue, 'owner', 'repo');
    expect(result.action).toBe('opened');
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.issueNumber).toBe(42);
    expect(result.title).toBe('Fix failing setup');
    expect(result.url).toBe('https://github.com/owner/repo/issues/42');
    expect(result.labels).toEqual(['openslack:task', 'bug']);
    expect(result.senderLogin).toBe('contributor');
    expect(result.deliveryId).toBe('');
    expect(result.updatedAt).toBe('2026-05-25T10:00:00Z');
  });

  it('extracts labels from string labels', () => {
    const issue: GitHubApiIssue = { ...baseIssue, labels: ['label-a', 'label-b'] };
    const result = normalizePollIssue(issue, 'owner', 'repo');
    expect(result.labels).toEqual(['label-a', 'label-b']);
  });

  it('handles mixed object and string labels', () => {
    const issue: GitHubApiIssue = { ...baseIssue, labels: [{ name: 'obj-label' }, 'str-label'] };
    const result = normalizePollIssue(issue, 'owner', 'repo');
    expect(result.labels).toEqual(['obj-label', 'str-label']);
  });

  it('handles null body', () => {
    const issue: GitHubApiIssue = { ...baseIssue, body: null };
    const result = normalizePollIssue(issue, 'owner', 'repo');
    expect(result.body).toBe('');
  });

  it('handles null user', () => {
    const issue: GitHubApiIssue = { ...baseIssue, user: null };
    const result = normalizePollIssue(issue, 'owner', 'repo');
    expect(result.senderLogin).toBe('');
  });

  it('handles empty labels array', () => {
    const issue: GitHubApiIssue = { ...baseIssue, labels: [] };
    const result = normalizePollIssue(issue, 'owner', 'repo');
    expect(result.labels).toEqual([]);
  });

  it('skips labels without a name property', () => {
    const issue: GitHubApiIssue = { ...baseIssue, labels: [{ id: 123 } as unknown as { name?: string }] };
    const result = normalizePollIssue(issue, 'owner', 'repo');
    expect(result.labels).toEqual([]);
  });
});
