import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

function expectPythonReport(stdout: string, portableOnly: boolean): void {
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  expect(report.schema).toBe('openslack.cleanup_python_test_run.v1');
  expect(report.portableOnly).toBe(portableOnly);
  expect(report.selected).toBeGreaterThan(0);
  expect(report.discovered).toBeGreaterThanOrEqual(report.selected);
  expect(report.executed).toBe(report.selected);
  expect(report.failures + report.errors + report.skipped).toBe(0);
  expect(report.successful).toBe(true);
}

describe('cleanup administrator Python tools', () => {
  it('keeps generated Python and TS contracts synchronized on every platform without regeneration', () => {
    const result = run([
      join(repositoryRoot, 'scripts/cleanup-broker/generate-administration-contract.py'),
      '--check',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it('keeps the reviewed registry and actual helper bytes pinned on every platform', () => {
    const contract = JSON.parse(
      readFileSync(
        join(repositoryRoot, 'packages/pr/src/internal/cleanup-administration-contract.json'),
        'utf8',
      ),
    );
    const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
    expect(
      sha(
        readFileSync(
          join(repositoryRoot, '.openslack/agents/registry/cleanup_qualification_pr418.yaml'),
        ),
      ),
    ).toBe(contract.registrySHA256);
    const dependency = readFileSync(join(tools, 'dependency-inventory.py'), 'utf8');
    expect(/HELPER_SHA256 = '([a-f0-9]{64})'/.exec(dependency)?.[1]).toBe(
      sha(readFileSync(join(tools, 'target-observation.py'))),
    );
  });
  it.each(entries)('%s refuses an unsupported platform before target IO', (entry) => {
    const owned = mkdtempSync(join(tmpdir(), 'cleanup-python-platform-'));
    try {
      const output = join(owned, 'never-created.json');
      const code = [
        'import builtins,runpy,sys,time',
        "sys.platform='win32'",
        "if hasattr(time,'clock_gettime_ns'): del time.clock_gettime_ns",
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
    expectPythonReport(result.stdout, true);
    expect(result.stderr).toContain('OK');
  });

  it('runs real Linux owned-FD fixtures, or native zero-IO refusal outside Linux', () => {
    const result = run([
      join(tools, 'administration_test.py'),
      ...(process.platform === 'linux' ? [] : ['--portable']),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expectPythonReport(result.stdout, process.platform !== 'linux');
    expect(result.stderr).toContain('OK');
  });

  it('runs independently reviewed load-time closure fixtures, or native collector refusal', () => {
    if (process.platform === 'linux') {
      const result = run([join(tools, 'dependency_inventory_test.py')]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expectPythonReport(result.stdout, false);
      expect(result.stderr).toContain('OK');
      return;
    }
    const result = run([join(tools, 'dependency-inventory.py')]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('LINUX_ROOT_OBSERVER_REQUIRED');
  });
});
