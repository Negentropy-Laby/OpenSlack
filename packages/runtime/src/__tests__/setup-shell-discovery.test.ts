import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { bashCandidates, executableCandidates, probeBash } from '@openslack/core';
import { detectGenesisShell } from '../setup-report.js';
vi.mock('@openslack/core', async (original) => ({
  ...(await original<object>()),
  bashCandidates: vi.fn(() => []),
  executableCandidates: vi.fn(() => []),
  probeBash: vi.fn(() => false),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<object>()),
  existsSync: vi.fn(() => true),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  execFileSync: vi.fn(() => ''),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bashCandidates).mockReturnValue([]);
  vi.mocked(executableCandidates).mockReturnValue([]);
});
describe('setup shell discovery policy', () => {
  it('keeps the WSL fallback on Windows and probes native Bash once on POSIX', () => {
    const result = detectGenesisShell('/fixture');
    expect(result.status).toBe('ok');
    if (process.platform === 'win32') {
      expect(result.command).toBe('wsl bash scripts/genesis-validate.sh');
      expect(result.exec).toEqual({ executable: 'wsl', args: ['bash', 'scripts/genesis-validate.sh'] });
      expect(execFileSync).toHaveBeenCalledWith('wsl', ['--status'], expect.any(Object));
    } else {
      expect(result.command).toBe('bash scripts/genesis-validate.sh');
      expect(result.exec).toEqual({ executable: 'bash', args: ['scripts/genesis-validate.sh'] });
      expect(execFileSync).toHaveBeenCalledOnce();
    }
  });
  it('prefers a verified discovered Git Bash over fallback when Windows supports it', () => {
    vi.mocked(bashCandidates).mockReturnValue(['C:/fixture Git/bin/bash.exe']);
    vi.mocked(probeBash).mockReturnValue(true);
    const result = detectGenesisShell('/fixture');
    expect(result.status).toBe('ok');
    if (process.platform === 'win32') {
      expect(result.command).toContain('C:/fixture Git/bin/bash.exe');
      // The structured invocation keeps a space-bearing executable path as one
      // argv element instead of a command string a shell would re-split.
      expect(result.exec).toEqual({
        executable: 'C:/fixture Git/bin/bash.exe',
        args: ['scripts/genesis-validate.sh'],
      });
      expect(execFileSync).not.toHaveBeenCalled();
    } else expect(result.command).toBe('bash scripts/genesis-validate.sh');
  });
  it('resolves an absolute launcher so a polluted PATH cannot substitute one', () => {
    if (process.platform !== 'win32') return;
    vi.mocked(executableCandidates).mockReturnValue(['C:/fixture/wsl.exe']);
    const result = detectGenesisShell('/fixture');
    expect(result.exec?.executable).toBe('C:/fixture/wsl.exe');
    expect(result.command).toBe('wsl bash scripts/genesis-validate.sh');
    expect(execFileSync).toHaveBeenCalledWith('C:/fixture/wsl.exe', ['--status'], expect.any(Object));
  });
});
