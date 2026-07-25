package postgres_test

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/testsupport"
	"rc_wsman/internal/vendorregistry"
	"rc_wsman/internal/vendorregistry/postgres"
)

func openVRPool(t *testing.T) *pgxpool.Pool {
	return testsupport.OpenPostgres(t)
}

func cleanVR(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// No global cleanup: tests isolate via unique owning scopes and vendor IDs
	// so parallel packages sharing the database never interfere. Append-only
	// tables (audit events, receipts, endpoint_versions) are never touched.
}

// shortID returns a compact unique token derived from the test name, safe for
// the length- and case-constrained vendor_id / owning_scope / actor columns.
func shortID(t *testing.T) string {
	t.Helper()
	h := fnv.New32a()
	_, _ = h.Write([]byte(fmt.Sprintf("%s-%d-%d", t.Name(), os.Getpid(), vendorTestSequence.Add(1))))
	return fmt.Sprintf("%08x", h.Sum32())
}

var vendorTestSequence atomic.Uint64

func uniqueActor(t *testing.T) string {
	t.Helper()
	return "actor-" + shortID(t)
}

func uniqueVendor(t *testing.T, suffix string) string {
	t.Helper()
	return "vendor-" + shortID(t) + suffix
}

func uniqueScope(t *testing.T) string {
	t.Helper()
	return "scope-" + shortID(t)
}

func endpointVersionFor(vendorID, actorID string) vendorregistry.EndpointVersion {
	return vendorregistry.EndpointVersion{
		VendorID:            vendorID,
		ConfigVersion:       1,
		ConfigSchemaVersion: 1,
		CanonicalURL:        "https://example.com/webhook",
		Method:              "POST",
		Hostname:            "example.com",
		Port:                443,
		TransportKind:       "https_public",
		TransportAuthHeaders: []vendorregistry.HeaderRule{
			{Kind: "literal", Name: "content-type", Value: "application/json"},
		},
		OutboundIdempotencyMapping: vendorregistry.OutboundIdempotencyMapping{Mode: "none"},
		EndpointPolicy: vendorregistry.EndpointPolicy{
			AllowedRequestHeaderNames:   []string{"content-type"},
			ForbiddenRequestHeaderNames: []string{},
			MaxRequestBodyBytes:         65536,
		},
		AuthStrategy:   "bearer",
		ResponsePolicy: vendorregistry.ResponsePolicyHTTPStatusV1,
		CredentialRef:  &vendorregistry.CredentialRef{Scheme: "env", OpaqueHandle: "VENDOR_A_TOKEN", ReferenceVersion: "v1"},
		CreatedByActor: actorID,
		CreatedAt:      time.Now(),
	}
}

func receiptAndAudit(vendorID, owningScope, actorID, operation string, revBefore, revAfter int64) (vendorregistry.AdminCommandReceipt, vendorregistry.AdminAuditEvent) {
	result := vendorregistry.AdminResult{Operation: operation, VendorID: vendorID, Lifecycle: vendorregistry.LifecycleDraft, RecordRevision: revAfter, CurrentConfigVersion: 1}
	receipt := vendorregistry.AdminCommandReceipt{
		ReceiptID:          "receipt-" + operation + "-" + vendorID,
		ActorID:            actorID,
		IdempotencyKey:     operation + "-idem-" + vendorID,
		CommandFingerprint: []byte("fp" + vendorID),
		Operation:          operation,
		VendorID:           vendorID,
		SafeResult:         result,
		RecordedAt:         time.Now(),
	}
	audit := vendorregistry.AdminAuditEvent{
		EventID:                "event-" + operation + "-" + vendorID,
		VendorID:               vendorID,
		OwningScope:            owningScope,
		ActorID:                actorID,
		AuthorizationBasis:     "owning_scope",
		Operation:              operation,
		Outcome:                "success",
		RecordRevisionAfter:    &revAfter,
		SanitizedRequestDigest: vendorregistry.SanitizedRequestDigest(operation, vendorID, revBefore),
		ReceiptID:              receipt.ReceiptID,
		OccurredAt:             time.Now(),
	}
	return receipt, audit
}

func TestPostgresRepository_RegisterVendor(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	cleanVR(t, pool)

	actor := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-a")

	repo := postgres.New(pool)
	ctx := context.Background()
	vendor := vendorregistry.VendorRecord{
		VendorID:             vendorID,
		OwningScope:          scope,
		Lifecycle:            vendorregistry.LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
		CreatedAt:            time.Now(),
	}
	receipt, audit := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpRegister, 0, 1)
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err != nil {
		t.Fatalf("register vendor: %v", err)
	}

	got, err := repo.GetVendor(ctx, vendorID)
	if err != nil {
		t.Fatalf("get vendor: %v", err)
	}
	if got.VendorID != vendorID {
		t.Fatalf("vendor id = %s, want %s", got.VendorID, vendorID)
	}
	if got.Lifecycle != vendorregistry.LifecycleDraft {
		t.Fatalf("lifecycle = %s, want draft", got.Lifecycle)
	}

	version, err := repo.GetEndpointVersion(ctx, vendorID, 1)
	if err != nil {
		t.Fatalf("get endpoint version: %v", err)
	}
	if version.Hostname != "example.com" {
		t.Fatalf("hostname = %s, want example.com", version.Hostname)
	}

	found, err := repo.FindReceipt(ctx, actor, vendorregistry.OpRegister+"-idem-"+vendorID)
	if err != nil {
		t.Fatalf("find receipt: %v", err)
	}
	if found.ReceiptID != "receipt-register-"+vendorID {
		t.Fatalf("receipt id = %s, want receipt-register-%s", found.ReceiptID, vendorID)
	}

	count, err := repo.CountAuditEvents(ctx, vendorID)
	if err != nil {
		t.Fatalf("count audit: %v", err)
	}
	if count != 1 {
		t.Fatalf("audit count = %d, want 1", count)
	}
}

func TestPostgresRepository_ReadsOptionalCredentialReferenceVersionWhenNull(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()

	ctx := context.Background()
	vendorID := uniqueVendor(t, "-nullable-ref")
	scope := uniqueScope(t)
	actor := uniqueActor(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (
			vendor_id, owning_scope, lifecycle, record_revision, current_config_version, activated_at
		) VALUES ($1, $2, 'active', 1, 1, clock_timestamp())`, vendorID, scope); err != nil {
		t.Fatalf("seed active vendor: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO endpoint_versions (
			vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port,
			transport_kind, auth_strategy, credential_ref_scheme, credential_ref_handle,
			transport_auth_headers, outbound_idempotency_mapping, endpoint_policy, created_by_actor
		) VALUES (
			$1, 1, 1, 'https://example.com/webhook', 'POST', 'example.com', 443,
			'https_public', 'bearer', 'env', 'VENDOR_A_TOKEN', '[]'::jsonb,
			'{"Mode":"none"}'::jsonb,
			'{"AllowedRequestHeaderNames":[],"ForbiddenRequestHeaderNames":[],"MaxRequestBodyBytes":65536}'::jsonb,
			$2
		)`, vendorID, actor); err != nil {
		t.Fatalf("seed endpoint with null credential_ref_version: %v", err)
	}

	repo := postgres.New(pool)
	version, err := repo.GetEndpointVersion(ctx, vendorID, 1)
	if err != nil || version.CredentialRef == nil || version.CredentialRef.ReferenceVersion != "" {
		t.Fatalf("get endpoint version=%+v err=%v", version.CredentialRef, err)
	}
	active, err := repo.ListActiveEndpointVersions(ctx)
	if err != nil {
		t.Fatalf("list active endpoint versions: %v", err)
	}
	found := false
	for _, item := range active {
		if item.VendorID == vendorID {
			found = true
			if item.CredentialRef == nil || item.CredentialRef.ReferenceVersion != "" {
				t.Fatalf("active reference version=%q, want empty", item.CredentialRef.ReferenceVersion)
			}
		}
	}
	if !found {
		t.Fatalf("active endpoint %s not returned", vendorID)
	}
	page, _, err := repo.ListEndpointVersions(ctx, vendorID, "", 10)
	if err != nil || len(page.Items) != 1 || page.Items[0].CredentialDescriptor.ReferenceVersion != "" {
		t.Fatalf("list endpoint versions=%+v err=%v", page, err)
	}
}

func TestPostgresRepository_ReadsSchemaV2NoneAuthWithNullCredential(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()

	ctx := context.Background()
	vendorID := uniqueVendor(t, "-none-auth")
	scope := uniqueScope(t)
	actor := uniqueActor(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (
			vendor_id, owning_scope, lifecycle, record_revision, current_config_version, activated_at
		) VALUES ($1, $2, 'active', 1, 1, clock_timestamp())`, vendorID, scope); err != nil {
		t.Fatalf("seed active vendor: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO endpoint_versions (
			vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port,
			transport_kind, auth_strategy, response_policy, credential_ref_scheme, credential_ref_handle,
			credential_ref_version, transport_auth_headers, outbound_idempotency_mapping, endpoint_policy,
			created_by_actor
		) VALUES (
			$1, 1, 2, 'https://example.com/webhook', 'POST', 'example.com', 443,
			'https_public', 'none', 'http_status_v1', NULL, NULL, NULL, '[]'::jsonb,
			'{"Mode":"headers","source":"ingress_idempotency_key","header_names":["idempotency-key","x-openslack-idempotency-key"]}'::jsonb,
			'{"AllowedRequestHeaderNames":["idempotency-key","x-openslack-idempotency-key"],"ForbiddenRequestHeaderNames":[],"MaxRequestBodyBytes":65536}'::jsonb,
			$2
		)`, vendorID, actor); err != nil {
		t.Fatalf("seed endpoint with no credential: %v", err)
	}

	repo := postgres.New(pool)
	version, err := repo.GetEndpointVersion(ctx, vendorID, 1)
	if err != nil {
		t.Fatalf("get endpoint version: %v", err)
	}
	if version.AuthStrategy != "none" || version.ResponsePolicy != vendorregistry.ResponsePolicyHTTPStatusV1 || version.CredentialRef != nil {
		t.Fatalf("nullable credential scan drifted: %+v", version)
	}
	if version.OutboundIdempotencyMapping.Mode != "headers" || version.OutboundIdempotencyMapping.Source != "ingress_idempotency_key" || len(version.OutboundIdempotencyMapping.HeaderNames) != 2 {
		t.Fatalf("schema v2 mapping scan drifted: %+v", version.OutboundIdempotencyMapping)
	}
	active, err := repo.ListActiveEndpointVersions(ctx)
	if err != nil {
		t.Fatalf("list active endpoint versions: %v", err)
	}
	found := false
	for _, item := range active {
		if item.VendorID == vendorID {
			found = true
			if item.CredentialRef != nil {
				t.Fatalf("active nullable credential=%+v, want zero value", item.CredentialRef)
			}
		}
	}
	if !found {
		t.Fatalf("active endpoint %s not returned", vendorID)
	}
	page, snapshotCap, err := repo.ListEndpointVersions(ctx, vendorID, "", 10)
	if err != nil || snapshotCap != 1 || len(page.Items) != 1 {
		t.Fatalf("list endpoint versions=%+v cap=%d err=%v", page, snapshotCap, err)
	}
	if page.Items[0].CredentialDescriptor != nil || page.Items[0].ResponsePolicy != vendorregistry.ResponsePolicyHTTPStatusV1 || page.Items[0].AuthStrategy != "none" {
		t.Fatalf("historical nullable credential drifted: %+v", page.Items[0])
	}
}

func TestPostgresRepository_RegisterVendor_Duplicate(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	cleanVR(t, pool)

	actor := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-a")

	repo := postgres.New(pool)
	ctx := context.Background()
	vendor := vendorregistry.VendorRecord{
		VendorID:             vendorID,
		OwningScope:          scope,
		Lifecycle:            vendorregistry.LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
		CreatedAt:            time.Now(),
	}
	receipt, audit := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpRegister, 0, 1)
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err == nil {
		t.Fatal("expected duplicate vendor_id to be rejected")
	}
}

func TestPostgresRepository_ListVendors(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	cleanVR(t, pool)

	actor := uniqueActor(t)
	scope := uniqueScope(t)

	repo := postgres.New(pool)
	ctx := context.Background()
	for i, id := range []string{uniqueVendor(t, "-a"), uniqueVendor(t, "-b")} {
		vendor := vendorregistry.VendorRecord{
			VendorID:             id,
			OwningScope:          scope,
			Lifecycle:            vendorregistry.LifecycleDraft,
			RecordRevision:       1,
			CurrentConfigVersion: 1,
			CreatedAt:            time.Now().Add(time.Duration(i) * time.Second),
		}
		v := endpointVersionFor(id, actor)
		receipt, audit := receiptAndAudit(id, scope, actor, vendorregistry.OpRegister, 0, 1)
		receipt.IdempotencyKey = "idem-" + id
		if err := repo.RegisterVendor(ctx, vendor, v, receipt, audit); err != nil {
			t.Fatalf("register %s: %v", id, err)
		}
	}

	page, err := repo.ListVendors(ctx, vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: []string{scope}}, "", 10)
	if err != nil {
		t.Fatalf("list vendors: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(page.Items))
	}
	if page.NextCursor != "" {
		t.Fatalf("expected no next cursor for 2 items, got %s", page.NextCursor)
	}
}

func TestPostgresRepository_CursorIsTamperEvidentAndScopeBound(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	repo := postgres.New(pool)
	ctx := context.Background()
	actor := uniqueActor(t)
	scope := uniqueScope(t)
	for i := 0; i < 3; i++ {
		id := uniqueVendor(t, fmt.Sprintf("-%d", i))
		vendor := vendorregistry.VendorRecord{VendorID: id, OwningScope: scope, Lifecycle: vendorregistry.LifecycleDraft, RecordRevision: 1, CurrentConfigVersion: 1, CreatedAt: time.Now().Add(time.Duration(i) * time.Second)}
		receipt, audit := receiptAndAudit(id, scope, actor, vendorregistry.OpRegister, 0, 1)
		if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(id, actor), receipt, audit); err != nil {
			t.Fatalf("register %d: %v", i, err)
		}
	}
	filter := vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: []string{scope}}
	first, err := repo.ListVendors(ctx, filter, "", 1)
	if err != nil || len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	second, err := repo.ListVendors(ctx, filter, first.NextCursor, 1)
	if err != nil || len(second.Items) != 1 {
		t.Fatalf("second page=%+v err=%v", second, err)
	}

	tampered := first.NextCursor[:len(first.NextCursor)-1] + "A"
	if tampered == first.NextCursor {
		tampered = first.NextCursor[:len(first.NextCursor)-1] + "B"
	}
	for name, call := range map[string]func() error{
		"tamper": func() error { _, err := repo.ListVendors(ctx, filter, tampered, 1); return err },
		"scope": func() error {
			_, err := repo.ListVendors(ctx, vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: []string{"other-scope"}}, first.NextCursor, 1)
			return err
		},
		"limit": func() error { _, err := repo.ListVendors(ctx, filter, first.NextCursor, 2); return err },
	} {
		if err := call(); !vendorregistry.IsReadError(err, vendorregistry.ReadErrInvalidCursor) {
			t.Fatalf("%s cursor returned %v", name, err)
		}
	}
}

func TestPostgresRepository_ListEndpointVersions(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	cleanVR(t, pool)

	actor := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-a")

	repo := postgres.New(pool)
	ctx := context.Background()
	vendor := vendorregistry.VendorRecord{
		VendorID:             vendorID,
		OwningScope:          scope,
		Lifecycle:            vendorregistry.LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
		CreatedAt:            time.Now(),
	}
	receipt, audit := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpRegister, 0, 1)
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err != nil {
		t.Fatalf("register vendor: %v", err)
	}

	page, cap, err := repo.ListEndpointVersions(ctx, vendorID, "", 10)
	if err != nil {
		t.Fatalf("list endpoint versions: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if cap != 1 {
		t.Fatalf("snapshot cap = %d, want 1", cap)
	}
}

func TestPostgresRepository_EndpointCursorFreezesSnapshotCap(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	repo := postgres.New(pool)
	ctx := context.Background()
	actor := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-versions")
	vendor := vendorregistry.VendorRecord{VendorID: vendorID, OwningScope: scope, Lifecycle: vendorregistry.LifecycleDraft, RecordRevision: 1, CurrentConfigVersion: 1, CreatedAt: time.Now()}
	receipt, audit := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpRegister, 0, 1)
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err != nil {
		t.Fatalf("register: %v", err)
	}

	appendVersion := func(configVersion, expectedRevision int64) {
		v := endpointVersionFor(vendorID, actor)
		v.ConfigVersion = configVersion
		v.CreatedAt = time.Now().Add(time.Duration(configVersion) * time.Second)
		r, a := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpUpdateVersion, expectedRevision, expectedRevision+1)
		r.ReceiptID = fmt.Sprintf("receipt-update-%s-v%d", vendorID, configVersion)
		r.IdempotencyKey = fmt.Sprintf("update-idem-%s-v%d", vendorID, configVersion)
		r.SafeResult.CurrentConfigVersion = configVersion
		a.ReceiptID = r.ReceiptID
		if err := repo.UpdateVersion(ctx, vendorID, expectedRevision, v, r, a); err != nil {
			t.Fatalf("append v%d: %v", configVersion, err)
		}
	}
	appendVersion(2, 1)
	first, cap, err := repo.ListEndpointVersions(ctx, vendorID, "", 1)
	if err != nil || cap != 2 || len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("first page=%+v cap=%d err=%v", first, cap, err)
	}
	appendVersion(3, 2)
	second, cap, err := repo.ListEndpointVersions(ctx, vendorID, first.NextCursor, 1)
	if err != nil || cap != 2 || len(second.Items) != 1 || second.Items[0].ConfigVersion != 2 || second.NextCursor != "" {
		t.Fatalf("frozen page=%+v cap=%d err=%v", second, cap, err)
	}
	fresh, cap, err := repo.ListEndpointVersions(ctx, vendorID, "", 10)
	if err != nil || cap != 3 || len(fresh.Items) != 3 {
		t.Fatalf("fresh traversal page=%+v cap=%d err=%v", fresh, cap, err)
	}
}

func TestPostgresRepository_ListAdminAuditEvents(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	cleanVR(t, pool)

	actor := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-a")

	repo := postgres.New(pool)
	ctx := context.Background()
	vendor := vendorregistry.VendorRecord{
		VendorID:             vendorID,
		OwningScope:          scope,
		Lifecycle:            vendorregistry.LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
		CreatedAt:            time.Now(),
	}
	receipt, audit := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpRegister, 0, 1)
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err != nil {
		t.Fatalf("register vendor: %v", err)
	}

	page, err := repo.ListAdminAuditEvents(ctx, vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: []string{scope}}, "", 10)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if page.SnapshotMaxSeq == nil || *page.SnapshotMaxSeq == 0 {
		t.Fatal("expected non-nil snapshot max seq")
	}
}

func TestPostgresRepository_EmptyAuditSnapshotUsesNull(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	repo := postgres.New(pool)
	page, err := repo.ListAdminAuditEvents(context.Background(), vendorregistry.ScopeFilter{}, "", 10)
	if err != nil {
		t.Fatalf("empty audit page: %v", err)
	}
	if len(page.Items) != 0 || page.SnapshotMaxSeq != nil || page.NextCursor != "" {
		t.Fatalf("empty page = %+v", page)
	}
}

func TestPostgresRepository_DescribeVendorState(t *testing.T) {
	pool := openVRPool(t)
	defer pool.Close()
	cleanVR(t, pool)

	actor := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-a")

	repo := postgres.New(pool)
	ctx := context.Background()
	vendor := vendorregistry.VendorRecord{
		VendorID:             vendorID,
		OwningScope:          scope,
		Lifecycle:            vendorregistry.LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
		CreatedAt:            time.Now(),
	}
	receipt, audit := receiptAndAudit(vendorID, scope, actor, vendorregistry.OpRegister, 0, 1)
	if err := repo.RegisterVendor(ctx, vendor, endpointVersionFor(vendorID, actor), receipt, audit); err != nil {
		t.Fatalf("register vendor: %v", err)
	}

	summary, err := repo.DescribeVendorState(ctx, vendorID)
	if err != nil {
		t.Fatalf("describe vendor state: %v", err)
	}
	if summary.VendorID != vendorID {
		t.Fatalf("vendor id = %s, want %s", summary.VendorID, vendorID)
	}
	if summary.ConfigVersionCount != 1 {
		t.Fatalf("config version count = %d, want 1", summary.ConfigVersionCount)
	}
	if summary.AuditEventCount != 1 {
		t.Fatalf("audit event count = %d, want 1", summary.AuditEventCount)
	}
}

func init() {
	_ = time.Now
}
