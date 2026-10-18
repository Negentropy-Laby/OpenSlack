import { closeSync, openSync, readSync } from 'node:fs';
import type { CleanupFixtureCall } from './cleanup-executor-http.js';

export function readCleanupFixtureLog(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (n === 0) break;
      count += n;
    }
    return {
      calls: buffer
        .subarray(0, Math.min(count, 64 * 1024))
        .toString('utf8')
        .split('\n'),
      logStatus: count > 64 * 1024 ? 'FIXTURE_LOG_TRUNCATED' : 'OK',
    };
  } catch {
    return { calls: [], logStatus: 'FIXTURE_LOG_UNAVAILABLE' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function cleanupFixtureHttpCalls(calls: readonly string[]): CleanupFixtureCall[] {
  return calls.filter((line) => line.startsWith('http:')).map((line) => JSON.parse(line.slice(5)));
}

export function cleanupFixtureFailure(
  directory: string,
  outcome: ReturnType<typeof readCleanupFixtureLog>,
  stderr: string,
) {
  // Only the child adapter's closed diagnostic projection is printed, never raw HTTP errors.
  return JSON.stringify({ directory, ...outcome, stderr });
}
