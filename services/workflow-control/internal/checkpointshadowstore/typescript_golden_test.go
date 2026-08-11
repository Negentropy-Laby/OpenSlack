package checkpointshadowstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func TestTypeScriptCheckpointShadowGoldenVectors(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve checkpoint shadow contract test path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "packages", "workflows", "contracts", "workflow-checkpoint-shadow", "v1", "golden-vectors.json"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var bundle struct {
		Schema, Authority, GoRole string
		Vectors                   map[string]struct {
			CanonicalBytes string `json:"canonicalBytes"`
			SHA256         string `json:"sha256"`
		}
	}
	if err := json.Unmarshal(body, &bundle); err != nil {
		t.Fatal(err)
	}
	if bundle.Schema != "openslack.workflow_checkpoint_shadow_golden_vectors.v1" || bundle.Authority != "typescript" || bundle.GoRole != "observer_only" {
		t.Fatalf("unexpected TypeScript golden bundle identity: %#v", bundle)
	}
	for _, name := range []string{"checkpointCommit", "resumeAdvance"} {
		vector, ok := bundle.Vectors[name]
		if !ok {
			t.Fatalf("missing TypeScript golden vector %s", name)
		}
		prepared, err := PrepareObservation([]byte(vector.CanonicalBytes))
		if err != nil {
			t.Fatalf("prepare %s: %v", name, err)
		}
		digest := sha256.Sum256([]byte(vector.CanonicalBytes))
		if prepared.EnvelopeHash != vector.SHA256 || hex.EncodeToString(digest[:]) != vector.SHA256 {
			t.Fatalf("%s SHA-256 drift", name)
		}
	}
	for _, name := range []string{"acceptedReplay", "reconciliation"} {
		vector, ok := bundle.Vectors[name]
		if !ok {
			t.Fatalf("missing TypeScript golden vector %s", name)
		}
		var value ReceiptValue
		decoder := json.NewDecoder(bytes.NewBufferString(vector.CanonicalBytes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		if err := ValidateReceiptValue(value); err != nil {
			t.Fatalf("validate %s: %v", name, err)
		}
		canonical, err := canonicaljson.Encode(value)
		if err != nil || string(canonical) != vector.CanonicalBytes {
			t.Fatalf("%s canonical receipt drift: %v", name, err)
		}
		digest := sha256.Sum256(canonical)
		if hex.EncodeToString(digest[:]) != vector.SHA256 {
			t.Fatalf("%s receipt SHA-256 drift", name)
		}
	}
}
