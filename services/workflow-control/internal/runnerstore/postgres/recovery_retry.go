package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/jackc/pgx/v5/pgconn"
)

func recoveryMetadataAbort(err error) *pgconn.PgError {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "40001" && pg.ConstraintName == "workflow_runner_recovery_version_retry" && pg.Detail != "" {
		return pg
	}
	return nil
}

func recoveryLeaseID(ctx context.Context, repository *Repository, body string) (string, error) {
	var identity struct {
		LeaseID   string `json:"leaseId"`
		BindingID string `json:"bindingId"`
	}
	// Called only to bound a retry after the operation has validated the exact body.
	_ = json.Unmarshal([]byte(body), &identity)
	if identity.LeaseID != "" || identity.BindingID == "" {
		return identity.LeaseID, nil
	}
	err := repository.pool.QueryRow(ctx, "SELECT lease_id FROM workflow_runner_authority_bindings WHERE binding_id=$1", identity.BindingID).Scan(&identity.LeaseID)
	return identity.LeaseID, err
}

// Retry only a positively identified, fully rolled-back metadata transaction.
// Callers put database work here; source CAS, message sending and receipt-unknown
// recovery stay outside. The existing commit-recovery budget bounds contention.
func retryRecoveryTransaction[T any](ctx context.Context, repository *Repository, leaseID func(context.Context) (string, error), operation func(context.Context) (T, error)) (T, error) {
	result, err := operation(ctx)
	if recoveryMetadataAbort(err) == nil {
		return result, err
	}
	retryCtx, cancel := context.WithTimeout(ctx, commitRecoveryTimeout)
	defer cancel()
	id, lookupErr := leaseID(retryCtx)
	if lookupErr != nil {
		return result, databaseFailure("resolve metadata retry lease", lookupErr)
	}
	if id != "" {
		var expires, now time.Time
		if readErr := repository.pool.QueryRow(retryCtx, "SELECT lease_expires_at,clock_timestamp() FROM workflow_runner_leases WHERE lease_id=$1", id).Scan(&expires, &now); readErr != nil {
			return result, databaseFailure("read metadata retry lease", readErr)
		}
		bounded, stop := context.WithTimeout(retryCtx, expires.Sub(now))
		defer stop()
		retryCtx = bounded
	}
	for {
		abort := recoveryMetadataAbort(err)
		if abort == nil {
			return result, err
		}
		if err = retryCtx.Err(); err != nil {
			return result, databaseFailure("metadata retry deadline", err)
		}
		// The failed operation has returned and released all business locks. Wait
		// for its contending metadata writer without holding any business row lock.
		if _, err = repository.pool.Exec(retryCtx, "SELECT pg_advisory_xact_lock(hashtextextended($1,11))", abort.Detail); err != nil {
			return result, databaseFailure("wait for recovery metadata writer", err)
		}
		result, err = operation(retryCtx)
	}
}

func recoveryCancelled(err error) error {
	return runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery read was cancelled or exceeded its deadline", err)
}

// Evidence persistence and expired-owner cleanup must remain possible after lease expiry.
func noRecoveryLease(context.Context) (string, error) { return "", nil }
