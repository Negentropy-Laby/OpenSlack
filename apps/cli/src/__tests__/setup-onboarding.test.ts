import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupCommands } from '../commands/setup.js';

describe('setup onboarding', () => {
  it('creates and resumes a durable local onboarding ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-setup-onboarding-'));
    const previous = process.cwd();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(root, 'openslack.yaml'),
        'schema: openslack.workspace.v1\nworkspace:\n  state_root: .openslack\n',
        'utf-8',
      );
      process.chdir(root);
      await setupCommands().parseAsync(['node', 'openslack', 'onboarding', '--start'], {
        from: 'node',
      });
      await setupCommands().parseAsync(['node', 'openslack', 'onboarding'], { from: 'node' });
      expect(log).toHaveBeenCalledWith('Next: workspace (pending)');
    } finally {
      process.chdir(previous);
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
