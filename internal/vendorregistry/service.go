package vendorregistry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Service is the Vendor Registry boundary. It performs authorization,
// validation, idempotency, lifecycle checks and delegates persistence to the
// Repository.
type Service struct {
	repo          Repository
	cfgMu         sync.RWMutex
	cfg           Config
	cfgGeneration uint64
	fpSecret      []byte
	now           func() time.Time
	newID         func() string
	events        SecurityEventSink
}

// SecurityEvent is the closed, non-persistent runtime signal emitted for one
// failed admin command. It intentionally has no vendor, owner, credential,
// request body, fingerprint, or actor-scope fields.
type SecurityEvent struct {
	Name        string
	Operation   string
	FailureCode string
}

// SecurityEventSink receives sanitized runtime security events.
type SecurityEventSink interface{ Emit(SecurityEvent) }

// SecurityEventFunc adapts a function to SecurityEventSink.
type SecurityEventFunc func(SecurityEvent)

// Emit implements SecurityEventSink.
func (f SecurityEventFunc) Emit(event SecurityEvent) { f(event) }

type discardSecurityEvents struct{}

func (discardSecurityEvents) Emit(SecurityEvent) {}

// NewService builds a Vendor Registry service.
func NewService(repo Repository, cfg Config) *Service {
	return &Service{
		repo:          repo,
		cfg:           cloneConfig(cfg),
		cfgGeneration: 1,
		fpSecret:      randomBytes(32),
		now:           time.Now,
		newID:         newID,
		events:        discardSecurityEvents{},
	}
}

// NewValidatedService validates required configuration and all active endpoint
// data before making generation 1 available to the composition root.
func NewValidatedService(ctx context.Context, repo Repository, cfg Config, events SecurityEventSink) (*Service, error) {
	service := NewService(repo, cfg)
	if events != nil {
		service.events = events
	}
	if err := service.preflightConfig(ctx, cfg); err != nil {
		return nil, err
	}
	return service, nil
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func newID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// AdminCommand is the wire envelope for a vendor administration command.
type AdminCommand struct {
	Operation              string
	VendorID               string
	ExpectedRecordRevision int64
	IdempotencyKey         string
	Body                   map[string]any
}

// ExecuteCommand processes a closed admin command and returns the AdminResult.
func (s *Service) ExecuteCommand(ctx context.Context, actor ActorContext, cmd AdminCommand) (result AdminResult, returnErr error) {
	defer func() {
		if returnErr != nil {
			s.events.Emit(SecurityEvent{Name: "operation_failed", Operation: sanitizedOperation(cmd.Operation), FailureCode: sanitizedFailureCode(returnErr)})
		}
	}()
	if err := validateActorContext(actor); err != nil {
		return AdminResult{}, err
	}
	if err := ValidateAdminCommand(cmd.Operation, cmd.VendorID, cmd.ExpectedRecordRevision, cmd.IdempotencyKey, cmd.Body); err != nil {
		return AdminResult{}, err
	}
	requiredCap, allowedScopeKinds := opCapabilityAndScope(cmd.Operation)
	if actor.Kind != ActorKindOperator && actor.Kind != ActorKindSystem {
		return AdminResult{}, AdminCommandError{Code: "FORBIDDEN", Err: errors.New("actor kind not allowed for admin command")}
	}
	if !actor.HasCapability(requiredCap) {
		return AdminResult{}, AdminCommandError{Code: "FORBIDDEN", Err: errors.New("missing capability")}
	}
	if err := checkScopeKind(actor.VendorScope, allowedScopeKinds); err != nil {
		return AdminResult{}, err
	}
	if err := s.authorizeCommandScope(ctx, actor, cmd); err != nil {
		return AdminResult{}, err
	}

	receipt, err := s.repo.FindReceipt(ctx, actor.ActorID, cmd.IdempotencyKey)
	if err == nil {
		fp := ComputeFingerprint(s.fpSecret, cmd.Operation, cmd.VendorID, cmd.ExpectedRecordRevision, cmd.Body)
		if VerifyFingerprint(receipt.CommandFingerprint, fp) {
			return receipt.SafeResult, nil
		}
		return AdminResult{}, AdminCommandError{Code: "IDEMPOTENCY_CONFLICT"}
	}
	if !isNotFound(err) {
		return AdminResult{}, AdminCommandError{Code: "COMMIT_OUTCOME_UNKNOWN", Err: err}
	}

	switch cmd.Operation {
	case OpRegister:
		result, err = s.register(ctx, actor, cmd)
	case OpUpdateVersion:
		result, err = s.updateVersion(ctx, actor, cmd)
	case OpActivate:
		result, err = s.activate(ctx, actor, cmd)
	case OpDisable:
		result, err = s.disable(ctx, actor, cmd)
	case OpRotateCredentialRef:
		result, err = s.rotateCredentialRef(ctx, actor, cmd)
	default:
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: fmt.Errorf("unknown operation %s", cmd.Operation)}
	}
	if err == nil {
		return result, nil
	}
	var commandErr AdminCommandError
	if errors.As(err, &commandErr) && isAuditedBusinessRejection(commandErr.Code) {
		if auditErr := s.persistBusinessRejection(ctx, actor, cmd, commandErr.Code); auditErr != nil {
			return AdminResult{}, auditErr
		}
	}
	return AdminResult{}, err
}

func sanitizedOperation(operation string) string {
	switch operation {
	case OpRegister, OpUpdateVersion, OpActivate, OpDisable, OpRotateCredentialRef:
		return operation
	default:
		return "unknown"
	}
}

func sanitizedFailureCode(err error) string {
	var commandErr AdminCommandError
	if errors.As(err, &commandErr) && commandErr.Code != "" {
		return commandErr.Code
	}
	var readErr ReadError
	if errors.As(err, &readErr) && readErr.Code != "" {
		return readErr.Code
	}
	return "INTERNAL_FAILURE"
}

func (s *Service) authorizeCommandScope(ctx context.Context, actor ActorContext, cmd AdminCommand) error {
	switch actor.VendorScope.Kind {
	case "all":
		return nil
	case "vendor_ids":
		if !actor.VendorScope.CoversVendorID(cmd.VendorID) {
			return AdminCommandError{Code: "FORBIDDEN", Err: errors.New("vendor_id outside scope")}
		}
		return nil
	case "owning_scopes":
		if cmd.Operation == OpRegister {
			owningScope, _ := cmd.Body["owning_scope"].(string)
			if !actor.VendorScope.CoversOwningScope(owningScope) {
				return AdminCommandError{Code: "FORBIDDEN", Err: errors.New("owning_scope outside scope")}
			}
			return nil
		}
		vendor, err := s.repo.GetVendor(ctx, cmd.VendorID)
		if err != nil {
			if isNotFound(err) {
				return AdminCommandError{Code: "VENDOR_NOT_FOUND"}
			}
			return AdminCommandError{Code: "COMMIT_OUTCOME_UNKNOWN", Err: err}
		}
		if !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
			return AdminCommandError{Code: "VENDOR_NOT_FOUND"}
		}
		return nil
	default:
		return AdminCommandError{Code: "INVALID_ACTOR_CONTEXT"}
	}
}

func opCapabilityAndScope(op string) (string, []string) {
	switch op {
	case OpRegister:
		return CapabilityRegister, []string{"owning_scopes", "all"}
	case OpUpdateVersion:
		return CapabilityUpdate, []string{"vendor_ids", "owning_scopes", "all"}
	case OpActivate:
		return CapabilityActivate, []string{"vendor_ids", "owning_scopes", "all"}
	case OpDisable:
		return CapabilityDisable, []string{"vendor_ids", "owning_scopes", "all"}
	case OpRotateCredentialRef:
		return CapabilityRotateCredentialRef, []string{"vendor_ids", "owning_scopes", "all"}
	}
	return "", nil
}

func checkScopeKind(scope VendorScope, allowed []string) error {
	for _, a := range allowed {
		if scope.Kind == a {
			return nil
		}
	}
	return AdminCommandError{Code: "FORBIDDEN", Err: errors.New("scope kind not allowed for operation")}
}

func validateActorContext(actor ActorContext) error {
	if actor.ActorID == "" {
		return AdminCommandError{Code: "INVALID_ACTOR_CONTEXT", Err: errors.New("missing actor_id")}
	}
	switch actor.Kind {
	case ActorKindIngress, ActorKindDelivery, ActorKindOperator, ActorKindAuditor, ActorKindSystem:
	default:
		return AdminCommandError{Code: "INVALID_ACTOR_CONTEXT", Err: fmt.Errorf("invalid kind %s", actor.Kind)}
	}
	if err := validateScope(actor.VendorScope); err != nil {
		return AdminCommandError{Code: "INVALID_ACTOR_CONTEXT", Err: err}
	}
	if actor.Kind == ActorKindIngress && actor.VendorScope.Kind != "vendor_ids" {
		return AdminCommandError{Code: "INVALID_ACTOR_CONTEXT", Err: errors.New("ingress requires vendor_ids scope")}
	}
	if actor.Kind == ActorKindDelivery && actor.VendorScope.Kind != "vendor_ids" && actor.VendorScope.Kind != "all" {
		return AdminCommandError{Code: "INVALID_ACTOR_CONTEXT", Err: errors.New("delivery scope kind invalid")}
	}
	return nil
}

func validateScope(scope VendorScope) error {
	switch scope.Kind {
	case "":
		return errors.New("empty scope kind")
	case "all":
		return nil
	case "vendor_ids":
		if len(scope.VendorIDs) == 0 || len(scope.VendorIDs) > 32 {
			return errors.New("vendor_ids scope size invalid")
		}
		seen := make(map[string]struct{}, len(scope.VendorIDs))
		for _, v := range scope.VendorIDs {
			if !vendorIDRegex.MatchString(v) {
				return fmt.Errorf("vendor_id invalid: %s", v)
			}
			if _, duplicate := seen[v]; duplicate {
				return fmt.Errorf("duplicate vendor_id: %s", v)
			}
			seen[v] = struct{}{}
		}
	case "owning_scopes":
		if len(scope.OwningScopes) == 0 || len(scope.OwningScopes) > 32 {
			return errors.New("owning_scopes scope size invalid")
		}
		seen := make(map[string]struct{}, len(scope.OwningScopes))
		for _, o := range scope.OwningScopes {
			if !owningScopeRegex.MatchString(o) {
				return fmt.Errorf("owning_scope invalid: %s", o)
			}
			if _, duplicate := seen[o]; duplicate {
				return fmt.Errorf("duplicate owning_scope: %s", o)
			}
			seen[o] = struct{}{}
		}
	default:
		return fmt.Errorf("invalid scope kind: %s", scope.Kind)
	}
	return nil
}

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return true
	}
	var re ReadError
	if errors.As(err, &re) {
		return re.Code == "VENDOR_NOT_FOUND" || re.Code == "VENDOR_INACTIVE_OR_UNKNOWN"
	}
	return false
}

func (s *Service) register(ctx context.Context, actor ActorContext, cmd AdminCommand) (AdminResult, error) {
	owningScope, ok := cmd.Body["owning_scope"].(string)
	if !ok || !owningScopeRegex.MatchString(owningScope) {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("owning_scope invalid")}
	}
	if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(owningScope) {
		return AdminResult{}, AdminCommandError{Code: "FORBIDDEN", Err: errors.New("owning_scope outside actor scope")}
	}
	configAny, ok := cmd.Body["initial_config"]
	if !ok {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("missing initial_config")}
	}
	var epInput EndpointConfigInput
	if err := decodeStrict(configAny, &epInput); err != nil {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: err}
	}
	version, err := ValidateEndpointConfig(s.currentConfig(), epInput)
	if err != nil {
		return AdminResult{}, err
	}
	version.VendorID = cmd.VendorID
	version.ConfigVersion = 1
	version.ConfigSchemaVersion = 1
	version.ResponsePolicy = ResponsePolicyHTTPStatusV1
	version.CreatedByActor = actor.ActorID
	version.CreatedAt = s.now()

	vendor := VendorRecord{
		VendorID:             cmd.VendorID,
		OwningScope:          owningScope,
		Lifecycle:            LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
		CreatedAt:            s.now(),
	}
	result := AdminResult{
		Operation:            OpRegister,
		VendorID:             cmd.VendorID,
		Lifecycle:            LifecycleDraft,
		RecordRevision:       1,
		CurrentConfigVersion: 1,
	}
	receipt := s.newReceipt(actor, cmd, result)
	audit := AdminAuditEvent{
		EventID:                s.newID(),
		VendorID:               cmd.VendorID,
		OwningScope:            owningScope,
		ActorID:                actor.ActorID,
		AuthorizationBasis:     authorizationBasis(actor.VendorScope),
		Operation:              OpRegister,
		Outcome:                "success",
		RecordRevisionAfter:    ptrInt64(1),
		SanitizedRequestDigest: SanitizedRequestDigest(OpRegister, cmd.VendorID, 0),
		ReceiptID:              receipt.ReceiptID,
		OccurredAt:             s.now(),
	}
	if err := s.repo.RegisterVendor(ctx, vendor, version, receipt, audit); err != nil {
		return AdminResult{}, mapRepoError(err)
	}
	return result, nil
}

func (s *Service) updateVersion(ctx context.Context, actor ActorContext, cmd AdminCommand) (AdminResult, error) {
	vendor, err := s.loadAuthorizedVendor(ctx, actor, cmd.VendorID)
	if err != nil {
		return AdminResult{}, err
	}
	if vendor.Lifecycle == LifecycleDisabled {
		return AdminResult{}, AdminCommandError{Code: "VENDOR_DISABLED_UPDATE_FORBIDDEN"}
	}
	if cmd.ExpectedRecordRevision != vendor.RecordRevision {
		return AdminResult{}, AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	configAny, ok := cmd.Body["replacement_policy"]
	if !ok {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("missing replacement_policy")}
	}
	if objectHasKey(configAny, "credential_ref") {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("update_version must not include credential_ref")}
	}
	var epInput EndpointConfigInput
	if err := decodeStrict(configAny, &epInput); err != nil {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: err}
	}
	current, err := s.repo.GetEndpointVersion(ctx, cmd.VendorID, vendor.CurrentConfigVersion)
	if err != nil {
		return AdminResult{}, AdminCommandError{Code: "COMMIT_OUTCOME_UNKNOWN", Err: err}
	}
	if current.CredentialRef == nil {
		return AdminResult{}, AdminCommandError{Code: "INVALID_CREDENTIAL_REF", Err: errors.New("current endpoint has no credential reference")}
	}
	epInput.CredentialRef = CredentialRefInput{
		Scheme:           current.CredentialRef.Scheme,
		OpaqueHandle:     current.CredentialRef.OpaqueHandle,
		ReferenceVersion: current.CredentialRef.ReferenceVersion,
	}
	version, err := ValidateEndpointConfig(s.currentConfig(), epInput)
	if err != nil {
		return AdminResult{}, err
	}
	version.VendorID = cmd.VendorID
	version.ConfigVersion = vendor.CurrentConfigVersion + 1
	version.ConfigSchemaVersion = 1
	version.ResponsePolicy = ResponsePolicyHTTPStatusV1
	version.CreatedByActor = actor.ActorID
	version.CreatedAt = s.now()

	result := AdminResult{
		Operation:            OpUpdateVersion,
		VendorID:             cmd.VendorID,
		Lifecycle:            vendor.Lifecycle,
		RecordRevision:       vendor.RecordRevision + 1,
		CurrentConfigVersion: version.ConfigVersion,
	}
	receipt := s.newReceipt(actor, cmd, result)
	audit := s.successAudit(actor, vendor, cmd, result, receipt.ReceiptID)
	if err := s.repo.UpdateVersion(ctx, cmd.VendorID, cmd.ExpectedRecordRevision, version, receipt, audit); err != nil {
		return AdminResult{}, mapRepoError(err)
	}
	return result, nil
}

func (s *Service) activate(ctx context.Context, actor ActorContext, cmd AdminCommand) (AdminResult, error) {
	vendor, err := s.loadAuthorizedVendor(ctx, actor, cmd.VendorID)
	if err != nil {
		return AdminResult{}, err
	}
	if cmd.ExpectedRecordRevision != vendor.RecordRevision {
		return AdminResult{}, AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	if vendor.Lifecycle != LifecycleDraft {
		return AdminResult{}, AdminCommandError{Code: "INVALID_TRANSITION"}
	}
	result := AdminResult{
		Operation:            OpActivate,
		VendorID:             cmd.VendorID,
		Lifecycle:            LifecycleActive,
		RecordRevision:       vendor.RecordRevision + 1,
		CurrentConfigVersion: vendor.CurrentConfigVersion,
	}
	receipt := s.newReceipt(actor, cmd, result)
	audit := s.successAudit(actor, vendor, cmd, result, receipt.ReceiptID)
	if err := s.repo.Activate(ctx, cmd.VendorID, cmd.ExpectedRecordRevision, receipt, audit); err != nil {
		return AdminResult{}, mapRepoError(err)
	}
	return result, nil
}

func (s *Service) disable(ctx context.Context, actor ActorContext, cmd AdminCommand) (AdminResult, error) {
	vendor, err := s.loadAuthorizedVendor(ctx, actor, cmd.VendorID)
	if err != nil {
		return AdminResult{}, err
	}
	if cmd.ExpectedRecordRevision != vendor.RecordRevision {
		return AdminResult{}, AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	if vendor.Lifecycle == LifecycleDisabled {
		return AdminResult{}, AdminCommandError{Code: "INVALID_TRANSITION"}
	}
	reason, ok := cmd.Body["reason"].(string)
	if !ok || !disableReasonRegex.MatchString(reason) || len(reason) > 1024 {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("disable reason invalid")}
	}
	result := AdminResult{
		Operation:            OpDisable,
		VendorID:             cmd.VendorID,
		Lifecycle:            LifecycleDisabled,
		RecordRevision:       vendor.RecordRevision + 1,
		CurrentConfigVersion: vendor.CurrentConfigVersion,
	}
	receipt := s.newReceipt(actor, cmd, result)
	audit := s.successAudit(actor, vendor, cmd, result, receipt.ReceiptID)
	if err := s.repo.Disable(ctx, cmd.VendorID, cmd.ExpectedRecordRevision, reason, receipt, audit); err != nil {
		return AdminResult{}, mapRepoError(err)
	}
	return result, nil
}

func (s *Service) rotateCredentialRef(ctx context.Context, actor ActorContext, cmd AdminCommand) (AdminResult, error) {
	vendor, err := s.loadAuthorizedVendor(ctx, actor, cmd.VendorID)
	if err != nil {
		return AdminResult{}, err
	}
	if vendor.Lifecycle == LifecycleDisabled {
		return AdminResult{}, AdminCommandError{Code: "VENDOR_DISABLED_UPDATE_FORBIDDEN"}
	}
	if cmd.ExpectedRecordRevision != vendor.RecordRevision {
		return AdminResult{}, AdminCommandError{Code: "EXPECTED_VERSION_MISMATCH"}
	}
	crefAny, ok := cmd.Body["new_credential_ref"]
	if !ok {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("missing new_credential_ref")}
	}
	var crefInput CredentialRefInput
	if err := decodeStrict(crefAny, &crefInput); err != nil {
		return AdminResult{}, AdminCommandError{Code: "INVALID_COMMAND", Err: err}
	}
	if _, ok := s.currentConfig().CredentialRefSchemeAllowlist[crefInput.Scheme]; !ok {
		return AdminResult{}, AdminCommandError{Code: "INVALID_CREDENTIAL_REF", Err: fmt.Errorf("scheme %s not allowed", crefInput.Scheme)}
	}
	if crefInput.Scheme == "env" && !credentialHandleRegex.MatchString(crefInput.OpaqueHandle) {
		return AdminResult{}, AdminCommandError{Code: "INVALID_CREDENTIAL_REF", Err: errors.New("opaque_handle invalid")}
	}
	current, err := s.repo.GetEndpointVersion(ctx, cmd.VendorID, vendor.CurrentConfigVersion)
	if err != nil {
		return AdminResult{}, AdminCommandError{Code: "COMMIT_OUTCOME_UNKNOWN", Err: err}
	}
	if current.CredentialRef == nil {
		return AdminResult{}, AdminCommandError{Code: "INVALID_CREDENTIAL_REF", Err: errors.New("current endpoint has no credential reference")}
	}
	version := EndpointVersion{
		VendorID:                   cmd.VendorID,
		ConfigVersion:              vendor.CurrentConfigVersion + 1,
		ConfigSchemaVersion:        1,
		CanonicalURL:               current.CanonicalURL,
		Method:                     current.Method,
		Hostname:                   current.Hostname,
		Port:                       current.Port,
		TransportKind:              current.TransportKind,
		CIDRException:              current.CIDRException,
		TransportAuthHeaders:       current.TransportAuthHeaders,
		OutboundIdempotencyMapping: current.OutboundIdempotencyMapping,
		EndpointPolicy:             current.EndpointPolicy,
		AuthStrategy:               current.AuthStrategy,
		ResponsePolicy:             ResponsePolicyHTTPStatusV1,
		CredentialRef:              &CredentialRef{Scheme: crefInput.Scheme, OpaqueHandle: crefInput.OpaqueHandle, ReferenceVersion: crefInput.ReferenceVersion},
		CreatedByActor:             actor.ActorID,
		CreatedAt:                  s.now(),
	}
	result := AdminResult{
		Operation:            OpRotateCredentialRef,
		VendorID:             cmd.VendorID,
		Lifecycle:            vendor.Lifecycle,
		RecordRevision:       vendor.RecordRevision + 1,
		CurrentConfigVersion: version.ConfigVersion,
	}
	receipt := s.newReceipt(actor, cmd, result)
	audit := s.successAudit(actor, vendor, cmd, result, receipt.ReceiptID)
	if err := s.repo.RotateCredentialRef(ctx, cmd.VendorID, cmd.ExpectedRecordRevision, version, receipt, audit); err != nil {
		return AdminResult{}, mapRepoError(err)
	}
	return result, nil
}

func (s *Service) loadAuthorizedVendor(ctx context.Context, actor ActorContext, vendorID string) (VendorRecord, error) {
	if actor.VendorScope.Kind == "vendor_ids" && !actor.VendorScope.CoversVendorID(vendorID) {
		return VendorRecord{}, AdminCommandError{Code: "FORBIDDEN", Err: errors.New("vendor_id outside scope")}
	}
	vendor, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		if isNotFound(err) {
			return VendorRecord{}, AdminCommandError{Code: "VENDOR_NOT_FOUND"}
		}
		return VendorRecord{}, AdminCommandError{Code: "COMMIT_OUTCOME_UNKNOWN", Err: err}
	}
	if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
		return VendorRecord{}, AdminCommandError{Code: "VENDOR_NOT_FOUND"}
	}
	return vendor, nil
}

func (s *Service) newReceipt(actor ActorContext, cmd AdminCommand, result AdminResult) AdminCommandReceipt {
	fp := ComputeFingerprint(s.fpSecret, cmd.Operation, cmd.VendorID, cmd.ExpectedRecordRevision, cmd.Body)
	return AdminCommandReceipt{
		ReceiptID:          s.newID(),
		ActorID:            actor.ActorID,
		IdempotencyKey:     cmd.IdempotencyKey,
		CommandFingerprint: fp,
		Operation:          cmd.Operation,
		VendorID:           cmd.VendorID,
		SafeResult:         result,
		RecordedAt:         s.now(),
	}
}

func (s *Service) successAudit(actor ActorContext, before VendorRecord, cmd AdminCommand, result AdminResult, receiptID string) AdminAuditEvent {
	return AdminAuditEvent{
		EventID:                      s.newID(),
		VendorID:                     cmd.VendorID,
		OwningScope:                  before.OwningScope,
		ActorID:                      actor.ActorID,
		AuthorizationBasis:           authorizationBasis(actor.VendorScope),
		Operation:                    cmd.Operation,
		Outcome:                      "success",
		ExpectedRecordRevisionBefore: ptrInt64(before.RecordRevision),
		RecordRevisionAfter:          ptrInt64(result.RecordRevision),
		SanitizedRequestDigest:       SanitizedRequestDigest(cmd.Operation, cmd.VendorID, cmd.ExpectedRecordRevision),
		ReceiptID:                    receiptID,
		OccurredAt:                   s.now(),
	}
}

func isAuditedBusinessRejection(code string) bool {
	switch code {
	case ErrVendorIDUnavailable, ErrVendorNotFound, ErrExpectedVersionMismatch,
		ErrInvalidTransition, ErrVendorDisabledUpdateForbidden,
		ErrInvalidEndpointPolicy, ErrInvalidCredentialRef:
		return true
	default:
		return false
	}
}

// persistBusinessRejection writes the one required rejected audit after all
// schema, kind, capability, scope and receipt checks have passed. Scope and
// fingerprint rejections never call this method.
func (s *Service) persistBusinessRejection(ctx context.Context, actor ActorContext, cmd AdminCommand, reason string) error {
	var owningScope string
	var currentRevision *int64
	if cmd.Operation == OpRegister {
		owningScope, _ = cmd.Body["owning_scope"].(string)
	} else {
		vendor, err := s.repo.GetVendor(ctx, cmd.VendorID)
		if err == nil {
			owningScope = vendor.OwningScope
			currentRevision = ptrInt64(vendor.RecordRevision)
		} else if !isNotFound(err) {
			return AdminCommandError{Code: ErrCommitOutcomeUnknown, Err: err}
		}
	}
	audit := AdminAuditEvent{
		EventID:                      s.newID(),
		VendorID:                     cmd.VendorID,
		OwningScope:                  owningScope,
		ActorID:                      actor.ActorID,
		AuthorizationBasis:           authorizationBasis(actor.VendorScope),
		Operation:                    cmd.Operation,
		Outcome:                      "rejected",
		ExpectedRecordRevisionBefore: currentRevision,
		SanitizedRequestDigest:       SanitizedRequestDigest(cmd.Operation, cmd.VendorID, cmd.ExpectedRecordRevision),
		RejectReason:                 reason,
		OccurredAt:                   s.now(),
	}
	if err := s.repo.InsertAuditEvent(ctx, audit); err != nil {
		return AdminCommandError{Code: ErrCommitOutcomeUnknown, Err: err}
	}
	return nil
}

func mapRepoError(err error) error {
	if err == nil {
		return nil
	}
	var ace AdminCommandError
	if errors.As(err, &ace) {
		return ace
	}
	var re ReadError
	if errors.As(err, &re) {
		if re.Code == ReadErrVendorNotFound {
			return AdminCommandError{Code: ErrVendorNotFound}
		}
		return AdminCommandError{Code: ErrCommitOutcomeUnknown, Err: err}
	}
	return AdminCommandError{Code: ErrCommitOutcomeUnknown, Err: err}
}

func authorizationBasis(scope VendorScope) string {
	switch scope.Kind {
	case "all":
		return "all"
	case "vendor_ids":
		return "vendor_id"
	case "owning_scopes":
		return "owning_scope"
	}
	return ""
}

func ptrInt64(v int64) *int64 { return &v }

func effectiveScopeFilter(actorScope VendorScope, filter ScopeFilter) (ScopeFilter, error) {
	if filter.Kind == "" {
		switch actorScope.Kind {
		case "all":
			return ScopeFilter{}, nil
		case "vendor_ids":
			return ScopeFilter{Kind: "vendor_ids", VendorIDs: append([]string(nil), actorScope.VendorIDs...)}, nil
		case "owning_scopes":
			return ScopeFilter{Kind: "owning_scopes", OwningScopes: append([]string(nil), actorScope.OwningScopes...)}, nil
		default:
			return ScopeFilter{}, errors.New("actor scope kind invalid")
		}
	}
	if filter.Kind != "vendor_ids" && filter.Kind != "owning_scopes" {
		return ScopeFilter{}, errors.New("scope filter kind invalid")
	}
	filterScope := VendorScope{Kind: filter.Kind, VendorIDs: filter.VendorIDs, OwningScopes: filter.OwningScopes}
	if err := validateScope(filterScope); err != nil {
		return ScopeFilter{}, err
	}
	if actorScope.Kind != "all" && filter.Kind != actorScope.Kind {
		return ScopeFilter{}, errors.New("scope filter kind must match actor scope kind")
	}
	if actorScope.Kind == "vendor_ids" {
		for _, v := range filter.VendorIDs {
			if !actorScope.CoversVendorID(v) {
				return ScopeFilter{}, fmt.Errorf("vendor_id %s outside actor scope", v)
			}
		}
	}
	if actorScope.Kind == "owning_scopes" {
		for _, o := range filter.OwningScopes {
			if !actorScope.CoversOwningScope(o) {
				return ScopeFilter{}, fmt.Errorf("owning_scope %s outside actor scope", o)
			}
		}
	}
	return filter, nil
}

func readActorKindAllowed(kind string) bool {
	return kind == ActorKindOperator || kind == ActorKindAuditor || kind == ActorKindSystem
}

func (s *Service) normalizeListLimit(limit int) (int, error) {
	cfg := s.currentConfig()
	if limit == 0 {
		return cfg.ListPageDefault, nil
	}
	if limit < 1 || limit > cfg.ListPageMax {
		return 0, errors.New("list page limit out of range")
	}
	return limit, nil
}

func decodeStrict(value any, dst any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func objectHasKey(value any, key string) bool {
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	_, exists := object[key]
	return exists
}

// IsVendorActive returns the merged active flag for a vendor.
func (s *Service) IsVendorActive(ctx context.Context, actor ActorContext, vendorID string) (bool, error) {
	if err := validateActorContext(actor); err != nil {
		return false, ReadError{Code: ReadErrInvalidActorContext, Err: err}
	}
	if !actor.HasCapability(CapabilityReadActive) {
		return false, ReadError{Code: ReadErrForbidden, Err: errors.New("missing capability")}
	}
	if actor.Kind != ActorKindIngress && actor.Kind != ActorKindDelivery && actor.Kind != ActorKindSystem {
		return false, ReadError{Code: ReadErrForbidden, Err: errors.New("actor kind not allowed")}
	}
	if actor.VendorScope.Kind == "vendor_ids" && !actor.VendorScope.CoversVendorID(vendorID) {
		return false, nil
	}
	vendor, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}
		return false, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
		return false, nil
	}
	return vendor.Lifecycle == LifecycleActive, nil
}

// Snapshot returns the latest active or specific historical snapshot.
func (s *Service) Snapshot(ctx context.Context, actor ActorContext, vendorID string, specificVersion *int64) (any, error) {
	if err := validateActorContext(actor); err != nil {
		return nil, ReadError{Code: ReadErrInvalidActorContext, Err: err}
	}
	if specificVersion == nil {
		if actor.Kind != ActorKindDelivery && actor.Kind != ActorKindSystem {
			return nil, ReadError{Code: ReadErrForbidden, Err: errors.New("actor kind not allowed")}
		}
		if !actor.HasCapability(CapabilitySnapshotLatest) || !actor.HasCapability(CapabilityReadCredentialLocator) {
			return nil, ReadError{Code: ReadErrForbidden, Err: errors.New("missing snapshot capabilities")}
		}
		if actor.VendorScope.Kind == "vendor_ids" && !actor.VendorScope.CoversVendorID(vendorID) {
			return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown}
		}
		vendor, err := s.repo.GetVendor(ctx, vendorID)
		if err != nil {
			if isNotFound(err) {
				return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown}
			}
			return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
		}
		if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
			return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown}
		}
		if vendor.Lifecycle != LifecycleActive {
			return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown}
		}
		version, err := s.repo.GetEndpointVersion(ctx, vendorID, vendor.CurrentConfigVersion)
		if err != nil {
			return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
		}
		return versionToDeliverySnapshot(version), nil
	}
	if !readActorKindAllowed(actor.Kind) {
		return nil, ReadError{Code: ReadErrForbidden, Err: errors.New("actor kind not allowed")}
	}
	if !actor.HasCapability(CapabilityReadHistory) {
		return nil, ReadError{Code: ReadErrForbidden, Err: errors.New("missing read-history capability")}
	}
	if actor.VendorScope.Kind == "vendor_ids" && !actor.VendorScope.CoversVendorID(vendorID) {
		return nil, ReadError{Code: ReadErrVendorNotFound}
	}
	vendor, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		if isNotFound(err) {
			return nil, ReadError{Code: ReadErrVendorNotFound}
		}
		return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
		return nil, ReadError{Code: ReadErrVendorNotFound}
	}
	version, err := s.repo.GetEndpointVersion(ctx, vendorID, *specificVersion)
	if err != nil {
		if isNotFound(err) {
			return nil, ReadError{Code: ReadErrVersionNotFound}
		}
		return nil, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	return versionToHistoricalSnapshot(version), nil
}

func versionToDeliverySnapshot(v EndpointVersion) DeliveryConfigSnapshot {
	return DeliveryConfigSnapshot{
		ProjectionSchema:           "delivery-v2",
		VendorID:                   v.VendorID,
		ConfigVersion:              v.ConfigVersion,
		ConfigSchemaVersion:        v.ConfigSchemaVersion,
		CanonicalURL:               v.CanonicalURL,
		Method:                     v.Method,
		Hostname:                   v.Hostname,
		Port:                       v.Port,
		TransportKind:              v.TransportKind,
		CIDRException:              v.CIDRException,
		TransportAuthHeaders:       v.TransportAuthHeaders,
		OutboundIdempotencyMapping: v.OutboundIdempotencyMapping,
		EndpointPolicy:             v.EndpointPolicy,
		AuthStrategy:               v.AuthStrategy,
		ResponsePolicy:             v.ResponsePolicy,
		CredentialRef:              v.CredentialRef,
	}
}

func versionToHistoricalSnapshot(v EndpointVersion) HistoricalConfigSnapshot {
	snapshot := HistoricalConfigSnapshot{
		ProjectionSchema:           "historical-v2",
		VendorID:                   v.VendorID,
		ConfigVersion:              v.ConfigVersion,
		ConfigSchemaVersion:        v.ConfigSchemaVersion,
		CanonicalURL:               v.CanonicalURL,
		Method:                     v.Method,
		Hostname:                   v.Hostname,
		Port:                       v.Port,
		TransportKind:              v.TransportKind,
		CIDRException:              v.CIDRException,
		TransportAuthHeaders:       v.TransportAuthHeaders,
		OutboundIdempotencyMapping: v.OutboundIdempotencyMapping,
		EndpointPolicy:             v.EndpointPolicy,
		AuthStrategy:               v.AuthStrategy,
		ResponsePolicy:             v.ResponsePolicy,
	}
	if v.CredentialRef != nil {
		snapshot.CredentialDescriptor = &CredentialDescriptor{Scheme: v.CredentialRef.Scheme, ReferenceVersion: v.CredentialRef.ReferenceVersion}
	}
	return snapshot
}

// ListVendors returns authorized vendor list page.
func (s *Service) ListVendors(ctx context.Context, actor ActorContext, filter ScopeFilter, cursor string, limit int) (Page[VendorListItem], error) {
	if err := validateActorContext(actor); err != nil {
		return Page[VendorListItem]{}, ReadError{Code: ReadErrInvalidActorContext, Err: err}
	}
	if !readActorKindAllowed(actor.Kind) || !actor.HasCapability(CapabilityRead) {
		return Page[VendorListItem]{}, ReadError{Code: ReadErrForbidden, Err: errors.New("missing capability")}
	}
	limit, err := s.normalizeListLimit(limit)
	if err != nil {
		return Page[VendorListItem]{}, ReadError{Code: ReadErrInvalidPageLimit, Err: err}
	}
	effectiveFilter, err := effectiveScopeFilter(actor.VendorScope, filter)
	if err != nil {
		return Page[VendorListItem]{}, ReadError{Code: ReadErrForbiddenScopeFilter, Err: err}
	}
	page, err := s.repo.ListVendors(ctx, effectiveFilter, cursor, limit)
	if err != nil {
		if IsReadError(err, ReadErrInvalidCursor) {
			return page, err
		}
		return page, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	return page, nil
}

// ListEndpointVersions returns authorized endpoint version page.
func (s *Service) ListEndpointVersions(ctx context.Context, actor ActorContext, vendorID string, cursor string, limit int) (Page[EndpointVersionListItem], int64, error) {
	if err := validateActorContext(actor); err != nil {
		return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrInvalidActorContext, Err: err}
	}
	if !readActorKindAllowed(actor.Kind) || !actor.HasCapability(CapabilityReadHistory) {
		return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrForbidden, Err: errors.New("missing capability")}
	}
	limit, err := s.normalizeListLimit(limit)
	if err != nil {
		return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrInvalidPageLimit, Err: err}
	}
	if actor.VendorScope.Kind == "vendor_ids" && !actor.VendorScope.CoversVendorID(vendorID) {
		return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrVendorNotFound}
	}
	vendor, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		if isNotFound(err) {
			return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrVendorNotFound}
		}
		return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
		return Page[EndpointVersionListItem]{}, 0, ReadError{Code: ReadErrVendorNotFound}
	}
	page, cap, err := s.repo.ListEndpointVersions(ctx, vendorID, cursor, limit)
	if err != nil {
		if IsReadError(err, ReadErrInvalidCursor) {
			return page, cap, err
		}
		return page, cap, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	return page, cap, nil
}

// ListAdminAuditEvents returns authorized audit page.
func (s *Service) ListAdminAuditEvents(ctx context.Context, actor ActorContext, filter ScopeFilter, cursor string, limit int) (Page[AdminAuditListItem], error) {
	if err := validateActorContext(actor); err != nil {
		return Page[AdminAuditListItem]{}, ReadError{Code: ReadErrInvalidActorContext, Err: err}
	}
	if !readActorKindAllowed(actor.Kind) || !actor.HasCapability(CapabilityReadAudit) {
		return Page[AdminAuditListItem]{}, ReadError{Code: ReadErrForbidden, Err: errors.New("missing capability")}
	}
	limit, err := s.normalizeListLimit(limit)
	if err != nil {
		return Page[AdminAuditListItem]{}, ReadError{Code: ReadErrInvalidPageLimit, Err: err}
	}
	effectiveFilter, err := effectiveScopeFilter(actor.VendorScope, filter)
	if err != nil {
		return Page[AdminAuditListItem]{}, ReadError{Code: ReadErrForbiddenScopeFilter, Err: err}
	}
	page, err := s.repo.ListAdminAuditEvents(ctx, effectiveFilter, cursor, limit)
	if err != nil {
		if IsReadError(err, ReadErrInvalidCursor) {
			return page, err
		}
		return page, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	return page, nil
}

// DescribeVendorState returns a vendor state summary.
func (s *Service) DescribeVendorState(ctx context.Context, actor ActorContext, vendorID string) (VendorStateSummary, error) {
	if err := validateActorContext(actor); err != nil {
		return VendorStateSummary{}, ReadError{Code: ReadErrInvalidActorContext, Err: err}
	}
	if !readActorKindAllowed(actor.Kind) || !actor.HasCapability(CapabilityRead) {
		return VendorStateSummary{}, ReadError{Code: ReadErrForbidden, Err: errors.New("missing capability")}
	}
	if actor.VendorScope.Kind == "vendor_ids" && !actor.VendorScope.CoversVendorID(vendorID) {
		return VendorStateSummary{}, ReadError{Code: ReadErrVendorNotFound}
	}
	vendor, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		if isNotFound(err) {
			return VendorStateSummary{}, ReadError{Code: ReadErrVendorNotFound}
		}
		return VendorStateSummary{}, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	if actor.VendorScope.Kind == "owning_scopes" && !actor.VendorScope.CoversOwningScope(vendor.OwningScope) {
		return VendorStateSummary{}, ReadError{Code: ReadErrVendorNotFound}
	}
	summary, err := s.repo.DescribeVendorState(ctx, vendorID)
	if err != nil {
		if isNotFound(err) {
			return VendorStateSummary{}, ReadError{Code: ReadErrVendorNotFound}
		}
		return VendorStateSummary{}, ReadError{Code: ReadErrVendorInactiveOrUnknown, Err: err}
	}
	return summary, nil
}
