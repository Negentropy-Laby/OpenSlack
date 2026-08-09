import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  claimIssueTask,
  parseClaimMetadata,
  renderClaimComment,
  resolveClaimOwnerFromComments,
} from '../claims.js';
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

const principal = {
  registry_id: 'test_agent',
  runtime_uid: 'agt_test',
  run_id: 'RUN-001',
  provider: 'cli' as const,
};

function liveClient(options: { createError?: unknown; claimRefExists?: boolean } = {}) {
  const getRef = vi.fn(async ({ ref }: { ref: string }) => {
    if (ref === 'heads/main') return { data: { object: { sha: 'a'.repeat(40) } } };
    if (ref === 'heads/openslack/claims/issue-42' && options.claimRefExists) {
      return { data: { object: { sha: 'b'.repeat(40) } } };
    }
    throw { status: 404 };
  });
  const createRef = vi.fn(async () => {
    if (options.createError !== undefined) throw options.createError;
  });
  return {
    getRef,
    createRef,
    factory: async () => ({
      isDryRun: false,
      owner: 'example',
      repo: 'repo',
      octokit: {
        git: { getRef, createRef },
        issues: {
          removeLabel: vi.fn(),
          addLabels: vi.fn(),
          createComment: vi.fn(),
        },
      },
    }),
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
    const owner = resolveClaimOwnerFromComments([{ body: '**Claimed by:** `legacy_agent`' }]);

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
    expect(result.lease?.ttlMinutes).toBe(60);
  });
});

describe('claimIssueTask atomic denial classification', () => {
  it('classifies 422 as already claimed only after reading the exact claim ref', async () => {
    const client = liveClient({ createError: { status: 422 }, claimRefExists: true });
    const result = await claimIssueTask(
      { issueNumber: 42, agentId: 'test_agent', principal },
      client.factory as never,
    );
    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'ALREADY_CLAIMED' });
    expect(client.getRef).toHaveBeenLastCalledWith({
      owner: 'example',
      repo: 'repo',
      ref: 'heads/openslack/claims/issue-42',
    });
  });

  it('keeps a 422 without an observable claim ref as API_ERROR', async () => {
    const client = liveClient({ createError: { status: 422 }, claimRefExists: false });
    const result = await claimIssueTask(
      { issueNumber: 42, agentId: 'test_agent', principal },
      client.factory as never,
    );
    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'API_ERROR' });
  });

  it('keeps ordinary create-ref failures as API_ERROR without a claim-ref read', async () => {
    const client = liveClient({ createError: { status: 500 } });
    const result = await claimIssueTask(
      { issueNumber: 42, agentId: 'test_agent', principal },
      client.factory as never,
    );
    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'API_ERROR' });
    expect(client.getRef).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 481])(
    'rejects invalid explicit TTL %s before client access',
    async (ttl) => {
      const factory = vi.fn();
      await expect(
        claimIssueTask(
          { issueNumber: 42, agentId: 'test_agent', principal, ttlMinutes: ttl },
          factory as never,
        ),
      ).rejects.toThrow('between 1 and 480');
      expect(factory).not.toHaveBeenCalled();
    },
  );
});
