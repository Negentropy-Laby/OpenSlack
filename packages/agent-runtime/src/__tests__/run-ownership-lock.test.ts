import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunTransactionLock, isRunPreAcquisitionContention } from '../run-ownership.js';
import { waitForRunObservation } from '../run-wait.js';

vi.mock('node:fs', async original => { const fs = await original<typeof Fs>(); return { ...fs, openSync: vi.fn(fs.openSync) }; });
const open = vi.mocked(openSync), nativeOpen = open.getMockImplementation()!;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); open.mockReset().mockImplementation(nativeOpen); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'run-lock-open-')); roots.push(root); return join(root, 'run.transaction.lock'); }

describe('bounded pre-acquisition run lock contention', () => {
  it.each(['EPERM', 'EBUSY'])('asynchronously waits through one Windows %s without publishing or skipping directory checks', async code => {
    const path = fixture(), verify = vi.fn();
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    open.mockImplementationOnce(() => { throw Object.assign(new Error('Fixture lock contention'), { code }); });
    const fd = await waitForRunObservation(() => acquireRunTransactionLock(path, verify, 'win32'), isRunPreAcquisitionContention);
    try {
      expect(open).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(wait).not.toHaveBeenCalled();
    } finally { closeSync(fd); }
  });
  it('preserves a persistent Windows permission error without synchronously waiting', () => {
    const path = fixture(), denied = Object.assign(new Error('Fixture permission failure'), { code: 'EPERM' });
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    open.mockImplementation(() => { throw denied; });
    expect(() => acquireRunTransactionLock(path, () => {}, 'win32')).toThrow(denied);
    expect(open).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
  it('does not reinterpret Linux permission failures as contention', () => {
    const path = fixture(), denied = Object.assign(new Error('Fixture permission failure'), { code: 'EPERM' });
    const wait = vi.spyOn(Atomics, 'wait'); open.mockImplementation(() => { throw denied; });
    expect(() => acquireRunTransactionLock(path, () => {}, 'linux')).toThrow(denied);
    expect(open).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
  });
  it('rejects directory drift before acquiring a descriptor', () => {
    const path = fixture(), drift = new Error('Fixture directory changed');
    expect(() => acquireRunTransactionLock(path, () => { throw drift; }, 'win32')).toThrow(drift);
    expect(open).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
  });
  it('returns the EEXIST busy outcome immediately without touching the incumbent', () => {
    const path = fixture();
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    open.mockImplementation(() => { throw Object.assign(new Error('Fixture existing lock'), { code: 'EEXIST' }); });
    expect(() => acquireRunTransactionLock(path, () => {}, 'win32')).toThrow(expect.objectContaining({ code: 'RUN_STATE_BUSY' }));
    expect(open).toHaveBeenCalledOnce();
  });
  it('never retries an unclassified open error', () => {
    const path = fixture(), failed = Object.assign(new Error('Fixture I/O failure'), { code: 'EIO' });
    open.mockImplementation(() => { throw failed; });
    expect(() => acquireRunTransactionLock(path, () => {}, 'win32')).toThrow(failed);
    expect(open).toHaveBeenCalledOnce(); expect(existsSync(path)).toBe(false);
  });
});
