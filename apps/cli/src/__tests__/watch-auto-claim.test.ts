import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedIssueRepositoryEvent } from '@openslack/github';
import { buildAutoClaimFn } from '../commands/watch-auto-claim.js';

const mocks = vi.hoisted(() => ({
  resolveAgentPrincipal: vi.fn(),
  authorizeAgentAction: vi.fn(),
  isTaskRiskLevel: vi.fn(),
  recordEvent: vi.fn(),
  claimIssueTask: vi.fn(),
  createIssueTaskSnapshot: vi.fn(),
  normalizeErrorMessage: vi.fn(),
  runAutoClaimGates: vi.fn(),
  parseAgentRegistry: vi.fn(),
}));

vi.mock('@openslack/runtime', () => ({
  resolveAgentPrincipal: mocks.resolveAgentPrincipal,
}));

vi.mock('@openslack/kernel', () => ({
  authorizeAgentAction: mocks.authorizeAgentAction,
  isTaskRiskLevel: mocks.isTaskRiskLevel,
}));

vi.mock('@openslack/collaboration', () => ({
  recordEvent: mocks.recordEvent,
}));

vi.mock('@openslack/github', () => ({
  claimIssueTask: mocks.claimIssueTask,
  createIssueTaskSnapshot: mocks.createIssueTaskSnapshot,
  normalizeErrorMessage: mocks.normalizeErrorMessage,
  runAutoClaimGates: mocks.runAutoClaimGates,
}));

vi.mock('@openslack/workspace', () => ({
  parseAgentRegistry: mocks.parseAgentRegistry,
}));

const event: NormalizedIssueRepositoryEvent = {
  kind: 'issue',
  eventKey: 'issues.opened',
  action: 'opened',
  repository: {
    owner: 'Negentropy-Laby',
    repo: 'OpenSlack',
    fullName: 'Negentropy-Laby/OpenSlack',
    canonicalFullName: 'negentropy-laby/openslack',
  },
  object: {
    kind: 'issue',
    id: 'negentropy-laby/openslack#42',
    number: 42,
  },
  source: 'webhook',
  observedAt: '2026-08-10T00:00:00Z',
  metadata: { informational: false, senderLogin: 'operator' },
  owner: 'Negentropy-Laby',
  repo: 'OpenSlack',
  issueNumber: 42,
  issueNodeId: 'I_kwDO42',
  title: 'Canonical issue task',
  url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
  labels: ['openslack:task', 'openslack:ready', 'agent-type:codex'],
  body: '```openslack-task\nmanifest\n```',
  state: 'open',
  senderLogin: 'operator',
  deliveryId: 'delivery-42',
  updatedAt: '2026-08-10T00:00:00Z',
};

describe('watch auto-claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.resolveAgentPrincipal.mockReturnValue({ principal: {}, snapshot: {} });
    mocks.parseAgentRegistry.mockReturnValue({
      capabilities: { primary: ['docs'], secondary: [] },
      task_matching: { max_risk_level: 'medium' },
    });
    mocks.isTaskRiskLevel.mockReturnValue(true);
    mocks.normalizeErrorMessage.mockReturnValue('normalized error');
    mocks.authorizeAgentAction.mockReturnValue({
      decision: 'allow',
      evidence: { reason: 'allowed' },
      diagnostics: [],
    });
    mocks.createIssueTaskSnapshot.mockReturnValue({
      schema: 'openslack.issue_task_snapshot.v1',
      issueNumber: 42,
      issueNodeId: 'I_kwDO42',
      updatedAt: event.updatedAt,
      sha256: 'a'.repeat(64),
    });
    mocks.claimIssueTask.mockResolvedValue({
      claimStatus: 'granted',
      projection: { status: 'synchronized' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['closed', { ...event, state: 'closed' as const }],
    ['unknown', { ...event, state: 'unknown' as const }],
    ['missing labels', { ...event, labels: ['openslack:task'] }],
  ])('passes the complete %s candidate through the shared gate', async (_name, candidate) => {
    mocks.runAutoClaimGates.mockReturnValue({
      allowed: false,
      code: 'ISSUE_NOT_OPEN',
      reason: 'candidate rejected',
      manifest: null,
      riskZone: 'green',
      declaredScope: [],
    });

    await buildAutoClaimFn('D:/repo')(candidate, ['operator']);

    expect(mocks.runAutoClaimGates).toHaveBeenCalledWith({
      candidate,
      agentCapabilities: { primary: ['docs'], secondary: [] },
      agentMaxRiskLevel: 'medium',
    });
    expect(mocks.claimIssueTask).not.toHaveBeenCalled();
  });

  it('authorizes the declared scope and uses the manifest lease', async () => {
    mocks.runAutoClaimGates.mockReturnValue({
      allowed: true,
      code: 'ALLOWED',
      reason: '',
      manifest: {
        task_id: 'TASK-2026-000042',
        lease: { ttl_minutes: 75, heartbeat_minutes: 15 },
      },
      riskZone: 'red',
      declaredScope: ['packages/kernel/src/**'],
    });

    await buildAutoClaimFn('D:/repo')(event, ['operator']);

    expect(mocks.authorizeAgentAction).toHaveBeenCalledWith({
      snapshot: {},
      action: 'task.claim',
      declaredScope: ['packages/kernel/src/**'],
      riskZone: 'red',
    });
    expect(mocks.claimIssueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 42,
        taskId: 'TASK-2026-000042',
        taskSnapshot: expect.objectContaining({ sha256: 'a'.repeat(64) }),
        riskZone: 'red',
        ttlMinutes: 75,
        heartbeatMinutes: 15,
      }),
    );
  });

  it.each(['API_ERROR', 'RECONCILIATION_REQUIRED'] as const)(
    'fails the watch delivery fast on %s',
    async (reason) => {
      mocks.runAutoClaimGates.mockReturnValue({
        allowed: true,
        code: 'ALLOWED',
        reason: '',
        manifest: { task_id: 'TASK-2026-000042' },
        riskZone: 'green',
        declaredScope: ['docs/**'],
      });
      mocks.claimIssueTask.mockResolvedValue({
        claimStatus: 'denied',
        issueNumber: 42,
        claimRef: 'refs/heads/openslack/claims/issue-42',
        reason,
      });

      await expect(buildAutoClaimFn('D:/repo')(event, ['operator'])).rejects.toThrow(reason);
    },
  );

  it('treats an already-claimed race as a normal candidate denial', async () => {
    mocks.runAutoClaimGates.mockReturnValue({
      allowed: true,
      code: 'ALLOWED',
      reason: '',
      manifest: { task_id: 'TASK-2026-000042' },
      riskZone: 'green',
      declaredScope: ['docs/**'],
    });
    mocks.claimIssueTask.mockResolvedValue({
      claimStatus: 'denied',
      issueNumber: 42,
      claimRef: 'refs/heads/openslack/claims/issue-42',
      reason: 'ALREADY_CLAIMED',
    });

    await expect(buildAutoClaimFn('D:/repo')(event, ['operator'])).resolves.toBeUndefined();
  });

  it('fails the watch delivery fast on an unexpected claim exception', async () => {
    mocks.runAutoClaimGates.mockReturnValue({
      allowed: true,
      code: 'ALLOWED',
      reason: '',
      manifest: { task_id: 'TASK-2026-000042' },
      riskZone: 'green',
      declaredScope: ['docs/**'],
    });
    mocks.claimIssueTask.mockRejectedValue('claim transport failed');

    await expect(buildAutoClaimFn('D:/repo')(event, ['operator'])).rejects.toBe(
      'claim transport failed',
    );
  });

  it('fails closed before the gate when the registry is invalid', async () => {
    mocks.parseAgentRegistry.mockImplementation(() => {
      throw new Error('bad registry');
    });

    await buildAutoClaimFn('D:/repo')(event, ['operator']);

    expect(mocks.runAutoClaimGates).not.toHaveBeenCalled();
    expect(mocks.claimIssueTask).not.toHaveBeenCalled();
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.blocked',
        summary: expect.stringContaining('agent registry is invalid: normalized error'),
      }),
    );
  });
});
