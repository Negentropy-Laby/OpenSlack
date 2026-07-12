import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { githubCommands } from '../commands/github.js';

describe('github app bind-installation command', () => {
  it('previews before binding the non-secret installation ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-cli-app-bind-'));
    const localState = join(root, '.openslack.local');
    const previous = process.cwd();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      mkdirSync(localState);
      writeFileSync(
        join(root, 'openslack.yaml'),
        'schema: openslack.workspace.v1\nworkspace:\n  state_root: .openslack\n',
      );
      writeFileSync(
        join(localState, 'github-app.json'),
        '{"schema":"openslack.github_app_local.v1","appId":"123","installationId":null,"appSlug":"local-app","privateKeyRef":"keychain:openslack/test-app"}\n',
      );
      process.chdir(root);
      const args = ['node', 'openslack', 'app', 'bind-installation', '--installation-id', '456'];
      await githubCommands().parseAsync(args, { from: 'node' });
      expect(readFileSync(join(localState, 'github-app.json'), 'utf-8')).toContain(
        '"installationId":null',
      );

      await githubCommands().parseAsync([...args, '--apply'], { from: 'node' });
      expect(JSON.parse(readFileSync(join(localState, 'github-app.json'), 'utf-8'))).toMatchObject({
        installationId: '456',
        privateKeyRef: 'keychain:openslack/test-app',
      });
    } finally {
      process.chdir(previous);
      process.exitCode = undefined;
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
