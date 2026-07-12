import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { initCommand } from '../commands/init.js';

describe('openslack init', () => {
  it('is preview-first and applies an idempotent workspace only with --apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-cli-init-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      await initCommand().parseAsync(
        ['node', 'openslack', '--root', root, '--repo', 'acme/example'],
        { from: 'node' },
      );
      expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);

      await initCommand().parseAsync(
        ['node', 'openslack', '--root', root, '--repo', 'acme/example', '--apply'],
        { from: 'node' },
      );
      expect(existsSync(join(root, 'openslack.yaml'))).toBe(true);

      await initCommand().parseAsync(
        ['node', 'openslack', '--root', root, '--repo', 'acme/example', '--apply'],
        { from: 'node' },
      );
      expect(log).toHaveBeenCalledWith('Workspace initialized and validated.');
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
