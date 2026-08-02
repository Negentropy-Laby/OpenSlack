package governancecontrol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
)

type goldenFile struct {
	Schema    string       `json:"schema"`
	Authority string       `json:"authority"`
	Cases     []goldenCase `json:"cases"`
}

type goldenCase struct {
	ID            string          `json:"id"`
	Operation     string          `json:"operation"`
	Input         json.RawMessage `json:"input"`
	Expected      json.RawMessage `json:"expected"`
	ExpectedError json.RawMessage `json:"expectedError"`
}

func decodeStrict(t *testing.T, raw []byte, target any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("unexpected trailing JSON value: %v", err)
	}
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	raw, err := os.ReadFile("internal/contractmirror/generated/v1/golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var result goldenFile
	decodeStrict(t, raw, &result)
	if result.Schema != "openslack.governed_plan_golden_vectors.v1" || result.Authority != "typescript" {
		t.Fatalf("golden identity drift: %s/%s", result.Schema, result.Authority)
	}
	return result
}

func equalJSON(t *testing.T, actual any, expected json.RawMessage) {
	t.Helper()
	actualRaw, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var actualValue, expectedValue any
	if err := json.Unmarshal(actualRaw, &actualValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &expectedValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("JSON mismatch:\n got %s\nwant %s", actualRaw, expected)
	}
}

func TestTypeScriptGoldenVectors(t *testing.T) {
	seen := map[string]struct{}{}
	for _, testCase := range loadGolden(t).Cases {
		testCase := testCase
		if _, exists := seen[testCase.ID]; exists {
			t.Fatalf("duplicate golden ID %q", testCase.ID)
		}
		seen[testCase.ID] = struct{}{}
		t.Run(testCase.ID, func(t *testing.T) {
			switch testCase.Operation {
			case "canonicalize_hash":
				var input struct {
					Value json.RawMessage `json:"value"`
				}
				var expected struct {
					CanonicalJSON string `json:"canonicalJson"`
					SHA256        string `json:"sha256"`
				}
				decodeStrict(t, testCase.Input, &input)
				decodeStrict(t, testCase.Expected, &expected)
				canonical, hash, err := HashGovernedJSON(input.Value)
				if err != nil {
					t.Fatal(err)
				}
				if string(canonical) != expected.CanonicalJSON || hash != expected.SHA256 {
					t.Fatalf("canonical/hash drift: %s/%s", canonical, hash)
				}
			case "hash_opaque":
				var input struct{ Value, Other string }
				var expected struct {
					Hash, Equal, Different any
				}
				decodeStrict(t, testCase.Input, &input)
				decodeStrict(t, testCase.Expected, &expected)
				hash, err := HashOpaque(input.Value)
				if err != nil {
					t.Fatal(err)
				}
				other, err := HashOpaque(input.Other)
				if err != nil {
					t.Fatal(err)
				}
				actual := map[string]any{
					"hash": hash, "equal": OpaqueHashesEqual(hash, hash),
					"different": OpaqueHashesEqual(hash, other),
				}
				equalJSON(t, actual, testCase.Expected)
			case "canonicalize_error":
				var input struct {
					Value json.RawMessage `json:"value"`
				}
				var expected struct {
					Code ErrorCode `json:"code"`
					Path string    `json:"path"`
				}
				decodeStrict(t, testCase.Input, &input)
				decodeStrict(t, testCase.ExpectedError, &expected)
				_, _, err := HashGovernedJSON(input.Value)
				var actual *ContractError
				if !errors.As(err, &actual) || actual.Code != expected.Code || actual.Path != expected.Path {
					t.Fatalf("canonical error drift: got %v, want %+v", err, expected)
				}
			case "validate_project_record":
				var input struct {
					Record json.RawMessage `json:"record"`
				}
				var expected struct {
					CanonicalRecord string          `json:"canonicalRecord"`
					ReadModel       json.RawMessage `json:"readModel"`
				}
				decodeStrict(t, testCase.Input, &input)
				decodeStrict(t, testCase.Expected, &expected)
				record, err := ValidateRecordJSON(input.Record)
				if err != nil {
					t.Fatal(err)
				}
				canonical, err := CanonicalRecordBytes(record)
				if err != nil {
					t.Fatal(err)
				}
				if string(canonical) != expected.CanonicalRecord {
					t.Fatalf("canonical record drift:\n got %s\nwant %s", canonical, expected.CanonicalRecord)
				}
				if _, err := ValidateCanonicalRecordBytes(canonical); err != nil {
					t.Fatalf("canonical record rejected: %v", err)
				}
				projected, err := Project(record)
				if err != nil {
					t.Fatal(err)
				}
				equalJSON(t, projected, expected.ReadModel)
				projectedJSON, err := json.Marshal(projected)
				if err != nil {
					t.Fatal(err)
				}
				for _, forbidden := range []string{
					"confirmationTokenHash", "sourceVersionHash", "permissionSnapshotHash",
					"actionCatalogHash", "executorBindingHash", "buildNonceHash", "processNonceHash",
				} {
					if bytes.Contains(projectedJSON, []byte(forbidden)) {
						t.Fatalf("read model leaked %s", forbidden)
					}
				}
			case "validate_record_error":
				var input struct {
					Record json.RawMessage `json:"record"`
				}
				var expected struct {
					Name    string    `json:"name"`
					Code    ErrorCode `json:"code"`
					Path    string    `json:"path"`
					Message string    `json:"message"`
				}
				decodeStrict(t, testCase.Input, &input)
				decodeStrict(t, testCase.ExpectedError, &expected)
				_, err := ValidateRecordJSON(input.Record)
				var actual *ContractError
				if !errors.As(err, &actual) {
					t.Fatalf("expected ContractError, got %v", err)
				}
				if expected.Name != "GovernedPlanContractError" || actual.Code != expected.Code || actual.Path != expected.Path || actual.Message != expected.Message {
					t.Fatalf("error drift:\n got %+v\nwant %+v", actual, expected)
				}
			default:
				t.Fatalf("unknown golden operation %q", testCase.Operation)
			}
		})
	}
	if len(seen) != 15 {
		t.Fatalf("golden case inventory drift: %d", len(seen))
	}
}

func TestStrictBoundaryAndStateMachine(t *testing.T) {
	for name, input := range map[string][]byte{
		"duplicate": []byte(`{"schema":"openslack.governed_plan.v1","schema":"duplicate"}`),
		"bom":       append([]byte{0xef, 0xbb, 0xbf}, []byte(`{}`)...),
		"unknown":   []byte(`{"unknown":true}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateRecordJSON(input); err == nil {
				t.Fatal("unsafe input was accepted")
			}
		})
	}
	if !CanTransition(StatePending, StateExecuting) || !CanTransition(StateExecuting, StateReconciliationRequired) {
		t.Fatal("required transition missing")
	}
	if CanTransition(StateSucceeded, StateExecuting) || CanTransition(StatePending, StateSucceeded) {
		t.Fatal("forbidden transition accepted")
	}
	if OpaqueHashesEqual(strings.Repeat("x", 64), strings.Repeat("x", 64)) {
		t.Fatal("non-hex hashes must not compare equal")
	}
	if _, err := Project(Record{}); err == nil {
		t.Fatal("zero-value record projected without validation")
	}

	for _, boundary := range []struct {
		name     string
		value    string
		accepted bool
	}{
		{"opaque-15", strings.Repeat("a", 15), false},
		{"opaque-16", strings.Repeat("a", 16), true},
		{"opaque-4096", strings.Repeat("a", 4096), true},
		{"opaque-4097", strings.Repeat("a", 4097), false},
		{"supplementary-4096-units", strings.Repeat("😀", 2048), true},
		{"supplementary-4098-units", strings.Repeat("😀", 2049), false},
	} {
		t.Run(boundary.name, func(t *testing.T) {
			_, err := HashOpaque(boundary.value)
			if (err == nil) != boundary.accepted {
				t.Fatalf("opaque boundary acceptance=%t, err=%v", boundary.accepted, err)
			}
		})
	}
	lone := string(canonicaljson.AppendWTF8CodeUnit(nil, 0xd800))
	loneHash, err := HashOpaque(strings.Repeat(lone, 16))
	if err != nil {
		t.Fatal(err)
	}
	replacementHash, err := HashOpaque(strings.Repeat("�", 16))
	if err != nil || loneHash != replacementHash {
		t.Fatalf("ECMAScript lone-surrogate hash drift: %v", err)
	}
}

func TestCanonicalRecordByteEnvelope(t *testing.T) {
	var input struct {
		Record json.RawMessage `json:"record"`
	}
	for _, testCase := range loadGolden(t).Cases {
		if testCase.ID == "pending-record-validation-and-read-model" {
			decodeStrict(t, testCase.Input, &input)
			break
		}
	}
	if len(input.Record) == 0 {
		t.Fatal("pending golden record not found")
	}
	record, err := ValidateRecordJSON(input.Record)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalRecordBytes(record)
	if err != nil {
		t.Fatal(err)
	}
	variants := map[string][]byte{
		"missing-lf":        append([]byte{}, canonical[:len(canonical)-1]...),
		"extra-lf":          append(append([]byte{}, canonical...), '\n'),
		"leading-space":     append([]byte{' '}, canonical...),
		"invalid-utf8":      append([]byte{0xff}, canonical...),
		"noncanonical-copy": bytes.Replace(append([]byte{}, canonical...), []byte(`{"bindings":`), []byte(`{"canonicalPlan":null,"bindings":`), 1),
	}
	for name, variant := range variants {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateCanonicalRecordBytes(variant); err == nil {
				t.Fatal("noncanonical record envelope accepted")
			}
		})
	}
}

func TestAuditContract(t *testing.T) {
	valid := []byte(`{
	  "schema":"openslack.governed_plan_audit.v1",
	  "eventId":"GAUDIT-123e4567-e89b-42d3-a456-426614174000",
	  "type":"plan.previewed",
	  "occurredAt":"2026-08-02T06:00:00.000Z",
	  "planId":"GPLAN-123e4567-e89b-42d3-a456-426614174000",
	  "kind":"scenario.instantiate",
	  "actorId":"qoder.local",
	  "workspaceId":"workspace.demo",
	  "correlationId":"CORR-123e4567-e89b-42d3-a456-426614174000",
	  "state":"pending",
	  "revision":1,
	  "evidenceRefs":[]
	}`)
	for eventType := range auditEventTypes {
		candidate := bytes.Replace(valid, []byte("plan.previewed"), []byte(eventType), 1)
		event, err := ValidateAuditJSON(candidate)
		if err != nil {
			t.Fatalf("%s: %v", eventType, err)
		}
		if event.Type != eventType || event.State != StatePending {
			t.Fatalf("unexpected audit projection: %+v", event)
		}
	}
	invalid := bytes.Replace(valid, []byte("plan.previewed"), []byte("plan.unreviewed"), 1)
	if _, err := ValidateAuditJSON(invalid); err == nil {
		t.Fatal("unknown audit event type accepted")
	}
}
