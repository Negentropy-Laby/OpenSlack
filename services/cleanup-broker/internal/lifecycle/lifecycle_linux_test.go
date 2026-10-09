//go:build linux

package lifecycle

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
)

type fixtureConfig struct{ changed bool }

func (f *fixtureConfig) Config() config.Config {
	return config.Config{BrokerID: "broker-1", WorkspaceID: "workspace-1", UID: 21001, GID: 21001}
}
func (f *fixtureConfig) CheckUnchanged() error {
	if f.changed {
		return config.ErrChanged
	}
	return nil
}

func fixture(t *testing.T) (*fixtureConfig, startSpec) {
	t.Helper()
	root, err := os.MkdirTemp("", "cb-life-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	s := startSpec{root: root, uid: uint32(os.Geteuid()), gid: uint32(os.Getegid()), now: time.Now, newNonce: func() (string, error) { return strings.Repeat("a", 64), nil }}
	for _, p := range []string{runDirectory, config.StatePath} {
		if err := os.MkdirAll(s.path(p), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(s.path(config.StatePath), 0700); err != nil {
		t.Fatal(err)
	}
	return &fixtureConfig{}, s
}

func TestBootActivationClockAndStop(t *testing.T) {
	c, s := fixture(t)
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	r, err := start(c, s)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.BootNonce != strings.Repeat("a", 64) || r.Generation() != "" {
		t.Fatal("boot falsely activated")
	}
	if err := r.Admit("1", strings.Repeat("b", 64)); !errors.Is(err, ErrNotActivated) {
		t.Fatal("wrong nonce accepted")
	}
	if err := r.Admit("1", r.BootNonce); err != nil {
		t.Fatal(err)
	}
	if r.Generation() != "1" {
		t.Fatal("generation not latched")
	}
	if err := r.Admit("1", r.BootNonce); err != nil {
		t.Fatal(err)
	}
	now = now.Add(-time.Second)
	if err := r.Check(); !errors.Is(err, ErrClockRollback) {
		t.Fatalf("clock rollback: %v", err)
	}
	now = now.Add(time.Hour)
	if err := r.Admit("1", r.BootNonce); !errors.Is(err, ErrClockRollback) {
		t.Fatal("clock poison cleared")
	}
	if _, err := r.Ledger.Reserve("permit", "op", strings.Repeat("c", 64), "subject", json.RawMessage(`{}`)); err != nil {
		t.Fatal("admission gate must not close ledger before HTTP drain", err)
	}
}

func TestGenerationChangeAndConfigChangeStopAdmission(t *testing.T) {
	for _, kind := range []string{"generation", "config", "stop"} {
		t.Run(kind, func(t *testing.T) {
			c, s := fixture(t)
			r, err := start(c, s)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			if err := r.Admit("1", r.BootNonce); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "generation":
				if err := r.Admit("2", r.BootNonce); !errors.Is(err, ErrGenerationChanged) {
					t.Fatal(err)
				}
			case "config":
				c.changed = true
				if r.Check() == nil {
					t.Fatal("changed config accepted")
				}
				c.changed = false
			case "stop":
				r.StopAdmission()
			}
			if r.Admit("1", r.BootNonce) == nil {
				t.Fatal("stopped runtime reopened")
			}
		})
	}
}

func TestRestartChangesNonceAndPreservesReservation(t *testing.T) {
	c, s := fixture(t)
	r, err := start(c, s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Ledger.Reserve("permit", "op", strings.Repeat("c", 64), "subject", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	s.newNonce = func() (string, error) { return strings.Repeat("b", 64), nil }
	r, err = start(c, s)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.BootNonce != strings.Repeat("b", 64) || r.Generation() != "" {
		t.Fatal("old activation reused")
	}
	if err := r.Admit("1", strings.Repeat("a", 64)); !errors.Is(err, ErrNotActivated) {
		t.Fatal(err)
	}
	reservation, err := r.Ledger.Reserve("permit", "op", strings.Repeat("c", 64), "subject", json.RawMessage(`{}`))
	if err != nil || reservation.Fresh {
		t.Fatal("reboot renewed reservation", err)
	}
}

func TestSingleWriterBeforeSocketMutation(t *testing.T) {
	c, s := fixture(t)
	r, err := start(c, s)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	before, err := os.Lstat(s.path(config.SocketPath))
	if err != nil {
		t.Fatal(err)
	}
	if other, err := start(c, s); !errors.Is(err, ledger.ErrLocked) {
		if other != nil {
			other.Close()
		}
		t.Fatalf("second writer: %v", err)
	}
	after, err := os.Lstat(s.path(config.SocketPath))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("second writer replaced live socket")
	}
}

func TestStaleSocketOnlyAndLiveListenerRefused(t *testing.T) {
	for _, kind := range []string{"stale", "live", "file", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			c, s := fixture(t)
			p := s.path(config.SocketPath)
			if kind == "file" {
				if err := os.WriteFile(p, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if kind == "symlink" {
				if err := os.Symlink("elsewhere", p); err != nil {
					t.Fatal(err)
				}
			} else {
				l, err := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
				if err != nil {
					t.Fatal(err)
				}
				l.SetUnlinkOnClose(false)
				defer l.Close()
				if kind == "stale" {
					l.Close()
				}
			}
			r, err := start(c, s)
			if kind == "stale" {
				if err != nil {
					t.Fatal(err)
				}
				r.Close()
			} else {
				if err == nil {
					r.Close()
					t.Fatal("occupied/unsafe socket replaced")
				}
				if _, err := os.Lstat(p); err != nil {
					t.Fatal("refused target removed")
				}
			}
		})
	}
}

func TestInstanceCorruptionAndPartialStateRefused(t *testing.T) {
	for _, kind := range []string{"corrupt", "missing-instance", "missing-ledger", "symlink", "mode"} {
		t.Run(kind, func(t *testing.T) {
			c, s := fixture(t)
			r, err := start(c, s)
			if err != nil {
				t.Fatal(err)
			}
			r.Close()
			p := s.path(instancePath)
			switch kind {
			case "corrupt":
				err = os.WriteFile(p, []byte(`{"bad":true}`), 0600)
			case "missing-instance":
				err = os.Remove(p)
			case "missing-ledger":
				err = os.Remove(filepath.Join(s.path(config.StatePath), "ledger.jsonl"))
			case "symlink":
				if err = os.Rename(p, p+".old"); err == nil {
					err = os.Symlink(p+".old", p)
				}
			case "mode":
				err = os.Chmod(p, 0644)
			}
			if err != nil {
				t.Fatal(err)
			}
			if next, err := start(c, s); err == nil {
				next.Close()
				t.Fatal("invalid recovery state reset")
			}
		})
	}
}

func TestStopAdmissionDoesNotCloseBeforeDrainAndClosePreservesReplacement(t *testing.T) {
	c, s := fixture(t)
	r, err := start(c, s)
	if err != nil {
		t.Fatal(err)
	}
	r.StopAdmission()
	if !errors.Is(r.Check(), ErrStopped) {
		t.Fatal("admission still open")
	}
	if _, err := r.Ledger.Reserve("permit", "op", strings.Repeat("c", 64), "subject", json.RawMessage(`{}`)); err != nil {
		t.Fatal("ledger closed before drain")
	}
	p := s.path(config.SocketPath)
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); !errors.Is(err, ErrUnsafeRuntime) {
		t.Fatalf("replacement not reported: %v", err)
	}
	if b, err := os.ReadFile(p); err != nil || string(b) != "replacement" {
		t.Fatal("unrelated replacement deleted")
	}
	if _, _, err := r.Ledger.Lookup("op"); !errors.Is(err, ledger.ErrClosed) {
		t.Fatal("ledger lock not released")
	}
}

func TestUnsafeDirectoriesRefused(t *testing.T) {
	for _, path := range []string{runDirectory, config.StatePath} {
		t.Run(filepath.Base(path), func(t *testing.T) {
			c, s := fixture(t)
			if err := os.Chmod(s.path(path), 0777); err != nil {
				t.Fatal(err)
			}
			if r, err := start(c, s); err == nil {
				r.Close()
				t.Fatal("unsafe directory accepted")
			}
		})
	}
}

func TestDurableActivationSyncFailureStopsAdmission(t *testing.T) {
	for _, phase := range []string{"file", "directory"} {
		t.Run(phase, func(t *testing.T) {
			c, s := fixture(t)
			r, err := start(c, s)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			if phase == "file" {
				r.syncRecord = func(*os.File) error { return syscall.EIO }
			} else {
				r.syncState = func() error { return syscall.EIO }
			}
			if err := r.Admit("1", r.BootNonce); !errors.Is(err, ErrUnsafeRuntime) {
				t.Fatalf("failed durability admitted: %v", err)
			}
			if r.Generation() != "" {
				t.Fatal("failed activation latched")
			}
			r.syncRecord = func(f *os.File) error { return f.Sync() }
			r.syncState = r.stateDir.Sync
			if err := r.Admit("1", r.BootNonce); !errors.Is(err, ErrUnsafeRuntime) {
				t.Fatal("storage poison cleared")
			}
		})
	}
}

func TestReplacedInstanceAndDirectoryStopAdmission(t *testing.T) {
	for _, kind := range []string{"instance", "directory"} {
		t.Run(kind, func(t *testing.T) {
			c, s := fixture(t)
			r, err := start(c, s)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			p := s.path(instancePath)
			if kind == "instance" {
				b, err := os.ReadFile(p)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(p, p+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, b, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				p = s.path(runDirectory)
				if err := os.Rename(p, p+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(p, 0755); err != nil {
					t.Fatal(err)
				}
			}
			if err := r.Check(); !errors.Is(err, ErrUnsafeRuntime) {
				t.Fatalf("replacement accepted: %v", err)
			}
		})
	}
}
