package integration_test

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/calleraccess"
	calleraccesspostgres "rc_wsman/internal/calleraccess/postgres"
	"rc_wsman/internal/testsupport"
)

var integrationCallerSequence atomic.Uint64

func uniquePrincipal(t *testing.T, base string) string {
	t.Helper()
	h := fnv.New32a()
	_, _ = h.Write([]byte(fmt.Sprintf("%s-%d-%d", t.Name(), os.Getpid(), integrationCallerSequence.Add(1))))
	return fmt.Sprintf("%s-%08x", base, h.Sum32())
}

type intPepper struct {
	id    string
	value []byte
}

func (p intPepper) PepperID() string    { return p.id }
func (p intPepper) PepperValue() []byte { return p.value }

func TestCallerAccess_EndToEnd_AuthenticateAndRevoke(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	cleanCallerAccess(t, pool)

	repo := calleraccesspostgres.New(pool)
	pepper := intPepper{id: "int-pepper", value: []byte("int-pepper-secret")}
	authenticator := calleraccess.NewAuthenticator(repo, calleraccess.NewPepperSet(pepper, nil))

	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-e2e"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}

	keyID, secret, hash, err := calleraccess.GenerateKey(pepper)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	if _, err := repo.IssueKey(ctx, keyID, principal.PrincipalID, hash, pepper.PepperID()); err != nil {
		t.Fatalf("issue key: %v", err)
	}

	cp, err := authenticator.AuthenticateCaller(ctx, "Bearer "+keyID+"."+secret)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if cp.PrincipalID != principal.PrincipalID {
		t.Fatalf("principal id = %s, want %s", cp.PrincipalID, principal.PrincipalID)
	}
	if !cp.CoversVendor("vendor-a") {
		t.Fatal("expected vendor-a in scope")
	}
	if err := cp.AuthorizeVendor("vendor-b"); err == nil {
		t.Fatal("expected out-of-scope vendor to be rejected")
	}

	if _, err := repo.RevokeKey(ctx, keyID); err != nil {
		t.Fatalf("revoke key: %v", err)
	}
	if _, err := authenticator.AuthenticateCaller(ctx, "Bearer "+keyID+"."+secret); err == nil {
		t.Fatal("expected revoked key to be rejected")
	}
}

func TestCallerAccess_EndToEnd_PreviousPepper(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	cleanCallerAccess(t, pool)

	repo := calleraccesspostgres.New(pool)
	oldPepper := intPepper{id: "old", value: []byte("old-secret")}
	newPepper := intPepper{id: "new", value: []byte("new-secret")}
	authenticator := calleraccess.NewAuthenticator(repo, calleraccess.NewPepperSet(newPepper, oldPepper))

	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-pepper"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}
	keyID, secret, hash, err := calleraccess.GenerateKey(oldPepper)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	if _, err := repo.IssueKey(ctx, keyID, principal.PrincipalID, hash, oldPepper.PepperID()); err != nil {
		t.Fatalf("issue key: %v", err)
	}
	if _, err := authenticator.AuthenticateCaller(ctx, "Bearer "+keyID+"."+secret); err != nil {
		t.Fatalf("previous pepper should authenticate: %v", err)
	}
}

func TestPepperRotationRunbookUsesKeyAdminAndFailsClosed(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	repo := calleraccesspostgres.New(pool)
	v1 := intPepper{id: uniquePrincipal(t, "pepper-v1"), value: []byte("rotation-v1-secret")}
	v2 := intPepper{id: uniquePrincipal(t, "pepper-v2"), value: []byte("rotation-v2-secret")}
	principal := calleraccess.PrincipalRecord{
		PrincipalID: uniquePrincipal(t, "caller-rotation"), Kind: calleraccess.KindCaller, Status: "active",
		VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}, OwningScope: "team-rotation",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatal(err)
	}
	op := calleraccess.OperatorPrincipal{
		PrincipalID: "rotation-harness", Capabilities: []string{calleraccess.CapabilityManageAccessKeys},
		ManagedPrincipalScope: []string{principal.OwningScope},
	}
	v1Issued, err := calleraccess.NewKeyAdmin(repo, calleraccess.NewPepperSet(v1, nil)).IssueKey(ctx, op, principal)
	if err != nil {
		t.Fatal(err)
	}
	grace := calleraccess.NewPepperSet(v2, v1)
	if err := calleraccess.ValidateLoadedPepperGenerations(ctx, repo, grace); err != nil {
		t.Fatalf("v2+previous v1 must satisfy startup validation: %v", err)
	}
	if _, err := calleraccess.NewAuthenticator(repo, grace).AuthenticateCaller(ctx, "Bearer "+v1Issued.RawKey); err != nil {
		t.Fatalf("v1 key must remain valid during grace: %v", err)
	}
	v2Issued, err := calleraccess.NewKeyAdmin(repo, grace).IssueKey(ctx, op, principal)
	if err != nil {
		t.Fatal(err)
	}
	v2ID := strings.SplitN(v2Issued.RawKey, ".", 2)[0]
	v2Record, err := repo.GetKey(ctx, v2ID)
	if err != nil || v2Record.PepperID != v2.PepperID() {
		t.Fatalf("new key record=%+v err=%v", v2Record, err)
	}
	if err := calleraccess.ValidateLoadedPepperGenerations(ctx, repo, calleraccess.NewPepperSet(v2, nil)); err == nil {
		t.Fatal("startup must fail while a non-revoked v1 key remains")
	}
	if revoked, err := repo.BulkRevokePepper(ctx, v1.PepperID()); err != nil || revoked != 1 {
		t.Fatalf("bulk revoke=%d err=%v", revoked, err)
	}
	v2Only := calleraccess.NewPepperSet(v2, nil)
	if err := calleraccess.ValidateLoadedPepperGenerations(ctx, repo, v2Only); err != nil {
		t.Fatalf("startup should pass after v1 revocation: %v", err)
	}
	if _, err := calleraccess.NewAuthenticator(repo, v2Only).AuthenticateCaller(ctx, "Bearer "+v1Issued.RawKey); err == nil {
		t.Fatal("revoked v1 key must fail immediately")
	}
	if _, err := calleraccess.NewAuthenticator(repo, v2Only).AuthenticateCaller(ctx, "Bearer "+v2Issued.RawKey); err != nil {
		t.Fatalf("v2 key must remain valid: %v", err)
	}
}

func TestCallerAccess_EndToEnd_RateLimit(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	cleanCallerAccess(t, pool)

	repo := calleraccesspostgres.New(pool)
	pepper := intPepper{id: "rl-pepper", value: []byte("rl-pepper-secret")}
	authenticator := calleraccess.NewAuthenticator(repo, calleraccess.NewPepperSet(pepper, nil))
	// Configure a tiny bucket to force immediate rejection after the first call.
	authenticator.SetRateLimiter(calleraccess.NewRateLimiter(1, 1, 1))

	principal := calleraccess.PrincipalRecord{
		PrincipalID:  uniquePrincipal(t, "caller-rl"),
		Kind:         calleraccess.KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{calleraccess.CapabilitySubmitNotification},
		OwningScope:  "team-a",
	}
	if err := repo.CreatePrincipal(ctx, principal); err != nil {
		t.Fatalf("create principal: %v", err)
	}
	keyID, secret, hash, err := calleraccess.GenerateKey(pepper)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	if _, err := repo.IssueKey(ctx, keyID, principal.PrincipalID, hash, pepper.PepperID()); err != nil {
		t.Fatalf("issue key: %v", err)
	}

	if _, err := authenticator.AuthenticateCaller(ctx, "Bearer "+keyID+"."+secret); err != nil {
		t.Fatalf("first authenticate: %v", err)
	}
	if _, err := authenticator.ApplyRateLimit(principal.PrincipalID, "caller"); err != nil {
		t.Fatalf("first rate limit should be allowed: %v", err)
	}
	if _, err := authenticator.ApplyRateLimit(principal.PrincipalID, "caller"); err == nil {
		t.Fatal("expected second rate limit to be rejected")
	}
}

func cleanCallerAccess(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// No global cleanup: tests use unique principal IDs so parallel packages
	// sharing the database never interfere. Rows persist as harmless fixtures.
}

func init() {
	_ = time.Now
}
