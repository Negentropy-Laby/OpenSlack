import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  claimIssueTask,
  createIssueTaskSnapshot,
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

function snapshot(issueNumber: number) {
  return createIssueTaskSnapshot({
    issueNumber,
    issueNodeId: `NODE_${issueNumber}`,
    state: 'open',
    labels: ['openslack:task', 'openslack:ready', 'agent-type:codex'],
    body: 'task body',
    updatedAt: '2026-08-09T00:00:00.000Z',
  });
}

function claimInput(issueNumber = 42) {
  return {
    issueNumber,
    agentId: 'test_agent',
    taskId: `TASK-2026-${String(issueNumber).padStart(6, '0')}`,
    taskSnapshot: snapshot(issueNumber),
    riskZone: 'green' as const,
    principal,
  };
}

function liveClient(
  options: {
    createError?: unknown;
    claimRefExists?: boolean;
    existingClaimBody?: string;
  } = {},
) {
  let labels = ['openslack:task', 'openslack:ready', 'agent-type:codex'];
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
  const removeLabel = vi.fn(async ({ name }: { name: string }) => {
    labels = labels.filter((label) => label !== name);
  });
  const addLabels = vi.fn(async ({ labels: additions }: { labels: string[] }) => {
    labels = [...new Set([...labels, ...additions])];
  });
  const listComments = vi.fn(async () => ({
    data: options.existingClaimBody ? [{ body: options.existingClaimBody }] : [],
  }));
  const getIssue = vi.fn(async () => ({ data: { labels } }));
  return {
    getRef,
    createRef,
    removeLabel,
    addLabels,
    listComments,
    labels: () => labels,
    factory: async () => ({
      isDryRun: false,
      owner: 'example',
      repo: 'repo',
      octokit: {
        git: { getRef, createRef },
        issues: {
          get: getIssue,
          listComments,
          removeLabel,
          addLabels,
          createComment: vi.fn(),
        },
      },
    }),
  };
}

function claimHarness(
  options: {
    currentBody?: string;
    currentLabels?: string[];
    currentState?: 'open' | 'closed';
    currentNodeId?: string;
    currentUpdatedAt?: string;
    deleteUncertain?: boolean;
    commentResponseLoss?: boolean;
    commentWriteFailure?: boolean;
    labelFailure?: boolean;
    mainRefFailure?: boolean;
  } = {},
) {
  let refPresent = false;
  let labels = ['openslack:task', 'openslack:ready', 'agent-type:codex'];
  const comments: Array<{ id: number; body: string }> = [];
  const getRef = vi.fn(async ({ ref }: { ref: string }) => {
    if (ref === 'heads/main') {
      if (options.mainRefFailure) throw { status: 500 };
      return { data: { object: { sha: 'a'.repeat(40) } } };
    }
    if (ref === 'heads/openslack/claims/issue-42' && refPresent) {
      return { data: { object: { sha: 'a'.repeat(40) } } };
    }
    throw { status: 404 };
  });
  const createRef = vi.fn(async () => {
    refPresent = true;
  });
  const deleteRef = vi.fn(async () => {
    if (!options.deleteUncertain) refPresent = false;
    else throw { status: 500 };
  });
  const issue = () => ({
    number: 42,
    node_id: options.currentNodeId ?? 'NODE_42',
    title: 'Task 42',
    html_url: 'https://github.com/example/repo/issues/42',
    labels: options.currentLabels ?? labels,
    body: options.currentBody ?? 'task body',
    state: options.currentState ?? 'open',
    updated_at: options.currentUpdatedAt ?? '2026-08-09T00:00:00.000Z',
  });
  const getIssue = vi.fn(async () => ({ data: issue() }));
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    if (!options.commentWriteFailure) comments.unshift({ id: 101, body });
    if (options.commentResponseLoss || options.commentWriteFailure) throw { status: 500 };
    return { data: { id: 101 } };
  });
  const getComment = vi.fn(async () => ({ data: comments[0] }));
  const listComments = vi.fn(async () => ({ data: comments }));
  const removeLabel = vi.fn(async ({ name }: { name: string }) => {
    if (options.labelFailure) throw { status: 500 };
    labels = labels.filter((label) => label !== name);
  });
  const addLabels = vi.fn(async ({ labels: additions }: { labels: string[] }) => {
    if (options.labelFailure) throw { status: 500 };
    labels = [...new Set([...labels, ...additions])];
  });
  return {
    getRef,
    createRef,
    deleteRef,
    getIssue,
    createComment,
    getComment,
    listComments,
    removeLabel,
    addLabels,
    refPresent: () => refPresent,
    labels: () => labels,
    comments,
    factory: async () => ({
      isDryRun: false,
      owner: 'example',
      repo: 'repo',
      octokit: {
        git: { getRef, createRef, deleteRef },
        issues: {
          get: getIssue,
          createComment,
          getComment,
          listComments,
          removeLabel,
          addLabels,
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
      ...claimInput(99),
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
      ...claimInput(100),
      agentId: 'test',
      principal: { registry_id: 'test', runtime_uid: 'agt_test', run_id: 'R1', provider: 'cli' },
    });
    expect(result.claimStatus).toBe('granted');
    expect(result.claimStatus).toBe('granted');
    if (result.claimStatus === 'granted') {
      expect(result.lease.ttlMinutes).toBe(60);
      expect(result.lease.heartbeatMinutes).toBe(15);
    }
  });
});

describe('claimIssueTask atomic denial classification', () => {
  it('classifies 422 as already claimed only after reading the exact claim ref', async () => {
    const client = liveClient({ createError: { status: 422 }, claimRefExists: true });
    const result = await claimIssueTask(claimInput(), client.factory as never);
    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'ALREADY_CLAIMED' });
    expect(client.getRef).toHaveBeenLastCalledWith({
      owner: 'example',
      repo: 'repo',
      ref: 'heads/openslack/claims/issue-42',
    });
  });

  it('repairs the label projection after an already-claimed race with owner evidence', async () => {
    const client = liveClient({
      createError: { status: 422 },
      claimRefExists: true,
      existingClaimBody: renderClaimComment(makeMetadata(), 60),
    });
    const result = await claimIssueTask(claimInput(), client.factory as never);

    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'ALREADY_CLAIMED' });
    expect(client.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'openslack:ready' }),
    );
    expect(client.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['openslack:claimed'] }),
    );
    expect(client.labels()).toContain('openslack:claimed');
    expect(client.labels()).not.toContain('openslack:ready');
  });

  it('does not repair an already-claimed projection from unrelated owner evidence', async () => {
    const unrelated = { ...makeMetadata(), issue_number: 41 };
    const client = liveClient({
      createError: { status: 422 },
      claimRefExists: true,
      existingClaimBody: renderClaimComment(unrelated, 60),
    });
    const result = await claimIssueTask(claimInput(), client.factory as never);

    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'ALREADY_CLAIMED' });
    expect(client.removeLabel).not.toHaveBeenCalled();
    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it('keeps a 422 without an observable claim ref as API_ERROR', async () => {
    const client = liveClient({ createError: { status: 422 }, claimRefExists: false });
    const result = await claimIssueTask(claimInput(), client.factory as never);
    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'API_ERROR' });
  });

  it('keeps ordinary create-ref failures as API_ERROR without a claim-ref read', async () => {
    const client = liveClient({ createError: { status: 500 } });
    const result = await claimIssueTask(claimInput(), client.factory as never);
    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'API_ERROR' });
    expect(client.getRef).toHaveBeenCalledTimes(1);
  });

  it('returns API_ERROR when the main ref cannot be read', async () => {
    const harness = claimHarness({ mainRefFailure: true });
    const result = await claimIssueTask(claimInput(), harness.factory as never);

    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'API_ERROR' });
    expect(harness.createRef).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 481])(
    'rejects invalid explicit TTL %s before client access',
    async (ttl) => {
      const factory = vi.fn();
      await expect(
        claimIssueTask({ ...claimInput(), ttlMinutes: ttl }, factory as never),
      ).rejects.toThrow('between 1 and 480');
      expect(factory).not.toHaveBeenCalled();
    },
  );
});

describe('claimIssueTask current-snapshot authority', () => {
  it('writes and reads back structured snapshot and heartbeat evidence before granting', async () => {
    const harness = claimHarness();
    const result = await claimIssueTask(
      { ...claimInput(), ttlMinutes: 120, heartbeatMinutes: 15 },
      harness.factory as never,
    );

    expect(result.claimStatus).toBe('granted');
    if (result.claimStatus !== 'granted') return;
    expect(result.taskSnapshotSha256).toBe(snapshot(42).sha256);
    expect(result.lease).toMatchObject({ ttlMinutes: 120, heartbeatMinutes: 15 });
    expect(Date.parse(result.lease.nextHeartbeatAt)).toBeLessThanOrEqual(
      Date.parse(result.lease.expiresAt),
    );
    expect(result.projection).toEqual({ status: 'synchronized' });
    const metadata = parseClaimMetadata(harness.comments[0].body);
    expect(metadata).toMatchObject({
      task_id: 'TASK-2026-000042',
      task_snapshot_sha256: snapshot(42).sha256,
      task_updated_at: '2026-08-09T00:00:00.000Z',
      risk_zone: 'green',
      ttl_minutes: 120,
      heartbeat_minutes: 15,
    });
    expect(metadata?.claim_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it.each([
    ['body', { currentBody: 'changed task body' }],
    ['labels', { currentLabels: ['openslack:task', 'agent-type:codex'] }],
    ['state', { currentState: 'closed' as const }],
    ['node identity', { currentNodeId: 'NODE_REPLACED' }],
    ['updated timestamp', { currentUpdatedAt: '2026-08-09T00:01:00.000Z' }],
  ])(
    'rolls back a tentative ref when the exact Issue %s changed after selection',
    async (_field, change) => {
      const harness = claimHarness(change);
      const result = await claimIssueTask(claimInput(), harness.factory as never);

      expect(result).toMatchObject({ claimStatus: 'denied', reason: 'STALE_CANDIDATE' });
      expect(harness.deleteRef).toHaveBeenCalledOnce();
      expect(harness.refPresent()).toBe(false);
      expect(harness.createComment).not.toHaveBeenCalled();
    },
  );

  it('rolls back when the exact Issue readback cannot form a canonical snapshot', async () => {
    const harness = claimHarness({ currentUpdatedAt: 'not-a-timestamp' });
    const result = await claimIssueTask(claimInput(), harness.factory as never);

    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'STALE_CANDIDATE' });
    expect(harness.deleteRef).toHaveBeenCalledOnce();
    expect(harness.refPresent()).toBe(false);
    expect(harness.createComment).not.toHaveBeenCalled();
  });

  it('requires reconciliation when stale-ref cleanup cannot be proven', async () => {
    const harness = claimHarness({ currentBody: 'changed task body', deleteUncertain: true });
    const result = await claimIssueTask(claimInput(), harness.factory as never);

    expect(result).toMatchObject({
      claimStatus: 'denied',
      reason: 'RECONCILIATION_REQUIRED',
    });
    expect(harness.refPresent()).toBe(true);
  });

  it('resolves a claim-comment response loss by reading back the unique claim ID', async () => {
    const harness = claimHarness({ commentResponseLoss: true });
    const result = await claimIssueTask(claimInput(), harness.factory as never);

    expect(result.claimStatus).toBe('granted');
    expect(harness.listComments).toHaveBeenCalled();
    expect(harness.refPresent()).toBe(true);
  });

  it('rolls back when owner evidence cannot be confirmed', async () => {
    const harness = claimHarness({ commentWriteFailure: true });
    const result = await claimIssueTask(claimInput(), harness.factory as never);

    expect(result).toMatchObject({ claimStatus: 'denied', reason: 'API_ERROR' });
    expect(harness.refPresent()).toBe(false);
  });

  it('keeps an authoritative claim when only the label projection fails', async () => {
    const harness = claimHarness({ labelFailure: true });
    const result = await claimIssueTask(claimInput(), harness.factory as never);

    expect(result).toMatchObject({
      claimStatus: 'granted',
      projection: {
        status: 'repair_required',
        recoveryCommand: 'openslack github repair claims --apply',
      },
    });
    expect(harness.refPresent()).toBe(true);
    expect(harness.comments).toHaveLength(1);
  });
});
