// Package postgres implements the notificationstore.Repository interface on top
// of PostgreSQL using pgx/v5.
//
// It keeps domain-decision logic in the notificationstore package and only
// handles SQL, transactions, and cursor signing.
package postgres

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/notificationstore"
)

// Repository implements notificationstore.Repository.
type Repository struct {
	pool   *pgxpool.Pool
	logger *slog.Logger
	signer *cursorSigner
}

// New builds a PostgreSQL-backed Notification Store repository.
func New(pool *pgxpool.Pool, logger *slog.Logger) notificationstore.Repository {
	return &Repository{
		pool:   pool,
		logger: logger,
		signer: newCursorSigner(),
	}
}

// txNow returns the current transaction time from the database.
func txNow(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var t time.Time
	if err := tx.QueryRow(ctx, "SELECT now()").Scan(&t); err != nil {
		return time.Time{}, notificationstore.Rejection{Category: notificationstore.RejectionClockUnavailable, Reason: "authoritative database clock unavailable"}
	}
	return t, nil
}

// Intake persists a new notification or returns an existing one idempotently.
func (r *Repository) Intake(ctx context.Context, in notificationstore.ValidatedIntake) (notificationstore.IntakeResult, error) {
	if err := notificationstore.ValidateIntake(in); err != nil {
		return notificationstore.IntakeResult{}, err
	}
	fp := notificationstore.ComputeFingerprint(in)

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return notificationstore.IntakeResult{}, fmt.Errorf("begin intake: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now, err := txNow(ctx, tx)
	if err != nil {
		return notificationstore.IntakeResult{}, err
	}

	var id string
	var createdAt time.Time
	insertErr := tx.QueryRow(ctx, intakeInsertSQL,
		in.CallerID,
		in.VendorID,
		in.IdempotencyKey,
		fp,
		in.Payload,
		now,
	).Scan(&id, &createdAt)
	switch {
	case insertErr == nil:
		// New row inserted; id is populated.
	case errors.Is(insertErr, pgx.ErrNoRows):
		// Conflict on unique key; read the existing row to apply the idempotency matrix.
		var existingFP []byte
		var existingID string
		var existingCreatedAt time.Time
		if err := tx.QueryRow(ctx, intakeSelectSQL, in.CallerID, in.IdempotencyKey).Scan(&existingID, &existingFP, &existingCreatedAt); err != nil {
			return notificationstore.IntakeResult{}, fmt.Errorf("intake conflict read: %w", err)
		}
		if string(existingFP) == string(fp) {
			if err := tx.Commit(ctx); err != nil {
				return notificationstore.IntakeResult{}, commitFailure(err)
			}
			return notificationstore.IntakeResult{NotificationID: existingID, IdempotentReplay: true, AcceptedAt: existingCreatedAt}, nil
		}
		return notificationstore.IntakeResult{}, notificationstore.Rejection{
			Category: notificationstore.RejectionIdempotencyConflict,
			Reason:   "idempotency key exists with different request fingerprint",
		}
	default:
		if pgErr := (&pgconn.PgError{}); errors.As(insertErr, &pgErr) && pgErr.Code == "23505" {
			// Rare race path: a concurrent insert committed between our insert
			// attempt and the conflict check; surface as outcome-unknown.
			return notificationstore.IntakeResult{}, notificationstore.Rejection{
				Category: notificationstore.RejectionCommitOutcomeUnknown,
				Reason:   "concurrent intake conflict",
			}
		}
		return notificationstore.IntakeResult{}, fmt.Errorf("intake insert: %w", insertErr)
	}

	if err := tx.Commit(ctx); err != nil {
		return notificationstore.IntakeResult{}, commitFailure(err)
	}
	return notificationstore.IntakeResult{NotificationID: id, IdempotentReplay: false, AcceptedAt: createdAt}, nil
}

// ClaimNext selects the oldest eligible pending notification and issues a lease.
func (r *Repository) ClaimNext(ctx context.Context, actor notificationstore.ActorContext, filter *notificationstore.ClaimFilter, leaseTTL time.Duration) (notificationstore.LeaseClaim, error) {
	if err := notificationstore.ValidateClaimActor(actor); err != nil {
		return notificationstore.LeaseClaim{}, err
	}
	if leaseTTL <= 0 || leaseTTL > notificationstore.LeaseTTLMax {
		return notificationstore.LeaseClaim{}, notificationstore.Rejection{
			Category: notificationstore.RejectionInvalidLeaseTTL,
			Reason:   fmt.Sprintf("lease_ttl must be in (0, %s]", notificationstore.LeaseTTLMax),
		}
	}

	scope, ok := scopeFromFilter(actor, filter)
	if !ok {
		return notificationstore.LeaseClaim{}, notificationstore.Rejection{Category: notificationstore.RejectionNotFound, Reason: "scope does not cover filter"}
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return notificationstore.LeaseClaim{}, fmt.Errorf("begin claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now, err := txNow(ctx, tx)
	if err != nil {
		return notificationstore.LeaseClaim{}, err
	}

	var n notificationstore.Notification
	var scanArgs []any
	var query string
	if filter != nil && filter.NotificationID != "" {
		query = claimByIDSQL
		scanArgs = []any{filter.NotificationID, scope}
	} else {
		query = claimScanSQL
		scanArgs = []any{scope}
	}
	row := tx.QueryRow(ctx, query, scanArgs...)
	if err := scanNotification(row, &n); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notificationstore.LeaseClaim{}, notificationstore.ErrNoEligibleNotification
		}
		return notificationstore.LeaseClaim{}, fmt.Errorf("claim select: %w", err)
	}

	leaseID := generateLeaseID()
	expiresAt := now.Add(leaseTTL)
	if err := applyClaim(ctx, tx, n.ID, n.Version, leaseID, expiresAt, actor.ActorID, now); err != nil {
		return notificationstore.LeaseClaim{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return notificationstore.LeaseClaim{}, commitFailure(err)
	}

	return notificationstore.LeaseClaim{
		NotificationID:         string(n.ID),
		IngressIdempotencyKey:  n.IdempotencyKey,
		LeaseID:                leaseID,
		LeaseExpiresAt:         expiresAt,
		Version:                n.Version + 1,
		Payload:                n.Payload,
		VendorID:               n.VendorID,
		AttemptCount:           n.AttemptCount,
		DeliveryCycleStartedAt: n.DeliveryCycleStartedAt,
		CreatedAt:              n.CreatedAt,
	}, nil
}

// Transition applies a state-machine transition under OCC + lease validation.
func (r *Repository) Transition(ctx context.Context, actor notificationstore.ActorContext, req notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
	if err := notificationstore.ValidateTransitionActor(actor, req.RequestedTransition); err != nil {
		return notificationstore.TransitionResult{}, err
	}

	scope, _, err := readScope(actor, nil) // nil filter => full actor scope for write paths
	if err != nil {
		return notificationstore.TransitionResult{}, err
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return notificationstore.TransitionResult{}, fmt.Errorf("begin transition: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now, err := txNow(ctx, tx)
	if err != nil {
		return notificationstore.TransitionResult{}, err
	}

	var n notificationstore.Notification
	row := tx.QueryRow(ctx, selectNotificationForUpdateSQL, req.NotificationID, scope)
	if err := scanNotification(row, &n); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notificationstore.TransitionResult{}, notificationstore.Rejection{
				Category: notificationstore.RejectionNotFound,
				Reason:   "notification not found or out of scope",
			}
		}
		return notificationstore.TransitionResult{}, fmt.Errorf("transition select: %w", err)
	}

	decision, err := notificationstore.DecideTransition(actor, req, n)
	if err != nil {
		return notificationstore.TransitionResult{}, err
	}

	if req.RequestedTransition != notificationstore.TransitionReplay {
		if err := notificationstore.ValidateLease(n, req.LeaseID, actor.ActorID, now); err != nil {
			return notificationstore.TransitionResult{}, err
		}
	}

	newAttemptCount, err := nextAttemptCount(n.AttemptCount, decision.AttemptCountDelta)
	if err != nil {
		return notificationstore.TransitionResult{}, err
	}

	newVersion := n.Version + 1
	newCycleStart := n.DeliveryCycleStartedAt
	if decision.SetReplayedAt {
		newCycleStart = now
	}

	attemptSeq, err := nextAttemptSeq(ctx, tx, n.ID)
	if err != nil {
		return notificationstore.TransitionResult{}, err
	}

	if err := appendAttempt(ctx, tx, n.ID, attemptSeq, decision, actor.ActorID, n.LeaseID, n.LeaseExpiresAt, req.DeliveryResult, now); err != nil {
		return notificationstore.TransitionResult{}, err
	}

	if err := updateNotification(ctx, tx, n, decision, newAttemptCount, newVersion, newCycleStart, actor.ActorID, now); err != nil {
		if errors.Is(err, errNoRowsAffected) {
			return notificationstore.TransitionResult{}, notificationstore.Rejection{
				Category: notificationstore.RejectionStaleVersion,
				Reason:   "version changed concurrently",
			}
		}
		return notificationstore.TransitionResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return notificationstore.TransitionResult{}, commitFailure(err)
	}

	return notificationstore.TransitionResult{
		NotificationID:         string(n.ID),
		State:                  decision.NewState,
		Version:                newVersion,
		AttemptCount:           newAttemptCount,
		DeliveryCycleStartedAt: newCycleStart,
		ReplayCount:            n.ReplayCount + boolInt(decision.SetReplayedAt),
	}, nil
}

// RecoverExpiredLeases sweeps expired in-flight leases back to pending.
func (r *Repository) RecoverExpiredLeases(ctx context.Context, actor notificationstore.ActorContext, batchLimit int) ([]notificationstore.RecoveredLease, error) {
	if err := actor.Validate(); err != nil {
		return nil, err
	}
	if actor.Kind != notificationstore.ActorSystem {
		return nil, notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "recovery requires system actor"}
	}
	if !actor.HasCapability(notificationstore.CapabilityRecoverExpiredLeases) {
		return nil, notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "missing recover_expired_leases capability"}
	}
	if batchLimit < notificationstore.RecoveryBatchMin || batchLimit > notificationstore.RecoveryBatchMax {
		return nil, notificationstore.Rejection{
			Category: notificationstore.RejectionInvalidBatchLimit,
			Reason:   fmt.Sprintf("batch_limit must be in [%d, %d]", notificationstore.RecoveryBatchMin, notificationstore.RecoveryBatchMax),
		}
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin recover: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lockAcquired bool
	if err := tx.QueryRow(ctx, recoveryTryLockSQL).Scan(&lockAcquired); err != nil {
		return nil, fmt.Errorf("recover advisory lock: %w", err)
	}
	if !lockAcquired {
		return []notificationstore.RecoveredLease{}, nil
	}

	now, err := txNow(ctx, tx)
	if err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, recoverSelectSQL, batchLimit, now)
	if err != nil {
		return nil, fmt.Errorf("recover select: %w", err)
	}
	// Materialize the rows before issuing further statements on the same tx;
	// pgx forbids interleaved queries on a busy connection.
	var expired []notificationstore.Notification
	for rows.Next() {
		var n notificationstore.Notification
		if err := scanNotificationRows(rows, &n); err != nil {
			rows.Close()
			return nil, fmt.Errorf("recover scan: %w", err)
		}
		expired = append(expired, n)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("recover rows: %w", err)
	}
	rows.Close()

	var out []notificationstore.RecoveredLease
	for _, n := range expired {
		newVersion := n.Version + 1
		newAttemptCount, err := nextAttemptCount(n.AttemptCount, 1)
		if err != nil {
			return nil, err
		}
		attemptSeq, err := nextAttemptSeq(ctx, tx, n.ID)
		if err != nil {
			return nil, err
		}
		decision := notificationstore.TransitionDecision{
			NewState:          notificationstore.StatePending,
			AttemptCountDelta: 1,
			ClearLease:        true,
			SetNextAttemptAt:  &now,
			LastOutcomeClass:  string(notificationstore.OutcomeClassRetryableFailure),
			LastErrorCode:     notificationstore.ErrorCodeLeaseExpiredUnknownResult,
			EventKind:         notificationstore.EventKindRecovery,
			ResultKind:        notificationstore.ResultKindUnknownResult,
			OutcomeClass:      notificationstore.OutcomeClassRetryableFailure,
			Reason:            notificationstore.ErrorCodeLeaseExpiredUnknownResult,
		}
		if err := appendAttempt(ctx, tx, n.ID, attemptSeq, decision, actor.ActorID, n.LeaseID, n.LeaseExpiresAt, nil, now); err != nil {
			return nil, err
		}
		if err := updateNotification(ctx, tx, n, decision, newAttemptCount, newVersion, n.DeliveryCycleStartedAt, actor.ActorID, now); err != nil {
			return nil, err
		}
		out = append(out, notificationstore.RecoveredLease{
			NotificationID: string(n.ID),
			Version:        newVersion,
			AttemptCount:   newAttemptCount,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, commitFailure(err)
	}
	return out, nil
}

// Get returns a notification summary for an authorized actor.
func (r *Repository) Get(ctx context.Context, actor notificationstore.ActorContext, id notificationstore.NotificationID) (notificationstore.Notification, error) {
	if err := readActorValidate(actor); err != nil {
		return notificationstore.Notification{}, err
	}
	scope, _, err := readScope(actor, nil)
	if err != nil {
		return notificationstore.Notification{}, err
	}
	var n notificationstore.Notification
	row := r.pool.QueryRow(ctx, selectNotificationSQL, string(id), scope)
	if err := scanNotification(row, &n); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notificationstore.Notification{}, notificationstore.Rejection{
				Category: notificationstore.RejectionNotFound,
				Reason:   "notification not found or out of scope",
			}
		}
		return notificationstore.Notification{}, fmt.Errorf("get notification: %w", err)
	}
	return n, nil
}

// QueryOutbox returns the BL-06 aggregate projection.
func (r *Repository) QueryOutbox(ctx context.Context, actor notificationstore.ActorContext, vendorFilter []string) (notificationstore.OutboxProjection, error) {
	if err := actor.Validate(); err != nil {
		return notificationstore.OutboxProjection{}, err
	}
	if actor.Kind != notificationstore.ActorOperator && actor.Kind != notificationstore.ActorSystem {
		return notificationstore.OutboxProjection{}, notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "outbox read requires operator or system actor"}
	}
	if !actor.HasCapability(notificationstore.CapabilityReadNotifications) && !(actor.Kind == notificationstore.ActorSystem && actor.HasCapability(notificationstore.CapabilityReadAllNotifications)) {
		return notificationstore.OutboxProjection{}, notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "missing outbox read capability"}
	}
	if actor.Kind == notificationstore.ActorSystem && len(vendorFilter) == 0 && len(actor.VendorScope) == 1 && actor.VendorScope[0] == "*" && !actor.HasCapability(notificationstore.CapabilityReadAllNotifications) {
		return notificationstore.OutboxProjection{}, notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "global system query requires read_all_notifications"}
	}
	scope, global, err := readScope(actor, vendorFilter)
	if err != nil {
		return notificationstore.OutboxProjection{}, err
	}
	if global && !actor.HasCapability(notificationstore.CapabilityReadAllNotifications) {
		return notificationstore.OutboxProjection{}, notificationstore.Rejection{
			Category: notificationstore.RejectionForbiddenAction,
			Reason:   "global query requires read_all_notifications",
		}
	}

	var proj notificationstore.OutboxProjection
	if err := r.pool.QueryRow(ctx, outboxProjectionSQL, global, scope).Scan(
		&proj.PendingCount, &proj.InFlightCount, &proj.DeliveredCount,
		&proj.DeadCount, &proj.OldestPendingAgeSeconds,
	); err != nil {
		return proj, fmt.Errorf("outbox projection: %w", err)
	}
	return proj, nil
}

// ListDead returns a snapshot-bounded page of dead notifications.
func (r *Repository) ListDead(ctx context.Context, actor notificationstore.ActorContext, vendorFilter []string, limit int, cursor string) (notificationstore.DeadPage, error) {
	if err := readActorValidate(actor); err != nil {
		return notificationstore.DeadPage{}, err
	}
	limit, err := normalizePageLimit(limit)
	if err != nil {
		return notificationstore.DeadPage{}, notificationstore.Rejection{
			Category: notificationstore.RejectionInvalidPageLimit,
			Reason:   fmt.Sprintf("limit must be in [%d, %d]", notificationstore.ListPageMin, notificationstore.ListPageMax),
		}
	}

	scope, _, err := readScope(actor, vendorFilter)
	if err != nil {
		return notificationstore.DeadPage{}, err
	}
	if len(scope) == 0 {
		return notificationstore.DeadPage{}, notificationstore.Rejection{
			Category: notificationstore.RejectionNotFound,
			Reason:   "empty effective scope",
		}
	}

	var snapshotAt time.Time
	var lastDeadAt *time.Time
	var lastID string

	if cursor != "" {
		env, err := r.signer.verify(cursor)
		if err != nil || env.Op != "list_dead" || !env.withScope(scope) || env.Limit != limit {
			return notificationstore.DeadPage{}, notificationstore.Rejection{
				Category: notificationstore.RejectionInvalidCursor,
				Reason:   "cursor tampered or mismatched",
			}
		}
		snapshotAt, err = time.Parse(time.RFC3339Nano, env.SnapshotAt)
		if err != nil {
			return notificationstore.DeadPage{}, notificationstore.Rejection{
				Category: notificationstore.RejectionInvalidCursor,
				Reason:   "invalid snapshot time",
			}
		}
		if env.LastDeadAt != "" {
			t, err := time.Parse(time.RFC3339Nano, env.LastDeadAt)
			if err != nil {
				return notificationstore.DeadPage{}, notificationstore.Rejection{
					Category: notificationstore.RejectionInvalidCursor,
					Reason:   "invalid dead_at cursor",
				}
			}
			lastDeadAt = &t
			lastID = env.LastID
		}
	} else {
		if err := r.pool.QueryRow(ctx, "SELECT now()").Scan(&snapshotAt); err != nil {
			return notificationstore.DeadPage{}, notificationstore.Rejection{
				Category: notificationstore.RejectionClockUnavailable,
				Reason:   "authoritative database clock unavailable",
			}
		}
	}

	rows, err := r.pool.Query(ctx, listDeadSQL, scope, snapshotAt, lastDeadAt, lastID, limit+1)
	if err != nil {
		return notificationstore.DeadPage{}, fmt.Errorf("list dead: %w", err)
	}
	defer rows.Close()

	var items []notificationstore.DeadNotification
	for rows.Next() {
		var n notificationstore.Notification
		if err := scanNotificationRows(rows, &n); err != nil {
			return notificationstore.DeadPage{}, fmt.Errorf("scan dead: %w", err)
		}
		items = append(items, notificationstore.DeadNotification{
			NotificationID: string(n.ID),
			VendorID:       n.VendorID,
			State:          n.State,
			Version:        n.Version,
			AttemptCount:   n.AttemptCount,
			ReplayCount:    n.ReplayCount,
			DeadAt:         *n.DeadAt,
			DeadReason:     n.DeadReason,
		})
	}
	if err := rows.Err(); err != nil {
		return notificationstore.DeadPage{}, fmt.Errorf("dead rows: %w", err)
	}

	var nextCursor string
	if len(items) > limit {
		last := items[limit-1]
		items = items[:limit]
		env := cursorEnvelope{
			Op:         "list_dead",
			Scope:      scope,
			Limit:      limit,
			SnapshotAt: snapshotAt.Format(time.RFC3339Nano),
			LastDeadAt: last.DeadAt.Format(time.RFC3339Nano),
			LastID:     last.NotificationID,
		}
		nextCursor, err = r.signer.sign(env)
		if err != nil {
			return notificationstore.DeadPage{}, fmt.Errorf("sign dead cursor: %w", err)
		}
	}
	return notificationstore.DeadPage{Items: items, NextCursor: nextCursor}, nil
}

// ListAttemptHistory returns a stable page of attempt history.
func (r *Repository) ListAttemptHistory(ctx context.Context, actor notificationstore.ActorContext, id notificationstore.NotificationID, limit int, cursor string) (notificationstore.AttemptPage, error) {
	if err := readActorValidate(actor); err != nil {
		return notificationstore.AttemptPage{}, err
	}
	limit, err := normalizePageLimit(limit)
	if err != nil {
		return notificationstore.AttemptPage{}, notificationstore.Rejection{
			Category: notificationstore.RejectionInvalidPageLimit,
			Reason:   fmt.Sprintf("limit must be in [%d, %d]", notificationstore.ListPageMin, notificationstore.ListPageMax),
		}
	}

	scope, _, err := readScope(actor, nil)
	if err != nil {
		return notificationstore.AttemptPage{}, err
	}

	// Verify the target notification exists and is in scope (without leaking state).
	var vendorID string
	if err := r.pool.QueryRow(ctx, "SELECT vendor_id FROM notifications WHERE notification_id = $1", string(id)).Scan(&vendorID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notificationstore.AttemptPage{}, notificationstore.Rejection{
				Category: notificationstore.RejectionNotFound,
				Reason:   "notification not found or out of scope",
			}
		}
		return notificationstore.AttemptPage{}, fmt.Errorf("history scope check: %w", err)
	}
	if !actor.CoversVendor(vendorID) {
		return notificationstore.AttemptPage{}, notificationstore.Rejection{
			Category: notificationstore.RejectionNotFound,
			Reason:   "notification not found or out of scope",
		}
	}

	var lastSeq int64
	var lastAttemptID string
	if cursor != "" {
		env, err := r.signer.verify(cursor)
		if err != nil || env.Op != "history" || env.NotificationID != string(id) || !env.withScope(scope) || env.Limit != limit {
			return notificationstore.AttemptPage{}, notificationstore.Rejection{
				Category: notificationstore.RejectionInvalidCursor,
				Reason:   "cursor tampered or mismatched",
			}
		}
		lastSeq = env.LastAttemptSeq
		lastAttemptID = env.LastAttemptID
	}

	rows, err := r.pool.Query(ctx, listHistorySQL, string(id), lastSeq, lastAttemptID, limit+1)
	if err != nil {
		return notificationstore.AttemptPage{}, fmt.Errorf("history query: %w", err)
	}
	defer rows.Close()

	var items []notificationstore.Attempt
	for rows.Next() {
		var a notificationstore.Attempt
		if err := scanAttempt(rows, &a); err != nil {
			return notificationstore.AttemptPage{}, fmt.Errorf("scan history: %w", err)
		}
		items = append(items, a)
	}
	if err := rows.Err(); err != nil {
		return notificationstore.AttemptPage{}, fmt.Errorf("history rows: %w", err)
	}

	var nextCursor string
	if len(items) > limit {
		last := items[limit-1]
		items = items[:limit]
		env := cursorEnvelope{
			Op:             "history",
			Scope:          scope,
			Limit:          limit,
			NotificationID: string(id),
			LastAttemptSeq: last.AttemptSeq,
			LastAttemptID:  last.ID,
		}
		nextCursor, err = r.signer.sign(env)
		if err != nil {
			return notificationstore.AttemptPage{}, fmt.Errorf("sign history cursor: %w", err)
		}
	}
	return notificationstore.AttemptPage{Items: items, NextCursor: nextCursor}, nil
}

// scopeFromFilter resolves the effective vendor scope for a claim filter.
func scopeFromFilter(actor notificationstore.ActorContext, filter *notificationstore.ClaimFilter) ([]string, bool) {
	if filter != nil && filter.VendorID != "" {
		if !actor.CoversVendor(filter.VendorID) {
			return nil, false
		}
		return []string{filter.VendorID}, true
	}
	return actor.VendorScope, true
}

// readScope resolves the effective read scope and a global flag.
func readScope(actor notificationstore.ActorContext, filter []string) ([]string, bool, error) {
	if len(filter) == 0 {
		if actor.Kind == notificationstore.ActorSystem && actor.HasCapability(notificationstore.CapabilityReadAllNotifications) {
			return []string{}, true, nil
		}
		return actor.VendorScope, false, nil
	}
	scope, ok := actor.EffectiveScope(filter)
	if !ok {
		return nil, false, notificationstore.Rejection{
			Category: notificationstore.RejectionNotFound,
			Reason:   "requested scope outside actor scope",
		}
	}
	return scope, false, nil
}

func readActorValidate(actor notificationstore.ActorContext) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	if actor.Kind != notificationstore.ActorOperator && actor.Kind != notificationstore.ActorSystem {
		return notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "read requires operator or system actor"}
	}
	if !actor.HasCapability(notificationstore.CapabilityReadNotifications) {
		return notificationstore.Rejection{Category: notificationstore.RejectionForbiddenAction, Reason: "missing read_notifications capability"}
	}
	return nil
}

// applyClaim updates the notification row and appends the claimed event.
func applyClaim(ctx context.Context, tx pgx.Tx, id notificationstore.NotificationID, version int64, leaseID string, expiresAt time.Time, actorID string, now time.Time) error {
	attemptSeq, err := nextAttemptSeq(ctx, tx, id)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, claimUpdateSQL, id, version, leaseID, expiresAt, actorID, now); err != nil {
		return fmt.Errorf("claim update: %w", err)
	}
	if _, err := tx.Exec(ctx, appendClaimedSQL, id, attemptSeq, leaseID, actorID, expiresAt, now); err != nil {
		return fmt.Errorf("claim append: %w", err)
	}
	return nil
}

// appendAttempt inserts a delivery_attempts row for a transition.
func appendAttempt(ctx context.Context, tx pgx.Tx, id notificationstore.NotificationID, seq int64, d notificationstore.TransitionDecision, actorID, leaseID string, leaseExpiresAt *time.Time, deliveryResult *notificationstore.DeliveryResult, recordedAt time.Time) error {
	var httpStatus interface{}
	if d.HTTPStatus != nil {
		httpStatus = *d.HTTPStatus
	}
	var claimedAt interface{}
	if d.EventKind == notificationstore.EventKindClaimed {
		claimedAt = recordedAt
	}
	var configVersion interface{}
	if deliveryResult != nil && deliveryResult.ConfigVersion != nil {
		configVersion = *deliveryResult.ConfigVersion
	}
	_, err := tx.Exec(ctx, appendAttemptSQL, id, seq, d.EventKind, nullableString(string(d.ResultKind)), nullableString(string(d.OutcomeClass)),
		httpStatus, nullableString(d.ErrorCode), nullableString(d.Reason), actorID, leaseID, leaseExpiresAt, recordedAt, claimedAt, configVersion)
	if err != nil {
		return fmt.Errorf("append attempt: %w", err)
	}
	return nil
}

func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// updateNotification applies the state decision to the notification row.
func updateNotification(ctx context.Context, tx pgx.Tx, current notificationstore.Notification, d notificationstore.TransitionDecision, attemptCount int, newVersion int64, newCycleStart time.Time, actorID string, now time.Time) error {
	var deliveredAt, deadAt, replayedAt, nextAttemptAt interface{} = nil, nil, nil, nil
	if d.SetDeliveredAt {
		deliveredAt = now
	}
	if d.SetDeadAt {
		deadAt = now
	}
	if d.SetReplayedAt {
		replayedAt = now
	}
	if d.SetNextAttemptAt != nil {
		nextAttemptAt = *d.SetNextAttemptAt
	}
	var lastOutcome, lastError interface{}
	if !d.ClearLastOutcome {
		if d.LastOutcomeClass != "" {
			lastOutcome = d.LastOutcomeClass
		}
		if d.LastErrorCode != "" {
			lastError = d.LastErrorCode
		}
	}
	leaseID := current.LeaseID
	leaseExpiresAt := current.LeaseExpiresAt
	leaseActorID := current.LeaseActorID
	if d.ClearLease {
		leaseID = ""
		leaseExpiresAt = nil
		leaseActorID = ""
	}

	ct, err := tx.Exec(ctx, transitionUpdateSQL,
		d.NewState,
		newVersion,
		attemptCount,
		current.ReplayCount+boolInt(d.SetReplayedAt),
		newCycleStart,
		deliveredAt,
		deadAt,
		d.DeadReason,
		replayedAt,
		actorID,
		d.ReplayReason,
		nextAttemptAt,
		lastOutcome,
		lastError,
		leaseID,
		leaseExpiresAt,
		leaseActorID,
		now,
		current.ID,
		current.Version,
	)
	if err != nil {
		return fmt.Errorf("transition update: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return errNoRowsAffected
	}
	return nil
}

// nextAttemptCount returns the new attempt count or an invariant-violation.
func nextAttemptCount(current int, delta int) (int, error) {
	if delta == -1 {
		return 0, nil
	}
	if delta < 0 {
		return current, notificationstore.Rejection{
			Category: notificationstore.RejectionInvariantViolation,
			Reason:   "negative attempt count delta",
		}
	}
	if current > (1<<31)-1-delta {
		return current, notificationstore.Rejection{
			Category: notificationstore.RejectionInvariantViolation,
			Reason:   "attempt_count integer overflow",
		}
	}
	return current + delta, nil
}

// nextAttemptSeq returns the next monotonic sequence number for a notification.
func nextAttemptSeq(ctx context.Context, tx pgx.Tx, id notificationstore.NotificationID) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, nextAttemptSeqSQL, id).Scan(&seq); err != nil {
		return 0, fmt.Errorf("next attempt seq: %w", err)
	}
	return seq, nil
}

func generateLeaseID() string {
	return "lease_" + generateID()
}

func generateID() string {
	// Use a short timestamp-free random string; collision risk is negligible
	// and the DB unique constraints catch any pathological case.
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("generate id: %v", err))
	}
	return fmt.Sprintf("%x", b)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// commitFailure maps a commit error to a stable rejection.
func commitFailure(err error) error {
	category := notificationstore.RejectionCommitOutcomeUnknown
	var pgErr *pgconn.PgError
	if errors.Is(err, pgx.ErrTxCommitRollback) || (errors.As(err, &pgErr) && pgErr.Code != "57P01" && pgErr.Code != "57P02" && pgErr.Code != "57P03" && pgErr.Code != "40003") {
		category = notificationstore.RejectionCommitRolledBack
	}
	return notificationstore.Rejection{
		Category: category,
		Reason:   "database commit did not complete normally",
	}
}

func normalizePageLimit(limit int) (int, error) {
	if limit == 0 {
		return notificationstore.ListPageDefault, nil
	}
	if limit < notificationstore.ListPageMin || limit > notificationstore.ListPageMax {
		return 0, notificationstore.Rejection{Category: notificationstore.RejectionInvalidPageLimit, Reason: "page limit out of range"}
	}
	return limit, nil
}

var errNoRowsAffected = errors.New("no rows affected")
