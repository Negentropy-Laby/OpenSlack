import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createTestProcessResolver,
  testProcessEnvironment,
} from '../../../../scripts/testing/process-fixture.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tools = join(repositoryRoot, 'scripts', 'cleanup-broker', 'administration');
const entries = [
  'target-observation',
  'dependency-inventory',
  'offline-backup',
  'isolation',
  'inspect-instance',
];

let resolver: ReturnType<typeof createTestProcessResolver> | undefined;
let preferredCommand: string | undefined;

function python() {
  resolver ??= createTestProcessResolver(testProcessEnvironment(), repositoryRoot);
  const failures: string[] = [];
  const commands = [
    ...new Set(
      [preferredCommand, 'python3', 'python', 'py'].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ];
  for (const command of commands) {
    try {
      const executable = resolver.executable(command);
      const probe = spawnSync(
        executable,
        ['-I', '-B', '-c', 'import sys;sys.exit(0 if sys.version_info >= (3,11) else 2)'],
        {
          encoding: 'utf8',
          cwd: repositoryRoot,
          env: resolver.env,
        },
      );
      if (probe.status === 0) {
        preferredCommand = command;
        return { executable, env: resolver.env };
      }
      failures.push(`${command}: interpreter must be Python 3.11 or newer`);
    } catch {
      failures.push(`${command}: verified executable unavailable`);
    }
  }
  throw new Error(`TEST_PYTHON_REQUIRED: install Python 3.11 or newer; ${failures.join('; ')}`);
}

function run(args: string[]) {
  const selected = python();
  return spawnSync(selected.executable, ['-I', '-B', ...args], {
    encoding: 'utf8',
    cwd: repositoryRoot,
    env: selected.env,
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe('cleanup administrator Python tools', () => {
  it.each(entries)('%s refuses an unsupported platform before target IO', (entry) => {
    const owned = mkdtempSync(join(tmpdir(), 'cleanup-python-platform-'));
    try {
      const output = join(owned, 'never-created.json');
      const code = [
        'import builtins,runpy,sys',
        "sys.platform='win32'",
        'original=builtins.__import__',
        'def audited(name,*args,**kwargs):',
        " if name in ('pwd','grp'): raise AssertionError('Linux import before platform refusal')",
        ' return original(name,*args,**kwargs)',
        'builtins.__import__=audited',
        'script,output=sys.argv[1:]',
        "sys.argv=[script,'--output',output]",
        "runpy.run_path(script,run_name='__main__')",
      ].join('\n');
      const result = run(['-c', code, join(tools, `${entry}.py`), output]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/LINUX_(DESCRIPTOR_CAPABILITY|ROOT_OBSERVER)_REQUIRED/);
      expect(result.stderr).not.toContain('Linux import before platform refusal');
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(owned)).toEqual([]);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it('runs the nonsecret portable parser and platform-boundary regressions', () => {
    const result = run([join(tools, 'administration_test.py'), '--portable']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 5 tests');
    expect(result.stderr).toContain('OK');
  });

  it('runs real Linux owned-FD fixtures, or native zero-IO refusal outside Linux', () => {
    const result = run([
      join(tools, 'administration_test.py'),
      ...(process.platform === 'linux' ? [] : ['--portable']),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran \d+ tests/);
    expect(result.stderr).toContain('OK');
  });

  it('runs independently reviewed load-time closure fixtures, or native collector refusal', () => {
    if (process.platform === 'linux') {
      const result = run([join(tools, 'dependency_inventory_test.py')]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('Ran 42 tests');
      expect(result.stderr).toContain('OK');
      return;
    }
    const result = run([join(tools, 'dependency-inventory.py')]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('LINUX_ROOT_OBSERVER_REQUIRED');
  });
});
