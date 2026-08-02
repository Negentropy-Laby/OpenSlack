package workflowcontrol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"testing"
)

type goldenFile struct {
	Schema        string       `json:"schema"`
	Authority     string       `json:"authority"`
	HashAlgorithm string       `json:"hashAlgorithm"`
	Cases         []goldenCase `json:"cases"`
}

type goldenCase struct {
	ID            string          `json:"id"`
	Operation     string          `json:"operation"`
	Input         json.RawMessage `json:"input"`
	Expected      json.RawMessage `json:"expected"`
	ExpectedError *goldenError    `json:"expectedError"`
}

type goldenError struct {
	Name    string    `json:"name"`
	Code    ErrorCode `json:"code"`
	Path    string    `json:"path"`
	Message string    `json:"message"`
}

func decodeClosed(t *testing.T, input []byte, target any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("trailing JSON: %v", err)
	}
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	input, err := os.ReadFile("internal/contractmirror/generated/v1/golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var result goldenFile
	decodeClosed(t, input, &result)
	if result.Schema != "openslack.workflow_control_golden_vectors.v1" || result.Authority != Authority || result.HashAlgorithm != "sha256(canonical-json-utf8)" {
		t.Fatalf("golden identity drift: %+v", result)
	}
	return result
}

func contractError(t *testing.T, err error) *ContractError {
	t.Helper()
	var result *ContractError
	if !errors.As(err, &result) {
		t.Fatalf("got %T %v, want ContractError", err, err)
	}
	return result
}

func TestTypeScriptGoldenVectors(t *testing.T) {
	golden := loadGolden(t)
	expectedIDs := []string{
		"valid-projection", "terminal-run-projection", "invalid-schema", "invalid-status",
		"invalid-terminal-transition", "legacy-run-gate-is-not-effect-approval",
		"secret-like-raw-field-rejected", "phase-bound-enforced",
		"valid-observation-full-sha256",
	}
	actualIDs := make([]string, 0, len(golden.Cases))
	for _, testCase := range golden.Cases {
		actualIDs = append(actualIDs, testCase.ID)
	}
	if !reflect.DeepEqual(actualIDs, expectedIDs) {
		t.Fatalf("golden case drift: %v", actualIDs)
	}

	for _, testCase := range golden.Cases {
		testCase := testCase
		t.Run(testCase.ID, func(t *testing.T) {
			switch testCase.Operation {
			case "project":
				observation, err := ValidateObservationJSON(testCase.Input)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := ProjectReadModel(observation)
				if err != nil {
					t.Fatal(err)
				}
				var expected ReadModel
				decodeClosed(t, testCase.Expected, &expected)
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("projection mismatch:\n got %#v\nwant %#v", actual, expected)
				}
			case "hash":
				observation, err := ValidateObservationJSON(testCase.Input)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := HashObservation(observation)
				if err != nil {
					t.Fatal(err)
				}
				var expected string
				decodeClosed(t, testCase.Expected, &expected)
				if actual != expected {
					t.Fatalf("got %s, want %s", actual, expected)
				}
			case "transition":
				var input struct {
					From RunState `json:"from"`
					To   RunState `json:"to"`
				}
				decodeClosed(t, testCase.Input, &input)
				assertGoldenError(t, ValidateTransition(input.From, input.To), testCase.ExpectedError)
			case "validate":
				_, err := ValidateObservationJSON(testCase.Input)
				assertGoldenError(t, err, testCase.ExpectedError)
			default:
				t.Fatalf("unknown operation %q", testCase.Operation)
			}
		})
	}
}

func assertGoldenError(t *testing.T, err error, expected *goldenError) {
	t.Helper()
	if expected == nil {
		t.Fatal("missing expected error")
	}
	actual := contractError(t, err)
	if actual.Code != expected.Code || actual.Path != expected.Path {
		t.Fatalf("got %s at %s, want %s at %s", actual.Code, actual.Path, expected.Code, expected.Path)
	}
}

func TestStrictJSONAndCredentialBoundary(t *testing.T) {
	base := loadGolden(t).Cases[0].Input
	duplicate := bytes.Replace(base, []byte(`"schema":`), []byte(`"schema":"openslack.workflow_control_observation.v1","schema":`), 1)
	if _, err := ValidateObservationJSON(duplicate); err == nil {
		t.Fatal("duplicate key accepted")
	}
	if _, err := ValidateObservationJSON(append([]byte{0xef, 0xbb, 0xbf}, base...)); err == nil {
		t.Fatal("BOM accepted")
	}
	if _, err := ValidateObservationJSON([]byte(`{"schema":"openslack.workflow_control_observation.v1","args":{}}`)); contractError(t, err).Code != ErrorSensitiveField {
		t.Fatalf("sensitive field error: %v", err)
	}
}
