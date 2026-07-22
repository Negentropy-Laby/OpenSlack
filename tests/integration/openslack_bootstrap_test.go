package integration_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"rc_wsman/internal/calleraccess"
	calleraccesspostgres "rc_wsman/internal/calleraccess/postgres"
	"rc_wsman/internal/openslackbootstrap"
	"rc_wsman/internal/testsupport"
)

type bootstrapPepper struct {
	id    string
	value []byte
}

func (p bootstrapPepper) PepperID() string    { return p.id }
func (p bootstrapPepper) PepperValue() []byte { return p.value }

func bootstrapOptions(path string, pepper bootstrapPepper, store openslackbootstrap.Store) openslackbootstrap.Options {
	return openslackbootstrap.Options{
		OutputPath: path, VendorIDs: []string{"fixture-slack", "fixture-webhook"}, ActivePepper: pepper,
		OpenStore: func(context.Context) (openslackbootstrap.Store, func(), error) {
			return store, func() {}, nil
		},
	}
}

func TestOpenSlackBootstrapDifferentOutputsHaveExactlyOneSuccessAndAuthenticate(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := calleraccesspostgres.NewOpenSlackBootstrapStore(pool)
	pepper := bootstrapPepper{id: "fixture-bootstrap", value: []byte("fixture-bootstrap-secret")}
	paths := []string{filepath.Join(t.TempDir(), "one.json"), filepath.Join(t.TempDir(), "two.json")}

	start := make(chan struct{})
	type outcome struct {
		index  int
		result openslackbootstrap.Result
		err    error
	}
	results := make(chan outcome, len(paths))
	var wait sync.WaitGroup
	for index, path := range paths {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := openslackbootstrap.Run(context.Background(), bootstrapOptions(path, pepper, store))
			results <- outcome{index: index, result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	var winner outcome
	var successes int
	for result := range results {
		if result.err == nil {
			successes++
			winner = result
			continue
		}
		if _, err := os.Stat(paths[result.index]); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("loser output was not durably removed: %v (bootstrap error %v)", err, result.err)
		}
	}
	if successes != 1 {
		t.Fatalf("successes=%d, want exactly one", successes)
	}
	output, err := openslackbootstrap.ReadOutput(paths[winner.index])
	if err != nil {
		t.Fatalf("read winner output: %v", err)
	}
	if info, err := os.Stat(paths[winner.index]); err != nil {
		t.Fatalf("stat winner output: %v", err)
	} else if info.Mode().Perm() != 0o600 {
		t.Fatalf("winner mode=%v, want 0600", info.Mode())
	}

	repo := calleraccesspostgres.New(pool)
	authenticator := calleraccess.NewAuthenticator(repo, calleraccess.NewPepperSet(pepper, nil))
	caller, err := authenticator.AuthenticateCaller(t.Context(), "Bearer "+output.Caller.APIKey)
	if err != nil {
		t.Fatalf("authenticate caller: %v", err)
	}
	if !caller.HasCapability(calleraccess.CapabilitySubmitNotification) || caller.HasCapability(calleraccess.CapabilityReadNotifications) ||
		!caller.CoversVendor("fixture-slack") || !caller.CoversVendor("fixture-webhook") {
		t.Fatalf("caller authority mismatch: %+v", caller)
	}
	auditor, err := authenticator.AuthenticateOperator(t.Context(), "Bearer "+output.Auditor.APIKey)
	if err != nil {
		t.Fatalf("authenticate auditor: %v", err)
	}
	if err := auditor.AuthorizeOperatorAction("read_notifications"); err != nil {
		t.Fatalf("auditor cannot read notifications: %v", err)
	}
	for _, forbidden := range []string{"replay_preview", "replay_execute", "replay_batch", "manage_access_keys"} {
		if err := auditor.AuthorizeOperatorAction(forbidden); !calleraccess.IsRejection(err, calleraccess.RejectionForbidden) {
			t.Fatalf("auditor action %s was not forbidden: %v", forbidden, err)
		}
	}
	principal, err := repo.GetPrincipal(t.Context(), openslackbootstrap.AuditorPrincipalID)
	if err != nil || len(principal.ManagedPrincipalScope) != 0 {
		t.Fatalf("auditor managed scope=%v err=%v", principal.ManagedPrincipalScope, err)
	}
}

func TestOpenSlackBootstrapSameOutputHasExactlyOneSuccess(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := calleraccesspostgres.NewOpenSlackBootstrapStore(pool)
	pepper := bootstrapPepper{id: "fixture-bootstrap", value: []byte("fixture-bootstrap-secret")}
	path := filepath.Join(t.TempDir(), "shared.json")
	const contenders = 8
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := openslackbootstrap.Run(context.Background(), bootstrapOptions(path, pepper, store))
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
	if successes != 1 {
		t.Fatalf("successes=%d, want exactly one", successes)
	}
	var principalCount, keyCount int
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM principals WHERE principal_id IN ($1, $2)`,
		openslackbootstrap.CallerPrincipalID, openslackbootstrap.AuditorPrincipalID).Scan(&principalCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM access_keys WHERE principal_id IN ($1, $2)`,
		openslackbootstrap.CallerPrincipalID, openslackbootstrap.AuditorPrincipalID).Scan(&keyCount); err != nil {
		t.Fatal(err)
	}
	if principalCount != 2 || keyCount != 2 {
		t.Fatalf("principals=%d keys=%d, want 2/2", principalCount, keyCount)
	}
}

func TestOpenSlackBootstrapInsertFailureRollsBackAllFourRows(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repo := calleraccesspostgres.New(pool)
	other := calleraccess.PrincipalRecord{
		PrincipalID: uniquePrincipal(t, "fixture-existing"), Kind: calleraccess.KindCaller, Status: "active",
		VendorScope: []string{"fixture-slack"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification},
	}
	if err := repo.CreatePrincipal(t.Context(), other); err != nil {
		t.Fatal(err)
	}
	pepper := bootstrapPepper{id: "fixture-bootstrap", value: []byte("fixture-bootstrap-secret")}
	keyID, _, hash, err := calleraccess.GenerateKey(pepper)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.IssueKey(t.Context(), keyID, other.PrincipalID, hash, pepper.PepperID()); err != nil {
		t.Fatal(err)
	}
	caller := calleraccess.PrincipalRecord{
		PrincipalID: openslackbootstrap.CallerPrincipalID, Kind: calleraccess.KindCaller, Status: "active", OwningScope: openslackbootstrap.OwningScope,
		VendorScope: []string{"fixture-slack", "fixture-webhook"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}, ManagedPrincipalScope: []string{},
	}
	auditor := calleraccess.PrincipalRecord{
		PrincipalID: openslackbootstrap.AuditorPrincipalID, Kind: calleraccess.KindOperator, Status: "active", OwningScope: openslackbootstrap.OwningScope,
		VendorScope: []string{"fixture-slack", "fixture-webhook"}, Capabilities: []string{calleraccess.CapabilityReadNotifications}, ManagedPrincipalScope: []string{},
	}
	request := openslackbootstrap.PersistRequest{
		Caller: caller, Auditor: auditor,
		CallerKey:  openslackbootstrap.KeyRecord{KeyID: uniquePrincipal(t, "caller-key"), PrincipalID: caller.PrincipalID, SecretHash: []byte("caller-hash"), PepperID: pepper.PepperID()},
		AuditorKey: openslackbootstrap.KeyRecord{KeyID: keyID, PrincipalID: auditor.PrincipalID, SecretHash: []byte("auditor-hash"), PepperID: pepper.PepperID()},
	}
	if err := calleraccesspostgres.NewOpenSlackBootstrapStore(pool).BootstrapOpenSlack(t.Context(), request); err == nil {
		t.Fatal("expected duplicate key failure")
	}
	var principalCount, keyCount int
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM principals WHERE principal_id IN ($1, $2)`, caller.PrincipalID, auditor.PrincipalID).Scan(&principalCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM access_keys WHERE principal_id IN ($1, $2)`, caller.PrincipalID, auditor.PrincipalID).Scan(&keyCount); err != nil {
		t.Fatal(err)
	}
	if principalCount != 0 || keyCount != 0 {
		t.Fatalf("partial bootstrap persisted principals=%d keys=%d", principalCount, keyCount)
	}
}
