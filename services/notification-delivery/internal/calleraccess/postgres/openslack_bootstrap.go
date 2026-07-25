package postgres

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/openslackbootstrap"
)

// This lock is transaction-scoped and dedicated to the OpenSlack identity
// bootstrap. It must not be reused by delivery or lease-recovery workflows.
const openSlackBootstrapAdvisoryLock int64 = 7835199304210062

// OpenSlackBootstrapStore performs the two-principal/two-key bootstrap as one
// PostgreSQL transaction.
type OpenSlackBootstrapStore struct {
	pool *pgxpool.Pool
}

// NewOpenSlackBootstrapStore constructs the dedicated bootstrap store.
func NewOpenSlackBootstrapStore(pool *pgxpool.Pool) openslackbootstrap.Store {
	return &OpenSlackBootstrapStore{pool: pool}
}

// BootstrapOpenSlack acquires a dedicated transaction-scoped advisory lock,
// rejects any existing bootstrap principal, and atomically inserts all rows.
func (s *OpenSlackBootstrapStore) BootstrapOpenSlack(ctx context.Context, request openslackbootstrap.PersistRequest) error {
	if err := validateOpenSlackBootstrapRequest(request); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return knownBootstrapFailure("transaction_begin_failed", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, openSlackBootstrapAdvisoryLock); err != nil {
		return knownBootstrapFailure("advisory_lock_failed", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM principals WHERE principal_id IN ($1, $2)
		)
	`, openslackbootstrap.CallerPrincipalID, openslackbootstrap.AuditorPrincipalID).Scan(&exists); err != nil {
		return knownBootstrapFailure("principal_existence_check_failed", err)
	}
	if exists {
		return knownBootstrapFailure("bootstrap_principal_exists", errors.New("bootstrap principal already exists"))
	}

	if err := insertBootstrapPrincipal(ctx, tx, request.Caller); err != nil {
		return knownBootstrapFailure("caller_insert_failed", err)
	}
	if err := insertBootstrapPrincipal(ctx, tx, request.Auditor); err != nil {
		return knownBootstrapFailure("auditor_insert_failed", err)
	}
	if err := insertBootstrapKey(ctx, tx, request.CallerKey); err != nil {
		return knownBootstrapFailure("caller_key_insert_failed", err)
	}
	if err := insertBootstrapKey(ctx, tx, request.AuditorKey); err != nil {
		return knownBootstrapFailure("auditor_key_insert_failed", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return classifyBootstrapCommitFailure(err)
	}
	return nil
}

func validateOpenSlackBootstrapRequest(request openslackbootstrap.PersistRequest) error {
	if request.Caller.PrincipalID != openslackbootstrap.CallerPrincipalID ||
		request.Auditor.PrincipalID != openslackbootstrap.AuditorPrincipalID ||
		request.CallerKey.PrincipalID != openslackbootstrap.CallerPrincipalID ||
		request.AuditorKey.PrincipalID != openslackbootstrap.AuditorPrincipalID {
		return knownBootstrapFailure("bootstrap_contract_invalid", errors.New("principal identity mismatch"))
	}
	if err := calleraccess.ValidatePrincipal(request.Caller); err != nil {
		return knownBootstrapFailure("bootstrap_contract_invalid", err)
	}
	if err := calleraccess.ValidatePrincipal(request.Auditor); err != nil {
		return knownBootstrapFailure("bootstrap_contract_invalid", err)
	}
	if request.Caller.Kind != calleraccess.KindCaller || request.Caller.Status != "active" ||
		request.Caller.OwningScope != openslackbootstrap.OwningScope ||
		!slices.Equal(request.Caller.Capabilities, []string{calleraccess.CapabilitySubmitNotification}) ||
		len(request.Caller.ManagedPrincipalScope) != 0 ||
		request.Auditor.Kind != calleraccess.KindOperator || request.Auditor.Status != "active" ||
		request.Auditor.OwningScope != openslackbootstrap.OwningScope ||
		!slices.Equal(request.Auditor.Capabilities, []string{calleraccess.CapabilityReadNotifications}) ||
		len(request.Auditor.ManagedPrincipalScope) != 0 ||
		len(request.Caller.VendorScope) != 2 || !slices.Equal(request.Caller.VendorScope, request.Auditor.VendorScope) ||
		request.Caller.VendorScope[0] == request.Caller.VendorScope[1] {
		return knownBootstrapFailure("bootstrap_contract_invalid", errors.New("principal authority mismatch"))
	}
	if request.CallerKey.KeyID == "" || len(request.CallerKey.SecretHash) == 0 || request.CallerKey.PepperID == "" ||
		request.AuditorKey.KeyID == "" || len(request.AuditorKey.SecretHash) == 0 || request.AuditorKey.PepperID == "" ||
		request.CallerKey.PepperID != request.AuditorKey.PepperID || request.CallerKey.KeyID == request.AuditorKey.KeyID {
		return knownBootstrapFailure("bootstrap_contract_invalid", errors.New("key verifier material invalid"))
	}
	return nil
}

func insertBootstrapPrincipal(ctx context.Context, tx pgx.Tx, principal calleraccess.PrincipalRecord) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO principals
			(principal_id, kind, status, vendor_scope, owning_scope, capabilities, managed_principal_scope)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, principal.PrincipalID, principal.Kind, principal.Status, principal.VendorScope, principal.OwningScope,
		principal.Capabilities, principal.ManagedPrincipalScope)
	return err
}

func insertBootstrapKey(ctx context.Context, tx pgx.Tx, key openslackbootstrap.KeyRecord) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO access_keys (key_id, principal_id, secret_hash, pepper_id, status)
		VALUES ($1, $2, $3, $4, 'active')
	`, key.KeyID, key.PrincipalID, key.SecretHash, key.PepperID)
	return err
}

func knownBootstrapFailure(code string, err error) error {
	return openslackbootstrap.PersistenceError{
		Kind: openslackbootstrap.FailureKnownRollback, Code: code, Err: err,
	}
}

func classifyBootstrapCommitFailure(err error) error {
	kind := openslackbootstrap.FailureCommitUnknown
	code := "commit_outcome_unknown"
	var pgErr *pgconn.PgError
	if errors.Is(err, pgx.ErrTxCommitRollback) ||
		(errors.As(err, &pgErr) && pgErr.Code != "57P01" && pgErr.Code != "57P02" && pgErr.Code != "57P03" && pgErr.Code != "40003") {
		kind = openslackbootstrap.FailureKnownRollback
		code = "commit_rolled_back"
	}
	return openslackbootstrap.PersistenceError{Kind: kind, Code: code, Err: err}
}
