package runnerbindingcontract

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
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
	contents, err := os.ReadFile("../../../packages/workflows/contracts/workflow-runner-authority-binding/schema-boundaries.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		ID       string         `json:"id"`
		Kind     string         `json:"kind"`
		Accepted bool           `json:"accepted"`
		Set      map[string]any `json:"set"`
		Remove   []string       `json:"remove"`
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
			parent := func(path string) (map[string]any, string) {
				keys := strings.Split(strings.TrimPrefix(path, "/"), "/")
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
			for path, change := range item.Set {
				record, key := parent(path)
				record[key] = change
			}
			for _, path := range item.Remove {
				record, key := parent(path)
				delete(record, key)
			}
			_, err = validators[item.Kind](value)
			if (err == nil) != item.Accepted {
				t.Fatalf("Go accepted=%t want=%t: %v", err == nil, item.Accepted, err)
			}
		})
	}
}
