import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { runGenesisValidation } from '../genesis-shell.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawnSync: vi.fn(),
}));

const spawn = vi.mocked(spawnSync);

function result(overrides: Record<string, unknown>): never {
  return {
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runGenesisValidation', () => {
  it('launches the structured invocation without a shell', () => {
    spawn.mockReturnValue(result({ status: 0 }));
    const outcome = runGenesisValidation(
      { detail: 'ok', exec: { executable: 'C:/fixture Git/bin/bash.exe', args: ['scripts/genesis-validate.sh'] } },
      { cwd: '/fixture' },
    );
    expect(outcome).toEqual({ ok: true, detail: '5/5 checks passing' });
    expect(spawn).toHaveBeenCalledWith(
      'C:/fixture Git/bin/bash.exe',
      ['scripts/genesis-validate.sh'],
      expect.objectContaining({ cwd: '/fixture', timeout: 30_000, stdio: 'pipe' }),
    );
  });

  it('reports SHELL_UNAVAILABLE when discovery found no launcher', () => {
    const outcome = runGenesisValidation(
      { detail: 'No Git Bash or WSL shell was detected for genesis validation.' },
      { cwd: '/fixture' },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('SHELL_UNAVAILABLE');
    expect(outcome.detail).toContain('No Git Bash or WSL shell');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports TOOL_MISSING when the launcher disappeared', () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    spawn.mockReturnValue(result({ error, status: null }));
    const outcome = runGenesisValidation(
      { detail: 'ok', exec: { executable: 'wsl', args: ['bash', 'scripts/genesis-validate.sh'] } },
      { cwd: '/fixture' },
    );
    expect(outcome.failure).toBe('TOOL_MISSING');
    expect(outcome.detail).toContain('wsl');
  });

  it('reports TIMEOUT rather than a script failure when the budget expires', () => {
    const error = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawn.mockReturnValue(result({ error, status: null, signal: 'SIGTERM' }));
    const outcome = runGenesisValidation(
      { detail: 'ok', exec: { executable: 'wsl', args: ['bash', 'scripts/genesis-validate.sh'] } },
      { cwd: '/fixture' },
    );
    expect(outcome.failure).toBe('TIMEOUT');
    expect(outcome.detail).toContain('30000ms');
  });

  it('reports TIMEOUT when the launcher is killed by a signal', () => {
    spawn.mockReturnValue(result({ status: null, signal: 'SIGKILL' }));
    const outcome = runGenesisValidation(
      { detail: 'ok', exec: { executable: 'wsl', args: ['bash', 'scripts/genesis-validate.sh'] } },
      { cwd: '/fixture' },
    );
    expect(outcome.failure).toBe('TIMEOUT');
    expect(outcome.detail).toContain('SIGKILL');
  });

  it('reports SCRIPT_FAILED with a bounded diagnostic on a non-zero exit', () => {
    spawn.mockReturnValue(result({ status: 1, stderr: '[3/5] constitution.md ... FAIL\n' }));
    const outcome = runGenesisValidation(
      { detail: 'ok', exec: { executable: 'bash', args: ['scripts/genesis-validate.sh'] } },
      { cwd: '/fixture' },
    );
    expect(outcome.failure).toBe('SCRIPT_FAILED');
    expect(outcome.detail).toContain('status 1');
    expect(outcome.detail).toContain('constitution.md');
  });

  it('keeps the existing budget and honours an explicit override', () => {
    spawn.mockReturnValue(result({ status: 0 }));
    runGenesisValidation(
      { detail: 'ok', exec: { executable: 'bash', args: ['scripts/genesis-validate.sh'] } },
      { cwd: '/fixture', timeoutMs: 5_000 },
    );
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      ['scripts/genesis-validate.sh'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });
});
