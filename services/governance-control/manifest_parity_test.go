package governancecontrol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestGeneratedManifestAndExactByteMirror(t *testing.T) {
	raw, err := os.ReadFile("internal/contractmirror/generated/v1/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema            string `json:"schema"`
		Authority         string `json:"authority"`
		AuthorityBoundary struct {
			Writer                   string `json:"writer"`
			GoRole                   string `json:"goRole"`
			RuntimeStore             string `json:"runtimeStore"`
			MemoryBankIsRuntimeStore bool   `json:"memoryBankIsRuntimeStore"`
		} `json:"authorityBoundary"`
		Schemas                    map[string]string `json:"schemas"`
		SchemaScope                string            `json:"schemaScope"`
		SemanticValidationRequired bool              `json:"semanticValidationRequired"`
		SemanticConstraints        []string          `json:"semanticConstraints"`
		States                     []State           `json:"states"`
		ExecutionStatuses          []string          `json:"executionStatuses"`
		StateTransitions           map[State][]State `json:"stateTransitions"`
		AuditEventTypes            []string          `json:"auditEventTypes"`
		Limits                     struct {
			Contract map[string]int `json:"contract"`
			Store    map[string]int `json:"store"`
			Service  map[string]int `json:"service"`
		} `json:"limits"`
		Algorithms map[string]string   `json:"algorithms"`
		ErrorCodes map[string][]string `json:"errorCodes"`
		Artifacts  map[string]struct {
			Path       string `json:"path"`
			ByteLength int    `json:"byteLength"`
			SHA256     string `json:"sha256"`
		} `json:"artifacts"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("manifest contains trailing JSON data: %v", err)
	}
	if manifest.Schema != "openslack.governed_plan_contract_manifest.v1" || manifest.Authority != "typescript" {
		t.Fatalf("manifest identity drift: %s/%s", manifest.Schema, manifest.Authority)
	}
	boundary := manifest.AuthorityBoundary
	if boundary.Writer != "@openslack/operator" || boundary.GoRole != "credential-free-read-model-only" ||
		boundary.RuntimeStore != ".openslack.local/operator/governed-plans" || boundary.MemoryBankIsRuntimeStore {
		t.Fatalf("authority boundary drift: %+v", boundary)
	}
	if !reflect.DeepEqual(manifest.Schemas, map[string]string{
		"actionPlan": "openslack.governed_action_plan.v1",
		"record":     "openslack.governed_plan.v1",
		"audit":      "openslack.governed_plan_audit.v1",
		"readModel":  "openslack.governed_plan_read_model.v1",
	}) {
		t.Fatalf("schema inventory drift: %v", manifest.Schemas)
	}
	if manifest.SchemaScope != "structural-prefilter" || !manifest.SemanticValidationRequired {
		t.Fatalf("schema semantic boundary drift: %s/%t", manifest.SchemaScope, manifest.SemanticValidationRequired)
	}
	if !reflect.DeepEqual(manifest.SemanticConstraints, []string{
		"canonical-json-exact-bytes", "utf8-byte-limits", "depth-and-node-limits",
		"inert-value-validation", "ecmascript-utf16-string-semantics", "timestamp-acceptance",
		"binding-hash-recomputation", "state-and-execution-invariants",
	}) {
		t.Fatalf("semantic constraint inventory drift: %v", manifest.SemanticConstraints)
	}
	expectedStates := []State{StatePending, StateExecuting, StateSucceeded, StateBlocked, StateFailed, StateReconciliationRequired, StateCancelled, StateExpired}
	if !reflect.DeepEqual(manifest.States, expectedStates) {
		t.Fatalf("state inventory drift: %v", manifest.States)
	}
	if !reflect.DeepEqual(manifest.ExecutionStatuses, []string{"succeeded", "blocked", "failed"}) {
		t.Fatalf("execution status drift: %v", manifest.ExecutionStatuses)
	}
	if len(manifest.StateTransitions) != len(transitions) {
		t.Fatalf("state-transition source inventory drift: %d", len(manifest.StateTransitions))
	}
	for _, from := range expectedStates {
		destinations, exists := manifest.StateTransitions[from]
		if !exists {
			t.Fatalf("manifest is missing transition source %s", from)
		}
		for _, to := range destinations {
			if !CanTransition(from, to) {
				t.Fatalf("manifest allows unknown transition %s -> %s", from, to)
			}
		}
		if len(destinations) != len(transitions[from]) {
			t.Fatalf("transition inventory drift for %s", from)
		}
	}
	expectedAuditTypes := []string{
		"plan.previewed", "plan.confirmed", "plan.confirmation_rejected", "plan.cancelled",
		"plan.expired", "plan.execution_started", "plan.execution_completed",
		"plan.execution_blocked", "plan.execution_failed", "plan.reconciliation_required",
		"workflow.approval_decided",
	}
	if !reflect.DeepEqual(manifest.AuditEventTypes, expectedAuditTypes) {
		t.Fatalf("audit event inventory drift: %v", manifest.AuditEventTypes)
	}
	if len(manifest.AuditEventTypes) != len(auditEventTypes) {
		t.Fatalf("runtime audit event inventory drift: %d", len(auditEventTypes))
	}
	for _, eventType := range manifest.AuditEventTypes {
		if _, exists := auditEventTypes[eventType]; !exists {
			t.Fatalf("manifest audit event is not accepted by runtime: %s", eventType)
		}
	}
	if !reflect.DeepEqual(manifest.Limits.Contract, map[string]int{
		"maxDepth": MaxDepth, "maxNodes": MaxNodes, "maxContainerEntries": MaxContainerEntries,
		"maxStringBytes": MaxStringBytes, "maxObjectKeyBytes": MaxObjectKeyBytes,
		"maxActions": MaxActions, "maxEffects": MaxEffects, "maxGoalBytes": MaxGoalBytes,
		"maxEffectSummaryBytes": MaxEffectSummaryBytes, "maxSummaryBytes": MaxSummaryBytes,
		"maxEvidenceRefBytes":        MaxEvidenceRefBytes,
		"maxOpaqueBindingCharacters": MaxOpaqueBindingCharacters,
		"minOpaqueBindingCharacters": MinOpaqueBindingCharacters,
	}) {
		t.Fatalf("contract limit drift: %v", manifest.Limits.Contract)
	}
	if !reflect.DeepEqual(manifest.Limits.Store, map[string]int{
		"maxRecordBytes": MaxRecordBytes, "maxRecords": 4_096, "maxLockBytes": 512,
		"lockAcquireAttempts": 3,
	}) {
		t.Fatalf("store limit drift: %v", manifest.Limits.Store)
	}
	if !reflect.DeepEqual(manifest.Limits.Service, map[string]int{
		"defaultTtlMs": 900_000, "minTtlMs": 60_000, "maxTtlMs": 86_400_000,
		"defaultExecutionTimeoutMs": 300_000, "minExecutionTimeoutMs": 10,
		"maxExecutionTimeoutMs": 900_000, "confirmationTokenBytes": 32,
		"confirmationTokenCharacters": 43,
	}) {
		t.Fatalf("service limit drift: %v", manifest.Limits.Service)
	}
	expectedAlgorithms := map[string]string{
		"canonicalJson":        AlgorithmCanonicalJSON,
		"governedValueHash":    AlgorithmGovernedValueHash,
		"opaqueValueHash":      AlgorithmOpaqueValueHash,
		"opaqueHashComparison": AlgorithmOpaqueHashComparison,
		"persistedRecord":      "canonical_json_utf8_plus_lf",
		"cas":                  "plan_id+expected_revision",
		"executionClaim":       "cas_once(plan_id,expected_revision,execution_id)",
	}
	if !reflect.DeepEqual(manifest.Algorithms, expectedAlgorithms) {
		t.Fatalf("algorithm contract drift: %v", manifest.Algorithms)
	}
	expectedErrors := map[string][]string{
		"contract": {string(ErrorInvalid), string(ErrorLimitExceeded), string(ErrorBindingMismatch)},
		"store": {
			"GOVERNED_PLAN_STORE_PATH_UNSAFE", "GOVERNED_PLAN_STORE_FILE_UNSAFE",
			"GOVERNED_PLAN_STORE_NOT_FOUND", "GOVERNED_PLAN_STORE_ALREADY_EXISTS",
			"GOVERNED_PLAN_STORE_BUSY", "GOVERNED_PLAN_STORE_CAS_MISMATCH",
			"GOVERNED_PLAN_STORE_TRANSITION_INVALID", "GOVERNED_PLAN_STORE_LIMIT_EXCEEDED",
			"GOVERNED_PLAN_STORE_RECORD_INVALID", "GOVERNED_PLAN_STORE_FILE_CHANGED",
		},
		"service": {
			"GOVERNED_PLAN_NOT_FOUND", "GOVERNED_PLAN_AUTHORITY_INVALID",
			"GOVERNED_PLAN_CONFIRMATION_INVALID", "GOVERNED_PLAN_BINDING_CHANGED",
			"GOVERNED_PLAN_STATE_INVALID", "GOVERNED_PLAN_EXECUTION_ACTIVE",
			"GOVERNED_PLAN_EXECUTION_ABORTED", "GOVERNED_PLAN_EXECUTION_UNCERTAIN",
			"GOVERNED_PLAN_CONFIGURATION_INVALID",
		},
	}
	if !reflect.DeepEqual(manifest.ErrorCodes, expectedErrors) {
		t.Fatalf("error inventory drift: %v", manifest.ErrorCodes)
	}
	if len(manifest.Artifacts) != 5 {
		t.Fatalf("artifact inventory drift: %d", len(manifest.Artifacts))
	}
	for name, artifact := range manifest.Artifacts {
		if name != artifact.Path {
			t.Fatalf("artifact key/path mismatch: %s/%s", name, artifact.Path)
		}
		mirror, err := os.ReadFile(filepath.Join("internal/contractmirror/generated/v1", artifact.Path))
		if err != nil {
			t.Fatal(err)
		}
		source, err := os.ReadFile(filepath.Join("../../packages/operator/contracts/governed-plan/v1", artifact.Path))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(mirror, source) || len(mirror) != artifact.ByteLength {
			t.Fatalf("artifact mirror drift: %s", name)
		}
		sum := sha256.Sum256(mirror)
		if hex.EncodeToString(sum[:]) != artifact.SHA256 {
			t.Fatalf("artifact digest drift: %s", name)
		}
	}
}
