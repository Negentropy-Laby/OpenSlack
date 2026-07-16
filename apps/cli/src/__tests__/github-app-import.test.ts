import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialStore, MemoryKeychainBackend } from '@openslack/credentials';
import { githubCommands } from '../commands/github.js';

describe('github app import command', () => {
  it('previews without reading and applies fake secret bytes only to an injected keychain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-cli-app-import-'));
    const source = join(root, 'fixture.pem');
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.cwd();
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      writeFileSync(
        join(root, 'openslack.yaml'),
        'schema: openslack.workspace.v1\nworkspace:\n  state_root: .openslack\n',
        'utf-8',
      );
      process.chdir(root);
      const args = [
        'node',
        'openslack',
        'app',
        'import',
        '--source',
        source,
        '--app-id',
        '123',
        '--installation-id',
        '456',
        '--slug',
        'acme-agent',
        '--key-ref',
        'keychain:openslack/acme-agent',
      ];
      await githubCommands({ credentialStore: store }).parseAsync(args, { from: 'node' });
      expect(log).toHaveBeenCalledWith(
        'No credential was read or written. Re-run with --apply after reviewing.',
      );

      writeFileSync(
        source,
        '-----BEGIN PRIVATE KEY-----\ncanary-secret\n-----END PRIVATE KEY-----',
        'utf-8',
      );
      await githubCommands({ credentialStore: store }).parseAsync([...args, '--apply'], {
        from: 'node',
      });
      const config = readFileSync(join(root, '.openslack.local', 'github-app.json'), 'utf-8');
      expect(config).toContain('keychain:openslack/acme-agent');
      expect(config).not.toContain('canary-secret');
    } finally {
      process.chdir(previous);
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('github metrics command', () => {
  it('emits only the bounded ready-query count and fixed explanatory prose', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await githubCommands({
        getMetricsClient: async () => ({ isDryRun: false }),
        queryReadyMetrics: async () => [{}, {}, {}],
      }).parseAsync(['node', 'openslack', 'metrics'], { from: 'node' });

      expect(log.mock.calls).toEqual([
        ['Ready: 3'],
        ['(Full metrics: claimed/running/review/done counts require label-based search.)'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('does not query task data in dry-run mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const queryReadyMetrics = vi.fn(async () => [{ sensitive: 'not-read' }]);
    try {
      await githubCommands({
        getMetricsClient: async () => ({ isDryRun: true }),
        queryReadyMetrics,
      }).parseAsync(['node', 'openslack', 'metrics'], { from: 'node' });

      expect(queryReadyMetrics).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith('[DRY RUN] Would compute metrics');
    } finally {
      log.mockRestore();
    }
  });

  it('redacts dependency errors and reports a failed exit status', async () => {
    const sentinel = 'credential=/private/sentinel.key token=secret-value';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await githubCommands({
        getMetricsClient: async () => {
          throw new Error(sentinel);
        },
      }).parseAsync(['node', 'openslack', 'metrics'], { from: 'node' });

      expect(error).toHaveBeenCalledExactlyOnceWith(
        'Metrics failed: task-loop metrics are unavailable.',
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain(sentinel);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
