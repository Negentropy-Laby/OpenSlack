import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryCommands } from '../commands/delivery.js';

const roots: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('delivery probe commands', () => {
  it('runs read-only selected-repository diagnostics', async () => {
    const root = repository();
    const previous = process.cwd();
    const diagnose = vi.fn(async () => ({
      state: 'READY_FOR_PROBE' as const,
      repositoryAccess: {
        accessible: true as const,
        totalAccessibleRepositories: 1,
        pagesScanned: 1,
      },
      permissions: [
        {
          capability: 'contents' as const,
          required: 'write' as const,
          actual: 'write',
          status: 'PASS' as const,
        },
        {
          capability: 'pull_requests' as const,
          required: 'write' as const,
          actual: 'write',
          status: 'PASS' as const,
        },
      ],
      evidenceTimestamp: '2026-07-11T00:00:00.000Z',
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(root);
      await deliveryCommands({ diagnose }).parseAsync(
        ['node', 'openslack', 'doctor', '--repo', 'acme/repo'],
        { from: 'node' },
      );
      expect(diagnose).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'acme', repo: 'repo', rootDir: root }),
      );
    } finally {
      process.chdir(previous);
    }
  });

  it('previews without mutation and applies through the package probe', async () => {
    const root = repository();
    const previous = process.cwd();
    const probe = vi.fn(async () => ({
      state: 'PROBE_CLEANED' as const,
      probeRef: 'openslack/probes/write-12345678',
      branchSha: 'a'.repeat(40),
      remoteSha: 'a'.repeat(40),
      repositoryAccess: {
        accessible: true as const,
        totalAccessibleRepositories: 1,
        pagesScanned: 1,
      },
      permissions: [
        {
          capability: 'contents' as const,
          required: 'write' as const,
          actual: 'write',
          status: 'PASS' as const,
        },
        {
          capability: 'pull_requests' as const,
          required: 'write' as const,
          actual: 'write',
          status: 'PASS' as const,
        },
      ],
      cleanup: 'PASS' as const,
      evidenceTimestamp: '2026-07-11T00:00:00.000Z',
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(root);
      const args = ['node', 'openslack', 'probe', '--repo', 'acme/repo'];
      await deliveryCommands({ probe }).parseAsync(args, { from: 'node' });
      expect(probe).not.toHaveBeenCalled();
      await deliveryCommands({ probe }).parseAsync([...args, '--apply'], { from: 'node' });
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'acme', repo: 'repo', rootDir: root }),
      );
    } finally {
      process.chdir(previous);
    }
  });

  it('keeps stranded-ref cleanup preview-first', async () => {
    const root = repository();
    const previous = process.cwd();
    const cleanupRef = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(root);
      const args = [
        'node',
        'openslack',
        'cleanup-ref',
        '--repo',
        'acme/repo',
        '--branch',
        'openslack/probes/write-12345678',
      ];
      await deliveryCommands({ cleanupRef }).parseAsync(args, { from: 'node' });
      expect(cleanupRef).not.toHaveBeenCalled();
      await deliveryCommands({ cleanupRef }).parseAsync([...args, '--apply'], { from: 'node' });
      expect(cleanupRef).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'openslack/probes/write-12345678' }),
      );
    } finally {
      process.chdir(previous);
    }
  });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-delivery-probe-cli-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}
