package postgres

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
)

const reconciliationTimeout = 5 * time.Second

const (
	idempotencyLockSalt int64 = 7277797366262101
	scenarioLockSalt    int64 = 7277797366262102
)

type Repository struct {
	pool              *pgxpool.Pool
	commitTransaction func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) graphstore.Store {
	return &Repository{pool: pool}
}

func (repository *Repository) Publish(
	ctx context.Context,
	input graphstore.PublishInput,
) (graphstore.Receipt, error) {
	prepared, err := graphstore.PreparePublish(input)
	if err != nil {
		return graphstore.Receipt{}, err
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return graphstore.Receipt{}, databaseFailure("begin publish", err)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()

	if err := lockPublishScope(
		ctx,
		transaction,
		prepared.Input.IdempotencyKey,
		prepared.Snapshot.ScenarioInstanceID,
	); err != nil {
		return graphstore.Receipt{}, err
	}

	existing, rawFingerprint, err := readReceiptRow(
		transaction.QueryRow(
			ctx,
			receiptSelectByKeySQL,
			prepared.Input.IdempotencyKey,
		),
	)
	switch {
	case err == nil:
		if subtle.ConstantTimeCompare(rawFingerprint, prepared.RequestFingerprint[:]) != 1 {
			return graphstore.Receipt{}, graphstore.Failure(
				graphstore.ErrorIdempotencyConflict,
				"idempotency key is bound to a different canonical request fingerprint",
				nil,
			)
		}
		if existing.Status == graphstore.ReceiptAccepted {
			existing.Status = graphstore.ReceiptDuplicate
		}
		return existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return graphstore.Receipt{}, databaseFailure("read ingest receipt", err)
	}

	actualCursor, actualRevision, actualIntegrity, err := readHeadForUpdate(
		ctx,
		transaction,
		prepared.Snapshot.ScenarioInstanceID,
	)
	if err != nil {
		return graphstore.Receipt{}, err
	}
	if !sameOptionalString(actualCursor, prepared.Input.ExpectedCursor) ||
		actualRevision != prepared.Input.ExpectedRevision {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCursorConflict,
			fmt.Sprintf(
				"expected cursor/revision %s/%d, found %s/%d",
				displayCursor(prepared.Input.ExpectedCursor),
				prepared.Input.ExpectedRevision,
				displayCursor(actualCursor),
				actualRevision,
			),
			nil,
		)
	}
	if actualCursor != nil && *actualCursor == prepared.Snapshot.Cursor {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCursorConflict,
			"published snapshot cursor must advance the current head",
			nil,
		)
	}

	if prepared.Delta != nil {
		if actualCursor == nil {
			return graphstore.Receipt{}, graphstore.Failure(
				graphstore.ErrorContentInvalid,
				"a delta requires a current parent snapshot",
				nil,
			)
		}
		parent, readErr := readSnapshotRow(
			transaction.QueryRow(
				ctx,
				snapshotSelectSQL,
				prepared.Snapshot.ScenarioInstanceID,
				*actualCursor,
			),
		)
		if readErr != nil {
			if errors.Is(readErr, pgx.ErrNoRows) {
				return graphstore.Receipt{}, graphstore.Failure(
					graphstore.ErrorContentInvalid,
					"current head does not resolve to a parent snapshot",
					readErr,
				)
			}
			return graphstore.Receipt{}, mapRowReadFailure("read current parent snapshot", readErr)
		}
		if parent.Snapshot.IntegrityHash != actualIntegrity {
			return graphstore.Receipt{}, graphstore.Failure(
				graphstore.ErrorContentInvalid,
				"current head integrity does not match its parent snapshot",
				nil,
			)
		}
		if err := graphstore.ValidateDeltaTransition(
			parent.Snapshot,
			prepared.Snapshot,
			*prepared.Delta,
		); err != nil {
			return graphstore.Receipt{}, err
		}
	}

	nextRevision := actualRevision + 1
	if _, err := transaction.Exec(
		ctx,
		snapshotInsertSQL,
		prepared.Snapshot.ScenarioInstanceID,
		prepared.Snapshot.Cursor,
		nextRevision,
		prepared.SnapshotBytes,
		prepared.Snapshot.IntegrityHash,
		prepared.Snapshot.ProjectorVersion,
		prepared.Snapshot.GeneratedAt,
	); err != nil {
		return graphstore.Receipt{}, mapWriteFailure("insert immutable snapshot", err)
	}

	var deltaIntegrityHash *string
	if prepared.Delta != nil {
		if _, err := transaction.Exec(
			ctx,
			deltaInsertSQL,
			prepared.Delta.ScenarioInstanceID,
			prepared.Delta.FromCursor,
			prepared.Delta.ToCursor,
			nextRevision,
			prepared.DeltaBytes,
			prepared.Delta.IntegrityHash,
			prepared.Delta.GeneratedAt,
		); err != nil {
			return graphstore.Receipt{}, mapWriteFailure("insert immutable delta", err)
		}
		value := prepared.Delta.IntegrityHash
		deltaIntegrityHash = &value
	}

	if err := moveHead(
		ctx,
		transaction,
		prepared,
		nextRevision,
	); err != nil {
		return graphstore.Receipt{}, err
	}

	receiptID, err := randomToken("graph-receipt")
	if err != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorDatabase,
			"generate receipt identity",
			err,
		)
	}
	var committedAt time.Time
	var recordedAt time.Time
	if err := transaction.QueryRow(
		ctx,
		receiptInsertAcceptedSQL,
		receiptID,
		prepared.Operation(),
		prepared.Snapshot.ScenarioInstanceID,
		prepared.Input.IdempotencyKey,
		prepared.RequestFingerprint[:],
		prepared.Input.ExpectedCursor,
		prepared.Snapshot.Cursor,
		nextRevision,
		prepared.Snapshot.IntegrityHash,
		deltaIntegrityHash,
	).Scan(&committedAt, &recordedAt); err != nil {
		return graphstore.Receipt{}, mapWriteFailure("insert accepted receipt", err)
	}

	receipt := graphstore.Receipt{
		Schema:                graphstore.ReceiptSchema,
		Operation:             prepared.Operation(),
		Status:                graphstore.ReceiptAccepted,
		IdempotencyKey:        prepared.Input.IdempotencyKey,
		RequestFingerprint:    prepared.FingerprintString(),
		ScenarioInstanceID:    prepared.Snapshot.ScenarioInstanceID,
		Cursor:                prepared.Snapshot.Cursor,
		Revision:              nextRevision,
		SnapshotIntegrityHash: prepared.Snapshot.IntegrityHash,
		DeltaIntegrityHash:    cloneString(deltaIntegrityHash),
		CommittedAt:           &committedAt,
		ReceiptID:             receiptID,
		PreviousCursor:        cloneString(prepared.Input.ExpectedCursor),
		RecordedAt:            recordedAt,
	}
	commitTransaction := repository.commitTransaction
	if commitTransaction == nil {
		commitTransaction = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commitTransaction(ctx, transaction); err != nil {
		return repository.resolveCommitOutcome(prepared, err)
	}
	return receipt, nil
}

func (repository *Repository) Current(
	ctx context.Context,
	scenarioInstanceID string,
) (graphstore.Head, graphstore.StoredSnapshot, error) {
	if err := graphstore.ValidateScenarioInstanceID(scenarioInstanceID); err != nil {
		return graphstore.Head{}, graphstore.StoredSnapshot{}, err
	}
	var head graphstore.Head
	var canonicalBytes []byte
	var snapshotRevision int64
	var storedAt time.Time
	err := repository.pool.QueryRow(ctx, currentSelectSQL, scenarioInstanceID).Scan(
		&head.ScenarioInstanceID,
		&head.Cursor,
		&head.Revision,
		&head.SnapshotIntegrityHash,
		&head.UpdatedAt,
		&canonicalBytes,
		&snapshotRevision,
		&storedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return graphstore.Head{}, graphstore.StoredSnapshot{}, graphstore.Failure(
			graphstore.ErrorNotFound,
			"current graph head not found",
			err,
		)
	}
	if err != nil {
		return graphstore.Head{}, graphstore.StoredSnapshot{}, databaseFailure("read current graph", err)
	}
	snapshot, err := graphstore.DecodeStoredSnapshot(
		canonicalBytes,
		head.ScenarioInstanceID,
		head.Cursor,
	)
	if err != nil {
		return graphstore.Head{}, graphstore.StoredSnapshot{}, err
	}
	if snapshotRevision != head.Revision ||
		snapshot.IntegrityHash != head.SnapshotIntegrityHash {
		return graphstore.Head{}, graphstore.StoredSnapshot{}, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"current head does not bind its stored snapshot revision and integrity",
			nil,
		)
	}
	head.GeneratedAt = snapshot.GeneratedAt
	return head, graphstore.StoredSnapshot{
		Snapshot:       snapshot,
		CanonicalBytes: append([]byte(nil), canonicalBytes...),
		Revision:       snapshotRevision,
		StoredAt:       storedAt,
	}, nil
}

func (repository *Repository) ListHeads(
	ctx context.Context,
	limit int,
) ([]graphstore.Head, error) {
	if err := graphstore.ValidateHeadListLimit(limit); err != nil {
		return nil, err
	}
	rows, err := repository.pool.Query(ctx, headListSQL, limit)
	if err != nil {
		return nil, databaseFailure("list graph heads", err)
	}
	defer rows.Close()

	result := make([]graphstore.Head, 0, limit)
	for rows.Next() {
		var head graphstore.Head
		var canonicalBytes []byte
		var snapshotRevision int64
		if err := rows.Scan(
			&head.ScenarioInstanceID,
			&head.Cursor,
			&head.Revision,
			&head.SnapshotIntegrityHash,
			&canonicalBytes,
			&snapshotRevision,
			&head.UpdatedAt,
		); err != nil {
			return nil, databaseFailure("scan graph head", err)
		}
		snapshot, err := graphstore.DecodeStoredSnapshot(
			canonicalBytes,
			head.ScenarioInstanceID,
			head.Cursor,
		)
		if err != nil {
			return nil, err
		}
		if snapshotRevision != head.Revision ||
			snapshot.IntegrityHash != head.SnapshotIntegrityHash {
			return nil, graphstore.Failure(
				graphstore.ErrorContentInvalid,
				"listed graph head does not bind its stored snapshot revision and integrity",
				nil,
			)
		}
		head.GeneratedAt = snapshot.GeneratedAt
		result = append(result, head)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("iterate graph heads", err)
	}
	return result, nil
}

func (repository *Repository) ReadSnapshot(
	ctx context.Context,
	scenarioInstanceID string,
	cursor string,
) (graphstore.StoredSnapshot, error) {
	if err := graphstore.ValidateScenarioInstanceID(scenarioInstanceID); err != nil {
		return graphstore.StoredSnapshot{}, err
	}
	if err := graphstore.ValidateCursor(cursor); err != nil {
		return graphstore.StoredSnapshot{}, err
	}
	value, err := readSnapshotRow(
		repository.pool.QueryRow(ctx, snapshotSelectSQL, scenarioInstanceID, cursor),
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return graphstore.StoredSnapshot{}, graphstore.Failure(
			graphstore.ErrorNotFound,
			"graph snapshot not found",
			err,
		)
	}
	if err != nil {
		return graphstore.StoredSnapshot{}, mapRowReadFailure("read graph snapshot", err)
	}
	return value, nil
}

func (repository *Repository) ReadDelta(
	ctx context.Context,
	scenarioInstanceID string,
	fromCursor string,
	toCursor string,
) (graphstore.StoredDelta, error) {
	if err := graphstore.ValidateScenarioInstanceID(scenarioInstanceID); err != nil {
		return graphstore.StoredDelta{}, err
	}
	if err := graphstore.ValidateCursor(fromCursor); err != nil {
		return graphstore.StoredDelta{}, err
	}
	if err := graphstore.ValidateCursor(toCursor); err != nil {
		return graphstore.StoredDelta{}, err
	}
	value, err := readDeltaRow(
		repository.pool.QueryRow(
			ctx,
			deltaSelectSQL,
			scenarioInstanceID,
			fromCursor,
			toCursor,
		),
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return graphstore.StoredDelta{}, graphstore.Failure(
			graphstore.ErrorNotFound,
			"graph delta not found",
			err,
		)
	}
	if err != nil {
		return graphstore.StoredDelta{}, mapRowReadFailure("read graph delta", err)
	}
	return value, nil
}

func (repository *Repository) ListSnapshots(
	ctx context.Context,
	scenarioInstanceID string,
	afterRevision int64,
	limit int,
) ([]graphstore.StoredSnapshot, error) {
	if err := graphstore.ValidateList(scenarioInstanceID, afterRevision, limit); err != nil {
		return nil, err
	}
	rows, err := repository.pool.Query(
		ctx,
		snapshotListSQL,
		scenarioInstanceID,
		afterRevision,
		limit,
	)
	if err != nil {
		return nil, databaseFailure("list graph snapshots", err)
	}
	defer rows.Close()
	result := make([]graphstore.StoredSnapshot, 0, limit)
	for rows.Next() {
		value, scanErr := readSnapshotRow(rows)
		if scanErr != nil {
			return nil, mapRowReadFailure("scan graph snapshot", scanErr)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("iterate graph snapshots", err)
	}
	return result, nil
}

func (repository *Repository) ListDeltas(
	ctx context.Context,
	scenarioInstanceID string,
	afterRevision int64,
	limit int,
) ([]graphstore.StoredDelta, error) {
	if err := graphstore.ValidateList(scenarioInstanceID, afterRevision, limit); err != nil {
		return nil, err
	}
	rows, err := repository.pool.Query(
		ctx,
		deltaListSQL,
		scenarioInstanceID,
		afterRevision,
		limit,
	)
	if err != nil {
		return nil, databaseFailure("list graph deltas", err)
	}
	defer rows.Close()
	result := make([]graphstore.StoredDelta, 0, limit)
	for rows.Next() {
		value, scanErr := readDeltaRow(rows)
		if scanErr != nil {
			return nil, mapRowReadFailure("scan graph delta", scanErr)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("iterate graph deltas", err)
	}
	return result, nil
}

func (repository *Repository) ReadReceipt(
	ctx context.Context,
	scenarioInstanceID string,
	idempotencyKey string,
) (graphstore.Receipt, error) {
	if err := graphstore.ValidateScenarioInstanceID(scenarioInstanceID); err != nil {
		return graphstore.Receipt{}, err
	}
	if err := graphstore.ValidateIdempotencyKey(idempotencyKey); err != nil {
		return graphstore.Receipt{}, err
	}
	receipt, _, err := readReceiptRow(
		repository.pool.QueryRow(ctx, receiptSelectScopedSQL, scenarioInstanceID, idempotencyKey),
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorNotFound,
			"graph ingest receipt not found",
			err,
		)
	}
	if err != nil {
		return graphstore.Receipt{}, mapRowReadFailure("read graph ingest receipt", err)
	}
	return receipt, nil
}

func (repository *Repository) ReadReceiptByKey(
	ctx context.Context,
	idempotencyKey string,
) (graphstore.Receipt, error) {
	if err := graphstore.ValidateIdempotencyKey(idempotencyKey); err != nil {
		return graphstore.Receipt{}, err
	}
	receipt, _, err := readReceiptRow(
		repository.pool.QueryRow(ctx, receiptSelectByKeySQL, idempotencyKey),
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorNotFound,
			"graph ingest receipt not found",
			err,
		)
	}
	if err != nil {
		return graphstore.Receipt{}, mapRowReadFailure("read graph ingest receipt by key", err)
	}
	return receipt, nil
}

func (repository *Repository) Statistics(ctx context.Context) (graphstore.Statistics, error) {
	var result graphstore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSelectSQL).Scan(
		&result.PublishedScenarios,
		&result.PublishedHeadRevisionMax,
		&result.ReconciliationPending,
	); err != nil {
		return graphstore.Statistics{}, databaseFailure("read graph store statistics", err)
	}
	return result, nil
}

func (repository *Repository) resolveCommitOutcome(
	prepared graphstore.PreparedPublish,
	commitErr error,
) (graphstore.Receipt, error) {
	reconcileCtx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()

	existing, err := repository.ReadReceiptByKey(reconcileCtx, prepared.Input.IdempotencyKey)
	if err == nil {
		raw, decodeErr := decodeFingerprint(existing.RequestFingerprint)
		if decodeErr == nil &&
			subtle.ConstantTimeCompare(raw, prepared.RequestFingerprint[:]) == 1 {
			return existing, nil
		}
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorIdempotencyConflict,
			"commit reconciliation found a different receipt fingerprint",
			commitErr,
		)
	}
	if !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"commit outcome could not be read or reconciled",
			errors.Join(commitErr, err),
		)
	}

	token, tokenErr := randomToken("graph-reconcile")
	if tokenErr != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"generate reconciliation token",
			errors.Join(commitErr, tokenErr),
		)
	}
	receiptID, receiptErr := randomToken("graph-receipt")
	if receiptErr != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"generate reconciliation receipt identity",
			errors.Join(commitErr, receiptErr),
		)
	}

	transaction, beginErr := repository.pool.Begin(reconcileCtx)
	if beginErr != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"begin reconciliation receipt",
			errors.Join(commitErr, beginErr),
		)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if lockErr := lockPublishScope(
		reconcileCtx,
		transaction,
		prepared.Input.IdempotencyKey,
		prepared.Snapshot.ScenarioInstanceID,
	); lockErr != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"lock reconciliation receipt",
			errors.Join(commitErr, lockErr),
		)
	}
	_, insertErr := transaction.Exec(
		reconcileCtx,
		receiptInsertReconciliationSQL,
		receiptID,
		prepared.Operation(),
		prepared.Snapshot.ScenarioInstanceID,
		prepared.Input.IdempotencyKey,
		prepared.RequestFingerprint[:],
		prepared.Input.ExpectedCursor,
		prepared.Snapshot.Cursor,
		prepared.Input.ExpectedRevision+1,
		prepared.Snapshot.IntegrityHash,
		optionalDeltaIntegrity(prepared.Delta),
		token,
	)
	if insertErr != nil && !isUniqueViolation(insertErr) {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"persist reconciliation-required receipt",
			errors.Join(commitErr, insertErr),
		)
	}
	persisted, rawFingerprint, readErr := readReceiptRow(
		transaction.QueryRow(
			reconcileCtx,
			receiptSelectByKeySQL,
			prepared.Input.IdempotencyKey,
		),
	)
	if readErr != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"read reconciliation-required receipt",
			errors.Join(commitErr, readErr),
		)
	}
	if subtle.ConstantTimeCompare(rawFingerprint, prepared.RequestFingerprint[:]) != 1 {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorIdempotencyConflict,
			"reconciliation receipt has a different fingerprint",
			commitErr,
		)
	}
	if commitReconciliationErr := transaction.Commit(reconcileCtx); commitReconciliationErr != nil {
		return graphstore.Receipt{}, graphstore.Failure(
			graphstore.ErrorCommitUnknown,
			"commit reconciliation-required receipt",
			errors.Join(commitErr, commitReconciliationErr),
		)
	}
	return persisted, nil
}

func readHeadForUpdate(
	ctx context.Context,
	transaction pgx.Tx,
	scenarioInstanceID string,
) (*string, int64, string, error) {
	var cursor string
	var revision int64
	var integrity string
	err := transaction.QueryRow(
		ctx,
		headForUpdateSQL,
		scenarioInstanceID,
	).Scan(&cursor, &revision, &integrity)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, "", nil
	}
	if err != nil {
		return nil, 0, "", databaseFailure("lock current graph head", err)
	}
	return &cursor, revision, integrity, nil
}

func lockPublishScope(
	ctx context.Context,
	transaction pgx.Tx,
	idempotencyKey string,
	scenarioInstanceID string,
) error {
	for _, lock := range []struct {
		value     string
		salt      int64
		operation string
	}{
		{value: idempotencyKey, salt: idempotencyLockSalt, operation: "lock graph idempotency key"},
		{value: scenarioInstanceID, salt: scenarioLockSalt, operation: "lock graph scenario"},
	} {
		if _, err := transaction.Exec(
			ctx,
			`SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
			lock.value,
			lock.salt,
		); err != nil {
			return databaseFailure(lock.operation, err)
		}
	}
	return nil
}

func moveHead(
	ctx context.Context,
	transaction pgx.Tx,
	prepared graphstore.PreparedPublish,
	nextRevision int64,
) error {
	var commandTag pgconn.CommandTag
	var err error
	if prepared.Input.ExpectedCursor == nil {
		commandTag, err = transaction.Exec(
			ctx,
			headInsertSQL,
			prepared.Snapshot.ScenarioInstanceID,
			prepared.Snapshot.Cursor,
			nextRevision,
			prepared.Snapshot.IntegrityHash,
		)
	} else {
		commandTag, err = transaction.Exec(
			ctx,
			headUpdateCASSQL,
			prepared.Snapshot.ScenarioInstanceID,
			*prepared.Input.ExpectedCursor,
			prepared.Input.ExpectedRevision,
			prepared.Snapshot.Cursor,
			nextRevision,
			prepared.Snapshot.IntegrityHash,
		)
	}
	if err != nil {
		return mapWriteFailure("move graph head", err)
	}
	if commandTag.RowsAffected() != 1 {
		return graphstore.Failure(
			graphstore.ErrorCursorConflict,
			"graph head compare-and-swap lost",
			nil,
		)
	}
	return nil
}

func readSnapshotRow(row pgx.Row) (graphstore.StoredSnapshot, error) {
	var scenarioInstanceID string
	var cursor string
	var canonicalBytes []byte
	var integrityHash string
	var projectorVersion string
	var generatedAt string
	var revision int64
	var storedAt time.Time
	if err := row.Scan(
		&scenarioInstanceID,
		&cursor,
		&revision,
		&canonicalBytes,
		&integrityHash,
		&projectorVersion,
		&generatedAt,
		&storedAt,
	); err != nil {
		return graphstore.StoredSnapshot{}, err
	}
	snapshot, err := graphstore.DecodeStoredSnapshot(
		canonicalBytes,
		scenarioInstanceID,
		cursor,
	)
	if err != nil {
		return graphstore.StoredSnapshot{}, err
	}
	if snapshot.IntegrityHash != integrityHash ||
		snapshot.ProjectorVersion != projectorVersion ||
		snapshot.GeneratedAt != generatedAt {
		return graphstore.StoredSnapshot{}, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored snapshot metadata differs from canonical bytes",
			nil,
		)
	}
	return graphstore.StoredSnapshot{
		Snapshot:       snapshot,
		CanonicalBytes: append([]byte(nil), canonicalBytes...),
		Revision:       revision,
		StoredAt:       storedAt,
	}, nil
}

func readDeltaRow(row pgx.Row) (graphstore.StoredDelta, error) {
	var scenarioInstanceID string
	var fromCursor string
	var toCursor string
	var canonicalBytes []byte
	var integrityHash string
	var generatedAt string
	var revision int64
	var storedAt time.Time
	if err := row.Scan(
		&scenarioInstanceID,
		&fromCursor,
		&toCursor,
		&revision,
		&canonicalBytes,
		&integrityHash,
		&generatedAt,
		&storedAt,
	); err != nil {
		return graphstore.StoredDelta{}, err
	}
	delta, err := graphstore.DecodeStoredDelta(
		canonicalBytes,
		scenarioInstanceID,
		fromCursor,
		toCursor,
	)
	if err != nil {
		return graphstore.StoredDelta{}, err
	}
	if delta.IntegrityHash != integrityHash || delta.GeneratedAt != generatedAt {
		return graphstore.StoredDelta{}, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored delta metadata differs from canonical bytes",
			nil,
		)
	}
	return graphstore.StoredDelta{
		Delta:          delta,
		CanonicalBytes: append([]byte(nil), canonicalBytes...),
		Revision:       revision,
		StoredAt:       storedAt,
	}, nil
}

func readReceiptRow(row pgx.Row) (graphstore.Receipt, []byte, error) {
	var receipt graphstore.Receipt
	var status string
	var rawFingerprint []byte
	var previousCursor pgtype.Text
	var revision pgtype.Int8
	var deltaIntegrity pgtype.Text
	var committedAt pgtype.Timestamptz
	var reconciliationToken pgtype.Text
	if err := row.Scan(
		&receipt.ReceiptID,
		&receipt.Operation,
		&status,
		&receipt.ScenarioInstanceID,
		&receipt.IdempotencyKey,
		&rawFingerprint,
		&previousCursor,
		&receipt.Cursor,
		&revision,
		&receipt.SnapshotIntegrityHash,
		&deltaIntegrity,
		&committedAt,
		&reconciliationToken,
		&receipt.RecordedAt,
	); err != nil {
		return graphstore.Receipt{}, nil, err
	}
	if len(rawFingerprint) != 32 {
		return graphstore.Receipt{}, nil, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored receipt fingerprint has the wrong length",
			nil,
		)
	}
	if !revision.Valid || revision.Int64 < 1 {
		return graphstore.Receipt{}, nil, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored receipt has no positive revision",
			nil,
		)
	}
	if receipt.Operation != graphstore.OperationSnapshot &&
		receipt.Operation != graphstore.OperationSnapshotDelta {
		return graphstore.Receipt{}, nil, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored receipt has an unknown operation",
			nil,
		)
	}
	if receipt.Operation == graphstore.OperationSnapshot && deltaIntegrity.Valid ||
		receipt.Operation == graphstore.OperationSnapshotDelta && !deltaIntegrity.Valid {
		return graphstore.Receipt{}, nil, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored receipt operation and delta integrity disagree",
			nil,
		)
	}
	switch graphstore.ReceiptStatus(status) {
	case graphstore.ReceiptAccepted:
		if !committedAt.Valid || reconciliationToken.Valid {
			return graphstore.Receipt{}, nil, graphstore.Failure(
				graphstore.ErrorContentInvalid,
				"stored accepted receipt has invalid reconciliation fields",
				nil,
			)
		}
	case graphstore.ReceiptReconciliationRequired:
		if committedAt.Valid || !reconciliationToken.Valid {
			return graphstore.Receipt{}, nil, graphstore.Failure(
				graphstore.ErrorContentInvalid,
				"stored reconciliation receipt has invalid reconciliation fields",
				nil,
			)
		}
	default:
		return graphstore.Receipt{}, nil, graphstore.Failure(
			graphstore.ErrorContentInvalid,
			"stored receipt has an unknown status",
			nil,
		)
	}
	receipt.Schema = graphstore.ReceiptSchema
	receipt.Status = graphstore.ReceiptStatus(status)
	receipt.RequestFingerprint = "sha256:" + hex.EncodeToString(rawFingerprint)
	receipt.PreviousCursor = textPointer(previousCursor)
	receipt.Revision = revision.Int64
	receipt.DeltaIntegrityHash = textPointer(deltaIntegrity)
	receipt.CommittedAt = timePointer(committedAt)
	receipt.ReconciliationToken = textPointer(reconciliationToken)
	return receipt, append([]byte(nil), rawFingerprint...), nil
}

func databaseFailure(operation string, err error) error {
	return graphstore.Failure(graphstore.ErrorDatabase, operation, err)
}

func mapRowReadFailure(operation string, err error) error {
	var storeFailure *graphstore.Error
	if errors.As(err, &storeFailure) {
		return err
	}
	return databaseFailure(operation, err)
}

func mapWriteFailure(operation string, err error) error {
	if isUniqueViolation(err) {
		return graphstore.Failure(graphstore.ErrorCursorConflict, operation, err)
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) &&
		(postgresError.Code == "23503" || postgresError.Code == "23514") {
		return graphstore.Failure(graphstore.ErrorContentInvalid, operation, err)
	}
	return databaseFailure(operation, err)
}

func isUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

func randomToken(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return prefix + "_" + hex.EncodeToString(value[:]), nil
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func displayCursor(value *string) string {
	if value == nil {
		return "<none>"
	}
	return *value
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func optionalDeltaIntegrity(delta *graphstore.Delta) *string {
	if delta == nil {
		return nil
	}
	value := delta.IntegrityHash
	return &value
}

func textPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func decodeFingerprint(value string) ([]byte, error) {
	const prefix = "sha256:"
	if len(value) != len(prefix)+64 || value[:len(prefix)] != prefix {
		return nil, errors.New("invalid fingerprint")
	}
	decoded, err := hex.DecodeString(value[len(prefix):])
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid fingerprint")
	}
	return decoded, nil
}

var _ graphstore.Store = (*Repository)(nil)
