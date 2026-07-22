package openslackbootstrap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"rc_wsman/internal/calleraccess"
)

type testPepper struct {
	id    string
	value []byte
}

func (p testPepper) PepperID() string    { return p.id }
func (p testPepper) PepperValue() []byte { return p.value }

type fakeStore struct {
	request PersistRequest
	err     error
	calls   atomic.Int32
}

func (s *fakeStore) BootstrapOpenSlack(_ context.Context, request PersistRequest) error {
	s.calls.Add(1)
	s.request = request
	return s.err
}

func validOptions(t *testing.T, store Store) Options {
	t.Helper()
	return Options{
		OutputPath: filepath.Join(t.TempDir(), "openslack-keys.json"),
		VendorIDs:  []string{"fixture-slack", "fixture-webhook"},
		ActivePepper: testPepper{
			id: "fixture-pepper", value: []byte("fixture-pepper-value"),
		},
		OpenStore: func(context.Context) (Store, func(), error) { return store, func() {}, nil },
	}
}

func TestRunWritesDurableProtectedOutputBeforeOpeningStore(t *testing.T) {
	store := &fakeStore{}
	options := validOptions(t, store)
	var opened bool
	options.OpenStore = func(context.Context) (Store, func(), error) {
		info, err := os.Stat(options.OutputPath)
		if err != nil {
			t.Fatalf("output did not exist before store open: %v", err)
		}
		if info.Mode().Perm() != 0o600 || !info.Mode().IsRegular() {
			t.Fatalf("output mode = %v, want regular 0600", info.Mode())
		}
		opened = true
		return store, func() {}, nil
	}

	result, err := Run(t.Context(), options)
	if err != nil {
		t.Fatalf("Run(): %v", err)
	}
	if !opened || store.calls.Load() != 1 || result.CallerKeyID == "" || result.AuditorKeyID == "" {
		t.Fatalf("unexpected result/open state: %+v opened=%v calls=%d", result, opened, store.calls.Load())
	}
	if store.request.Caller.PrincipalID != CallerPrincipalID || store.request.Caller.Kind != calleraccess.KindCaller ||
		len(store.request.Caller.Capabilities) != 1 || store.request.Caller.Capabilities[0] != calleraccess.CapabilitySubmitNotification {
		t.Fatalf("caller contract mismatch: %+v", store.request.Caller)
	}
	if store.request.Auditor.PrincipalID != AuditorPrincipalID || store.request.Auditor.Kind != calleraccess.KindOperator ||
		len(store.request.Auditor.Capabilities) != 1 || store.request.Auditor.Capabilities[0] != calleraccess.CapabilityReadNotifications ||
		len(store.request.Auditor.ManagedPrincipalScope) != 0 {
		t.Fatalf("auditor contract mismatch: %+v", store.request.Auditor)
	}
	output, err := ReadOutput(options.OutputPath)
	if err != nil {
		t.Fatalf("ReadOutput(): %v", err)
	}
	if output.Caller.KeyID != result.CallerKeyID || output.Auditor.KeyID != result.AuditorKeyID ||
		!strings.HasPrefix(output.Caller.APIKey, output.Caller.KeyID+".") || !strings.HasPrefix(output.Auditor.APIKey, output.Auditor.KeyID+".") {
		t.Fatal("credential output and non-secret result disagree")
	}
	data, _ := os.ReadFile(options.OutputPath)
	if data[len(data)-1] != '\n' || strings.Index(string(data), `"caller"`) > strings.Index(string(data), `"auditor"`) {
		t.Fatalf("output is not stable ordered JSON: %s", data)
	}
}

func TestRunKnownFailureRemovesOutputAndUnknownRetainsIt(t *testing.T) {
	tests := []struct {
		name       string
		storeError error
		wantFile   bool
	}{
		{name: "known rollback", storeError: PersistenceError{Kind: FailureKnownRollback, Code: "insert_failed"}},
		{name: "commit unknown", storeError: PersistenceError{Kind: FailureCommitUnknown, Code: "commit_outcome_unknown"}, wantFile: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			options := validOptions(t, &fakeStore{err: tt.storeError})
			result, err := Run(t.Context(), options)
			if err == nil {
				t.Fatal("expected bootstrap error")
			}
			_, statErr := os.Stat(options.OutputPath)
			if (statErr == nil) != tt.wantFile {
				t.Fatalf("output exists=%v, want %v; error=%v result=%+v", statErr == nil, tt.wantFile, err, result)
			}
			if tt.wantFile && (result.CallerKeyID == "" || result.AuditorKeyID == "") {
				t.Fatal("commit-unknown result omitted convergence key IDs")
			}
		})
	}
}

func TestRunDatabaseOpenFailureRemovesOutput(t *testing.T) {
	options := validOptions(t, &fakeStore{})
	options.OpenStore = func(context.Context) (Store, func(), error) {
		return nil, nil, errors.New("database unavailable")
	}
	if _, err := Run(t.Context(), options); err == nil {
		t.Fatal("expected database open failure")
	}
	if _, err := os.Stat(options.OutputPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("known failure retained output: %v", err)
	}
}

func TestRunExistingOutputFailsBeforeStoreOpen(t *testing.T) {
	store := &fakeStore{}
	options := validOptions(t, store)
	if err := os.WriteFile(options.OutputPath, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(t.Context(), options); err == nil {
		t.Fatal("expected create-only failure")
	}
	if store.calls.Load() != 0 {
		t.Fatal("store was called after create-only failure")
	}
	data, _ := os.ReadFile(options.OutputPath)
	if string(data) != "existing" {
		t.Fatal("existing output was overwritten")
	}
}

func TestRunSameOutputConcurrencyHasExactlyOneSuccess(t *testing.T) {
	store := &fakeStore{}
	options := validOptions(t, store)
	const contenders = 8
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := Run(context.Background(), options)
			results <- err
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	var successes int
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 || store.calls.Load() != 1 {
		t.Fatalf("successes=%d store calls=%d, want 1/1", successes, store.calls.Load())
	}
}

func TestRunRejectsInvalidVendorSetAndSymlinkParentBeforeStore(t *testing.T) {
	for _, vendors := range [][]string{{"fixture-one"}, {"fixture-one", "fixture-one"}, {"INVALID", "fixture-two"}} {
		store := &fakeStore{}
		options := validOptions(t, store)
		options.VendorIDs = vendors
		if _, err := Run(t.Context(), options); err == nil {
			t.Fatalf("vendor IDs %v accepted", vendors)
		}
		if store.calls.Load() != 0 {
			t.Fatal("store called for invalid vendor set")
		}
	}

	realParent := t.TempDir()
	linkParent := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(realParent, linkParent); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	store := &fakeStore{}
	options := validOptions(t, store)
	options.OutputPath = filepath.Join(linkParent, "keys.json")
	if _, err := Run(t.Context(), options); err == nil {
		t.Fatal("symlink parent accepted")
	}
	if store.calls.Load() != 0 {
		t.Fatal("store called through symlink parent")
	}
}
