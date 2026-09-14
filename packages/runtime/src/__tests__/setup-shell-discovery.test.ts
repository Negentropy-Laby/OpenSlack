import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { bashCandidates, probeBash } from '@openslack/core';
import { detectGenesisShell } from '../setup-report.js';
vi.mock('@openslack/core', async (original) => ({
  ...(await original<object>()),
  bashCandidates: vi.fn(() => []),
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
});
describe('setup shell discovery policy', () => {
  it('keeps the WSL fallback on Windows and probes native Bash once on POSIX', () => {
    const result = detectGenesisShell('/fixture');
    expect(result.status).toBe('ok');
    if (process.platform === 'win32') {
      expect(result.command).toBe('wsl bash scripts/genesis-validate.sh');
      expect(execFileSync).toHaveBeenCalledWith('wsl', ['--status'], expect.any(Object));
    } else {
      expect(result.command).toBe('bash scripts/genesis-validate.sh');
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
      expect(execFileSync).not.toHaveBeenCalled();
    } else expect(result.command).toBe('bash scripts/genesis-validate.sh');
  });
});
