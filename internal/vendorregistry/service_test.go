package vendorregistry

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeRepo struct {
	vendors          map[string]VendorRecord
	versions         map[string]map[int64]EndpointVersion
	receipts         map[string]AdminCommandReceipt
	auditEvents      []AdminAuditEvent
	listVendorsPage  Page[VendorListItem]
	listVersionsPage Page[EndpointVersionListItem]
	listAuditPage    Page[AdminAuditListItem]
	lastVendorFilter ScopeFilter
	lastAuditFilter  ScopeFilter
	getVendorCalls   int
	auditInsertErr   error
	findReceiptErr   error
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		vendors:  make(map[string]VendorRecord),
		versions: make(map[string]map[int64]EndpointVersion),
		receipts: make(map[string]AdminCommandReceipt),
	}
}

func (r *fakeRepo) RegisterVendor(ctx context.Context, vendor VendorRecord, version EndpointVersion, receipt AdminCommandReceipt, audit AdminAuditEvent) error {
	if _, ok := r.vendors[vendor.VendorID]; ok {
		return AdminCommandError{Code: "VENDOR_ID_UNAVAILABLE"}
	}
	r.vendors[vendor.VendorID] = vendor
	r.versions[vendor.VendorID] = map[int64]EndpointVersion{1: version}
	r.receipts[receipt.IdempotencyKey] = receipt
	r.auditEvents = append(r.auditEvents, audit)
	return nil
}

func (r *fakeRepo) UpdateVersion(ctx context.Context, vendorID string, expectedRevision int64, version EndpointVersion, receipt AdminCommandReceipt, audit AdminAuditEvent) error {
	vendor, ok := r.vendors[vendorID]
	if !ok {
		return ReadError{Code: "VENDOR_NOT_FOUND"}
	}
	if vendor.RecordRevision != expectedRevision {
		return AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	vendor.RecordRevision++
	vendor.CurrentConfigVersion = version.ConfigVersion
	r.vendors[vendorID] = vendor
	r.versions[vendorID][version.ConfigVersion] = version
	r.receipts[receipt.IdempotencyKey] = receipt
	r.auditEvents = append(r.auditEvents, audit)
	return nil
}

func (r *fakeRepo) Activate(ctx context.Context, vendorID string, expectedRevision int64, receipt AdminCommandReceipt, audit AdminAuditEvent) error {
	vendor, ok := r.vendors[vendorID]
	if !ok {
		return ReadError{Code: "VENDOR_NOT_FOUND"}
	}
	if vendor.RecordRevision != expectedRevision {
		return AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	vendor.Lifecycle = LifecycleActive
	vendor.RecordRevision++
	r.vendors[vendorID] = vendor
	r.receipts[receipt.IdempotencyKey] = receipt
	r.auditEvents = append(r.auditEvents, audit)
	return nil
}

func (r *fakeRepo) Disable(ctx context.Context, vendorID string, expectedRevision int64, reason string, receipt AdminCommandReceipt, audit AdminAuditEvent) error {
	vendor, ok := r.vendors[vendorID]
	if !ok {
		return ReadError{Code: "VENDOR_NOT_FOUND"}
	}
	if vendor.RecordRevision != expectedRevision {
		return AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	vendor.Lifecycle = LifecycleDisabled
	vendor.RecordRevision++
	r.vendors[vendorID] = vendor
	r.receipts[receipt.IdempotencyKey] = receipt
	r.auditEvents = append(r.auditEvents, audit)
	return nil
}

func (r *fakeRepo) RotateCredentialRef(ctx context.Context, vendorID string, expectedRevision int64, version EndpointVersion, receipt AdminCommandReceipt, audit AdminAuditEvent) error {
	return r.UpdateVersion(ctx, vendorID, expectedRevision, version, receipt, audit)
}

func (r *fakeRepo) GetVendor(ctx context.Context, vendorID string) (VendorRecord, error) {
	r.getVendorCalls++
	vendor, ok := r.vendors[vendorID]
	if !ok {
		return VendorRecord{}, ReadError{Code: "VENDOR_NOT_FOUND"}
	}
	return vendor, nil
}

func (r *fakeRepo) GetEndpointVersion(ctx context.Context, vendorID string, configVersion int64) (EndpointVersion, error) {
	versions, ok := r.versions[vendorID]
	if !ok {
		return EndpointVersion{}, ReadError{Code: "VERSION_NOT_FOUND"}
	}
	v, ok := versions[configVersion]
	if !ok {
		return EndpointVersion{}, ReadError{Code: "VERSION_NOT_FOUND"}
	}
	return v, nil
}

func (r *fakeRepo) FindReceipt(ctx context.Context, actorID, idempotencyKey string) (AdminCommandReceipt, error) {
	if r.findReceiptErr != nil {
		return AdminCommandReceipt{}, r.findReceiptErr
	}
	receipt, ok := r.receipts[idempotencyKey]
	if !ok {
		return AdminCommandReceipt{}, ReadError{Code: "VENDOR_NOT_FOUND"}
	}
	return receipt, nil
}

func TestServiceEmitsOneSanitizedRuntimeEventForPreconditionAndStoreFailure(t *testing.T) {
	for name, arrange := range map[string]func(*fakeRepo, *AdminCommand){
		"precondition": func(_ *fakeRepo, command *AdminCommand) { command.VendorID = "SECRET-VENDOR" },
		"store": func(repo *fakeRepo, _ *AdminCommand) {
			repo.findReceiptErr = errors.New("database locator password=secret")
		},
	} {
		t.Run(name, func(t *testing.T) {
			repo := newFakeRepo()
			var events []SecurityEvent
			service, err := NewValidatedService(context.Background(), repo, DefaultConfig(), SecurityEventFunc(func(event SecurityEvent) { events = append(events, event) }))
			if err != nil {
				t.Fatal(err)
			}
			command := validRegisterInput()
			arrange(repo, &command)
			actor := ActorContext{Kind: ActorKindOperator, ActorID: "op-1", VendorScope: VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}}, Capabilities: []string{CapabilityRegister}}
			if _, err := service.ExecuteCommand(context.Background(), actor, command); err == nil {
				t.Fatal("expected command failure")
			}
			if len(events) != 1 || events[0].Name != "operation_failed" {
				t.Fatalf("events=%+v", events)
			}
			encoded := events[0].Name + events[0].Operation + events[0].FailureCode
			for _, forbidden := range []string{"SECRET-VENDOR", "team-a", "password", "secret", "credential"} {
				if strings.Contains(encoded, forbidden) {
					t.Fatalf("event leaked %q: %+v", forbidden, events[0])
				}
			}
		})
	}
}

func (r *fakeRepo) ListVendors(ctx context.Context, filter ScopeFilter, cursor string, limit int) (Page[VendorListItem], error) {
	r.lastVendorFilter = filter
	return r.listVendorsPage, nil
}

func (r *fakeRepo) ListEndpointVersions(ctx context.Context, vendorID string, cursor string, limit int) (Page[EndpointVersionListItem], int64, error) {
	return r.listVersionsPage, 1, nil
}

func (r *fakeRepo) ListAdminAuditEvents(ctx context.Context, filter ScopeFilter, cursor string, limit int) (Page[AdminAuditListItem], error) {
	r.lastAuditFilter = filter
	return r.listAuditPage, nil
}

func (r *fakeRepo) DescribeVendorState(ctx context.Context, vendorID string) (VendorStateSummary, error) {
	return VendorStateSummary{}, errors.New("not implemented")
}

func (r *fakeRepo) CountEndpointVersions(ctx context.Context, vendorID string) (int64, error) {
	return int64(len(r.versions[vendorID])), nil
}

func (r *fakeRepo) CountAuditEvents(ctx context.Context, vendorID string) (int64, error) {
	return int64(len(r.auditEvents)), nil
}

func (r *fakeRepo) ListActiveEndpointVersions(context.Context) ([]EndpointVersion, error) {
	var active []EndpointVersion
	for vendorID, vendor := range r.vendors {
		if vendor.Lifecycle != LifecycleActive {
			continue
		}
		if version, ok := r.versions[vendorID][vendor.CurrentConfigVersion]; ok {
			active = append(active, version)
		}
	}
	return active, nil
}

func (r *fakeRepo) InsertAuditEvent(ctx context.Context, audit AdminAuditEvent) error {
	if r.auditInsertErr != nil {
		return r.auditInsertErr
	}
	r.auditEvents = append(r.auditEvents, audit)
	return nil
}

func validRegisterInput() AdminCommand {
	return AdminCommand{
		Operation:              OpRegister,
		VendorID:               "vendor-a",
		ExpectedRecordRevision: 0,
		IdempotencyKey:         "idem-1",
		Body: map[string]any{
			"owning_scope": "team-a",
			"initial_config": map[string]any{
				"endpoint_target": map[string]any{
					"url": "https://example.com/webhook",
				},
				"method": "POST",
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
				"credential_ref": map[string]any{"scheme": "env", "opaque_handle": "VENDOR_A_TOKEN", "reference_version": "v1"},
			},
		},
	}
}

func validReplacementPolicy() map[string]any {
	return map[string]any{
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
		"auth_strategy": "bearer",
	}
}

func TestService_Register_Success(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}},
		Capabilities: []string{CapabilityRegister},
	}
	result, err := svc.ExecuteCommand(context.Background(), actor, validRegisterInput())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if result.VendorID != "vendor-a" {
		t.Fatalf("vendor id = %s, want vendor-a", result.VendorID)
	}
	if result.Lifecycle != LifecycleDraft {
		t.Fatalf("lifecycle = %s, want draft", result.Lifecycle)
	}
	if len(repo.auditEvents) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(repo.auditEvents))
	}
}

func TestService_Register_ForbiddenOwningScope(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-b"}},
		Capabilities: []string{CapabilityRegister},
	}
	cmd := validRegisterInput()
	_, err := svc.ExecuteCommand(context.Background(), actor, cmd)
	if !IsAdminCommandError(err, "FORBIDDEN") {
		t.Fatalf("expected forbidden, got %v", err)
	}
}

func TestService_Register_IdempotencyConflict(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}},
		Capabilities: []string{CapabilityRegister},
	}
	cmd := validRegisterInput()
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); err != nil {
		t.Fatalf("first register: %v", err)
	}
	cmd.Body = map[string]any{
		"owning_scope": "team-a",
		"initial_config": map[string]any{
			"endpoint_target":              map[string]any{"url": "https://different.com/webhook"},
			"method":                       "POST",
			"outbound_idempotency_mapping": map[string]any{"mode": "none"},
			"endpoint_policy": map[string]any{
				"allowed_request_header_names":   []any{},
				"forbidden_request_header_names": []any{},
				"max_request_body_bytes":         65536,
			},
			"auth_strategy":  "bearer",
			"credential_ref": map[string]any{"scheme": "env", "opaque_handle": "TOKEN", "reference_version": "v1"},
		},
	}
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); err == nil {
		t.Fatal("expected idempotency conflict")
	}
}

func TestService_Activate_Success(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}},
		Capabilities: []string{CapabilityRegister, CapabilityActivate},
	}
	if _, err := svc.ExecuteCommand(context.Background(), actor, validRegisterInput()); err != nil {
		t.Fatalf("register: %v", err)
	}
	cmd := AdminCommand{
		Operation:              OpActivate,
		VendorID:               "vendor-a",
		ExpectedRecordRevision: 1,
		IdempotencyKey:         "idem-activate",
		Body:                   map[string]any{},
	}
	result, err := svc.ExecuteCommand(context.Background(), actor, cmd)
	if err != nil {
		t.Fatalf("activate: %v", err)
	}
	if result.Lifecycle != LifecycleActive {
		t.Fatalf("lifecycle = %s, want active", result.Lifecycle)
	}
}

func TestService_Activate_InvalidTransition(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}},
		Capabilities: []string{CapabilityRegister, CapabilityActivate},
	}
	if _, err := svc.ExecuteCommand(context.Background(), actor, validRegisterInput()); err != nil {
		t.Fatalf("register: %v", err)
	}
	cmd := AdminCommand{
		Operation:              OpActivate,
		VendorID:               "vendor-a",
		ExpectedRecordRevision: 1,
		IdempotencyKey:         "idem-activate",
		Body:                   map[string]any{},
	}
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); err != nil {
		t.Fatalf("first activate: %v", err)
	}
	cmd.IdempotencyKey = "idem-activate-2"
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); err == nil {
		t.Fatal("expected invalid transition on second activate")
	}
}

func TestService_IsVendorActive(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindIngress,
		ActorID:      "ingress",
		VendorScope:  VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-a"}},
		Capabilities: []string{CapabilityReadActive},
	}
	active, err := svc.IsVendorActive(context.Background(), actor, "vendor-a")
	if err != nil {
		t.Fatalf("is active: %v", err)
	}
	if active {
		t.Fatal("expected inactive for missing vendor")
	}
}

func TestService_ListVendors_ForbiddenCapability(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "all"},
		Capabilities: []string{},
	}
	if _, err := svc.ListVendors(context.Background(), actor, ScopeFilter{}, "", 10); err == nil {
		t.Fatal("expected forbidden without read capability")
	}
}

func TestService_ListVendors_InvalidPageLimit(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "all"},
		Capabilities: []string{CapabilityRead},
	}
	if _, err := svc.ListVendors(context.Background(), actor, ScopeFilter{}, "", 1000); err == nil {
		t.Fatal("expected invalid page limit")
	}
}

func TestService_ListVendors_ForbiddenScopeFilter(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind:         ActorKindOperator,
		ActorID:      "op-1",
		VendorScope:  VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-a"}},
		Capabilities: []string{CapabilityRead},
	}
	filter := ScopeFilter{Kind: "vendor_ids", VendorIDs: []string{"vendor-b"}}
	if _, err := svc.ListVendors(context.Background(), actor, filter, "", 10); err == nil {
		t.Fatal("expected forbidden scope filter")
	}
}

func TestService_ListVendors_OmittedFilterAttenuatesToActorScope(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind: ActorKindAuditor, ActorID: "audit-1",
		VendorScope:  VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-a", "vendor-b"}},
		Capabilities: []string{CapabilityRead},
	}
	if _, err := svc.ListVendors(context.Background(), actor, ScopeFilter{}, "", 0); err != nil {
		t.Fatalf("list vendors: %v", err)
	}
	if repo.lastVendorFilter.Kind != "vendor_ids" || len(repo.lastVendorFilter.VendorIDs) != 2 {
		t.Fatalf("effective filter = %+v", repo.lastVendorFilter)
	}
}

func TestService_RejectsInvalidActorMatrixAndDuplicateScope(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	duplicateScope := ActorContext{
		Kind: ActorKindIngress, ActorID: "ingress-1",
		VendorScope:  VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-a", "vendor-a"}},
		Capabilities: []string{CapabilityReadActive},
	}
	if _, err := svc.IsVendorActive(context.Background(), duplicateScope, "vendor-a"); !IsReadError(err, ReadErrInvalidActorContext) {
		t.Fatalf("duplicate scope: %v", err)
	}
	operator := ActorContext{
		Kind: ActorKindOperator, ActorID: "op-1", VendorScope: VendorScope{Kind: "all"},
		Capabilities: []string{CapabilityReadActive},
	}
	if _, err := svc.IsVendorActive(context.Background(), operator, "vendor-a"); !IsReadError(err, ReadErrForbidden) {
		t.Fatalf("operator read-active: %v", err)
	}
	ingressAdmin := ActorContext{
		Kind: ActorKindIngress, ActorID: "ingress-1",
		VendorScope:  VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-a"}},
		Capabilities: []string{CapabilityActivate},
	}
	cmd := AdminCommand{Operation: OpActivate, VendorID: "vendor-a", ExpectedRecordRevision: 1, IdempotencyKey: "idem-a", Body: map[string]any{}}
	if _, err := svc.ExecuteCommand(context.Background(), ingressAdmin, cmd); !IsAdminCommandError(err, ErrForbidden) {
		t.Fatalf("ingress admin command: %v", err)
	}
}

func TestService_ReauthorizesBeforeReceiptReplay(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind: ActorKindOperator, ActorID: "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}},
		Capabilities: []string{CapabilityRegister},
	}
	cmd := validRegisterInput()
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); err != nil {
		t.Fatalf("initial register: %v", err)
	}
	actor.VendorScope.OwningScopes = []string{"team-b"}
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrForbidden) {
		t.Fatalf("revoked replay returned %v", err)
	}
	if len(repo.auditEvents) != 1 {
		t.Fatalf("revoked replay wrote audit; count=%d", len(repo.auditEvents))
	}
}

func TestService_AuthorizedBusinessRejectionsAreAuditedWithoutReceipt(t *testing.T) {
	t.Run("missing vendor", func(t *testing.T) {
		repo := newFakeRepo()
		svc := NewService(repo, DefaultConfig())
		actor := ActorContext{
			Kind: ActorKindOperator, ActorID: "op-1",
			VendorScope:  VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-missing"}},
			Capabilities: []string{CapabilityUpdate},
		}
		cmd := AdminCommand{Operation: OpUpdateVersion, VendorID: "vendor-missing", ExpectedRecordRevision: 1, IdempotencyKey: "idem-missing", Body: map[string]any{"replacement_policy": validReplacementPolicy()}}
		if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrVendorNotFound) {
			t.Fatalf("missing vendor: %v", err)
		}
		if len(repo.auditEvents) != 1 || repo.auditEvents[0].RejectReason != ErrVendorNotFound || len(repo.receipts) != 0 {
			t.Fatalf("audit=%+v receipts=%d", repo.auditEvents, len(repo.receipts))
		}
	})

	t.Run("register conflict", func(t *testing.T) {
		repo := newFakeRepo()
		svc := NewService(repo, DefaultConfig())
		actor := ActorContext{Kind: ActorKindOperator, ActorID: "op-1", VendorScope: VendorScope{Kind: "all"}, Capabilities: []string{CapabilityRegister}}
		cmd := validRegisterInput()
		if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); err != nil {
			t.Fatalf("register: %v", err)
		}
		cmd.IdempotencyKey = "idem-2"
		if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrVendorIDUnavailable) {
			t.Fatalf("conflict: %v", err)
		}
		if len(repo.auditEvents) != 2 || repo.auditEvents[1].Outcome != "rejected" || repo.auditEvents[1].RejectReason != ErrVendorIDUnavailable {
			t.Fatalf("audits=%+v", repo.auditEvents)
		}
		if len(repo.receipts) != 1 {
			t.Fatalf("rejected command created receipt; count=%d", len(repo.receipts))
		}
	})
}

func TestService_ClosedNestedSchemaAndAuditFailure(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{Kind: ActorKindOperator, ActorID: "op-1", VendorScope: VendorScope{Kind: "all"}, Capabilities: []string{CapabilityRegister}}
	cmd := validRegisterInput()
	config := cmd.Body["initial_config"].(map[string]any)
	config["unexpected"] = true
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrInvalidCommand) {
		t.Fatalf("nested unknown field: %v", err)
	}
	if len(repo.auditEvents) != 0 {
		t.Fatalf("schema rejection wrote audit: %+v", repo.auditEvents)
	}

	repo = newFakeRepo()
	repo.auditInsertErr = errors.New("database unavailable")
	svc = NewService(repo, DefaultConfig())
	cmd = validRegisterInput()
	cmd.Body["initial_config"].(map[string]any)["endpoint_target"] = map[string]any{"url": "http://example.com"}
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrCommitOutcomeUnknown) {
		t.Fatalf("audit persistence failure: %v", err)
	}
}

func TestService_RegisterRejectsOmittedRequiredEndpointCollections(t *testing.T) {
	for _, fieldPath := range []string{
		"transport_auth_headers",
		"endpoint_policy.allowed_request_header_names",
		"endpoint_policy.forbidden_request_header_names",
	} {
		t.Run(fieldPath, func(t *testing.T) {
			repo := newFakeRepo()
			svc := NewService(repo, DefaultConfig())
			actor := ActorContext{Kind: ActorKindOperator, ActorID: "op-1", VendorScope: VendorScope{Kind: "all"}, Capabilities: []string{CapabilityRegister}}
			cmd := validRegisterInput()
			config := cmd.Body["initial_config"].(map[string]any)
			if fieldPath == "transport_auth_headers" {
				delete(config, fieldPath)
			} else {
				delete(config["endpoint_policy"].(map[string]any), strings.TrimPrefix(fieldPath, "endpoint_policy."))
			}
			if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrInvalidCommand) {
				t.Fatalf("got %v, want %s", err, ErrInvalidCommand)
			}
			if len(repo.vendors) != 0 || len(repo.receipts) != 0 {
				t.Fatalf("omitted required field wrote state: vendors=%d receipts=%d", len(repo.vendors), len(repo.receipts))
			}
		})
	}
}

func TestService_UpdateRejectsCredentialFieldEvenWhenEmpty(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, DefaultConfig())
	actor := ActorContext{
		Kind: ActorKindOperator, ActorID: "op-1",
		VendorScope:  VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}},
		Capabilities: []string{CapabilityRegister, CapabilityUpdate},
	}
	if _, err := svc.ExecuteCommand(context.Background(), actor, validRegisterInput()); err != nil {
		t.Fatalf("register: %v", err)
	}
	replacement := validReplacementPolicy()
	replacement["credential_ref"] = map[string]any{}
	cmd := AdminCommand{Operation: OpUpdateVersion, VendorID: "vendor-a", ExpectedRecordRevision: 1, IdempotencyKey: "idem-update", Body: map[string]any{"replacement_policy": replacement}}
	if _, err := svc.ExecuteCommand(context.Background(), actor, cmd); !IsAdminCommandError(err, ErrInvalidCommand) {
		t.Fatalf("credential field: %v", err)
	}
	if len(repo.auditEvents) != 1 {
		t.Fatalf("schema rejection wrote audit; count=%d", len(repo.auditEvents))
	}
}

func init() {
	_ = time.Now
}
