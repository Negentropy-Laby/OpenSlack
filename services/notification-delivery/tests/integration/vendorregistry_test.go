package integration_test

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
	vendorregistrypostgres "rc_wsman/internal/vendorregistry/postgres"
)

var integrationVendorSequence atomic.Uint64

func TestVendorRegistry_EndToEnd_RegisterActivateDescribe(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	cleanVR(t, pool)

	repo := vendorregistrypostgres.New(pool)
	svc := vendorregistry.NewService(repo, vendorregistry.DefaultConfig())
	actorID := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-e2e")
	actor := vendorregistry.ActorContext{
		Kind:         vendorregistry.ActorKindOperator,
		ActorID:      actorID,
		VendorScope:  vendorregistry.VendorScope{Kind: "owning_scopes", OwningScopes: []string{scope}},
		Capabilities: []string{vendorregistry.CapabilityRegister, vendorregistry.CapabilityActivate, vendorregistry.CapabilityRead, vendorregistry.CapabilityReadActive},
	}

	registerCmd := vendorregistry.AdminCommand{
		Operation:              vendorregistry.OpRegister,
		VendorID:               vendorID,
		ExpectedRecordRevision: 0,
		IdempotencyKey:         "reg-idem-1",
		Body: map[string]any{
			"owning_scope": scope,
			"initial_config": map[string]any{
				"endpoint_target": map[string]any{"url": "https://example.com/webhook"},
				"method":          "POST",
				"transport_auth_headers": []any{
					map[string]any{"kind": "literal", "name": "content-type", "value": "application/json"},
				},
				"outbound_idempotency_mapping": map[string]any{"mode": "none"},
				"endpoint_policy": map[string]any{
					"allowed_request_header_names":   []any{"content-type"},
					"forbidden_request_header_names": []any{},
					"max_request_body_bytes":         65536,
				},
				"auth_strategy":  "bearer",
				"credential_ref": map[string]any{"scheme": "env", "opaque_handle": "VENDOR_E2E_TOKEN", "reference_version": "v1"},
			},
		},
	}
	result, err := svc.ExecuteCommand(ctx, actor, registerCmd)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if result.VendorID != vendorID {
		t.Fatalf("vendor id = %s, want %s", result.VendorID, vendorID)
	}
	if result.Lifecycle != vendorregistry.LifecycleDraft {
		t.Fatalf("lifecycle = %s, want draft", result.Lifecycle)
	}

	activateCmd := vendorregistry.AdminCommand{
		Operation:              vendorregistry.OpActivate,
		VendorID:               vendorID,
		ExpectedRecordRevision: 1,
		IdempotencyKey:         "act-idem-1",
		Body:                   map[string]any{},
	}
	result, err = svc.ExecuteCommand(ctx, actor, activateCmd)
	if err != nil {
		t.Fatalf("activate: %v", err)
	}
	if result.Lifecycle != vendorregistry.LifecycleActive {
		t.Fatalf("lifecycle = %s, want active", result.Lifecycle)
	}

	ingressActor := vendorregistry.ActorContext{
		Kind:         vendorregistry.ActorKindIngress,
		ActorID:      "ingress-" + actorID,
		VendorScope:  vendorregistry.VendorScope{Kind: "vendor_ids", VendorIDs: []string{vendorID}},
		Capabilities: []string{vendorregistry.CapabilityReadActive},
	}
	active, err := svc.IsVendorActive(ctx, ingressActor, vendorID)
	if err != nil {
		t.Fatalf("is active: %v", err)
	}
	if !active {
		t.Fatal("expected vendor to be active")
	}

	summary, err := svc.DescribeVendorState(ctx, actor, vendorID)
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if summary.VendorID != vendorID {
		t.Fatalf("summary vendor id = %s, want %s", summary.VendorID, vendorID)
	}
	if summary.ConfigVersionCount != 1 {
		t.Fatalf("config version count = %d, want 1", summary.ConfigVersionCount)
	}
	if summary.AuditEventCount < 2 {
		t.Fatalf("expected at least 2 audit events, got %d", summary.AuditEventCount)
	}
}

func TestVendorRegistry_EndToEnd_RegisterConflict(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	cleanVR(t, pool)

	repo := vendorregistrypostgres.New(pool)
	svc := vendorregistry.NewService(repo, vendorregistry.DefaultConfig())
	actorID := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-conflict")
	actor := vendorregistry.ActorContext{
		Kind:         vendorregistry.ActorKindOperator,
		ActorID:      actorID,
		VendorScope:  vendorregistry.VendorScope{Kind: "owning_scopes", OwningScopes: []string{scope}},
		Capabilities: []string{vendorregistry.CapabilityRegister},
	}

	cmd := vendorregistry.AdminCommand{
		Operation:              vendorregistry.OpRegister,
		VendorID:               vendorID,
		ExpectedRecordRevision: 0,
		IdempotencyKey:         "conflict-idem-1",
		Body: map[string]any{
			"owning_scope": scope,
			"initial_config": map[string]any{
				"endpoint_target":              map[string]any{"url": "https://example.com/webhook"},
				"method":                       "POST",
				"transport_auth_headers":       []any{},
				"outbound_idempotency_mapping": map[string]any{"mode": "none"},
				"endpoint_policy": map[string]any{
					"allowed_request_header_names":   []any{},
					"forbidden_request_header_names": []any{},
					"max_request_body_bytes":         65536,
				},
				"auth_strategy":  "bearer",
				"credential_ref": map[string]any{"scheme": "env", "opaque_handle": "TOKEN", "reference_version": "v1"},
			},
		},
	}
	if _, err := svc.ExecuteCommand(ctx, actor, cmd); err != nil {
		t.Fatalf("first register: %v", err)
	}
	cmd.IdempotencyKey = "conflict-idem-2"
	if _, err := svc.ExecuteCommand(ctx, actor, cmd); err == nil {
		t.Fatal("expected duplicate vendor_id to be rejected")
	}
}

func TestVendorRegistry_EndToEnd_ListAndAudit(t *testing.T) {
	ctx := context.Background()
	pool := testsupport.OpenPostgres(t)
	cleanVR(t, pool)

	repo := vendorregistrypostgres.New(pool)
	svc := vendorregistry.NewService(repo, vendorregistry.DefaultConfig())
	actorID := uniqueActor(t)
	scope := uniqueScope(t)
	vendorID := uniqueVendor(t, "-list")
	actor := vendorregistry.ActorContext{
		Kind:         vendorregistry.ActorKindOperator,
		ActorID:      actorID,
		VendorScope:  vendorregistry.VendorScope{Kind: "owning_scopes", OwningScopes: []string{scope}},
		Capabilities: []string{vendorregistry.CapabilityRegister, vendorregistry.CapabilityRead, vendorregistry.CapabilityReadAudit},
	}

	cmd := vendorregistry.AdminCommand{
		Operation:              vendorregistry.OpRegister,
		VendorID:               vendorID,
		ExpectedRecordRevision: 0,
		IdempotencyKey:         "list-idem-1",
		Body: map[string]any{
			"owning_scope": scope,
			"initial_config": map[string]any{
				"endpoint_target":              map[string]any{"url": "https://example.com/webhook"},
				"method":                       "POST",
				"transport_auth_headers":       []any{},
				"outbound_idempotency_mapping": map[string]any{"mode": "none"},
				"endpoint_policy": map[string]any{
					"allowed_request_header_names":   []any{},
					"forbidden_request_header_names": []any{},
					"max_request_body_bytes":         65536,
				},
				"auth_strategy":  "bearer",
				"credential_ref": map[string]any{"scheme": "env", "opaque_handle": "TOKEN", "reference_version": "v1"},
			},
		},
	}
	if _, err := svc.ExecuteCommand(ctx, actor, cmd); err != nil {
		t.Fatalf("register: %v", err)
	}

	page, err := svc.ListVendors(ctx, actor, vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: []string{scope}}, "", 10)
	if err != nil {
		t.Fatalf("list vendors: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}

	auditPage, err := svc.ListAdminAuditEvents(ctx, actor, vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: []string{scope}}, "", 10)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	if len(auditPage.Items) != 1 {
		t.Fatalf("audit items = %d, want 1", len(auditPage.Items))
	}
	if auditPage.SnapshotMaxSeq == nil || *auditPage.SnapshotMaxSeq == 0 {
		t.Fatal("expected non-zero snapshot max seq")
	}
}

func cleanVR(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// No global cleanup: tests isolate via unique owning scopes and vendor IDs
	// so parallel packages sharing the database never interfere. Append-only
	// tables (audit events, receipts, endpoint_versions) are never touched.
}

func shortID(t *testing.T) string {
	t.Helper()
	h := fnv.New32a()
	_, _ = h.Write([]byte(fmt.Sprintf("%s-%d-%d", t.Name(), os.Getpid(), integrationVendorSequence.Add(1))))
	return fmt.Sprintf("%08x", h.Sum32())
}

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

func init() {
	_ = time.Now
}
