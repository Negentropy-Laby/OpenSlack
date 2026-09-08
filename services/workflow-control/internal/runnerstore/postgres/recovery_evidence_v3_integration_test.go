package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type recoveryPageTracer struct {
	pages          atomic.Int64
	rows           atomic.Int64
	attemptQueries atomic.Int64
}

func (tr *recoveryPageTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "FROM workflow_runner_recovery_records") {
		tr.pages.Add(1)
		if strings.Contains(data.SQL, "record_key>='attempt.'") {
			tr.attemptQueries.Add(1)
		}
		return context.WithValue(ctx, recoveryTraceKey{}, true)
	}
	return ctx
}

type recoveryTraceKey struct{}

func (tr *recoveryPageTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if ctx.Value(recoveryTraceKey{}) == true {
		tr.rows.Add(data.CommandTag.RowsAffected())
	}
}

func recoveryHistory(t testing.TB, repo *Repository, count int) []runnerstore.V2AuthorityBindingView {
	t.Helper()
	lease := claimV2(t, repo, v2JobInputForWorkspace(t, "recovery-pages", "workspace-recovery-pages", "go", "workflow-control"))
	sealRuntimeAdmission(t, repo, lease, "initial")
	negotiateV2Lease(t, repo, lease)
	at := canonicalNow()
	input := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-recovery-initial", lease.RunRevision, lease.ResumeGeneration, at,
		map[string]any{"acceptedAt": at, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
	input.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
	accepted, err := repo.RecordV2Event(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	deliverV2Control(t, repo, lease.AttemptID, accepted.Receipt.EventID, string(accepted.Receipt.Kind))
	history := make([]runnerstore.V2AuthorityBindingView, 0, count)
	for i := 0; i < count; i++ {
		state := "completed"
		if i == count-1 {
			state = "resolved"
		}
		history = append(history, exerciseGS9F2BindingLifecycleUntil(t, repo, runnerbindingcontract.OperationCheckpointCommit, fmt.Sprintf("recovery-page-%d", i), &lease, state, ""))
	}
	return history
}

func collectRecoveryPages(t testing.TB, repo *Repository, q runnerstore.RecoveryEvidenceV3Query, limit, batch int) (runnerstore.RecoveryEvidenceV3, int) {
	t.Helper()
	var result runnerstore.RecoveryEvidenceV3
	pages := 0
	last := ""
	for {
		page, err := repo.readRecoveryEvidencePage(context.Background(), q, limit, batch)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		exact, err := canonicaljson.Encode(page.Evidence)
		if err != nil || !bytes.Equal(append(exact, '\n'), page.Bytes) || len(page.Bytes) > limit {
			t.Fatal("page is not exact bounded canonical JSON", err)
		}
		if pages == 1 {
			result = page.Evidence
			result.Records = nil
		} else if result.RecoveryVersion != page.Evidence.RecoveryVersion || result.ReadAt != page.Evidence.ReadAt || result.Snapshot != page.Evidence.Snapshot {
			t.Fatal("page identity changed")
		}
		for _, record := range page.Evidence.Records {
			if record.Key <= last {
				t.Fatal("duplicated or unordered page", record.Key)
			}
			last = record.Key
			result.Records = append(result.Records, record)
		}
		if page.Evidence.NextCursor == nil {
			break
		}
		q.After = *page.Evidence.NextCursor
		q.Snapshot = page.Evidence.Snapshot
		q.ReadAt = page.Evidence.ReadAt
		q.RecoveryVersion = page.Evidence.RecoveryVersion
	}
	return result, pages
}

func TestRecoveryV3PagesUpgradeIdentityAndReadOnly(t *testing.T) {
	requireGS9F2(t)
	pool := testsupport.OpenPostgresAtSchema(t, 10)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	history := recoveryHistory(t, repo, 4)
	v := history[0]
	ctx := context.Background()
	before, err := repo.ReadRecoveryEvidenceV2(ctx, v.WorkspaceID, v.RunID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(v2MigrationPath(t, "000011_index_workflow_runner_recovery_pages.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	if err = databaseready.RequireRecoveryV3(ctx, pool); err != nil {
		t.Fatal(err)
	}
	q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: v.WorkspaceID, RunID: v.RunID}
	full, err := repo.ReadRecoveryEvidenceV3(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	largest := 0
	for _, record := range full.Evidence.Records {
		raw, _ := canonicaljson.Encode(record)
		if len(raw) > largest {
			largest = len(raw)
		}
	}
	paged, count := collectRecoveryPages(t, repo, q, largest+1000, 2)
	expected, _ := canonicaljson.Encode(before.Records)
	actual, _ := canonicaljson.Encode(paged.Records)
	if count < 2 || !bytes.Equal(expected, actual) {
		t.Fatalf("pages lost historical evidence: %d pages", count)
	}
	for _, original := range history {
		var raw []byte
		if err = pool.QueryRow(ctx, "SELECT exact_resolution_receipt_bytes FROM workflow_runner_authority_bindings WHERE binding_id=$1", original.BindingID).Scan(&raw); err != nil || !bytes.Equal(raw, original.ExactResolutionReceipt) {
			t.Fatal("migration or read changed exact bytes", err)
		}
	}
	var revision int64
	var pending int
	if err = pool.QueryRow(ctx, "SELECT revision FROM workflow_runner_recovery_versions WHERE workspace_id=$1 AND run_id=$2", v.WorkspaceID, v.RunID).Scan(&revision); err != nil || revision != 1 {
		t.Fatal("read wrote recovery version", revision, err)
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM workflow_runner_recovery_pending").Scan(&pending); err != nil || pending != 0 {
		t.Fatal("pending metadata survived commit", pending, err)
	}
	continuation := q
	continuation.After = full.Evidence.Records[0].Key
	continuation.Snapshot = full.Evidence.Snapshot
	continuation.RecoveryVersion = full.Evidence.RecoveryVersion
	continuation.ReadAt = full.Evidence.ReadAt
	for _, change := range []func(*runnerstore.RecoveryEvidenceV3Query){
		func(q *runnerstore.RecoveryEvidenceV3Query) { q.BindingID = v.BindingID },
		func(q *runnerstore.RecoveryEvidenceV3Query) { q.ReadAt = "2020-01-01T00:00:00.000Z" },
	} {
		changed := continuation
		change(&changed)
		if _, err = repo.ReadRecoveryEvidenceV3(ctx, changed); !runnerstore.IsCode(err, runnerstore.ErrorIdentityMismatch) {
			t.Fatal("cross-query cursor accepted", err)
		}
	}
	for _, changed := range []runnerstore.RecoveryEvidenceV3Query{{WorkspaceID: "foreign", RunID: v.RunID}, {WorkspaceID: v.WorkspaceID, RunID: "foreign"}} {
		if _, err = repo.ReadRecoveryEvidenceV3(ctx, changed); !runnerstore.IsCode(err, runnerstore.ErrorNotFound) {
			t.Fatal(err)
		}
	}
	// Ordinary heartbeat timestamps and job revision do not change projected evidence.
	if _, err = pool.Exec(ctx, "UPDATE workflow_runner_leases SET last_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE lease_id=$1", v.LeaseID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "UPDATE workflow_runner_jobs SET revision=revision+1,updated_at=clock_timestamp() WHERE job_id=$1", v.JobID); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.ReadRecoveryEvidenceV3(ctx, continuation); err != nil {
		t.Fatal("heartbeat invalidated unchanged page", err)
	}
	if _, err = pool.Exec(ctx, "UPDATE workflow_runner_leases SET state='expired' WHERE lease_id=$1", v.LeaseID); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.ReadRecoveryEvidenceV3(ctx, continuation); !runnerstore.IsCode(err, runnerstore.ErrorAuthorityUnavailable) {
		t.Fatal("changed history accepted", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = repo.ReadRecoveryEvidenceV3(cancelled, q); err == nil {
		t.Fatal("cancelled query succeeded")
	}
	if _, err = pool.Exec(ctx, "ALTER TABLE workflow_runner_jobs DISABLE TRIGGER workflow_runner_recovery_jobs"); err != nil {
		t.Fatal(err)
	}
	if err = databaseready.RequireRecoveryV3(ctx, pool); err == nil {
		t.Fatal("disabled maintenance trigger accepted")
	}
}

func TestRecoveryV3MetadataOldWriterModesAndContention(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	ctx := context.Background()
	first := v2JobInputForWorkspace(t, "metadata-a", "metadata-workspace", "go", "workflow-control")
	second := v2JobInputForWorkspace(t, "metadata-b", "metadata-workspace", "go", "workflow-control")
	second.Prepared.Spec.WorkflowRunID = first.Prepared.Spec.WorkflowRunID
	var err error
	second.Prepared, err = runnerstore.PrepareV2JobSpec(second.Prepared.Spec)
	if err != nil {
		t.Fatal(err)
	}
	second.IdempotencyKey, second.RequestFingerprint = runnerstore.V2SubmissionBindings(second.Prepared)
	for _, input := range []runnerstore.V2SubmitInput{first, second} {
		claimV2(t, repo, input)
	}
	q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: first.Prepared.Spec.WorkspaceID, RunID: first.Prepared.Spec.WorkflowRunID}
	before, err := repo.ReadRecoveryEvidenceV3(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	priorVersion, _ := strconv.ParseInt(before.Evidence.RecoveryVersion, 10, 64)
	var schema string
	if err = pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	relation := pgx.Identifier{schema, "workflow_runner_jobs"}.Sanitize()
	a, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Rollback(ctx)
	if _, err = a.Exec(ctx, "SET LOCAL search_path=pg_catalog; SET LOCAL session_replication_role=replica; SET CONSTRAINTS ALL IMMEDIATE;"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Exec(ctx, "UPDATE "+relation+" SET routing_epoch=routing_epoch+1 WHERE job_id=$1", first.Prepared.Spec.JobID); err != nil {
		t.Fatal(err)
	}
	b, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Rollback(ctx)
	if _, err = b.Exec(ctx, "SET LOCAL session_replication_role=replica"); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Exec(ctx, "UPDATE workflow_runner_jobs SET routing_epoch=routing_epoch+1 WHERE job_id=$1", second.Prepared.Spec.JobID); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err = b.Commit(bounded)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "40001" {
		t.Fatal("metadata contention must abort without waiting for source locks", err)
	}
	if _, err = a.Exec(ctx, "UPDATE "+relation+" SET routing_epoch=routing_epoch+1 WHERE job_id=$1", second.Prepared.Spec.JobID); err != nil {
		t.Fatal(err)
	}
	if err = a.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var currentVersion int64
	if err = pool.QueryRow(ctx, "SELECT revision FROM workflow_runner_recovery_versions WHERE workspace_id=$1 AND run_id=$2", q.WorkspaceID, q.RunID).Scan(&currentVersion); err != nil || currentVersion != priorVersion+2 {
		t.Fatal("old writer modes bypassed version maintenance", currentVersion, err)
	}
	if _, err = repo.ReadRecoveryEvidenceV3(ctx, q); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
		t.Fatal("changed route was not diagnosed", err)
	}
	var count int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM workflow_runner_recovery_pending").Scan(&count); err != nil || count != 0 {
		t.Fatal("queue leaked", err)
	}
}

func TestRecoveryV3MigrationRefusesConcurrentWriterWithoutPartialDDL(t *testing.T) {
	pool := testsupport.OpenPostgresAtSchema(t, 10)
	ctx := context.Background()
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(ctx)
	if _, err = writer.Exec(ctx, "LOCK TABLE workflow_runner_jobs IN ROW EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(v2MigrationPath(t, "000011_index_workflow_runner_recovery_pages.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	_, err = conn.Exec(ctx, string(migration))
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatal("migration did not reject concurrent writer", err)
	}
	if _, err = conn.Exec(ctx, "ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	var relation *string
	if err = conn.QueryRow(ctx, "SELECT to_regclass('workflow_runner_recovery_versions')::text").Scan(&relation); err != nil || relation != nil {
		t.Fatal("partial migration remained", err)
	}
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
}

func BenchmarkRecoveryV3FetchBatch(b *testing.B) {
	for _, size := range []int{16, 128} {
		pool := testsupport.OpenPostgres(b)
		repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
		history := recoveryHistory(b, repo, size)
		q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: history[0].WorkspaceID, RunID: history[0].RunID}
		for _, batch := range []int{1, 4, 16, 64} {
			b.Run(fmt.Sprintf("history=%d/batch=%d", size, batch), func(b *testing.B) {
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					request := q
					for {
						page, err := repo.readRecoveryEvidencePage(context.Background(), request, runnerstore.RecoveryEvidenceMaxResponseBytes, batch)
						if err != nil {
							b.Fatal(err)
						}
						if page.Evidence.NextCursor == nil {
							break
						}
						request.After = *page.Evidence.NextCursor
						request.ReadAt = page.Evidence.ReadAt
						request.RecoveryVersion = page.Evidence.RecoveryVersion
						request.Snapshot = page.Evidence.Snapshot
					}
				}
			})
		}
	}
}

func TestRecoveryV3PageWorkScalesWithReturnedRecords(t *testing.T) {
	requireGS9F2(t)
	tracer := &recoveryPageTracer{}
	pool := testsupport.OpenPostgresWithTracer(t, tracer)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	history := recoveryHistory(t, repo, 16)
	v := history[0]
	q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: v.WorkspaceID, RunID: v.RunID}
	full, err := repo.ReadRecoveryEvidenceV3(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	largest := 0
	for _, record := range full.Evidence.Records {
		raw, _ := canonicaljson.Encode(record)
		if len(raw) > largest {
			largest = len(raw)
		}
	}
	for _, batch := range []int{1, 4, 16} {
		tracer.pages.Store(0)
		tracer.rows.Store(0)
		evidence, pages := collectRecoveryPages(t, repo, q, largest+1000, batch)
		if len(evidence.Records) != len(full.Evidence.Records) || pages < 2 {
			t.Fatal("history differs")
		}
		// One indexed stream per kind, plus bounded lookahead per response. The
		// database never returns all history again for each continuation page.
		if tracer.rows.Load() > int64(len(evidence.Records)+pages*batch) {
			t.Fatal("unbounded page prefetch", tracer.rows.Load())
		}
		if tracer.pages.Load() > int64(4*pages+(len(evidence.Records)+batch-1)/batch) {
			t.Fatal("page query count grew with full history", tracer.pages.Load())
		}
	}
	q.After = "binding." + v.BindingID
	q.ReadAt, q.RecoveryVersion, q.Snapshot = full.Evidence.ReadAt, full.Evidence.RecoveryVersion, full.Evidence.Snapshot
	tracer.attemptQueries.Store(0)
	if _, err := repo.ReadRecoveryEvidenceV3(context.Background(), q); err != nil {
		t.Fatal(err)
	}
	if tracer.attemptQueries.Load() != 0 {
		t.Fatal("later pages queried the excluded attempt history")
	}
}

func TestRecoveryV3LeaseExpiryUsesFirstDatabaseReadPoint(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	ctx := context.Background()
	for i := 0; i < 8; i++ {
		input := v2JobInputForWorkspace(t, fmt.Sprintf("read-point-%d", i), "read-point-workspace", "go", "workflow-control")
		input.Prepared.Spec.WorkflowRunID = "run-read-point"
		var err error
		input.Prepared, err = runnerstore.PrepareV2JobSpec(input.Prepared.Spec)
		if err != nil {
			t.Fatal(err)
		}
		input.IdempotencyKey, input.RequestFingerprint = runnerstore.V2SubmissionBindings(input.Prepared)
		claimV2(t, repo, input)
	}
	var deadline time.Time
	if err := pool.QueryRow(ctx, "SELECT clock_timestamp()+interval '1 second'").Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE workflow_runner_leases SET lease_expires_at=$1,offer_expires_at=$1 WHERE workspace_id='read-point-workspace'", deadline); err != nil {
		t.Fatal(err)
	}
	q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: "read-point-workspace", RunID: "run-read-point"}
	first, err := repo.readRecoveryEvidencePage(ctx, q, 800, 1)
	if err != nil || first.Evidence.NextCursor == nil || len(first.Evidence.Records) == 0 {
		t.Fatal("fixture did not paginate active attempts", err)
	}
	var remaining time.Duration
	if err = pool.QueryRow(ctx, "SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000000000)::bigint", deadline).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	time.Sleep(remaining + time.Millisecond)
	q.After = *first.Evidence.NextCursor
	q.ReadAt = first.Evidence.ReadAt
	q.RecoveryVersion = first.Evidence.RecoveryVersion
	q.Snapshot = first.Evidence.Snapshot
	rest, _ := collectRecoveryPages(t, repo, q, 800, 1)
	if len(first.Evidence.Records)+len(rest.Records) != 8 {
		t.Fatal("lease expiry tore the fixed view")
	}
	fresh, err := repo.ReadRecoveryEvidenceV3(ctx, runnerstore.RecoveryEvidenceV3Query{WorkspaceID: q.WorkspaceID, RunID: q.RunID})
	if err != nil || len(fresh.Evidence.Records) != 0 || fresh.Evidence.RecoveryVersion != q.RecoveryVersion {
		t.Fatal("fresh expiry projection differs", err)
	}
}

// Timing and EXPLAIN evidence live in an opt-in benchmark, not ordinary tests.
func BenchmarkRecoveryV3ExpiredAttemptRange(b *testing.B) {
	for _, size := range []int{64, 256} {
		pool := testsupport.OpenPostgres(b)
		repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
		ctx := context.Background()
		q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: "workspace-expired-range", RunID: "run-expired-range"}
		for i := 0; i < size; i++ {
			input := v2JobInputForWorkspace(b, fmt.Sprintf("expired-range-%d", i), q.WorkspaceID, "go", "workflow-control")
			input.Prepared.Spec.WorkflowRunID = q.RunID
			var err error
			input.Prepared, err = runnerstore.PrepareV2JobSpec(input.Prepared.Spec)
			if err != nil {
				b.Fatal(err)
			}
			input.IdempotencyKey, input.RequestFingerprint = runnerstore.V2SubmissionBindings(input.Prepared)
			claimV2(b, repo, input)
		}
		if _, err := pool.Exec(ctx, "UPDATE workflow_runner_leases SET created_at=clock_timestamp()-interval '3 seconds',offer_expires_at=clock_timestamp()-interval '2 seconds',lease_expires_at=clock_timestamp()-interval '1 second'"); err != nil {
			b.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "ANALYZE workflow_runner_recovery_records"); err != nil {
			b.Fatal(err)
		}
		first, err := repo.ReadRecoveryEvidenceV3(ctx, q)
		if err != nil {
			b.Fatal(err)
		}
		q.ReadAt, q.RecoveryVersion, q.Snapshot = first.Evidence.ReadAt, first.Evidence.RecoveryVersion, first.Evidence.Snapshot
		for _, after := range []string{"", "binding.after-attempt-range"} {
			b.Run(fmt.Sprintf("expired=%d/after=%s", size, after), func(b *testing.B) {
				query := q
				query.After = after
				if after == "" {
					query.ReadAt, query.RecoveryVersion, query.Snapshot = "", "", ""
				}
				// This is the same attempt-range statement as the reader; EXPLAIN reports
				// filtered tuples too, unlike a driver tracer's returned-row count.
				var planBytes []byte
				readAt, _ := time.Parse(time.RFC3339Nano, q.ReadAt)
				if after < "attempt/" {
					err := pool.QueryRow(ctx, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT record_key,attempt_id FROM workflow_runner_recovery_records
    WHERE workspace_id=$1 AND run_id=$2 AND record_key>$3 COLLATE "C" AND record_key>='attempt.' AND record_key<'attempt/' AND lease_expires_at>$4 ORDER BY record_key LIMIT $5`, q.WorkspaceID, q.RunID, after, readAt, recoveryRecordFetchBatch).Scan(&planBytes)
					if err != nil {
						b.Fatal(err)
					}
				} else {
					planBytes = []byte(`[{"Plan": {"Node Type": "Result", "Shared Hit Blocks": 0}}]`)
				}
				var plans []map[string]any
				if err = json.Unmarshal(planBytes, &plans); err != nil {
					b.Fatal(err)
				}
				var examined float64
				var scan func(map[string]any)
				scan = func(node map[string]any) {
					if kind, _ := node["Node Type"].(string); strings.Contains(kind, "Scan") {
						rows, _ := node["Actual Rows"].(float64)
						removed, _ := node["Rows Removed by Filter"].(float64)
						loops, _ := node["Actual Loops"].(float64)
						examined += (rows + removed) * loops
					}
					if children, ok := node["Plans"].([]any); ok {
						for _, child := range children {
							scan(child.(map[string]any))
						}
					}
				}
				plan := plans[0]["Plan"].(map[string]any)
				scan(plan)
				hits, _ := plan["Shared Hit Blocks"].(float64)
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if _, err := repo.ReadRecoveryEvidenceV3(ctx, query); err != nil {
						b.Fatal(err)
					}
				}
				b.ReportMetric(examined, "attempt-tuples/page")
				b.ReportMetric(hits, "attempt-buffer-hits/page")
			})
		}
	}
}
