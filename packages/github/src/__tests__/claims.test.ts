import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseClaimMetadata, renderClaimComment, resolveClaimOwnerFromComments } from '../claims.js';
import type { ClaimMetadata } from '../claims.js';

let originalAuthMode: string | undefined;

beforeEach(() => {
  originalAuthMode = process.env.OPENSLACK_GITHUB_AUTH_MODE;
  process.env.OPENSLACK_GITHUB_AUTH_MODE = 'dry-run';
});

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.OPENSLACK_GITHUB_AUTH_MODE;
  else process.env.OPENSLACK_GITHUB_AUTH_MODE = originalAuthMode;
});

function makeMetadata(): ClaimMetadata {
  return {
    schema: 'openslack.claim.v1',
    issue_number: 42,
    agent_id: 'test_agent',
    claim_ref: 'refs/heads/openslack/claims/issue-42',
    claimed_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-01T01:00:00.000Z',
    principal: {
      registry_id: 'test_agent',
      run_id: 'RUN-001',
      provider: 'cli',
    },
  };
}

describe('claim metadata', () => {
  it('renders structured openslack-claim JSON marker', () => {
    const body = renderClaimComment(makeMetadata(), 60);

    expect(body).toContain('<!-- openslack-claim');
    expect(body).toContain('"schema": "openslack.claim.v1"');
    expect(body).toContain('"agent_id": "test_agent"');
    expect(body).toContain('"registry_id": "test_agent"');
    expect(body).toContain('**Principal:**');
  });

  it('parses structured claim metadata', () => {
    const body = renderClaimComment(makeMetadata(), 60);
    const parsed = parseClaimMetadata(body);

    expect(parsed).not.toBeNull();
    expect(parsed!.agent_id).toBe('test_agent');
    expect(parsed!.principal.run_id).toBe('RUN-001');
    expect(parsed!.claim_ref).toBe('refs/heads/openslack/claims/issue-42');
  });

  it('resolves owner from structured marker before legacy comments', () => {
    const owner = resolveClaimOwnerFromComments([
      { body: '**Claimed by:** `legacy_agent`' },
      { body: renderClaimComment(makeMetadata(), 60) },
    ]);

    expect(owner).toEqual({ agentId: 'test_agent', structured: true });
  });

  it('falls back to legacy claim owner parsing', () => {
    const owner = resolveClaimOwnerFromComments([
      { body: '**Claimed by:** `legacy_agent`' },
    ]);

    expect(owner).toEqual({ agentId: 'legacy_agent', structured: false });
  });
});

describe('claimIssueTask owner/repo override', () => {
  it('accepts owner/repo params in dry-run mode', async () => {
    const { claimIssueTask } = await import('../claims.js');
    const result = await claimIssueTask({
      issueNumber: 99,
      agentId: 'test',
      owner: 'override-owner',
      repo: 'override-repo',
      principal: { registry_id: 'test', runtime_uid: 'agt_test', run_id: 'R1', provider: 'cli' },
    });
    expect(result.claimStatus).toBe('granted');
    expect(result.issueNumber).toBe(99);
  });

  it('accepts claim without owner/repo in dry-run mode', async () => {
    const { claimIssueTask } = await import('../claims.js');
    const result = await claimIssueTask({
      issueNumber: 100,
      agentId: 'test',
      principal: { registry_id: 'test', runtime_uid: 'agt_test', run_id: 'R1', provider: 'cli' },
    });
    expect(result.claimStatus).toBe('granted');
  });
});
