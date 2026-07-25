package calleraccess

import (
	"context"
	"testing"
)

func TestKeyAdmin_IssueKey_Success(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{
		PrincipalID: "caller-1", Kind: KindCaller, Status: "active",
		VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilitySubmitNotification},
		OwningScope: "team-a",
	}
	repo.principals["op-1"] = PrincipalRecord{
		PrincipalID: "op-1", Kind: KindOperator, Status: "active",
		VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilityManageAccessKeys},
		ManagedPrincipalScope: []string{"team-a"},
	}
	admin := NewKeyAdmin(repo, testPepperSet())
	op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-a"}}

	res, err := admin.IssueKey(context.Background(), op, repo.principals["caller-1"])
	if err != nil {
		t.Fatalf("issue key: %v", err)
	}
	if res.RawKey == "" {
		t.Fatal("raw key must be returned once on success")
	}
	if res.Status != "active" {
		t.Fatalf("status = %s, want active", res.Status)
	}
}

func TestKeyAdmin_IssueKey_MissingCapability(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{}, OwningScope: "team-a"}
	admin := NewKeyAdmin(repo, testPepperSet())
	op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityReadNotifications}, ManagedPrincipalScope: []string{"team-a"}}

	_, err := admin.IssueKey(context.Background(), op, repo.principals["caller-1"])
	if !IsRejection(err, RejectionForbidden) {
		t.Fatalf("expected forbidden, got %v", err)
	}
}

func TestKeyAdmin_IssueKey_OutOfManagedScope(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{}, OwningScope: "team-a"}
	repo.principals["op-1"] = PrincipalRecord{PrincipalID: "op-1", Kind: KindOperator, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-b"}}
	admin := NewKeyAdmin(repo, testPepperSet())
	op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-b"}}

	_, err := admin.IssueKey(context.Background(), op, repo.principals["caller-1"])
	if !IsRejection(err, RejectionInvalidManagedPrincipal) {
		t.Fatalf("expected invalid-managed-principal, got %v", err)
	}
}

func TestKeyAdmin_RevokeKey(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{}, OwningScope: "team-a"}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	keyID, secret, hash, _ := GenerateKey(pepper)
	repo.keys[keyID] = AccessKeyRecord{KeyID: keyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "active"}

	admin := NewKeyAdmin(repo, NewPepperSet(pepper, nil))
	op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-a"}}

	res, err := admin.RevokeKey(context.Background(), op, keyID)
	if err != nil {
		t.Fatalf("revoke key: %v", err)
	}
	if res.Status != "revoked" {
		t.Fatalf("status = %s, want revoked", res.Status)
	}
	// After revocation the raw key must not authenticate.
	auth := NewAuthenticator(repo, NewPepperSet(pepper, nil))
	_, err = auth.AuthenticateCaller(context.Background(), "Bearer "+keyID+"."+secret)
	if !IsRejection(err, RejectionUnauthenticated) {
		t.Fatalf("revoked key must not authenticate: %v", err)
	}
}

func TestKeyAdmin_RotateKey(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{}, OwningScope: "team-a"}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	oldKeyID, _, hash, _ := GenerateKey(pepper)
	repo.keys[oldKeyID] = AccessKeyRecord{KeyID: oldKeyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "active"}

	admin := NewKeyAdmin(repo, NewPepperSet(pepper, nil))
	op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-a"}}

	res, err := admin.RotateKey(context.Background(), op, oldKeyID)
	if err != nil {
		t.Fatalf("rotate key: %v", err)
	}
	if res.RawKey == "" {
		t.Fatal("raw key must be returned on rotate")
	}
	if len(repo.issued) != 1 {
		t.Fatalf("expected 1 newly issued key, got %d", len(repo.issued))
	}
	if len(repo.keys) != 2 {
		t.Fatalf("expected old + new keys in repo, got %d", len(repo.keys))
	}
}

func TestKeyRotationDoesNotResetPrincipalRateLimit(t *testing.T) {
	repo := newFakeRepo()
	repo.principals["caller-1"] = PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilitySubmitNotification}, OwningScope: "team-a"}
	pepper := testPepper{id: "pepper-active", value: []byte("active-pepper-secret")}
	oldKeyID, _, hash, _ := GenerateKey(pepper)
	repo.keys[oldKeyID] = AccessKeyRecord{KeyID: oldKeyID, PrincipalID: "caller-1", SecretHash: hash, PepperID: pepper.PepperID(), Status: "active"}

	authenticator := NewAuthenticator(repo, NewPepperSet(pepper, nil))
	authenticator.SetRateLimiter(NewRateLimiter(1, 1, 1))
	if _, err := authenticator.ApplyRateLimit("caller-1", "caller"); err != nil {
		t.Fatalf("first operation should consume the principal bucket: %v", err)
	}
	admin := NewKeyAdmin(repo, NewPepperSet(pepper, nil))
	op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-a"}}
	if _, err := admin.RotateKey(context.Background(), op, oldKeyID); err != nil {
		t.Fatalf("rotate key: %v", err)
	}
	if _, err := authenticator.ApplyRateLimit("caller-1", "caller"); !IsRejection(err, RejectionRateLimited) {
		t.Fatalf("rotation reset the principal bucket: %v", err)
	}
}

func TestKeyAdmin_CommitOutcomeUnknownReturnsOnlyKeyIDForConvergence(t *testing.T) {
	for _, durable := range []bool{false, true} {
		t.Run(map[bool]string{false: "not-found", true: "active"}[durable], func(t *testing.T) {
			repo := newFakeRepo()
			target := PrincipalRecord{PrincipalID: "caller-1", Kind: KindCaller, Status: "active", VendorScope: []string{"vendor-a"}, Capabilities: []string{CapabilitySubmitNotification}, OwningScope: "team-a"}
			repo.principals[target.PrincipalID] = target
			repo.issueErr = Rejection{Category: RejectionCommitOutcomeUnknown, Reason: "connection lost during commit"}
			repo.issueDurableOnError = durable
			admin := NewKeyAdmin(repo, testPepperSet())
			op := OperatorPrincipal{PrincipalID: "op-1", Capabilities: []string{CapabilityManageAccessKeys}, ManagedPrincipalScope: []string{"team-a"}}
			result, err := admin.IssueKey(context.Background(), op, target)
			if !IsRejection(err, RejectionCommitOutcomeUnknown) || result.KeyID == "" || result.RawKey != "" {
				t.Fatalf("unknown result=%+v err=%v", result, err)
			}
			key, queryErr := repo.GetKey(context.Background(), result.KeyID)
			if durable {
				if queryErr != nil || key.Status != "active" {
					t.Fatalf("authoritative active query key=%+v err=%v", key, queryErr)
				}
				if _, err := admin.RevokeKey(context.Background(), op, result.KeyID); err != nil {
					t.Fatalf("revoke converged active key: %v", err)
				}
			} else if !IsRejection(queryErr, RejectionUnauthenticated) {
				t.Fatalf("authoritative not-found query=%v", queryErr)
			}
		})
	}
}
