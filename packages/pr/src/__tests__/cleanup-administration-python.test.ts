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

const linuxFixtureCases = [
  'AdministrationBehaviorTests.test_backup_refuses_history_before_output_creation',
  'AdministrationBehaviorTests.test_first_start_rejects_nonempty_generation',
  'AdministrationBehaviorTests.test_post_start_cannot_pass_with_missing_runtime_objects',
  'BackupFixtureTests.test_absent_optional_file_appearing_after_copy_refuses_and_preserves',
  'BackupFixtureTests.test_absent_optional_link_directory_or_fifo_appearing_refuses_without_open',
  'BackupFixtureTests.test_backup_subdirectory_replacement_after_copy_preserves_partial_and_refuses',
  'BackupFixtureTests.test_changed_offline_state_after_copy_refuses_without_reset',
  'BackupFixtureTests.test_complete_fixed_allowlist_dual_sync_and_backup_local_restore',
  'BackupFixtureTests.test_dependency_cli_refuses_sensitive_inputs_before_helper_read',
  'BackupFixtureTests.test_existing_output_never_overwritten',
  'BackupFixtureTests.test_fifo_hardlink_oversize_and_mode_refuse_before_output',
  'BackupFixtureTests.test_installed_binary_flock_blocks_backup_without_history',
  'BackupFixtureTests.test_observer_rejects_nonprivate_output_parent_without_creation',
  'BackupFixtureTests.test_optional_unreadable_or_unverified_parent_never_counts_as_missing',
  'BackupFixtureTests.test_parent_directory_link_refuses_without_external_creation',
  'BackupFixtureTests.test_partial_and_zero_writes_and_fsync_failure',
  'BackupFixtureTests.test_runtime_or_process_or_locks_stop_before_creation',
  'BackupFixtureTests.test_source_replacement_during_copy_refuses_and_preserves_partial',
  'BackupFixtureTests.test_unlisted_and_sensitive_files_are_not_opened_or_backed_up',
  'InstanceFixtureTests.test_actual_fixed_inode_hash_pid_and_empty_generation',
  'InstanceFixtureTests.test_exact_schema_ids_nonce_generation_and_time',
  'InstanceFixtureTests.test_fine_boot_clock_interval_and_clock_change_are_fail_closed',
  'IsolationFixtureTests.test_changed_metadata_or_wrong_dropped_identity_block',
  'IsolationFixtureTests.test_prestart_defers_only_runtime_poststart_requires_all',
  'IsolationFixtureTests.test_privileged_or_unknown_groups_and_sudo_scope_block',
  'IsolationFixtureTests.test_unexpected_prestart_history_and_missing_credential_block',
  'MoreBoundaryTests.test_bad_result_after_child_reap_never_signals_reused_numeric_pid',
  'MoreBoundaryTests.test_container_daemon_unknown_endpoint_blocks_even_if_fixed_paths_absent',
  'MoreBoundaryTests.test_live_access_function_uses_only_owned_nonsecret_fixture_permissions',
  'MoreBoundaryTests.test_process_record_checks_every_uid_gid_and_exact_executable',
  'MoreBoundaryTests.test_sudo_scope_no_daemon_no_interfaces_complete_fixture',
  'MoreBoundaryTests.test_sudo_unknown_grant_or_command_failure_is_blocked',
  'MoreBoundaryTests.test_untrusted_output_parent_and_directory_replacement_are_refused',
  'ProcessObservationTests.test_ambiguous_status_is_unverified',
  'ProcessObservationTests.test_disappeared_process_is_unverified_not_stopped',
  'ProcessObservationTests.test_one_root_anchor_per_independent_scan_and_no_arguments_or_environment',
  'SafetyFixtureTests.test_bounded_read_rejects_fifo_hardlink_and_invalid_json',
  'SafetyFixtureTests.test_each_fstat_fault_closes_every_acquired_fd',
  'SafetyFixtureTests.test_file_and_ancestor_close_failures_are_both_retained',
  'SafetyFixtureTests.test_primary_and_cleanup_failure_both_retained',
  'SafetyFixtureTests.test_sensitive_and_active_outputs_are_refused_before_writes',
] as const;
const linuxCaseReports = new Map<string, { inventory: string[]; executed: string[] }>();

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

function expectPythonReport(stdout: string, portableOnly: boolean, selection = portableOnly ? 'portable' : 'all', testCase?: string) {
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
  const selected = testCase ? inventory.filter(id => id.endsWith(`.${testCase}`)) : inventory;
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
    if (process.platform !== 'linux' || linuxCaseReports.size === 0) return;
    const reports = [...linuxCaseReports.values()];
    const inventory = reports[0]!.inventory;
    for (const report of reports) expect(report.inventory).toEqual(inventory);
    const executed = reports.flatMap(report => report.executed);
    expect(new Set(executed).size).toBe(executed.length);
    const selected = inventory.filter(id => linuxCaseReports.has(id.split('.').slice(-2).join('.')));
    expect([...executed].sort()).toEqual([...selected].sort());
    const complete = linuxCaseReports.size === linuxFixtureCases.length;
    if (complete) expect([...executed].sort()).toEqual([...inventory].sort());
    console.info(JSON.stringify({ scope: 'cleanup Linux Python fixture coverage', complete,
      discovered: inventory.length, executed: executed.length, cases: [...linuxCaseReports.keys()],
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

  // Map each existing independent unittest to the unchanged per-test timeout.
  // Discovery checks the explicit matrix; the hook checks actual execution IDs,
  // so added, omitted or duplicated Python tests cannot silently disappear.
  it.each(linuxFixtureCases)('runs real owned-FD case %s, or native refusal outside Linux', (testCase) => {
    if (process.platform === 'linux') {
      const result = run([join(tools, 'administration_test.py'), '--linux-only', testCase]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = expectPythonReport(result.stdout, false, 'linux', testCase);
      expect(report.inventory.linux.map((id: string) => id.split('.').slice(-2).join('.')).sort())
        .toEqual([...linuxFixtureCases].sort());
      expect(linuxCaseReports.has(testCase)).toBe(false);
      linuxCaseReports.set(testCase, { inventory: report.inventory.linux, executed: report.executedTestIds });
      expect(result.stderr).toContain('OK');
    } else {
      const result = run([join(tools, 'administration_test.py'), '--linux-only', testCase]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('TEST_LINUX_REQUIRED');
      if (testCase !== linuxFixtureCases[0]) return;
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
