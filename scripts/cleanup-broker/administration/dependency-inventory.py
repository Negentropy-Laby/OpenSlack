#!/usr/bin/env python3
"""Read-only installed ELF load-time dependency closure. No Broker/executor invocation."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import _safety as common
import time
import types

HELPER_NAME = 'target-observation.py'
HELPER_SHA256 = 'd1c9ad04a1012809945e65a332fa9b53979faf3cf89d6986dd39b032a7e05f68'
BINDINGS = common.BINDINGS
INSTALLED = {path: bound for path, (bound, _) in common.LAYOUT.items()}
LDD_INPUTS = tuple(p for p in INSTALLED if p.rsplit('/', 1)[-1] in ('node', 'git', 'sh', 'git-remote-https'))
INSTALLED_MODES = {path: f'{mode:04o}' for path, (_, mode) in common.LAYOUT.items()}
BROKER = '/usr/lib/openslack-cleanup/cleanup-broker'
LIBRARY_BOUND = 256 * 1024 * 1024
MINIMAL_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
SHA256 = re.compile(r'^[a-f0-9]{64}$')
SONAME = re.compile(r'^[A-Za-z0-9_.+-]{1,255}$')


class Refusal(Exception):
    pass


def require(value, code):
    if not value:
        raise Refusal(code)


def strict_json(data):
    try:
        return common.strict_json(data)
    except common.Refusal as error:
        raise Refusal(error.code) from error


def evidence_bytes(value):
    return common.encode(value)


def load_frozen_helper(file):
    # Read and compile the same verified bytes, not a second mutable path import; no pyc is written.
    require(file.name == HELPER_NAME, 'FROZEN_HELPER_NAME_MISMATCH')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 128 * 1024,
            'FROZEN_HELPER_FILE_UNSAFE')
        data = bytearray()
        while len(data) <= 128 * 1024:
            block = os.read(fd, min(65536, 128 * 1024 + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        entry = os.stat(file, follow_symlinks=False)
        same = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
        require(same(before) == same(after) == same(entry) and len(data) == before.st_size,
            'FROZEN_HELPER_CHANGED')
        require(hashlib.sha256(data).hexdigest() == HELPER_SHA256, 'FROZEN_HELPER_DIGEST_MISMATCH')
    finally:
        os.close(fd)
    module = types.ModuleType('cleanup_frozen_safe_helper')
    module.__file__ = str(file)
    exec(compile(bytes(data), str(file), 'exec'), module.__dict__)
    return module


class VerifiedFile:
    def __init__(self, root, logical, bound, helper, expected_owner=(0, 0),
                 allow_sticky_evidence_ancestors=False):
        self.root, self.path, self.bound, self.helper = root, logical, bound, helper
        self.expected_owner = expected_owner
        self.allow_sticky_evidence_ancestors = allow_sticky_evidence_ancestors
        self.stack = ExitStack()

    def __enter__(self):
        try:
            self.anchor = self.stack.enter_context(self.helper.AnchoredPath(self.root, self.path))
            self.trusted_ancestors()
            self.fd = os.open(self.anchor.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                dir_fd=self.anchor.parent)
            self.stack.callback(os.close, self.fd)
            self.initial = os.fstat(self.fd)
            require(stat.S_ISREG(self.initial.st_mode) and self.initial.st_nlink == 1
                and 0 < self.initial.st_size <= self.bound, 'NON_REGULAR_LINKED_OR_UNBOUNDED_FILE')
            require((self.initial.st_uid, self.initial.st_gid) == self.expected_owner
                and self.initial.st_mode & 0o7022 == 0, 'UNTRUSTED_FILE_OWNER_OR_MODE')
            self.before = self.snapshot()
            return self
        except BaseException:
            self.stack.close()
            raise

    def trusted_ancestors(self):
        # Only the internal fixture API can supply a namespace root other than /.
        # In production every ancestor from / is checked before opening a file.
        root_depth = len(Path(self.root).parts) - 1
        require(root_depth <= len(self.anchor.chain), 'FILE_OUTSIDE_DECLARED_ROOT')
        root_fd = self.anchor.root_fd if root_depth == 0 else self.anchor.chain[root_depth - 1][2]
        directories = [('/', root_fd)]
        parts = []
        for _, name, fd, _ in self.anchor.chain[root_depth:]:
            parts.append(name)
            directories.append(('/' + '/'.join(parts), fd))
        for logical, fd in directories:
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == self.expected_owner,
                'UNTRUSTED_ANCESTOR_OWNER_OR_MODE')
            # Root-owned sticky temporary parents are permitted for read-only input
            # evidence only. They are never accepted for an executed program path.
            sticky_evidence = self.allow_sticky_evidence_ancestors and logical in ('/tmp', '/var/tmp') \
                and stat.S_IMODE(info.st_mode) == 0o1777
            require(sticky_evidence or info.st_mode & 0o7022 == 0, 'UNTRUSTED_ANCESTOR_OWNER_OR_MODE')
        self.anchor.check()

    def peek(self, offset, length):
        require(0 <= offset and 0 <= length <= 16 * 1024 * 1024 and offset + length <= self.initial.st_size,
            'ELF_READ_BOUND_INVALID')
        data = os.pread(self.fd, length, offset)
        require(len(data) == length, 'ELF_READ_SHORT')
        return data

    def read_all(self):
        return self.peek(0, self.initial.st_size)

    def snapshot(self):
        os.lseek(self.fd, 0, os.SEEK_SET)
        digest, count = hashlib.sha256(), 0
        while True:
            chunk = os.read(self.fd, min(1024 * 1024, self.bound + 1 - count))
            if not chunk:
                break
            digest.update(chunk)
            count += len(chunk)
            require(count <= self.bound, 'FILE_EXCEEDS_BOUND')
        current = os.fstat(self.fd)
        entry = os.stat(self.anchor.name, dir_fd=self.anchor.parent, follow_symlinks=False)
        require(self.helper.file_stamp(self.initial) == self.helper.file_stamp(current)
            == self.helper.file_stamp(entry) and count == self.initial.st_size, 'OPEN_FILE_OR_ENTRY_CHANGED')
        self.anchor.check()
        self.trusted_ancestors()
        result = self.helper.metadata(self.path, current)
        result['sha256'] = digest.hexdigest()
        return result

    def check_identity(self):
        # Cheap same-stage checkpoint; permissions and ancestors are rechecked.
        # Executed tools and the final proof still use a complete byte snapshot.
        current = os.fstat(self.fd)
        entry = os.stat(self.anchor.name, dir_fd=self.anchor.parent, follow_symlinks=False)
        require(self.helper.file_stamp(self.initial) == self.helper.file_stamp(current)
            == self.helper.file_stamp(entry), 'OPEN_FILE_OR_ENTRY_CHANGED')
        self.anchor.check()
        self.trusted_ancestors()

    def unchanged(self):
        after = self.snapshot()
        require(after == self.before, 'FILE_BYTES_CHANGED')
        return after

    def __exit__(self, *_):
        self.stack.close()


def allowed_system_alias(value):
    return isinstance(value, str) and value.startswith(('/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/')) \
        and not re.search(r'[\x00-\x20\x7f]', value) and '..' not in value.split('/') \
        and '.' not in value.split('/') and '//' not in value \
        and not any(part.casefold() in ('credentials', 'secrets') or part.casefold().startswith('.env')
                    or part.casefold().endswith(('.pem', '.key')) for part in value.split('/'))


def canonical_system_file(root, alias, helper, expected_owner=(0, 0)):
    require(allowed_system_alias(alias), 'NON_SYSTEM_LIBRARY_PATH')
    pending, resolved, links = alias.split('/')[1:], [], []
    followed, final_regular = 0, False
    # Resolve system aliases one anchored component at a time. A symlink never grants arbitrary path traversal.
    with helper.AnchoredPath(root, '/sentinel') as root_anchor:
        root_info = os.fstat(root_anchor.parent)
        require((root_info.st_uid, root_info.st_gid) == expected_owner and root_info.st_mode & 0o022 == 0,
            'SYSTEM_ROOT_UNTRUSTED')
    while pending:
        name = pending.pop(0)
        if name in ('', '.'):
            final_regular = False
            continue
        if name == '..':
            # Follow previous symlinks first, then traverse their actual parent.
            # Lexically normalizing a target before resolving it changes Linux semantics.
            require(resolved, 'SYSTEM_LINK_ESCAPES_LIBRARY_ROOT')
            resolved.pop()
            final_regular = False
            continue
        logical = '/' + '/'.join(resolved + [name])
        require(logical in ('/usr', '/usr/lib', '/usr/lib64', '/lib', '/lib64')
            or allowed_system_alias(logical), 'SYSTEM_LINK_ESCAPES_LIBRARY_ROOT')
        with helper.AnchoredPath(root, logical) as anchor:
            info = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
            require((info.st_uid, info.st_gid) == expected_owner, 'SYSTEM_PATH_OWNER_UNTRUSTED')
            if stat.S_ISLNK(info.st_mode):
                followed += 1
                require(followed <= 40, 'SYSTEM_SYMLINK_LIMIT_OR_LOOP')
                target = os.readlink(anchor.name, dir_fd=anchor.parent)
                require(0 < len(target) <= 4096 and not re.search(r'[\x00-\x20\x7f]', target), 'SYSTEM_LINK_TARGET_INVALID')
                after = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
                require(helper.file_stamp(info) == helper.file_stamp(after), 'SYSTEM_LINK_CHANGED')
                links.append(dict(path=logical, target=target, dev=str(info.st_dev), ino=str(info.st_ino),
                    uid=info.st_uid, gid=info.st_gid, mode=f'{stat.S_IMODE(info.st_mode):04o}',
                    mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns))
                pending = target.split('/') + pending
                if target.startswith('/'):
                    resolved = []
                final_regular = False
            else:
                require(info.st_mode & 0o7022 == 0, 'SYSTEM_PATH_MODE_UNTRUSTED')
                require(stat.S_ISDIR(info.st_mode) if pending else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                    'SYSTEM_PATH_TYPE_OR_HARDLINK_INVALID')
                resolved.append(name)
                final_regular = not pending and stat.S_ISREG(info.st_mode)
            anchor.check()
    canonical = '/' + '/'.join(resolved)
    require(canonical.startswith('/usr/lib/') and final_regular, 'CANONICAL_LIBRARY_NOT_UNDER_USR_LIB_OR_NOT_FILE')
    return dict(alias=alias, canonicalPath=canonical, links=links)


def system_bash_resolution(root, helper, shebang, expected_owner=(0, 0)):
    require(shebang in ('/bin/bash', '/usr/bin/bash'), 'SYSTEM_LDD_SHEBANG_UNSUPPORTED')
    if shebang == '/usr/bin/bash':
        return dict(shebang=shebang, canonicalPath=shebang, alias=None)
    with helper.AnchoredPath(root, '/bin') as anchor:
        info = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
        require((info.st_uid, info.st_gid) == expected_owner, 'SYSTEM_BIN_OWNER_UNTRUSTED')
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(anchor.name, dir_fd=anchor.parent)
            after = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
            require(helper.file_stamp(info) == helper.file_stamp(after), 'SYSTEM_BIN_ALIAS_CHANGED')
            require(target in ('usr/bin', '/usr/bin'), 'SYSTEM_BIN_ALIAS_UNEXPECTED')
            result = dict(shebang=shebang, canonicalPath='/usr/bin/bash', alias=dict(
                path='/bin', target=target, dev=str(info.st_dev), ino=str(info.st_ino),
                uid=info.st_uid, gid=info.st_gid, mode=f'{stat.S_IMODE(info.st_mode):04o}',
                mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns))
        else:
            require(stat.S_ISDIR(info.st_mode) and info.st_mode & 0o7022 == 0, 'SYSTEM_BIN_MODE_UNTRUSTED')
            result = dict(shebang=shebang, canonicalPath=shebang, alias=None)
        anchor.check()
        return result


def elf_metadata(file):
    header = file.peek(0, 64)
    require(header[:4] == b'\x7fELF' and header[4:7] == bytes([2, 1, 1]), 'ELF64_LITTLE_ENDIAN_REQUIRED')
    fields = struct.unpack('<HHIQQQIHHHHHH', header[16:64])
    etype, machine, version, _, phoff, _, _, ehsize, phsize, phcount, *_ = fields
    require(etype in (2, 3) and machine == 62 and version == 1 and ehsize == 64 and phsize == 56
        and 0 < phcount <= 1024, 'ELF_PROGRAM_HEADER_UNSUPPORTED')
    headers = [struct.unpack('<IIQQQQQQ', file.peek(phoff + i * 56, 56)) for i in range(phcount)]
    for ptype, _, offset, _, _, size, _, _ in headers:
        require(offset + size <= file.before['bytes'], 'ELF_SEGMENT_OUT_OF_FILE')
    interpreters = [p for p in headers if p[0] == 3]
    dynamics = [p for p in headers if p[0] == 2]
    require(len(interpreters) <= 1 and len(dynamics) <= 1, 'ELF_AMBIGUOUS_SEGMENTS')
    interpreter = None
    if interpreters:
        segment = interpreters[0]
        require(1 < segment[5] <= 4096, 'ELF_INTERPRETER_BOUND_INVALID')
        raw = file.peek(segment[2], segment[5])
        require(raw[-1:] == b'\0' and b'\0' not in raw[:-1], 'ELF_INTERPRETER_INVALID')
        try:
            interpreter = raw[:-1].decode('ascii')
        except UnicodeError as error:
            raise Refusal('ELF_INTERPRETER_ENCODING_INVALID') from error
        require(allowed_system_alias(interpreter) and posixpath.basename(interpreter) == 'ld-linux-x86-64.so.2',
            'ELF_INTERPRETER_NOT_SYSTEM_GLIBC')
    needed, soname = [], None
    if dynamics:
        segment = dynamics[0]
        require(0 < segment[5] <= 65536 and segment[5] % 16 == 0, 'ELF_DYNAMIC_BOUND_INVALID')
        tags, terminated = {}, False
        for tag, value in struct.iter_unpack('<qQ', file.peek(segment[2], segment[5])):
            if tag == 0:
                terminated = True
                break
            require(tag not in (0x7ffffffd, 0x7fffffff), 'ELF_FILTER_OR_AUXILIARY_UNSUPPORTED')
            tags.setdefault(tag, []).append(value)
        require(terminated, 'ELF_DYNAMIC_NOT_TERMINATED')
        if tags.get(1) or tags.get(14):
            require(len(tags.get(5, [])) == 1 and len(tags.get(10, [])) == 1 and len(tags.get(14, [])) <= 1,
                'ELF_STRTAB_AMBIGUOUS')
            address, length = tags[5][0], tags[10][0]
            require(0 < length <= 16 * 1024 * 1024, 'ELF_STRTAB_BOUND_INVALID')
            mapping = [p for p in headers if p[0] == 1 and p[3] <= address and address + length <= p[3] + p[5]]
            require(len(mapping) == 1, 'ELF_STRTAB_NOT_FILE_BACKED')
            strings = file.peek(mapping[0][2] + address - mapping[0][3], length)
            def name(offset):
                require(offset < len(strings), 'ELF_DEPENDENCY_NAME_OFFSET_INVALID')
                end = strings.find(b'\0', offset)
                require(end >= 0 and 0 < end - offset <= 255, 'ELF_DEPENDENCY_NAME_UNBOUNDED')
                try:
                    value = strings[offset:end].decode('ascii')
                except UnicodeError as error:
                    raise Refusal('ELF_DEPENDENCY_NAME_ENCODING_INVALID') from error
                require(SONAME.fullmatch(value), 'ELF_DEPENDENCY_NAME_INVALID')
                return value
            needed = [name(offset) for offset in tags.get(1, [])]
            require(len(needed) == len(set(needed)), 'ELF_DUPLICATE_NEEDED')
            soname = name(tags[14][0]) if tags.get(14) else None
    return dict(kind='dynamic' if dynamics else 'static', interpreter=interpreter,
        needed=needed, soname=soname, elfClass=64, machine=62)


def parse_ldd(output):
    libraries, direct_paths, virtual = {}, [], []
    lines = output.splitlines()
    require(lines, 'LDD_EMPTY_OUTPUT')
    for raw in lines:
        line = raw.strip()
        require(line, 'LDD_EMPTY_LINE')
        require('not found' not in line, 'LDD_UNRESOLVED_DEPENDENCY')
        vdso = re.fullmatch(r'(linux-vdso\.so\.[0-9]+) \(0x[a-fA-F0-9]+\)', line)
        if vdso:
            require(not virtual, 'LDD_DUPLICATE_VDSO')
            virtual.append(vdso.group(1))
            continue
        linked = re.fullmatch(r'([A-Za-z0-9_.+-]{1,255}) => (/[^\s]+) \(0x[a-fA-F0-9]+\)', line)
        direct = re.fullmatch(r'(/[^\s]+) \(0x[a-fA-F0-9]+\)', line)
        require(linked is not None or direct is not None, 'LDD_UNEXPECTED_OUTPUT')
        alias = linked.group(2) if linked else direct.group(1)
        require(allowed_system_alias(alias), 'LDD_NON_SYSTEM_PATH')
        if linked:
            key = linked.group(1)
            require(key not in libraries, 'LDD_DUPLICATE_SONAME')
            libraries[key] = alias
        else:
            require(alias not in direct_paths, 'LDD_DUPLICATE_DIRECT_PATH')
            direct_paths.append(alias)
    require(libraries and direct_paths, 'LDD_LIBRARY_OR_INTERPRETER_MISSING')
    return dict(libraries=libraries, directPaths=direct_paths, virtual=virtual)


def run_ldd(input_path):
    require(input_path in LDD_INPUTS, 'LDD_INPUT_NOT_FIXED_INSTALLED_ARTIFACT')
    argv = ['/usr/bin/ldd', '--', input_path]
    start, stdout, stderr, truncated, timed_out = time.monotonic(), bytearray(), bytearray(), False, False
    process, selector, status, command_error, spawn_error = None, None, None, None, None
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(MINIMAL_ENV), cwd='/', close_fds=True, start_new_session=True)
        selector = selectors.DefaultSelector()
        for stream, result, bound in ((process.stdout, stdout, 128 * 1024), (process.stderr, stderr, 64 * 1024)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, (result, bound))
        while selector.get_map():
            remaining = 20 - (time.monotonic() - start)
            if remaining <= 0:
                timed_out = True
                break
            for key, _ in selector.select(min(remaining, 0.25)):
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                result, bound = key.data
                available = max(0, bound - len(result))
                result.extend(chunk[:available])
                if len(chunk) > available:
                    truncated = True
                    break
            if truncated:
                break
        if timed_out or truncated:
            os.killpg(process.pid, signal.SIGKILL)
        try:
            status = process.wait(timeout=max(0.001, min(5, 20 - (time.monotonic() - start))))
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            status = process.wait(timeout=5)
    except (OSError, subprocess.SubprocessError) as error:
        detail = errno.errorcode.get(error.errno, 'IO_ERROR') if isinstance(error, OSError) else type(error).__name__
        if process is None:
            spawn_error = detail
        else:
            command_error = detail
            try:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                status = process.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                command_error += ':TERMINATION_UNVERIFIED'
    except BaseException:
        if process is not None:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        raise
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            process.stdout.close()
            process.stderr.close()
    encoding_valid = True
    try:
        out, err = stdout.decode('utf-8', errors='strict'), stderr.decode('utf-8', errors='strict')
    except UnicodeError:
        encoding_valid = False
        out, err = stdout.decode('utf-8', errors='replace'), stderr.decode('utf-8', errors='replace')
    return dict(argv=argv, environment=dict(MINIMAL_ENV), cwd='/', status=status,
        signal=-status if status is not None and status < 0 else None, timedOut=timed_out, truncated=truncated,
        spawnError=spawn_error, commandError=command_error,
        encodingValid=encoding_valid, stdout=out, stderr=err,
        stdoutHex=stdout.hex(), stderrHex=stderr.hex(), elapsedMs=round((time.monotonic() - start) * 1000, 3))


def moment(text):
    require(isinstance(text, str), 'OBSERVATION_TIME_INVALID')
    try:
        value = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError as error:
        raise Refusal('OBSERVATION_TIME_INVALID') from error
    require(value.tzinfo is not None, 'OBSERVATION_TIME_INVALID')
    return value


def current_target(root, helper):
    identities = helper.identities()
    for role, (_, uid, gid) in helper.EXPECTED.items():
        actual = identities.get(role, {})
        require(actual.get('state') == 'present' and (actual.get('uid'), actual.get('gid')) == (uid, gid)
            and actual.get('groupIds') == [gid] and actual.get('shell') == '/usr/sbin/nologin', 'TARGET_IDENTITY_CHANGED')
    process = helper.observe_processes(root)
    require(process.get('state') == 'stopped' and process.get('uninspectableCount') == 0, 'BROKER_NOT_CONFIRMED_STOPPED')
    history = [helper.observed_metadata(root, '/var/lib/openslack-cleanup/' + name) for name in helper.HISTORY]
    require(all(item['state'] == 'missing' for item in history), 'PERSISTENT_HISTORY_REQUIRES_REVIEW')
    counts = helper.directory_counts(root)
    require(counts.get('/var/lib/openslack-cleanup') == 0 and counts.get('/run/openslack-cleanup') == 0,
        'PERSISTENT_OR_RUNTIME_ENTRIES_CHANGED')
    locks = helper.observe_locks(root, history)
    require(locks.get('state') == 'none-observed', 'TARGET_LOCKS_UNVERIFIED')
    return dict(identities=identities, process=process, history=history, entryCounts=counts, locks=locks)


def validate_observation(observation, now):
    require(isinstance(observation, dict) and observation.get('schema') == 'openslack.cleanup_target_observation.v1',
        'TARGET_OBSERVATION_SCHEMA_INVALID')
    require(all(observation.get(key) == value for key, value in BINDINGS.items()), 'TARGET_OBSERVATION_BINDING_MISMATCH')
    start, end = moment(observation.get('recordedAt')), moment(observation.get('expiresAt'))
    require(start <= now < end and end > start and end - start <= timedelta(hours=24), 'TARGET_OBSERVATION_EXPIRED')
    require(observation.get('host', {}).get('system') == 'Linux' and observation.get('host', {}).get('arch') == 'x86_64',
        'TARGET_PLATFORM_MISMATCH')
    require(observation.get('neverStartedOfflineUpgrade', {}).get('eligible') is True
        and observation.get('process', {}).get('state') == 'stopped'
        and observation.get('persistentState', {}).get('state') == 'absent', 'TARGET_OBSERVATION_REQUIRES_REVIEW')
    require(isinstance(observation.get('files'), list) and len(observation['files']) == len(INSTALLED), 'INSTALLED_OBSERVATION_SET_INVALID')
    files = {}
    for entry in observation['files']:
        require(isinstance(entry, dict) and entry.get('path') in INSTALLED and entry['path'] not in files
            and entry.get('state') == 'present' and entry.get('kind') == 'regular'
            and type(entry.get('uid')) is int and entry.get('uid') == 0
            and type(entry.get('gid')) is int and entry.get('gid') == 0
            and type(entry.get('nlink')) is int and entry.get('nlink') == 1
            and type(entry.get('bytes')) is int and 0 < entry.get('bytes') <= INSTALLED[entry['path']]
            and isinstance(entry.get('mode'), str) and re.fullmatch(r'0[0-7]{3}', entry.get('mode'))
            and entry.get('mode') == INSTALLED_MODES[entry['path']]
            and int(entry['mode'], 8) & 0o7022 == 0
            and isinstance(entry.get('sha256'), str) and SHA256.fullmatch(entry.get('sha256')),
            'INSTALLED_OBSERVATION_INVALID')
        files[entry['path']] = entry
    return files


def inventory_file(observation):
    result = {key: observation[key] for key in ('path', 'sha256', 'uid', 'gid', 'mode')}
    require(result['path'].startswith('/usr/lib/') and SHA256.fullmatch(result['sha256'])
        and result['uid'] == 0 and result['gid'] == 0 and re.fullmatch(r'0[0-7]{3}', result['mode'])
        and int(result['mode'], 8) & 0o022 == 0, 'PRODUCTION_INVENTORY_FILE_INVALID')
    return result


def collect(observation, observation_digest, helper, root=Path('/'), now=None, hours=24,
            handle_factory=VerifiedFile, resolver=canonical_system_file, command_runner=run_ldd,
            target_observer=current_target, clock=lambda: datetime.now(timezone.utc),
            bash_resolver=system_bash_resolution):
    now = now or datetime.now(timezone.utc)
    raw = dict(schema='openslack.cleanup_installed_dependency_observation.v1', **BINDINGS,
        recordedAt=now.isoformat(), expiresAt=(now + timedelta(hours=hours)).isoformat(),
        targetObservationSHA256=observation_digest, frozenHelperSHA256=HELPER_SHA256,
        scope='ELF DT_NEEDED load-time closure and embedded interpreter; runtime dlopen/NSS/plugins are not asserted',
        installed=[], brokerELF=None, lddTool=None, lddShell=None, lddCalls=[], aliases=[], libraries=[], count=0,
        closureVerified=False, productionInventory=None, blockingReasons=[], installationPerformed=False, credentialContentsRead=False,
        brokerStarted=False, executorStarted=False, approvalRecorded=False, permitIssued=False)
    inventory = None
    try:
        require(isinstance(hours, int) and 1 <= hours <= 24 and SHA256.fullmatch(observation_digest),
            'COLLECTION_WINDOW_OR_SOURCE_DIGEST_INVALID')
        expected = validate_observation(observation, now)
        target_before = target_observer(root, helper)
        raw['targetBefore'] = target_before
        with ExitStack() as owned:
            installed = {logical: owned.enter_context(handle_factory(root, logical, bound, helper))
                for logical, bound in INSTALLED.items()}
            for logical, file in installed.items():
                require(all(file.before[key] == expected[logical].get(key)
                    for key in ('sha256', 'uid', 'gid', 'mode', 'bytes', 'dev', 'ino', 'nlink')),
                    'INSTALLED_ARTIFACT_DIFFERS_FROM_TARGET_OBSERVATION')
                raw['installed'].append(dict(before=file.before, after=None))
            broker = elf_metadata(installed[BROKER])
            raw['brokerELF'] = broker
            require(broker['kind'] == 'static' and broker['interpreter'] is None and not broker['needed'],
                'BROKER_NOT_STATIC_NO_BROKER_EXECUTION_ALLOWED')
            ldd = owned.enter_context(handle_factory(root, '/usr/bin/ldd', 1024 * 1024, helper))
            first_line = ldd.peek(0, min(ldd.before['bytes'], 64)).split(b'\n', 1)[0]
            require(first_line in (b'#!/bin/bash', b'#!/usr/bin/bash'), 'SYSTEM_LDD_NOT_EXPECTED_SCRIPT')
            raw['lddTool'] = dict(before=ldd.before, after=None)
            shell_resolution = bash_resolver(root, helper, first_line[2:].decode('ascii'))
            shell = owned.enter_context(handle_factory(root, shell_resolution['canonicalPath'], 16 * 1024 * 1024, helper))
            shell_elf = elf_metadata(shell)
            require(shell_elf['kind'] == 'dynamic' and shell_elf['interpreter'] is not None, 'SYSTEM_BASH_ELF_INVALID')
            raw['lddShell'] = dict(resolution=shell_resolution, before=shell.before, after=None, elf=shell_elf)
            all_aliases, all_files, metadata = {}, {}, {}
            def remember_alias(resolution):
                alias = resolution['alias']
                require(alias not in all_aliases or all_aliases[alias] == resolution, 'LIBRARY_ALIAS_CHANGED')
                all_aliases[alias] = resolution
            shell_loader = resolver(root, shell_elf['interpreter'], helper)
            remember_alias(shell_loader)
            shell_loader_path = shell_loader['canonicalPath']
            verified_shell_loader = owned.enter_context(handle_factory(root, shell_loader_path, LIBRARY_BOUND, helper))
            all_files[shell_loader_path], metadata[shell_loader_path] = verified_shell_loader, elf_metadata(verified_shell_loader)
            require(metadata[shell_loader_path]['kind'] == 'dynamic'
                and metadata[shell_loader_path]['interpreter'] is None, 'SYSTEM_LOADER_ELF_INVALID')
            raw['lddShell']['interpreterResolution'] = shell_loader
            for logical in LDD_INPUTS:
                elf = elf_metadata(installed[logical])
                require(elf['kind'] == 'dynamic' and elf['interpreter'] is not None, 'INSTALLED_DYNAMIC_EXECUTABLE_REQUIRED')
                interpreter = resolver(root, elf['interpreter'], helper)
                remember_alias(interpreter)
                # Validate the genuine embedded loader before invoking ldd; arbitrary interpreter paths never run.
                interpreter_path = interpreter['canonicalPath']
                if interpreter_path not in all_files:
                    loader = owned.enter_context(handle_factory(root, interpreter_path, LIBRARY_BOUND, helper))
                    all_files[interpreter_path], metadata[interpreter_path] = loader, elf_metadata(loader)
                loader_elf = metadata[interpreter_path]
                require(loader_elf['kind'] == 'dynamic' and loader_elf['interpreter'] is None,
                        'SYSTEM_LOADER_ELF_INVALID')
                all_files[interpreter_path].unchanged()
                installed[logical].unchanged()
                ldd.unchanged()
                shell.unchanged()
                require(bash_resolver(root, helper, first_line[2:].decode('ascii')) == shell_resolution,
                    'SYSTEM_BIN_ALIAS_CHANGED')
                call = command_runner(logical)
                raw['lddCalls'].append(dict(input=logical, installedSHA256=installed[logical].before['sha256'],
                    elf=elf, **call))
                require(call.get('argv') == ['/usr/bin/ldd', '--', logical] and call.get('environment') == MINIMAL_ENV
                    and call.get('cwd') == '/' and call.get('status') == 0 and call.get('signal') is None
                    and call.get('timedOut') is False and call.get('truncated') is False
                    and call.get('encodingValid') is True and call.get('stderr') == ''
                    and call.get('spawnError') is None and call.get('commandError') is None,
                    'LDD_COMMAND_FAILED_OR_UNKNOWN')
                parsed = parse_ldd(call.get('stdout', ''))
                local_names, local_paths = {}, set()
                for name, alias in list(parsed['libraries'].items()) + [(None, p) for p in parsed['directPaths']]:
                    resolution = resolver(root, alias, helper)
                    remember_alias(resolution)
                    canonical = resolution['canonicalPath']
                    local_paths.add(canonical)
                    if canonical not in all_files:
                        require(len(all_files) < 4096, 'DEPENDENCY_FILE_LIMIT')
                        library = owned.enter_context(handle_factory(root, canonical, LIBRARY_BOUND, helper))
                        all_files[canonical] = library
                        metadata[canonical] = elf_metadata(library)
                        require(metadata[canonical]['kind'] == 'dynamic' and metadata[canonical]['interpreter'] is None,
                            'DEPENDENCY_ELF_KIND_INVALID')
                    if name is not None:
                        require(metadata[canonical]['soname'] in (None, name), 'LDD_SONAME_DIFFERS_FROM_ELF')
                        require(name not in local_names or local_names[name] == canonical,
                            'AMBIGUOUS_DEPENDENCY_SONAME')
                        local_names[name] = canonical
                    # GNU ldd prints the loader without an arrow. libc can itself need that
                    # loader's SONAME, so bind the directly listed file's observed SONAME too.
                    actual_name = metadata[canonical]['soname']
                    if actual_name is not None:
                        require(actual_name not in local_names or local_names[actual_name] == canonical,
                            'AMBIGUOUS_DEPENDENCY_SONAME')
                        local_names[actual_name] = canonical
                require(interpreter['canonicalPath'] in local_paths, 'LDD_EMBEDDED_INTERPRETER_MISSING')
                require(set(elf['needed']).issubset(local_names), 'EXECUTABLE_DT_NEEDED_UNRESOLVED')
                for canonical in local_paths:
                    require(set(metadata[canonical]['needed']).issubset(local_names), 'TRANSITIVE_DT_NEEDED_UNRESOLVED')
                installed[logical].check_identity()
                ldd.check_identity()
                shell.check_identity()
            for alias, before in all_aliases.items():
                require(resolver(root, alias, helper) == before, 'LIBRARY_ALIAS_CHANGED')
            raw['aliases'] = [all_aliases[alias] for alias in sorted(all_aliases)]
            for canonical in sorted(all_files):
                file = all_files[canonical]
                after = file.unchanged()
                raw['libraries'].append(dict(before=file.before, after=after, elf=metadata[canonical]))
            for entry, file in zip(raw['installed'], installed.values()):
                entry['after'] = file.unchanged()
            raw['lddTool']['after'] = ldd.unchanged()
            raw['lddShell']['after'] = shell.unchanged()
            require(bash_resolver(root, helper, first_line[2:].decode('ascii')) == shell_resolution,
                'SYSTEM_BIN_ALIAS_CHANGED')
            target_after = target_observer(root, helper)
            raw['targetAfter'] = target_after
            require(target_after == target_before, 'TARGET_STATE_CHANGED_DURING_DEPENDENCY_OBSERVATION')
            require(now <= clock() < min(now + timedelta(hours=hours), moment(observation['expiresAt'])),
                'OBSERVATION_EXPIRED_OR_CLOCK_ROLLBACK_DURING_COLLECTION')
            files = [inventory_file(entry['after']) for entry in raw['libraries']]
            require(files and len({entry['path'] for entry in files}) == len(files), 'DEPENDENCY_SET_EMPTY_OR_DUPLICATE')
            raw['count'], raw['closureVerified'] = len(files), True
            # Evidence cannot outlive either its source target observation or its own collection window.
            expiry = min(now + timedelta(hours=hours), moment(observation['expiresAt']))
            raw['expiresAt'] = expiry.isoformat()
            inventory = dict(schema='openslack.cleanup_dependency_inventory.v1', **BINDINGS,
                recordedAt=now.isoformat(), expiresAt=expiry.isoformat(), files=files)
            inventory_bytes = evidence_bytes(inventory)
            raw['productionInventory'] = dict(schema=inventory['schema'],
                sha256=hashlib.sha256(inventory_bytes).hexdigest(), bytes=len(inventory_bytes), fileCount=len(files))
    except (Refusal, OSError, ValueError, KeyError, TypeError, helper.ObservationFailure) as error:
        raw['blockingReasons'].append(str(error) if isinstance(error, (Refusal, helper.ObservationFailure))
            else 'DEPENDENCY_OBSERVATION_FAILED:' + type(error).__name__)
        raw['closureVerified'], raw['productionInventory'], inventory = False, None, None
        raw['count'] = len(raw['libraries'])
    return raw, inventory


def main():
    require(sys.platform == 'linux' and os.geteuid() == 0, 'LINUX_ROOT_OBSERVER_REQUIRED')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--observation', type=Path, required=True)
    parser.add_argument('--raw-output', type=Path, required=True)
    parser.add_argument('--inventory-output', type=Path, required=True)
    parser.add_argument('--helper', type=Path, default=Path(__file__).with_name(HELPER_NAME))
    parser.add_argument('--window-hours', type=int, default=24, choices=range(1, 25))
    args = parser.parse_args()
    require(all(hasattr(os, key) for key in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC')),
        'LINUX_DESCRIPTOR_CAPABILITY_REQUIRED')
    require(args.raw_output != args.inventory_output, 'DISTINCT_EVIDENCE_OUTPUTS_REQUIRED')
    for path in (args.observation, args.raw_output, args.inventory_output, args.helper):
        try:
            common.safe_path(path)
        except common.Refusal as error:
            raise Refusal(error.code) from error
    require(not args.raw_output.exists() and not args.inventory_output.exists()
        and not args.raw_output.is_symlink() and not args.inventory_output.is_symlink(), 'EVIDENCE_OUTPUT_ALREADY_EXISTS')
    helper = load_frozen_helper(args.helper)
    with VerifiedFile(Path('/'), str(args.observation), 2 * 1024 * 1024, helper,
                      allow_sticky_evidence_ancestors=True) as source:
        observation = strict_json(source.read_all())
        digest = source.before['sha256']
        source.unchanged()
        raw, inventory = collect(observation, digest, helper, hours=args.window_hours)
        try:
            source.unchanged()
        except (Refusal, OSError, helper.ObservationFailure):
            raw['blockingReasons'].append('SOURCE_TARGET_OBSERVATION_CHANGED_DURING_COLLECTION')
            raw['closureVerified'] = False
            raw['productionInventory'] = None
            inventory = None
    helper.publish(args.raw_output, evidence_bytes(raw))
    if inventory is not None:
        helper.publish(args.inventory_output, evidence_bytes(inventory))
    print(json.dumps(dict(state='COMPLETE' if inventory else 'REFUSED_NO_INVENTORY',
        rawOutput=str(args.raw_output), inventoryOutput=str(args.inventory_output) if inventory else None,
        actualFileCount=raw['count'], blockingReasons=raw['blockingReasons'],
        installedEntrypointsInvoked=False, brokerStarted=False, installationPerformed=False)))
    return 0 if inventory is not None else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Refusal, OSError, ValueError) as error:
        print('STOP: ' + (str(error) if isinstance(error, Refusal) else type(error).__name__)
            + '; preserve any partial evidence; no automatic overwrite or replay', file=sys.stderr)
        raise SystemExit(2)
