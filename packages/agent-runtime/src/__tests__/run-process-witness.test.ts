import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { execFileSync } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { ownRunWriterWitness, observeRunWriter } from '../run-process-witness.js';

vi.mock('node:fs', async load => {
  const fs = await load<typeof FsModule>(); return { ...fs, readFileSync: vi.fn(fs.readFileSync), statSync: vi.fn(fs.statSync) };
});
vi.mock('node:child_process', async load => {
  const value = await load<typeof ChildProcessModule>(); return { ...value, execFileSync: vi.fn(value.execFileSync) };
});
const read = vi.mocked(readFileSync), stat = vi.mocked(statSync);
const originalRead = read.getMockImplementation()!, originalStat = stat.getMockImplementation()!;
const execute = vi.mocked(execFileSync), originalExecute = execute.getMockImplementation()!;
afterEach(() => { read.mockReset().mockImplementation(originalRead); stat.mockReset().mockImplementation(originalStat);
  execute.mockReset().mockImplementation(originalExecute); vi.restoreAllMocks(); });

describe('read-only same-scope writer birth evidence', () => {
  it('never treats missing or malformed birth evidence as a stopped process', () => {
    expect(observeRunWriter(undefined)).toBe('unavailable');
    expect(observeRunWriter({ platform: 'linux', boot: 'unknown', namespace: 'unknown', uid: '0', pid: -1, birth: '1' })).toBe('unavailable');
  });
  it.runIf(process.platform === 'linux' || process.platform === 'win32')('observes its actual OS witness alive, not merely the numeric PID', () => {
    const witness = ownRunWriterWitness();
    expect(witness).toBeDefined();
    expect(observeRunWriter(witness)).toBe('alive');
  });
  it.runIf(process.platform === 'linux').each(['uid', 'boot', 'namespace'] as const)('refuses a different %s scope without classifying it exited', field => {
    const witness = ownRunWriterWitness()!;
    expect(witness.platform).toBe('linux');
    expect(observeRunWriter({ ...witness, [field]: 'different-scope' })).toBe('unavailable');
  });
  it.runIf(process.platform === 'linux')('distinguishes PID reuse from the original writer using the kernel birth field', () => {
    const witness = ownRunWriterWitness()!;
    expect(witness.platform).toBe('linux');
    read.mockImplementation((...args: Parameters<typeof readFileSync>) => {
      const value = originalRead(...args);
      if (String(args[0]) !== `/proc/${process.pid}/stat`) return value;
      const text = String(value), end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
      fields[19] = String(BigInt(fields[19]!) + 1n);
      return `${text.slice(0, end + 2)}${fields.join(' ')}`;
    });
    expect(observeRunWriter(witness)).toBe('exited');
  });
  it.runIf(process.platform === 'linux').each(['EPERM', 'ENOENT'] as const)('does not turn %s or hidden procfs visibility into death evidence', code => {
    const witness = ownRunWriterWitness()!;
    stat.mockImplementation((...args: Parameters<typeof statSync>) => {
      if (String(args[0]) === `/proc/${process.pid}/stat`) throw Object.assign(new Error('fixture OS read denied'), { code });
      return originalStat(...args);
    });
    read.mockImplementation((...args: Parameters<typeof readFileSync>) => {
      if (String(args[0]) === `/proc/${process.pid}/stat`) throw Object.assign(new Error('fixture OS read denied'), { code });
      return originalRead(...args);
    });
    expect(observeRunWriter(witness)).toBe('unavailable');
  });
  it.runIf(process.platform === 'win32').each(['reused-birth', 'different-host', 'different-boot', 'permission-denied', 'malformed', 'hidden-live', 'absent-esrch'] as const)(
    'keeps the Windows CIM %s branch separate from PID-only guesses', kind => {
      const witness = ownRunWriterWitness()!;
      if (witness.platform !== 'win32') throw new Error('An actual native Windows own witness is required');
      execute.mockClear(); // The isolated -t case may have just collected its real own witness.
      execute.mockImplementation(() => {
        if (kind === 'permission-denied') throw Object.assign(new Error('fixture OS denied'), { code: 'EACCES' });
        if (kind === 'malformed') return Buffer.from('{invalid');
        return Buffer.from(JSON.stringify({ host: kind === 'different-host' ? 'other-host' : witness.host,
          boot: kind === 'different-boot' ? '2000-01-01T00:00:00Z' : witness.boot,
          birth: kind === 'hidden-live' || kind === 'absent-esrch' ? null : kind === 'reused-birth' ? '2000-01-01T00:00:00Z' : witness.birth }));
      });
      if (kind === 'hidden-live') vi.spyOn(process, 'kill').mockReturnValue(true);
      if (kind === 'absent-esrch') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('fixture absent'), { code: 'ESRCH' }); });
      expect(observeRunWriter(witness)).toBe(['reused-birth', 'absent-esrch'].includes(kind) ? 'exited' : 'unavailable');
      // Outside observeRunWriter's catch-all: an assertion here cannot be
      // mistaken for an unavailable OS observation and make a negative case green.
      expect(execute).toHaveBeenCalledOnce();
      const [command, argv] = execute.mock.calls[0]!;
      expect(String(command)).toMatch(/powershell\.exe$/i);
      const script = (argv as readonly string[]).at(-1)!;
      expect(script).toContain(`SELECT ProcessId,CreationDate FROM Win32_Process WHERE ProcessId=${witness.pid}`);
      expect(script).not.toContain('CommandLine');
      if (kind === 'hidden-live' || kind === 'absent-esrch') expect(process.kill).toHaveBeenCalledExactlyOnceWith(witness.pid, 0);
    });
});
