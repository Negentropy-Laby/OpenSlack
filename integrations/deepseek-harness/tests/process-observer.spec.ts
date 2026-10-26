import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isCleanExit, OwnedProcessObservation } from '../src/process-observer.ts';

describe('public Node owned-process evidence', () => {
  it('observes the exact actual child and rejects using an absent observation', async () => {
    const missing = new OwnedProcessObservation(process.execPath, ['-e', 'unused']);
    onTestFinished(() => missing.dispose());
    expect(() => missing.assertCaptured()).toThrow('unavailable');
    const args = ['-e', 'process.exitCode=0'];
    const observed = new OwnedProcessObservation(process.execPath, args);
    onTestFinished(() => observed.dispose());
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH }, stdio: 'ignore' });
    await once(child, 'spawn');
    observed.assertCaptured(child.pid);
    const receipt = await observed.waitForClose(5_000);
    expect(receipt.pid).toBe(child.pid);
    expect(isCleanExit(receipt)).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('rejects SIGTERM handled as exit zero rather than reporting clean shutdown', async () => {
    const args = ['-e', 'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready");setInterval(()=>{},1000)'];
    const observed = new OwnedProcessObservation(process.execPath, args);
    onTestFinished(() => observed.dispose());
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
    child.kill('SIGTERM');
    const receipt = await observed.waitForClose(5_000);
    expect(receipt.code).toBe(0);
    expect(receipt.signal).toBeNull();
    expect(receipt.terminationRequested).toBe(true);
    expect(isCleanExit(receipt)).toBe(false);
  });
  it('rejects a forced stop and does not confuse a signal request with actual exit', async () => {
    const args = ['-e', 'setInterval(()=>{},1000)'];
    const observed = new OwnedProcessObservation(process.execPath, args);
    onTestFinished(() => observed.dispose());
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH }, stdio: 'ignore' });
    await once(child, 'spawn');
    child.kill('SIGKILL');
    const receipt = await observed.waitForClose(5_000);
    expect(isCleanExit(receipt)).toBe(false);
  });
});
