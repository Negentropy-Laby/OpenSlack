//go:build linux

// Package lifecycle owns one broker boot, its exclusive ledger lock and its
// fixed Unix listener. A boot nonce is never activation. The HTTP handler must
// independently authenticate the peer and verify the fixed authority policy,
// including BrokerID, before calling Admit at each effect boundary.
package lifecycle

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

const (
	runDirectory   = "/run/openslack-cleanup"
	instancePath   = "/var/lib/openslack-cleanup/instance.json"
	instanceSchema = "openslack.cleanup_broker_instance.v1"
	socketName     = "broker.sock"
	instanceName   = "instance.json"
	oPath          = 0x200000
)

var (
	ErrUnsafeRuntime     = errors.New("BROKER_RUNTIME_UNSAFE")
	ErrNotActivated      = errors.New("BROKER_NOT_ACTIVATED")
	ErrStopped           = errors.New("BROKER_ADMISSION_STOPPED")
	ErrClockRollback     = errors.New("BROKER_CLOCK_ROLLBACK")
	ErrGenerationChanged = errors.New("BROKER_GENERATION_CHANGED_RESTART_REQUIRED")
	decimal              = regexp.MustCompile(`^[1-9][0-9]{0,39}$`)
	noncePattern         = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type configView interface {
	Config() config.Config
	CheckUnchanged() error
}

type startSpec struct {
	root     string
	uid, gid uint32
	now      func() time.Time
	newNonce func() (string, error)
}

func (s startSpec) path(path string) string {
	return filepath.Join(s.root, strings.TrimPrefix(path, "/"))
}

type instanceRecord struct {
	Schema      string    `json:"schema"`
	BrokerID    string    `json:"brokerId"`
	WorkspaceID string    `json:"workspaceId"`
	BootNonce   string    `json:"bootNonce"`
	Generation  string    `json:"generation"`
	StartedAt   time.Time `json:"startedAt"`
}

type Runtime struct {
	// These references are owned by Runtime. Close only after HTTP shutdown and
	// admitted handlers have drained. Ledger itself does not authorize a send.
	Ledger               *ledger.Ledger
	Listener             *net.UnixListener
	BootNonce            string
	mu                   sync.Mutex
	view                 configView
	spec                 startSpec
	runDir, stateDir     *os.File
	runStamp, stateStamp syscall.Stat_t
	socketStamp          *syscall.Stat_t
	instanceFile         *os.File
	instanceStamp        syscall.Stat_t
	instance             instanceRecord
	lastWall             time.Time
	stopped              error
	closed               bool
	syncRecord           func(*os.File) error
	syncState            func() error
}

// Start never creates installation/state/run directories. Administrator setup
// must provide broker-owned state 0700 and run 0755 directories. Socket 0666
// admits distinct peer UIDs without sharing the credential-readable broker GID;
// SO_PEERCRED plus the administrator peer mapping is the authentication gate.
func Start(snapshot *config.Snapshot) (*Runtime, error) {
	if snapshot == nil {
		return nil, ErrUnsafeRuntime
	}
	c := snapshot.Config()
	if c.UID == 0 || c.GID == 0 || c.UID != uint32(os.Geteuid()) || c.GID != uint32(os.Getegid()) {
		return nil, ErrUnsafeRuntime
	}
	return start(snapshot, startSpec{root: "/", uid: c.UID, gid: c.GID, now: time.Now, newNonce: permit.NewBootNonce})
}

func start(view configView, spec startSpec) (_ *Runtime, err error) {
	if view == nil || view.CheckUnchanged() != nil {
		return nil, ErrUnsafeRuntime
	}
	r := &Runtime{view: view, spec: spec}
	defer func() {
		if err != nil {
			err = errors.Join(err, r.Close())
		}
	}()
	r.runDir, err = r.openDirectory(runDirectory, 0755)
	if err != nil {
		return nil, err
	}
	r.stateDir, err = r.openDirectory(config.StatePath, 0700)
	if err != nil {
		return nil, err
	}
	r.syncRecord = func(f *os.File) error { return f.Sync() }
	r.syncState = r.stateDir.Sync
	if syscall.Fstat(int(r.runDir.Fd()), &r.runStamp) != nil || syscall.Fstat(int(r.stateDir.Fd()), &r.stateStamp) != nil {
		return nil, ErrUnsafeRuntime
	}
	// An incomplete/lost bootstrap is a recovery case, not permission to reset
	// the durable history. In particular do not create a fresh ledger beside an
	// old instance record. Whole-directory backup rollback still requires the
	// independent boot-nonce/administrator activation boundary.
	hadLedger, e := entryExists(int(r.stateDir.Fd()), "ledger.jsonl")
	if e != nil {
		return nil, e
	}
	hadInstance, e := entryExists(int(r.stateDir.Fd()), instanceName)
	if e != nil {
		return nil, e
	}
	if hadLedger != hadInstance {
		return nil, ErrUnsafeRuntime
	}
	r.Ledger, err = ledger.Open(spec.path(config.StatePath))
	if err != nil {
		return nil, err
	}
	var previous instanceRecord
	if hadInstance {
		previous, r.instanceFile, r.instanceStamp, err = r.readInstance()
		if err != nil {
			return nil, err
		}
	}
	c := view.Config()
	now := spec.now().UTC()
	if now.IsZero() || (!previous.StartedAt.IsZero() && now.Before(previous.StartedAt)) {
		return nil, ErrClockRollback
	}
	nonce, err := spec.newNonce()
	if err != nil || !noncePattern.MatchString(nonce) || nonce == previous.BootNonce {
		return nil, ErrUnsafeRuntime
	}
	r.BootNonce = nonce
	r.lastWall = now
	if err = r.publishInstance(instanceRecord{Schema: instanceSchema, BrokerID: c.BrokerID, WorkspaceID: c.WorkspaceID, BootNonce: nonce, StartedAt: now}); err != nil {
		return nil, err
	}
	// No socket can be removed or bound before the OS ledger lock above.
	if err = r.removeStaleSocket(); err != nil {
		return nil, err
	}
	r.Listener, err = net.ListenUnix("unix", &net.UnixAddr{Name: spec.path(config.SocketPath), Net: "unix"})
	if err != nil {
		return nil, ErrUnsafeRuntime
	}
	r.Listener.SetUnlinkOnClose(false)
	st, err := socketStat(int(r.runDir.Fd()))
	if err != nil {
		return nil, err
	}
	r.socketStamp = &st
	if err = os.Chmod(spec.path(config.SocketPath), 0666); err != nil {
		return nil, ErrUnsafeRuntime
	}
	updated, err := socketStat(int(r.runDir.Fd()))
	if err != nil || !sameInode(st, updated) {
		return nil, ErrUnsafeRuntime
	}
	r.socketStamp = &updated
	if err = r.runDir.Sync(); err != nil {
		return nil, ErrUnsafeRuntime
	}
	if err = r.check(); err != nil {
		return nil, err
	}
	return r, nil
}

func entryExists(dir int, name string) (bool, error) {
	fd, err := syscall.Openat(dir, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ENOENT) {
		return false, nil
	}
	if err != nil {
		return false, ErrUnsafeRuntime
	}
	syscall.Close(fd)
	return true, nil
}

func sameInode(a, b syscall.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func sameFile(a, b syscall.Stat_t) bool {
	return sameInode(a, b) && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func (r *Runtime) openDirectory(path string, mode uint32) (*os.File, error) {
	fd, err := syscall.Open(r.spec.root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrUnsafeRuntime
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil || (st.Uid != 0 && st.Uid != r.spec.uid) || st.Mode&07022 != 0 {
			syscall.Close(fd)
			return nil, ErrUnsafeRuntime
		}
		next, err := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if err != nil {
			return nil, ErrUnsafeRuntime
		}
		fd = next
	}
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Uid != r.spec.uid || st.Gid != r.spec.gid || st.Mode&07777 != mode {
		syscall.Close(fd)
		return nil, ErrUnsafeRuntime
	}
	return os.NewFile(uintptr(fd), path), nil
}

func socketStat(dir int) (syscall.Stat_t, error) {
	var st syscall.Stat_t
	fd, err := syscall.Openat(dir, socketName, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return st, err
	}
	defer syscall.Close(fd)
	if err = syscall.Fstat(fd, &st); err != nil {
		return st, err
	}
	return st, nil
}

func (r *Runtime) removeStaleSocket() error {
	st, err := socketStat(int(r.runDir.Fd()))
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return ErrUnsafeRuntime
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Mode&07000 != 0 || st.Uid != r.spec.uid || st.Nlink != 1 {
		return ErrUnsafeRuntime
	}
	conn, dialErr := net.DialTimeout("unix", r.spec.path(config.SocketPath), 250*time.Millisecond)
	if dialErr == nil {
		conn.Close()
		return ErrUnsafeRuntime
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) {
		return ErrUnsafeRuntime
	}
	again, err := socketStat(int(r.runDir.Fd()))
	if err != nil || !sameFile(st, again) {
		return ErrUnsafeRuntime
	}
	// The directory is broker-owned and non-writable by peers. No Linux unlink
	// operation atomically compares inode; hostile same-UID/root writers remain
	// outside the OS isolation contract, and are never granted this directory.
	if err := syscall.Unlinkat(int(r.runDir.Fd()), socketName); err != nil {
		return ErrUnsafeRuntime
	}
	if err := r.runDir.Sync(); err != nil {
		return ErrUnsafeRuntime
	}
	return nil
}

func (r *Runtime) readInstance() (instanceRecord, *os.File, syscall.Stat_t, error) {
	var rec instanceRecord
	var before, after syscall.Stat_t
	fd, err := syscall.Openat(int(r.stateDir.Fd()), instanceName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return rec, nil, before, ErrUnsafeRuntime
	}
	f := os.NewFile(uintptr(fd), instanceName)
	fail := func() (instanceRecord, *os.File, syscall.Stat_t, error) {
		f.Close()
		return rec, nil, before, ErrUnsafeRuntime
	}
	if syscall.Fstat(fd, &before) != nil || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Mode&07777 != 0600 || before.Uid != r.spec.uid || before.Nlink != 1 || before.Size <= 0 || before.Size > 4096 {
		return fail()
	}
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(b) > 4096 || int64(len(b)) != before.Size || syscall.Fstat(fd, &after) != nil || !sameFile(before, after) || permit.Decode(b, &rec) != nil {
		return fail()
	}
	c := r.view.Config()
	if rec.Schema != instanceSchema || rec.BrokerID != c.BrokerID || rec.WorkspaceID != c.WorkspaceID || !noncePattern.MatchString(rec.BootNonce) || (!decimal.MatchString(rec.Generation) && rec.Generation != "") || rec.StartedAt.IsZero() {
		return fail()
	}
	return rec, f, before, nil
}

func (r *Runtime) publishInstance(rec instanceRecord) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return ErrUnsafeRuntime
	}
	nameNonce, err := permit.NewBootNonce()
	if err != nil {
		return ErrUnsafeRuntime
	}
	name := ".instance-" + nameNonce + ".tmp"
	fd, err := syscall.Openat(int(r.stateDir.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return ErrUnsafeRuntime
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	n, err := f.Write(data)
	if err != nil || n != len(data) || r.syncRecord(f) != nil {
		return ErrUnsafeRuntime
	}
	if err := syscall.Renameat(int(r.stateDir.Fd()), name, int(r.stateDir.Fd()), instanceName); err != nil {
		return ErrUnsafeRuntime
	}
	if r.syncState() != nil {
		return ErrUnsafeRuntime
	}
	verified, next, stamp, err := r.readInstance()
	if err != nil {
		return err
	}
	if verified != rec {
		next.Close()
		return ErrUnsafeRuntime
	}
	if r.instanceFile != nil {
		r.instanceFile.Close()
	}
	r.instanceFile = next
	r.instanceStamp = stamp
	r.instance = rec
	return nil
}

func (r *Runtime) poison(err error) error {
	if r.stopped == nil {
		r.stopped = err
	}
	return r.stopped
}

func (r *Runtime) check() error {
	if r.closed {
		return ErrStopped
	}
	if r.stopped != nil {
		return r.stopped
	}
	if r.view.CheckUnchanged() != nil {
		return r.poison(config.ErrChanged)
	}
	now := r.spec.now().UTC()
	if now.IsZero() || now.Before(r.lastWall) {
		return r.poison(ErrClockRollback)
	}
	r.lastWall = now
	for _, d := range []struct {
		path  string
		mode  uint32
		stamp syscall.Stat_t
	}{{runDirectory, 0755, r.runStamp}, {config.StatePath, 0700, r.stateStamp}} {
		f, err := r.openDirectory(d.path, d.mode)
		if err != nil {
			return r.poison(ErrUnsafeRuntime)
		}
		var st syscall.Stat_t
		err = syscall.Fstat(int(f.Fd()), &st)
		f.Close()
		if err != nil || !sameInode(st, d.stamp) {
			return r.poison(ErrUnsafeRuntime)
		}
	}
	if r.socketStamp == nil {
		return r.poison(ErrUnsafeRuntime)
	}
	st, err := socketStat(int(r.runDir.Fd()))
	if err != nil || !sameFile(st, *r.socketStamp) || st.Mode&07777 != 0666 {
		return r.poison(ErrUnsafeRuntime)
	}
	var held syscall.Stat_t
	if r.instanceFile == nil || syscall.Fstat(int(r.instanceFile.Fd()), &held) != nil || !sameFile(held, r.instanceStamp) {
		return r.poison(ErrUnsafeRuntime)
	}
	rec, f, stamp, err := r.readInstance()
	if err != nil {
		return r.poison(ErrUnsafeRuntime)
	}
	f.Close()
	if rec != r.instance || !sameFile(stamp, r.instanceStamp) {
		return r.poison(ErrUnsafeRuntime)
	}
	return nil
}

// Check checks health and monotonic wall-clock observations, not activation.
// Calling it for status does not authorize execution.
func (r *Runtime) Check() error { r.mu.Lock(); defer r.mu.Unlock(); return r.check() }

// Admit binds a verified authority generation and nonce. A different generation
// after the first latch permanently stops admission until a fresh process boot.
func (r *Runtime) Admit(generation, bootNonce string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return err
	}
	if !decimal.MatchString(generation) || bootNonce != r.instance.BootNonce {
		return ErrNotActivated
	}
	if r.instance.Generation != "" && r.instance.Generation != generation {
		return r.poison(ErrGenerationChanged)
	}
	if r.instance.Generation == "" {
		rec := r.instance
		rec.Generation = generation
		if err := r.publishInstance(rec); err != nil {
			return r.poison(err)
		}
		// Include the time spent in durable activation publication in the clock
		// observation; the caller still repeats its own final authority checks.
		if err := r.check(); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) Generation() string { r.mu.Lock(); defer r.mu.Unlock(); return r.instance.Generation }

// StopAdmission leaves listener and ledger open so the HTTP server can perform
// its bounded Shutdown and admitted operations can persist reconciliation.
func (r *Runtime) StopAdmission() { r.mu.Lock(); defer r.mu.Unlock(); r.poison(ErrStopped) }

// Close is called after HTTP shutdown/drain. It never unlinks a replacement
// socket or deletes ledger/instance/recovery evidence.
func (r *Runtime) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	r.poison(ErrStopped)
	var errs []error
	if r.Listener != nil {
		if err := r.Listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			errs = append(errs, err)
		}
		if r.runDir != nil && r.socketStamp != nil {
			st, err := socketStat(int(r.runDir.Fd()))
			if errors.Is(err, syscall.ENOENT) {
			} else if err != nil || !sameFile(st, *r.socketStamp) {
				errs = append(errs, ErrUnsafeRuntime)
			} else if err := syscall.Unlinkat(int(r.runDir.Fd()), socketName); err != nil {
				errs = append(errs, ErrUnsafeRuntime)
			} else if err := r.runDir.Sync(); err != nil {
				errs = append(errs, ErrUnsafeRuntime)
			}
		}
	}
	if r.instanceFile != nil {
		errs = append(errs, r.instanceFile.Close())
	}
	if r.Ledger != nil {
		errs = append(errs, r.Ledger.Close())
	}
	if r.runDir != nil {
		errs = append(errs, r.runDir.Close())
	}
	if r.stateDir != nil {
		errs = append(errs, r.stateDir.Close())
	}
	return errors.Join(errs...)
}
