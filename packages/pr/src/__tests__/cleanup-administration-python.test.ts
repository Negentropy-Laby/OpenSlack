import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
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

const linuxFixtureGroups = [
  'AdministrationBehaviorTests',
  'ProcessObservationTests',
  'BackupFixtureTests',
  'SafetyFixtureTests',
  'IsolationFixtureTests',
  'InstanceFixtureTests',
  'MoreBoundaryTests',
] as const;
const linuxGroupReports = new Map<string, { inventory: string[]; executed: string[] }>();

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

function expectPythonReport(stdout: string, portableOnly: boolean, selection = portableOnly ? 'portable' : 'all', group?: string) {
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  expect(report.schema).toBe('openslack.cleanup_python_test_run.v1');
  expect(report.portableOnly).toBe(portableOnly);
  expect(report.selection).toBe(selection);
  expect(Object.keys(report.portability).sort()).toEqual(['linux', 'portable']);
  expect(report.portability.linux + report.portability.portable).toBe(report.discovered);
  const inventory: string[] = selection === 'all'
    ? [...report.inventory.portable, ...report.inventory.linux]
    : report.inventory[selection];
  expect(report.inventory.portable).toHaveLength(report.portability.portable);
  expect(report.inventory.linux).toHaveLength(report.portability.linux);
  const selected = group ? inventory.filter(id => id.split('.').at(-2) === group) : inventory;
  expect(report.selected).toBe(selected.length);
  expect(report.selected).toBeGreaterThan(0);
  expect(report.discovered).toBeGreaterThanOrEqual(report.selected);
  expect(report.executed).toBe(report.selected);
  expect(report.failures + report.errors + report.skipped).toBe(0);
  expect(report.successful).toBe(true);
  expect(new Set(report.executedTestIds).size).toBe(report.executed);
  expect([...report.executedTestIds].sort()).toEqual([...selected].sort());
  return report;
}

// Load host pathlib before simulating another platform: Python 3.14 imports
// pwd from pathlib on Linux. Application imports remain audited afterwards.
const unsupportedPlatformAudit = [
  'import builtins,pathlib,runpy,sys,time',
  "sys.platform='win32'",
  "if hasattr(time,'clock_gettime_ns'): del time.clock_gettime_ns",
  'original=builtins.__import__',
  'def audited(name,*args,**kwargs):',
  " if name in ('pwd','grp'): raise AssertionError('Linux import before platform refusal')",
  ' return original(name,*args,**kwargs)',
  'builtins.__import__=audited',
].join('\n');

describe('cleanup administrator Python tools', () => {
  afterAll(() => {
    if (process.platform !== 'linux' || linuxGroupReports.size === 0) return;
    const reports = [...linuxGroupReports.values()];
    const inventory = reports[0]!.inventory;
    for (const report of reports) expect(report.inventory).toEqual(inventory);
    const executed = reports.flatMap(report => report.executed);
    expect(new Set(executed).size).toBe(executed.length);
    const selected = inventory.filter(id => linuxGroupReports.has(id.split('.').at(-2)!));
    expect([...executed].sort()).toEqual([...selected].sort());
    const complete = linuxGroupReports.size === linuxFixtureGroups.length;
    if (complete) expect([...executed].sort()).toEqual([...inventory].sort());
    console.info(JSON.stringify({ scope: 'cleanup Linux Python fixture coverage', complete,
      discovered: inventory.length, executed: executed.length, groups: [...linuxGroupReports.keys()],
      executedTestIds: executed }));
  });
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
        unsupportedPlatformAudit,
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

  it.each(['pwd', 'grp'])(
    'still audits direct application imports of %s after host preload',
    (module) => {
      const result = run(['-c', `${unsupportedPlatformAudit}\n__import__(sys.argv[1])`, module]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('AssertionError: Linux import before platform refusal');
    },
  );

  it('runs the nonsecret portable parser and platform-boundary regressions', () => {
    const result = run([join(tools, 'administration_test.py'), '--portable']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expectPythonReport(result.stdout, true);
    expect(result.stderr).toContain('OK');
  });

  it('rejects an unknown Python selector before executing a known selected test', () => {
    const result = run([
      join(tools, 'administration_test.py'),
      '--portable',
      'PortableLogicTests.test_strict_json_duplicate_escaped_keys_and_non_json_numbers',
      'MissingFixtureTests',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TEST_SELECTION_UNKNOWN');
    expect(result.stdout).toBe('');
  });

  // Each Python class is an independent fixture boundary under the unchanged
  // per-test timeout. The hook above requires the full discovered Linux union,
  // so a new class, omitted group or duplicate execution cannot silently pass.
  it.each(linuxFixtureGroups)('runs real owned-FD group %s, or native refusal outside Linux', (group) => {
    if (process.platform === 'linux') {
      const result = run([join(tools, 'administration_test.py'), '--linux-only', group]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = expectPythonReport(result.stdout, false, 'linux', group);
      expect([...new Set<string>(report.inventory.linux.map((id: string) => id.split('.').at(-2)!))].sort())
        .toEqual([...linuxFixtureGroups].sort());
      expect(linuxGroupReports.has(group)).toBe(false);
      linuxGroupReports.set(group, { inventory: report.inventory.linux, executed: report.executedTestIds });
      expect(result.stderr).toContain('OK');
    } else {
      const result = run([join(tools, 'administration_test.py'), '--linux-only', group]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('TEST_LINUX_REQUIRED');
      if (group !== linuxFixtureGroups[0]) return;
      const owned = mkdtempSync(join(tmpdir(), 'cleanup-python-native-'));
      try {
        for (const entry of entries) {
          const output = join(owned, `${entry}.json`);
          const result = run([join(tools, `${entry}.py`), '--output', output]);
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(2);
          expect(result.stderr).toMatch(/LINUX_(DESCRIPTOR_CAPABILITY|ROOT_OBSERVER)_REQUIRED/);
          expect(existsSync(output)).toBe(false);
        }
        expect(readdirSync(owned)).toEqual([]);
      } finally { rmSync(owned, { recursive: true, force: true }); }
    }
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
