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

import { tickAgent, validateTickTargetOptions } from '../tick.js';
import { createIssueTaskSnapshot } from '@openslack/github';

const principal = {
  registry_id: 'test-agent',
  runtime_uid: 'agt_test',
  run_id: 'RUN-TEST',
  provider: 'cli',
};
const snapshot = { source: 'test-snapshot' };

function task(issueNumber = 42) {
  const candidate = {
    issueNumber,
    issueNodeId: `NODE_${issueNumber}`,
    title: `Task ${issueNumber}`,
    url: `https://github.com/example/repo/issues/${issueNumber}`,
    labels: ['openslack:task', 'openslack:ready', 'agent-type:codex'],
    body: 'manifest body',
    state: 'open' as const,
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
  return { ...candidate, snapshot: createIssueTaskSnapshot(candidate) };
}

function allowedGate(ttlMinutes: number | null = 120) {
  return {
    allowed: true,
    code: 'ALLOWED',
    reason: '',
    manifest: {
      schema: 'openslack.github_issue_task.v1',
      task_id: 'TASK-2026-000042',
      title: 'Task 42',
      status: 'ready',
      agent_type: 'codex',
      risk_level: 'low',
      allowed_paths: ['docs/**'],
      ...(ttlMinutes === null ? {} : { lease: { ttl_minutes: ttlMinutes, heartbeat_minutes: 15 } }),
    },
    riskZone: 'green',
    declaredScope: ['docs/**'],
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
  mocks.runGates.mockImplementation(({ candidate }) => {
    if (candidate.state !== 'open') {
      return {
        allowed: false,
        code: 'ISSUE_NOT_OPEN',
        reason: 'Issue is not open',
        manifest: null,
        riskZone: 'green',
        declaredScope: [],
      };
    }
    if (
      !candidate.labels.includes('openslack:task') ||
      !candidate.labels.includes('openslack:ready')
    ) {
      return {
        allowed: false,
        code: 'ISSUE_NOT_READY',
        reason: 'Issue must have openslack:task and openslack:ready labels',
        manifest: null,
        riskZone: 'green',
        declaredScope: [],
      };
    }
    return allowedGate();
  });
  mocks.claim.mockResolvedValue({
    claimStatus: 'granted',
    issueNumber: 42,
    claimRef: 'refs/heads/openslack/claims/issue-42',
    lease: {
      ttlMinutes: 120,
      heartbeatMinutes: 15,
      expiresAt: '2026-08-09T12:00:00.000Z',
      nextHeartbeatAt: '2026-08-09T10:15:00.000Z',
    },
    projection: { status: 'synchronized' },
  });
  mocks.queryReady.mockResolvedValue([]);
});

describe('tickAgent targeted GitHub issue claims', () => {
  it('shares one target option validator across string and runtime inputs', () => {
    expect(validateTickTargetOptions({ source: 'github-issues', issueNumber: '42' })).toEqual({
      valid: true,
      issueNumber: 42,
    });
    expect(validateTickTargetOptions({ source: 'github-issues', issueNumber: '01' })).toMatchObject(
      {
        valid: false,
      },
    );
    expect(validateTickTargetOptions({ source: 'github-issues', issueNumber: 42 })).toEqual({
      valid: true,
      issueNumber: 42,
    });
  });

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
      declaredScope: ['docs/**'],
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

  it('rejects missing or unknown Issue states instead of coercing them open', async () => {
    for (const state of [undefined, 'unknown'] as const) {
      mocks.getIssue.mockResolvedValue({
        status: 'found',
        task: { ...task(), state },
      });
      const result = await runTick({ source: 'github-issues', issueNumber: 42 });
      expect(result.message).toContain('not open');
    }
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('preserves a manifest gate rejection and never falls back', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });
    mocks.runGates.mockReturnValue({
      allowed: false,
      code: 'CAPABILITY_DENIED',
      reason: 'Agent lacks required capabilities: authenticated-host',
      manifest: null,
      riskZone: 'green',
      declaredScope: [],
    });

    const result = await runTick({
      source: 'github-issues',
      issueNumber: 42,
    });
    expect(result.message).toContain('authenticated-host');
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('wraps a targeted manifest gate exception with stable Issue context', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });
    mocks.runGates.mockImplementation(() => {
      throw 'malformed candidate';
    });

    const result = await runTick({ source: 'github-issues', issueNumber: 42 });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('TARGET_ISSUE_NOT_CLAIMABLE: issue #42');
    expect(result.message).toContain('malformed candidate');
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

  it('uses a stable fallback for an empty exact-target claim denial', async () => {
    mocks.getIssue.mockResolvedValue({ status: 'found', task: task() });
    mocks.claim.mockResolvedValue({
      claimStatus: 'denied',
      issueNumber: 42,
      claimRef: 'refs/heads/openslack/claims/issue-42',
    });

    const result = await runTick({ source: 'github-issues', issueNumber: 42 });
    expect(result.message).toContain('claim was denied');
    expect(result.message).not.toContain('undefined');
  });
});

describe('tickAgent unscoped GitHub issue claims', () => {
  it('skips ineligible candidates and claims the next eligible issue', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.runGates
      .mockReturnValueOnce({
        allowed: false,
        code: 'RISK_DENIED',
        reason: 'risk exceeds agent maximum',
        manifest: null,
        riskZone: 'red',
        declaredScope: [],
      })
      .mockReturnValueOnce(allowedGate(90));
    mocks.claim.mockResolvedValueOnce({
      claimStatus: 'granted',
      issueNumber: 370,
      claimRef: 'refs/heads/openslack/claims/issue-370',
      lease: {
        ttlMinutes: 90,
        heartbeatMinutes: 15,
        expiresAt: '2026-08-09T12:00:00.000Z',
        nextHeartbeatAt: '2026-08-09T10:15:00.000Z',
      },
      projection: { status: 'synchronized' },
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'claimed', taskId: '#370' });
    expect(result.candidateRejections).toEqual([
      {
        issueNumber: 369,
        code: 'RISK_DENIED',
        reason: 'risk exceeds agent maximum',
      },
    ]);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 370, ttlMinutes: 90 }),
    );
  });

  it('bounds and normalizes candidate rejection diagnostics', async () => {
    mocks.queryReady.mockResolvedValue(Array.from({ length: 12 }, (_, index) => task(400 + index)));
    mocks.runGates.mockReturnValue({
      allowed: false,
      code: 'MANIFEST_INVALID',
      reason: `  ${'invalid\n'.repeat(80)}  `,
      manifest: null,
      riskZone: 'green',
      declaredScope: [],
    });

    const result = await runTick({ source: 'github-issues' });

    expect(result).toMatchObject({ action: 'idle' });
    expect(result.candidateRejections).toHaveLength(10);
    expect(result.candidateRejections?.[0]).toMatchObject({
      issueNumber: 400,
      code: 'MANIFEST_INVALID',
    });
    expect(result.candidateRejections?.[0]?.reason.length).toBeLessThanOrEqual(240);
    expect(result.candidateRejections?.[0]?.reason).not.toMatch(/\s{2,}/u);
    expect(result.message).toContain('10 candidate(s) rejected');
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
        lease: {
          ttlMinutes: 120,
          heartbeatMinutes: 15,
          expiresAt: '2026-08-09T12:00:00.000Z',
          nextHeartbeatAt: '2026-08-09T10:15:00.000Z',
        },
        projection: { status: 'synchronized' },
      });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'claimed', taskId: '#370' });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it('continues after a snapshot race was rolled back', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.claim
      .mockResolvedValueOnce({
        claimStatus: 'denied',
        issueNumber: 369,
        claimRef: 'refs/heads/openslack/claims/issue-369',
        reason: 'STALE_CANDIDATE',
      })
      .mockResolvedValueOnce({
        claimStatus: 'granted',
        issueNumber: 370,
        claimRef: 'refs/heads/openslack/claims/issue-370',
        lease: {
          ttlMinutes: 120,
          heartbeatMinutes: 15,
          expiresAt: '2026-08-09T12:00:00.000Z',
          nextHeartbeatAt: '2026-08-09T10:15:00.000Z',
        },
        projection: { status: 'synchronized' },
      });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({
      action: 'claimed',
      candidateRejections: [expect.objectContaining({ code: 'STALE_CANDIDATE' })],
    });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it('fails fast on an unexpected manifest gate exception', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.runGates
      .mockImplementationOnce(() => {
        throw new SyntaxError('bad manifest');
      })
      .mockReturnValueOnce(allowedGate());

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('bad manifest');
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('skips a candidate authorization denial and claims the next candidate', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.authorize
      .mockReturnValueOnce({
        decision: 'allow',
        diagnostics: [],
        evidence: { reason: 'coarse grant' },
      })
      .mockReturnValueOnce({
        decision: 'deny',
        diagnostics: [],
        evidence: { reason: 'candidate denied' },
      })
      .mockReturnValueOnce({
        decision: 'allow',
        diagnostics: [],
        evidence: { reason: 'candidate allowed' },
      });
    mocks.claim.mockResolvedValueOnce({
      claimStatus: 'granted',
      issueNumber: 370,
      claimRef: 'refs/heads/openslack/claims/issue-370',
      lease: {
        ttlMinutes: 120,
        heartbeatMinutes: 15,
        expiresAt: '2026-08-09T12:00:00.000Z',
        nextHeartbeatAt: '2026-08-09T10:15:00.000Z',
      },
      projection: { status: 'synchronized' },
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'claimed', taskId: '#370' });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it('uses empty capabilities and the default risk when the registry is absent', async () => {
    mocks.parseRegistry.mockReturnValue(null);
    mocks.queryReady.mockResolvedValue([task()]);

    await runTick({ source: 'github-issues' });
    expect(mocks.runGates).toHaveBeenCalledWith(
      expect.objectContaining({
        agentCapabilities: {},
        agentMaxRiskLevel: 'medium',
      }),
    );
  });

  it('uses the 60-minute runtime fallback only when lease is absent', async () => {
    mocks.queryReady.mockResolvedValue([task()]);
    mocks.runGates.mockReturnValue(allowedGate(null));

    await runTick({ source: 'github-issues' });
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ ttlMinutes: 60 }));
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

  it('fails closed when tentative-ref cleanup requires reconciliation', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.claim.mockResolvedValueOnce({
      claimStatus: 'denied',
      issueNumber: 369,
      claimRef: 'refs/heads/openslack/claims/issue-369',
      reason: 'RECONCILIATION_REQUIRED',
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('RECONCILIATION_REQUIRED');
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it('fails closed after a claim denial without a reason', async () => {
    mocks.queryReady.mockResolvedValue([task(369), task(370)]);
    mocks.claim.mockResolvedValueOnce({
      claimStatus: 'denied',
      issueNumber: 369,
      claimRef: 'refs/heads/openslack/claims/issue-369',
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('claim was denied');
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it('fails before GitHub discovery when the registry risk ceiling is invalid', async () => {
    mocks.parseRegistry.mockReturnValue({
      capabilities: { primary: [], secondary: [] },
      task_matching: { max_risk_level: 'hig' },
    });

    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('max_risk_level');
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });

  it('keeps the legacy empty search result as idle', async () => {
    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'idle' });
    expect(result.message).toContain('No ready issues');
  });

  it('normalizes a non-Error transport throw', async () => {
    mocks.queryReady.mockRejectedValue(null);
    const result = await runTick({ source: 'github-issues' });
    expect(result).toMatchObject({ action: 'error' });
    expect(result.message).toContain('unknown error');
    expect(result.message).not.toContain('undefined');
  });
});

describe('tickAgent local default', () => {
  it('defaults to local without loading GitHub task discovery', async () => {
    mocks.authorize.mockReturnValue({
      decision: 'deny',
      diagnostics: [],
      evidence: { reason: 'local denied' },
    });
    const result = await runTick({});
    expect(result).toMatchObject({ action: 'error' });
    expect(mocks.queryReady).not.toHaveBeenCalled();
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });
});
