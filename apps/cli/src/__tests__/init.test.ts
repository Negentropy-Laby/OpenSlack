import { testTemporaryDirectory } from '../../../../scripts/testing/process-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { initCommand } from '../commands/init.js';

describe('openslack init', () => {
  let root: string;
  let log: MockInstance<typeof console.log>;
  beforeEach(() => {
    root = testTemporaryDirectory('openslack-cli-init-');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  });
  afterEach(() => {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });
  const apply = () =>
    initCommand().parseAsync(
      ['node', 'openslack', '--root', root, '--repo', 'acme/example', '--apply'],
      { from: 'node' },
    );

  it('previews without creating workspace files', async () => {
    await initCommand().parseAsync(
      ['node', 'openslack', '--root', root, '--repo', 'acme/example'],
      { from: 'node' },
    );
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
    expect(log).not.toHaveBeenCalledWith('Workspace initialized and validated.');
  });

  it('creates and validates workspace files only with --apply', async () => {
    await apply();
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(true);
    expect(log).toHaveBeenCalledWith('Workspace initialized and validated.');
  });

  describe('an initialized workspace', () => {
    beforeEach(async () => {
      await apply();
      log.mockClear();
    });
    it('preserves existing workspace bytes on repeated --apply', async () => {
      const original = readFileSync(join(root, 'openslack.yaml'));
      await apply();
      expect(readFileSync(join(root, 'openslack.yaml'))).toEqual(original);
      expect(log).toHaveBeenCalledWith('Workspace initialized and validated.');
    });
  });
});
