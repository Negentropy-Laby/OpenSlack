import { afterEach, describe, expect, it, vi } from 'vitest';
import { repairExpiredClaims, repairLabels } from '../repair.js';
import { renderClaimComment, type ClaimMetadata } from '../claims.js';

function claimComment(expiresAt = '2026-08-10T00:30:00.000Z') {
  const metadata: ClaimMetadata = {
    schema: 'openslack.claim.v1',
    issue_number: 42,
    agent_id: 'agent-one',
    claim_ref: 'refs/heads/openslack/claims/issue-42',
    claimed_at: '2026-08-10T00:00:00.000Z',
    expires_at: expiresAt,
    principal: { registry_id: 'agent-one', run_id: 'RUN-42', provider: 'cli' },
  };
  return renderClaimComment(metadata, 30);
}

function heartbeatComment() {
  return `<!-- openslack-heartbeat
${JSON.stringify(
  {
    schema: 'openslack.heartbeat.v1',
    issue_number: 42,
    agent_id: 'agent-one',
    heartbeat_at: '2026-08-10T00:20:00.000Z',
    expires_at: '2026-08-10T02:20:00.000Z',
    claim_ref: 'refs/heads/openslack/claims/issue-42',
    ttl_minutes: 120,
    heartbeat_minutes: 15,
    next_heartbeat_at: '2026-08-10T00:35:00.000Z',
  },
  null,
  2,
)}
-->`;
}

function harness(comments: string[]) {
  let refExists = true;
  let labels = ['openslack:task', 'openslack:ready'];
  const octokit = {
    git: {
      listMatchingRefs: vi.fn(async () => ({
        data: [{ ref: 'refs/heads/openslack/claims/issue-42' }],
      })),
      deleteRef: vi.fn(async () => {
        refExists = false;
      }),
      getRef: vi.fn(async () => {
        if (!refExists) throw { status: 404 };
        return { data: { object: { sha: 'a'.repeat(40) } } };
      }),
    },
    issues: {
      listComments: vi.fn(async () => ({
        data: comments.map((body, index) => ({ id: index + 1, body })),
      })),
      removeLabel: vi.fn(async ({ name }: { name: string }) => {
        labels = labels.filter((label) => label !== name);
      }),
      addLabels: vi.fn(async ({ labels: additions }: { labels: string[] }) => {
        labels = [...new Set([...labels, ...additions])];
      }),
      get: vi.fn(async () => ({ data: { labels } })),
    },
  };
  return {
    octokit,
    labels: () => labels,
    refExists: () => refExists,
    factory: async () => ({
      isDryRun: false,
      owner: 'example',
      repo: 'repo',
      octokit,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('repair module', () => {
  it('exports repairLabels function', () => {
    expect(typeof repairLabels).toBe('function');
  });

  it('uses the latest valid heartbeat instead of expiring from the initial lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T01:00:00.000Z'));
    const state = harness([heartbeatComment(), claimComment()]);

    const results = await repairExpiredClaims({}, state.factory as never);

    expect(results).toEqual([
      expect.objectContaining({ action: 'repairClaimProjection', fixed: true, issueNumber: 42 }),
    ]);
    expect(state.octokit.git.deleteRef).not.toHaveBeenCalled();
    expect(state.labels()).toContain('openslack:claimed');
    expect(state.labels()).not.toContain('openslack:ready');
  });

  it('never invents owner evidence for an orphan claim ref', async () => {
    const state = harness([]);

    const results = await repairExpiredClaims({}, state.factory as never);

    expect(results).toEqual([
      expect.objectContaining({ action: 'reconcileClaim', fixed: false, issueNumber: 42 }),
    ]);
    expect(state.octokit.issues.removeLabel).not.toHaveBeenCalled();
    expect(state.octokit.issues.addLabels).not.toHaveBeenCalled();
    expect(state.refExists()).toBe(true);
  });

  it('deletes an expired ref before restoring the ready projection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T03:00:00.000Z'));
    const state = harness([claimComment()]);

    const results = await repairExpiredClaims({}, state.factory as never);

    expect(results).toEqual([
      expect.objectContaining({ action: 'expireClaim', fixed: true, issueNumber: 42 }),
    ]);
    expect(state.refExists()).toBe(false);
    expect(state.labels()).toContain('openslack:ready');
    expect(state.labels()).not.toContain('openslack:claimed');
  });
});
