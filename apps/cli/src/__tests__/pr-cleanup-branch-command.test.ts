import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  client: vi.fn(),
  resolve: vi.fn(),
  append: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@openslack/pr', () => ({ cleanupPRBranch: mocks.cleanup }));
vi.mock('@openslack/github', () => ({
  getClient: mocks.client,
  parseGitHubRepoSpec: (s: string) => (/^[\w-]+\/[\w.-]+$/.test(s) ? {} : null),
}));
vi.mock('@openslack/runtime', () => ({ resolveAgentPrincipal: mocks.resolve }));
vi.mock('@openslack/collaboration', () => ({
  createBoundEventAppender: () => ({ append: mocks.append }),
  createEvent: (event: unknown) => event,
  recordEvent: mocks.record,
}));

import { runPRBranchCleanupCommand } from '../commands/pr-cleanup-branch.js';

const options = { auth: 'auto', remote: 'origin', timeout: '60' };
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
    await runPRBranchCleanupCommand('417', { ...options, execute: true, agentId: 'worker' });
    expect(process.exitCode).toBe(1);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('passes resolved agent context without turning ask into human authorization', async () => {
    const principal = { agentId: 'worker' };
    const snapshot = { agentId: 'worker' };
    mocks.resolve.mockReturnValue({ principal, snapshot });
    mocks.cleanup.mockResolvedValue({ ...result, state: 'BLOCKED_AUTHORIZATION' });
    await runPRBranchCleanupCommand('417', { ...options, execute: true, agentId: 'worker' });
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ context: { kind: 'agent', principal, snapshot } }),
    );
    expect(process.exitCode).toBe(1);
  });

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
