"""Private Linux FD primitives for fixed-path administrator observations.

The CLI tools are read-only except an explicitly new evidence/backup destination.
Fixture roots and OS-call injection are function parameters, never CLI options.
"""
from datetime import datetime, timedelta, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

BINDINGS = dict(target='OpenSlack-Cleanup-Qual', workspaceId='openslack-self',
    repository='Negentropy-Laby/openslack-cleanup-qualification', repositoryId='1380965476')
BROKER_UID, BROKER_GID, AGENT_UID, AGENT_GID = 44180, 44180, 44181, 44181
BROKER_ID, AGENT_ID = 'cleanup-broker-pr418', 'cleanup_qualification_pr418'
LAYOUT = {
    '/usr/lib/openslack-cleanup/cleanup-broker': (64 * 1024 * 1024, 0o755),
    '/usr/lib/openslack-cleanup/executor.mjs': (64 * 1024 * 1024, 0o644),
    '/usr/lib/openslack-cleanup/node': (512 * 1024 * 1024, 0o755),
    '/usr/lib/openslack-cleanup/git': (64 * 1024 * 1024, 0o755),
    '/usr/lib/openslack-cleanup/sh': (16 * 1024 * 1024, 0o755),
    '/usr/lib/openslack-cleanup/git-core/git-remote-https': (64 * 1024 * 1024, 0o755),
}
ACTIVE = ('/etc/openslack-cleanup', '/usr/lib/openslack-cleanup',
    '/var/lib/openslack-cleanup', '/run/openslack-cleanup')
SHA256 = re.compile(r'^[0-9a-f]{64}$')


class Refusal(Exception):
    """Stable, non-secret code; retain cleanup diagnostics without losing the cause."""
    def __init__(self, code, cleanup=()):
        super().__init__(code)
        self.code = code
        self.cleanup = list(cleanup)


def require(value, code):
    if not value:
        raise Refusal(code)


def error_code(error):
    return error.code if isinstance(error, Refusal) else (
        errno.errorcode.get(error.errno, 'IO_ERROR') if isinstance(error, OSError) else type(error).__name__)


def linux_required():
    require(sys.platform == 'linux' and all(hasattr(os, key) for key in
        ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK', 'O_CLOEXEC', 'pread', 'setresuid', 'setresgid')),
        'LINUX_DESCRIPTOR_CAPABILITY_REQUIRED')


def administrator_required():
    linux_required()
    require(os.getuid() == os.geteuid() == 0 and os.getgid() == os.getegid() == 0,
        'LINUX_ROOT_ADMINISTRATOR_REQUIRED')


def safe_path(value):
    require(isinstance(value, (str, Path)), 'PATH_TYPE_INVALID')
    text = str(value)
    require(text.startswith('/') and not re.search(r'[\x00-\x1f\x7f]', text), 'PATH_INVALID')
    require('..' not in text.split('/') and '.' not in text.split('/') and '//' not in text,
        'PATH_TRAVERSAL_OR_ALIAS')
    require(not any(part.casefold() in ('credentials', 'secrets', '.ssh', '.gnupg', '.aws', '.azure', '.kube') or part.casefold().startswith('.env')
        or part.casefold().endswith(('.pem', '.key')) for part in text.split('/')), 'SENSITIVE_PATH_FORBIDDEN')
    return text


def output_path(value):
    text = safe_path(value)
    require(not any(text == path or text.startswith(path + '/') for path in ACTIVE), 'ACTIVE_OUTPUT_FORBIDDEN')
    return text


def directory_stamp(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)


def file_stamp(info):
    return directory_stamp(info) + (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def row(path, info, sha256=None):
    return dict(path=path, uid=info.st_uid, gid=info.st_gid,
        mode=f'{stat.S_IMODE(info.st_mode):04o}', bytes=info.st_size,
        dev=str(info.st_dev), ino=str(info.st_ino), nlink=info.st_nlink, sha256=sha256)


class Owned:
    def __init__(self):
        self.fds = []

    def add(self, fd):
        # Ownership is registered before the first fstat/validation can throw.
        self.fds.append(fd)
        return fd

    def close(self, primary=None):
        failures = []
        while self.fds:
            fd = self.fds.pop()
            try:
                os.close(fd)
            except OSError as error:
                failures.append(error_code(error))
        if failures:
            if isinstance(primary, Refusal):
                primary.cleanup.extend(failures)
                raise primary
            if primary is not None:
                raise Refusal(error_code(primary), failures) from primary
            raise Refusal('FD_CLEANUP_FAILED', failures)

    def __enter__(self):
        return self

    def __exit__(self, _, primary, __):
        self.close(primary)


class Anchor:
    """Walk from filesystem root, hold every parent, reject links before any write."""
    def __init__(self, root, logical, owners=None, sticky_evidence=False, sensitive_metadata=False):
        logical = str(logical)
        if sensitive_metadata:
            require(logical in ('/etc/openslack-cleanup/credentials',
                '/etc/openslack-cleanup/credentials/governance',
                '/etc/openslack-cleanup/credentials/github-app-private-key'), 'METADATA_PATH_FORBIDDEN')
        else:
            safe_path(logical)
        self.root = Path(root)
        require(self.root.is_absolute() and '..' not in self.root.parts, 'FIXTURE_ROOT_INVALID')
        self.logical, self.physical = logical, self.root / logical.lstrip('/')
        self.owners = {0, os.geteuid()} if owners is None else set(owners)
        self.sticky_evidence = sticky_evidence
        self.owned, self.chain = Owned(), []

    def trusted(self, fd, physical):
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in self.owners,
            'UNTRUSTED_ANCESTOR_OWNER_OR_MODE')
        sticky = self.sticky_evidence and physical in ('/tmp', '/var/tmp') \
            and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o1777
        require(sticky or info.st_mode & 0o7022 == 0, 'UNTRUSTED_ANCESTOR_OWNER_OR_MODE')
        return directory_stamp(info)

    def __enter__(self):
        try:
            current = self.owned.add(os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
            self.root_fd = current
            self.root_stamp = self.trusted(current, '/')
            components = []
            for name in self.physical.parent.parts[1:]:
                new = self.owned.add(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=current))
                components.append(name)
                stamp = self.trusted(new, '/' + '/'.join(components))
                self.chain.append((current, name, new, stamp, '/' + '/'.join(components)))
                current = new
            self.parent, self.name = current, self.physical.name
            self.check()
            return self
        except BaseException as error:
            self.owned.close(error)
            raise

    def check(self):
        require(self.trusted(self.root_fd, '/') == self.root_stamp, 'ROOT_DIRECTORY_CHANGED')
        for parent, name, fd, expected, physical in self.chain:
            require(self.trusted(fd, physical) == expected
                and directory_stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected,
                'DIRECTORY_CHANGED')

    def __exit__(self, _, primary, __):
        self.owned.close(primary)


class ReadFile:
    def __init__(self, root, logical, bound, owners=None, mode=None, empty=False, sticky_evidence=False):
        self.anchor = Anchor(root, logical, owners={0, os.geteuid(), BROKER_UID} if owners is None else
            {0, os.geteuid(), *(uid for uid, _ in owners)}, sticky_evidence=sticky_evidence)
        self.logical, self.bound, self.owners, self.mode, self.empty = str(logical), bound, owners, mode, empty
        self.owned = Owned()

    def __enter__(self):
        try:
            self.anchor.__enter__()
            self.fd = self.owned.add(os.open(self.anchor.name,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.anchor.parent))
            self.info = os.fstat(self.fd)
            require(stat.S_ISREG(self.info.st_mode) and self.info.st_nlink == 1
                and (0 if self.empty else 1) <= self.info.st_size <= self.bound, 'UNSAFE_FILE_TYPE_OR_SIZE')
            require(self.owners is None or (self.info.st_uid, self.info.st_gid) in self.owners,
                'FILE_OWNER_MISMATCH')
            require(self.info.st_mode & 0o7022 == 0 and (self.mode is None or stat.S_IMODE(self.info.st_mode) == self.mode),
                'FILE_MODE_MISMATCH')
            self.check()
            return self
        except BaseException as error:
            self.close(error)
            raise

    def check(self):
        require(file_stamp(self.info) == file_stamp(os.fstat(self.fd)) == file_stamp(
            os.stat(self.anchor.name, dir_fd=self.anchor.parent, follow_symlinks=False)), 'FILE_CHANGED')
        self.anchor.check()

    def chunks(self):
        os.lseek(self.fd, 0, os.SEEK_SET)
        total = 0
        while total <= self.bound:
            data = os.read(self.fd, min(1024 * 1024, self.bound + 1 - total))
            if not data:
                break
            total += len(data)
            require(total <= self.bound, 'FILE_TOO_LARGE')
            yield data
        require(total == self.info.st_size, 'FILE_SIZE_CHANGED')
        self.check()

    def read(self):
        return b''.join(self.chunks())

    def digest(self):
        digest = hashlib.sha256()
        for block in self.chunks():
            digest.update(block)
        return digest.hexdigest()

    def close(self, primary=None):
        cleanup = None
        try:
            self.owned.close(primary)
        except BaseException as error:
            cleanup = error
        try:
            self.anchor.__exit__(None, cleanup or primary, None)
        except BaseException as error:
            cleanup = error
        if cleanup is not None:
            raise cleanup

    def __exit__(self, _, primary, __):
        self.close(primary)


def strict_json(data, bound=2 * 1024 * 1024):
    require(isinstance(data, bytes) and 0 < len(data) <= bound, 'JSON_SIZE_INVALID')
    def pairs(values):
        out = {}
        for key, value in values:
            require(key not in out, 'DUPLICATE_JSON_KEY')
            out[key] = value
        return out
    def constant(_):
        raise Refusal('NON_JSON_CONSTANT')
    try:
        return json.loads(data.decode('utf-8', errors='strict'), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError) as error:
        raise Refusal('INVALID_JSON_OR_UTF8') from error


def exact(value, keys, code='UNKNOWN_OR_MISSING_FIELDS'):
    require(isinstance(value, dict) and set(value) == set(keys), code)
    return value


def encode(value):
    return (json.dumps(value, indent=2, allow_nan=False) + '\n').encode('utf-8')


def write_all(fd, data):
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        require(0 < count <= len(view), 'WRITE_NO_PROGRESS')
        view = view[count:]


def publish(output, value):
    output = output_path(output)
    data = encode(value)
    with Anchor(Path('/'), output, sticky_evidence=True) as anchor, Owned() as owned:
        info = os.fstat(anchor.parent)
        require(info.st_uid in (0, os.geteuid()) and stat.S_IMODE(info.st_mode) == 0o700,
            'OUTPUT_PARENT_NOT_PRIVATE')
        fd = owned.add(os.open(anchor.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600, dir_fd=anchor.parent))
        identity = os.fstat(fd)
        require(stat.S_ISREG(identity.st_mode) and identity.st_nlink == 1
            and stat.S_IMODE(identity.st_mode) == 0o600, 'OUTPUT_FILE_UNSAFE')
        write_all(fd, data)
        os.fsync(fd)
        entry = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
        require((entry.st_dev, entry.st_ino) == (identity.st_dev, identity.st_ino), 'OUTPUT_REPLACED')
        os.fsync(anchor.parent)
        anchor.check()


def base_report(schema, hours=24):
    require(type(hours) is int and 1 <= hours <= 24, 'EVIDENCE_WINDOW_INVALID')
    now = datetime.now(timezone.utc)
    return dict(schema=schema, **BINDINGS, recordedAt=now.isoformat(),
        expiresAt=(now + timedelta(hours=hours)).isoformat(), observer=dict(uid=getattr(os, 'geteuid', lambda: None)(), gid=getattr(os, 'getegid', lambda: None)()),
        approvalRecorded=False, installationPerformed=False, brokerStarted=False, permitIssued=False,
        activationIssued=False, credentialContentsRead=False, networkExecuted=False)


def load_source(path, name):
    # Compile precisely the bounded FD bytes we audited, with no second path import or pyc write.
    path = Path(path)
    with ReadFile(Path('/'), str(path), 128 * 1024, owners={(0, 0), (os.geteuid(), os.getegid())},
                  sticky_evidence=True) as source:
        data = source.read()
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(data, str(path), 'exec'), module.__dict__)
    return module


def proc_text(pid, name, root=Path('/'), bound=65536):
    require(type(pid) is int and pid > 0 and name in ('status', 'comm', 'stat'), 'PROC_METADATA_PATH_INVALID')
    logical = f'/proc/{pid}/{name}'
    pid_owner = os.stat(Path(root) / 'proc' / str(pid), follow_symlinks=False).st_uid
    with Anchor(root, logical, owners={0, os.geteuid(), BROKER_UID, AGENT_UID, pid_owner},
                sticky_evidence=Path(root) != Path('/')) as anchor, Owned() as owned:
        fd = owned.add(os.open(anchor.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=anchor.parent))
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= bound, 'PROC_METADATA_UNSAFE')
        data = bytearray()
        while len(data) <= bound:
            block = os.read(fd, min(4096, bound + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(len(data) <= bound, 'PROC_METADATA_TOO_LARGE')
        require(directory_stamp(before) == directory_stamp(os.fstat(fd)) == directory_stamp(
            os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)), 'PROC_METADATA_CHANGED')
        anchor.check()
        return bytes(data).decode('utf-8', errors='strict')


def process_status(text):
    result = {}
    for line in text.splitlines():
        if ':' in line:
            key, value = line.split(':', 1)
            require(key not in result, 'DUPLICATE_PROC_FIELD')
            result[key] = value.strip()
    return result


def process_start_ticks(text):
    end = text.rfind(')')
    require(end > 0, 'PROC_STAT_INVALID')
    fields = text[end + 1:].split()
    require(len(fields) >= 20 and fields[19].isdecimal(), 'PROC_STAT_INVALID')
    return fields[19]


def boot_time(root=Path('/')):
    with Anchor(root, '/proc/stat', owners={0, os.geteuid()}, sticky_evidence=Path(root) != Path('/')) as anchor, Owned() as owned:
        fd = owned.add(os.open(anchor.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=anchor.parent))
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 1024 * 1024, 'PROC_STAT_UNSAFE')
        data = bytearray()
        while len(data) <= 1024 * 1024:
            block = os.read(fd, min(65536, 1024 * 1024 + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(len(data) <= 1024 * 1024, 'PROC_STAT_TOO_LARGE')
        values = [line.split() for line in data.decode('ascii', errors='strict').splitlines() if line.startswith('btime ')]
        require(len(values) == 1 and len(values[0]) == 2 and values[0][1].isdecimal(), 'PROC_BOOT_TIME_INVALID')
        require(directory_stamp(info) == directory_stamp(os.fstat(fd)) == directory_stamp(
            os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)), 'PROC_STAT_CHANGED')
        anchor.check()
        return int(values[0][1])
