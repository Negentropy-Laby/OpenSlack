import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyWorkspaceAttach, planWorkspaceAttach } from '@openslack/workspace';
import { setupCommands } from '../commands/setup.js';

const roots: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('setup attach command', () => {
  it('previews by default without changing the repository', async () => {
    const root = gitRoot();
    process.chdir(root);
    const logs = captureConsole();

    await setupCommands().parseAsync(['node', 'openslack', 'attach', '--repo', 'Acme/Project'], {
      from: 'node',
    });

    expect(logs.stdout.join('\n')).toContain('Workspace attach preview');
    expect(logs.stdout.join('\n')).toContain('Preview only');
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
  });

  it('applies before starting the typed foreground daemon', async () => {
    const root = gitRoot();
    process.chdir(root);
    const order: string[] = [];
    const startWatch = vi.fn(async () => {
      order.push('watch');
      expect(existsSync(join(root, 'openslack.yaml'))).toBe(true);
      expect(existsSync(join(root, '.openslack', 'monitors', 'github-watch.yaml'))).toBe(true);
      return {
        mode: 'poll' as const,
        configPath: join(root, '.openslack', 'monitors', 'github-watch.yaml'),
        repositories: 1,
        pollIntervalSeconds: 300,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    const applyAttach = vi.fn((plan: Parameters<typeof applyWorkspaceAttach>[0]) => {
      order.push('apply');
      return applyWorkspaceAttach(plan);
    });
    captureConsole();

    await setupCommands({ applyAttach, startWatch }).parseAsync(
      [
        'node',
        'openslack',
        'attach',
        '--repo',
        'Acme/Project',
        '--mode',
        'full-agent',
        '--apply',
        '--start-watch',
      ],
      { from: 'node' },
    );

    expect(order).toEqual(['apply', 'watch']);
    expect(startWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: join(root, '.openslack', 'monitors', 'github-watch.yaml'),
      }),
    );
    const agent = readFileSync(
      join(root, '.openslack', 'agents', 'registry', 'openslack_agent_operator.yaml'),
      'utf8',
    );
    expect(agent).toContain('can_approve: false');
    expect(agent).toContain('can_merge: false');
  });

  it('rejects --start-watch without --apply before planning or writing', async () => {
    const root = gitRoot();
    process.chdir(root);
    const planAttach = vi.fn(planWorkspaceAttach);
    const startWatch = vi.fn();
    const logs = captureConsole();
    process.exitCode = undefined;

    await setupCommands({ planAttach, startWatch }).parseAsync(
      ['node', 'openslack', 'attach', '--repo', 'Acme/Project', '--start-watch'],
      { from: 'node' },
    );

    expect(planAttach).not.toHaveBeenCalled();
    expect(startWatch).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
    expect(logs.stderr.join('\n')).toContain('--start-watch requires --apply');
    expect(process.exitCode).toBe(1);
  });

  it('keeps a validated attach when daemon startup fails', async () => {
    const root = gitRoot();
    process.chdir(root);
    const logs = captureConsole();
    process.exitCode = undefined;

    await setupCommands({
      startWatch: vi.fn().mockRejectedValue(new Error('daemon failed safely')),
    }).parseAsync(
      ['node', 'openslack', 'attach', '--repo', 'Acme/Project', '--apply', '--start-watch'],
      { from: 'node' },
    );

    expect(existsSync(join(root, 'openslack.yaml'))).toBe(true);
    expect(logs.stderr.join('\n')).toContain('daemon failed safely');
    expect(logs.stderr.join('\n')).toContain('remains committed');
    expect(process.exitCode).toBe(1);
  });

  it('repeated --apply is idempotent', async () => {
    const root = gitRoot();
    process.chdir(root);
    const logs = captureConsole();
    const command = () =>
      setupCommands().parseAsync(
        ['node', 'openslack', 'attach', '--repo', 'Acme/Project', '--apply'],
        { from: 'node' },
      );

    await command();
    const before = readFileSync(join(root, 'openslack.yaml'));
    await command();

    expect(readFileSync(join(root, 'openslack.yaml'))).toEqual(before);
    expect(logs.stdout.join('\n')).toContain('already matches; validation passed');
  });
});

function gitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-setup-attach-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function captureConsole(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  return { stdout, stderr };
}
