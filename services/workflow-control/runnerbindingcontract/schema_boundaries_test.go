package runnerbindingcontract

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The same corpus is checked against the generated JSON Schemas and TypeScript validators.
func TestSharedSchemaBoundaryCorpus(t *testing.T) {
	golden := loadBindingGolden(t)
	exchange := golden.Positive.Operations["resume_advance"]
	bases := map[string]any{
		"error":   Record{"schema": ErrorSchema, "code": string(ErrorCodes()[0]), "message": "closed contract failure", "bindingId": nil, "operation": nil, "reconciliationToken": nil},
		"receipt": exchange.StageReceipt.Value, "stage": exchange.Stage.Value, "resolution": exchange.Resolution.Value,
		"runtimeAdmission": golden.Positive.RuntimeAdmission.Request.Value, "runtimeAdmissionReceipt": golden.Positive.RuntimeAdmission.Receipt.Value,
	}
	prepared, err := PrepareRuntimeAdmission(bases["runtimeAdmission"])
	if err != nil {
		t.Fatal(err)
	}
	validators := map[string]func(any) (Record, error){
		"error": ValidateErrorRecord, "receipt": ValidateReceipt, "stage": ValidateStage, "resolution": ValidateResolution,
		"runtimeAdmission":        ValidateRuntimeAdmission,
		"runtimeAdmissionReceipt": func(v any) (Record, error) { return ValidateRuntimeAdmissionReceipt(v, prepared) },
	}
	contextual := map[string]func(*testing.T, any) (Record, error){}
	for kind, reference := range golden.Positive.ControlDelivery.ByKind {
		control := goldenControlArtifact(t, golden, reference)
		key := "control:" + kind
		bases[key] = control.Receipt.Value
		validators[key] = ValidateReceipt
		contextual[key] = func(t *testing.T, value any) (Record, error) {
			return ValidateControlDeliveryReceiptForMessage(value, control.Message, goldenControlContext(t, golden, kind, control))
		}
	}
	contents, err := os.ReadFile("../../../packages/workflows/contracts/workflow-runner-authority-binding/schema-boundaries.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		ID            string `json:"id"`
		Kind          string `json:"kind"`
		Accepted      bool   `json:"accepted"`
		ExpectedError *struct {
			Code    string `json:"code"`
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"expectedError"`
		Set    map[string]any `json:"set"`
		Remove []string       `json:"remove"`
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	if err := decoder.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	if err := normalizeGoldenNumbers(reflect.ValueOf(&cases)); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		t.Run(item.ID, func(t *testing.T) {
			base, ok := bases[item.Kind]
			if !ok {
				t.Fatal("unknown fixture kind")
			}
			exact, err := json.Marshal(base)
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]any
			decoder := json.NewDecoder(bytes.NewReader(exact))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil {
				t.Fatal(err)
			}
			if err := normalizeGoldenNumbers(reflect.ValueOf(&value)); err != nil {
				t.Fatal(err)
			}
			applyCorpusMutation(t, value, item.Set, item.Remove)
			if validate := contextual[item.Kind]; validate != nil {
				_, err := validate(t, value)
				if item.ExpectedError != nil {
					actual, ok := err.(*ContractError)
					if !ok || string(actual.Code) != item.ExpectedError.Code || actual.Path != item.ExpectedError.Path || actual.Message != item.ExpectedError.Message {
						t.Fatalf("contextual Go error identity mismatch: %v, want %+v", err, item.ExpectedError)
					}
				}
				if (err == nil) != item.Accepted {
					t.Fatalf("contextual Go accepted=%t want=%t: %v", err == nil, item.Accepted, err)
				}
			}
			_, err = validators[item.Kind](value)
			if item.ExpectedError != nil {
				actual, ok := err.(*ContractError)
				if !ok || string(actual.Code) != item.ExpectedError.Code || actual.Path != item.ExpectedError.Path || actual.Message != item.ExpectedError.Message {
					t.Fatalf("Go error identity mismatch: %v, want %+v", err, item.ExpectedError)
				}
			}
			if (err == nil) != item.Accepted {
				t.Fatalf("Go accepted=%t want=%t: %v", err == nil, item.Accepted, err)
			}
		})
	}
}

var corpusPathPattern = regexp.MustCompile(`^/[A-Za-z][A-Za-z0-9]*(/[A-Za-z][A-Za-z0-9]*)*$`)

func corpusPath(t *testing.T, path string) []string {
	t.Helper()
	if !validCorpusPath(path) {
		t.Fatal("invalid corpus path")
	}
	return strings.Split(path[1:], "/")
}

func validCorpusPath(path string) bool {
	if !corpusPathPattern.MatchString(path) {
		return false
	}
	for _, key := range strings.Split(path[1:], "/") {
		if key == "constructor" || key == "prototype" || key == "__proto__" {
			return false
		}
	}
	return true
}

func TestCorpusPathValidation(t *testing.T) {
	for _, path := range []string{"/__proto__/x", "/constructor/x", "target/x", "/target//x", "/target/", "/target/~1"} {
		if validCorpusPath(path) {
			t.Fatalf("accepted invalid corpus path %s", path)
		}
	}
	if !validCorpusPath("/target/idempotencyKey") {
		t.Fatal("valid corpus path rejected")
	}
}

func applyCorpusMutation(t *testing.T, value map[string]any, set map[string]any, remove []string) {
	t.Helper()
	parent := func(path string) (map[string]any, string) {
		keys := corpusPath(t, path)
		record := value
		for _, key := range keys[:len(keys)-1] {
			var ok bool
			record, ok = record[key].(map[string]any)
			if !ok {
				t.Fatalf("unknown fixture path %s", path)
			}
		}
		return record, keys[len(keys)-1]
	}
	paths := make([]string, 0, len(set))
	for path := range set {
		corpusPath(t, path)
		paths = append(paths, path)
	}
	for _, path := range remove {
		corpusPath(t, path)
	}
	sort.Slice(paths, func(i, j int) bool {
		a, b := strings.Count(paths[i], "/"), strings.Count(paths[j], "/")
		if a != b {
			return a < b
		}
		return paths[i] < paths[j]
	})
	for _, path := range paths {
		record, key := parent(path)
		record[key] = set[path]
	}
	for _, path := range remove {
		record, key := parent(path)
		delete(record, key)
	}
}

func TestSharedCorpusMutationResults(t *testing.T) {
	data, err := os.ReadFile("../../../packages/workflows/contracts/workflow-runner-authority-binding/corpus-operations.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		ID                  string
		Base, Set, Expected map[string]any
		Remove              []string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, row := range cases {
		t.Run(row.ID, func(t *testing.T) {
			applyCorpusMutation(t, row.Base, row.Set, row.Remove)
			if !reflect.DeepEqual(row.Base, row.Expected) {
				t.Fatalf("mutation result: %#v; expected %#v", row.Base, row.Expected)
			}
		})
	}
}
