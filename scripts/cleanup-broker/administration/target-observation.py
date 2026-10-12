#!/usr/bin/env python3
"""Read-only installed-target observation. No credentials, authorization or manifest."""
import sys
sys.dont_write_bytecode = True
if sys.platform != "linux":
    print("STOP: LINUX_DESCRIPTOR_CAPABILITY_REQUIRED", file=sys.stderr)
    raise SystemExit(2)

import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import errno
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import sys

LAYOUT = (
    ('/usr/lib/openslack-cleanup/cleanup-broker', 64 * 1024 * 1024),
    ('/usr/lib/openslack-cleanup/executor.mjs', 64 * 1024 * 1024),
    ('/usr/lib/openslack-cleanup/node', 512 * 1024 * 1024),
    ('/usr/lib/openslack-cleanup/git', 64 * 1024 * 1024),
    ('/usr/lib/openslack-cleanup/sh', 16 * 1024 * 1024),
    ('/usr/lib/openslack-cleanup/git-core/git-remote-https', 64 * 1024 * 1024),
)
DIRECTORIES = ('/etc/openslack-cleanup', '/etc/openslack-cleanup/credentials',
               '/usr/lib/openslack-cleanup', '/run/openslack-cleanup', '/var/lib/openslack-cleanup')
HISTORY = ('ledger.jsonl', 'workers.jsonl', 'instance.json')
INSTALL_MANIFEST = '/usr/lib/openslack-cleanup/install-manifest.json'
EXPECTED = {'broker':('openslack-cleanup-broker',44180,44180),
            'agent':('openslack-cleanup-agent',44181,44181)}


class ObservationFailure(Exception):
    pass


def stamp(info):
    return (info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode)


def file_stamp(info):
    return stamp(info) + (info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def kind(mode):
    for predicate, name in ((stat.S_ISREG,'regular'),(stat.S_ISDIR,'directory'),
                            (stat.S_ISLNK,'symlink'),(stat.S_ISSOCK,'socket'),(stat.S_ISFIFO,'fifo')):
        if predicate(mode):
            return name
    return 'other'


def metadata(path, info, state='present', reason=None):
    return dict(path=path,state=state,kind=kind(info.st_mode) if info else None,
        uid=info.st_uid if info else None,gid=info.st_gid if info else None,
        mode=f'{stat.S_IMODE(info.st_mode):04o}' if info else None,
        bytes=info.st_size if info else None,nlink=info.st_nlink if info else None,
        dev=str(info.st_dev) if info else None,ino=str(info.st_ino) if info else None,
        sha256=None,reason=reason)


class AnchoredPath:
    """Every ancestor is opened from /; owned descriptors are registered immediately."""
    def __init__(self, root, path):
        self.path=path
        self.physical=Path(root) / path.lstrip('/')
        if not self.physical.is_absolute() or '..' in self.physical.parts:
            raise ObservationFailure('UNSAFE_PATH')
        self.stack=ExitStack()
        self.chain=[]

    def __enter__(self):
        try:
            fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            self.stack.callback(os.close,fd)
            self.root_fd=fd
            self.root_stamp=stamp(os.fstat(fd))
            for name in self.physical.parent.parts[1:]:
                new=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                self.stack.callback(os.close,new)
                info=os.fstat(new)
                self.chain.append((fd,name,new,stamp(info)))
                fd=new
            self.parent=fd
            self.name=self.physical.name
            return self
        except BaseException:
            self.stack.close()
            raise

    def check(self):
        if stamp(os.fstat(self.root_fd))!=self.root_stamp:
            raise ObservationFailure('ROOT_DIRECTORY_CHANGED')
        for parent,name,fd,expected in self.chain:
            if stamp(os.fstat(fd)) != expected or stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)) != expected:
                raise ObservationFailure('DIRECTORY_CHANGED')

    def __exit__(self,*_):
        self.stack.close()


def observed_metadata(root,path):
    try:
        with AnchoredPath(root,path) as anchor:
            info=os.stat(anchor.name,dir_fd=anchor.parent,follow_symlinks=False)
            anchor.check()
            return metadata(path,info,'unverified' if stat.S_ISLNK(info.st_mode) else 'present',
                            'SYMLINK' if stat.S_ISLNK(info.st_mode) else None)
    except FileNotFoundError:
        return metadata(path,None,'missing','ENOENT')
    except PermissionError:
        return metadata(path,None,'unreadable','EACCES')
    except (OSError,ObservationFailure) as error:
        return metadata(path,None,'unverified',str(error) if isinstance(error,ObservationFailure) else errno.errorcode.get(error.errno,'IO_ERROR'))


def hash_artifact(root,path,bound,expected_owner=(0,0)):
    info=None
    try:
        with AnchoredPath(root,path) as anchor:
            with ExitStack() as owned:
                fd=os.open(anchor.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=anchor.parent)
                owned.callback(os.close,fd)
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or not 0<info.st_size<=bound:
                    raise ObservationFailure('UNSAFE_ARTIFACT_TYPE_OR_SIZE')
                if (info.st_uid,info.st_gid)!=expected_owner or info.st_mode & 0o7022:
                    raise ObservationFailure('UNTRUSTED_ARTIFACT_OWNER_OR_MODE')
                digest=hashlib.sha256()
                read=0
                while True:
                    block=os.read(fd,min(1024*1024,bound+1-read))
                    if not block:
                        break
                    digest.update(block)
                    read+=len(block)
                    if read>bound:
                        raise ObservationFailure('ARTIFACT_TOO_LARGE')
                after=os.fstat(fd)
                entry=os.stat(anchor.name,dir_fd=anchor.parent,follow_symlinks=False)
                if file_stamp(info)!=file_stamp(after) or file_stamp(info)!=file_stamp(entry) or read!=info.st_size:
                    raise ObservationFailure('ARTIFACT_CHANGED')
                anchor.check()
                result=metadata(path,info)
                result['sha256']=digest.hexdigest()
                return result
    except FileNotFoundError:
        return metadata(path,None,'missing','ENOENT')
    except PermissionError:
        return metadata(path,info,'unreadable','EACCES')
    except (OSError,ObservationFailure) as error:
        return metadata(path,info,'unverified',str(error) if isinstance(error,ObservationFailure) else errno.errorcode.get(error.errno,'IO_ERROR'))


def list_directory(root,path,bound=16384):
    with AnchoredPath(root,path) as anchor,ExitStack() as owned:
        fd=os.open(anchor.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=anchor.parent)
        owned.callback(os.close,fd)
        before=os.fstat(fd)
        with os.scandir(fd) as entries:
            names=[]
            for entry in entries:
                if len(names)>=bound:
                    raise ObservationFailure('DIRECTORY_ENTRY_LIMIT')
                names.append(entry.name)
        if stamp(before)!=stamp(os.fstat(fd)) or stamp(before)!=stamp(os.stat(anchor.name,dir_fd=anchor.parent,follow_symlinks=False)):
            raise ObservationFailure('DIRECTORY_CHANGED')
        anchor.check()
        return names


def bounded_system_text(root,path,bound):
    # Allowed system metadata only. No arbitrary path from command options is read.
    if not path.startswith('/proc/'):
        raise ObservationFailure('SYSTEM_METADATA_PATH_FORBIDDEN')
    with AnchoredPath(root,path) as anchor,ExitStack() as owned:
        fd=os.open(anchor.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=anchor.parent)
        owned.callback(os.close,fd)
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>bound:
            raise ObservationFailure('UNSAFE_SYSTEM_METADATA')
        data=bytearray()
        while len(data)<=bound:
            block=os.read(fd,min(4096,bound+1-len(data)))
            if not block:
                break
            data.extend(block)
        if len(data)>bound:
            raise ObservationFailure('SYSTEM_METADATA_TOO_LARGE')
        entry=os.stat(anchor.name,dir_fd=anchor.parent,follow_symlinks=False)
        if stamp(info)!=stamp(os.fstat(fd)) or stamp(info)!=stamp(entry):
            raise ObservationFailure('SYSTEM_METADATA_CHANGED')
        anchor.check()
        return data.decode('utf-8',errors='strict')


def identities():
    result={}
    for role,(name,_,_) in EXPECTED.items():
        try:
            user=pwd.getpwnam(name)
            groups=sorted(set(os.getgrouplist(name,user.pw_gid)))
            result[role]=dict(state='present',name=name,uid=user.pw_uid,gid=user.pw_gid,
                             shell=user.pw_shell,groupIds=groups)
        except KeyError:
            result[role]=dict(state='missing',name=name,uid=None,gid=None,shell=None,groupIds=[])
        except OSError:
            result[role]=dict(state='unverified',name=name,uid=None,gid=None,shell=None,groupIds=[])
    return result


def observe_processes(root):
    matches=[]
    unavailable=0
    try:
        names=list_directory(root,'/proc')
        for name in names:
            if not name.isdecimal():
                continue
            try:
                comm=bounded_system_text(root,f'/proc/{name}/comm',128).strip()
                if comm=='cleanup-broker':
                    status=bounded_system_text(root,f'/proc/{name}/status',65536)
                    fields={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in status.splitlines() if ':' in line}
                    matches.append(dict(pid=int(name),uid=[int(v) for v in fields['Uid'].split()],
                                        gid=[int(v) for v in fields['Gid'].split()]))
            except FileNotFoundError:
                # A process exited during scanning; no surviving PID was hidden.
                continue
            except (OSError,ObservationFailure,UnicodeError,KeyError,ValueError):
                unavailable+=1
        return dict(state='unverified' if unavailable else 'running' if matches else 'stopped',
                    pid=matches[0]['pid'] if len(matches)==1 else None,pids=matches,
                    uninspectableCount=unavailable,argumentsRead=False,environmentRead=False)
    except (OSError,ObservationFailure):
        return dict(state='unverified',pid=None,pids=[],uninspectableCount=None,
                    argumentsRead=False,environmentRead=False)


def observe_locks(root,objects):
    matches=[]
    try:
        for line in bounded_system_text(root,'/proc/locks',2*1024*1024).splitlines():
            parts=line.split()
            for index,part in enumerate(parts):
                components=part.split(':')
                if len(components)!=3:
                    continue
                try:
                    major,minor,inode=int(components[0],16),int(components[1],16),int(components[2])
                except ValueError:
                    continue
                for obj in objects:
                    if obj['dev'] is not None and (os.major(int(obj['dev'])),os.minor(int(obj['dev'])),int(obj['ino']))==(major,minor,inode):
                        pid=int(parts[index-1]) if index>0 and parts[index-1].lstrip('-').isdigit() else None
                        matches.append(dict(path=obj['path'],pid=pid))
        return dict(state='held' if matches else 'none-observed',matchedLocks=matches,
                    scope='momentary kernel lock metadata; not a claim or a future lock guarantee')
    except (OSError,ObservationFailure,UnicodeError):
        return dict(state='unverified',matchedLocks=[],scope='kernel lock metadata unavailable')


def directory_counts(root):
    counts={}
    for path in ('/var/lib/openslack-cleanup','/run/openslack-cleanup'):
        try:
            counts[path]=len(list_directory(root,path,4096))
        except FileNotFoundError:
            counts[path]=0 if path=='/run/openslack-cleanup' else None
        except (OSError,ObservationFailure):
            counts[path]=None
    return counts


def observe(root=Path('/'),identity_source=identities,expected_owner=(0,0),hours=24):
    start=datetime.now(timezone.utc)
    ids=identity_source()
    dirs=[observed_metadata(root,path) for path in DIRECTORIES]
    files=[hash_artifact(root,path,bound,expected_owner) for path,bound in LAYOUT]
    history=[observed_metadata(root,'/var/lib/openslack-cleanup/'+name) for name in HISTORY]
    installed_manifest=observed_metadata(root,INSTALL_MANIFEST)
    socket=observed_metadata(root,'/run/openslack-cleanup/broker.sock')
    process=observe_processes(root)
    problems=[]
    for role,(name,uid,gid) in EXPECTED.items():
        entry=ids.get(role,{})
        if entry.get('state')!='present' or (entry.get('uid'),entry.get('gid'))!=(uid,gid) or entry.get('groupIds')!=[gid]:
            problems.append('IDENTITY_MAPPING_OR_GROUPS_UNVERIFIED:'+role)
    if ids.get('agent',{}).get('shell')!='/usr/sbin/nologin':
        problems.append('AGENT_SHELL_MISMATCH')
    if any(f['state']!='present' for f in files):
        problems.append('INSTALLED_ARTIFACT_UNVERIFIED')
    if process['state']!='stopped':
        problems.append('BROKER_PROCESS_NOT_CONFIRMED_STOPPED')
    counts=directory_counts(root)
    if any(h['state']!='missing' for h in history) or counts['/var/lib/openslack-cleanup']!=0:
        problems.append('UNEXPECTED_OR_UNVERIFIED_PERSISTENT_HISTORY')
    if counts['/run/openslack-cleanup'] not in (0,):
        problems.append('RUNTIME_ENTRIES_REQUIRE_REVIEW')
    if any(d['state'] not in ('present','missing') for d in dirs):
        problems.append('INSTALLATION_DIRECTORY_UNVERIFIED')
    if installed_manifest['state'] not in ('present','missing') or (installed_manifest['state']=='present'
            and installed_manifest['kind']!='regular'):
        problems.append('INSTALLED_MANIFEST_METADATA_REQUIRES_REVIEW')
    locks=observe_locks(root,history+[socket])
    if locks['state']!='none-observed':
        problems.append('KERNEL_LOCK_OBSERVATION_REQUIRES_REVIEW')
    # Observe again after hashing; an intervening startup does not leave a stale "stopped" claim.
    after_process=observe_processes(root)
    if after_process!=process:
        problems.append('PROCESS_OBSERVATION_CHANGED')
    after_history=[observed_metadata(root,'/var/lib/openslack-cleanup/'+name) for name in HISTORY]
    if after_history!=history:
        problems.append('PERSISTENT_METADATA_CHANGED')
    after_manifest=observed_metadata(root,INSTALL_MANIFEST)
    if after_manifest!=installed_manifest:
        problems.append('INSTALLED_MANIFEST_METADATA_CHANGED')
    after_counts=directory_counts(root)
    if after_counts!=counts:
        problems.append('STATE_OR_RUNTIME_ENTRY_COUNT_CHANGED')
    if after_counts['/var/lib/openslack-cleanup']!=0:
        problems.append('UNEXPECTED_OR_UNVERIFIED_PERSISTENT_HISTORY')
    if after_counts['/run/openslack-cleanup']!=0:
        problems.append('RUNTIME_ENTRIES_REQUIRE_REVIEW')
    uname=os.uname()
    return dict(schema='openslack.cleanup_target_observation.v1',
        target='OpenSlack-Cleanup-Qual',targetLabelSource='externally selected; caller must verify distribution routing',
        workspaceId='openslack-self',repository='Negentropy-Laby/openslack-cleanup-qualification',
        repositoryId='1380965476',bindingSource='prior selection; no GitHub authority query performed',
        recordedAt=start.isoformat(),expiresAt=(start+timedelta(hours=hours)).isoformat(),
        host=dict(hostname=uname.nodename,kernel=uname.release,arch=uname.machine,system=uname.sysname),
        observer=dict(uid=os.geteuid(),gid=os.getegid()),identities=ids,directories=dirs,files=files,
        installedManifest=dict(observation=after_manifest,contentsRead=False,
            scope='presence and metadata only; absent remains absent, no installation proof is manufactured'),
        process=after_process,persistentState=dict(state='absent' if all(h['state']=='missing' for h in after_history)
            and after_counts['/var/lib/openslack-cleanup']==0 and 'PERSISTENT_METADATA_CHANGED' not in problems
            and 'STATE_OR_RUNTIME_ENTRY_COUNT_CHANGED' not in problems else 'requires-review',
            objects=after_history,directoryEntryCount=after_counts['/var/lib/openslack-cleanup'],
            ledgerSHA256=None,journalSHA256=None,contentsRead=False),
        runtime=dict(socket=socket,directoryEntryCount=after_counts['/run/openslack-cleanup']),locks=locks,
        neverStartedOfflineUpgrade=dict(eligible=not problems,blockingReasons=sorted(set(problems)),
        scope='identity/files/process/history/lock observation preconditions only; not full installation or dependency acceptance'),
        dependencyInventory=dict(state='NOT_COLLECTED',files=[],count=0,closureVerified=False),
        candidateBytesRead=False,credentialContentsRead=False,historyContentsRead=False,
        manifestProduced=False,approvalRecorded=False,brokerStarted=False,installationPerformed=False)


def publish(output,data):
    if not output.is_absolute() or '..' in output.parts:
        raise ObservationFailure('OUTPUT_PATH_INVALID')
    if any(p in ('credentials','secrets','.env') or p.endswith(('.pem','.key')) for p in output.parts):
        raise ObservationFailure('OUTPUT_PATH_SENSITIVE')
    if any(str(output)==p or str(output).startswith(p+'/') for p in
        ('/etc/openslack-cleanup','/usr/lib/openslack-cleanup','/run/openslack-cleanup','/var/lib/openslack-cleanup')):
        raise ObservationFailure('OUTPUT_ACTIVE_PATH_FORBIDDEN')
    with AnchoredPath(Path('/'),str(output)) as anchor,ExitStack() as owned:
        parent=os.fstat(anchor.parent)
        if parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            raise ObservationFailure('OUTPUT_DIRECTORY_NOT_PRIVATE')
        fd=os.open(anchor.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=anchor.parent)
        owned.callback(os.close,fd)
        info=os.fstat(fd)
        if stat.S_IMODE(info.st_mode)!=0o600 or not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
            raise ObservationFailure('OUTPUT_FILE_UNSAFE')
        view=memoryview(data)
        while view:
            n=os.write(fd,view)
            if n<=0:
                raise ObservationFailure('OUTPUT_WRITE_NO_PROGRESS')
            view=view[n:]
        os.fsync(fd)
        os.fsync(anchor.parent)
        current=os.stat(anchor.name,dir_fd=anchor.parent,follow_symlinks=False)
        if (current.st_dev,current.st_ino)!=(info.st_dev,info.st_ino):
            raise ObservationFailure('OUTPUT_REPLACED')
        anchor.check()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,help='optional exclusive file in an existing private Linux directory')
    parser.add_argument('--window-hours',type=int,default=24,choices=range(1,25))
    args=parser.parse_args()
    if sys.platform!='linux' or any(not hasattr(os,n) for n in ('O_NOFOLLOW','O_DIRECTORY','O_NONBLOCK')):
        raise ObservationFailure('LINUX_DESCRIPTOR_CAPABILITY_REQUIRED')
    report=observe(hours=args.window_hours)
    data=(json.dumps(report,indent=2)+'\n').encode()
    publication_failed=False
    if args.output:
        try:
            publish(args.output,data)
        except (OSError,ObservationFailure) as error:
            publication_failed=True
            code=str(error) if isinstance(error,ObservationFailure) else errno.errorcode.get(error.errno,'IO_ERROR')
            print('OBSERVATION_OUTPUT_REFUSED: '+code+'; preserve any partial output',file=sys.stderr)
    sys.stdout.buffer.write(data)
    return 2 if publication_failed or not report['neverStartedOfflineUpgrade']['eligible'] else 0


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (OSError,ObservationFailure,ValueError) as error:
        code=str(error) if isinstance(error,ObservationFailure) else 'OBSERVATION_FAILED'
        print('STOP: '+code,file=sys.stderr)
        raise SystemExit(2)
