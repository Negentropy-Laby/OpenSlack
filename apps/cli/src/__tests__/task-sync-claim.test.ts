import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proposeWorkspacePR: vi.fn(),
  resolveAgentPrincipal: vi.fn(),
  reviewClaim: vi.fn(),
}));

vi.mock('@openslack/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openslack/runtime')>()),
  proposeWorkspacePR: mocks.proposeWorkspacePR,
  resolveAgentPrincipal: mocks.resolveAgentPrincipal,
}));

vi.mock('@openslack/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openslack/github')>()),
  reviewClaim: mocks.reviewClaim,
}));

import { taskCommands } from '../commands/task.js';

describe('task sync claim handoff', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    mocks.proposeWorkspacePR.mockReset();
    mocks.resolveAgentPrincipal.mockReset();
    mocks.reviewClaim.mockReset();
    mocks.resolveAgentPrincipal.mockReturnValue({
      principal: {
        registry_id: 'agent-one',
        runtime_uid: 'agt_agent-one',
        run_id: 'RUN-42',
        provider: 'cli',
      },
      snapshot: { permissions: {} },
    });
    mocks.proposeWorkspacePR.mockResolvedValue({
      success: true,
      prBody: '<!-- openslack-task-link -->',
      branchName: 'agent/agent-one/TASK-42/RUN-42',
      riskZone: 'yellow',
      errors: [],
      prUrl: 'https://github.com/acme/project/pull/7',
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('passes issue identity into publication and reports a recoverable partial transition', async () => {
    mocks.reviewClaim.mockResolvedValue({
      schema: 'openslack.claim_lifecycle.v1',
      operation: 'review',
      outcome: 'partial',
      issueNumber: 42,
      claimRef: 'refs/heads/openslack/claims/issue-42',
      agentId: 'agent-one',
      owner: 'agent-one',
      prUrl: 'https://github.com/acme/project/pull/7',
      postconditions: [
        { name: 'review_label_present', satisfied: true },
        { name: 'pr_link_present', satisfied: false },
      ],
      errorCode: 'CLAIM_PARTIAL_STATE',
      recoveryCommand:
        'openslack github claim review --issue-number 42 --agent-id agent-one --pr-url https://github.com/acme/project/pull/7',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taskCommands().parseAsync(
      [
        'node',
        'openslack',
        'sync',
        '--agent-id',
        'agent-one',
        '--task-id',
        'TASK-42',
        '--run-id',
        'RUN-42',
        '--paths',
        'src/greeting.txt',
        '--issue-number',
        '42',
      ],
      { from: 'node' },
    );

    expect(mocks.proposeWorkspacePR).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 42, agentId: 'agent-one' }),
    );
    expect(mocks.reviewClaim).toHaveBeenCalledWith({
      issueNumber: 42,
      agentId: 'agent-one',
      prUrl: 'https://github.com/acme/project/pull/7',
    });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('publication succeeded'));
    expect(error).toHaveBeenCalledWith(
      'Recovery: openslack github claim review --issue-number 42 --agent-id agent-one --pr-url https://github.com/acme/project/pull/7',
    );
    expect(mocks.proposeWorkspacePR).toHaveBeenCalledTimes(1);
  });
});
