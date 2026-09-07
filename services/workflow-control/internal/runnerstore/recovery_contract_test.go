package runnerstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestRecoveryWireDifferentialVectors(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "packages", "workflows", "contracts", "workflow-recovery", "v2")
	raw, err := os.ReadFile(filepath.Join(root, "golden-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Schema, Name, Bytes string
		Valid               bool
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	var schemas map[string]any
	if err = json.Unmarshal([]byte(RecoverySchemasJSON), &schemas); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Schema+"/"+v.Name, func(t *testing.T) {
			compiler := jsonschema.NewCompiler()
			compiler.AssertFormat()
			if err := compiler.AddResource("urn:recovery", schemas[v.Schema]); err != nil {
				t.Fatal(err)
			}
			schema, err := compiler.Compile("urn:recovery")
			if err != nil {
				t.Fatal(err)
			}
			var value any
			if err = json.Unmarshal([]byte(v.Bytes), &value); err != nil {
				t.Fatal(err)
			}
			if got := schema.Validate(value) == nil; got != v.Valid {
				t.Fatalf("schema accepted=%v expected=%v", got, v.Valid)
			}
			if v.Schema == "BindingReconciliationRequest" {
				_, err = ParseBindingReconciliation([]byte(v.Bytes))
			} else {
				_, err = ParseBindingSettlement([]byte(v.Bytes))
			}
			if (err == nil) != v.Valid {
				t.Fatalf("Go accepted=%v expected=%v: %v", err == nil, v.Valid, err)
			}
		})
	}
}
