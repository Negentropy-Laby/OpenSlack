import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCommands } from '../commands/agent.js';

const tickAgent = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  tickAgent.mockResolvedValue({
    agentId: 'test-agent',
    action: 'claimed',
    taskId: '#42',
    leaseId: 'refs/heads/openslack/claims/issue-42',
    message: 'claimed',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function run(args: string[]) {
  await agentCommands({ tickAgent }).parseAsync(['node', 'openslack', ...args]);
}

describe('agent tick --issue-number', () => {
  it('passes one validated target to the runtime', async () => {
    await run([
      'tick',
      '--agent-id',
      'test-agent',
      '--source',
      'github-issues',
      '--issue-number',
      '42',
    ]);

    expect(tickAgent).toHaveBeenCalledWith('test-agent', {
      source: 'github-issues',
      issueNumber: 42,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['0', '-1', '4.2', '1e3', '9007199254740992', 'not-a-number'])(
    'rejects invalid issue number %s',
    async (value) => {
      await run([
        'tick',
        '--agent-id',
        'test-agent',
        '--source',
        'github-issues',
        '--issue-number',
        value,
      ]);
      expect(tickAgent).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );

  it('rejects a target with the local source before invoking the runtime', async () => {
    await run(['tick', '--agent-id', 'test-agent', '--issue-number', '42']);
    expect(tickAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('keeps an unscoped GitHub tick compatible', async () => {
    await run(['tick', '--agent-id', 'test-agent', '--source', 'github-issues']);
    expect(tickAgent).toHaveBeenCalledWith('test-agent', {
      source: 'github-issues',
      issueNumber: undefined,
    });
  });

  it('returns exit code one for a targeted runtime failure', async () => {
    tickAgent.mockResolvedValueOnce({
      agentId: 'test-agent',
      action: 'error',
      message: 'TARGET_ISSUE_NOT_CLAIMABLE: issue #42: ALREADY_CLAIMED',
    });
    await run([
      'tick',
      '--agent-id',
      'test-agent',
      '--source',
      'github-issues',
      '--issue-number',
      '42',
    ]);
    expect(process.exitCode).toBe(1);
  });
});
