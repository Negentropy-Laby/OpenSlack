"""Non-sensitive owned fixtures; no real target, credentials or network."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).parent

def load(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), BASE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class PlatformBoundaryTests(unittest.TestCase):
    def test_target_refuses_before_linux_only_imports(self):
        code = '''import builtins,runpy,sys
sys.platform='win32'
original=builtins.__import__
def guarded(name,*args,**kwargs):
 if name in ('pwd','grp'): raise ImportError('Linux-only import attempted')
 return original(name,*args,**kwargs)
builtins.__import__=guarded
sys.argv=[sys.argv[1],'--output',sys.argv[2]]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as own:
            output = Path(own) / 'no evidence.json'
            result = subprocess.run([sys.executable, '-I', '-B', '-c', code,
                str(BASE / 'target-observation.py'), str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('LINUX_DESCRIPTOR_CAPABILITY_REQUIRED', result.stderr)
            self.assertNotIn('Linux-only import attempted', result.stderr)
            self.assertFalse(output.exists())

class AdministrationBehaviorTests(unittest.TestCase):
    def test_backup_refuses_history_before_output_creation(self):
        backup = load('offline-backup')
        with tempfile.TemporaryDirectory() as own:
            root = Path(own) / 'root'
            root.mkdir(mode=0o700)
            state = root / 'var/lib/openslack-cleanup'
            state.mkdir(parents=True, mode=0o700)
            (state / 'ledger.jsonl').write_text('preserved history\n')
            output = Path(own) / 'new backup'
            result = backup.prepare_backup(root=root, output=output, owner=(os.geteuid(), os.getegid()),
                process_observer=lambda _: {'state':'stopped'}, lock_observer=lambda *_: {'state':'none-observed'})
            self.assertEqual(result['result'], 'BLOCKED')
            self.assertIn('UNEXPECTED_PERSISTENT_HISTORY', result['blockingReasons'])
            self.assertFalse(output.exists())
            self.assertEqual((state / 'ledger.jsonl').read_text(), 'preserved history\n')

    def test_post_start_cannot_pass_with_missing_runtime_objects(self):
        isolation = load('isolation')
        report = isolation.evaluate('post-start', identities={'broker':{'uid':44180,'gid':44180,'groupIds':[44180],'shell':'/usr/sbin/nologin'},
                'agent':{'uid':44181,'gid':44181,'groupIds':[44181],'shell':'/usr/sbin/nologin'}},
            probes=[{'id':item['id'],'expected':item['expected'],'observed':'missing'}
                    for item in isolation.PROBES],
            privilege={'verified':True, 'blockingReasons':[]})
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('RUNTIME_OBJECT_MISSING', report['blockingReasons'])
        self.assertNotIn('VACUOUS', json.dumps(report))

    def test_first_start_rejects_nonempty_generation(self):
        instance = load('inspect-instance')
        record = dict(schema='openslack.cleanup_broker_instance.v1', brokerId='cleanup-broker-pr418',
            workspaceId='openslack-self', bootNonce='a'*64, generation='1',
            startedAt='2026-10-11T12:00:00+00:00')
        with self.assertRaisesRegex(instance.common.Refusal, 'FIRST_START_GENERATION_NOT_EMPTY'):
            instance.validate_instance(record, first_start=True)


class OwnedInstallation:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cleanup-administration-', dir='/var/tmp')
        self.outer = Path(self.temporary.name)
        self.root = self.outer / 'owned target with spaces'
        self.root.mkdir(mode=0o700)
        (self.root / 'run').mkdir(mode=0o755)
        self.parent = self.outer / 'private evidence'
        self.parent.mkdir(mode=0o700)
        self.backup = load('offline-backup')
        self.common = self.backup.common
        for logical, (_, mode) in self.common.LAYOUT.items():
            path = self.root / logical.lstrip('/')
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            path.write_bytes(('owned non-executable fixture: ' + logical).encode())
            path.chmod(mode)
        for logical, data in [('/etc/openslack-cleanup/broker.json', b'{"nonsecret":"fixture"}\n'),
            ('/etc/openslack-cleanup/task-dependencies.json', b'{"nonsecret":"fixture"}\n')]:
            path = self.root / logical.lstrip('/')
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
            path.write_bytes(data)
            path.chmod(0o640)
        state = self.root / 'var/lib/openslack-cleanup'
        state.mkdir(parents=True, mode=0o700)
        self.process = lambda _: {'state':'stopped'}
        self.locks = lambda *_: {'state':'none-observed'}

    def run(self, output=None):
        return self.backup.prepare_backup(root=self.root, output=output or self.parent / 'new backup',
            owner=(os.geteuid(), os.getegid()), process_observer=self.process, lock_observer=self.locks)

    def close(self):
        self.temporary.cleanup()

class BackupFixtureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = OwnedInstallation()
        self.addCleanup(self.fixture.close)

    def test_installed_binary_flock_blocks_backup_without_history(self):
        import fcntl
        helper = load('target-observation')
        binary = self.fixture.root / 'usr/lib/openslack-cleanup/node'
        with binary.open('rb') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Capture actual kernel metadata into the isolated /proc fixture;
            # absence of /proc/locks must not accidentally pass this regression.
            proc = self.fixture.root / 'proc'
            proc.mkdir(mode=0o755)
            (proc / 'locks').write_text(Path('/proc/locks').read_text())
            info = os.fstat(handle.fileno())
            observed = helper.observe_locks(self.fixture.root, [dict(
                path='/usr/lib/openslack-cleanup/node', dev=str(info.st_dev), ino=str(info.st_ino))])
            self.assertEqual(observed['state'], 'held', observed)
            self.fixture.locks = helper.observe_locks
            result = self.fixture.run()
        self.assertEqual(result['result'], 'BLOCKED', result)
        self.assertIn('LOCKS_NOT_CONFIRMED_ABSENT', result['blockingReasons'])
        self.assertFalse((self.fixture.parent / 'new backup').exists())

    def test_observer_rejects_nonprivate_output_parent_without_creation(self):
        helper = load('target-observation')
        parent = self.fixture.outer / 'shared-observation'
        parent.mkdir(mode=0o750)
        output = parent / 'observation.json'
        with self.assertRaises(helper.ObservationFailure):
            helper.publish(output, b'{}\n')
        self.assertFalse(output.exists())

    def test_dependency_cli_refuses_sensitive_inputs_before_helper_read(self):
        tool = load('dependency-inventory')
        for name in ['.ssh', '.AWS', '.env.local', '.ENV']:
            with self.subTest(name=name), patch.object(os, 'geteuid', return_value=0), \
                    patch.object(sys, 'argv', ['dependency-inventory', '--observation',
                        f'/var/tmp/{name}/input.json', '--raw-output', '/var/tmp/raw.json',
                        '--inventory-output', '/var/tmp/inventory.json']), \
                    patch.object(tool, 'load_frozen_helper', side_effect=AssertionError('input opened')):
                with self.assertRaises(tool.Refusal):
                    tool.main()

    def test_complete_fixed_allowlist_dual_sync_and_backup_local_restore(self):
        real_sync = os.fsync
        calls = []
        def synced(fd):
            calls.append(os.fstat(fd).st_mode)
            return real_sync(fd)
        with patch.object(os, 'fsync', side_effect=synced):
            report = self.fixture.run()
        self.assertEqual(report['result'], 'PASS', report)
        self.assertTrue(report['restoreVerified'])
        self.assertFalse(report['activeTargetRestored'])
        self.assertFalse(report['credentialContentsRead'])
        self.assertEqual({item['path'] for item in report['files']}, set(self.fixture.common.LAYOUT) | {
            '/etc/openslack-cleanup/broker.json', '/etc/openslack-cleanup/task-dependencies.json'})
        self.assertTrue(any(__import__('stat').S_ISREG(mode) for mode in calls))
        self.assertTrue(any(__import__('stat').S_ISDIR(mode) for mode in calls))
        out = self.fixture.parent / 'new backup'
        for item in report['files']:
            self.assertEqual((out / item['backupRelativePath']).read_bytes(),
                (out / item['restoreRelativePath']).read_bytes())
            self.assertEqual((self.fixture.root / item['path'].lstrip('/')).read_bytes(),
                (out / item['backupRelativePath']).read_bytes())

    def test_unlisted_and_sensitive_files_are_not_opened_or_backed_up(self):
        directory = self.fixture.root / 'etc/openslack-cleanup/credentials'
        directory.mkdir(mode=0o700)
        # No credential fixture bytes; a FIFO would block if incorrectly opened for reading.
        os.mkfifo(directory / 'governance', 0o600)
        extra = self.fixture.root / 'usr/lib/openslack-cleanup/unlisted-note.txt'
        extra.write_text('ordinary unlisted file')
        report = self.fixture.run()
        self.assertEqual(report['result'], 'PASS', report)
        self.assertNotIn('credentials', json.dumps(report['files']))
        self.assertNotIn('unlisted-note', json.dumps(report['files']))

    def test_existing_output_never_overwritten(self):
        output = self.fixture.parent / 'existing'
        output.mkdir(mode=0o700)
        evidence = output / 'preserve.txt'
        evidence.write_text('owned previous evidence')
        report = self.fixture.run(output)
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertFalse(report['outputCreated'])
        self.assertEqual(evidence.read_text(), 'owned previous evidence')

    def test_runtime_or_process_or_locks_stop_before_creation(self):
        cases = ['runtime', 'process', 'locks']
        for case in cases:
            with self.subTest(case=case):
                fixture = OwnedInstallation()
                try:
                    if case == 'runtime':
                        runtime = fixture.root / 'run/openslack-cleanup'
                        runtime.mkdir(parents=True, mode=0o755)
                        (runtime / 'instance.lock').write_text('existing runtime')
                    elif case == 'process':
                        fixture.process = lambda _: {'state':'running'}
                    else:
                        fixture.locks = lambda *_: {'state':'unknown'}
                    report = fixture.run()
                    self.assertEqual(report['result'], 'BLOCKED', report)
                    self.assertFalse(report['outputCreated'])
                    self.assertFalse((fixture.parent / 'new backup').exists())
                finally:
                    fixture.close()

    def test_parent_directory_link_refuses_without_external_creation(self):
        old = self.fixture.root / 'usr/lib/openslack-cleanup'
        external = self.fixture.outer / 'external'
        old.rename(external)
        old.symlink_to(external, target_is_directory=True)
        report = self.fixture.run()
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertFalse(report['outputCreated'])
        self.assertFalse((self.fixture.parent / 'new backup').exists())

    def test_partial_and_zero_writes_and_fsync_failure(self):
        real_write = os.write
        with patch.object(os, 'write', side_effect=lambda fd, data: real_write(fd, data[:3])):
            report = self.fixture.run(self.fixture.parent / 'partial writes')
        self.assertEqual(report['result'], 'PASS', report)
        with patch.object(os, 'write', return_value=0):
            report = self.fixture.run(self.fixture.parent / 'zero progress')
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('WRITE_NO_PROGRESS', report['blockingReasons'])
        with patch.object(os, 'fsync', side_effect=OSError(5, 'owned injected sync error')):
            report = self.fixture.run(self.fixture.parent / 'sync failure')
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertFalse(report['restoreVerified'])
        self.assertTrue(report['outputCreated'])
        self.assertTrue(report['preservePartialOutput'])
        self.assertTrue((self.fixture.parent / 'sync failure').exists())

    def test_source_replacement_during_copy_refuses_and_preserves_partial(self):
        original = self.fixture.backup.copy_checked
        replaced = False
        def copy(source, *args):
            nonlocal replaced
            result = original(source, *args)
            if not replaced:
                replaced = True
                physical = self.fixture.root / source.logical.lstrip('/')
                alternative = physical.with_name('replacement-fixture')
                alternative.write_bytes(physical.read_bytes())
                alternative.chmod(0o755)
                os.replace(alternative, physical)
            return result
        with patch.object(self.fixture.backup, 'copy_checked', side_effect=copy):
            report = self.fixture.run()
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('FILE_CHANGED', report['blockingReasons'])
        self.assertTrue(report['preservePartialOutput'])

    def test_changed_offline_state_after_copy_refuses_without_reset(self):
        original = self.fixture.backup.copy_checked
        changed = False
        ledger = self.fixture.root / 'var/lib/openslack-cleanup/ledger.jsonl'
        def copy(source, *args):
            nonlocal changed
            result = original(source, *args)
            if not changed:
                changed = True
                ledger.write_text('new history must be retained')
            return result
        with patch.object(self.fixture.backup, 'copy_checked', side_effect=copy):
            report = self.fixture.run()
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertEqual(ledger.read_text(), 'new history must be retained')
        self.assertIn('UNEXPECTED_PERSISTENT_HISTORY', report['blockingReasons'])

    def test_backup_subdirectory_replacement_after_copy_preserves_partial_and_refuses(self):
        for name in ('files', 'restore-verification'):
            with self.subTest(name=name):
                fixture = OwnedInstallation()
                try:
                    output = fixture.parent / 'new backup'
                    calls = 0
                    def stopped(_):
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            (output / name).rename(output / (name + '-retained'))
                            (output / name).mkdir(mode=0o700)
                        return {'state': 'stopped'}
                    fixture.process = stopped
                    report = fixture.run()
                    self.assertEqual(report['result'], 'BLOCKED', report)
                    self.assertFalse(report['restoreVerified'])
                    self.assertIn('BACKUP_DIRECTORY_CHANGED', report['blockingReasons'])
                    self.assertTrue(report['preservePartialOutput'])
                    self.assertTrue((output / (name + '-retained') / '00.bin').is_file())
                    self.assertEqual(list((output / name).iterdir()), [])
                finally:
                    fixture.close()

    def test_absent_optional_file_appearing_after_copy_refuses_and_preserves(self):
        for logical in sorted(self.fixture.backup.OPTIONAL):
            with self.subTest(logical=logical):
                fixture = OwnedInstallation()
                try:
                    path = fixture.root / logical.lstrip('/')
                    if path.exists():
                        path.unlink()
                    calls = 0
                    def stopped(_):
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            path.write_text('new nonsecret configuration must be preserved')
                            path.chmod(0o600)
                        return {'state': 'stopped'}
                    fixture.process = stopped
                    report = fixture.run()
                    self.assertEqual(report['result'], 'BLOCKED', report)
                    self.assertFalse(report['restoreVerified'])
                    self.assertIn('ABSENT_OPTIONAL_FILE_CHANGED', report['blockingReasons'])
                    self.assertTrue(report['preservePartialOutput'])
                    self.assertEqual(path.read_text(), 'new nonsecret configuration must be preserved')
                finally:
                    fixture.close()

    def test_absent_optional_link_directory_or_fifo_appearing_refuses_without_open(self):
        for kind in ('link', 'directory', 'fifo'):
            with self.subTest(kind=kind):
                fixture = OwnedInstallation()
                try:
                    path = fixture.root / 'usr/lib/openslack-cleanup/install-manifest.json'
                    calls = 0
                    def stopped(_):
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            if kind == 'link':
                                path.symlink_to('unknown-nonsecret-link-target')
                            elif kind == 'directory':
                                path.mkdir(mode=0o700)
                            else:
                                os.mkfifo(path, 0o600)
                        return {'state': 'stopped'}
                    fixture.process = stopped
                    report = fixture.run()
                    self.assertEqual(report['result'], 'BLOCKED')
                    self.assertIn('ABSENT_OPTIONAL_FILE_CHANGED', report['blockingReasons'])
                    self.assertFalse(report['restoreVerified'])
                    self.assertTrue(report['preservePartialOutput'])
                    self.assertTrue(path.is_symlink() or path.exists())
                finally:
                    fixture.close()

    def test_optional_unreadable_or_unverified_parent_never_counts_as_missing(self):
        original_open = os.open
        def denied(name, *args, **kwargs):
            if name == 'install-manifest.json':
                raise PermissionError(13, 'owned fixture permission refusal')
            return original_open(name, *args, **kwargs)
        with patch.object(os, 'open', side_effect=denied):
            report = self.fixture.run()
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('EACCES', report['blockingReasons'])
        self.assertFalse(report['outputCreated'])
        self.assertNotIn('/usr/lib/openslack-cleanup/install-manifest.json', report['absentOptionalFiles'])
        directory = self.fixture.root / 'etc/openslack-cleanup'
        directory.rename(directory.with_name('retained-nonsecret-config'))
        report = self.fixture.run()
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('OPTIONAL_PARENT_UNVERIFIED', report['blockingReasons'])
        self.assertFalse(report['outputCreated'])

    def test_fifo_hardlink_oversize_and_mode_refuse_before_output(self):
        for case in ['fifo', 'hardlink', 'mode']:
            with self.subTest(case=case):
                fixture = OwnedInstallation()
                try:
                    path = fixture.root / 'usr/lib/openslack-cleanup/executor.mjs'
                    if case == 'fifo':
                        path.unlink()
                        os.mkfifo(path, 0o644)
                    elif case == 'hardlink':
                        os.link(path, path.with_name('hardlinked-owned-fixture'))
                    else:
                        path.chmod(0o666)
                    report = fixture.run()
                    self.assertEqual(report['result'], 'BLOCKED')
                    self.assertFalse(report['outputCreated'])
                finally:
                    fixture.close()

class SafetyFixtureTests(unittest.TestCase):
    def setUp(self):
        self.common = load('_safety')

    def test_each_fstat_fault_closes_every_acquired_fd(self):
        with tempfile.TemporaryDirectory(prefix='cleanup-fstat-', dir='/var/tmp') as own:
            directory = Path(own) / 'one/two'
            directory.mkdir(parents=True, mode=0o700)
            logical = str(directory / 'new record.json')
            original_open, original_close, original_fstat = os.open, os.close, os.fstat
            for fail_at in range(1, 15):
                with self.subTest(fail_at=fail_at):
                    acquired, closed, calls = [], [], [0]
                    def opened(*args, **kwargs):
                        fd = original_open(*args, **kwargs)
                        acquired.append(fd)
                        return fd
                    def closed_fd(fd):
                        closed.append(fd)
                        return original_close(fd)
                    def inspected(fd):
                        calls[0] += 1
                        if calls[0] == fail_at:
                            raise OSError(5, 'owned fstat fault')
                        return original_fstat(fd)
                    with patch.object(os, 'open', side_effect=opened), patch.object(os, 'close', side_effect=closed_fd), \
                         patch.object(os, 'fstat', side_effect=inspected):
                        try:
                            with self.common.Anchor(Path('/'), logical, sticky_evidence=True):
                                pass
                        except OSError:
                            pass
                    self.assertCountEqual(acquired, closed)

    def test_primary_and_cleanup_failure_both_retained(self):
        real_close = os.close
        fd = os.open('/dev/null', os.O_RDONLY)
        def close_fault(value):
            real_close(value)
            raise OSError(5, 'owned close fault')
        primary = self.common.Refusal('PRIMARY_FAILED')
        owner = self.common.Owned()
        owner.add(fd)
        with patch.object(os, 'close', side_effect=close_fault):
            with self.assertRaises(self.common.Refusal) as raised:
                owner.close(primary)
        self.assertEqual(raised.exception.code, 'PRIMARY_FAILED')
        self.assertEqual(raised.exception.cleanup, ['EIO'])

    def test_bounded_read_rejects_fifo_hardlink_and_invalid_json(self):
        with tempfile.TemporaryDirectory(prefix='cleanup-bounded-', dir='/var/tmp') as own:
            path = Path(own) / 'input.json'
            os.mkfifo(path, 0o600)
            with self.assertRaisesRegex(self.common.Refusal, 'UNSAFE_FILE_TYPE_OR_SIZE'):
                with self.common.ReadFile(Path('/'), str(path), 64, owners={(os.geteuid(), os.getegid())},
                    sticky_evidence=True):
                    self.fail('FIFO must never be read')
            path.unlink()
            path.write_bytes(b'{"key":1,"\\u006bey":2}')
            path.chmod(0o600)
            with self.assertRaisesRegex(self.common.Refusal, 'DUPLICATE_JSON_KEY'):
                self.common.strict_json(path.read_bytes())
            os.link(path, path.with_name('second'))
            with self.assertRaisesRegex(self.common.Refusal, 'UNSAFE_FILE_TYPE_OR_SIZE'):
                with self.common.ReadFile(Path('/'), str(path), 64, owners={(os.geteuid(), os.getegid())},
                    sticky_evidence=True):
                    self.fail('hardlink must never be read')

    def test_file_and_ancestor_close_failures_are_both_retained(self):
        with tempfile.TemporaryDirectory(prefix='cleanup-close-',dir='/var/tmp') as own:
            path=Path(own)/'input.json'
            path.write_bytes(b'{"ordinary":"fixture"}')
            path.chmod(0o600)
            held=self.common.ReadFile(Path('/'),str(path),64,owners={(os.geteuid(),os.getegid())},sticky_evidence=True)
            held.__enter__()
            file_fd,parent_fd=held.fd,held.anchor.parent
            real_close=os.close
            def closed(fd):
                real_close(fd)
                if fd==file_fd: raise OSError(5,'owned file close fault')
                if fd==parent_fd: raise OSError(9,'owned ancestor close fault')
            with patch.object(os,'close',side_effect=closed),self.assertRaises(self.common.Refusal) as raised:
                held.__exit__(None,None,None)
            self.assertIn('EIO',raised.exception.cleanup)
            self.assertIn('EBADF',raised.exception.cleanup)

    def test_sensitive_and_active_outputs_are_refused_before_writes(self):
        for path in ['/root/credentials/probe.json','/root/.env','/root/pem.key',
            '/var/lib/openslack-cleanup/clear.json','/etc/openslack-cleanup/replaced.json']:
            with self.subTest(path=path), patch.object(os, 'open') as opened:
                with self.assertRaises(self.common.Refusal):
                    self.common.publish(Path(path), {'nonsecret':'fixture'})
                opened.assert_not_called()

class IsolationFixtureTests(unittest.TestCase):
    def setUp(self):
        self.tool = load('isolation')
        self.ids = {'broker':{'uid':44180,'gid':44180,'groupIds':[44180],'shell':'/usr/sbin/nologin'},
            'agent':{'uid':44181,'gid':44181,'groupIds':[44181],'shell':'/usr/sbin/nologin'}}

    def rows(self, phase):
        return [{'id':item['id'],'expected':item['expected'],
            'observed':'missing' if phase == 'pre-start' and item['id'] in self.tool.RUNTIME_IDS else item['expected']}
            for item in self.tool.PROBES]

    def test_prestart_defers_only_runtime_poststart_requires_all(self):
        report = self.tool.evaluate('pre-start', identities=self.ids, probes=self.rows('pre-start'),
            privilege={'verified':True, 'blockingReasons':[]})
        self.assertEqual(report['result'], 'PASS', report)
        self.assertEqual(set(report['deferred']), self.tool.RUNTIME_IDS)
        report = self.tool.evaluate('post-start', identities=self.ids, probes=self.rows('post-start'),
            privilege={'verified':True,'blockingReasons':[]})
        self.assertEqual(report['result'], 'PASS', report)
        self.assertEqual(report['deferred'], [])

    def test_unexpected_prestart_history_and_missing_credential_block(self):
        rows = self.rows('pre-start')
        next(item for item in rows if item['id'] == 'read:ledger')['observed'] = 'deny'
        next(item for item in rows if item['id'] == 'read:governance-credential')['observed'] = 'missing'
        report = self.tool.evaluate('pre-start', identities=self.ids, probes=rows,
            privilege={'verified':True,'blockingReasons':[]})
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('UNEXPECTED_PRESTART_RUNTIME_OBJECT', report['blockingReasons'])
        self.assertIn('REQUIRED_OBJECT_MISSING', report['blockingReasons'])

    def test_privileged_or_unknown_groups_and_sudo_scope_block(self):
        for problem in ['broker-group','sudo-group','unknown-scope']:
            with self.subTest(problem=problem):
                ids = json.loads(json.dumps(self.ids))
                privilege = {'verified':True,'blockingReasons':[]}
                if problem == 'broker-group': ids['agent']['groupIds'].append(44180)
                elif problem == 'sudo-group': ids['agent']['groupIds'].append(27)
                else: privilege = {'verified':False,'blockingReasons':['SUDO_SCOPE_UNKNOWN']}
                report = self.tool.evaluate('post-start', identities=ids, probes=self.rows('post-start'), privilege=privilege)
                self.assertEqual(report['result'], 'BLOCKED')

    def test_changed_metadata_or_wrong_dropped_identity_block(self):
        counter = [0]
        def metadata(root, spec):
            counter[0] += 1
            return {'state':'present', 'path':spec['path'], 'ino':str(counter[0])}
        def access(paths):
            return {'uid':[44181]*4,'gid':[44181]*4,'supplementaryGroups':[],
                'access':{key:False for key,_,_ in paths}}
        report = self.tool.observe('post-start', identity_source=lambda:self.ids,
            access=access, metadata_source=metadata,
            privilege_observer=lambda **_: {'verified':True,'blockingReasons':[]})
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('ISOLATION_ACCESS_OR_METADATA_FAILED', report['blockingReasons'])
        report = self.tool.observe('post-start', identity_source=lambda:self.ids,
            access=lambda _: {'uid':[0]*4,'gid':[0]*4,'supplementaryGroups':[]},
            metadata_source=lambda root,spec:{'state':'present'},
            privilege_observer=lambda **_: {'verified':True,'blockingReasons':[]})
        self.assertEqual(report['result'], 'BLOCKED')
        self.assertIn('DROPPED_IDENTITY_MISMATCH', report['blockingReasons'])

class InstanceFixtureTests(unittest.TestCase):
    def setUp(self):
        self.tool = load('inspect-instance')
        self.record = dict(schema='openslack.cleanup_broker_instance.v1', brokerId='cleanup-broker-pr418',
            workspaceId='openslack-self', bootNonce='a'*64, generation='', startedAt='2026-10-11T12:00:00+00:00')

    def test_exact_schema_ids_nonce_generation_and_time(self):
        self.assertEqual(self.tool.validate_instance(self.record), self.record)
        for field, value in [('schema','wrong'),('brokerId','other'),('workspaceId','other'),
            ('bootNonce','invalid'),('generation','0'),('startedAt','not a time')]:
            with self.subTest(field=field):
                mutated = {**self.record,field:value}
                with self.assertRaises(self.tool.common.Refusal):
                    self.tool.validate_instance(mutated)
        with self.assertRaisesRegex(self.tool.common.Refusal, 'UNKNOWN_OR_MISSING'):
            self.tool.validate_instance({**self.record,'unknown':True})
        for value in ['0','-1','+2',' 2','0x10','1e2','2147483648']:
            with self.subTest(pid=value), self.assertRaises(self.tool.common.Refusal):
                self.tool.positive_pid(value)

    def test_fine_boot_clock_interval_and_clock_change_are_fail_closed(self):
        wall = 1_791_726_400_000_000_000
        values = iter([10_000_000_000, wall, 10_000_001_000])
        interval = self.tool.start_interval('950', 100, clock=lambda _:next(values))
        lower = self.tool.datetime.fromisoformat(interval['startedAtUtc'])
        upper = self.tool.datetime.fromisoformat(interval['startTimeUpperUtc'])
        self.assertEqual((upper - lower).total_seconds(), 0.010001)
        self.assertNotIn('one second', interval['startTimePrecision'])
        within = {**self.record, 'startedAt':lower.isoformat()}
        with self.assertRaisesRegex(self.tool.common.Refusal, 'INSTANCE_PROCESS_START_AMBIGUOUS'):
            self.tool.validate_start_binding(within, interval)
        self.tool.validate_start_binding({**self.record, 'startedAt':upper.isoformat()}, interval)
        shifted = {**interval, 'bootEpochLowerNs':str(int(interval['bootEpochLowerNs']) - 500_000_000),
            'bootEpochUpperNs':str(int(interval['bootEpochUpperNs']) - 500_000_000)}
        with self.assertRaisesRegex(self.tool.common.Refusal, 'PROCESS_CLOCK_CHANGED_OR_UNVERIFIED'):
            self.tool.validate_clock_continuity(interval, shifted)

    def test_actual_fixed_inode_hash_pid_and_empty_generation(self):
        with tempfile.TemporaryDirectory(prefix='cleanup-instance-', dir='/var/tmp') as own:
            root = Path(own)
            broker = root / 'usr/lib/openslack-cleanup/cleanup-broker'
            broker.parent.mkdir(parents=True, mode=0o755)
            broker.write_bytes(b'owned non-executable Broker fixture')
            broker.chmod(0o755)
            instance = root / 'var/lib/openslack-cleanup/instance.json'
            instance.parent.mkdir(parents=True, mode=0o700)
            instance.write_text(json.dumps(self.record))
            instance.chmod(0o600)
            digest = __import__('hashlib').sha256(broker.read_bytes()).hexdigest()
            proof = dict(pid=123,uid=[44180]*4,gid=[44180]*4,executable=self.tool.BROKER,comm='cleanup-broker',
                startTicks='10', startedAtUtc='2026-10-11T11:59:59.980000+00:00',
                startTimeUpperUtc='2026-10-11T11:59:59.990000+00:00', bootEpochLowerNs='100',
                bootEpochUpperNs='200', clockTicksPerSecond=100,
                supplementaryGroups=[], capabilities={'CapEff':'0','CapPrm':'0','CapAmb':'0'})
            def executable(pid, root, owner):
                return self.tool.common.row(self.tool.BROKER, broker.stat(), digest)
            reader = lambda *_: os.open('/dev/null', os.O_RDONLY)
            report = self.tool.inspect(123,digest,root=root,owner=(os.geteuid(),os.getegid()),
                broker_owner=(os.geteuid(),os.getegid()),process_reader=lambda *_,**__:proof,
                executable_reader=executable,pidfd_factory=reader,pidfd_alive=lambda _:True)
            self.assertEqual(report['result'], 'PASS', report)
            self.assertEqual(report['realNonce'], 'a'*64)
            self.assertFalse(report['brokerStarted'])
            for started in ['2026-10-11T12:01:00+00:00', '2026-10-11T12:00:00.500000+00:00']:
                with self.subTest(started=started):
                    stale_process = {**proof, 'startedAtUtc':started, 'startTimeUpperUtc':started}
                    stale = self.tool.inspect(123,digest,root=root,owner=(os.geteuid(),os.getegid()),
                        broker_owner=(os.geteuid(),os.getegid()),process_reader=lambda *_,**__:stale_process,
                        executable_reader=executable,pidfd_factory=reader,pidfd_alive=lambda _:True)
                    self.assertEqual(stale['result'], 'BLOCKED')
                    self.assertIn('INSTANCE_PREDATES_PROCESS', stale['blockingReasons'])
            ambiguous_process = {**proof, 'startTimeUpperUtc':'2026-10-11T12:00:00.005000+00:00'}
            ambiguous = self.tool.inspect(123,digest,root=root,owner=(os.geteuid(),os.getegid()),
                broker_owner=(os.geteuid(),os.getegid()),process_reader=lambda *_,**__:ambiguous_process,
                executable_reader=executable,pidfd_factory=reader,pidfd_alive=lambda _:True)
            self.assertEqual(ambiguous['result'], 'BLOCKED')
            self.assertIsNone(ambiguous['realNonce'])
            self.assertIn('INSTANCE_PROCESS_START_AMBIGUOUS', ambiguous['blockingReasons'])
            wrong = {**proof,'uid':[44180,0,44180,44180]}
            report = self.tool.inspect(123,digest,root=root,owner=(os.geteuid(),os.getegid()),
                broker_owner=(os.geteuid(),os.getegid()),process_reader=lambda *_,**__:wrong,
                executable_reader=executable,pidfd_factory=reader,pidfd_alive=lambda _:True)
            self.assertEqual(report['result'], 'BLOCKED')
            self.assertIsNone(report['realNonce'])

# unittest.main must run after all class definitions.

class MoreBoundaryTests(unittest.TestCase):
    def test_all_linux_entries_refuse_before_reads_writes_or_commands(self):
        for name in ['target-observation','dependency-inventory','offline-backup','isolation','inspect-instance']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as own:
                evidence = Path(own) / 'never created.json'
                script = BASE / (name + '.py')
                code = "\n".join(["import runpy,sys,time", "sys.platform='darwin'",
                    "if hasattr(time,'clock_gettime_ns'): del time.clock_gettime_ns",
                    "sys.argv=[sys.argv[1]];runpy.run_path(sys.argv[0],run_name='__main__')"])
                result = subprocess.run([sys.executable,'-I','-B','-c',code,str(script)], capture_output=True,text=True)
                self.assertEqual(result.returncode,2,result.stderr)
                self.assertRegex(result.stderr,'LINUX_(DESCRIPTOR_CAPABILITY|ROOT_OBSERVER)_REQUIRED')
                self.assertFalse(evidence.exists())

    def test_untrusted_output_parent_and_directory_replacement_are_refused(self):
        common = load('_safety')
        with tempfile.TemporaryDirectory(prefix='cleanup-output-',dir='/var/tmp') as own:
            directory = Path(own) / 'private'
            directory.mkdir(mode=0o777)
            directory.chmod(0o777)
            output = directory / 'record.json'
            with self.assertRaises(common.Refusal):
                common.publish(output,{'nonsecret':True})
            self.assertFalse(output.exists())
            directory.chmod(0o700)
            real_write = common.write_all
            replacement = Path(own) / 'replacement'
            replacement.mkdir(mode=0o700)
            moved = Path(own) / 'original authorized directory'
            changed = [False]
            def written(fd,data):
                real_write(fd,data)
                if not changed[0]:
                    changed[0]=True
                    directory.rename(moved)
                    replacement.rename(directory)
            with patch.object(common,'write_all',side_effect=written):
                with self.assertRaisesRegex(common.Refusal,'DIRECTORY_CHANGED'):
                    common.publish(output,{'nonsecret':True})
            self.assertFalse(output.exists())
            self.assertTrue((moved/'record.json').exists())

    def test_live_access_function_uses_only_owned_nonsecret_fixture_permissions(self):
        tool = load('isolation')
        with tempfile.TemporaryDirectory(prefix='cleanup-access-',dir='/var/tmp') as own:
            readable = Path(own) / 'ordinary.txt'
            readable.write_text('nonsecret fixture')
            denied = Path(own) / 'denied.txt'
            denied.write_text('nonsecret fixture')
            denied.chmod(0o000)
            # Only testing current UID in owned scratch. No selected target identity is used.
            with patch.object(tool.common,'administrator_required'), patch.object(os,'setgroups'), \
                 patch.object(os,'getgroups',return_value=[]):
                proof = tool.dropped_access([('ordinary',str(readable),os.R_OK),('denied',str(denied),os.R_OK)],
                    uid=os.geteuid(),gid=os.getegid())
            self.assertEqual(proof['uid'],[os.geteuid()]*4)
            self.assertEqual(proof['access'],{'ordinary':True,'denied':False})
            self.assertFalse(proof['credentialBytesOpened'])
            self.assertFalse(proof['targetWrites'])
            denied.chmod(0o600)
            self.assertEqual(denied.read_text(),'nonsecret fixture')

    def test_bad_result_after_child_reap_never_signals_reused_numeric_pid(self):
        tool = load('isolation')
        real_pipe = os.pipe2
        def pipe(flags):
            reader,writer=real_pipe(flags)
            os.write(writer,b'bad JSON after fixture child exit')
            return reader,writer
        with patch.object(tool.common,'administrator_required'), patch.object(os,'pipe2',side_effect=pipe), \
             patch.object(os,'fork',return_value=123), patch.object(os,'waitpid',return_value=(123,0)), \
             patch.object(os,'kill') as killed:
            with self.assertRaises(tool.common.Refusal):
                tool.dropped_access([])
            killed.assert_not_called()

    def test_sudo_unknown_grant_or_command_failure_is_blocked(self):
        tool = load('isolation')
        for result in [dict(status=0,stdout='(ALL) ALL',stderr=''),
            dict(status=1,stdout='',stderr='cannot inspect sudo policy')]:
            with self.subTest(result=result):
                report=tool.privilege_scope(sudo_runner=lambda:result,
                    access=lambda _:self.fail('unknown privilege must stop before access probes'))
                self.assertFalse(report['verified'])
                self.assertIn('SUDO_PRIVILEGE_NOT_CONFIRMED_DENIED',report['blockingReasons'])

    def test_container_daemon_unknown_endpoint_blocks_even_if_fixed_paths_absent(self):
        tool=load('isolation')
        with tempfile.TemporaryDirectory(prefix='cleanup-container-',dir='/var/tmp') as own:
            root=Path(own)
            (root/'proc/123').mkdir(parents=True,mode=0o755)
            (root/'proc/123/comm').write_text('dockerd\n')
            (root/'run').mkdir(mode=0o755)
            report=tool.privilege_scope(root=root,sudo_runner=lambda:dict(status=1,
                stdout='User openslack-cleanup-agent is not allowed to run sudo on fixture.',stderr=''),
                access=lambda _:self.fail('no fixed container sockets exist'))
            self.assertFalse(report['verified'])
            self.assertIn('CONTAINER_DAEMON_CUSTOM_ENDPOINT_SCOPE_UNKNOWN',report['blockingReasons'])
            self.assertEqual(report['containerProcesses'],[{'pid':123,'comm':'dockerd'}])

    def test_sudo_scope_no_daemon_no_interfaces_complete_fixture(self):
        tool=load('isolation')
        with tempfile.TemporaryDirectory(prefix='cleanup-privilege-',dir='/var/tmp') as own:
            root=Path(own)
            (root/'proc').mkdir(mode=0o755)
            (root/'run').mkdir(mode=0o755)
            report=tool.privilege_scope(root=root,sudo_runner=lambda:dict(status=1,
                stdout='User openslack-cleanup-agent is not allowed to run sudo on fixture.',stderr=''),
                access=lambda _:self.fail('no access checks required for absent sockets'))
            self.assertTrue(report['verified'],report)
            self.assertEqual(len(report['containerInterfaces']),len(tool.CONTAINER_PATHS))

    def test_process_record_checks_every_uid_gid_and_exact_executable(self):
        tool=load('inspect-instance')
        with tempfile.TemporaryDirectory(prefix='cleanup-process-',dir='/var/tmp') as own:
            root=Path(own)
            proc=root/'proc/123'
            proc.mkdir(parents=True,mode=0o755)
            (proc/'comm').write_text('cleanup-broker\n')
            (proc/'exe').symlink_to(tool.BROKER)
            status='Uid:\t44180 44180 44180 44180\nGid:\t44180 44180 44180 44180\nGroups:\t44180\nCapEff:\t0\nCapPrm:\t0\nCapAmb:\t0\n'
            (proc/'status').write_text(status)
            (proc/'stat').write_text('123 (cleanup-broker) '+' '.join(['S']+['0']*18+['100']+['0']*12))
            (root/'proc/stat').write_text('cpu 1 2 3\nbtime 1791720000\n')
            value=tool.process_record(123,root=root)
            self.assertEqual(value['uid'],[44180]*4)
            self.assertEqual(value['gid'],[44180]*4)
            for key in ('Uid','Gid'):
                for position in range(4):
                    with self.subTest(key=key,position=position):
                        altered=status.splitlines()
                        index=0 if key=='Uid' else 1
                        fields=['44180']*4
                        fields[position]='0'
                        altered[index]=key+': '+ ' '.join(fields)
                        (proc/'status').write_text('\n'.join(altered)+'\n')
                        with self.assertRaisesRegex(tool.common.Refusal,'PROCESS_UID_GID_MISMATCH'):
                            tool.process_record(123,root=root)
            (proc/'status').write_text(status)
            (proc/'exe').unlink()
            (proc/'exe').symlink_to('/usr/bin/other-owned-fixture')
            with self.assertRaisesRegex(tool.common.Refusal,'PROCESS_EXECUTABLE_PATH_MISMATCH'):
                tool.process_record(123,root=root)

class PortableLogicTests(unittest.TestCase):
    def test_instance_decoder_is_closed_and_requires_selected_bindings(self):
        tool=load('inspect-instance')
        record=dict(schema='openslack.cleanup_broker_instance.v1',brokerId='cleanup-broker-pr418',
            workspaceId='openslack-self',bootNonce='b'*64,generation='',startedAt='2026-10-11T12:00:00+00:00')
        self.assertEqual(tool.validate_instance(record),record)
        with self.assertRaisesRegex(tool.common.Refusal,'INSTANCE_BINDING_MISMATCH'):
            tool.validate_instance({**record,'workspaceId':'other'})
        with self.assertRaisesRegex(tool.common.Refusal,'FIRST_START_GENERATION_NOT_EMPTY'):
            tool.validate_instance({**record,'generation':'2'})

    def test_strict_json_duplicate_escaped_keys_and_non_json_numbers(self):
        common=load('_safety')
        for data in [b'{"a":1,"\\u0061":2}',b'{"value":NaN}',b'\xff']:
            with self.subTest(data=data),self.assertRaises(common.Refusal):
                common.strict_json(data)

    def test_isolation_future_files_are_not_a_poststart_pass(self):
        tool=load('isolation')
        ids={'broker':{'uid':44180,'gid':44180,'groupIds':[44180],'shell':'/usr/sbin/nologin'},
             'agent':{'uid':44181,'gid':44181,'groupIds':[44181],'shell':'/usr/sbin/nologin'}}
        rows=[{'id':item['id'],'expected':item['expected'],'observed':'missing' if item['id'] in tool.RUNTIME_IDS
            else item['expected']} for item in tool.PROBES]
        privilege={'verified':True,'blockingReasons':[]}
        self.assertEqual(tool.evaluate('pre-start',identities=ids,probes=rows,privilege=privilege)['result'],'PASS')
        result=tool.evaluate('post-start',identities=ids,probes=rows,privilege=privilege)
        self.assertEqual(result['result'],'BLOCKED')
        self.assertIn('RUNTIME_OBJECT_MISSING',result['blockingReasons'])

if __name__ == "__main__":
    if '--portable' in sys.argv:
        sys.argv.remove('--portable')
        suite=unittest.TestSuite()
        for cls in [PlatformBoundaryTests,PortableLogicTests]:
            suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(cls))
        suite.addTest(MoreBoundaryTests('test_all_linux_entries_refuse_before_reads_writes_or_commands'))
        result=unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(0 if result.wasSuccessful() else 1)
    unittest.main(verbosity=2)
