// Package postgres implements the vendorregistry.Repository interface on PostgreSQL.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

// Repository implements vendorregistry.Repository.
type Repository struct {
	pool   *pgxpool.Pool
	signer *cursorSigner
}

// New builds a PostgreSQL-backed Vendor Registry repository.
func New(pool *pgxpool.Pool) vendorregistry.Repository {
	return &Repository{pool: pool, signer: newCursorSigner()}
}

// RegisterVendor creates a new vendor with an initial endpoint version.
func (r *Repository) RegisterVendor(ctx context.Context, vendor vendorregistry.VendorRecord, version vendorregistry.EndpointVersion, receipt vendorregistry.AdminCommandReceipt, audit vendorregistry.AdminAuditEvent) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return confirmedRollback("begin register", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle, record_revision, current_config_version, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, vendor.VendorID, vendor.OwningScope, vendor.Lifecycle, vendor.RecordRevision, vendor.CurrentConfigVersion, vendor.CreatedAt); err != nil {
		return confirmedRollback("insert vendor", mapError(err))
	}

	if err := r.insertEndpointVersion(ctx, tx, version); err != nil {
		return confirmedRollback("insert endpoint version", err)
	}
	if err := r.insertReceipt(ctx, tx, receipt); err != nil {
		return confirmedRollback("insert receipt", err)
	}
	if err := r.insertAuditEvent(ctx, tx, audit); err != nil {
		return confirmedRollback("insert audit", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return commitOutcomeUnknown("commit register", err)
	}
	return nil
}

// UpdateVersion appends a new endpoint version and updates the vendor pointer.
func (r *Repository) UpdateVersion(ctx context.Context, vendorID string, expectedRevision int64, version vendorregistry.EndpointVersion, receipt vendorregistry.AdminCommandReceipt, audit vendorregistry.AdminAuditEvent) error {
	return r.appendVersionCommand(ctx, vendorID, expectedRevision, version, receipt, audit, vendorregistry.OpUpdateVersion)
}

// Activate transitions draft to active.
func (r *Repository) Activate(ctx context.Context, vendorID string, expectedRevision int64, receipt vendorregistry.AdminCommandReceipt, audit vendorregistry.AdminAuditEvent) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return confirmedRollback("begin activate", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lifecycle string
	var recordRevision int64
	err = tx.QueryRow(ctx, `
		UPDATE vendors
		SET lifecycle = $2, record_revision = record_revision + 1, activated_at = now()
		WHERE vendor_id = $1 AND record_revision = $3 AND lifecycle = 'draft'
		RETURNING lifecycle, record_revision
	`, vendorID, vendorregistry.LifecycleActive, expectedRevision).Scan(&lifecycle, &recordRevision)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
		}
		return confirmedRollback("activate update", err)
	}
	if err := r.insertReceipt(ctx, tx, receipt); err != nil {
		return confirmedRollback("insert activate receipt", err)
	}
	if err := r.insertAuditEvent(ctx, tx, audit); err != nil {
		return confirmedRollback("insert activate audit", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return commitOutcomeUnknown("commit activate", err)
	}
	return nil
}

// Disable transitions to disabled.
func (r *Repository) Disable(ctx context.Context, vendorID string, expectedRevision int64, reason string, receipt vendorregistry.AdminCommandReceipt, audit vendorregistry.AdminAuditEvent) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return confirmedRollback("begin disable", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lifecycle string
	var recordRevision int64
	err = tx.QueryRow(ctx, `
		UPDATE vendors
		SET lifecycle = $2, record_revision = record_revision + 1, disabled_at = now(), disabled_reason = $4
		WHERE vendor_id = $1 AND record_revision = $3 AND lifecycle != 'disabled'
		RETURNING lifecycle, record_revision
	`, vendorID, vendorregistry.LifecycleDisabled, expectedRevision, reason).Scan(&lifecycle, &recordRevision)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
		}
		return confirmedRollback("disable update", err)
	}
	if err := r.insertReceipt(ctx, tx, receipt); err != nil {
		return confirmedRollback("insert disable receipt", err)
	}
	if err := r.insertAuditEvent(ctx, tx, audit); err != nil {
		return confirmedRollback("insert disable audit", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return commitOutcomeUnknown("commit disable", err)
	}
	return nil
}

// RotateCredentialRef appends a new endpoint version with a new credential ref.
func (r *Repository) RotateCredentialRef(ctx context.Context, vendorID string, expectedRevision int64, version vendorregistry.EndpointVersion, receipt vendorregistry.AdminCommandReceipt, audit vendorregistry.AdminAuditEvent) error {
	return r.appendVersionCommand(ctx, vendorID, expectedRevision, version, receipt, audit, vendorregistry.OpRotateCredentialRef)
}

func (r *Repository) appendVersionCommand(ctx context.Context, vendorID string, expectedRevision int64, version vendorregistry.EndpointVersion, receipt vendorregistry.AdminCommandReceipt, audit vendorregistry.AdminAuditEvent, op string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return confirmedRollback("begin "+op, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var currentConfigVersion int64
	var recordRevision int64
	err = tx.QueryRow(ctx, `
		UPDATE vendors
		SET current_config_version = $2, record_revision = record_revision + 1
		WHERE vendor_id = $1 AND record_revision = $3
		RETURNING current_config_version, record_revision
	`, vendorID, version.ConfigVersion, expectedRevision).Scan(&currentConfigVersion, &recordRevision)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
		}
		return confirmedRollback(op+" update", err)
	}
	if currentConfigVersion != version.ConfigVersion {
		return confirmedRollback(op+" invariant", errors.New("current config version mismatch"))
	}

	if err := r.insertEndpointVersion(ctx, tx, version); err != nil {
		return confirmedRollback("insert "+op+" endpoint version", err)
	}
	if err := r.insertReceipt(ctx, tx, receipt); err != nil {
		return confirmedRollback("insert "+op+" receipt", err)
	}
	if err := r.insertAuditEvent(ctx, tx, audit); err != nil {
		return confirmedRollback("insert "+op+" audit", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return commitOutcomeUnknown("commit "+op, err)
	}
	return nil
}

// GetVendor returns the vendor record.
func (r *Repository) GetVendor(ctx context.Context, vendorID string) (vendorregistry.VendorRecord, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT vendor_id, owning_scope, lifecycle, record_revision, current_config_version, created_at, activated_at, disabled_at, disabled_reason
		FROM vendors
		WHERE vendor_id = $1
	`, vendorID)
	var v vendorregistry.VendorRecord
	var activatedAt, disabledAt *time.Time
	var disabledReason *string
	err := row.Scan(&v.VendorID, &v.OwningScope, &v.Lifecycle, &v.RecordRevision, &v.CurrentConfigVersion, &v.CreatedAt, &activatedAt, &disabledAt, &disabledReason)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.VendorRecord{}, vendorregistry.ReadError{Code: "VENDOR_NOT_FOUND"}
		}
		return vendorregistry.VendorRecord{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	v.ActivatedAt = activatedAt
	v.DisabledAt = disabledAt
	if disabledReason != nil {
		v.DisabledReason = *disabledReason
	}
	return v, nil
}

// GetEndpointVersion returns a specific endpoint version.
func (r *Repository) GetEndpointVersion(ctx context.Context, vendorID string, configVersion int64) (vendorregistry.EndpointVersion, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port, transport_kind,
		       endpoint_policy, transport_auth_headers, outbound_idempotency_mapping,
		       auth_strategy, response_policy, credential_ref_scheme, credential_ref_handle, credential_ref_version, created_by_actor, created_at
		FROM endpoint_versions
		WHERE vendor_id = $1 AND config_version = $2
	`, vendorID, configVersion)
	return r.scanEndpointVersion(row)
}

// ListActiveEndpointVersions returns the current immutable endpoint version for
// every active vendor so a candidate configuration generation can be checked
// before publication.
func (r *Repository) ListActiveEndpointVersions(ctx context.Context) ([]vendorregistry.EndpointVersion, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT e.vendor_id, e.config_version, e.config_schema_version, e.canonical_url, e.method, e.hostname, e.port, e.transport_kind,
		       e.endpoint_policy, e.transport_auth_headers, e.outbound_idempotency_mapping,
		       e.auth_strategy, e.response_policy, e.credential_ref_scheme, e.credential_ref_handle, e.credential_ref_version, e.created_by_actor, e.created_at
		FROM vendors v
		JOIN endpoint_versions e ON e.vendor_id=v.vendor_id AND e.config_version=v.current_config_version
		WHERE v.lifecycle='active'
		ORDER BY e.vendor_id`)
	if err != nil {
		return nil, fmt.Errorf("list active endpoint versions: %w", err)
	}
	defer rows.Close()
	versions := make([]vendorregistry.EndpointVersion, 0)
	for rows.Next() {
		version, err := r.scanEndpointVersion(rows)
		if err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list active endpoint versions: %w", err)
	}
	return versions, nil
}

// FindReceipt returns an existing receipt by actor+idempotency key.
func (r *Repository) FindReceipt(ctx context.Context, actorID, idempotencyKey string) (vendorregistry.AdminCommandReceipt, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT receipt_id, actor_id, idempotency_key, command_fingerprint_hash, result, recorded_at
		FROM admin_command_receipts
		WHERE actor_id = $1 AND idempotency_key = $2
	`, actorID, idempotencyKey)
	var receipt vendorregistry.AdminCommandReceipt
	var resultJSON []byte
	err := row.Scan(&receipt.ReceiptID, &receipt.ActorID, &receipt.IdempotencyKey, &receipt.CommandFingerprint, &resultJSON, &receipt.RecordedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.AdminCommandReceipt{}, vendorregistry.ReadError{Code: "VENDOR_NOT_FOUND"}
		}
		return vendorregistry.AdminCommandReceipt{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	if err := json.Unmarshal(resultJSON, &receipt.SafeResult); err != nil {
		return vendorregistry.AdminCommandReceipt{}, fmt.Errorf("unmarshal receipt result: %w", err)
	}
	return receipt, nil
}

// ListVendors returns an authorized vendor page.
func (r *Repository) ListVendors(ctx context.Context, filter vendorregistry.ScopeFilter, cursor string, limit int) (vendorregistry.Page[vendorregistry.VendorListItem], error) {
	var lastCreatedAt time.Time
	var lastVendorID string
	if cursor != "" {
		env, err := r.signer.verify(cursor)
		if err != nil || env.Operation != "list_vendors" || env.Limit != limit || !cursorMatchesFilter(env, filter) {
			return vendorregistry.Page[vendorregistry.VendorListItem]{}, vendorregistry.ReadError{Code: "INVALID_CURSOR", Err: err}
		}
		lastCreatedAt, err = time.Parse(time.RFC3339Nano, env.LastCreatedAt)
		if err != nil || env.LastVendorID == "" {
			return vendorregistry.Page[vendorregistry.VendorListItem]{}, vendorregistry.ReadError{Code: "INVALID_CURSOR", Err: errors.New("cursor position invalid")}
		}
		lastVendorID = env.LastVendorID
	}

	args := []any{lastCreatedAt, lastVendorID}
	where := "WHERE (created_at, vendor_id) > ($1, $2)"
	if filter.Kind == "owning_scopes" && len(filter.OwningScopes) > 0 {
		args = append(args, filter.OwningScopes)
		where += " AND owning_scope = ANY($" + fmt.Sprint(len(args)) + ")"
	} else if filter.Kind == "vendor_ids" && len(filter.VendorIDs) > 0 {
		args = append(args, filter.VendorIDs)
		where += " AND vendor_id = ANY($" + fmt.Sprint(len(args)) + ")"
	}
	args = append(args, limit+1)
	query := fmt.Sprintf(`
		SELECT vendor_id, owning_scope, lifecycle, record_revision, current_config_version, created_at
		FROM vendors
		%s
		ORDER BY created_at ASC, vendor_id ASC
		LIMIT $%d
	`, where, len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return vendorregistry.Page[vendorregistry.VendorListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	defer rows.Close()

	var items []vendorregistry.VendorListItem
	for rows.Next() {
		var it vendorregistry.VendorListItem
		if err := rows.Scan(&it.VendorID, &it.OwningScope, &it.Lifecycle, &it.RecordRevision, &it.CurrentConfigVersion, &it.CreatedAt); err != nil {
			return vendorregistry.Page[vendorregistry.VendorListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return vendorregistry.Page[vendorregistry.VendorListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}

	var nextCursor string
	if len(items) > limit {
		last := items[limit-1]
		items = items[:limit]
		kind, vendorIDs, owningScopes := cursorScope(filter)
		nextCursor, err = r.signer.sign(cursorEnvelope{Operation: "list_vendors", ScopeKind: kind, VendorIDs: vendorIDs, OwningScopes: owningScopes, Limit: limit, LastCreatedAt: last.CreatedAt.Format(time.RFC3339Nano), LastVendorID: last.VendorID})
		if err != nil {
			return vendorregistry.Page[vendorregistry.VendorListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
	}
	return vendorregistry.Page[vendorregistry.VendorListItem]{Items: items, NextCursor: nextCursor}, nil
}

// ListEndpointVersions returns a historical version page.
func (r *Repository) ListEndpointVersions(ctx context.Context, vendorID string, cursor string, limit int) (vendorregistry.Page[vendorregistry.EndpointVersionListItem], int64, error) {
	var snapshotCap, lastConfigVersion int64
	if cursor != "" {
		env, err := r.signer.verify(cursor)
		if err != nil || env.Operation != "list_endpoint_versions" || env.VendorID != vendorID || env.Limit != limit || env.SnapshotCap < 1 || env.LastConfigVersion < 1 || env.LastConfigVersion > env.SnapshotCap {
			return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "INVALID_CURSOR", Err: err}
		}
		snapshotCap = env.SnapshotCap
		lastConfigVersion = env.LastConfigVersion
	}

	vendor, err := r.GetVendor(ctx, vendorID)
	if err != nil {
		if errors.Is(err, vendorregistry.ReadError{Code: "VENDOR_NOT_FOUND"}) {
			return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, err
		}
		return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	if cursor == "" {
		snapshotCap = vendor.CurrentConfigVersion
	} else if snapshotCap > vendor.CurrentConfigVersion {
		return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "INVALID_CURSOR", Err: errors.New("cursor snapshot cap invalid")}
	}

	rows, err := r.pool.Query(ctx, `
		SELECT vendor_id, config_version, config_schema_version, canonical_url, method, transport_kind,
		       auth_strategy, response_policy, credential_ref_scheme, credential_ref_version, created_at, created_by_actor
		FROM endpoint_versions
		WHERE vendor_id = $1 AND config_version <= $2 AND config_version > $3
		ORDER BY config_version ASC
		LIMIT $4
	`, vendorID, snapshotCap, lastConfigVersion, limit+1)
	if err != nil {
		return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	defer rows.Close()

	var items []vendorregistry.EndpointVersionListItem
	for rows.Next() {
		var it vendorregistry.EndpointVersionListItem
		var credentialScheme, credentialVersion pgtype.Text
		if err := rows.Scan(&it.VendorID, &it.ConfigVersion, &it.ConfigSchemaVersion, &it.CanonicalURL, &it.Method, &it.TransportKind,
			&it.AuthStrategy, &it.ResponsePolicy, &credentialScheme, &credentialVersion, &it.CreatedAt, &it.CreatedByActor); err != nil {
			return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
		if it.AuthStrategy == "none" {
			if credentialScheme.Valid || credentialVersion.Valid {
				return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: errors.New("auth none has credential descriptor")}
			}
		} else if credentialScheme.Valid {
			it.CredentialDescriptor = &vendorregistry.CredentialDescriptor{Scheme: credentialScheme.String}
			if credentialVersion.Valid {
				it.CredentialDescriptor.ReferenceVersion = credentialVersion.String
			}
		} else if credentialVersion.Valid || it.AuthStrategy == "bearer" {
			return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: errors.New("partial credential descriptor")}
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}

	var nextCursor string
	if len(items) > limit {
		last := items[limit-1]
		items = items[:limit]
		nextCursor, err = r.signer.sign(cursorEnvelope{Operation: "list_endpoint_versions", VendorID: vendorID, Limit: limit, SnapshotCap: snapshotCap, LastConfigVersion: last.ConfigVersion})
		if err != nil {
			return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{}, 0, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
	}
	return vendorregistry.Page[vendorregistry.EndpointVersionListItem]{Items: items, NextCursor: nextCursor}, snapshotCap, nil
}

// ListAdminAuditEvents returns an audit page.
func (r *Repository) ListAdminAuditEvents(ctx context.Context, filter vendorregistry.ScopeFilter, cursor string, limit int) (vendorregistry.Page[vendorregistry.AdminAuditListItem], error) {
	var snapshotCap, lastSeq int64
	var lastEventID string
	if cursor == "" {
		if err := r.pool.QueryRow(ctx, `SELECT COALESCE(MAX(audit_seq), 0) FROM admin_audit_events`).Scan(&snapshotCap); err != nil {
			return vendorregistry.Page[vendorregistry.AdminAuditListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
	} else {
		env, err := r.signer.verify(cursor)
		if err != nil || env.Operation != "list_admin_audit_events" || env.Limit != limit || !cursorMatchesFilter(env, filter) || env.SnapshotCap < 0 || env.LastAuditSeq < 1 || env.LastEventID == "" {
			return vendorregistry.Page[vendorregistry.AdminAuditListItem]{}, vendorregistry.ReadError{Code: "INVALID_CURSOR", Err: err}
		}
		snapshotCap, lastSeq, lastEventID = env.SnapshotCap, env.LastAuditSeq, env.LastEventID
	}

	args := []any{snapshotCap}
	where := "WHERE audit_seq <= $1"
	paramIdx := 1
	if cursor != "" {
		args = append(args, lastSeq, lastEventID)
		paramIdx += 2
		where += " AND (audit_seq, event_id) < ($" + fmt.Sprint(paramIdx-1) + ", $" + fmt.Sprint(paramIdx) + ")"
	}
	if filter.Kind == "owning_scopes" && len(filter.OwningScopes) > 0 {
		args = append(args, filter.OwningScopes)
		paramIdx++
		where += " AND owning_scope = ANY($" + fmt.Sprint(paramIdx) + ")"
	} else if filter.Kind == "vendor_ids" && len(filter.VendorIDs) > 0 {
		args = append(args, filter.VendorIDs)
		paramIdx++
		where += " AND vendor_id = ANY($" + fmt.Sprint(paramIdx) + ")"
	}
	args = append(args, limit+1)
	paramIdx++
	query := fmt.Sprintf(`
		SELECT event_id, audit_seq, vendor_id, actor_id, authorization_basis, operation, outcome,
		       expected_record_revision_before, record_revision_after, sanitized_request_digest, receipt_id, reject_reason, occurred_at
		FROM admin_audit_events
		%s
		ORDER BY audit_seq DESC, event_id DESC
		LIMIT $%d
	`, where, paramIdx)

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return vendorregistry.Page[vendorregistry.AdminAuditListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	defer rows.Close()

	var items []vendorregistry.AdminAuditListItem
	for rows.Next() {
		var it vendorregistry.AdminAuditListItem
		var expected, recordRevision *int64
		var receiptID, rejectReason *string
		if err := rows.Scan(&it.EventID, &it.AuditSeq, &it.VendorID, &it.ActorID, &it.AuthorizationBasis, &it.Operation, &it.Outcome,
			&expected, &recordRevision, &it.SanitizedRequestDigest, &receiptID, &rejectReason, &it.OccurredAt); err != nil {
			return vendorregistry.Page[vendorregistry.AdminAuditListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
		it.ExpectedRecordRevisionBefore = expected
		it.RecordRevisionAfter = recordRevision
		if receiptID != nil {
			it.ReceiptID = *receiptID
		}
		if rejectReason != nil {
			it.RejectReason = *rejectReason
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return vendorregistry.Page[vendorregistry.AdminAuditListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}

	var nextCursor string
	if len(items) > limit {
		last := items[limit-1]
		items = items[:limit]
		kind, vendorIDs, owningScopes := cursorScope(filter)
		nextCursor, err = r.signer.sign(cursorEnvelope{Operation: "list_admin_audit_events", ScopeKind: kind, VendorIDs: vendorIDs, OwningScopes: owningScopes, Limit: limit, SnapshotCap: snapshotCap, LastAuditSeq: last.AuditSeq, LastEventID: last.EventID})
		if err != nil {
			return vendorregistry.Page[vendorregistry.AdminAuditListItem]{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
		}
	}
	page := vendorregistry.Page[vendorregistry.AdminAuditListItem]{
		Items:      items,
		NextCursor: nextCursor,
	}
	if snapshotCap > 0 {
		page.SnapshotMaxSeq = &snapshotCap
	}
	return page, nil
}

// DescribeVendorState returns a summary.
func (r *Repository) DescribeVendorState(ctx context.Context, vendorID string) (vendorregistry.VendorStateSummary, error) {
	row := r.pool.QueryRow(ctx, `
		WITH v AS (
		    SELECT * FROM vendors WHERE vendor_id = $1
		)
		SELECT v.vendor_id, v.lifecycle, v.owning_scope, v.record_revision, v.current_config_version, v.created_at, v.activated_at, v.disabled_at, v.disabled_reason,
		       (SELECT COUNT(*) FROM endpoint_versions WHERE vendor_id = v.vendor_id) AS config_version_count,
		       (SELECT COUNT(*) FROM admin_audit_events WHERE vendor_id = v.vendor_id) AS audit_event_count
		FROM v
	`, vendorID)
	var s vendorregistry.VendorStateSummary
	var activatedAt, disabledAt *time.Time
	var disabledReason *string
	err := row.Scan(&s.VendorID, &s.Lifecycle, &s.OwningScope, &s.RecordRevision, &s.CurrentConfigVersion, &s.CreatedAt,
		&activatedAt, &disabledAt, &disabledReason, &s.ConfigVersionCount, &s.AuditEventCount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.VendorStateSummary{}, vendorregistry.ReadError{Code: "VENDOR_NOT_FOUND"}
		}
		return vendorregistry.VendorStateSummary{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	s.ActivatedAt = activatedAt
	s.DisabledAt = disabledAt
	if disabledReason != nil {
		s.DisabledReason = *disabledReason
	}
	return s, nil
}

// CountEndpointVersions returns the total number of endpoint versions.
func (r *Repository) CountEndpointVersions(ctx context.Context, vendorID string) (int64, error) {
	var count int64
	err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM endpoint_versions WHERE vendor_id = $1`, vendorID).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// CountAuditEvents returns the total number of audit events.
func (r *Repository) CountAuditEvents(ctx context.Context, vendorID string) (int64, error) {
	var count int64
	err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_audit_events WHERE vendor_id = $1`, vendorID).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// InsertAuditEvent persists a rejected audit event.
func (r *Repository) InsertAuditEvent(ctx context.Context, audit vendorregistry.AdminAuditEvent) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO admin_audit_events (
		    event_id, audit_seq, vendor_id, owning_scope, actor_id, authorization_basis, operation, outcome,
		    expected_record_revision_before, record_revision_after, sanitized_request_digest, receipt_id, reject_reason, occurred_at
		) VALUES (
		    gen_random_uuid(), nextval('admin_audit_events_audit_seq_seq'), $1, NULLIF($2, ''), $3, $4, $5, $6,
		    $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12
		)
	`, audit.VendorID, audit.OwningScope, audit.ActorID, audit.AuthorizationBasis, audit.Operation, audit.Outcome,
		audit.ExpectedRecordRevisionBefore, audit.RecordRevisionAfter, audit.SanitizedRequestDigest, audit.ReceiptID, audit.RejectReason, audit.OccurredAt)
	if err != nil {
		return fmt.Errorf("insert audit event: %w", err)
	}
	return nil
}

func (r *Repository) insertEndpointVersion(ctx context.Context, tx pgx.Tx, v vendorregistry.EndpointVersion) error {
	tahJSON, err := json.Marshal(v.TransportAuthHeaders)
	if err != nil {
		return fmt.Errorf("marshal transport_auth_headers: %w", err)
	}
	oidJSON, err := json.Marshal(v.OutboundIdempotencyMapping)
	if err != nil {
		return fmt.Errorf("marshal outbound_idempotency_mapping: %w", err)
	}
	policyJSON, err := json.Marshal(v.EndpointPolicy)
	if err != nil {
		return fmt.Errorf("marshal endpoint_policy: %w", err)
	}
	credentialScheme, credentialHandle, credentialVersion := credentialColumnValues(v.CredentialRef)
	if _, err := tx.Exec(ctx, `
		INSERT INTO endpoint_versions (
		    vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port, transport_kind,
		    endpoint_policy, transport_auth_headers, outbound_idempotency_mapping,
		    auth_strategy, response_policy, credential_ref_scheme, credential_ref_handle, credential_ref_version, created_by_actor, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
	`, v.VendorID, v.ConfigVersion, v.ConfigSchemaVersion, v.CanonicalURL, v.Method, v.Hostname, v.Port, v.TransportKind,
		policyJSON, tahJSON, oidJSON, v.AuthStrategy, v.ResponsePolicy, credentialScheme, credentialHandle, credentialVersion, v.CreatedByActor, v.CreatedAt); err != nil {
		return mapError(err)
	}
	return nil
}

func (r *Repository) insertReceipt(ctx context.Context, tx pgx.Tx, receipt vendorregistry.AdminCommandReceipt) error {
	resultJSON, err := json.Marshal(receipt.SafeResult)
	if err != nil {
		return fmt.Errorf("marshal receipt result: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_command_receipts (receipt_id, actor_id, idempotency_key, command_fingerprint_hash, result, recorded_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, receipt.ReceiptID, receipt.ActorID, receipt.IdempotencyKey, receipt.CommandFingerprint, resultJSON, receipt.RecordedAt); err != nil {
		return mapError(err)
	}
	return nil
}

func (r *Repository) insertAuditEvent(ctx context.Context, tx pgx.Tx, audit vendorregistry.AdminAuditEvent) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO admin_audit_events (
		    event_id, audit_seq, vendor_id, owning_scope, actor_id, authorization_basis, operation, outcome,
		    expected_record_revision_before, record_revision_after, sanitized_request_digest, receipt_id, reject_reason, occurred_at
		) VALUES (
		    gen_random_uuid(), nextval('admin_audit_events_audit_seq_seq'), $1, $2, $3, $4, $5, $6,
		    $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12
		)
	`, audit.VendorID, audit.OwningScope, audit.ActorID, audit.AuthorizationBasis, audit.Operation, audit.Outcome,
		audit.ExpectedRecordRevisionBefore, audit.RecordRevisionAfter, audit.SanitizedRequestDigest, audit.ReceiptID, audit.RejectReason, audit.OccurredAt)
	if err != nil {
		return fmt.Errorf("insert audit event: %w", err)
	}
	return nil
}

func (r *Repository) scanEndpointVersion(row pgx.Row) (vendorregistry.EndpointVersion, error) {
	var v vendorregistry.EndpointVersion
	var policyJSON, tahJSON, oidJSON []byte
	var credentialScheme, credentialHandle, credentialVersion pgtype.Text
	err := row.Scan(&v.VendorID, &v.ConfigVersion, &v.ConfigSchemaVersion, &v.CanonicalURL, &v.Method, &v.Hostname, &v.Port, &v.TransportKind,
		&policyJSON, &tahJSON, &oidJSON, &v.AuthStrategy, &v.ResponsePolicy, &credentialScheme, &credentialHandle, &credentialVersion, &v.CreatedByActor, &v.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return vendorregistry.EndpointVersion{}, vendorregistry.ReadError{Code: "VERSION_NOT_FOUND"}
		}
		return vendorregistry.EndpointVersion{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: err}
	}
	if credentialScheme.Valid && credentialHandle.Valid {
		v.CredentialRef = &vendorregistry.CredentialRef{Scheme: credentialScheme.String, OpaqueHandle: credentialHandle.String}
		if credentialVersion.Valid {
			v.CredentialRef.ReferenceVersion = credentialVersion.String
		}
	} else if credentialScheme.Valid || credentialHandle.Valid || credentialVersion.Valid {
		return vendorregistry.EndpointVersion{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: errors.New("partial credential reference")}
	}
	if (v.AuthStrategy == "none" && v.CredentialRef != nil) || (v.AuthStrategy == "bearer" && v.CredentialRef == nil) {
		return vendorregistry.EndpointVersion{}, vendorregistry.ReadError{Code: "VENDOR_INACTIVE_OR_UNKNOWN", Err: errors.New("credential reference does not match auth strategy")}
	}
	if err := json.Unmarshal(policyJSON, &v.EndpointPolicy); err != nil {
		return vendorregistry.EndpointVersion{}, fmt.Errorf("unmarshal endpoint_policy: %w", err)
	}
	if v.EndpointPolicy.AllowedRequestHeaderNames == nil {
		v.EndpointPolicy.AllowedRequestHeaderNames = []string{}
	}
	if v.EndpointPolicy.ForbiddenRequestHeaderNames == nil {
		v.EndpointPolicy.ForbiddenRequestHeaderNames = []string{}
	}
	if err := json.Unmarshal(tahJSON, &v.TransportAuthHeaders); err != nil {
		return vendorregistry.EndpointVersion{}, fmt.Errorf("unmarshal transport_auth_headers: %w", err)
	}
	if err := json.Unmarshal(oidJSON, &v.OutboundIdempotencyMapping); err != nil {
		return vendorregistry.EndpointVersion{}, fmt.Errorf("unmarshal outbound_idempotency_mapping: %w", err)
	}
	if v.EndpointPolicy.CIDRException != nil && v.EndpointPolicy.CIDRException.CIDR == "" {
		v.EndpointPolicy.CIDRException = nil
	}
	if v.EndpointPolicy.CIDRException != nil {
		v.CIDRException = v.EndpointPolicy.CIDRException
	}
	return v, nil
}

func credentialColumnValues(ref *vendorregistry.CredentialRef) (any, any, any) {
	if ref == nil {
		return nil, nil, nil
	}
	return ref.Scheme, ref.OpaqueHandle, ref.ReferenceVersion
}

func mapError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.Code == "23505" && pgErr.ConstraintName == "vendors_pkey" {
			return vendorregistry.AdminCommandError{Code: "VENDOR_ID_UNAVAILABLE"}
		}
	}
	if errors.Is(err, vendorregistry.AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}) {
		return err
	}
	return fmt.Errorf("repo: %w", err)
}

func confirmedRollback(label string, err error) error {
	var commandErr vendorregistry.AdminCommandError
	if errors.As(err, &commandErr) {
		return commandErr
	}
	return vendorregistry.AdminCommandError{Code: vendorregistry.ErrCommitRolledBack, Err: fmt.Errorf("%s: %w", label, err)}
}

func commitOutcomeUnknown(label string, err error) error {
	return vendorregistry.AdminCommandError{Code: vendorregistry.ErrCommitOutcomeUnknown, Err: fmt.Errorf("%s: %w", label, err)}
}
