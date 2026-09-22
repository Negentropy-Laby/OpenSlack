import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  client: vi.fn(),
  resolve: vi.fn(),
  append: vi.fn(),
  record: vi.fn(),
  broker: vi.fn(),
  registry: vi.fn(),
  identity: vi.fn(),
}));
vi.mock('@openslack/pr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openslack/pr')>();
  return {
    cleanupPRBranch: mocks.cleanup,
    sendCleanupBrokerRequest: mocks.broker,
    CleanupBrokerClientError: actual.CleanupBrokerClientError,
  };
});
vi.mock('@openslack/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openslack/workspace')>()),
  parseAgentRegistry: mocks.registry,
}));
vi.mock('@openslack/github', () => ({
  getClient: mocks.client,
  parseGitHubRepoSpec: (s: string) => (/^[\w-]+\/[\w.-]+$/.test(s) ? {} : null),
}));
vi.mock('@openslack/runtime', () => ({
  resolveAgentPrincipal: mocks.resolve,
  loadRuntimeIdentity: mocks.identity,
}));
vi.mock('@openslack/collaboration', () => ({
  createBoundEventAppender: () => ({ append: mocks.append }),
  createEvent: (event: unknown) => event,
  recordEvent: mocks.record,
}));

import { runPRBranchCleanupCommand } from '../commands/pr-cleanup-branch.js';
import { CleanupBrokerClientError } from '@openslack/pr';

const options = { auth: 'auto', remote: 'origin', timeout: '60' };
const agentOptions = {
  ...options,
  auth: 'app',
  remoteExplicit: true,
  repo: 'owner/repo',
  permitId: 'PERMIT-1',
  agentId: 'worker',
};
const brokerResult = {
  schema: 'openslack.cleanup_response.v1',
  mode: 'preview',
  permitId: 'PERMIT-1',
  permitState: 'issued',
  claimRequirement: 'not_required',
  claimStatus: 'not_evaluated',
  state: 'CLEANUP_READY',
  attempted: false,
  auditStatus: 'NOT_REQUIRED',
  reason: 'CLEANUP_READY',
};
const result = {
  state: 'CLEANUP_READY',
  prNumber: 417,
  repository: 'owner/repo',
  branch: 'feature',
  expectedSha: 'a'.repeat(40),
  attempted: false,
  checks: [],
  reason: 'Ready',
  operationId: 'operation-1',
  evidenceTimestamp: '2026-09-20T00:00:00.000Z',
  auditStatus: 'NOT_REQUIRED',
};

describe('branch cleanup CLI adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.client.mockResolvedValue({ owner: 'owner', repo: 'repo', isDryRun: false });
    mocks.cleanup.mockResolvedValue(result);
    mocks.resolve.mockReturnValue({
      principal: { registry_id: 'worker', runtime_uid: 'uid', run_id: 'RUN-1', provider: 'cli' },
      snapshot: {},
    });
    mocks.registry.mockReturnValue({
      agent_id: 'worker',
      identity: { uid: 'uid', principal_id: 'custom:worker' },
    });
    mocks.broker.mockResolvedValue(brokerResult);
    mocks.identity.mockReturnValue({
      agent_id: 'worker',
      agent_uid: 'uid',
      run_id: 'RUN-1',
      provider: 'cli',
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('defaults to live preview and records previewed without a durable execution write', async () => {
    mocks.cleanup.mockImplementation(async (input) => {
      await input.audit({
        ...result,
        phase: 'outcome',
        mode: 'preview',
        executor: 'human-cli',
        authorizationSource: 'preview-only',
      });
      return result;
    });
    await runPRBranchCleanupCommand('417', options);
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({ requireLive: true, strictEvidence: true }),
    );
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        execute: false,
        context: { kind: 'human-cli' },
        timeoutMs: expect.any(Number),
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr.cleanup_branch.previewed' }),
      expect.any(String),
    );
    expect(mocks.append).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Preview only. No remote branch was deleted.');
  });

  it.each(['0', '-1', '1x', '1.2', '9007199254740992'])(
    'rejects invalid PR number %s before evidence',
    async (number) => {
      await runPRBranchCleanupCommand(number, options);
      expect(process.exitCode).toBe(1);
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
    },
  );

  it.each([
    { auth: 'dry-run' },
    { auth: 'unknown' },
    { timeout: '0' },
    { timeout: '601' },
    { timeout: '2s' },
    { remote: '--all' },
    { remote: 'https://github.com/owner/repo' },
    { repo: 'bad' },
  ])('rejects invalid options %j', async (invalid) => {
    await runPRBranchCleanupCommand('417', { ...options, ...invalid });
    expect(process.exitCode).toBe(1);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('does not fall back to human when agent resolution fails', async () => {
    mocks.resolve.mockReturnValue({ error: 'missing' });
    await runPRBranchCleanupCommand('417', { ...agentOptions, execute: true, operationId: 'OP-1' });
    expect(process.exitCode).toBe(1);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('routes self-reported agent identity exclusively to broker without GitHub auth or direct cleanup', async () => {
    await runPRBranchCleanupCommand('417', agentOptions);
    expect(mocks.broker).toHaveBeenCalledWith(
      {
        schema: 'openslack.cleanup_request.v1',
        mode: 'preview',
        agentId: 'worker',
        principalId: 'custom:worker',
        runtimeUid: 'uid',
        runId: 'RUN-1',
        repo: 'owner/repo',
        remote: 'origin',
        prNumber: 417,
        permitId: 'PERMIT-1',
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    { permitId: undefined },
    { repo: undefined },
    { remoteExplicit: false },
    { remoteExplicit: undefined },
    { auth: 'auto' },
    { auth: 'token' },
    { execute: true },
    { operationStatus: true },
    { operationId: 'OP-1' },
    { execute: true, operationStatus: true, operationId: 'OP-1' },
  ])('rejects unsafe broker flag combination %j before evidence or transport', async (patch) => {
    await runPRBranchCleanupCommand('417', { ...agentOptions, ...patch });
    expect(process.exitCode).toBe(1);
    expect(mocks.broker).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([{ permitId: 'PERMIT-1' }, { operationId: 'OP-1' }, { operationStatus: true }])(
    'rejects broker options without explicit agent %j',
    async (patch) => {
      await runPRBranchCleanupCommand('417', { ...options, ...patch });
      expect(process.exitCode).toBe(1);
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(mocks.broker).not.toHaveBeenCalled();
    },
  );

  it.each(['execute', 'status'] as const)(
    'sends %s with stable operation ID and accepts durable consumed result',
    async (mode) => {
      mocks.broker.mockResolvedValue({
        ...brokerResult,
        mode,
        operationId: 'OP-1',
        state: 'DELETED',
        attempted: true,
        permitState: 'consumed',
        auditStatus: 'RECORDED',
      });
      await runPRBranchCleanupCommand('417', {
        ...agentOptions,
        execute: mode === 'execute',
        operationStatus: mode === 'status',
        operationId: 'OP-1',
      });
      expect(mocks.broker).toHaveBeenCalledWith(
        expect.objectContaining({ mode, operationId: 'OP-1' }),
        expect.any(Object),
      );
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    'UNSUPPORTED_PLATFORM',
    'BROKER_UNAVAILABLE',
    'BROKER_TIMEOUT',
    'BROKER_INVALID_RESPONSE',
  ] as const)('prints typed broker %s without fallback or retry', async (code) => {
    mocks.broker.mockRejectedValue(new CleanupBrokerClientError(code, true));
    await runPRBranchCleanupCommand('417', { ...agentOptions, execute: true, operationId: 'OP-1' });
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(mocks.broker).toHaveBeenCalledTimes(1);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    'OPERATION_IN_PROGRESS',
    'RECONCILIATION_REQUIRED',
    'OPERATION_NOT_FOUND',
    'BLOCKED_AUTHORIZATION',
  ])('does not treat broker %s as completed', async (state) => {
    mocks.broker.mockResolvedValue({
      ...brokerResult,
      mode: 'status',
      state,
      permitState: 'reserved',
      operationId: 'OP-1',
    });
    await runPRBranchCleanupCommand('417', {
      ...agentOptions,
      operationStatus: true,
      operationId: 'OP-1',
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.broker).toHaveBeenCalledTimes(1);
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('rejects local registry identity drift without contacting broker or GitHub', async () => {
    mocks.registry.mockReturnValue({
      agent_id: 'worker',
      identity: { uid: 'different', principal_id: 'custom:worker' },
    });
    await runPRBranchCleanupCommand('417', agentOptions);
    expect(process.exitCode).toBe(1);
    expect(mocks.broker).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('queries a historical receipt without current active-registry admission', async () => {
    mocks.registry.mockReturnValue({
      agent_id: 'worker',
      identity: { uid: 'uid', principal_id: 'custom:worker', status: 'retired' },
    });
    mocks.resolve.mockReturnValue({ error: 'retired' });
    mocks.broker.mockResolvedValue({
      ...brokerResult,
      mode: 'status',
      operationId: 'OP-1',
      state: 'DELETED',
      attempted: true,
      permitState: 'consumed',
      auditStatus: 'RECORDED',
    });
    await runPRBranchCleanupCommand('417', {
      ...agentOptions,
      operationStatus: true,
      operationId: 'OP-1',
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.broker).toHaveBeenCalledOnce();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['registry', 'identity'] as const)(
    'reports missing original %s for status without inventing claims',
    async (missing) => {
      mocks[missing].mockReturnValue(null);
      await runPRBranchCleanupCommand('417', {
        ...agentOptions,
        operationStatus: true,
        operationId: 'OP-1',
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('STATUS_IDENTITY_UNAVAILABLE'),
      );
      expect(mocks.broker).not.toHaveBeenCalled();
      expect(mocks.client).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([false, true])(
    'Commander distinguishes default versus explicit origin (%s)',
    async (explicit) => {
      const { prCommands } = await import('../commands/pr.js');
      const args = [
        'cleanup-branch',
        '417',
        '--agent-id',
        'worker',
        '--permit-id',
        'PERMIT-1',
        '--repo',
        'owner/repo',
        '--auth',
        'app',
      ];
      if (explicit) args.push('--remote', 'origin');
      await prCommands().exitOverride().parseAsync(args, { from: 'user' });
      expect(mocks.broker).toHaveBeenCalledTimes(explicit ? 1 : 0);
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(explicit ? undefined : 1);
    },
  );

  it('records durable requested and executed events through the callback', async () => {
    mocks.cleanup.mockImplementation(async (input) => {
      const event = { ...result, executor: 'human-cli', authorizationSource: 'explicit-execute' };
      await input.audit({ ...event, phase: 'requested' });
      await input.audit({ ...event, phase: 'outcome', state: 'DELETED', attempted: true });
      return { ...result, state: 'DELETED', attempted: true, auditStatus: 'RECORDED' };
    });
    await runPRBranchCleanupCommand('417', { ...options, execute: true });
    expect(mocks.append.mock.calls.map(([e]) => e.type)).toEqual([
      'pr.cleanup_branch.requested',
      'pr.cleanup_branch.executed',
    ]);
    expect(mocks.append.mock.calls[0][0].metadata).toMatchObject({
      operation_id: 'operation-1',
      authorization_source: 'explicit-execute',
      transport_identity: 'github_app_installation',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('propagates durable append failure to the steward without swallowing it', async () => {
    mocks.append.mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    mocks.cleanup.mockImplementation(async (input) => {
      await expect(
        input.audit({
          ...result,
          phase: 'requested',
          executor: 'human-cli',
          authorizationSource: 'explicit-execute',
        }),
      ).rejects.toThrow('disk unavailable');
      return { ...result, state: 'BLOCKED_AUDIT', auditStatus: 'FAILED' };
    });
    await runPRBranchCleanupCommand('417', { ...options, execute: true });
    expect(process.exitCode).toBe(1);
  });

  it.each(['ABSENT_AFTER_ATTEMPT', 'RECONCILIATION_REQUIRED', 'FAILED', 'BLOCKED_EVIDENCE'])(
    'exits nonzero for %s',
    async (state) => {
      mocks.cleanup.mockResolvedValue({ ...result, state });
      await runPRBranchCleanupCommand('417', { ...options, execute: true });
      expect(process.exitCode).toBe(1);
    },
  );

  it('does not report successful completion when deletion succeeded but terminal audit failed', async () => {
    mocks.cleanup.mockResolvedValue({
      ...result,
      state: 'DELETED',
      attempted: true,
      auditStatus: 'FAILED',
    });
    await runPRBranchCleanupCommand('417', { ...options, execute: true });
    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Decision: DELETED'));
  });
});
