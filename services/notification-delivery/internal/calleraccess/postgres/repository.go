// Package postgres implements the calleraccess.Repository interface on PostgreSQL.
package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
)

// Repository implements calleraccess.Repository.
type Repository struct {
	pool *pgxpool.Pool
}

// New builds a PostgreSQL-backed Caller Access repository.
func New(pool *pgxpool.Pool) calleraccess.Repository {
	return &Repository{pool: pool}
}

// GetPrincipal returns a principal by id.
func (r *Repository) GetPrincipal(ctx context.Context, principalID string) (calleraccess.PrincipalRecord, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT principal_id, kind, status, vendor_scope, owning_scope, capabilities, managed_principal_scope, revision, created_at, updated_at
		FROM principals
		WHERE principal_id = $1
	`, principalID)

	var p calleraccess.PrincipalRecord
	var vendorScope, capabilities, managed []string
	var owningScope *string
	err := row.Scan(
		&p.PrincipalID, &p.Kind, &p.Status,
		&vendorScope, &owningScope, &capabilities, &managed,
		&p.Revision, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return calleraccess.PrincipalRecord{}, calleraccess.Rejection{Category: calleraccess.RejectionPrincipalNotFound, Reason: "principal not found"}
		}
		return calleraccess.PrincipalRecord{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	p.VendorScope = vendorScope
	p.OwningScope = derefString(owningScope)
	p.Capabilities = capabilities
	p.ManagedPrincipalScope = managed
	return p, nil
}

// GetKey returns an access key by public key_id.
func (r *Repository) GetKey(ctx context.Context, keyID string) (calleraccess.AccessKeyRecord, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT key_id, principal_id, secret_hash, pepper_id, status, created_at, expires_at, revoked_at
		FROM access_keys
		WHERE key_id = $1
	`, keyID)

	var k calleraccess.AccessKeyRecord
	err := row.Scan(
		&k.KeyID, &k.PrincipalID, &k.SecretHash, &k.PepperID, &k.Status,
		&k.CreatedAt, &k.ExpiresAt, &k.RevokedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return calleraccess.AccessKeyRecord{}, calleraccess.Rejection{Category: calleraccess.RejectionUnauthenticated, Reason: "key not found"}
		}
		return calleraccess.AccessKeyRecord{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return k, nil
}

// CreatePrincipal persists a new principal.
func (r *Repository) CreatePrincipal(ctx context.Context, p calleraccess.PrincipalRecord) error {
	if err := calleraccess.ValidatePrincipal(p); err != nil {
		return err
	}
	if p.ManagedPrincipalScope == nil {
		p.ManagedPrincipalScope = []string{}
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO principals (principal_id, kind, status, vendor_scope, owning_scope, capabilities, managed_principal_scope)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, p.PrincipalID, p.Kind, p.Status, p.VendorScope, p.OwningScope, p.Capabilities, p.ManagedPrincipalScope)
	if err != nil {
		return calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return nil
}

// IssueKey creates a new active key with the given keyID, principal and hash.
func (r *Repository) IssueKey(ctx context.Context, keyID, principalID string, hash []byte, pepperID string) (calleraccess.KeyIssueResult, error) {
	if keyID == "" || len(hash) == 0 || pepperID == "" {
		return calleraccess.KeyIssueResult{}, calleraccess.Rejection{Category: calleraccess.RejectionInvalidKeyFormat, Reason: "missing key_id, hash or pepper_id"}
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return calleraccess.KeyIssueResult{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize concurrent key issuance for the same principal using the
	// principal row as a mutex. This prevents races on the active-key limit.
	if _, err := tx.Exec(ctx, `
		SELECT 1 FROM principals WHERE principal_id = $1 FOR UPDATE
	`, principalID); err != nil {
		return calleraccess.KeyIssueResult{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}

	var activeCount int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM access_keys
		WHERE principal_id = $1 AND status = 'active'
	`, principalID).Scan(&activeCount); err != nil {
		return calleraccess.KeyIssueResult{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	if activeCount >= calleraccess.DefaultMaxActiveKeysPerPrincipal {
		return calleraccess.KeyIssueResult{}, calleraccess.Rejection{Category: calleraccess.RejectionActiveKeyLimit, Reason: "principal already has max active keys"}
	}

	createdAt := time.Now()
	if _, err := tx.Exec(ctx, `
		INSERT INTO access_keys (key_id, principal_id, secret_hash, pepper_id, status, created_at)
		VALUES ($1, $2, $3, $4, 'active', $5)
	`, keyID, principalID, hash, pepperID, createdAt); err != nil {
		return calleraccess.KeyIssueResult{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}

	if err := tx.Commit(ctx); err != nil {
		return calleraccess.KeyIssueResult{KeyID: keyID, PrincipalID: principalID}, calleraccess.Rejection{Category: calleraccess.RejectionCommitOutcomeUnknown, Reason: err.Error()}
	}
	return calleraccess.KeyIssueResult{KeyID: keyID, PrincipalID: principalID, Status: "active", CreatedAt: createdAt}, nil
}

// RevokeKey marks a key as revoked.
func (r *Repository) RevokeKey(ctx context.Context, keyID string) (calleraccess.KeyRevokeResult, error) {
	var principalID string
	var revokedAt time.Time
	err := r.pool.QueryRow(ctx, `
		UPDATE access_keys SET status = 'revoked', revoked_at = now()
		WHERE key_id = $1 AND status = 'active'
		RETURNING principal_id, revoked_at
	`, keyID).Scan(&principalID, &revokedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return calleraccess.KeyRevokeResult{}, calleraccess.Rejection{Category: calleraccess.RejectionUnauthenticated, Reason: "key not active"}
		}
		return calleraccess.KeyRevokeResult{}, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return calleraccess.KeyRevokeResult{KeyID: keyID, PrincipalID: principalID, Status: "revoked", RevokedAt: revokedAt}, nil
}

// ListActiveKeys returns active keys for a principal.
func (r *Repository) ListActiveKeys(ctx context.Context, principalID string) ([]calleraccess.AccessKeyRecord, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT key_id, principal_id, secret_hash, pepper_id, status, created_at, expires_at, revoked_at
		FROM access_keys
		WHERE principal_id = $1 AND status = 'active'
		ORDER BY created_at ASC
	`, principalID)
	if err != nil {
		return nil, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	defer rows.Close()

	var out []calleraccess.AccessKeyRecord
	for rows.Next() {
		var k calleraccess.AccessKeyRecord
		if err := rows.Scan(
			&k.KeyID, &k.PrincipalID, &k.SecretHash, &k.PepperID, &k.Status,
			&k.CreatedAt, &k.ExpiresAt, &k.RevokedAt,
		); err != nil {
			return nil, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return out, nil
}

// CountNonRevokedKeysForPepper returns the number of non-revoked keys with the pepper.
func (r *Repository) CountNonRevokedKeysForPepper(ctx context.Context, pepperID string) (int64, error) {
	var count int64
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM access_keys WHERE pepper_id = $1 AND status != 'revoked'
	`, pepperID).Scan(&count)
	if err != nil {
		return 0, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return count, nil
}

// ListNonRevokedPepperIDs returns the distinct pepper generations referenced
// by keys that have not been revoked.
func (r *Repository) ListNonRevokedPepperIDs(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT pepper_id
		FROM access_keys
		WHERE status != 'revoked'
		ORDER BY pepper_id
	`)
	if err != nil {
		return nil, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return ids, nil
}

// BulkRevokePepper revokes all keys with the given pepper_id in one transaction.
func (r *Repository) BulkRevokePepper(ctx context.Context, pepperID string) (int64, error) {
	var count int64
	err := r.pool.QueryRow(ctx, `
		WITH revoked AS (
			UPDATE access_keys
			SET status = 'revoked', revoked_at = now()
			WHERE pepper_id = $1 AND status = 'active'
			RETURNING key_id
		)
		SELECT COUNT(*) FROM revoked
	`, pepperID).Scan(&count)
	if err != nil {
		return 0, calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable, Reason: err.Error()}
	}
	return count, nil
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
