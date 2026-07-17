import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collaborationCommands } from '../commands/collaboration.js';

const roots: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('collaboration Negentropy commands', () => {
  it('exports an unsigned schema-pinned SHADOW preview', async () => {
    const root = workspace();
    process.chdir(root);
    const output = captureConsole();

    await collaborationCommands().parseAsync(
      ['node', 'openslack', 'integration', 'negentropy', 'export-slot', '--format', 'json'],
      { from: 'node' },
    );

    const value = JSON.parse(output.stdout.join('\n')) as Record<string, unknown>;
    expect(value.schema).toBe('openslack.negentropy.slot-preview.v1');
    expect(value.readiness).toBe('NOT_REGISTERABLE');
    expect(value).toHaveProperty('contribution.manifest.gate.mode', 'SHADOW');
    expect(value).toHaveProperty('contribution.manifest.metadata.projectionOnly', true);
    expect(JSON.stringify(value)).not.toContain('authorityWriterHandle":');
    expect(JSON.stringify(value)).not.toContain('proposeMutation":');
  });

  it('reports only the bounded three-state integration status', async () => {
    const root = workspace();
    process.chdir(root);
    const output = captureConsole();

    await collaborationCommands().parseAsync(
      ['node', 'openslack', 'integration', 'negentropy', 'export-slot'],
      { from: 'node' },
    );
    output.stdout.length = 0;
    await collaborationCommands().parseAsync(
      ['node', 'openslack', 'integration', 'negentropy', 'status', '--format', 'json'],
      { from: 'node' },
    );

    const report = JSON.parse(output.stdout.join('\n')) as Record<string, unknown>;
    expect(report.state).toBe('UNSIGNED_PREVIEW');
    expect(report).not.toHaveProperty('negentropyLifecycle');
    expect(process.exitCode).not.toBe(1);
  });

  it('rejects unsupported export formats without writing an artifact', async () => {
    const root = workspace();
    process.chdir(root);
    const output = captureConsole();
    process.exitCode = undefined;

    await collaborationCommands().parseAsync(
      ['node', 'openslack', 'integration', 'negentropy', 'export-slot', '--format', 'yaml'],
      { from: 'node' },
    );

    expect(output.stderr.join('\n')).toContain('supports only --format json');
    expect(process.exitCode).toBe(1);
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-cli-negentropy-'));
  roots.push(root);
  writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf8');
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
