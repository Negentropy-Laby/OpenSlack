package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerconfig"
)

type testHTTPService struct{ stopped chan struct{} }

func (service testHTTPService) Run(ctx context.Context, _ string, _ time.Duration) error {
	<-ctx.Done()
	close(service.stopped)
	return nil
}

type testScheduler struct{ failure error }

func (scheduler testScheduler) Run(context.Context) error { return scheduler.failure }

func TestRunCancelsHTTPWhenSchedulerFails(t *testing.T) {
	stopped := make(chan struct{})
	expected := errors.New("scheduler failed")
	err := run(context.Background(), testHTTPService{stopped: stopped}, testScheduler{failure: expected}, runnerconfig.Config{})
	if !errors.Is(err, expected) {
		t.Fatalf("run error=%v", err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("HTTP service was not stopped")
	}
}

func TestRunnerServerRequiresSchemaVersionThree(t *testing.T) {
	if minimumSchemaVersion != 2 || maximumSchemaVersion != 5 {
		t.Fatalf("minimum schema version=%d", minimumSchemaVersion)
	}
}

func TestRuntimeOSFailsClosedWithoutParentDeathGuarantee(t *testing.T) {
	for _, goos := range []string{"linux", "windows"} {
		if err := validateRuntimeOS(goos); err != nil {
			t.Fatalf("%s must be supported: %v", goos, err)
		}
	}
	for _, goos := range []string{"darwin", "freebsd", "openbsd", "plan9"} {
		if err := validateRuntimeOS(goos); err == nil {
			t.Fatalf("%s must fail closed", goos)
		}
	}
}

func TestBootInstanceIDIsUniqueBoundedAndPrefixBound(t *testing.T) {
	first, err := newBootInstanceID("runner.test", bytes.NewReader(bytes.Repeat([]byte{1}, 16)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := newBootInstanceID("runner.test", bytes.NewReader(bytes.Repeat([]byte{2}, 16)))
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !strings.HasPrefix(first, "runner.test.boot.") || len(first) > 256 {
		t.Fatalf("invalid boot identities: %q %q", first, second)
	}
	if _, err := newBootInstanceID(strings.Repeat("a", 217), bytes.NewReader(make([]byte, 16))); err == nil {
		t.Fatal("oversized configured prefix must fail closed")
	}
}

type fakeLockManager struct {
	mu    sync.Mutex
	owned map[int64]bool
}

type fakeAdvisorySession struct {
	manager  *fakeLockManager
	released bool
}

type fakeAdvisoryRow struct {
	value bool
	err   error
}

func (row fakeAdvisoryRow) Scan(destinations ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(destinations) != 1 {
		return fmt.Errorf("expected one destination")
	}
	target, ok := destinations[0].(*bool)
	if !ok {
		return fmt.Errorf("expected boolean destination")
	}
	*target = row.value
	return nil
}

func (session *fakeAdvisorySession) QueryRow(_ context.Context, sql string, arguments ...any) pgx.Row {
	if session.released || len(arguments) != 1 {
		return fakeAdvisoryRow{err: fmt.Errorf("invalid fake lock session")}
	}
	key, ok := arguments[0].(int64)
	if !ok {
		return fakeAdvisoryRow{err: fmt.Errorf("invalid advisory key")}
	}
	session.manager.mu.Lock()
	defer session.manager.mu.Unlock()
	switch {
	case strings.Contains(sql, "pg_try_advisory_lock"):
		if session.manager.owned[key] {
			return fakeAdvisoryRow{value: false}
		}
		session.manager.owned[key] = true
		return fakeAdvisoryRow{value: true}
	case strings.Contains(sql, "pg_advisory_unlock"):
		if !session.manager.owned[key] {
			return fakeAdvisoryRow{value: false}
		}
		delete(session.manager.owned, key)
		return fakeAdvisoryRow{value: true}
	default:
		return fakeAdvisoryRow{err: fmt.Errorf("unexpected query")}
	}
}

func (session *fakeAdvisorySession) Release() { session.released = true }
func (session *fakeAdvisorySession) Hijack() *pgx.Conn {
	session.released = true
	return nil
}

func TestWorkspaceAdvisoryLockIsSingletonPerWorkspace(t *testing.T) {
	manager := &fakeLockManager{owned: map[int64]bool{}}
	acquire := func(context.Context) (advisorySession, error) {
		return &fakeAdvisorySession{manager: manager}, nil
	}
	first, err := acquireWorkspaceLock(context.Background(), acquire, "workspace.one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireWorkspaceLock(context.Background(), acquire, "workspace.one"); err == nil {
		t.Fatal("second runner-server for one workspace must fail closed")
	}
	secondWorkspace, err := acquireWorkspaceLock(context.Background(), acquire, "workspace.two")
	if err != nil {
		t.Fatalf("different workspace must have an independent lock: %v", err)
	}
	if workspaceAdvisoryLockKey("workspace.one") == workspaceAdvisoryLockKey("workspace.two") {
		t.Fatal("test workspaces unexpectedly collide")
	}
	if err := first.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := secondWorkspace.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	third, err := acquireWorkspaceLock(context.Background(), acquire, "workspace.one")
	if err != nil {
		t.Fatalf("workspace lock must be recoverable after release: %v", err)
	}
	if err := third.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
}
