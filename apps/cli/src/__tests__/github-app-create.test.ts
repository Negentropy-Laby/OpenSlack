import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { githubCommands } from '../commands/github.js';

describe('github app create command', () => {
  it('previews without starting a server and starts only with --apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-cli-app-create-'));
    const start = vi.fn(async () => ({
      status: 'completed' as const,
      appId: '123',
      appSlug: 'openslack-agent-operator',
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.cwd();
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'git@github.com:acme/standalone-workspace.git'],
        { cwd: root, stdio: 'ignore' },
      );
      writeFileSync(
        join(root, 'openslack.yaml'),
        'schema: openslack.workspace.v1\nworkspace:\n  state_root: .openslack\n',
        'utf-8',
      );
      process.chdir(root);
      const args = ['node', 'openslack', 'app', 'create', '--org', 'acme'];
      await githubCommands({ startAppManifestServer: start }).parseAsync(args, { from: 'node' });
      expect(start).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        'No server was started and no credential was written. Re-run with --apply.',
      );

      await githubCommands({ startAppManifestServer: start }).parseAsync([...args, '--apply'], {
        from: 'node',
      });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: root,
          organization: 'acme',
          port: 8200,
          homepageUrl: 'https://github.com/acme/standalone-workspace',
        }),
      );
    } finally {
      process.chdir(previous);
      process.exitCode = undefined;
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
