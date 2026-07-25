package calleraccess

import (
	"context"
	"crypto/rand"
	"encoding/base64"
)

// KeyAdmin performs API-key lifecycle operations guarded by the operator's
// managed_principal_scope. It never exposes raw secrets except on confirmed
// issue/rotate success.
type KeyAdmin struct {
	repo    Repository
	peppers PepperSet
}

// NewKeyAdmin builds a KeyAdmin for the given repository and pepper generations.
func NewKeyAdmin(repo Repository, peppers PepperSet) *KeyAdmin {
	return &KeyAdmin{repo: repo, peppers: peppers}
}

// IssueKey creates a new active key for the target principal. The operator must
// have manage_access_keys and cover the target principal in managed_principal_scope.
// Returns the raw key only once, on confirmed success.
func (ka *KeyAdmin) IssueKey(ctx context.Context, op OperatorPrincipal, target PrincipalRecord) (KeyIssueResult, error) {
	if err := ka.requireAdminScope(op, target); err != nil {
		return KeyIssueResult{}, err
	}
	return ka.issueNewKey(ctx, target)
}

// RotateKey creates a new active key for the principal that owns the supplied
// currentKeyID. The operator must have manage_access_keys and cover that
// principal. The old key remains active until explicitly revoked.
func (ka *KeyAdmin) RotateKey(ctx context.Context, op OperatorPrincipal, currentKeyID string) (KeyIssueResult, error) {
	key, err := ka.repo.GetKey(ctx, currentKeyID)
	if err != nil {
		if IsRejection(err, RejectionAuthorityUnavailable) {
			return KeyIssueResult{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "key lookup failed"}
		}
		return KeyIssueResult{}, Rejection{Category: RejectionUnauthenticated, Reason: "key not found"}
	}
	principal, err := ka.repo.GetPrincipal(ctx, key.PrincipalID)
	if err != nil {
		return KeyIssueResult{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "principal lookup failed"}
	}
	if err := ka.requireAdminScope(op, principal); err != nil {
		return KeyIssueResult{}, err
	}
	return ka.issueNewKey(ctx, principal)
}

// RevokeKey revokes an active key. The operator must manage the principal that
// owns the key.
func (ka *KeyAdmin) RevokeKey(ctx context.Context, op OperatorPrincipal, keyID string) (KeyRevokeResult, error) {
	key, err := ka.repo.GetKey(ctx, keyID)
	if err != nil {
		if IsRejection(err, RejectionAuthorityUnavailable) {
			return KeyRevokeResult{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "key lookup failed"}
		}
		return KeyRevokeResult{}, Rejection{Category: RejectionUnauthenticated, Reason: "key not found"}
	}
	principal, err := ka.repo.GetPrincipal(ctx, key.PrincipalID)
	if err != nil {
		return KeyRevokeResult{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "principal lookup failed"}
	}
	if err := ka.requireAdminScope(op, principal); err != nil {
		return KeyRevokeResult{}, err
	}
	return ka.repo.RevokeKey(ctx, keyID)
}

func (ka *KeyAdmin) requireAdminScope(op OperatorPrincipal, target PrincipalRecord) error {
	if !op.HasCapability(CapabilityManageAccessKeys) {
		return Rejection{Category: RejectionForbidden, Reason: "missing manage_access_keys capability"}
	}
	for _, s := range op.ManagedPrincipalScope {
		if s == target.PrincipalID || s == target.OwningScope {
			return nil
		}
	}
	return Rejection{Category: RejectionInvalidManagedPrincipal, Reason: "target principal outside managed scope"}
}

func (ka *KeyAdmin) issueNewKey(ctx context.Context, target PrincipalRecord) (KeyIssueResult, error) {
	if ka.peppers == nil || ka.peppers.Active() == nil {
		return KeyIssueResult{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "no active pepper"}
	}
	keyID, secret, hash, err := GenerateKey(ka.peppers.Active())
	if err != nil {
		return KeyIssueResult{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "key generation failed"}
	}
	res, err := ka.repo.IssueKey(ctx, keyID, target.PrincipalID, hash, ka.peppers.Active().PepperID())
	if err != nil {
		if IsRejection(err, RejectionCommitOutcomeUnknown) {
			// The public key id is safe and is required for authoritative
			// convergence. Never return the raw secret for an unknown outcome.
			return KeyIssueResult{KeyID: keyID, PrincipalID: target.PrincipalID}, err
		}
		return KeyIssueResult{}, err
	}
	res.RawKey = keyID + "." + secret
	return res, nil
}

// randomBase64URL returns URL-safe base64 encoded random bytes of length n.
func randomBase64URL(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
