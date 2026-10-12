#!/usr/bin/env python3
"""Exclusive nonsecret offline backup for the selected never-started installation.

It never restores the active target, deletes state, reads credentials, or starts a process.
An unexpected process/history/runtime object stops this route and preserves partial output.
"""
import argparse
from contextlib import ExitStack
import hashlib
import os
from pathlib import Path
import stat
import sys
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).parent))
import _safety as common

# Exactly these nonsecret files; no recursive traversal, credential paths or globbing.
ALLOWLIST = {**common.LAYOUT,
    '/usr/lib/openslack-cleanup/install-manifest.json': (2 * 1024 * 1024, None),
    '/etc/openslack-cleanup/broker.json': (64 * 1024, None),
    '/etc/openslack-cleanup/task-dependencies.json': (2 * 1024 * 1024, None)}
OPTIONAL = set(ALLOWLIST) - set(common.LAYOUT)
HISTORY = ('ledger.jsonl', 'workers.jsonl', 'instance.json')


def observed_directory(root, logical, owner, missing=False):
    with common.Anchor(root, logical, owners={0, owner[0], common.BROKER_UID}, sticky_evidence=True) as anchor:
        try:
            info = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
        except FileNotFoundError:
            common.require(missing, 'REQUIRED_DIRECTORY_MISSING')
            anchor.check()
            return dict(path=logical, state='missing', entries=[])
        common.require(stat.S_ISDIR(info.st_mode), 'UNSAFE_INSTALLATION_DIRECTORY')
        common.require(info.st_uid in {owner[0], common.BROKER_UID} and info.st_mode & 0o7022 == 0,
            'INSTALLATION_DIRECTORY_OWNER_OR_MODE')
        with common.Owned() as owned:
            fd = owned.add(os.open(anchor.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=anchor.parent))
            before = os.fstat(fd)
            common.require(common.directory_stamp(info) == common.directory_stamp(before), 'DIRECTORY_CHANGED')
            names = sorted(os.listdir(fd))
            common.require(len(names) <= 4096, 'DIRECTORY_ENTRY_LIMIT')
            common.require(common.directory_stamp(before) == common.directory_stamp(os.fstat(fd)) ==
                common.directory_stamp(os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)),
                'DIRECTORY_CHANGED')
            anchor.check()
            return dict(path=logical, state='present', entries=names,
                uid=info.st_uid, gid=info.st_gid, mode=f'{stat.S_IMODE(info.st_mode):04o}',
                dev=str(info.st_dev), ino=str(info.st_ino), mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns)


def default_observers():
    helper = common.load_source(Path(__file__).with_name('target-observation.py'), 'backup_target_observer')
    return helper.observe_processes, helper.observe_locks


def offline_guard(root, owner, process_observer, lock_observer, absent=()):
    process = process_observer(root)
    check_absent_optional(absent)
    common.require(isinstance(process, dict) and process.get('state') == 'stopped',
        'BROKER_PROCESS_NOT_CONFIRMED_STOPPED')
    state = observed_directory(root, '/var/lib/openslack-cleanup', owner)
    common.require(not state['entries'], 'UNEXPECTED_PERSISTENT_HISTORY')
    expected = owner if owner != (0, 0) else (44180, 44180)
    common.require((state['uid'], state['gid'], state['mode']) == (*expected, '0700'),
        'PERSISTENT_DIRECTORY_OWNER_OR_MODE')
    runtime = observed_directory(root, '/run/openslack-cleanup', owner, missing=True)
    common.require(not runtime['entries'], 'UNEXPECTED_RUNTIME_OBJECT')
    common.require(runtime['state'] == 'missing' or (runtime['uid'], runtime['gid'], runtime['mode'])
        == (*expected, '0755'), 'RUNTIME_DIRECTORY_OWNER_OR_MODE')
    objects = []
    # Include fixed installed inodes even when there is no ledger, journal or
    # socket yet. A non-Broker process can still hold a lock on an executable.
    for logical in [*ALLOWLIST, *(f'/var/lib/openslack-cleanup/{name}' for name in HISTORY),
                    '/run/openslack-cleanup/broker.sock']:
        try:
            with common.Anchor(root, logical, owners={0, owner[0], common.BROKER_UID},
                               sticky_evidence=True) as anchor:
                info = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
                common.require(not stat.S_ISLNK(info.st_mode), 'LOCK_TARGET_UNSAFE')
                objects.append(dict(path=logical, dev=str(info.st_dev), ino=str(info.st_ino)))
                anchor.check()
        except FileNotFoundError:
            continue
    locks = lock_observer(root, objects)
    common.require(isinstance(locks, dict) and locks.get('state') == 'none-observed', 'LOCKS_NOT_CONFIRMED_ABSENT')
    return dict(process=process, state=state, runtime=runtime, locks=locks)


def check_created_directories(bindings):
    for parent, name, fd, expected in bindings:
        common.require(common.directory_stamp(os.fstat(fd)) == expected
            == common.directory_stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)),
            'BACKUP_DIRECTORY_CHANGED')


def check_created_files(bindings):
    for parent, name, fd, expected in bindings:
        common.require(common.file_stamp(os.fstat(fd)) == expected
            == common.file_stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)),
            'BACKUP_ENTRY_CHANGED')


def check_absent_optional(anchors):
    for anchor in anchors:
        anchor.check()
        try:
            os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
        except FileNotFoundError:
            anchor.check()
        else:
            raise common.Refusal('ABSENT_OPTIONAL_FILE_CHANGED')


def new_child(parent, name, owned, bindings, created=None):
    common.require('/' not in name and name not in ('', '.', '..'), 'INTERNAL_BACKUP_NAME_INVALID')
    os.mkdir(name, 0o700, dir_fd=parent)
    if created is not None:
        created()
    fd = owned.add(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent))
    info = os.fstat(fd)
    common.require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
        and info.st_uid == os.geteuid(), 'BACKUP_DIRECTORY_UNSAFE')
    bindings.append((parent, name, fd, common.directory_stamp(info)))
    check_created_directories(bindings)
    os.fsync(parent)
    return fd


def new_file(parent, name, owned):
    fd = owned.add(os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600, dir_fd=parent))
    info = os.fstat(fd)
    common.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
        and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600, 'BACKUP_FILE_UNSAFE')
    return fd


def copy_checked(source, destination, owner, mode):
    digest, size = hashlib.sha256(), 0
    for block in source.chunks():
        digest.update(block)
        common.write_all(destination, block)
        size += len(block)
    info = os.fstat(destination)
    if (info.st_uid, info.st_gid) != owner:
        os.fchown(destination, *owner)
    os.fchmod(destination, mode)
    os.fsync(destination)
    common.require(size == source.info.st_size, 'BACKUP_SIZE_MISMATCH')
    after = os.fstat(destination)
    common.require((after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) == (*owner, mode)
        and after.st_size == size and after.st_nlink == 1, 'BACKUP_METADATA_MISMATCH')
    os.lseek(destination, 0, os.SEEK_SET)
    check, count = hashlib.sha256(), 0
    while block := os.read(destination, 1024 * 1024):
        check.update(block)
        count += len(block)
    common.require(count == size and check.hexdigest() == digest.hexdigest(), 'BACKUP_BYTES_MISMATCH')
    source.check()
    return digest.hexdigest()


def prepare_backup(*, root=Path('/'), output, owner=(0, 0), process_observer=None, lock_observer=None):
    report = common.base_report('openslack.cleanup_offline_backup.v1')
    report.update(result='BLOCKED', route='existing-never-started-offline', backupPath=str(output),
        outputCreated=False, files=[], absentOptionalFiles=[], restoreVerified=False,
        activeTargetRestored=False, historyContentsRead=False, blockingReasons=[], cleanupErrors=[],
        allowlist=sorted(ALLOWLIST))
    try:
        common.linux_required()
        # Only function-level fixture APIs can change root/owner or observers.
        if process_observer is None or lock_observer is None:
            observed_processes, observed_locks = default_observers()
            process_observer = process_observer or observed_processes
            lock_observer = lock_observer or observed_locks
        if root == Path('/') and owner == (0, 0):
            helper = common.load_source(Path(__file__).with_name('target-observation.py'), 'backup_identity_observer')
            actual_ids = helper.identities()
            for role, uid, gid in [('broker', 44180, 44180), ('agent', 44181, 44181)]:
                entry = actual_ids.get(role, {})
                common.require(entry.get('state') == 'present' and (entry.get('uid'), entry.get('gid')) == (uid, gid)
                    and entry.get('groupIds') == [gid] and entry.get('shell') == '/usr/sbin/nologin',
                    'IDENTITY_MAPPING_OR_GROUPS_UNVERIFIED')
            report['identities'] = actual_ids
        before = offline_guard(root, owner, process_observer, lock_observer)
        report['targetBefore'] = before
        output = Path(common.output_path(output))
        with ExitStack() as sources:
            held, absent = [], []
            for logical, (bound, required_mode) in ALLOWLIST.items():
                try:
                    source = sources.enter_context(common.ReadFile(root, logical, bound,
                        owners=({owner, (0, common.BROKER_GID)} if owner == (0, 0) and logical.startswith('/etc/') else {owner}),
                        mode=required_mode, sticky_evidence=True))
                except FileNotFoundError:
                    common.require(logical in OPTIONAL, 'REQUIRED_INSTALLED_FILE_MISSING')
                    # Keep the real parent descriptor for the whole transaction. A missing
                    # parent or an unreadable path cannot establish stable file absence.
                    try:
                        missing = sources.enter_context(common.Anchor(root, logical,
                            owners={0, owner[0]}, sticky_evidence=True))
                    except FileNotFoundError as error:
                        raise common.Refusal('OPTIONAL_PARENT_UNVERIFIED') from error
                    absent.append(missing)
                    check_absent_optional(absent)
                    report['absentOptionalFiles'].append(logical)
                    continue
                held.append((logical, source))
            common.require(len(held) >= len(common.LAYOUT), 'INSTALLED_LAYOUT_INCOMPLETE')
            check_absent_optional(absent)
            with common.Anchor(Path('/'), str(output), sticky_evidence=True) as anchor, common.Owned() as owned:
                parent = os.fstat(anchor.parent)
                common.require(parent.st_uid == os.geteuid() and stat.S_IMODE(parent.st_mode) == 0o700,
                    'BACKUP_PARENT_NOT_PRIVATE')
                directories, copied_files = [], []
                backup_fd = new_child(anchor.parent, anchor.name, owned, directories,
                    created=lambda: report.update(outputCreated=True))
                files_fd = new_child(backup_fd, 'files', owned, directories)
                restore_fd = new_child(backup_fd, 'restore-verification', owned, directories)
                for index, (logical, source) in enumerate(held):
                    check_absent_optional(absent)
                    check_created_directories(directories)
                    name = f'{index:02d}.bin'
                    copied = new_file(files_fd, name, owned)
                    restored = new_file(restore_fd, name, owned)
                    metadata = (source.info.st_uid, source.info.st_gid)
                    mode = stat.S_IMODE(source.info.st_mode)
                    digest = copy_checked(source, copied, metadata, mode)
                    # Read the backup itself as the restoration source, not the original target again.
                    os.lseek(copied, 0, os.SEEK_SET)
                    restored_hash, restored_size = hashlib.sha256(), 0
                    while block := os.read(copied, 1024 * 1024):
                        common.write_all(restored, block)
                        restored_hash.update(block)
                        restored_size += len(block)
                    info = os.fstat(restored)
                    if (info.st_uid, info.st_gid) != metadata:
                        os.fchown(restored, *metadata)
                    os.fchmod(restored, mode)
                    os.fsync(restored)
                    restore_info = os.fstat(restored)
                    common.require((restore_info.st_uid, restore_info.st_gid, stat.S_IMODE(restore_info.st_mode),
                        restore_info.st_size, restore_info.st_nlink) == (*metadata, mode, source.info.st_size, 1)
                        and restored_size == source.info.st_size and restored_hash.hexdigest() == digest,
                        'RESTORE_VERIFICATION_MISMATCH')
                    os.lseek(restored, 0, os.SEEK_SET)
                    restored_actual = hashlib.sha256()
                    while block := os.read(restored, 1024 * 1024):
                        restored_actual.update(block)
                    common.require(restored_actual.hexdigest() == digest, 'RESTORED_BYTES_MISMATCH')
                    entry = os.stat(name, dir_fd=files_fd, follow_symlinks=False)
                    restored_entry = os.stat(name, dir_fd=restore_fd, follow_symlinks=False)
                    common.require(common.file_stamp(entry) == common.file_stamp(os.fstat(copied))
                        and common.file_stamp(restored_entry) == common.file_stamp(os.fstat(restored)), 'BACKUP_ENTRY_CHANGED')
                    copied_files.extend(((files_fd, name, copied, common.file_stamp(entry)),
                        (restore_fd, name, restored, common.file_stamp(restored_entry))))
                    check_created_directories(directories)
                    source.check()
                    report['files'].append({**common.row(logical, source.info, digest),
                        'backupRelativePath':'files/' + name, 'restoreRelativePath':'restore-verification/' + name})
                check_created_directories(directories)
                check_created_files(copied_files)
                check_absent_optional(absent)
                os.fsync(files_fd)
                os.fsync(restore_fd)
                check_absent_optional(absent)
                after = offline_guard(root, owner, process_observer, lock_observer, absent)
                report['targetAfter'] = after
                common.require(before == after, 'OFFLINE_TARGET_CHANGED')
                check_created_directories(directories)
                check_created_files(copied_files)
                for _, source in held:
                    source.check()
                check_absent_optional(absent)
                report['restoreVerified'] = True
                report['result'] = 'PASS'
                data = common.encode(report)
                manifest = new_file(backup_fd, 'backup-manifest.json', owned)
                common.write_all(manifest, data)
                os.fsync(manifest)
                copied_files.append((backup_fd, 'backup-manifest.json', manifest,
                    common.file_stamp(os.fstat(manifest))))
                os.fsync(backup_fd)
                os.fsync(anchor.parent)
                check_created_directories(directories)
                check_created_files(copied_files)
                check_absent_optional(absent)
                anchor.check()
                report['manifestSHA256'] = hashlib.sha256(data).hexdigest()
    except (common.Refusal, OSError, ValueError) as error:
        report['result'] = 'BLOCKED'
        report['restoreVerified'] = False
        report['blockingReasons'].append(common.error_code(error))
        report['cleanupErrors'].extend(error.cleanup if isinstance(error, common.Refusal) else [])
        report['preservePartialOutput'] = report['outputCreated']
    return report


def main():
    common.administrator_required()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', type=Path, required=True, help='new directory inside an existing root-owned 0700 parent')
    args = parser.parse_args()
    report = prepare_backup(output=args.backup)
    sys.stdout.buffer.write(common.encode(report))
    return 0 if report['result'] == 'PASS' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (common.Refusal, OSError, ValueError) as error:
        print('STOP: ' + common.error_code(error) + '; preserve existing state and partial evidence', file=sys.stderr)
        raise SystemExit(2)
