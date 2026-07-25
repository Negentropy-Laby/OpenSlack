package postgres_test

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/calleraccess"
	"rc_wsman/internal/calleraccess/postgres"
	"rc_wsman/internal/testsupport"
)

type testPepper struct {
	id    string
	value []byte
}

func (p testPepper) PepperID() string    { return p.id }
func (p testPepper) PepperValue() []byte { return p.value }

func openPool(t *testing.T) *pgxpool.Pool {
	return testsupport.OpenPostgres(t)
}

func cleanCallerAccess(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// No global cleanup: tests use unique principal IDs so parallel packages
	// sharing the database never interfere. Rows persist as harmless fixtures.
}

// uniquePrincipal derives a unique principal ID from the test name, safe for
// repeated runs against a persistent shared database.
func uniquePrincipal(t *testing.T, base string) string {
	t.Helper()
	h := fnv.New32a()
	_, _ = h.Write([]byte(fmt.Sprintf("%s-%d-%d", t.Name(), os.Getpid(), callerTestSequence.Add(1))))
	return fmt.Sprintf("%s-%08x", base, h.Sum32())
}

var callerTestSequence atomic.Uint64

func TestPostgresRepository_IssueKey_Concurrency(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	cleanCallerAccess(t, pool)

	repo := postgres.New(pool)
	ctx := context.Background()
	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-concurrent"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}

	pepper := testPepper{id: "pepper-v1", value: []byte("pepper-v1-secret")}
	initialKeyID, _, initialHash, err := calleraccess.GenerateKey(pepper)
	if err != nil {
		t.Fatalf("generate initial key: %v", err)
	}
	if _, err := repo.IssueKey(ctx, initialKeyID, principal.PrincipalID, initialHash, pepper.PepperID()); err != nil {
		t.Fatalf("occupy first active-key slot: %v", err)
	}

	// Use many goroutines to compete for the one remaining active-key slot.
	const n = 10
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			keyID, _, hash, _ := calleraccess.GenerateKey(pepper)
			_, err := repo.IssueKey(ctx, keyID, principal.PrincipalID, hash, pepper.PepperID())
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	var successes, failures int
	for err := range results {
		if err == nil {
			successes++
		} else if calleraccess.IsRejection(err, calleraccess.RejectionActiveKeyLimit) {
			failures++
		} else {
			t.Fatalf("unexpected issue error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successes = %d, want 1", successes)
	}
	if successes+failures != n {
		t.Fatalf("successes+failures = %d, want %d", successes+failures, n)
	}
	active, err := repo.ListActiveKeys(ctx, principal.PrincipalID)
	if err != nil || len(active) != 2 {
		t.Fatalf("active keys = %d, want 2: %v", len(active), err)
	}
}

func TestPostgresRepository_RevokeKey_And_BulkRevokePepper(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	cleanCallerAccess(t, pool)

	repo := postgres.New(pool)
	ctx := context.Background()
	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-revoke"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}

	pepper := testPepper{id: "pepper-old", value: []byte("pepper-old-secret")}
	keyID1, _, hash1, _ := calleraccess.GenerateKey(pepper)
	if _, err := repo.IssueKey(ctx, keyID1, principal.PrincipalID, hash1, pepper.PepperID()); err != nil {
		t.Fatalf("issue key1: %v", err)
	}
	keyID2, _, hash2, _ := calleraccess.GenerateKey(pepper)
	if _, err := repo.IssueKey(ctx, keyID2, principal.PrincipalID, hash2, pepper.PepperID()); err != nil {
		t.Fatalf("issue key2: %v", err)
	}

	if _, err := repo.RevokeKey(ctx, keyID1); err != nil {
		t.Fatalf("revoke key1: %v", err)
	}

	count, err := repo.CountNonRevokedKeysForPepper(ctx, pepper.PepperID())
	if err != nil {
		t.Fatalf("count non-revoked: %v", err)
	}
	if count != 1 {
		t.Fatalf("non-revoked count = %d, want 1", count)
	}

	revoked, err := repo.BulkRevokePepper(ctx, pepper.PepperID())
	if err != nil {
		t.Fatalf("bulk revoke: %v", err)
	}
	if revoked != 1 {
		t.Fatalf("bulk revoked = %d, want 1", revoked)
	}

	count, err = repo.CountNonRevokedKeysForPepper(ctx, pepper.PepperID())
	if err != nil {
		t.Fatalf("count after bulk revoke: %v", err)
	}
	if count != 0 {
		t.Fatalf("non-revoked count after bulk = %d, want 0", count)
	}
}

func TestPostgresRepository_GetKey_ExpiredNotActive(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	cleanCallerAccess(t, pool)

	repo := postgres.New(pool)
	ctx := context.Background()
	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-expired"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}

	pepper := testPepper{id: "pepper-v1", value: []byte("pepper-v1-secret")}
	keyID, _, hash, _ := calleraccess.GenerateKey(pepper)
	if _, err := repo.IssueKey(ctx, keyID, principal.PrincipalID, hash, pepper.PepperID()); err != nil {
		t.Fatalf("issue key: %v", err)
	}
	_, err := repo.GetKey(ctx, keyID)
	if err != nil {
		t.Fatalf("get key: %v", err)
	}
	_, err = repo.GetKey(ctx, "non-existent-key")
	if err == nil {
		t.Fatal("expected error for non-existent key")
	}
}

func TestPostgresRepository_CreatePrincipal(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	cleanCallerAccess(t, pool)

	repo := postgres.New(pool)
	ctx := context.Background()
	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-principal"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}
	got, err := repo.GetPrincipal(ctx, principal.PrincipalID)
	if err != nil {
		t.Fatalf("get principal: %v", err)
	}
	if got.PrincipalID != principal.PrincipalID {
		t.Fatalf("principal id = %s, want %s", got.PrincipalID, principal.PrincipalID)
	}
	if !got.IsActive() {
		t.Fatal("principal should be active")
	}
}

func init() {
	_ = time.Now
}
