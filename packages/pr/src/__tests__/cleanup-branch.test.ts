import { describe, expect, it, vi } from 'vitest';
import { cleanupPRBranch, planPRBranchCleanup } from '../cleanup-branch.js';
import type { PRBranchCleanupDependencies } from '../cleanup-branch.js';
import type { PRBranchCleanupInput } from '../cleanup-types.js';
import type { PRReviewReport } from '../types.js';
import type { AgentPermissionSnapshot } from '@openslack/kernel';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
function report(patch: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 417,
    title: 'Cleanup',
    author: 'bot[bot]',
    state: 'closed',
    draft: false,
    merged: true,
    baseRef: 'main',
    headRef: 'topic',
    headSha: sha,
    headRepoFullName: 'owner/repo',
    baseRepoFullName: 'owner/repo',
    body: '',
    changedFiles: [],
    checks: [],
    reviews: [],
    humanApprovals: [],
    riskZone: 'yellow',
    decision: 'MERGED',
    reason: '',
    recommendation: '',
    mergeable: false,
    ...patch,
  };
}
function setup(patch: Partial<PRReviewReport> = {}) {
  const audit = vi.fn(async () => {});
  const input: PRBranchCleanupInput = {
    prNumber: 417,
    rootDir: '/unused-fixture',
    owner: 'owner',
    repo: 'repo',
    context: { kind: 'human-cli' },
    audit,
  };
  const deps = {
    fetchPR: vi.fn(async () => report(patch)),
    getDefaultBranch: vi.fn(async () => 'main'),
    isBranchProtected: vi.fn(async () => false),
    listOpenPRsForBranch: vi.fn(async () => []),
    claimRefPresent: vi.fn(async () => false),
    readRemoteBranchSha: vi.fn(async (): Promise<string | null> => sha),
    deleteRemoteBranchIfAt: vi.fn(
      async (_input: Parameters<PRBranchCleanupDependencies['deleteRemoteBranchIfAt']>[0]) => ({
        state: 'DELETED' as const,
        attempted: true,
        observedRefState: 'ABSENT' as const,
      }),
    ),
    hasLocalTaskDependency: vi.fn(() => false),
  } satisfies PRBranchCleanupDependencies;
  return { input, deps, audit };
}
const marker =
  '<!-- openslack-task-link\n' +
  JSON.stringify({
    schema: 'openslack.task_link.v1',
    issue_number: 12,
    agent_id: 'repair',
    task_id: 'TASK-12',
    run_id: 'RUN-12',
    claim_ref: 'refs/heads/openslack/claims/issue-12',
  }) +
  '\n-->';

describe('governed branch cleanup', () => {
  it('defaults to live preview, never invokes deletion or audit intent', async () => {
    const { input, deps, audit } = setup();
    const result = await cleanupPRBranch(input, deps);
    expect(result.state).toBe('CLEANUP_READY');
    expect(result.attempted).toBe(false);
    expect(deps.fetchPR).toHaveBeenCalledWith(
      417,
      expect.objectContaining({
        requireLive: true,
        strictEvidence: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mode: 'preview', phase: 'outcome', attempted: false }),
    );
  });
  it('planner ignores execute, and new execute re-observes current evidence', async () => {
    const { input, deps } = setup();
    expect((await planPRBranchCleanup({ ...input, execute: true }, deps)).state).toBe(
      'CLEANUP_READY',
    );
    deps.fetchPR.mockResolvedValue(report({ merged: false }));
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe(
      'BLOCKED_NOT_MERGED',
    );
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it.each([
    [{ state: 'open', merged: false }, 'BLOCKED_NOT_MERGED'],
    [{ state: 'closed', merged: false }, 'BLOCKED_NOT_MERGED'],
    [{ baseRef: 'other' }, 'BLOCKED_BASE_BRANCH'],
    [{ headRepoFullName: 'fork/repo' }, 'BLOCKED_FORK'],
    [{ baseRepoFullName: 'wrong/repo' }, 'BLOCKED_FORK'],
    [{ headRepoFullName: undefined }, 'BLOCKED_EVIDENCE'],
    [{ headSha: 'weak' }, 'BLOCKED_EVIDENCE'],
    [{ headRef: 'main' }, 'BLOCKED_BRANCH_RESERVED'],
    [{ headRef: 'openslack/claims' }, 'BLOCKED_BRANCH_RESERVED'],
    [{ headRef: 'openslack/probes/write-x' }, 'BLOCKED_BRANCH_RESERVED'],
    [{ headRef: 'topic..x' }, 'BLOCKED_EVIDENCE'],
    [{ body: '<!-- openslack-task-link {} -->' }, 'BLOCKED_EVIDENCE'],
    [{ body: marker + marker }, 'BLOCKED_EVIDENCE'],
    [{ headRef: 'agent/repair/TASK-12/RUN-12' }, 'BLOCKED_EVIDENCE'],
    [{ headRef: 'agent/other/TASK-12/RUN-12', body: marker }, 'BLOCKED_EVIDENCE'],
  ] as Array<[Partial<PRReviewReport>, string]>)('fails closed for %j', async (patch, state) => {
    const { input, deps } = setup(patch);
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe(state);
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it.each([
    'getDefaultBranch',
    'isBranchProtected',
    'listOpenPRsForBranch',
    'claimRefPresent',
    'readRemoteBranchSha',
  ] as const)('fails closed on %s evidence error', async (name) => {
    const { input, deps } = setup({ body: marker });
    deps[name].mockRejectedValue(new Error('secret response must not escape'));
    const result = await cleanupPRBranch({ ...input, execute: true }, deps);
    expect(result.state).toBe('BLOCKED_EVIDENCE');
    expect(JSON.stringify(result)).not.toContain('secret response');
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('blocks default branch even if not main', async () => {
    const { input, deps } = setup();
    deps.getDefaultBranch.mockResolvedValue('topic');
    expect((await cleanupPRBranch(input, deps)).state).toBe('BLOCKED_BRANCH_RESERVED');
  });
  it('blocks protected branch', async () => {
    const { input, deps } = setup();
    deps.isBranchProtected.mockResolvedValue(true);
    expect((await cleanupPRBranch(input, deps)).state).toBe('BLOCKED_BRANCH_RESERVED');
  });
  it('blocks any open PR depending on the branch', async () => {
    const { input, deps } = setup();
    deps.listOpenPRsForBranch.mockResolvedValue([
      {
        number: 99,
        headRef: 'other',
        baseRef: 'topic',
        headRepoFullName: 'owner/repo',
        baseRepoFullName: 'owner/repo',
      },
    ] as never);
    expect((await cleanupPRBranch(input, deps)).state).toBe('BLOCKED_DEPENDENCY');
  });
  it.each(['claim', 'local'])('blocks %s task association without releasing it', async (kind) => {
    const { input, deps } = setup({ body: marker });
    if (kind === 'claim') deps.claimRefPresent.mockResolvedValue(true);
    else deps.hasLocalTaskDependency.mockReturnValue(true);
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe(
      'BLOCKED_DEPENDENCY',
    );
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('returns absent without querying unavailable branch protection', async () => {
    const { input, deps } = setup();
    deps.readRemoteBranchSha.mockResolvedValue(null);
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe('ALREADY_ABSENT');
    expect(deps.isBranchProtected).not.toHaveBeenCalled();
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('blocks remote SHA drift before any deletion', async () => {
    const { input, deps } = setup();
    deps.readRemoteBranchSha.mockResolvedValue(other);
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe(
      'BLOCKED_SHA_DRIFT',
    );
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('persists intent, rechecks and writes one exact conditioned deletion then outcome', async () => {
    const { input, deps, audit } = setup();
    const result = await cleanupPRBranch({ ...input, execute: true }, deps);
    expect(result.state).toBe('DELETED');
    expect(result.auditStatus).toBe('RECORDED');
    expect(deps.fetchPR).toHaveBeenCalledTimes(2);
    expect(deps.deleteRemoteBranchIfAt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ branch: 'topic', expectedSha: sha, owner: 'owner', repo: 'repo' }),
    );
    expect(audit.mock.calls).toHaveLength(2);
    expect(audit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: 'requested', attempted: false }),
    );
    expect(audit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'outcome', state: 'DELETED', attempted: true }),
    );
  });
  it('blocks deletion if intent cannot be persisted', async () => {
    const { input, deps, audit } = setup();
    audit.mockRejectedValue(new Error('disk failure'));
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe('BLOCKED_AUDIT');
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('does not claim undo or retry if outcome audit fails', async () => {
    const { input, deps, audit } = setup();
    audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk'));
    const result = await cleanupPRBranch({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ state: 'DELETED', attempted: true, auditStatus: 'FAILED' });
    expect(deps.deleteRemoteBranchIfAt).toHaveBeenCalledTimes(1);
  });
  it('catches claim changes while durable intent is awaiting', async () => {
    const { input, deps, audit } = setup({ body: marker });
    audit.mockImplementationOnce(async () => {
      deps.claimRefPresent.mockResolvedValue(true);
    });
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe(
      'BLOCKED_DEPENDENCY',
    );
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('never retries a destructive transport without a receipt', async () => {
    const { input, deps } = setup();
    deps.deleteRemoteBranchIfAt.mockRejectedValue(new Error('timeout'));
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe(
      'RECONCILIATION_REQUIRED',
    );
    expect(deps.deleteRemoteBranchIfAt).toHaveBeenCalledTimes(1);
  });
  it('owns target/context across an await', async () => {
    const { input, deps } = setup();
    deps.fetchPR.mockImplementationOnce(async () => {
      input.owner = 'attacker';
      input.context = undefined as never;
      return report();
    });
    expect((await cleanupPRBranch({ ...input, execute: true }, deps)).state).toBe('DELETED');
    expect(deps.deleteRemoteBranchIfAt).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner' }),
    );
  });
  it('fails a bounded read deadline with zero writes', async () => {
    const { input, deps } = setup();
    deps.fetchPR.mockImplementation(() => new Promise(() => {}));
    expect((await cleanupPRBranch({ ...input, timeoutMs: 10, execute: true }, deps)).state).toBe(
      'BLOCKED_EVIDENCE',
    );
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it.each(['deny', 'ask', 'allow'] as const)('honors agent action %s', async (permission) => {
    const { input, deps } = setup();
    const principal = {
      registry_id: 'repair',
      runtime_uid: 'uid',
      run_id: 'run',
      provider: 'cli' as const,
    };
    const snapshot: AgentPermissionSnapshot = {
      principal,
      registry_entry_agent_id: 'repair',
      permissions: {
        paths: { allow: ['**'], deny: [] },
        actions: { 'pr.cleanup_branch': permission },
        github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: false },
        max_risk_zone: 'yellow',
      },
      resolved_at: new Date().toISOString(),
      source: 'registry_v2',
    };
    const result = await cleanupPRBranch(
      { ...input, execute: true, context: { kind: 'agent', principal, snapshot } },
      deps,
    );
    expect(result.state).toBe(permission === 'allow' ? 'DELETED' : 'BLOCKED_AUTHORIZATION');
    expect(deps.deleteRemoteBranchIfAt).toHaveBeenCalledTimes(permission === 'allow' ? 1 : 0);
  });
  it.each([undefined, { kind: 'agent' }, { kind: 'human-cli', snapshot: {} }])(
    'does not downgrade incomplete context %j',
    async (context) => {
      const { input, deps } = setup();
      expect(
        (await cleanupPRBranch({ ...input, execute: true, context: context as never }, deps)).state,
      ).toBe('BLOCKED_AUTHORIZATION');
      expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
    },
  );
  it('fails closed for a matching principal with malformed permissions', async () => {
    const { input, deps } = setup();
    const principal = {
      registry_id: 'repair',
      runtime_uid: 'uid',
      run_id: 'run',
      provider: 'cli' as const,
    };
    const context = {
      kind: 'agent',
      principal,
      snapshot: { principal, registry_entry_agent_id: 'repair' },
    };
    const result = await cleanupPRBranch(
      { ...input, execute: true, context: context as never },
      deps,
    );
    expect(result.state).toBe('BLOCKED_AUTHORIZATION');
    expect(deps.deleteRemoteBranchIfAt).not.toHaveBeenCalled();
  });
  it('reserves time for outcome audit after the transport consumes its budget', async () => {
    vi.useFakeTimers();
    try {
      const { input, deps, audit } = setup();
      deps.deleteRemoteBranchIfAt.mockImplementationOnce(async (transport) => {
        expect(transport.timeoutMs).toBe(800);
        vi.setSystemTime(Date.now() + transport.timeoutMs!);
        return { state: 'DELETED', attempted: true, observedRefState: 'ABSENT' };
      });
      const result = await cleanupPRBranch({ ...input, execute: true, timeoutMs: 1000 }, deps);
      expect(result).toMatchObject({ state: 'DELETED', auditStatus: 'RECORDED' });
      expect(audit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ phase: 'outcome', observedRefState: 'ABSENT' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
