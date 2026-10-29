import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { describe, expect, it, vi, onTestFinished } from 'vitest';

const helper = fileURLToPath(new URL('../dist/openslack-harness-supervisor.exe', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/supervisor-child.mjs', import.meta.url));

describe('private native Windows Job owner', () => {
  it.runIf(process.platform === 'win32')('closes its noninherited Job on helper termination and kills all three generations without a receipt', async () => {
    const child = spawn(helper, ['--run-id', 'RUN-JOB-CRASH', '--generation', 'owner-crash', '--cleanup-ms', '3000', '--',
      process.execPath, fixture, 'crash-tree'], { stdio: 'pipe', env: { PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
    child.stderr.resume(); child.stdin.on('error', () => {});
    onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const records: Array<Record<string, unknown>> = [];
    let childBytes = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { const row = JSON.parse(line); records.push(row);
      if (row.kind === 'bridge-bytes') childBytes += Buffer.from(row.data, 'base64').toString('utf8'); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await vi.waitFor(() => expect([...childBytes.matchAll(/"fixturePid":(\d+)/g)]).toHaveLength(3));
    const pids = [...childBytes.matchAll(/"fixturePid":(\d+)/g)].map(match => Number(match[1]));
    child.kill('SIGKILL');
    expect(await exited).not.toBe(0);
    expect(records.some(row => row.kind === 'exit-receipt')).toBe(false);
    await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); });
  }, 10_000);
  it.runIf(process.platform === 'win32').each(['normal', 'tree', 'forge', 'flood', 'root-exit', 'force', 'blocked-input', 'tail'])(
    '%s records actual root, descendants and drained pipes without trusting child JSON', async mode => {
      const child = spawn(helper, ['--run-id', 'RUN-JOB-TEST', '--generation', 'owner-test', '--cleanup-ms', '3000', '--',
        process.execPath, fixture, mode], { stdio: 'pipe', env: { PATH: process.env.PATH ?? '',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
      const records: Array<Record<string, unknown>> = [];
      onTestFinished(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let childBytes = '';
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        const row = JSON.parse(line) as Record<string, unknown>;
        records.push(row);
        expect(row.protocol).toBe('openslack.windows_job.v1');
        expect(row.runId).toBe('RUN-JOB-TEST');
        expect(row.generation).toBe('owner-test');
        if (row.kind === 'bridge-bytes') {
          const bytes = Buffer.from(String(row.data), 'base64');
          expect(bytes.length).toBeLessThanOrEqual(65_536);
          expect(bytes.toString('base64')).toBe(row.data);
          childBytes += bytes.toString('utf8');
        }
        if (row.kind === 'spawned') {
          if (mode === 'blocked-input' || mode === 'tail') child.stdin.write(Buffer.alloc(2 * 1024 * 1024, 65));
          setTimeout(() => child.stdin.end(), 300);
        }
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      const forced = mode === 'root-exit' || mode === 'force' || mode === 'blocked-input';
      expect(code, JSON.stringify({ records, childBytes })).toBe(forced ? 1 : 0);
      expect(records.filter(row => row.kind === 'spawned')).toHaveLength(1);
      const receipts = records.filter(row => row.kind === 'exit-receipt');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ jobEmpty: true, streamsDrained: true,
        terminationRequested: forced, graceful: !forced, timedOut: forced });
      expect(receipts[0]!.pid).toBe(records[0]!.pid);
      if (!forced) expect(receipts[0]!.rootExitCode).toBe(0);
      if (mode === 'forge') expect(childBytes).toContain('"kind":"exit-receipt"');
      if (mode === 'tail') expect(childBytes).toContain('"receivedBytes":2097152');
      const pids = [...childBytes.matchAll(/"fixturePid":(\d+)/g)].map(match => Number(match[1]));
      expect(pids.length).toBeGreaterThanOrEqual(mode === 'tree' || mode === 'root-exit' ? 3 : 1);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    }, 15_000,
  );
});
