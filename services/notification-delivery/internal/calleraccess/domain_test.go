package calleraccess

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"testing"
	"time"
)

type testPepper struct {
	id    string
	value []byte
}

func (p testPepper) PepperID() string    { return p.id }
func (p testPepper) PepperValue() []byte { return p.value }

type fakeRepository struct {
	keys                map[string]AccessKeyRecord
	principals          map[string]PrincipalRecord
	issued              []AccessKeyRecord
	revoked             []string
	issueErr            error
	issueDurableOnError bool
}

func newFakeRepo() *fakeRepository {
	return &fakeRepository{
		keys:       make(map[string]AccessKeyRecord),
		principals: make(map[string]PrincipalRecord),
	}
}

func (r *fakeRepository) GetPrincipal(_ context.Context, principalID string) (PrincipalRecord, error) {
	p, ok := r.principals[principalID]
	if !ok {
		return PrincipalRecord{}, Rejection{Category: RejectionPrincipalNotFound}
	}
	return p, nil
}

func (r *fakeRepository) GetKey(_ context.Context, keyID string) (AccessKeyRecord, error) {
	k, ok := r.keys[keyID]
	if !ok {
		return AccessKeyRecord{}, Rejection{Category: RejectionUnauthenticated}
	}
	return k, nil
}

func (r *fakeRepository) IssueKey(_ context.Context, keyID, principalID string, hash []byte, pepperID string) (KeyIssueResult, error) {
	k := AccessKeyRecord{KeyID: keyID, PrincipalID: principalID, SecretHash: hash, PepperID: pepperID, Status: "active", CreatedAt: time.Now()}
	if r.issueErr != nil && !r.issueDurableOnError {
		return KeyIssueResult{KeyID: keyID, PrincipalID: principalID}, r.issueErr
	}
	r.keys[keyID] = k
	r.issued = append(r.issued, k)
	if r.issueErr != nil {
		return KeyIssueResult{KeyID: keyID, PrincipalID: principalID}, r.issueErr
	}
	return KeyIssueResult{KeyID: keyID, PrincipalID: principalID, Status: "active", CreatedAt: k.CreatedAt}, nil
}

func (r *fakeRepository) RevokeKey(_ context.Context, keyID string) (KeyRevokeResult, error) {
	k, ok := r.keys[keyID]
	if !ok {
		return KeyRevokeResult{}, Rejection{Category: RejectionUnauthenticated}
	}
	k.Status = "revoked"
	r.keys[keyID] = k
	r.revoked = append(r.revoked, keyID)
	return KeyRevokeResult{KeyID: keyID, PrincipalID: k.PrincipalID, Status: "revoked", RevokedAt: time.Now()}, nil
}

func (r *fakeRepository) ListActiveKeys(_ context.Context, _ string) ([]AccessKeyRecord, error) {
	return nil, nil
}

func (r *fakeRepository) CountNonRevokedKeysForPepper(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (r *fakeRepository) ListNonRevokedPepperIDs(_ context.Context) ([]string, error) {
	var ids []string
	seen := map[string]bool{}
	for _, key := range r.keys {
		if key.Status != "revoked" && !seen[key.PepperID] {
			ids = append(ids, key.PepperID)
			seen[key.PepperID] = true
		}
	}
	return ids, nil
}

func (r *fakeRepository) BulkRevokePepper(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (r *fakeRepository) CreatePrincipal(_ context.Context, _ PrincipalRecord) error {
	return nil
}

func testPepperSet() PepperSet {
	return NewPepperSet(testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}, nil)
}

func TestAuthenticateCaller_DerivesPrincipal(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{
		PrincipalID:  "caller-1",
		Kind:         KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{CapabilitySubmitNotification},
	}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	keyID, secret, hash, _ := GenerateKey(pepper)
	repo.keys[keyID] = AccessKeyRecord{KeyID: keyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "active"}

	auth := NewAuthenticator(repo, NewPepperSet(pepper, nil))
	cp, err := auth.AuthenticateCaller(t.Context(), "Bearer "+keyID+"."+secret)
	if err != nil {
		t.Fatalf("authenticate caller: %v", err)
	}
	if cp.PrincipalID != "caller-1" {
		t.Fatalf("caller_id = %s, want caller-1", cp.PrincipalID)
	}
	if len(cp.VendorScope) != 1 || cp.VendorScope[0] != "vendor-a" {
		t.Fatalf("vendor scope mismatch: %v", cp.VendorScope)
	}
	if !cp.HasCapability(CapabilitySubmitNotification) {
		t.Fatal("missing submit_notification capability")
	}
}

func TestAuthenticateCaller_MissingBearerPrefix(t *testing.T) {
	auth := NewAuthenticator(newFakeRepo(), testPepperSet())
	_, err := auth.AuthenticateCaller(t.Context(), "key.value")
	if !IsRejection(err, RejectionUnauthenticated) {
		t.Fatalf("expected unauthenticated, got %v", err)
	}
}

func TestAuthenticateCaller_RevokedKey(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilitySubmitNotification}}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	keyID, secret, hash, _ := GenerateKey(pepper)
	repo.keys[keyID] = AccessKeyRecord{KeyID: keyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "revoked"}

	auth := NewAuthenticator(repo, NewPepperSet(pepper, nil))
	_, err := auth.AuthenticateCaller(t.Context(), "Bearer "+keyID+"."+secret)
	if !IsRejection(err, RejectionUnauthenticated) {
		t.Fatalf("expected unauthenticated for revoked key, got %v", err)
	}
}

func TestAuthenticateCaller_WrongSecret(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilitySubmitNotification}}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	keyID, _, hash, _ := GenerateKey(pepper)
	repo.keys[keyID] = AccessKeyRecord{KeyID: keyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "active"}

	auth := NewAuthenticator(repo, NewPepperSet(pepper, nil))
	_, err := auth.AuthenticateCaller(t.Context(), "Bearer "+keyID+".wrong-secret")
	if !IsRejection(err, RejectionUnauthenticated) {
		t.Fatalf("expected unauthenticated for wrong secret, got %v", err)
	}
}

func TestAuthenticateCaller_PreviousPepperVerifies(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilitySubmitNotification}}
	oldPepper := testPepper{id: "pepper-old", value: []byte("old-pepper-secret")}
	newPepper := testPepper{id: "pepper-new", value: []byte("new-pepper-secret")}
	keyID, secret, hash, _ := GenerateKey(oldPepper)
	repo.keys[keyID] = AccessKeyRecord{KeyID: keyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: oldPepper.PepperID(), Status: "active"}

	auth := NewAuthenticator(repo, NewPepperSet(newPepper, oldPepper))
	_, err := auth.AuthenticateCaller(t.Context(), "Bearer "+keyID+"."+secret)
	if err != nil {
		t.Fatalf("previous pepper should verify: %v", err)
	}
}

func TestAuthenticateOperator_MissingCapability(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["op-1"] = PrincipalRecord{PrincipalID: "op-1", Kind: KindOperator, Status: "active", VendorScope: []string{"vendor-a"}, OwningScope: "team-a", Capabilities: []string{CapabilityReadNotifications}}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	keyID, secret, hash, _ := GenerateKey(pepper)
	repo.keys[keyID] = AccessKeyRecord{KeyID: keyID, PrincipalID: "op-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "active"}

	auth := NewAuthenticator(repo, NewPepperSet(pepper, nil))
	op, err := auth.AuthenticateOperator(t.Context(), "Bearer "+keyID+"."+secret)
	if err != nil {
		t.Fatalf("authenticate operator: %v", err)
	}
	if err := op.AuthorizeOperatorAction("replay_execute"); !IsRejection(err, RejectionForbidden) {
		t.Fatalf("expected forbidden, got %v", err)
	}
	if op.OwningScope != "team-a" || op.NewVRAdminContext().OwningScope != "team-a" {
		t.Fatalf("owning scope was not server-derived: principal=%q context=%q", op.OwningScope, op.NewVRAdminContext().OwningScope)
	}
}

func TestCallerPrincipal_AuthorizeVendor_OutOfScope(t *testing.T) {
	cp := CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}}
	err := cp.AuthorizeVendor("vendor-b")
	if !IsRejection(err, RejectionInvalidScope) {
		t.Fatalf("expected invalid-scope, got %v", err)
	}
}

func TestCallerPrincipal_AuthorizeVendor_InScope(t *testing.T) {
	cp := CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}}
	if err := cp.AuthorizeVendor("vendor-a"); err != nil {
		t.Fatalf("expected in-scope, got %v", err)
	}
}

func TestRateLimit_AllowsFirstRejectsBurst(t *testing.T) {
	// 60 per minute = 1 per second. First request allowed; immediate second rejected.
	rl := NewRateLimiter(60, 60, 10)
	allowed, _ := rl.Allow("p1", "caller")
	if !allowed {
		t.Fatal("first request should be allowed")
	}
	allowed, retry := rl.Allow("p1", "caller")
	if allowed {
		t.Fatal("second immediate request should be rejected")
	}
	if retry < time.Second || retry > DefaultRateLimitRetryAfterMax {
		t.Fatalf("retry out of bounds: %v", retry)
	}
}

func TestDigestKey_DifferentPeppersDifferentHashes(t *testing.T) {
	p1 := testPepper{id: "a", value: []byte("secret-1")}
	p2 := testPepper{id: "b", value: []byte("secret-2")}
	h1 := digestKey("k", "s", p1)
	h2 := digestKey("k", "s", p2)
	if bytes.Equal(h1, h2) {
		t.Fatal("same key under different peppers must produce different digests")
	}
}

func TestDigestKey_UsesHMACSHA256(t *testing.T) {
	p := testPepper{id: "a", value: []byte("pepper")}
	want := hmac.New(sha256.New, p.value)
	want.Write([]byte("k.s"))
	got := digestKey("k", "s", p)
	if !bytes.Equal(got, want.Sum(nil)) {
		t.Fatal("digest does not match HMAC-SHA-256")
	}
}

func TestValidatePrincipal_CallerOk(t *testing.T) {
	p := PrincipalRecord{
		PrincipalID:  "caller-1",
		Kind:         KindCaller,
		Status:       "active",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []string{CapabilitySubmitNotification},
	}
	if err := ValidatePrincipal(p); err != nil {
		t.Fatalf("valid caller rejected: %v", err)
	}
}

func TestValidatePrincipal_ManagedScopeFollowsAccessKeyCapability(t *testing.T) {
	base := PrincipalRecord{
		PrincipalID: "op-1", Kind: KindOperator, Status: "active",
		VendorScope: []string{"vendor-a"},
	}
	tests := []struct {
		name         string
		kind         string
		capabilities []string
		managed      []string
		wantError    bool
	}{
		{name: "read-only auditor has empty scope", capabilities: []string{CapabilityReadNotifications}},
		{name: "read-only auditor cannot carry managed scope", capabilities: []string{CapabilityReadNotifications}, managed: []string{"team-a"}, wantError: true},
		{name: "key manager needs managed scope", capabilities: []string{CapabilityManageAccessKeys}, wantError: true},
		{name: "key manager has managed scope", capabilities: []string{CapabilityManageAccessKeys}, managed: []string{"team-a"}},
		{name: "caller cannot carry managed scope", kind: KindCaller, capabilities: []string{CapabilitySubmitNotification}, managed: []string{"team-a"}, wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := base
			if tt.kind != "" {
				p.Kind = tt.kind
			}
			p.Capabilities = tt.capabilities
			p.ManagedPrincipalScope = tt.managed
			err := ValidatePrincipal(p)
			if (err != nil) != tt.wantError {
				t.Fatalf("ValidatePrincipal() error = %v, wantError %v", err, tt.wantError)
			}
		})
	}
}
