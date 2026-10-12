#!/usr/bin/env python3
"""Owned, nonsecret fixtures and injected ldd responses only; no live target/process/network."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import unittest
import sys
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parent))
from _test_runner import LinuxTests, run as run_tests

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('fixture_dependency_collector', BASE / 'dependency-inventory.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
HELPER = collector.load_frozen_helper(BASE / collector.HELPER_NAME)
OWNER = (os.geteuid(), os.getegid())
NOW = datetime(2026, 10, 11, 12, 1, tzinfo=timezone.utc)
LOADER = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
LIBC = '/usr/lib/x86_64-linux-gnu/libc.so.6'
LIBA = '/usr/lib/x86_64-linux-gnu/libfixtureA.so.1'


def elf_bytes(*, dynamic=True, interpreter=None, needed=(), soname=None):
    """Small ELF64 synthetic fixture, not an executable capable of running any program."""
    strings = bytearray(b'\0')
    names = {}
    for name in list(needed) + ([soname] if soname is not None else []):
        if name not in names:
            names[name] = len(strings)
            strings.extend(name.encode('ascii') + b'\0')
    tags = [(1, names[name]) for name in needed]
    if soname is not None:
        tags.append((14, names[soname]))
    if tags:
        tags.extend(((5, 0x400000 + 0x400), (10, len(strings))))
    tags.append((0, 0))
    dynamic_bytes = b''.join(struct.pack('<qQ', *tag) for tag in tags)
    size = max(0x500, 0x400 + len(strings), 0x300 + len(dynamic_bytes))
    result = bytearray(size)
    ph = [(1, 5, 0, 0x400000, 0x400000, size, size, 4096)]
    if interpreter is not None:
        data = interpreter.encode('ascii') + b'\0'
        result[0x200:0x200 + len(data)] = data
        ph.append((3, 4, 0x200, 0x400200, 0x400200, len(data), len(data), 1))
    if dynamic:
        result[0x300:0x300 + len(dynamic_bytes)] = dynamic_bytes
        result[0x400:0x400 + len(strings)] = strings
        ph.append((2, 4, 0x300, 0x400300, 0x400300, len(dynamic_bytes), len(dynamic_bytes), 8))
    result[:16] = b'\x7fELF' + bytes((2, 1, 1)) + bytes(9)
    result[16:64] = struct.pack('<HHIQQQIHHHHHH', 2 if interpreter or not dynamic else 3,
        62, 1, 0, 64, 0, 0, 64, 56, len(ph), 0, 0, 0)
    for index, header in enumerate(ph):
        result[64 + index * 56:64 + (index + 1) * 56] = struct.pack('<IIQQQQQQ', *header)
    return bytes(result)


class OwnedFixtures:
    def __init__(self):
        self.outer = Path(tempfile.mkdtemp(prefix='openslack-dependency-fixtures-', dir='/var/tmp'))
        self.root = self.outer / 'owned root with spaces'
        self.root.mkdir(mode=0o700)
        self.calls, self.opened, self.alias_calls = [], [], []
        self.observer_calls = 0
        self.command_change = None
        self.handle_change = None
        self.alias_change = None
        self.target_change = None
        self.write('/usr/bin/ldd', b'#!/bin/bash\n# synthetic script; not executed\n')
        self.write('/usr/bin/bash', elf_bytes(interpreter='/lib64/ld-linux-x86-64.so.2',
            needed=('libc.so.6',)), mode=0o755)
        (self.root / 'bin').symlink_to('usr/bin', target_is_directory=True)
        self.write(LOADER, elf_bytes(soname='ld-linux-x86-64.so.2'))
        self.write(LIBC, elf_bytes(needed=('ld-linux-x86-64.so.2',), soname='libc.so.6'))
        self.write(LIBA, elf_bytes(needed=('libc.so.6',), soname='libfixtureA.so.1'))
        (self.root / 'lib').symlink_to('usr/lib', target_is_directory=True)
        (self.root / 'usr/lib64').mkdir(mode=0o755)
        (self.root / 'lib64').symlink_to('usr/lib64', target_is_directory=True)
        (self.root / 'usr/lib64/ld-linux-x86-64.so.2').symlink_to('../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2')
        for path in collector.INSTALLED:
            data = b'// owned non-sensitive executor fixture\n' if path.endswith('executor.mjs') else (
                elf_bytes(dynamic=False) if path == collector.BROKER else
                elf_bytes(interpreter='/lib64/ld-linux-x86-64.so.2', needed=('libfixtureA.so.1', 'libc.so.6')))
            self.write(path, data, mode=int(collector.INSTALLED_MODES[path], 8))
        self.refresh_observation()

    def close(self):
        shutil.rmtree(self.outer)

    def write(self, logical, data, mode=0o644):
        path = self.root / logical.lstrip('/')
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def refresh_observation(self):
        files = []
        for logical, bound in collector.INSTALLED.items():
            with collector.VerifiedFile(self.root, logical, bound, HELPER, expected_owner=OWNER) as file:
                entry = deepcopy(file.before)
                # Root ownership below is injected solely into an in-memory fixture result.
                # No actual target observation or production inventory is published by tests.
                entry['uid'], entry['gid'] = 0, 0
                files.append(entry)
        self.observation = dict(schema='openslack.cleanup_target_observation.v1', **collector.BINDINGS,
            recordedAt=(NOW - timedelta(minutes=1)).isoformat(), expiresAt=(NOW + timedelta(hours=23)).isoformat(),
            host=dict(system='Linux', arch='x86_64'), files=files,
            neverStartedOfflineUpgrade=dict(eligible=True), process=dict(state='stopped'),
            persistentState=dict(state='absent'))

    def handles(self, root, logical, bound, helper):
        fixture = self
        class Handle:
            def __enter__(self):
                fixture.opened.append(logical)
                self.real = collector.VerifiedFile(root, logical, bound, helper, expected_owner=OWNER)
                self.real.__enter__()
                self.before = deepcopy(self.real.before)
                self.before['uid'], self.before['gid'] = 0, 0
                self.fd = self.real.fd
                return self
            def peek(self, offset, length):
                return self.real.peek(offset, length)
            def check_identity(self):
                if fixture.handle_change is not None:
                    fixture.handle_change(logical, self)
                self.real.check_identity()
            def unchanged(self):
                if fixture.handle_change is not None:
                    fixture.handle_change(logical, self)
                after = deepcopy(self.real.unchanged())
                after['uid'], after['gid'] = 0, 0
                return after
            def __exit__(self, *args):
                self.real.__exit__(*args)
        return Handle()

    def resolve(self, root, alias, helper):
        self.alias_calls.append(alias)
        if self.alias_change is not None:
            changed = self.alias_change(alias, self.alias_calls.count(alias))
            if changed is not None:
                return changed
        return collector.canonical_system_file(root, alias, helper, expected_owner=OWNER)

    def ldd(self, logical):
        self.calls.append(logical)
        output = ('\tlinux-vdso.so.1 (0x00007fff0000)\n'
            '\tlibfixtureA.so.1 => /lib/x86_64-linux-gnu/libfixtureA.so.1 (0x00007f1000)\n'
            '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f2000)\n'
            '\t/lib64/ld-linux-x86-64.so.2 (0x00007f3000)\n')
        value = dict(argv=['/usr/bin/ldd', '--', logical], environment=dict(collector.MINIMAL_ENV), cwd='/',
            status=0, signal=None, timedOut=False, truncated=False, encodingValid=True,
            stdout=output, stderr='', stdoutHex=output.encode().hex(), stderrHex='', elapsedMs=0)
        return self.command_change(logical, value) if self.command_change is not None else value

    def target(self, *_):
        self.observer_calls += 1
        result = dict(state='owned-fixture-only-no-real-host-observation', stopped=True, history='absent')
        return self.target_change(self.observer_calls, result) if self.target_change is not None else result

    def collect(self, *, observation=None, clock=None, hours=24):
        evidence = self.observation if observation is None else observation
        digest = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
        return collector.collect(evidence, digest, HELPER, root=self.root, now=NOW, hours=hours,
            handle_factory=self.handles, resolver=self.resolve, command_runner=self.ldd,
            target_observer=self.target, clock=clock or (lambda: NOW + timedelta(seconds=1)),
            bash_resolver=lambda root, helper, shebang: collector.system_bash_resolution(root, helper, shebang,
                expected_owner=OWNER))


class DependencyCollectorTests(LinuxTests):
    def setUp(self):
        self.fixture = OwnedFixtures()
        self.addCleanup(self.fixture.close)

    def refused(self, raw, inventory, code):
        self.assertIsNone(inventory)
        self.assertFalse(raw['closureVerified'])
        self.assertIsNone(raw['productionInventory'])
        self.assertIn(code, raw['blockingReasons'])
        for key in ('installationPerformed', 'credentialContentsRead', 'brokerStarted', 'executorStarted',
                    'approvalRecorded', 'permitIssued'):
            self.assertFalse(raw[key])

    def test_complete_fixture_closure_has_exact_production_shape_and_derived_count(self):
        raw, inventory = self.fixture.collect()
        self.assertTrue(raw['closureVerified'], raw['blockingReasons'])
        self.assertEqual(raw['count'], len(inventory['files']))
        self.assertEqual(raw['count'], 3)
        encoded = collector.evidence_bytes(inventory)
        self.assertEqual(raw['productionInventory'], dict(schema=inventory['schema'],
            sha256=hashlib.sha256(encoded).hexdigest(), bytes=len(encoded), fileCount=len(inventory['files'])))
        self.assertEqual(set(inventory), {'schema', 'target', 'workspaceId', 'repository', 'repositoryId',
                                        'recordedAt', 'expiresAt', 'files'})
        self.assertEqual(inventory['schema'], 'openslack.cleanup_dependency_inventory.v1')
        for file in inventory['files']:
            self.assertEqual(set(file), {'path', 'sha256', 'uid', 'gid', 'mode'})
            self.assertTrue(file['path'].startswith('/usr/lib/'))
            self.assertEqual((file['uid'], file['gid']), (0, 0))
            self.assertRegex(file['sha256'], r'^[0-9a-f]{64}$')
            self.assertEqual(int(file['mode'], 8) & 0o022, 0)
        self.assertEqual(self.fixture.calls, list(collector.LDD_INPUTS))
        self.assertNotIn(collector.BROKER, self.fixture.calls)
        self.assertFalse(any(p.endswith('executor.mjs') for p in self.fixture.calls))
        for call in raw['lddCalls']:
            self.assertEqual(bytes.fromhex(call['stdoutHex']).decode(), call['stdout'])
            self.assertEqual(call['environment'], collector.MINIMAL_ENV)
        self.assertTrue(all(file['before'] == file['after'] for file in raw['libraries']))
        self.assertEqual(raw['brokerELF']['kind'], 'static')
        self.assertIn('dlopen/NSS/plugins are not asserted', raw['scope'])

    def test_direct_loader_soname_satisfies_libc_transitive_requirement(self):
        raw, inventory = self.fixture.collect()
        self.assertIsNotNone(inventory, raw['blockingReasons'])
        entry = next(file for file in raw['libraries'] if file['after']['path'] == LIBC)
        self.assertEqual(entry['elf']['needed'], ['ld-linux-x86-64.so.2'])

    def test_inventory_count_changes_with_observed_set_not_a_preset_total(self):
        self.fixture.write('/usr/lib/x86_64-linux-gnu/libfixtureB.so.1',
            elf_bytes(needed=('libc.so.6',), soname='libfixtureB.so.1'))
        def change(_, value):
            value['stdout'] += '\tlibfixtureB.so.1 => /lib/x86_64-linux-gnu/libfixtureB.so.1 (0x00007f4000)\n'
            value['stdoutHex'] = value['stdout'].encode().hex()
            return value
        self.fixture.command_change = change
        raw, inventory = self.fixture.collect()
        self.assertIsNotNone(inventory, raw['blockingReasons'])
        self.assertEqual(raw['count'], 4)
        self.assertEqual(raw['count'], len(inventory['files']))

    def test_dynamic_broker_is_refused_before_any_command(self):
        self.fixture.write(collector.BROKER, elf_bytes(interpreter='/lib64/ld-linux-x86-64.so.2'), mode=0o755)
        self.fixture.refresh_observation()
        self.refused(*self.fixture.collect(), 'BROKER_NOT_STATIC_NO_BROKER_EXECUTION_ALLOWED')
        self.assertEqual(self.fixture.calls, [])

    def test_installed_hash_drift_is_refused_before_any_command(self):
        path = self.fixture.root / collector.LDD_INPUTS[0].lstrip('/')
        path.write_bytes(elf_bytes(interpreter='/lib64/ld-linux-x86-64.so.2', needed=('libc.so.6',)))
        self.refused(*self.fixture.collect(), 'INSTALLED_ARTIFACT_DIFFERS_FROM_TARGET_OBSERVATION')
        self.assertEqual(self.fixture.calls, [])

    def test_writable_ldd_and_installed_ancestors_refuse_before_any_command(self):
        for logical in ('/usr/bin', '/usr/lib/openslack-cleanup'):
            actual = self.fixture.root / logical.lstrip('/')
            with self.subTest(path=logical):
                actual.chmod(0o777)
                self.fixture.calls.clear()
                self.refused(*self.fixture.collect(), 'UNTRUSTED_ANCESTOR_OWNER_OR_MODE')
                self.assertEqual(self.fixture.calls, [])
                actual.chmod(0o755)

    def test_wrong_owner_ldd_and_installed_ancestors_refuse_before_any_command(self):
        original_fstat = os.fstat
        for logical in ('/usr/bin', '/usr/lib/openslack-cleanup'):
            actual = str(self.fixture.root / logical.lstrip('/'))
            def wrong_owner(fd):
                result = original_fstat(fd)
                if os.readlink('/proc/self/fd/' + str(fd)) == actual:
                    values = list(result)
                    values[4] = OWNER[0] + 1
                    return os.stat_result(values)
                return result
            with self.subTest(path=logical), patch.object(os, 'fstat', side_effect=wrong_owner):
                self.fixture.calls.clear()
                self.refused(*self.fixture.collect(), 'UNTRUSTED_ANCESTOR_OWNER_OR_MODE')
                self.assertEqual(self.fixture.calls, [])

    def test_unexpected_bin_alias_refuses_before_any_command(self):
        alias = self.fixture.root / 'bin'
        alias.unlink()
        alias.symlink_to('tmp/untrusted-bin')
        self.refused(*self.fixture.collect(), 'SYSTEM_BIN_ALIAS_UNEXPECTED')
        self.assertEqual(self.fixture.calls, [])

    def test_installed_change_after_ldd_retains_raw_call_but_refuses_inventory(self):
        def change(path, value):
            self.fixture.write(path, b'changed installed fixture')
            return value
        self.fixture.command_change = change
        raw, inventory = self.fixture.collect()
        self.refused(raw, inventory, 'OPEN_FILE_OR_ENTRY_CHANGED')
        self.assertEqual(len(raw['lddCalls']), 1)

    def test_ldd_not_found_refuses_inventory_and_preserves_exact_output(self):
        def change(_, value):
            value['stdout'] = '\tlibmissing.so.1 => not found\n'
            value['stdoutHex'] = value['stdout'].encode().hex()
            return value
        self.fixture.command_change = change
        raw, inventory = self.fixture.collect()
        self.refused(raw, inventory, 'LDD_UNRESOLVED_DEPENDENCY')
        self.assertEqual(raw['lddCalls'][0]['stdout'], '\tlibmissing.so.1 => not found\n')

    def test_ldd_unexpected_output_refuses_inventory(self):
        self.fixture.command_change = lambda _, value: dict(value, stdout='warning: unexpected fixture output\n')
        self.refused(*self.fixture.collect(), 'LDD_UNEXPECTED_OUTPUT')

    def test_command_errors_signals_timeouts_truncation_and_stderr_refuse(self):
        cases = [dict(status=1), dict(status=-9, signal=9), dict(timedOut=True), dict(truncated=True),
                 dict(encodingValid=False), dict(stderr='untrusted warning'),
                 dict(commandError='EIO', status=0), dict(spawnError='EACCES', status=0),
                 dict(argv=['ldd', '--', collector.LDD_INPUTS[0]]), dict(cwd='/tmp'),
                 dict(environment=dict(collector.MINIMAL_ENV, LD_PRELOAD='/tmp/untrusted.so'))]
        for changes in cases:
            with self.subTest(changes=changes):
                self.fixture.command_change = lambda _, value, changes=changes: dict(value, **changes)
                self.refused(*self.fixture.collect(), 'LDD_COMMAND_FAILED_OR_UNKNOWN')

    def test_transitive_missing_needed_refuses(self):
        self.fixture.write(LIBA, elf_bytes(needed=('libmissing.so.1',), soname='libfixtureA.so.1'))
        self.refused(*self.fixture.collect(), 'TRANSITIVE_DT_NEEDED_UNRESOLVED')

    def test_executable_missing_needed_refuses(self):
        self.fixture.write(collector.LDD_INPUTS[0], elf_bytes(interpreter='/lib64/ld-linux-x86-64.so.2',
            needed=('libmissing.so.1',)), mode=0o755)
        self.fixture.refresh_observation()
        self.refused(*self.fixture.collect(), 'EXECUTABLE_DT_NEEDED_UNRESOLVED')

    def test_missing_embedded_interpreter_refuses(self):
        alt = '/usr/lib/x86_64-linux-gnu/ld-other.so.2'
        self.fixture.write(alt, elf_bytes(soname='ld-other.so.2'))
        self.fixture.command_change = lambda _, value: dict(value, stdout=value['stdout'].replace(
            '/lib64/ld-linux-x86-64.so.2', alt))
        self.refused(*self.fixture.collect(), 'LDD_EMBEDDED_INTERPRETER_MISSING')

    def test_reported_soname_mismatch_refuses(self):
        self.fixture.write(LIBA, elf_bytes(soname='libwrong.so.1'))
        self.refused(*self.fixture.collect(), 'LDD_SONAME_DIFFERS_FROM_ELF')

    def test_duplicate_ldd_names_paths_and_vdso_refuse(self):
        good = self.fixture.ldd(collector.LDD_INPUTS[0])['stdout']
        for row, code in [(good.splitlines()[1], 'LDD_DUPLICATE_SONAME'),
                          (good.splitlines()[-1], 'LDD_DUPLICATE_DIRECT_PATH'),
                          (good.splitlines()[0], 'LDD_DUPLICATE_VDSO')]:
            with self.subTest(code=code):
                with self.assertRaisesRegex(collector.Refusal, code):
                    collector.parse_ldd(good + row + '\n')

    def test_non_system_ldd_path_refuses(self):
        self.fixture.command_change = lambda _, value: dict(value, stdout=value['stdout'].replace(
            '/lib/x86_64-linux-gnu/libc.so.6', '/tmp/libc.so.6'))
        self.refused(*self.fixture.collect(), 'LDD_NON_SYSTEM_PATH')

    def test_library_inode_replacement_refuses(self):
        replaced = False
        def change(path, _):
            nonlocal replaced
            if path == LIBA and not replaced:
                replaced = True
                actual = self.fixture.root / path.lstrip('/')
                actual.rename(actual.with_suffix('.old'))
                self.fixture.write(path, elf_bytes(soname='libfixtureA.so.1'))
        self.fixture.handle_change = change
        self.refused(*self.fixture.collect(), 'OPEN_FILE_OR_ENTRY_CHANGED')

    def test_alias_changed_after_observation_refuses(self):
        def change(alias, count):
            if alias.endswith('/libfixtureA.so.1') and count > 4:
                return dict(alias=alias, canonicalPath=LIBA, links=[])
            return None
        self.fixture.alias_change = change
        self.refused(*self.fixture.collect(), 'LIBRARY_ALIAS_CHANGED')

    def test_target_state_change_refuses(self):
        self.fixture.target_change = lambda count, value: dict(value, stopped=count == 1)
        self.refused(*self.fixture.collect(), 'TARGET_STATE_CHANGED_DURING_DEPENDENCY_OBSERVATION')

    def test_expiry_and_clock_rollback_during_collection_refuse(self):
        for time in (NOW + timedelta(days=1), NOW - timedelta(seconds=1)):
            with self.subTest(time=time):
                self.refused(*self.fixture.collect(clock=lambda: time),
                    'OBSERVATION_EXPIRED_OR_CLOCK_ROLLBACK_DURING_COLLECTION')

    def test_invalid_and_expired_source_bindings_refuse_before_commands(self):
        cases = [(dict(repositoryId='1'), 'TARGET_OBSERVATION_BINDING_MISMATCH'),
                 (dict(expiresAt=NOW.isoformat()), 'TARGET_OBSERVATION_EXPIRED'),
                 (dict(recordedAt=(NOW + timedelta(seconds=1)).isoformat()), 'TARGET_OBSERVATION_EXPIRED'),
                 (dict(host=dict(system='Windows', arch='x86_64')), 'TARGET_PLATFORM_MISMATCH'),
                 (dict(files=[]), 'INSTALLED_OBSERVATION_SET_INVALID'),
                 (dict(neverStartedOfflineUpgrade=dict(eligible=False)), 'TARGET_OBSERVATION_REQUIRES_REVIEW')]
        for changes, code in cases:
            with self.subTest(code=code):
                self.fixture.calls.clear()
                self.refused(*self.fixture.collect(observation=dict(self.fixture.observation, **changes)), code)
                self.assertEqual(self.fixture.calls, [])

    def test_clean_environment_used_even_with_ld_in_parent(self):
        class NotExecuted(Exception):
            pass
        with patch.dict(os.environ, {'LD_PRELOAD': '/tmp/untrusted.so', 'LD_LIBRARY_PATH': '/tmp',
                                     'BASH_ENV': '/tmp/untrusted-bash', 'GH_TOKEN': 'nonsecret-fixture-token'}), \
             patch.object(collector.subprocess, 'Popen', side_effect=NotExecuted) as start:
            with self.assertRaises(NotExecuted):
                collector.run_ldd(collector.LDD_INPUTS[0])
            self.assertEqual(start.call_args.args[0], ['/usr/bin/ldd', '--', collector.LDD_INPUTS[0]])
            self.assertEqual(start.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
            self.assertEqual(start.call_args.kwargs['cwd'], '/')
            self.assertTrue(start.call_args.kwargs['close_fds'])

    def test_spawn_failure_is_reported_without_a_fabricated_exit_status(self):
        for error in (FileNotFoundError(errno.ENOENT, 'fixture missing'),
                      PermissionError(errno.EACCES, 'fixture denied')):
            with self.subTest(errno=error.errno), patch.object(collector.subprocess, 'Popen', side_effect=error):
                result = collector.run_ldd(collector.LDD_INPUTS[0])
            self.assertEqual(result['argv'], ['/usr/bin/ldd', '--', collector.LDD_INPUTS[0]])
            self.assertEqual(result['spawnError'], errno.errorcode[error.errno])
            self.assertIsNone(result['status'])
            self.assertIsNone(result['signal'])
            self.assertEqual(result['stdoutHex'], '')
            self.assertEqual(result['stderrHex'], '')

    def test_runner_preserves_exact_pipe_bytes_without_running_a_process(self):
        class PipesOnly:
            def __init__(self):
                self.pid, self.returncode = 987654321, None
                self.stdout = self.pipe(b'fixture stdout\n')
                self.stderr = self.pipe(b'fixture stderr\n')
            def pipe(self, content):
                read, write = os.pipe()
                os.write(write, content)
                os.close(write)
                return os.fdopen(read, 'rb', buffering=0)
            def wait(self, timeout):
                self.returncode = 3
                return self.returncode
            def poll(self):
                return self.returncode
        with patch.object(collector.subprocess, 'Popen', side_effect=lambda *args, **kwargs: PipesOnly()):
            result = collector.run_ldd(collector.LDD_INPUTS[0])
        self.assertEqual(result['stdoutHex'], b'fixture stdout\n'.hex())
        self.assertEqual(result['stderrHex'], b'fixture stderr\n'.hex())
        self.assertEqual(result['status'], 3)
        self.assertFalse(result['timedOut'])

    def test_runner_timeout_terminates_only_mocked_owned_process_group(self):
        class PipesOnly:
            def __init__(self):
                self.pid, self.returncode = 987654321, None
                self.writers = []
                self.stdout, self.stderr = self.pipe(), self.pipe()
            def pipe(self):
                read, write = os.pipe()
                self.writers.append(write)
                return os.fdopen(read, 'rb', buffering=0)
            def wait(self, timeout):
                self.returncode = -9
                for fd in self.writers:
                    os.close(fd)
                self.writers.clear()
                return self.returncode
            def poll(self):
                return self.returncode
        with patch.object(collector.subprocess, 'Popen', side_effect=lambda *args, **kwargs: PipesOnly()), \
             patch.object(collector.time, 'monotonic', side_effect=(0, 21, 21, 21)), \
             patch.object(collector.os, 'killpg') as kill:
            result = collector.run_ldd(collector.LDD_INPUTS[0])
        self.assertTrue(result['timedOut'])
        self.assertEqual(result['status'], -9)
        self.assertEqual(result['signal'], 9)
        kill.assert_called_once_with(987654321, 9)

    def test_broker_executor_and_arbitrary_ldd_inputs_rejected_before_process(self):
        with patch.object(collector.subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as start:
            for path in (collector.BROKER, '/usr/lib/openslack-cleanup/executor.mjs', '/tmp/node'):
                with self.subTest(path=path), self.assertRaisesRegex(collector.Refusal, 'LDD_INPUT_NOT_FIXED'):
                    collector.run_ldd(path)
            start.assert_not_called()

    def test_strict_json_duplicate_and_escaped_keys_invalid_utf8_and_constants(self):
        for payload in (b'{"key":1,"key":2}', b'{"key":1,"\\u006bey":2}', b'\xff', b'{"x":NaN}'):
            with self.subTest(payload=payload), self.assertRaises(collector.Refusal):
                collector.strict_json(payload)

    def test_malformed_elf_and_arbitrary_interpreter_refuse_without_command(self):
        for content, code in [(b'not ELF' + bytes(100), 'ELF64_LITTLE_ENDIAN_REQUIRED'),
                              (elf_bytes(interpreter='/tmp/loader'), 'ELF_INTERPRETER_NOT_SYSTEM_GLIBC')]:
            with self.subTest(code=code):
                self.fixture.write(collector.LDD_INPUTS[0], content, mode=0o755)
                self.fixture.refresh_observation()
                self.fixture.calls.clear()
                self.refused(*self.fixture.collect(), code)
                self.assertEqual(self.fixture.calls, [])

    def test_expected_system_aliases_canonicalize_to_usr_lib(self):
        resolved = self.fixture.resolve(self.fixture.root, '/lib64/ld-linux-x86-64.so.2', HELPER)
        self.assertEqual(resolved['canonicalPath'], LOADER)
        self.assertEqual(len(resolved['links']), 2)
        self.assertEqual([row['path'] for row in resolved['links']],
            ['/lib64', '/usr/lib64/ld-linux-x86-64.so.2'])

    def test_symlink_then_parent_uses_real_resolution_not_lexical_normalization(self):
        self.fixture.write('/usr/lib/canonical/libfixtureA.so.1', b'wrong lexical target')
        actual = self.fixture.write('/usr/lib/other/libfixtureA.so.1', elf_bytes(soname='libfixtureA.so.1'))
        (self.fixture.root / 'usr/lib/other/deep').mkdir(mode=0o755)
        (self.fixture.root / 'usr/lib/canonical/redirect').symlink_to('../other/deep', target_is_directory=True)
        alias = self.fixture.root / 'usr/lib/libfixtureA.so.1'
        alias.symlink_to('canonical/redirect/../libfixtureA.so.1')
        resolution = self.fixture.resolve(self.fixture.root, '/usr/lib/libfixtureA.so.1', HELPER)
        self.assertEqual(resolution['canonicalPath'], '/' + str(alias.resolve().relative_to(self.fixture.root)))
        self.assertEqual(resolution['canonicalPath'], '/usr/lib/other/libfixtureA.so.1')
        self.assertEqual(alias.resolve(), actual)
        self.assertNotEqual(hashlib.sha256(alias.read_bytes()).hexdigest(),
            hashlib.sha256((self.fixture.root / 'usr/lib/canonical/libfixtureA.so.1').read_bytes()).hexdigest())
        def change(_, value):
            value['stdout'] = value['stdout'].replace('/lib/x86_64-linux-gnu/libfixtureA.so.1',
                '/usr/lib/libfixtureA.so.1')
            value['stdoutHex'] = value['stdout'].encode().hex()
            return value
        self.fixture.command_change = change
        raw, inventory = self.fixture.collect()
        self.assertIsNotNone(inventory, raw['blockingReasons'])
        bound = next(file for file in inventory['files'] if file['path'] == '/usr/lib/other/libfixtureA.so.1')
        self.assertEqual(bound['sha256'], hashlib.sha256(alias.read_bytes()).hexdigest())
        self.assertFalse(any(file['path'] == '/usr/lib/canonical/libfixtureA.so.1' for file in inventory['files']))

    def test_system_symlink_escape_and_loop_refused(self):
        for target, code in [('/tmp/untrusted.so', 'SYSTEM_LINK_ESCAPES_LIBRARY_ROOT'),
                             ('libalias.so.1', 'SYSTEM_SYMLINK_LIMIT_OR_LOOP')]:
            alias = self.fixture.root / 'usr/lib/libalias.so.1'
            if alias.is_symlink():
                alias.unlink()
            alias.symlink_to(target)
            with self.subTest(target=target), self.assertRaisesRegex(collector.Refusal, code):
                self.fixture.resolve(self.fixture.root, '/usr/lib/libalias.so.1', HELPER)

    def test_sensitive_library_path_is_refused_before_any_file_open(self):
        for alias in ('/usr/lib/credentials/material', '/usr/lib/secrets/material', '/usr/lib/.env',
                      '/usr/lib/private.pem', '/usr/lib/private.key'):
            with self.subTest(alias=alias), \
                 patch.object(HELPER, 'AnchoredPath', side_effect=AssertionError('must not open')) as open_path:
                with self.assertRaisesRegex(collector.Refusal, 'NON_SYSTEM_LIBRARY_PATH'):
                    self.fixture.resolve(self.fixture.root, alias, HELPER)
                open_path.assert_not_called()

    def test_system_library_hardlink_world_write_and_owner_refused(self):
        logical = '/usr/lib/hardlink.so.1'
        actual = self.fixture.write(logical, elf_bytes())
        os.link(actual, actual.with_suffix('.copy'))
        with self.assertRaisesRegex(collector.Refusal, 'SYSTEM_PATH_TYPE_OR_HARDLINK_INVALID'):
            self.fixture.resolve(self.fixture.root, logical, HELPER)
        actual.with_suffix('.copy').unlink()
        actual.chmod(0o666)
        with self.assertRaisesRegex(collector.Refusal, 'SYSTEM_PATH_MODE_UNTRUSTED'):
            self.fixture.resolve(self.fixture.root, logical, HELPER)
        actual.chmod(0o644)
        with self.assertRaisesRegex(collector.Refusal, 'SYSTEM_ROOT_UNTRUSTED'):
            collector.canonical_system_file(self.fixture.root, logical, HELPER, expected_owner=(-1, -1))

    def test_verified_file_refuses_fifo_without_blocking_symlink_hardlink_and_bounds(self):
        logical = '/usr/lib/owned-read-fixture'
        actual = self.fixture.root / logical.lstrip('/')
        os.mkfifo(actual)
        with self.assertRaisesRegex(collector.Refusal, 'NON_REGULAR_LINKED_OR_UNBOUNDED_FILE'):
            with collector.VerifiedFile(self.fixture.root, logical, 1000, HELPER, expected_owner=OWNER):
                self.fail('FIFO must refuse')
        actual.unlink()
        actual.symlink_to('x86_64-linux-gnu/libc.so.6')
        with self.assertRaises(OSError):
            with collector.VerifiedFile(self.fixture.root, logical, 1000, HELPER, expected_owner=OWNER):
                self.fail('symlink must refuse')
        actual.unlink()
        self.fixture.write(logical, b'x' * 10)
        with self.assertRaisesRegex(collector.Refusal, 'NON_REGULAR_LINKED_OR_UNBOUNDED_FILE'):
            with collector.VerifiedFile(self.fixture.root, logical, 9, HELPER, expected_owner=OWNER):
                self.fail('bound must refuse')
        os.link(actual, actual.with_suffix('.copy'))
        with self.assertRaisesRegex(collector.Refusal, 'NON_REGULAR_LINKED_OR_UNBOUNDED_FILE'):
            with collector.VerifiedFile(self.fixture.root, logical, 20, HELPER, expected_owner=OWNER):
                self.fail('hardlink must refuse')

    def test_parent_directory_replacement_and_final_inode_replacement_refuse(self):
        logical = '/usr/lib/replaced/file'
        actual = self.fixture.write(logical, b'original')
        with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=OWNER) as file:
            actual.parent.rename(actual.parent.with_name('previous'))
            self.fixture.write(logical, b'replacement')
            with self.assertRaises(HELPER.ObservationFailure):
                file.unchanged()
        logical = '/usr/lib/inode-file'
        actual = self.fixture.write(logical, b'original')
        with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=OWNER) as file:
            actual.rename(actual.with_suffix('.old'))
            self.fixture.write(logical, b'original')
            with self.assertRaisesRegex(collector.Refusal, 'OPEN_FILE_OR_ENTRY_CHANGED'):
                file.unchanged()

    def test_fstat_faults_close_every_acquired_descriptor(self):
        logical = '/usr/lib/x86_64-linux-gnu/libc.so.6'
        real_fstat = os.fstat
        total = 0
        def counting(fd):
            nonlocal total
            total += 1
            return real_fstat(fd)
        with patch.object(os, 'fstat', side_effect=counting):
            with collector.VerifiedFile(self.fixture.root, logical, 4096, HELPER, expected_owner=OWNER):
                pass
        for failed_index in range(1, total + 1):
            with self.subTest(index=failed_index):
                before = len(os.listdir('/proc/self/fd'))
                count = 0
                def failing(fd):
                    nonlocal count
                    count += 1
                    if count == failed_index:
                        raise OSError('nonsecret injected fstat fault')
                    return real_fstat(fd)
                with patch.object(os, 'fstat', side_effect=failing), self.assertRaises(OSError):
                    with collector.VerifiedFile(self.fixture.root, logical, 4096, HELPER, expected_owner=OWNER):
                        pass
                self.assertEqual(len(os.listdir('/proc/self/fd')), before)

    def test_verified_owner_and_mode_refuse(self):
        logical = '/usr/lib/unsafe-mode'
        actual = self.fixture.write(logical, b'fixture', mode=0o664)
        with self.assertRaisesRegex(collector.Refusal, 'UNTRUSTED_FILE_OWNER_OR_MODE'):
            with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=OWNER):
                self.fail('group writable must refuse')
        actual.chmod(0o644)
        with self.assertRaisesRegex(collector.Refusal, 'UNTRUSTED_(?:FILE|ANCESTOR)_OWNER_OR_MODE'):
            with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=(-1, -1)):
                self.fail('wrong owner must refuse')

    def test_sticky_evidence_parent_exception_never_applies_to_execution_paths(self):
        logical = '/tmp/private/source.json'
        self.fixture.write(logical, b'{}')
        (self.fixture.root / 'tmp').chmod(0o1777)
        (self.fixture.root / 'tmp/private').chmod(0o700)
        with self.assertRaisesRegex(collector.Refusal, 'UNTRUSTED_ANCESTOR_OWNER_OR_MODE'):
            with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=OWNER):
                self.fail('default execution policy rejects sticky/writable directory')
        with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=OWNER,
            allow_sticky_evidence_ancestors=True) as file:
            self.assertEqual(file.read_all(), b'{}')
        (self.fixture.root / 'tmp/private').chmod(0o777)
        with self.assertRaisesRegex(collector.Refusal, 'UNTRUSTED_ANCESTOR_OWNER_OR_MODE'):
            with collector.VerifiedFile(self.fixture.root, logical, 100, HELPER, expected_owner=OWNER,
                allow_sticky_evidence_ancestors=True):
                self.fail('only exact sticky parent exception; child still must be trusted')

    def test_frozen_helper_tamper_and_wrong_name_refuse(self):
        helper = self.fixture.outer / collector.HELPER_NAME
        helper.write_bytes(b'# nonsecret tampered helper\n')
        with self.assertRaisesRegex(collector.Refusal, 'FROZEN_HELPER_DIGEST_MISMATCH'):
            collector.load_frozen_helper(helper)
        with self.assertRaisesRegex(collector.Refusal, 'FROZEN_HELPER_NAME_MISMATCH'):
            collector.load_frozen_helper(self.fixture.outer / 'wrong.py')

    def test_nonroot_main_stops_before_read_spawn_or_publication(self):
        args = ['collector', '--observation', '/var/tmp/source.json', '--raw-output', '/var/tmp/raw.json',
                '--inventory-output', '/var/tmp/inventory.json']
        with patch('sys.argv', args), patch.object(os, 'geteuid', return_value=1000), \
             patch.object(collector, 'load_frozen_helper', side_effect=AssertionError('must not read')) as read, \
             patch.object(collector.subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as start:
            with self.assertRaisesRegex(collector.Refusal, 'LINUX_ROOT_OBSERVER_REQUIRED'):
                collector.main()
            read.assert_not_called()
            start.assert_not_called()


if __name__ == '__main__':
    run_tests(sys.modules[__name__])
