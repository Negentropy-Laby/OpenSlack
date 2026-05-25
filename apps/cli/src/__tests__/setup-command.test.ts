import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupCommands } from '../commands/setup.js';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn((command: string) => {
    if (command.includes('github doctor')) {
      const err = new Error('GitHub doctor failed') as Error & { stderr?: Buffer };
      err.stderr = Buffer.from('Dry-run (no credentials)');
      throw err;
    }
    return Buffer.from('PASS');
  }),
}));

vi.mock('@openslack/runtime', () => ({
  detectGenesisShell: vi.fn(() => ({
    status: 'ok',
    category: 'ok',
    title: 'Genesis validation shell',
    detail: 'Git Bash detected',
    command: 'git-bash scripts/genesis-validate.sh',
  })),
  buildSetupReport: vi.fn(),
  renderSetupReport: vi.fn(() => 'setup report'),
}));

vi.mock('@openslack/collaboration', () => ({
  recordEvent: vi.fn(),
}));

function runSetupCommand(args: string[]): number {
  const command = setupCommands();
  const originalArgv = process.argv;
  process.argv = ['node', 'openslack', 'setup', ...args];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`EXIT:${code ?? 0}`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});

  try {
    command.parse(['node', 'openslack setup', ...args], { from: 'node' });
    return 0;
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('EXIT:')) return Number(message.slice('EXIT:'.length));
    throw err;
  } finally {
    exitSpy.mockRestore();
    process.argv = originalArgv;
  }
}

describe('setup command strict mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats GitHub doctor warnings as non-blocking by default and blocking in strict mode', () => {
    expect(runSetupCommand(['smoke'])).toBe(0);
    expect(runSetupCommand(['smoke', '--strict'])).toBe(1);
    expect(runSetupCommand(['run', '--strict'])).toBe(1);
    expect(vi.mocked(execSync)).toHaveBeenCalled();
  });
});
