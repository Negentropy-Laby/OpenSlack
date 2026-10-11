#!/usr/bin/env python3
"""Stage-specific metadata/DAC/ACL isolation observation under the actual Agent UID.

No credential bytes are opened, no socket is connected, and no target object is written.
Unknown privilege, identity or runtime evidence is BLOCKED, never a vacuous PASS.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
sys.dont_write_bytecode = True
import time

sys.path.insert(0, str(Path(__file__).parent))
import _safety as common

RUNTIME_IDS = {'read:ledger', 'read:worker-journal', 'read:instance', 'access:socket'}
PROBES = [
    dict(id='read:credentials-directory', path='/etc/openslack-cleanup/credentials', access=os.R_OK | os.X_OK,
         expected='deny', kind='directory', owner=(0, 44180), mode=0o750, sensitive=True),
    dict(id='read:broker-config', path='/etc/openslack-cleanup/broker.json', access=os.R_OK,
         expected='deny', kind='regular', owner=(0, 44180), mode=0o640),
    dict(id='read:task-view', path='/etc/openslack-cleanup/task-dependencies.json', access=os.R_OK,
         expected='deny', kind='regular', owner=(0, 44180), mode=0o640),
    dict(id='read:governance-credential', path='/etc/openslack-cleanup/credentials/governance', access=os.R_OK,
         expected='deny', kind='regular', owner=(0, 44180), mode=0o640, sensitive=True),
    dict(id='read:app-credential', path='/etc/openslack-cleanup/credentials/github-app-private-key', access=os.R_OK,
         expected='deny', kind='regular', owner=(0, 44180), mode=0o640, sensitive=True),
    dict(id='read:state-directory', path='/var/lib/openslack-cleanup', access=os.R_OK | os.X_OK,
         expected='deny', kind='directory', owner=(44180, 44180), mode=0o700),
    *[dict(id='read:' + name, path='/var/lib/openslack-cleanup/' + file, access=os.R_OK,
           expected='deny', kind='regular', owner=(44180, 44180), mode=0o600)
      for name, file in [('ledger', 'ledger.jsonl'), ('worker-journal', 'workers.jsonl'), ('instance', 'instance.json')]],
    dict(id='access:socket', path='/run/openslack-cleanup/broker.sock', access=os.R_OK | os.W_OK,
         expected='allow', kind='socket', owner=(44180, 44180), mode=0o666),
    *[dict(id='read:' + path.rsplit('/', 1)[-1], path=path, access=os.R_OK, expected='allow',
           kind='regular', owner=(0, 0), mode=mode) for path, (_, mode) in common.LAYOUT.items()],
    *[dict(id='modify:' + path.rsplit('/', 1)[-1], path=path, access=os.W_OK, expected='deny',
           kind='regular', owner=(0, 0), mode=mode) for path, (_, mode) in common.LAYOUT.items()],
    *[dict(id='write:' + name, path=path, access=os.W_OK | os.X_OK, expected='deny', kind='directory',
           owner=owner, mode=mode) for name, path, owner, mode in (
        ('config-directory', '/etc/openslack-cleanup', (0, 44180), 0o750),
        ('program-directory', '/usr/lib/openslack-cleanup', (0, 0), 0o755),
        ('state-directory', '/var/lib/openslack-cleanup', (44180, 44180), 0o700),
        ('run-directory', '/run/openslack-cleanup', (44180, 44180), 0o755))],
]
CONTAINER_PATHS = ('/run/docker.sock', '/run/podman/podman.sock', '/run/containerd/containerd.sock',
    '/run/lxd/unix.socket', '/var/snap/lxd/common/lxd/unix.socket')
CONTAINER_COMMS = {'dockerd', 'containerd', 'podman', 'lxd', 'incusd', 'crio'}


def identities():
    import pwd
    result = {}
    for role, name in [('broker', 'openslack-cleanup-broker'), ('agent', 'openslack-cleanup-agent')]:
        try:
            user = pwd.getpwnam(name)
            result[role] = dict(name=name, uid=user.pw_uid, gid=user.pw_gid, shell=user.pw_shell,
                groupIds=sorted(set(os.getgrouplist(name, user.pw_gid))))
        except (KeyError, OSError):
            result[role] = dict(name=name, uid=None, gid=None, shell=None, groupIds=None)
    return result


def validate_identities(value):
    common.require(isinstance(value, dict) and set(value) == {'broker', 'agent'}, 'IDENTITY_EVIDENCE_MISSING')
    for role, uid, gid in [('broker', 44180, 44180), ('agent', 44181, 44181)]:
        item = value[role]
        common.require(isinstance(item, dict) and (item.get('uid'), item.get('gid')) == (uid, gid),
            'IDENTITY_MAPPING_MISMATCH')
        common.require(item.get('groupIds') == [gid] and item.get('shell') == '/usr/sbin/nologin',
            'SUPPLEMENTARY_GROUP_OR_SHELL_UNVERIFIED')


def metadata(root, spec):
    try:
        with common.Anchor(root, spec['path'], owners={0, os.geteuid(), 44180},
            sticky_evidence=True, sensitive_metadata=spec.get('sensitive', False)) as anchor:
            info = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
            kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'regular' if stat.S_ISREG(info.st_mode) \
                else 'socket' if stat.S_ISSOCK(info.st_mode) else 'unsafe'
            common.require(kind == spec['kind'] and (kind == 'directory' or info.st_nlink == 1),
                'OBJECT_KIND_OR_LINK_MISMATCH')
            common.require((info.st_uid, info.st_gid) == spec['owner'] and stat.S_IMODE(info.st_mode) == spec['mode'],
                'OBJECT_OWNER_OR_MODE_MISMATCH')
            anchor.check()
            return dict(state='present', kind=kind, mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns,
                **common.row(spec['path'], info))
    except FileNotFoundError:
        return dict(path=spec['path'], state='missing')
    except (common.Refusal, OSError) as error:
        return dict(path=spec['path'], state='unverified', reason=common.error_code(error))


def dropped_access(paths, uid=44181, gid=44181):
    """Owned child drops all real/effective/saved IDs; access checks do not open any file."""
    common.administrator_required()
    with common.Owned() as owned:
        reader, writer = os.pipe2(os.O_CLOEXEC)
        owned.add(reader)
        owned.add(writer)
        child = os.fork()
        if child == 0:
            try:
                os.close(reader)
                os.setgroups([])
                os.setresgid(gid, gid, gid)
                os.setresuid(uid, uid, uid)
                status = common.process_status(common.proc_text(os.getpid(), 'status'))
                uids = [int(value) for value in status['Uid'].split()]
                gids = [int(value) for value in status['Gid'].split()]
                common.require(uids == [uid] * 4 and gids == [gid] * 4 and os.getgroups() == [],
                    'DROPPED_IDENTITY_MISMATCH')
                common.require(all(int(status.get(key, '-1'), 16) == 0 for key in ('CapEff', 'CapPrm', 'CapAmb')),
                    'DROPPED_IDENTITY_HAS_CAPABILITIES')
                values = {name: bool(os.access(path, mode, effective_ids=True)) for name, path, mode in paths}
                result = dict(uid=uids, gid=gids, supplementaryGroups=[], capabilities='none-effective-permitted-ambient',
                    access=values, credentialBytesOpened=False, targetWrites=False, socketConnected=False)
                common.write_all(writer, common.encode(result))
                os._exit(0)
            except BaseException:
                try:
                    common.write_all(writer, b'{"error":"DROPPED_ACCESS_FAILED"}')
                finally:
                    os._exit(2)
        # Closing the parent's writer allows EOF to indicate the owned child finished.
        os.close(writer)
        owned.fds.remove(writer)
        data, end = bytearray(), time.monotonic() + 5
        reaped = False
        try:
            while True:
                remaining = end - time.monotonic()
                common.require(remaining > 0, 'DROPPED_ACCESS_TIMEOUT')
                ready, _, _ = select.select([reader], [], [], remaining)
                common.require(bool(ready), 'DROPPED_ACCESS_TIMEOUT')
                block = os.read(reader, min(4096, 65537 - len(data)))
                if not block:
                    break
                data.extend(block)
                common.require(len(data) <= 65536, 'DROPPED_ACCESS_RESULT_TOO_LARGE')
            pid, status = os.waitpid(child, 0)
            reaped = True
            common.require(pid == child and os.waitstatus_to_exitcode(status) == 0, 'DROPPED_ACCESS_FAILED')
            result = common.strict_json(bytes(data), 65536)
            common.exact(result, {'uid', 'gid', 'supplementaryGroups', 'capabilities', 'access',
                'credentialBytesOpened', 'targetWrites', 'socketConnected'}, 'DROPPED_ACCESS_RESULT_INVALID')
            common.require(result['uid'] == [uid] * 4 and result['gid'] == [gid] * 4
                and result['supplementaryGroups'] == [] and result['credentialBytesOpened'] is False
                and result['targetWrites'] is False and result['socketConnected'] is False,
                'DROPPED_IDENTITY_MISMATCH')
            common.require(set(result['access']) == {name for name, _, _ in paths}
                and all(type(value) is bool for value in result['access'].values()), 'DROPPED_ACCESS_RESULT_INVALID')
            return result
        except BaseException:
            # Once reaped, this numeric PID is no longer owned and must never be signalled.
            if not reaped:
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(child, 0)
                except ChildProcessError:
                    pass
            raise


def sudo_command():
    """Fixed read-only no-password listing, not a user-configurable command."""
    from contextlib import ExitStack
    # sudo is deliberately setuid; validate its exact root-owned mode without treating it as an ordinary artifact.
    with common.Anchor(Path('/'), '/usr/bin/sudo', owners={0}) as anchor, common.Owned() as owned:
        fd = owned.add(os.open(anchor.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=anchor.parent))
        before = os.fstat(fd)
        common.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and (before.st_uid, before.st_gid) == (0, 0) and stat.S_IMODE(before.st_mode) in (0o755, 0o4755)
            and 0 < before.st_size <= 8 * 1024 * 1024, 'SUDO_EXECUTABLE_UNTRUSTED')
        anchor.check()
        with ExitStack() as streams:
            process = subprocess.Popen(['/usr/bin/sudo', '-n', '-l', '-U', 'openslack-cleanup-agent'],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
                cwd='/', env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
            # Register process/pipe cleanup before parsing anything it returns.
            streams.callback(process.wait)
            streams.callback(lambda: process.kill() if process.poll() is None else None)
            common.require(process.stdout is not None and process.stderr is not None, 'SUDO_PIPE_UNAVAILABLE')
            streams.callback(process.stdout.close)
            streams.callback(process.stderr.close)
            buffers = {'stdout':bytearray(), 'stderr':bytearray()}
            limit = time.monotonic() + 5
            selector = streams.enter_context(selectors.DefaultSelector())
            for name, stream in [('stdout', process.stdout), ('stderr', process.stderr)]:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = limit - time.monotonic()
                common.require(remaining > 0, 'SUDO_OBSERVATION_TIMEOUT')
                ready = selector.select(remaining)
                common.require(bool(ready), 'SUDO_OBSERVATION_TIMEOUT')
                for key, _ in ready:
                    data = os.read(key.fileobj.fileno(), 16385 - len(buffers[key.data]))
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    buffers[key.data].extend(data)
                    common.require(len(buffers[key.data]) <= 16384, 'SUDO_OBSERVATION_TOO_LARGE')
            remaining = limit - time.monotonic()
            common.require(remaining > 0, 'SUDO_OBSERVATION_TIMEOUT')
            status = process.wait(timeout=remaining)
            stdout, stderr = bytes(buffers['stdout']), bytes(buffers['stderr'])
        common.require(common.file_stamp(before) == common.file_stamp(os.fstat(fd)) == common.file_stamp(
            os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)), 'SUDO_EXECUTABLE_CHANGED')
        anchor.check()
        return dict(argv=['/usr/bin/sudo', '-n', '-l', '-U', 'openslack-cleanup-agent'],
            environment={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}, status=status,
            stdout=stdout.decode('utf-8', errors='strict'), stderr=stderr.decode('utf-8', errors='strict'))


def privilege_scope(*, root=Path('/'), access=dropped_access, sudo_runner=sudo_command):
    result = dict(verified=False, blockingReasons=[], sudo=None, containerInterfaces=[], containerProcesses=[],
        scope='selected OS identity, fixed sudo policy and observed local container interfaces; not a vulnerability audit')
    try:
        sudo = sudo_runner()
        result['sudo'] = sudo
        output = (sudo['stdout'] + '\n' + sudo['stderr']).strip()
        denied = re.search(r'User openslack-cleanup-agent is not allowed to run sudo on [^\n]+\.?', output) \
            or re.search(r'Sorry, user openslack-cleanup-agent may not run sudo on [^\n]+\.?', output)
        common.require(sudo.get('status') == 1 and bool(denied), 'SUDO_PRIVILEGE_NOT_CONFIRMED_DENIED')
        paths = []
        for index, path in enumerate(CONTAINER_PATHS):
            try:
                with common.Anchor(root, path, owners={0, os.geteuid()}, sticky_evidence=True) as anchor:
                    info = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
                    common.require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0, 'CONTAINER_INTERFACE_UNTRUSTED')
                    anchor.check()
                    result['containerInterfaces'].append(dict(state='present', **common.row(path, info)))
                    paths.append(('container:' + str(index), str(root / path.lstrip('/')), os.W_OK))
            except FileNotFoundError:
                result['containerInterfaces'].append(dict(path=path, state='missing'))
        if paths:
            checked = access(paths)
            common.require(not any(checked['access'].values()), 'AGENT_CONTAINER_INTERFACE_ACCESS')
        # Unknown/custom endpoints cannot be assumed denied when an active daemon is observed.
        with common.Anchor(root, '/proc/sentinel', owners={0, os.geteuid(), 44180, 44181},
                           sticky_evidence=Path(root) != Path('/')) as anchor:
            names = os.listdir(anchor.parent)
            common.require(len(names) <= 16384, 'PROC_ENTRY_LIMIT')
            for name in names:
                if not name.isdecimal():
                    continue
                try:
                    comm = common.proc_text(int(name), 'comm', root=root, bound=128).strip()
                    if comm in CONTAINER_COMMS:
                        result['containerProcesses'].append(dict(pid=int(name), comm=comm))
                except FileNotFoundError:
                    continue
            anchor.check()
        common.require(not result['containerProcesses'], 'CONTAINER_DAEMON_CUSTOM_ENDPOINT_SCOPE_UNKNOWN')
        result['verified'] = True
    except (common.Refusal, OSError, ValueError, subprocess.SubprocessError, UnicodeError, KeyError) as error:
        result['blockingReasons'].append(common.error_code(error))
    return result


def evaluate(phase, *, identities, probes, privilege):
    report = common.base_report('openslack.cleanup_isolation_observation.v1')
    report.update(phase=phase, result='BLOCKED', identities=identities, probes=probes, privilegeScope=privilege,
        deferred=[], blockingReasons=[], credentialMetadataOnly=True, targetWrites=False, socketConnected=False,
        scope='OS identity and installed-object metadata/DAC/ACL observation only; '
            'excludes fixed runtime identity, registry and private workspace; no execution authorization')
    problems = report['blockingReasons']
    try:
        common.require(phase in ('pre-start', 'post-start'), 'ISOLATION_PHASE_INVALID')
        validate_identities(identities)
        common.require(isinstance(probes, list) and len(probes) == len(PROBES), 'PROBE_SET_INCOMPLETE')
        indexed = {item.get('id'):item for item in probes}
        common.require(len(indexed) == len(probes) and set(indexed) == {item['id'] for item in PROBES},
            'PROBE_SET_INCOMPLETE')
        for spec in PROBES:
            observed = indexed[spec['id']]
            common.require(observed.get('expected') == spec['expected'], 'PROBE_EXPECTATION_MISMATCH')
            if spec['id'] in RUNTIME_IDS and phase == 'pre-start':
                if observed.get('observed') == 'missing':
                    report['deferred'].append(spec['id'])
                    continue
                problems.append('UNEXPECTED_PRESTART_RUNTIME_OBJECT')
            if observed.get('observed') == 'missing':
                problems.append('RUNTIME_OBJECT_MISSING' if spec['id'] in RUNTIME_IDS else 'REQUIRED_OBJECT_MISSING')
            elif observed.get('observed') != spec['expected']:
                problems.append('ISOLATION_ACCESS_OR_METADATA_FAILED')
        common.require(isinstance(privilege, dict) and privilege.get('verified') is True
            and privilege.get('blockingReasons') == [], 'PRIVILEGE_SCOPE_UNVERIFIED')
    except (common.Refusal, TypeError, ValueError) as error:
        problems.append(common.error_code(error))
    report['blockingReasons'] = sorted(set(problems))
    report['result'] = 'PASS' if not problems else 'BLOCKED'
    return report


def observe(phase, *, root=Path('/'), identity_source=identities, access=dropped_access,
            privilege_observer=privilege_scope, metadata_source=metadata):
    common.linux_required()
    ids = identity_source()
    try:
        validate_identities(ids)
    except common.Refusal as error:
        return evaluate(phase, identities=ids, probes=[], privilege=dict(verified=False,
            blockingReasons=[error.code]))
    before = {item['id']: metadata_source(root, item) for item in PROBES}
    candidates = [(item['id'], str(root / item['path'].lstrip('/')), item['access'])
                  for item in PROBES if before[item['id']]['state'] == 'present']
    try:
        checked = access(candidates)
        common.require(checked['uid'] == [44181] * 4 and checked['gid'] == [44181] * 4
            and checked['supplementaryGroups'] == [], 'DROPPED_IDENTITY_MISMATCH')
        permission = checked['access']
        after = {item['id']: metadata_source(root, item) for item in PROBES}
        rows = []
        for item in PROBES:
            entry = before[item['id']]
            observed = 'unverified' if entry != after[item['id']] else ('allow' if permission[item['id']]
                else 'deny') if entry['state'] == 'present' else entry['state']
            rows.append(dict(id=item['id'], path=item['path'], expected=item['expected'], observed=observed,
                metadata=after[item['id']]))
        privilege = privilege_observer(root=root, access=access)
        common.require(identity_source() == ids, 'IDENTITY_MAPPING_CHANGED')
        report = evaluate(phase, identities=ids, probes=rows, privilege=privilege)
        report['droppedIdentity'] = {key:value for key, value in checked.items() if key != 'access'}
        return report
    except (common.Refusal, OSError, ValueError, KeyError) as error:
        report = evaluate(phase, identities=ids, probes=[], privilege=dict(verified=False,
            blockingReasons=[common.error_code(error)]))
        report['blockingReasons'].append(common.error_code(error))
        return report


def main():
    common.administrator_required()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('pre-start', 'post-start'), required=True)
    parser.add_argument('--output', type=Path, required=True, help='exclusive new evidence file in a root-owned 0700 parent')
    args = parser.parse_args()
    report = observe(args.phase)
    common.publish(args.output, report)
    sys.stdout.buffer.write(common.encode(report))
    return 0 if report['result'] == 'PASS' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (common.Refusal, OSError, ValueError) as error:
        print('STOP: ' + common.error_code(error) + '; no target writes or credential reads', file=sys.stderr)
        raise SystemExit(2)
