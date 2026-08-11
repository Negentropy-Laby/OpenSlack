import { describe, expect, it } from 'vitest';
import { createIssueTaskSnapshot, issueTaskSnapshotMatches } from '../issue-task-snapshot.js';

const task = {
  issueNumber: 42,
  issueNodeId: 'I_kwDO42',
  state: 'open' as const,
  labels: ['openslack:task', 'openslack:ready', 'agent-type:codex'],
  body: 'canonical body',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

describe('canonical Issue task snapshots', () => {
  it('is stable across label ordering but binds every claim decision field', () => {
    const snapshot = createIssueTaskSnapshot(task);
    expect(createIssueTaskSnapshot({ ...task, labels: [...task.labels].reverse() }).sha256).toBe(
      snapshot.sha256,
    );

    for (const changed of [
      { ...task, issueNodeId: 'I_kwDO43' },
      { ...task, state: 'closed' as const },
      { ...task, labels: [...task.labels, 'risk:high'] },
      { ...task, body: 'changed body' },
      { ...task, updatedAt: '2026-08-10T00:01:00.000Z' },
    ]) {
      expect(issueTaskSnapshotMatches(snapshot, changed)).toBe(false);
    }
  });

  it('fails closed for missing identity or invalid timestamps', () => {
    expect(() => createIssueTaskSnapshot({ ...task, issueNodeId: '' })).toThrow('node identity');
    expect(() => createIssueTaskSnapshot({ ...task, updatedAt: 'not-a-date' })).toThrow(
      'updatedAt',
    );
  });
});
