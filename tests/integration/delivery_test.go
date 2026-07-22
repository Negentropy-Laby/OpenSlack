package integration_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/delivery"
	"rc_wsman/internal/notificationstore"
	notificationstorepostgres "rc_wsman/internal/notificationstore/postgres"
	"rc_wsman/internal/testsupport"
	"rc_wsman/internal/vendorregistry"
	vendorregistrypostgres "rc_wsman/internal/vendorregistry/postgres"
)

type integrationCredentialResolver struct{}

func (integrationCredentialResolver) Resolve(context.Context, vendorregistry.CredentialRef) (delivery.Credential, error) {
	return delivery.Credential{BearerToken: "integration-secret"}, nil
}

type recordingCredentialResolver struct {
	mu      sync.Mutex
	handles []string
}

func (r *recordingCredentialResolver) Resolve(_ context.Context, ref vendorregistry.CredentialRef) (delivery.Credential, error) {
	r.mu.Lock()
	r.handles = append(r.handles, ref.OpaqueHandle)
	r.mu.Unlock()
	return delivery.Credential{BearerToken: "token-for-" + ref.OpaqueHandle}, nil
}

type integrationDNSResolver struct{}

func (integrationDNSResolver) ResolveAll(context.Context, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
}

type integrationHTTPTransport struct{}

func (integrationHTTPTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusNoContent,
		Header:     make(http.Header),
		Body:       io.NopCloser(&emptyIntegrationBody{}),
	}, nil
}

type captureIntegrationTransport struct {
	body   []byte
	header http.Header
}

func (t *captureIntegrationTransport) Do(_ context.Context, req *http.Request, _ netip.Addr, _ time.Duration) (*http.Response, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	t.body = body
	t.header = req.Header.Clone()
	return &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header), Body: io.NopCloser(&emptyIntegrationBody{})}, nil
}

type sequenceIntegrationTransport struct {
	mu       sync.Mutex
	statuses []int
	calls    int
	after    func(int)
}

type deadlineIntegrationBarrierTransport struct {
	mu      sync.Mutex
	total   int
	started int
	clock   *integrationMutableClock
	cutoff  time.Time
	release chan struct{}
}

type blockingIntegrationTransport struct {
	once    sync.Once
	started chan struct{}
	release chan struct{}
	status  int
}

func (t *blockingIntegrationTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration) (*http.Response, error) {
	t.once.Do(func() { close(t.started) })
	<-t.release
	return &http.Response{StatusCode: t.status, Header: make(http.Header), Body: io.NopCloser(&emptyIntegrationBody{})}, nil
}

func (t *deadlineIntegrationBarrierTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration) (*http.Response, error) {
	t.mu.Lock()
	t.started++
	if t.started == t.total {
		t.clock.Set(t.cutoff)
		close(t.release)
	}
	t.mu.Unlock()
	<-t.release
	return &http.Response{StatusCode: http.StatusServiceUnavailable, Header: make(http.Header), Body: io.NopCloser(&emptyIntegrationBody{})}, nil
}

func (t *sequenceIntegrationTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration) (*http.Response, error) {
	t.mu.Lock()
	index := t.calls
	t.calls++
	status := t.statuses[index]
	after := t.after
	t.mu.Unlock()
	if after != nil {
		after(index + 1)
	}
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(&emptyIntegrationBody{})}, nil
}

type integrationMutableClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *integrationMutableClock) Now() time.Time    { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *integrationMutableClock) Set(now time.Time) { c.mu.Lock(); c.now = now; c.mu.Unlock() }

type emptyIntegrationBody struct{}

func (*emptyIntegrationBody) Read([]byte) (int, error) { return 0, io.EOF }

// TestDeliveryRunner_PostgresEndToEnd proves that Delivery composes the real
// Vendor Registry snapshot and Notification Store transaction boundaries: a
// pending row is claimed, sent once, atomically marked delivered, and recorded
// in append-only attempt history.
func TestDeliveryRunner_PostgresEndToEnd(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	const vendorID = "vendor-delivery-it"

	_, err := pool.Exec(ctx, `
		INSERT INTO vendors (
			vendor_id, owning_scope, lifecycle, record_revision, current_config_version
		) VALUES ($1, 'scope-delivery', 'active', 1, 1)
	`, vendorID)
	if err != nil {
		t.Fatalf("seed active vendor: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO endpoint_versions (
			vendor_id, config_version, config_schema_version, canonical_url,
			method, hostname, port, transport_kind, auth_strategy,
			credential_ref_scheme, credential_ref_handle, credential_ref_version,
			transport_auth_headers, outbound_idempotency_mapping, endpoint_policy,
			created_by_actor
		) VALUES (
			$1, 1, 1, 'https://vendor.example/hook',
			'POST', 'vendor.example', 443, 'https_public', 'bearer',
			'env', 'DELIVERY_IT_TOKEN', 'v1',
			'[]'::jsonb, '{"Mode":"none"}'::jsonb,
			'{"AllowedRequestHeaderNames":[],"ForbiddenRequestHeaderNames":[],"MaxRequestBodyBytes":4096}'::jsonb,
			'integration-test'
		)
	`, vendorID)
	if err != nil {
		t.Fatalf("seed endpoint version: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := notificationstorepostgres.New(pool, logger)
	accepted, err := store.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID:       "caller-delivery-it",
		VendorID:       vendorID,
		Payload:        []byte(`{"event":"paid"}`),
		IdempotencyKey: "delivery-it-key",
	})
	if err != nil {
		t.Fatalf("intake: %v", err)
	}

	cfg := delivery.DefaultConfig()
	policy, err := delivery.NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatalf("address policy: %v", err)
	}
	registry := vendorregistry.NewService(vendorregistrypostgres.New(pool), vendorregistry.DefaultConfig())
	runner, err := delivery.NewRunner(
		cfg,
		store,
		registry,
		integrationCredentialResolver{},
		integrationDNSResolver{},
		integrationHTTPTransport{},
		policy,
		delivery.RealClock{},
		delivery.CryptoRNG{},
	)
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	worker := notificationstore.ActorContext{
		Kind:        notificationstore.ActorWorker,
		ActorID:     "delivery-it-worker",
		VendorScope: []string{vendorID},
		Capabilities: []notificationstore.Capability{
			notificationstore.CapabilityClaimDelivery,
			notificationstore.CapabilityRecordDeliveryResult,
		},
	}
	claimed, err := runner.RunOnce(ctx, worker)
	if err != nil || !claimed {
		t.Fatalf("run once: claimed=%v err=%v", claimed, err)
	}

	operator := notificationstore.ActorContext{
		Kind:         notificationstore.ActorOperator,
		ActorID:      "delivery-it-operator",
		VendorScope:  []string{vendorID},
		Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications},
	}
	n, err := store.Get(ctx, operator, notificationstore.NotificationID(accepted.NotificationID))
	if err != nil {
		t.Fatalf("get delivered notification: %v", err)
	}
	if n.State != notificationstore.StateDelivered || n.AttemptCount != 1 || n.DeliveredAt == nil {
		t.Fatalf("delivered state: %+v", n)
	}
	history, err := store.ListAttemptHistory(ctx, operator, notificationstore.NotificationID(accepted.NotificationID), 20, "")
	if err != nil {
		t.Fatalf("attempt history: %v", err)
	}
	if len(history.Items) != 2 {
		t.Fatalf("attempt history length = %d, want claim+result", len(history.Items))
	}
	result := history.Items[1]
	if result.ResultKind != string(notificationstore.ResultKindHTTPResponse) || result.OutcomeClass != string(notificationstore.OutcomeClassSuccess) || result.HTTPStatus == nil || *result.HTTPStatus != http.StatusNoContent {
		t.Fatalf("delivery result history: %+v", result)
	}
}

func TestDeliveryRunnerSchemaV2PreservesIngressKeyAndExactBodyWithoutCredentialResolution(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	const vendorID = "vendor-delivery-v2-continuity"
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle, record_revision, current_config_version)
		VALUES ($1, 'scope-delivery', 'active', 1, 1)`, vendorID); err != nil {
		t.Fatalf("seed v2 vendor record: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO endpoint_versions (
			vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port,
			transport_kind, auth_strategy, response_policy, credential_ref_scheme, credential_ref_handle,
			credential_ref_version, transport_auth_headers, outbound_idempotency_mapping, endpoint_policy,
			created_by_actor
		) VALUES (
			$1, 1, 2, 'https://vendor.example/hook', 'POST', 'vendor.example', 443,
			'https_public', 'none', 'http_status_v1', NULL, NULL, NULL,
			'[{"Kind":"literal","Name":"content-type","Value":"application/octet-stream"}]'::jsonb,
			'{"Mode":"headers","source":"ingress_idempotency_key","header_names":["idempotency-key","x-openslack-idempotency-key"]}'::jsonb,
			'{"AllowedRequestHeaderNames":["content-type","idempotency-key","x-openslack-idempotency-key"],"ForbiddenRequestHeaderNames":[],"MaxRequestBodyBytes":4096}'::jsonb,
			'integration-test'
		)`, vendorID); err != nil {
		t.Fatalf("seed v2 endpoint: %v", err)
	}
	payload := []byte("exact\x00vendor\nbody")
	const ingressKey = "openslack-ingress-key"
	store := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := store.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID: "caller-v2-continuity", VendorID: vendorID, Payload: payload, IdempotencyKey: ingressKey,
	}); err != nil {
		t.Fatalf("intake: %v", err)
	}
	credentials := &recordingCredentialResolver{}
	transport := &captureIntegrationTransport{}
	registry := vendorregistry.NewService(vendorregistrypostgres.New(pool), vendorregistry.DefaultConfig())
	runner := newIntegrationRunner(t, store, registry, credentials, transport, delivery.RealClock{})
	worker := notificationstore.ActorContext{
		Kind: notificationstore.ActorWorker, ActorID: "worker-v2-continuity", VendorScope: []string{vendorID},
		Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult},
	}
	if claimed, err := runner.RunOnce(ctx, worker); err != nil || !claimed {
		t.Fatalf("run once: claimed=%v err=%v", claimed, err)
	}
	if string(transport.body) != string(payload) {
		t.Fatalf("vendor body changed: got %q want %q", transport.body, payload)
	}
	if transport.header.Get("Idempotency-Key") != ingressKey || transport.header.Get("X-OpenSlack-Idempotency-Key") != ingressKey {
		t.Fatalf("idempotency headers=%v", transport.header)
	}
	if transport.header.Get("Authorization") != "" {
		t.Fatalf("auth none emitted authorization header")
	}
	credentials.mu.Lock()
	defer credentials.mu.Unlock()
	if len(credentials.handles) != 0 {
		t.Fatalf("auth none resolved credentials: %v", credentials.handles)
	}
}

func seedDeliveryVendor(t *testing.T, pool *pgxpool.Pool, vendorID, credentialHandle string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO vendors (vendor_id,owning_scope,lifecycle,record_revision,current_config_version) VALUES ($1,'scope-delivery','active',1,1)`, vendorID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id,config_version,config_schema_version,canonical_url,method,hostname,port,transport_kind,auth_strategy,
		credential_ref_scheme,credential_ref_handle,credential_ref_version,transport_auth_headers,outbound_idempotency_mapping,endpoint_policy,created_by_actor
	) VALUES ($1,1,1,'https://vendor.example/hook','POST','vendor.example',443,'https_public','bearer','env',$2,'v1','[]'::jsonb,'{"Mode":"none"}'::jsonb,'{"AllowedRequestHeaderNames":[],"ForbiddenRequestHeaderNames":[],"MaxRequestBodyBytes":4096}'::jsonb,'integration-test')`, vendorID, credentialHandle); err != nil {
		t.Fatal(err)
	}
}

func newIntegrationRunner(t *testing.T, store notificationstore.Repository, registry *vendorregistry.Service, credentials delivery.CredentialResolver, transport delivery.HTTPTransport, clock delivery.Clock) *delivery.Runner {
	t.Helper()
	cfg := delivery.DefaultConfig()
	policy, err := delivery.NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := delivery.NewRunner(cfg, store, registry, credentials, integrationDNSResolver{}, transport, policy, clock, delivery.CryptoRNG{})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func TestDeliveryRunnerRefreshesCredentialVersionAndVendorDisableAcrossAttempts(t *testing.T) {
	for _, disable := range []bool{false, true} {
		t.Run(map[bool]string{false: "credential-rotation", true: "vendor-disable"}[disable], func(t *testing.T) {
			pool := testsupport.OpenPostgres(t)
			ctx := context.Background()
			vendorID := map[bool]string{false: "vendor-rotate-attempt", true: "vendor-disable-attempt"}[disable]
			seedDeliveryVendor(t, pool, vendorID, "TOKEN_V1")
			store := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
			accepted, err := store.Intake(ctx, notificationstore.ValidatedIntake{CallerID: "caller-" + vendorID, VendorID: vendorID, Payload: []byte(`{}`), IdempotencyKey: "key-" + vendorID})
			if err != nil {
				t.Fatal(err)
			}
			credentials := &recordingCredentialResolver{}
			transport := &sequenceIntegrationTransport{statuses: []int{503, 204}}
			registry := vendorregistry.NewService(vendorregistrypostgres.New(pool), vendorregistry.DefaultConfig())
			runner := newIntegrationRunner(t, store, registry, credentials, transport, delivery.RealClock{})
			worker := notificationstore.ActorContext{Kind: notificationstore.ActorWorker, ActorID: "worker-refresh", VendorScope: []string{vendorID}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult}}
			if claimed, err := runner.RunOnce(ctx, worker); err != nil || !claimed {
				t.Fatalf("first attempt claimed=%v err=%v", claimed, err)
			}
			if disable {
				if _, err := pool.Exec(ctx, `UPDATE vendors SET lifecycle='disabled',record_revision=record_revision+1,disabled_at=now(),disabled_reason='operator disabled' WHERE vendor_id=$1`, vendorID); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
					vendor_id,config_version,config_schema_version,canonical_url,method,hostname,port,transport_kind,
					endpoint_policy,transport_auth_headers,outbound_idempotency_mapping,auth_strategy,
					credential_ref_scheme,credential_ref_handle,credential_ref_version,created_by_actor,created_at
				) SELECT vendor_id,2,config_schema_version,canonical_url,method,hostname,port,transport_kind,
					endpoint_policy,transport_auth_headers,outbound_idempotency_mapping,auth_strategy,
					credential_ref_scheme,'TOKEN_V2','v2',created_by_actor,now()
				FROM endpoint_versions WHERE vendor_id=$1 AND config_version=1`, vendorID); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, `UPDATE vendors SET current_config_version=2,record_revision=record_revision+1 WHERE vendor_id=$1`, vendorID); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := pool.Exec(ctx, `UPDATE notifications SET next_attempt_at=now()-interval '1 second' WHERE notification_id=$1`, accepted.NotificationID); err != nil {
				t.Fatal(err)
			}
			if claimed, err := runner.RunOnce(ctx, worker); err != nil || !claimed {
				t.Fatalf("second attempt claimed=%v err=%v", claimed, err)
			}
			operator := notificationstore.ActorContext{Kind: notificationstore.ActorOperator, ActorID: "op-refresh", VendorScope: []string{vendorID}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications}}
			n, err := store.Get(ctx, operator, notificationstore.NotificationID(accepted.NotificationID))
			if err != nil {
				t.Fatal(err)
			}
			if disable {
				if n.State != notificationstore.StateDead || n.AttemptCount != 1 || n.DeadReason != notificationstore.ReasonVendorUnavailable || transport.calls != 1 {
					t.Fatalf("disabled result=%+v sends=%d", n, transport.calls)
				}
			} else {
				if n.State != notificationstore.StateDelivered || n.AttemptCount != 2 || transport.calls != 2 {
					t.Fatalf("rotated result=%+v sends=%d", n, transport.calls)
				}
				credentials.mu.Lock()
				handles := append([]string(nil), credentials.handles...)
				credentials.mu.Unlock()
				if len(handles) != 2 || handles[0] != "TOKEN_V1" || handles[1] != "TOKEN_V2" {
					t.Fatalf("credential handles=%v", handles)
				}
			}
		})
	}
}

func TestDeliveryRunnerCommitsCurrentHTTPResultWhenVendorDisabledAfterSend(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	vendorID := "vendor-disable-after-send"
	seedDeliveryVendor(t, pool, vendorID, "TOKEN_V1")
	store := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	accepted, err := store.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID: "caller-disable-after-send", VendorID: vendorID, Payload: []byte(`{}`), IdempotencyKey: "key-disable-after-send",
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := &blockingIntegrationTransport{started: make(chan struct{}), release: make(chan struct{}), status: http.StatusNoContent}
	registry := vendorregistry.NewService(vendorregistrypostgres.New(pool), vendorregistry.DefaultConfig())
	runner := newIntegrationRunner(t, store, registry, &recordingCredentialResolver{}, transport, delivery.RealClock{})
	worker := notificationstore.ActorContext{
		Kind: notificationstore.ActorWorker, ActorID: "worker-disable-after-send", VendorScope: []string{vendorID},
		Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult},
	}
	done := make(chan error, 1)
	go func() {
		claimed, runErr := runner.RunOnce(ctx, worker)
		if runErr == nil && !claimed {
			runErr = errors.New("runner did not claim notification")
		}
		done <- runErr
	}()
	select {
	case <-transport.started:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP attempt did not start")
	}
	if _, err := pool.Exec(ctx, `UPDATE vendors SET lifecycle='disabled', record_revision=record_revision+1, disabled_at=clock_timestamp(), disabled_reason='disabled after send' WHERE vendor_id=$1`, vendorID); err != nil {
		t.Fatal(err)
	}
	close(transport.release)
	if err := <-done; err != nil {
		t.Fatalf("runner after disable: %v", err)
	}
	operator := notificationstore.ActorContext{
		Kind: notificationstore.ActorOperator, ActorID: "op-disable-after-send", VendorScope: []string{vendorID},
		Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications},
	}
	n, err := store.Get(ctx, operator, notificationstore.NotificationID(accepted.NotificationID))
	if err != nil {
		t.Fatal(err)
	}
	if n.State != notificationstore.StateDelivered || n.AttemptCount != 1 || n.DeliveredAt == nil {
		t.Fatalf("current HTTP result was not committed after disable: %+v", n)
	}
	history, err := store.ListAttemptHistory(ctx, operator, notificationstore.NotificationID(accepted.NotificationID), 20, "")
	if err != nil || len(history.Items) != 2 {
		t.Fatalf("attempt history=%+v err=%v", history, err)
	}
	result := history.Items[1]
	if result.ResultKind != string(notificationstore.ResultKindHTTPResponse) || result.OutcomeClass != string(notificationstore.OutcomeClassSuccess) || result.HTTPStatus == nil || *result.HTTPStatus != http.StatusNoContent {
		t.Fatalf("current result history=%+v", result)
	}
}

func TestDeliveryRunnerPostgresB01PersistsDeadBeforeCycleDeadline(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	const vendorID = "vendor-b01-postgres"
	seedDeliveryVendor(t, pool, vendorID, "TOKEN_B01")
	store := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	accepted, err := store.Intake(ctx, notificationstore.ValidatedIntake{CallerID: "caller-b01", VendorID: vendorID, Payload: []byte(`{}`), IdempotencyKey: "key-b01"})
	if err != nil {
		t.Fatal(err)
	}
	cfg := delivery.DefaultConfig()
	var databaseNow time.Time
	if err := pool.QueryRow(ctx, `SELECT now()`).Scan(&databaseNow); err != nil {
		t.Fatal(err)
	}
	cycleStart := databaseNow.Add(-cfg.MaxAge).Add(cfg.HTTPHardTimeout).Add(cfg.ResultCommitMargin).Add(2 * time.Second)
	if _, err := pool.Exec(ctx, `UPDATE notifications SET delivery_cycle_started_at=$2 WHERE notification_id=$1`, accepted.NotificationID, cycleStart); err != nil {
		t.Fatal(err)
	}
	cutoff := cycleStart.Add(cfg.MaxAge).Add(-cfg.HTTPHardTimeout).Add(-cfg.ResultCommitMargin)
	clock := &integrationMutableClock{now: databaseNow}
	transport := &sequenceIntegrationTransport{statuses: []int{503}, after: func(int) { clock.Set(cutoff) }}
	registry := vendorregistry.NewService(vendorregistrypostgres.New(pool), vendorregistry.DefaultConfig())
	runner := newIntegrationRunner(t, store, registry, &recordingCredentialResolver{}, transport, clock)
	worker := notificationstore.ActorContext{Kind: notificationstore.ActorWorker, ActorID: "worker-b01", VendorScope: []string{vendorID}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult}}
	if claimed, err := runner.RunOnce(ctx, worker); err != nil || !claimed {
		t.Fatalf("run claimed=%v err=%v", claimed, err)
	}
	var state, reason string
	var attemptCount int
	var deadAt, storedCycleStart time.Time
	if err := pool.QueryRow(ctx, `SELECT state,attempt_count,dead_at,dead_reason,delivery_cycle_started_at FROM notifications WHERE notification_id=$1`, accepted.NotificationID).Scan(&state, &attemptCount, &deadAt, &reason, &storedCycleStart); err != nil {
		t.Fatal(err)
	}
	cycleDeadline := storedCycleStart.Add(cfg.MaxAge)
	if state != string(notificationstore.StateDead) || attemptCount != 1 || reason != notificationstore.ReasonDeadlineExceeded || deadAt.After(cycleDeadline) {
		t.Fatalf("B01 state=%s attempts=%d dead_at=%s deadline=%s reason=%s", state, attemptCount, deadAt, cycleDeadline, reason)
	}
}

func TestDeliveryRunnerPostgresDeadlineBacklogNWPersistsAllDeadBeforeDeadline(t *testing.T) {
	const workers = 5
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	const vendorID = "vendor-b01-postgres-nw"
	seedDeliveryVendor(t, pool, vendorID, "TOKEN_B01_NW")
	store := notificationstorepostgres.New(pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ids := make([]string, 0, workers)
	for i := 0; i < workers; i++ {
		accepted, err := store.Intake(ctx, notificationstore.ValidatedIntake{
			CallerID: "caller-b01-nw", VendorID: vendorID, Payload: []byte(`{}`),
			IdempotencyKey: "key-b01-nw-" + string(rune('a'+i)),
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, accepted.NotificationID)
	}
	cfg := delivery.DefaultConfig()
	var databaseNow time.Time
	if err := pool.QueryRow(ctx, `SELECT now()`).Scan(&databaseNow); err != nil {
		t.Fatal(err)
	}
	cycleStart := databaseNow.Add(-cfg.MaxAge).Add(cfg.HTTPHardTimeout).Add(cfg.ResultCommitMargin).Add(2 * time.Second)
	if _, err := pool.Exec(ctx, `UPDATE notifications SET delivery_cycle_started_at=$2 WHERE notification_id=ANY($1::text[])`, ids, cycleStart); err != nil {
		t.Fatal(err)
	}
	cutoff := cycleStart.Add(cfg.MaxAge).Add(-cfg.HTTPHardTimeout).Add(-cfg.ResultCommitMargin)
	clock := &integrationMutableClock{now: databaseNow}
	transport := &deadlineIntegrationBarrierTransport{total: workers, clock: clock, cutoff: cutoff, release: make(chan struct{})}
	registry := vendorregistry.NewService(vendorregistrypostgres.New(pool), vendorregistry.DefaultConfig())
	runner := newIntegrationRunner(t, store, registry, &recordingCredentialResolver{}, transport, clock)
	worker := notificationstore.ActorContext{Kind: notificationstore.ActorWorker, ActorID: "worker-b01-nw", VendorScope: []string{vendorID}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult}}
	var wg sync.WaitGroup
	errCh := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claimed, err := runner.RunOnce(ctx, worker)
			if err != nil {
				errCh <- err
				return
			}
			if !claimed {
				errCh <- notificationstore.ErrNoEligibleNotification
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	cycleDeadline := cycleStart.Add(cfg.MaxAge)
	var deadCount, countedAttempts, deadlineReasons, persistedBeforeDeadline int
	if err := pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE state='dead'),
		count(*) FILTER (WHERE attempt_count=1),
		count(*) FILTER (WHERE dead_reason='deadline_exceeded'),
		count(*) FILTER (WHERE dead_at IS NOT NULL AND dead_at <= $2)
		FROM notifications WHERE notification_id=ANY($1::text[])`, ids, cycleDeadline).Scan(&deadCount, &countedAttempts, &deadlineReasons, &persistedBeforeDeadline); err != nil {
		t.Fatal(err)
	}
	var claimEvents, resultEvents int
	if err := pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE event_kind='claimed'),
		count(*) FILTER (WHERE event_kind='outcome' AND result_kind='http_response' AND http_status=503 AND outcome_class='permanent_failure' AND reason='deadline_exceeded')
		FROM delivery_attempts WHERE notification_id=ANY($1::text[])`, ids).Scan(&claimEvents, &resultEvents); err != nil {
		t.Fatal(err)
	}
	if deadCount != workers || countedAttempts != workers || deadlineReasons != workers || persistedBeforeDeadline != workers || claimEvents != workers || resultEvents != workers || transport.started != workers {
		t.Fatalf("N=W persistence dead=%d attempts=%d reasons=%d before_deadline=%d claims=%d results=%d sends=%d", deadCount, countedAttempts, deadlineReasons, persistedBeforeDeadline, claimEvents, resultEvents, transport.started)
	}
	if claimed, err := runner.RunOnce(ctx, worker); err != nil || claimed {
		t.Fatalf("second claim claimed=%v err=%v", claimed, err)
	}
}
