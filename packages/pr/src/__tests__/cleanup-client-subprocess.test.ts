import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLEANUP_OPERATION_RECORD_SCHEMA,
  saveCleanupOperationRecord,
  type CleanupOperationQueryRecord,
  type CleanupOperationRequest,
} from '../cleanup-operation-record.js';
import { cleanupBrokerExecutionDigest } from '../internal/cleanup-broker-digest.js';
import { snapshotAllowingOutbox } from './helpers/cleanup-record-snapshot.js';

/**
 * Real subprocess tests for the shipped Broker-only client.
 *
 * The client is bundled exactly as the package build does, then executed with
 * Node as a separate process. These cover the refusal surface, which is
 * platform-independent; the execute path itself additionally requires Linux and
 * is covered by the package build on that host.
 */
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const clientSource = join(repositoryRoot, 'scripts', 'cleanup-broker', 'client.ts');

const roots: string[] = [];
let bundlePath = '';
let bundleBytes = '';

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Run the bundled client and capture its exit code and output. */
function runClient(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bundlePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

beforeAll(() => {
  const out = temporaryRoot('cleanup-client-bundle-');
  bundlePath = join(out, 'client.mjs');
  // Bundle with Bun (the repository toolchain) but execute with Node, matching
  // the shipped artifact's target. `process.execPath` is Node under Vitest.
  execFileSync(
    'bun',
    ['build', clientSource, '--target=node', '--format=esm', '--outfile', bundlePath],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  bundleBytes = readFileSync(bundlePath, 'utf8');
});

afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(): CleanupOperationQueryRecord {
  const request: CleanupOperationRequest = {
    schema: 'openslack.cleanup_request.v1',
    mode: 'execute',
    agentId: 'worker',
    principalId: 'custom:worker',
    runtimeUid: 'uid',
    runId: 'RUN-1',
    repo: 'owner/repo',
    remote: 'origin',
    prNumber: 417,
    permitId: 'PERMIT-1',
    operationId: 'OP-1',
  };
  return {
    schema: CLEANUP_OPERATION_RECORD_SCHEMA,
    createdAt: '2026-09-21T00:00:00.000Z',
    request,
    requestDigest: cleanupBrokerExecutionDigest(request),
  };
}

describe('bundled client subprocess', () => {
  it('bundles without any process-execution capability', () => {
    // The client must not be able to shell out to Git on its own.
    expect(bundleBytes).not.toContain('child_process');
    expect(bundleBytes).not.toContain('execFileSync');
    expect(bundleBytes).not.toContain('simple-git');
  });

  it('requires an explicit workspace', () => {
    const result = runClient([
      '--mode',
      'execute',
      '--agent-id',
      'worker',
      '--repo',
      'owner/repo',
      '--remote',
      'origin',
      '--pr',
      '417',
      '--permit-id',
      'PERMIT-1',
      '--operation-id',
      'OP-1',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--workspace is required');
  });

  it('refuses a record outside status mode', () => {
    const result = runClient(['--mode', 'execute', '--operation-record', '/tmp/whatever.json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--operation-record is only valid with --mode status');
  });

  it('refuses an explicit binding that conflicts with the record', () => {
    const root = temporaryRoot('cleanup-client-record-');
    const saved = saveCleanupOperationRecord(record(), {
      rootDir: root,
      snapshot: snapshotAllowingOutbox(),
    });

    const result = runClient([
      '--mode',
      'status',
      '--operation-record',
      saved.path,
      '--repo',
      'other/repo',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--operation-record conflicts with --repo');
  });

  it('queries the broker from a record instead of only printing it', () => {
    const root = temporaryRoot('cleanup-client-query-');
    const saved = saveCleanupOperationRecord(record(), {
      rootDir: root,
      snapshot: snapshotAllowingOutbox(),
    });

    const result = runClient(['--mode', 'status', '--operation-record', saved.path]);
    // The record is printed, and the client then attempts the broker query: on
    // a non-Linux host the production client refuses the platform rather than
    // silently reporting the record as a result.
    expect(result.stdout).toContain('"operationId": "OP-1"');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/UNSUPPORTED_PLATFORM|BROKER_UNAVAILABLE/);
  });

  it('rejects an unknown argument', () => {
    const result = runClient(['--mode', 'status', '--bogus', 'x']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unexpected or repeated argument');
  });
});

// Keep a written copy so a failing run leaves inspectable evidence.
it('leaves the bundle readable for inspection', () => {
  const dir = temporaryRoot('cleanup-client-copy-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'client.mjs'), bundleBytes);
  expect(readFileSync(join(dir, 'client.mjs'), 'utf8')).toBe(bundleBytes);
});
