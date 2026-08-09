import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  claim: vi.fn(),
  getIssue: vi.fn(),
  parseRegistry: vi.fn(),
  queryReady: vi.fn(),
  resolvePrincipal: vi.fn(),
  runGates: vi.fn(),
}));

import { tickAgent } from '../tick.js';

const principal = {
  registry_id: 'test-agent',
  runtime_uid: 'agt_test',
  run_id: 'RUN-TEST',
  provider: 'cli',
};
const snapshot = { source: 'test-snapshot' };

function task(issueNumber = 42) {
  return {
    issueNumber,
    issueNodeId: `NODE_${issueNumber}`,
    title: `Task ${issueNumber}`,
    url: `https://github.com/example/repo/issues/${issueNumber}`,
    labels: ['openslack:task', 'openslack:ready'],
    body: 'manifest body',
    state: 'open' as const,
  };
}

function allowedGate(ttlMinutes = 120) {
  return {
    allowed: true,
    reason: '',
    manifest: {
      schema: 'openslack.github_issue_task.v1',
      task_id: 'TASK-2026-000042',
      title: 'Task 42',
      status: 'ready',
      agent_type: 'codex',
      risk_level: 'low',
      allowed_paths: ['docs/**'],
      lease: { ttl_minutes: ttlMinutes, heartbeat_minutes: 15 },
    },
    riskZone: 'green',
    changedPaths: ['docs/**'],
  };
}

function dependencies() {
  return {
    resolveAgentPrincipal: mocks.resolvePrincipal,
    authorizeAgentAction: mocks.authorize,
    parseAgentRegistry: mocks.parseRegistry,
    github: {
      claimIssueTask: mocks.claim,
      getIssueTaskByNumber: mocks.getIssue,
      queryReadyIssueTasks: mocks.queryReady,
      runAutoClaimGates: mocks.runGates,
    },
  };
}

function runTick(options: Parameters<typeof tickAgent>[1]) {
  return tickAgent('test-agent', options, dependencies());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePrincipal.mockReturnValue({ principal, snapshot });
  mocks.authorize.mockReturnValue({
    decision: 'allow',
    diagnostics: [],
    evidence: { reason: 'allowed' },
  });
  mocks.parseRegistry.mockReturnValue({
    capabilities: { primary: ['documentation'], secondary: ['git'] },
    task_matching: { max_risk_level: 'medium' },
  });
  mocks.runGates.mockReturnValue(allowedGate());
  mocks.claim.mockResolvedValue({
    claimStatus: 'granted',
    issueNumber: 42,
    claimRef: 'refs/heads/openslack/claims/issue-42',
    lease: { ttlMinutes: 120, expiresAt: '2026-08-09T12:00:00.000Z' },
  });
  mocks.queryReady.mockResolvedValue([]);
});

describe('tickAgent targeted GitHub issue claims', () => {
  it('rejects invalid target options before identity or network work', async () => {
    const invalid = await runTick({
      source: 'github-issues',
      issueNumber: 0,
    });
    expect(invalid.action).toBe('error');
    expect(invalid.message).toContain('positive integer');

    const local = await runTick({ source: 'local', issueNumber: 42 });
    expect(local.action).toBe('error');
    expect(local.message).toContain('requires --source github-issues');
    expect(mocks.resolvePrincipal).not.toHaveBeenCalled();
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });

  it('claims only the exact issue with manifest TTL and candidate authorization', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });

    const result = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });

    expect(result).toMatchObject({
      action: 'claimed',
      taskId: '#42',
      leaseId: 'refs/heads/openslack/claims/issue-42',
    });
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 42, ttlMinutes: 120 }),
    );
    expect(mocks.authorize).toHaveBeenLastCalledWith({
      snapshot,
      action: 'task.claim',
      changedPaths: ['docs/**'],
      riskZone: 'green',
    });
  });

  it.each([
    ['not found', { status: 'not_found' }, 'not found'],
    ['a pull request', { status: 'pull_request' }, 'pull request'],
  ])('fails closed when the target is %s', async (_name, lookup, expected) => {
    mocks.getIssue.mockResolvedValue(lookup);

    const result = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });

    expect(result.action).toBe('error');
    expect(result.message).toContain('TARGET_ISSUE_NOT_CLAIMABLE');
    expect(result.message).toContain(expected);
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('rejects closed or incorrectly labelled targets without fallback', async () => {
    mocks.getIssue.mockResolvedValue({
      status: 'found',
      task: { ...task(), state: 'closed' },
    });
    const closed = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });
    expect(closed.message).toContain('not open');

    mocks.getIssue.mockResolvedValue({
      status: 'found',
      task: { ...task(), labels: ['openslack:task'] },
    });
    const unlabelled = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });
    expect(unlabelled.message).toContain('openslack:ready');
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('preserves a manifest gate rejection and never falls back', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });
    mocks.runGates.mockReturnValue({
      allowed: false,
      reason: 'Agent lacks required capabilities: authenticated-host',
      manifest: null,
      riskZone: 'green',
      changedPaths: [],
    });

    const result = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });
    expect(result.message).toContain('authenticated-host');
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('fails the exact target when candidate-level authorization rejects its paths', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });
    mocks.authorize
      .mockReturnValueOnce({
        decision: 'allow',
        diagnostics: [],
        evidence: { reason: 'coarse grant' },
      })
      .mockReturnValueOnce({
        decision: 'deny',
        diagnostics: [],
        evidence: { reason: 'path denied' },
      });

    const result = await runTick({ source: 'github-issues', issueNumber: 42 });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('TARGET_ISSUE_NOT_CLAIMABLE');
    expect(result.message).toContain('path denied');
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('wraps an exact lookup API failure without searching for another issue', async () => {
    mocks.getIssue.mockRejectedValue(new Error('rate limited'));

    const result = await runTick({ source: 'github-issues', issueNumber: 42 });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('TARGET_ISSUE_NOT_CLAIMABLE');
    expect(result.message).toContain('rate limited');
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('returns the atomic claim denial for the exact target', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });
    mocks.claim.mockResolvedValue({
      claimStatus: 'denied',
      issueNumber: 42,
      claimRef: 'refs/heads/openslack/claims/issue-42',
      reason: 'ALREADY_CLAIMED',
    });

    const result = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });
    expect(result.action).toBe('error');
    expect(result.message).toContain('ALREADY_CLAIMED');
  });
});

describe('tickAgent unscoped GitHub issue claims', () => {
  it('skips ineligible candidates and claims the next eligible issue', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.runGates
      .mockReturnValueOnce({
        allowed: false,
        reason: 'risk exceeds agent maximum',
        manifest: null,
        riskZone: 'red',
        changedPaths: [],
      })
      .mockReturnValueOnce(allowedGate(90));
    mocks.claim.mockResolvedValueOnce({
      claimStatus: 'granted',
      issueNumber: 370,
      claimRef: 'refs/heads/openslack/claims/issue-370',
      lease: { ttlMinutes: 90, expiresAt: '2026-08-09T12:00:00.000Z' },
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'claimed', taskId: '#370' });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 370, ttlMinutes: 90 }),
    );
  });

  it('continues after an atomic claim race', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.claim
      .mockResolvedValueOnce({
        claimStatus: 'denied',
        issueNumber: 369,
        claimRef: 'refs/heads/openslack/claims/issue-369',
        reason: 'ALREADY_CLAIMED',
      })
      .mockResolvedValueOnce({
        claimStatus: 'granted',
        issueNumber: 370,
        claimRef: 'refs/heads/openslack/claims/issue-370',
        lease: { ttlMinutes: 120, expiresAt: '2026-08-09T12:00:00.000Z' },
      });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'claimed', taskId: '#370' });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it('fails closed after a claim API error instead of selecting another issue', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.claim.mockResolvedValueOnce({
      claimStatus: 'denied',
      issueNumber: 369,
      claimRef: 'refs/heads/openslack/claims/issue-369',
      reason: 'API_ERROR',
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('API_ERROR');
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy empty search result as idle', async () => {
    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'idle' });
    expect(result.message).toContain('No ready issues');
  });
});
