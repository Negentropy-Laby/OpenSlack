// server is the Organization Graph PostgreSQL shadow service entry point.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
	graphpostgres "github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore/postgres"
)

const (
	requiredSchemaVersion = int64(2)
	maxScenarioList       = 10_000
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		logFailure(logger, "graph_service_config_failed", "CONFIG_INVALID")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startupCtx, cancelStartup := context.WithTimeout(ctx, 15*time.Second)
	defer cancelStartup()
	pool, err := pgxpool.New(startupCtx, cfg.DatabaseURL)
	if err != nil {
		logFailure(logger, "graph_service_database_pool_failed", "DATABASE_POOL_CREATE_FAILED")
		os.Exit(1)
	}
	defer pool.Close()
	if err := checkDatabaseReady(startupCtx, pool); err != nil {
		logFailure(logger, "graph_service_database_not_ready", "DATABASE_OR_SCHEMA_NOT_READY")
		os.Exit(1)
	}

	repository := graphpostgres.New(pool)
	store := &storeAdapter{store: repository, pool: pool}
	service, err := app.New(app.Options{
		Store:                store,
		CursorSecret:         cfg.QueryCursorSecret,
		PreviousCursorSecret: cfg.PreviousQueryCursorSecret,
		BuildSHA:             cfg.ServiceBuildSHA,
		CanaryRoutingEpoch:   cfg.CanaryRoutingEpoch,
		Logger:               logger,
	})
	if err != nil {
		logFailure(logger, "graph_service_composition_failed", "COMPOSITION_INVALID")
		os.Exit(1)
	}

	logger.Info(
		"graph_service_starting",
		"http_bind", cfg.HTTPBind,
		"network_mode", cfg.NetworkMode,
		"build_sha", cfg.ServiceBuildSHA,
	)
	if err := service.Run(ctx, cfg.HTTPBind, cfg.ShutdownDeadline); err != nil {
		logFailure(logger, "graph_service_stopped_with_error", "HTTP_SERVER_FAILED")
		os.Exit(1)
	}
	logger.Info("graph_service_stopped")
}

type storeAdapter struct {
	store graphstore.Store
	pool  *pgxpool.Pool
}

func (adapter *storeAdapter) CheckReady(ctx context.Context) error {
	return checkDatabaseReady(ctx, adapter.pool)
}

func (adapter *storeAdapter) IngestSnapshot(
	ctx context.Context,
	command app.SnapshotCommand,
) (app.Receipt, error) {
	revision, err := adapter.resolveExpectedRevision(
		ctx,
		command.Snapshot.ScenarioInstanceID,
		command.IdempotencyKey,
		command.ExpectedCursor,
	)
	if err != nil {
		var storeFailure *app.StoreError
		if command.ExpectedCursor != nil &&
			errors.As(err, &storeFailure) &&
			storeFailure.Code == app.StoreNotFound {
			return app.Receipt{}, &app.StoreError{Code: app.StoreConflict, Cause: err}
		}
		return app.Receipt{}, err
	}
	receipt, err := adapter.store.Publish(ctx, graphstore.PublishInput{
		IdempotencyKey:     command.IdempotencyKey,
		RequestFingerprint: command.Fingerprint,
		ExpectedCursor:     command.ExpectedCursor,
		ExpectedRevision:   revision,
		Snapshot:           command.Snapshot,
	})
	if err != nil {
		return app.Receipt{}, mapStoreError(err)
	}
	return mapReceipt(receipt)
}

func (adapter *storeAdapter) IngestDelta(
	ctx context.Context,
	command app.DeltaCommand,
) (app.Receipt, error) {
	expected := command.ExpectedCursor
	revision, err := adapter.resolveExpectedRevision(
		ctx,
		command.TargetSnapshot.ScenarioInstanceID,
		command.IdempotencyKey,
		&expected,
	)
	if err != nil {
		return app.Receipt{}, err
	}
	delta := command.Delta
	receipt, err := adapter.store.Publish(ctx, graphstore.PublishInput{
		IdempotencyKey:     command.IdempotencyKey,
		RequestFingerprint: command.Fingerprint,
		ExpectedCursor:     &expected,
		ExpectedRevision:   revision,
		Snapshot:           command.TargetSnapshot,
		Delta:              &delta,
	})
	if err != nil {
		return app.Receipt{}, mapStoreError(err)
	}
	return mapReceipt(receipt)
}

func (adapter *storeAdapter) CurrentSnapshot(
	ctx context.Context,
	scenarioInstanceID string,
) (app.CurrentSnapshot, error) {
	head, stored, err := adapter.store.Current(ctx, scenarioInstanceID)
	if err != nil {
		return app.CurrentSnapshot{}, mapReadStoreError(err)
	}
	if head.Revision != stored.Revision ||
		head.Cursor != stored.Snapshot.Cursor ||
		head.SnapshotIntegrityHash != stored.Snapshot.IntegrityHash {
		return app.CurrentSnapshot{}, &app.StoreError{Code: app.StoreInternal}
	}
	return app.CurrentSnapshot{Snapshot: stored.Snapshot, Revision: head.Revision}, nil
}

func (adapter *storeAdapter) ListScenarios(ctx context.Context) ([]app.Scenario, error) {
	statistics, err := adapter.store.Statistics(ctx)
	if err != nil {
		return nil, mapReadStoreError(err)
	}
	if statistics.PublishedScenarios > maxScenarioList {
		return nil, &app.StoreError{Code: app.StoreTooLarge}
	}
	heads, err := adapter.store.ListHeads(ctx, maxScenarioList)
	if err != nil {
		return nil, mapReadStoreError(err)
	}
	if len(heads) == maxScenarioList {
		after, err := adapter.store.Statistics(ctx)
		if err != nil {
			return nil, mapReadStoreError(err)
		}
		if after.PublishedScenarios > int64(len(heads)) {
			return nil, &app.StoreError{Code: app.StoreTooLarge}
		}
	}
	result := make([]app.Scenario, 0, len(heads))
	for _, head := range heads {
		result = append(result, app.Scenario{
			ScenarioInstanceID:    head.ScenarioInstanceID,
			Cursor:                head.Cursor,
			SnapshotIntegrityHash: head.SnapshotIntegrityHash,
			Revision:              head.Revision,
			GeneratedAt:           head.GeneratedAt,
		})
	}
	return result, nil
}

func (adapter *storeAdapter) Metrics(ctx context.Context) (app.StoreMetrics, error) {
	statistics, err := adapter.store.Statistics(ctx)
	if err != nil {
		return app.StoreMetrics{}, mapReadStoreError(err)
	}
	return app.StoreMetrics{
		PublishedScenarios:       statistics.PublishedScenarios,
		PublishedHeadRevisionMax: statistics.PublishedHeadRevisionMax,
		ReconciliationPending:    statistics.ReconciliationPending,
	}, nil
}

func (adapter *storeAdapter) expectedRevision(
	ctx context.Context,
	scenarioInstanceID string,
	expectedCursor *string,
) (int64, error) {
	if expectedCursor == nil {
		return 0, nil
	}
	head, _, err := adapter.store.Current(ctx, scenarioInstanceID)
	if err != nil {
		return 0, mapReadStoreError(err)
	}
	// Do not reject a stale cursor here. Publish checks the idempotency receipt
	// before CAS, which lets a commit racing this pre-read return duplicate;
	// without a matching receipt the transactional CAS still returns conflict.
	return head.Revision, nil
}

func (adapter *storeAdapter) resolveExpectedRevision(
	ctx context.Context,
	scenarioInstanceID string,
	idempotencyKey string,
	expectedCursor *string,
) (int64, error) {
	receipt, err := adapter.store.ReadReceiptByKey(ctx, idempotencyKey)
	if err == nil {
		if receipt.Revision < 1 {
			return 0, &app.StoreError{Code: app.StoreInternal}
		}
		if expectedCursor == nil {
			return 0, nil
		}
		revision := receipt.Revision - 1
		if revision < 1 {
			revision = 1
		}
		return revision, nil
	}
	if !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		return 0, mapReadStoreError(err)
	}
	return adapter.expectedRevision(ctx, scenarioInstanceID, expectedCursor)
}

func checkDatabaseReady(ctx context.Context, pool *pgxpool.Pool) error {
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("database ping: %w", err)
	}
	rows, err := pool.Query(ctx, `SELECT version, dirty FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	defer rows.Close()
	count := 0
	var version int64
	var dirty bool
	for rows.Next() {
		count++
		if count > 1 {
			return fmt.Errorf("schema_migrations contains multiple rows")
		}
		if err := rows.Scan(&version, &dirty); err != nil {
			return fmt.Errorf("scan schema_migrations: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate schema_migrations: %w", err)
	}
	if count != 1 || version != requiredSchemaVersion || dirty {
		return fmt.Errorf(
			"schema_migrations must be version=%d dirty=false; found rows=%d version=%d dirty=%t",
			requiredSchemaVersion,
			count,
			version,
			dirty,
		)
	}
	return checkRequiredSchema(ctx, pool)
}

type requiredSchemaField struct {
	name string
	oid  uint32
}

type requiredSchemaRelation struct {
	name   string
	query  string
	fields []requiredSchemaField
}

var requiredSchemaRelations = []requiredSchemaRelation{
	{
		name:   "graph_snapshots",
		query:  `SELECT scenario_instance_id, cursor, revision, canonical_bytes, integrity_hash, projector_version, generated_at, stored_at FROM graph_snapshots LIMIT 0`,
		fields: []requiredSchemaField{{"scenario_instance_id", pgtype.TextOID}, {"cursor", pgtype.TextOID}, {"revision", pgtype.Int8OID}, {"canonical_bytes", pgtype.ByteaOID}, {"integrity_hash", pgtype.TextOID}, {"projector_version", pgtype.TextOID}, {"generated_at", pgtype.TextOID}, {"stored_at", pgtype.TimestamptzOID}},
	},
	{
		name:   "graph_deltas",
		query:  `SELECT scenario_instance_id, from_cursor, to_cursor, revision, canonical_bytes, integrity_hash, generated_at, stored_at FROM graph_deltas LIMIT 0`,
		fields: []requiredSchemaField{{"scenario_instance_id", pgtype.TextOID}, {"from_cursor", pgtype.TextOID}, {"to_cursor", pgtype.TextOID}, {"revision", pgtype.Int8OID}, {"canonical_bytes", pgtype.ByteaOID}, {"integrity_hash", pgtype.TextOID}, {"generated_at", pgtype.TextOID}, {"stored_at", pgtype.TimestamptzOID}},
	},
	{
		name:   "graph_heads",
		query:  `SELECT scenario_instance_id, cursor, revision, snapshot_integrity_hash, updated_at FROM graph_heads LIMIT 0`,
		fields: []requiredSchemaField{{"scenario_instance_id", pgtype.TextOID}, {"cursor", pgtype.TextOID}, {"revision", pgtype.Int8OID}, {"snapshot_integrity_hash", pgtype.TextOID}, {"updated_at", pgtype.TimestamptzOID}},
	},
	{
		name:   "graph_ingest_receipts",
		query:  `SELECT receipt_id, operation, status, scenario_instance_id, idempotency_key, request_fingerprint, previous_cursor, cursor, revision, snapshot_integrity_hash, delta_integrity_hash, committed_at, reconciliation_token, recorded_at FROM graph_ingest_receipts LIMIT 0`,
		fields: []requiredSchemaField{{"receipt_id", pgtype.TextOID}, {"operation", pgtype.TextOID}, {"status", pgtype.TextOID}, {"scenario_instance_id", pgtype.TextOID}, {"idempotency_key", pgtype.TextOID}, {"request_fingerprint", pgtype.ByteaOID}, {"previous_cursor", pgtype.TextOID}, {"cursor", pgtype.TextOID}, {"revision", pgtype.Int8OID}, {"snapshot_integrity_hash", pgtype.TextOID}, {"delta_integrity_hash", pgtype.TextOID}, {"committed_at", pgtype.TimestamptzOID}, {"reconciliation_token", pgtype.TextOID}, {"recorded_at", pgtype.TimestamptzOID}},
	},
}

func checkRequiredSchema(ctx context.Context, pool *pgxpool.Pool) error {
	for _, relation := range requiredSchemaRelations {
		rows, err := pool.Query(ctx, relation.query)
		if err != nil {
			return fmt.Errorf("probe required relation %s: %w", relation.name, err)
		}
		fields := rows.FieldDescriptions()
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("probe required relation %s: %w", relation.name, err)
		}
		if len(fields) != len(relation.fields) {
			return fmt.Errorf("required relation %s has %d fields; expected %d", relation.name, len(fields), len(relation.fields))
		}
		for index, expected := range relation.fields {
			if fields[index].Name != expected.name || fields[index].DataTypeOID != expected.oid {
				return fmt.Errorf(
					"required relation %s field %d is %s/%d; expected %s/%d",
					relation.name,
					index,
					fields[index].Name,
					fields[index].DataTypeOID,
					expected.name,
					expected.oid,
				)
			}
		}
	}
	return nil
}

func mapStoreError(err error) error {
	var failure *graphstore.Error
	if !errors.As(err, &failure) {
		return &app.StoreError{Code: app.StoreInternal, Cause: err}
	}
	switch failure.Code {
	case graphstore.ErrorInvalidInput, graphstore.ErrorContentInvalid:
		return &app.StoreError{Code: app.StoreUnprocessable, Cause: err}
	case graphstore.ErrorCursorConflict:
		return &app.StoreError{Code: app.StoreConflict, Cause: err}
	case graphstore.ErrorIdempotencyConflict:
		return &app.StoreError{Code: app.StoreIdempotencyConflict, Cause: err}
	case graphstore.ErrorNotFound:
		return &app.StoreError{Code: app.StoreNotFound, Cause: err}
	case graphstore.ErrorDatabase:
		return &app.StoreError{Code: app.StoreUnavailable, Cause: err}
	case graphstore.ErrorCommitUnknown:
		return &app.StoreError{Code: app.StoreAmbiguous, Cause: err}
	default:
		return &app.StoreError{Code: app.StoreInternal, Cause: err}
	}
}

func mapReadStoreError(err error) error {
	if graphstore.IsCode(err, graphstore.ErrorContentInvalid) {
		return &app.StoreError{Code: app.StoreInternal, Cause: err}
	}
	return mapStoreError(err)
}

func mapReceipt(receipt graphstore.Receipt) (app.Receipt, error) {
	if receipt.Schema != graphstore.ReceiptSchema {
		return app.Receipt{}, &app.StoreError{Code: app.StoreInternal}
	}
	result := app.Receipt{
		Operation:             receipt.Operation,
		Status:                string(receipt.Status),
		IdempotencyKey:        receipt.IdempotencyKey,
		RequestFingerprint:    receipt.RequestFingerprint,
		ScenarioInstanceID:    receipt.ScenarioInstanceID,
		Cursor:                receipt.Cursor,
		Revision:              receipt.Revision,
		SnapshotIntegrityHash: receipt.SnapshotIntegrityHash,
		DeltaIntegrityHash:    cloneString(receipt.DeltaIntegrityHash),
		ReconciliationToken:   cloneString(receipt.ReconciliationToken),
	}
	if receipt.CommittedAt != nil {
		value := receipt.CommittedAt.UTC().Format(time.RFC3339Nano)
		result.CommittedAt = &value
	}
	return result, nil
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func logFailure(logger *slog.Logger, event, code string) {
	logger.Error(event, "failure_code", code)
}
