import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { collaborationCommands } from '../commands/collaboration.js';

const roots: string[] = [];
const cwd = process.cwd();
const exitCode = process.exitCode;
afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['repair-checkpoints', 'reconcile-bindings'])(
  '%s retains safe configuration errors without a rejected command promise',
  async (command) => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-recovery-cli-'));
    roots.push(root);
    writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n');
    process.chdir(root);
    process.exitCode = undefined;
    vi.stubEnv('OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN', 'invalid-private-origin');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      collaborationCommands().parseAsync(['workflow', 'runs', command, 'run.test', '--apply'], {
        from: 'user',
      }),
    ).resolves.toBeDefined();
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join('\n')).toContain('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID');
    expect(stderr.mock.calls.flat().join('\n')).not.toContain('invalid-private-origin');
    expect(stdout).not.toHaveBeenCalled();
  },
);
