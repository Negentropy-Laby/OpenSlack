#!/usr/bin/env python3
"""Inspect the real supervised Broker process and anchored instance; never start or activate it."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import re
import select
import stat
import sys
sys.dont_write_bytecode = True
import time

sys.path.insert(0, str(Path(__file__).parent))
import _safety as common

INSTANCE = '/var/lib/openslack-cleanup/instance.json'
BROKER = '/usr/lib/openslack-cleanup/cleanup-broker'


def validate_instance(value, *, first_start=True, now=None):
    common.exact(value, {'schema', 'brokerId', 'workspaceId', 'bootNonce', 'generation', 'startedAt'},
        'INSTANCE_UNKNOWN_OR_MISSING_FIELDS')
    common.require(value['schema'] == 'openslack.cleanup_broker_instance.v1'
        and value['brokerId'] == common.BROKER_ID and value['workspaceId'] == common.BINDINGS['workspaceId'],
        'INSTANCE_BINDING_MISMATCH')
    common.require(isinstance(value['bootNonce'], str) and common.SHA256.fullmatch(value['bootNonce']),
        'INSTANCE_NONCE_INVALID')
    common.require(isinstance(value['generation'], str) and (value['generation'] == ''
        or re.fullmatch(r'[1-9][0-9]{0,39}', value['generation'])), 'INSTANCE_GENERATION_INVALID')
    common.require(not first_start or value['generation'] == '', 'FIRST_START_GENERATION_NOT_EMPTY')
    common.require(isinstance(value['startedAt'], str), 'INSTANCE_START_TIME_INVALID')
    try:
        started = datetime.fromisoformat(value['startedAt'].replace('Z', '+00:00'))
        common.require(started.tzinfo is not None and started.utcoffset().total_seconds() == 0,
            'INSTANCE_START_TIME_INVALID')
        if now is not None:
            common.require(started <= now, 'INSTANCE_START_TIME_IN_FUTURE')
    except (ValueError, OverflowError) as error:
        raise common.Refusal('INSTANCE_START_TIME_INVALID') from error
    return value


def utc_ns(value, *, ceil=False):
    seconds, remainder = divmod(value, 1_000_000_000)
    micros = (remainder + (999 if ceil else 0)) // 1000
    return datetime.fromtimestamp(seconds, timezone.utc) + timedelta(microseconds=micros)


def start_interval(start_ticks, ticks_per_second, *, clock=time.clock_gettime_ns):
    common.require(hasattr(time, 'CLOCK_BOOTTIME') and hasattr(time, 'CLOCK_REALTIME'),
        'PROCESS_CLOCK_CAPABILITY_REQUIRED')
    before = clock(time.CLOCK_BOOTTIME)
    wall = clock(time.CLOCK_REALTIME)
    after = clock(time.CLOCK_BOOTTIME)
    common.require(type(before) is int and type(wall) is int and type(after) is int
        and 0 <= before <= after and type(ticks_per_second) is int and ticks_per_second > 0
        and isinstance(start_ticks, str) and start_ticks.isdecimal(), 'PROCESS_CLOCK_SAMPLE_INVALID')
    tick_start = int(start_ticks) * 1_000_000_000 // ticks_per_second
    tick_end = ((int(start_ticks) + 1) * 1_000_000_000 + ticks_per_second - 1) // ticks_per_second
    common.require(tick_start <= after, 'PROCESS_START_TICKS_IN_FUTURE')
    lower_epoch, upper_epoch = wall - after, wall - before
    return dict(startedAtUtc=utc_ns(lower_epoch + tick_start).isoformat(),
        startTimeUpperUtc=utc_ns(upper_epoch + tick_end, ceil=True).isoformat(),
        bootEpochLowerNs=str(lower_epoch), bootEpochUpperNs=str(upper_epoch),
        clockTicksPerSecond=ticks_per_second,
        startTimePrecision='CLOCK_BOOTTIME/UTC bracketing plus a full kernel clock tick; '
            'an instance inside the uncertainty interval is refused')


def process_record(pid, *, root=Path('/')):
    common.require(type(pid) is int and pid > 0, 'PID_INVALID')
    status = common.process_status(common.proc_text(pid, 'status', root=root))
    try:
        uid, gid = ([int(value) for value in status[key].split()] for key in ('Uid', 'Gid'))
        groups = [int(value) for value in status['Groups'].split()]
        caps = {key:status[key] for key in ('CapEff', 'CapPrm', 'CapAmb')}
        common.require(uid == [44180] * 4 and gid == [44180] * 4, 'PROCESS_UID_GID_MISMATCH')
        common.require(set(groups) <= {44180}, 'PROCESS_SUPPLEMENTARY_GROUPS_INVALID')
        common.require(all(int(value, 16) == 0 for value in caps.values()), 'PROCESS_CAPABILITIES_INVALID')
    except (KeyError, ValueError) as error:
        raise common.Refusal('PROCESS_STATUS_INVALID') from error
    comm = common.proc_text(pid, 'comm', root=root, bound=128).strip()
    common.require(comm == 'cleanup-broker', 'PROCESS_COMM_MISMATCH')
    start = common.process_start_ticks(common.proc_text(pid, 'stat', root=root))
    ticks_per_second = os.sysconf('SC_CLK_TCK')
    common.require(type(ticks_per_second) is int and ticks_per_second > 0, 'PROCESS_CLOCK_TICKS_INVALID')
    interval = start_interval(start, ticks_per_second)
    with common.Anchor(root, f'/proc/{pid}/exe', owners={0, os.geteuid(), 44180},
                       sticky_evidence=Path(root) != Path('/')) as anchor:
        link = os.stat(anchor.name, dir_fd=anchor.parent, follow_symlinks=False)
        common.require(stat.S_ISLNK(link.st_mode), 'PROCESS_EXE_LINK_INVALID')
        executable = os.readlink(anchor.name, dir_fd=anchor.parent)
        common.require(executable == BROKER, 'PROCESS_EXECUTABLE_PATH_MISMATCH')
        common.require(common.file_stamp(link) == common.file_stamp(os.stat(anchor.name,
            dir_fd=anchor.parent, follow_symlinks=False)), 'PROCESS_EXE_CHANGED')
        anchor.check()
    return dict(pid=pid, uid=uid, gid=gid, supplementaryGroups=groups, capabilities=caps,
        comm=comm, startTicks=start, executable=executable, **interval,
        argumentsRead=False, environmentRead=False)


def alive(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN | select.POLLERR | select.POLLHUP)
    return not poll.poll(0)


def process_executable(pid, *, root=Path('/'), owner=(0, 0)):
    # This is the single allowed kernel-proc symlink follow. The target is not supplied by a caller.
    # Bind the actual process executable's dev/ino to the separately verified installed Broker FD.
    with common.Anchor(root, f'/proc/{pid}/exe', owners={0, os.geteuid(), 44180},
                       sticky_evidence=Path(root) != Path('/')) as anchor, common.Owned() as owned:
        common.require(os.readlink(anchor.name, dir_fd=anchor.parent) == BROKER, 'PROCESS_EXECUTABLE_PATH_MISMATCH')
        fd = owned.add(os.open(anchor.name, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=anchor.parent))
        before = os.fstat(fd)
        common.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 64 * 1024 * 1024
            and (before.st_uid, before.st_gid) == owner and stat.S_IMODE(before.st_mode) == 0o755,
            'PROCESS_EXECUTABLE_UNTRUSTED')
        digest, count = hashlib.sha256(), 0
        while count <= 64 * 1024 * 1024:
            block = os.read(fd, min(1024 * 1024, 64 * 1024 * 1024 + 1 - count))
            if not block:
                break
            count += len(block)
            digest.update(block)
        common.require(count == before.st_size and common.file_stamp(before) == common.file_stamp(os.fstat(fd)),
            'PROCESS_EXECUTABLE_CHANGED')
        common.require(os.readlink(anchor.name, dir_fd=anchor.parent) == BROKER, 'PROCESS_EXE_CHANGED')
        anchor.check()
        return common.row(BROKER, before, digest.hexdigest())


CLOCK_FIELDS = {'startedAtUtc', 'startTimeUpperUtc', 'bootEpochLowerNs', 'bootEpochUpperNs',
    'clockTicksPerSecond', 'startTimePrecision'}


def stable_process(record):
    return {key:value for key, value in record.items() if key not in CLOCK_FIELDS}


def validate_start_binding(record, process):
    try:
        lower = datetime.fromisoformat(process['startedAtUtc'])
        upper = datetime.fromisoformat(process['startTimeUpperUtc'])
        started = datetime.fromisoformat(record['startedAt'].replace('Z', '+00:00'))
        common.require(lower.tzinfo is not None and upper.tzinfo is not None
            and lower.utcoffset().total_seconds() == 0 and upper.utcoffset().total_seconds() == 0
            and lower <= upper, 'PROCESS_START_TIME_UNVERIFIED')
        common.require(started >= lower, 'INSTANCE_PREDATES_PROCESS')
        common.require(started >= upper, 'INSTANCE_PROCESS_START_AMBIGUOUS')
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise common.Refusal('PROCESS_START_TIME_UNVERIFIED') from error


def validate_clock_continuity(before, after):
    try:
        hz = before['clockTicksPerSecond']
        common.require(type(hz) is int and hz > 0 and after['clockTicksPerSecond'] == hz,
            'PROCESS_CLOCK_CHANGED_OR_UNVERIFIED')
        lower = max(int(before['bootEpochLowerNs']), int(after['bootEpochLowerNs']))
        upper = min(int(before['bootEpochUpperNs']), int(after['bootEpochUpperNs']))
        common.require(lower - upper <= (1_000_000_000 + hz - 1) // hz,
            'PROCESS_CLOCK_CHANGED_OR_UNVERIFIED')
    except (ValueError, KeyError, TypeError) as error:
        raise common.Refusal('PROCESS_CLOCK_CHANGED_OR_UNVERIFIED') from error


def inspect(pid, expected_sha256, *, first_start=True, root=Path('/'), owner=(0, 0),
            broker_owner=(44180, 44180), process_reader=process_record, executable_reader=process_executable,
            pidfd_factory=None, pidfd_alive=alive):
    report = common.base_report('openslack.cleanup_instance_observation.v1')
    report.update(result='BLOCKED', pid=pid, firstStart=first_start, selectedBrokerId=common.BROKER_ID,
        process=None, installedBroker=None, actualProcessExecutable=None, instance=None, instanceSHA256=None,
        realNonce=None, blockingReasons=[], cleanupErrors=[], processStartedByTool=False,
        scope='current process/instance binding only; not activation, Permit or qualification evidence')
    try:
        common.linux_required()
        common.require(type(pid) is int and pid > 0, 'PID_INVALID')
        common.require(isinstance(expected_sha256, str) and common.SHA256.fullmatch(expected_sha256), 'BROKER_DIGEST_INVALID')
        pidfd_factory = pidfd_factory or getattr(os, 'pidfd_open', None)
        common.require(pidfd_factory is not None, 'PIDFD_CAPABILITY_REQUIRED')
        with common.Owned() as owned, ExitStack() as held:
            pidfd = owned.add(pidfd_factory(pid, 0))
            common.require(pidfd_alive(pidfd), 'PROCESS_ALREADY_EXITED')
            before = process_reader(pid, root=root)
            report['process'] = before
            # The process reader is internally injected for fixtures; production binds all identities here too.
            common.require(before.get('pid') == pid and before.get('uid') == [44180] * 4
                and before.get('gid') == [44180] * 4 and before.get('executable') == BROKER
                and before.get('comm') == 'cleanup-broker', 'PROCESS_BINDING_MISMATCH')
            broker = held.enter_context(common.ReadFile(root, BROKER, 64 * 1024 * 1024,
                owners={owner}, mode=0o755, sticky_evidence=True))
            actual = executable_reader(pid, root=root, owner=owner)
            digest = broker.digest()
            common.require(actual['sha256'] == digest == expected_sha256 and actual['dev'] == str(broker.info.st_dev)
                and actual['ino'] == str(broker.info.st_ino), 'PROCESS_EXECUTABLE_DIGEST_OR_INODE_MISMATCH')
            report['actualProcessExecutable'] = actual
            report['installedBroker'] = common.row(BROKER, broker.info, digest)
            source = held.enter_context(common.ReadFile(root, INSTANCE, 4096, owners={broker_owner},
                mode=0o600, sticky_evidence=True))
            data = source.read()
            record = validate_instance(common.strict_json(data, 4096), first_start=first_start,
                now=datetime.now(timezone.utc))
            validate_start_binding(record, before)
            source.check()
            broker.check()
            after = process_reader(pid, root=root)
            common.require(stable_process(before) == stable_process(after) and pidfd_alive(pidfd),
                'PROCESS_CHANGED_OR_EXITED')
            validate_clock_continuity(before, after)
            validate_start_binding(record, after)
            report['processAfter'] = after
            # Retain exact instance bytes hash rather than re-encoding a parsed object.
            report['instance'] = record
            report['instanceSHA256'] = hashlib.sha256(data).hexdigest()
            report['instanceMetadata'] = common.row(INSTANCE, source.info, report['instanceSHA256'])
            report['realNonce'] = record['bootNonce']
            report['result'] = 'PASS'
    except (common.Refusal, OSError, UnicodeError, ValueError, KeyError) as error:
        report['result'] = 'BLOCKED'
        report['realNonce'] = None
        report['blockingReasons'].append(common.error_code(error))
        report['cleanupErrors'].extend(error.cleanup if isinstance(error, common.Refusal) else [])
    return report


def positive_pid(value):
    common.require(re.fullmatch(r'[1-9][0-9]{0,9}', value) is not None, 'PID_INVALID')
    pid = int(value)
    common.require(pid <= 2**31 - 1, 'PID_INVALID')
    return pid


def main():
    common.administrator_required()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=positive_pid, required=True, help='observed PID from the supervised Broker entry')
    parser.add_argument('--expected-broker-sha256', required=True, help='actual formal package Broker SHA256')
    parser.add_argument('--output', type=Path, required=True, help='exclusive new file inside a root-owned 0700 parent')
    parser.add_argument('--allow-activated', action='store_true', help='accept an already-latched nonempty generation; default verifies first unactivated start')
    args = parser.parse_args()
    report = inspect(args.pid, args.expected_broker_sha256, first_start=not args.allow_activated)
    common.publish(args.output, report)
    sys.stdout.buffer.write(common.encode(report))
    return 0 if report['result'] == 'PASS' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (common.Refusal, OSError, ValueError) as error:
        print('STOP: ' + common.error_code(error) + '; Broker was not started or activated by this tool', file=sys.stderr)
        raise SystemExit(2)
