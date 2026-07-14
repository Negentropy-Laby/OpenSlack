import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeClaim: vi.fn(),
  heartbeatClaim: vi.fn(),
  reviewClaim: vi.fn(),
}));

vi.mock('@openslack/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openslack/github')>()),
  completeClaim: mocks.completeClaim,
  heartbeatClaim: mocks.heartbeatClaim,
  reviewClaim: mocks.reviewClaim,
}));

import { githubCommands } from '../commands/github.js';

function result(operation: 'heartbeat' | 'review' | 'complete', outcome = 'completed') {
  return {
    schema: 'openslack.claim_lifecycle.v1' as const,
    operation,
    outcome: outcome as 'completed' | 'partial',
    issueNumber: 42,
    claimRef: 'refs/heads/openslack/claims/issue-42',
    agentId: 'agent-one',
    owner: 'agent-one',
    postconditions: [{ name: 'owner_matches' as const, satisfied: outcome === 'completed' }],
    ...(outcome === 'partial'
      ? {
          errorCode: 'CLAIM_PARTIAL_STATE' as const,
          recoveryCommand:
            'openslack github claim heartbeat --issue-number 42 --agent-id agent-one --ttl-minutes 60',
        }
      : {}),
  };
}

describe('github claim lifecycle commands', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    mocks.completeClaim.mockReset();
    mocks.heartbeatClaim.mockReset();
    mocks.reviewClaim.mockReset();
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('runs a strict heartbeat and renders verified postconditions', async () => {
    mocks.heartbeatClaim.mockResolvedValue(result('heartbeat'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await githubCommands().parseAsync(
      [
        'node',
        'openslack',
        'claim',
        'heartbeat',
        '--issue-number',
        '42',
        '--agent-id',
        'agent-one',
        '--ttl-minutes',
        '60',
      ],
      { from: 'node' },
    );
    expect(mocks.heartbeatClaim).toHaveBeenCalledWith({
      issueNumber: 42,
      agentId: 'agent-one',
      ttlMinutes: 60,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PASS: claim heartbeat'));
    expect(process.exitCode).toBeUndefined();
  });

  it('sets a nonzero exit code for partial state without leaking unexpected errors', async () => {
    mocks.heartbeatClaim.mockResolvedValue(result('heartbeat', 'partial'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await githubCommands().parseAsync(
      [
        'node',
        'openslack',
        'claim',
        'heartbeat',
        '--issue-number',
        '42',
        '--agent-id',
        'agent-one',
      ],
      { from: 'node' },
    );
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('CLAIM_PARTIAL_STATE'));
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-canary');
  });

  it('keeps issue-done as a strict deprecated alias requiring owner and PR evidence', async () => {
    mocks.completeClaim.mockResolvedValue({
      ...result('complete'),
      prUrl: 'https://github.com/acme/project/pull/7',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await githubCommands().parseAsync(
      [
        'node',
        'openslack',
        'issue-done',
        '--issue-number',
        '42',
        '--agent-id',
        'agent-one',
        '--pr-url',
        'https://github.com/acme/project/pull/7',
      ],
      { from: 'node' },
    );
    expect(mocks.completeClaim).toHaveBeenCalledWith({
      issueNumber: 42,
      agentId: 'agent-one',
      prUrl: 'https://github.com/acme/project/pull/7',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deprecated'));
  });

  it('collapses unexpected command errors to a fixed non-leaking message', async () => {
    mocks.reviewClaim.mockRejectedValue(new Error('transport-secret-canary'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await githubCommands().parseAsync(
      [
        'node',
        'openslack',
        'claim',
        'review',
        '--issue-number',
        '42',
        '--agent-id',
        'agent-one',
        '--pr-url',
        'https://github.com/acme/project/pull/7',
      ],
      { from: 'node' },
    );
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'CLAIM_API_UNAVAILABLE: claim review transition failed safely.',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('transport-secret-canary');
  });
});
