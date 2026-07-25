package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/delivery"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
	notificationstorepostgres "github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/operationscontrol"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/reliability"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

func TestCrashSendHelper(t *testing.T) {
	if os.Getenv("RC_WSMAN_CRASH_HELPER") != "1" {
		return
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("RC_WSMAN_CRASH_DATABASE_URL"))
	if err != nil {
		os.Exit(87)
	}
	defer pool.Close()
	store := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	cfg := delivery.DefaultConfig()
	policy, err := delivery.NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		os.Exit(87)
	}
	vendorID := os.Getenv("RC_WSMAN_CRASH_VENDOR_ID")
	runner, err := delivery.NewRunner(cfg, store, acceptanceSnapshotReader{vendorID: vendorID}, integrationCredentialResolver{}, integrationDNSResolver{}, &callbackTransport{
		vendorURL: os.Getenv("RC_WSMAN_VENDOR_URL"), notificationID: os.Getenv("RC_WSMAN_NOTIFICATION_ID"), crashAfterSend: true,
	}, policy, delivery.RealClock{}, delivery.CryptoRNG{})
	if err != nil {
		os.Exit(87)
	}
	if claimed, err := runner.RunOnce(ctx, workerActor(vendorID)); err != nil || !claimed {
		os.Exit(86)
	}
	os.Exit(87)
}

type acceptanceSnapshotReader struct{ vendorID string }

func (s acceptanceSnapshotReader) Snapshot(context.Context, vendorregistry.ActorContext, string, *int64) (any, error) {
	return vendorregistry.DeliveryConfigSnapshot{
		ProjectionSchema: "delivery-v1", VendorID: s.vendorID, ConfigVersion: 1, ConfigSchemaVersion: 1,
		CanonicalURL: "https://vendor.example/hook", Method: http.MethodPost, Hostname: "vendor.example", Port: 443,
		TransportKind: "https_public", OutboundIdempotencyMapping: vendorregistry.OutboundIdempotencyMapping{Mode: "none"},
		ResponsePolicy: vendorregistry.ResponsePolicyHTTPStatusV1,
		EndpointPolicy: vendorregistry.EndpointPolicy{AllowedRequestHeaderNames: []string{}, ForbiddenRequestHeaderNames: []string{}, MaxRequestBodyBytes: 4096},
		AuthStrategy:   "bearer", CredentialRef: &vendorregistry.CredentialRef{Scheme: "env", OpaqueHandle: "ACCEPTANCE_VENDOR_TOKEN", ReferenceVersion: "v1"},
	}, nil
}

type callbackTransport struct {
	vendorURL      string
	notificationID string
	crashAfterSend bool
}

func (t *callbackTransport) Do(ctx context.Context, _ *http.Request, _ netip.Addr, _ time.Duration, _ string) (delivery.TransportResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.vendorURL, bytes.NewBufferString(`{"event":"paid"}`))
	if err != nil {
		return delivery.TransportResponse{}, err
	}
	req.Header.Set("X-Notification-ID", t.notificationID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return delivery.TransportResponse{}, err
	}
	_ = resp.Body.Close()
	if t.crashAfterSend {
		// This is the actual Delivery Runner process. Terminate only after the
		// vendor accepted the request and before Runner can write the outcome.
		os.Exit(88)
	}
	return delivery.TransportResponse{StatusCode: http.StatusNoContent, Header: make(http.Header)}, nil
}

func operationsPrincipal(vendorID string) calleraccess.OperatorPrincipal {
	return calleraccess.OperatorPrincipal{PrincipalID: "operator-operations-it", VendorScope: []string{vendorID}, Capabilities: []string{
		calleraccess.CapabilityReadNotifications, calleraccess.CapabilityReplayPreview,
		calleraccess.CapabilityReplayExecute, calleraccess.CapabilityReplayBatch,
	}}
}

func TestOperationsDeadPreviewExecuteStartsNewDeliveryCycle(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	res := f.intake(ctx, "caller-operations", "key-operations")
	vendorID := "vendor-caller-operations"
	worker := workerActor(vendorID)
	claim, err := f.repo.ClaimNext(ctx, worker, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	dead, err := f.repo.Transition(ctx, worker, notificationstore.TransitionRequest{
		NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
		ExpectedVersion: claim.Version, LeaseID: claim.LeaseID, RequestedTransition: notificationstore.TransitionDie,
		DeliveryResult: &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassPermanentFailure, HTTPStatus: 400, Reason: notificationstore.ReasonNonRetryableHTTPStatus},
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := operationscontrol.New(f.repo)
	if err != nil {
		t.Fatal(err)
	}
	op := operationsPrincipal(vendorID)
	preview, err := service.PreviewReplay(ctx, op, []string{res.NotificationID}, "vendor recovery was confirmed")
	if err != nil || len(preview) != 1 || preview[0].Outcome != "eligible" || preview[0].ExpectedVersion != dead.Version {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	executed, err := service.ExecuteReplay(ctx, op, []operationscontrol.ReplayExecuteInput{{NotificationID: res.NotificationID, ExpectedVersion: preview[0].ExpectedVersion}}, "vendor recovery was confirmed")
	if err != nil || len(executed.Succeeded) != 1 || len(executed.Failed) != 0 || len(executed.Skipped) != 0 {
		t.Fatalf("execute=%+v err=%v", executed, err)
	}
	status, err := service.QueryNotification(ctx, op, res.NotificationID)
	if err != nil || status.VendorID != vendorID || status.State != "pending" || status.AttemptCount != 0 || status.ReplayCount != 1 || !status.DeliveryCycleStartedAt.After(claim.DeliveryCycleStartedAt) {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	history, err := service.ListAttemptHistory(ctx, op, res.NotificationID, 100, "")
	if err != nil || len(history.Items) != 3 || history.Items[2].EventKind != "replay" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
}

func TestOperationsPreviewThenConcurrentReplayMakesStaleExecuteNonDestructive(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	accepted := f.intake(ctx, "caller-operations-stale", "key-operations-stale")
	vendorID := "vendor-caller-operations-stale"
	worker := workerActor(vendorID)
	claim, err := f.repo.ClaimNext(ctx, worker, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	dead, err := f.repo.Transition(ctx, worker, notificationstore.TransitionRequest{
		NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
		ExpectedVersion: claim.Version, LeaseID: claim.LeaseID, RequestedTransition: notificationstore.TransitionDie,
		DeliveryResult: &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassPermanentFailure, HTTPStatus: 400, Reason: notificationstore.ReasonNonRetryableHTTPStatus},
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := operationscontrol.New(f.repo)
	if err != nil {
		t.Fatal(err)
	}
	op := operationsPrincipal(vendorID)
	preview, err := service.PreviewReplay(ctx, op, []string{accepted.NotificationID}, "vendor recovery was confirmed")
	if err != nil || len(preview) != 1 || preview[0].ExpectedVersion != dead.Version {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	first, err := service.ExecuteReplay(ctx, op, []operationscontrol.ReplayExecuteInput{{NotificationID: accepted.NotificationID, ExpectedVersion: preview[0].ExpectedVersion}}, "first operator replay confirmed")
	if err != nil || len(first.Succeeded) != 1 {
		t.Fatalf("concurrent replay=%+v err=%v", first, err)
	}
	before, err := service.QueryNotification(ctx, op, accepted.NotificationID)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := service.ExecuteReplay(ctx, op, []operationscontrol.ReplayExecuteInput{{NotificationID: accepted.NotificationID, ExpectedVersion: preview[0].ExpectedVersion}}, "stale preview replay attempt")
	if err != nil || len(stale.Skipped) != 1 || stale.Skipped[0].Reason != "stale_version" || len(stale.Succeeded) != 0 || len(stale.Failed) != 0 {
		t.Fatalf("stale execute=%+v err=%v", stale, err)
	}
	after, err := service.QueryNotification(ctx, op, accepted.NotificationID)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != before.State || after.Version != before.Version || after.ReplayCount != before.ReplayCount || after.AttemptCount != before.AttemptCount {
		t.Fatalf("stale execute overwrote current state: before=%+v after=%+v", before, after)
	}
}

func TestOperationsVendorScopeDeenumeratesQueryPreviewAndExecute(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	accepted := f.intake(ctx, "caller-operations-scope", "key-operations-scope")
	vendorID := "vendor-caller-operations-scope"
	worker := workerActor(vendorID)
	claim, err := f.repo.ClaimNext(ctx, worker, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	dead, err := f.repo.Transition(ctx, worker, notificationstore.TransitionRequest{
		NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
		ExpectedVersion: claim.Version, LeaseID: claim.LeaseID, RequestedTransition: notificationstore.TransitionDie,
		DeliveryResult: &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassPermanentFailure, HTTPStatus: 400, Reason: notificationstore.ReasonNonRetryableHTTPStatus},
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := operationscontrol.New(f.repo)
	if err != nil {
		t.Fatal(err)
	}
	outside := operationsPrincipal("vendor-outside-operator-scope")
	for _, query := range []func() error{
		func() error { _, err := service.QueryOutbox(ctx, outside, []string{vendorID}); return err },
		func() error { _, err := service.ListDead(ctx, outside, []string{vendorID}, 10, ""); return err },
	} {
		if err := query(); !calleraccess.IsRejection(err, calleraccess.RejectionForbidden) {
			t.Fatalf("out-of-scope filtered query error=%v", err)
		}
	}
	for _, id := range []string{accepted.NotificationID, "notification-that-does-not-exist"} {
		if _, err := service.QueryNotification(ctx, outside, id); !notificationstore.IsRejection(err, notificationstore.RejectionNotFound) {
			t.Fatalf("query id=%s err=%v", id, err)
		}
		preview, err := service.PreviewReplay(ctx, outside, []string{id}, "vendor recovery was confirmed")
		if err != nil || len(preview) != 1 || preview[0].Outcome != "skipped" || preview[0].Reason != "not_found" || preview[0].CurrentState != "" || preview[0].ExpectedVersion != 0 {
			t.Fatalf("preview id=%s result=%+v err=%v", id, preview, err)
		}
		execute, err := service.ExecuteReplay(ctx, outside, []operationscontrol.ReplayExecuteInput{{NotificationID: id, ExpectedVersion: dead.Version}}, "vendor recovery was confirmed")
		if err != nil || len(execute.Succeeded) != 0 || len(execute.Failed) != 0 || len(execute.Skipped) != 1 || execute.Skipped[0].Reason != "not_found" {
			t.Fatalf("execute id=%s result=%+v err=%v", id, execute, err)
		}
	}
	after, err := service.QueryNotification(ctx, operationsPrincipal(vendorID), accepted.NotificationID)
	if err != nil || after.State != "dead" || after.Version != dead.Version || after.ReplayCount != 0 {
		t.Fatalf("out-of-scope operations changed target: after=%+v err=%v", after, err)
	}
}

func TestReliabilityCollectsRealGlobalSnapshot(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	f.intake(ctx, "caller-metrics-a", "key-metrics-a")
	f.intake(ctx, "caller-metrics-b", "key-metrics-b")
	service, err := reliability.New(f.repo, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.Collect(ctx)
	if err != nil || snapshot.PendingCount < 2 || snapshot.OldestPendingAgeSeconds < 0 || snapshot.DeadCount < 0 {
		t.Fatalf("snapshot=%+v err=%v", snapshot, err)
	}
}

func TestReliabilityRejectsNegativeAgeFromRealStoreProjection(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	accepted := f.intake(ctx, "caller-metrics-negative-age", "key-metrics-negative-age")
	if _, err := f.pool.Exec(ctx,
		`UPDATE notifications SET created_at = now() + interval '1 hour' WHERE notification_id = $1`,
		accepted.NotificationID,
	); err != nil {
		t.Fatal(err)
	}
	service, err := reliability.New(f.repo, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot, err := service.Collect(ctx); err == nil || snapshot != (reliability.Snapshot{}) {
		t.Fatalf("negative Store age published snapshot=%+v err=%v", snapshot, err)
	}
}

func TestReliabilityGlobalQueryRejectsMissingReadAllCapabilityWithoutProjection(t *testing.T) {
	f := newStoreFixture(t)
	actor := notificationstore.ActorContext{
		Kind: notificationstore.ActorSystem, ActorID: "reliability-without-capability", VendorScope: []string{"*"},
		Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications},
	}
	projection, err := f.repo.QueryOutbox(t.Context(), actor, nil)
	if !notificationstore.IsRejection(err, notificationstore.RejectionForbiddenAction) || projection != (notificationstore.OutboxProjection{}) {
		t.Fatalf("projection=%+v err=%v", projection, err)
	}
}

func TestSensitiveMarkerIsExcludedFromAttemptsAuditLogsAndOperatorProjections(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	const marker = "RC_WSMAN_SENSITIVE_ACCEPTANCE_MARKER"
	const vendorID = "vendor-sensitive-marker"
	f.seedVendor(ctx, vendorID)
	var logBuffer bytes.Buffer
	store := notificationstorepostgres.New(f.pool, slog.New(slog.NewJSONHandler(&logBuffer, nil)))
	accepted, err := store.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID: "caller-sensitive-marker", VendorID: vendorID, Payload: []byte(marker), IdempotencyKey: "sensitive-marker-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimNext(ctx, workerActor(vendorID), nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Transition(ctx, workerActor(vendorID), notificationstore.TransitionRequest{
		NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
		ExpectedVersion: claim.Version, LeaseID: claim.LeaseID, RequestedTransition: notificationstore.TransitionDie,
		DeliveryResult: &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindTransportFailure, OutcomeClass: notificationstore.OutcomeClassPermanentFailure, ErrorCode: delivery.ErrorCodeConnectionFailure, Reason: notificationstore.ReasonDeadlineExceeded},
	}); err != nil {
		t.Fatal(err)
	}
	var attemptText, auditText string
	if err := f.pool.QueryRow(ctx, `SELECT COALESCE(string_agg(row_to_json(a)::text, ''), '') FROM delivery_attempts a WHERE notification_id=$1`, accepted.NotificationID).Scan(&attemptText); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT COALESCE(string_agg(row_to_json(a)::text, ''), '') FROM admin_audit_events a WHERE vendor_id=$1`, vendorID).Scan(&auditText); err != nil {
		t.Fatal(err)
	}
	service, err := operationscontrol.New(store)
	if err != nil {
		t.Fatal(err)
	}
	status, err := service.QueryNotification(ctx, operationsPrincipal(vendorID), accepted.NotificationID)
	if err != nil {
		t.Fatal(err)
	}
	history, err := service.ListAttemptHistory(ctx, operationsPrincipal(vendorID), accepted.NotificationID, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	projectionJSON, err := json.Marshal([]any{status, history})
	if err != nil {
		t.Fatal(err)
	}
	for surface, value := range map[string]string{
		"attempts": attemptText, "audit": auditText, "store_logs": logBuffer.String(), "operator_projection": string(projectionJSON),
	} {
		if bytes.Contains([]byte(value), []byte(marker)) {
			t.Fatalf("%s leaked sensitive marker", surface)
		}
	}
}

func TestRecoveryAdvisoryLockAllowsOnlyOneActiveSweeper(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	conn, err := f.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(7277797366262101)`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7277797366262101)`) }()
	recovered, err := f.repo.RecoverExpiredLeases(ctx, systemActor("vendor-any"), 100)
	if err != nil || len(recovered) != 0 {
		t.Fatalf("contending sweeper recovered=%+v err=%v", recovered, err)
	}
}

func TestCrashAfterSendBeforeCommitConvergesWithoutLossAndMayDuplicate(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	res := f.intake(ctx, "caller-crash-process", "key-crash-process")
	vendorID := "vendor-caller-crash-process"
	worker := workerActor(vendorID)
	var received atomic.Int64
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Notification-ID") == res.NotificationID {
			received.Add(1)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer vendor.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashSendHelper$")
	cmd.Env = append(os.Environ(),
		"RC_WSMAN_CRASH_HELPER=1",
		"RC_WSMAN_CRASH_DATABASE_URL="+f.pool.Config().ConnString(),
		"RC_WSMAN_VENDOR_URL="+vendor.URL,
		"RC_WSMAN_NOTIFICATION_ID="+res.NotificationID,
		"RC_WSMAN_CRASH_VENDOR_ID="+vendorID,
	)
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 88 || received.Load() != 1 {
		t.Fatalf("helper err=%v exit=%v received=%d", err, exitErr, received.Load())
	}
	if _, err := f.pool.Exec(ctx, `UPDATE notifications SET lease_expires_at=now()-interval '1 second' WHERE notification_id=$1`, res.NotificationID); err != nil {
		t.Fatal(err)
	}
	// Two independent recovery instances compete after the lease-owning worker
	// process has died. Advisory locking and row state must yield exactly one
	// recovery record.
	var recoveryWG sync.WaitGroup
	recoveredCounts := make(chan int, 2)
	recoveryErrors := make(chan error, 2)
	for range 2 {
		recoveryWG.Add(1)
		go func() {
			defer recoveryWG.Done()
			pool, openErr := pgxpool.New(ctx, f.pool.Config().ConnString())
			if openErr != nil {
				recoveryErrors <- openErr
				return
			}
			defer pool.Close()
			repo := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
			recovered, recoverErr := repo.RecoverExpiredLeases(ctx, systemActor(vendorID), 100)
			if recoverErr != nil {
				recoveryErrors <- recoverErr
				return
			}
			recoveredCounts <- len(recovered)
		}()
	}
	recoveryWG.Wait()
	close(recoveredCounts)
	close(recoveryErrors)
	for recoveryErr := range recoveryErrors {
		t.Fatal(recoveryErr)
	}
	totalRecovered := 0
	for count := range recoveredCounts {
		totalRecovered += count
	}
	if totalRecovered != 1 {
		t.Fatalf("two recovery instances recovered %d leases, want exactly 1", totalRecovered)
	}
	cfg := delivery.DefaultConfig()
	policy, err := delivery.NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := delivery.NewRunner(cfg, f.repo, acceptanceSnapshotReader{vendorID: vendorID}, integrationCredentialResolver{}, integrationDNSResolver{}, &callbackTransport{
		vendorURL: vendor.URL, notificationID: res.NotificationID,
	}, policy, delivery.RealClock{}, delivery.CryptoRNG{})
	if err != nil {
		t.Fatal(err)
	}
	if claimed, err := runner.RunOnce(ctx, worker); err != nil || !claimed {
		t.Fatalf("replacement worker claimed=%v err=%v", claimed, err)
	}
	status, err := f.repo.Get(ctx, operatorActor(vendorID), notificationstore.NotificationID(res.NotificationID))
	if err != nil || status.State != notificationstore.StateDelivered || status.AttemptCount != 2 || received.Load() != 2 {
		t.Fatalf("status=%+v received=%d err=%v", status, received.Load(), err)
	}
	history, err := f.repo.ListAttemptHistory(ctx, operatorActor(vendorID), notificationstore.NotificationID(res.NotificationID), 100, "")
	if err != nil || len(history.Items) != 4 || history.Items[1].EventKind != notificationstore.EventKindRecovery {
		t.Fatalf("history=%+v err=%v", history, err)
	}
}
