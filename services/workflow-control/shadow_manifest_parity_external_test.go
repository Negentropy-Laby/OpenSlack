package workflowcontrol_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
)

type shadowArtifact struct {
	Path       string `json:"path"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

func TestTypeScriptShadowBundleAndGoWireParity(t *testing.T) {
	root := shadowContractRoot(t)
	var manifest struct {
		Schema    string `json:"schema"`
		Authority string `json:"authority"`
		Transport struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"transport"`
		Limits struct {
			MaxEnvelopeBytes int `json:"maxEnvelopeBytes"`
		} `json:"limits"`
		Artifacts   map[string]shadowArtifact `json:"artifacts"`
		BundleFiles []string                  `json:"bundleFiles"`
	}
	decodeJSON(t, filepath.Join(root, "manifest.json"), &manifest)
	if manifest.Schema != "openslack.workflow_control_shadow_contract_manifest.v1" ||
		manifest.Authority != workflowcontrol.Authority || manifest.Transport.Method != "POST" ||
		manifest.Transport.Path != workflowcontrol.ShadowObservationPath ||
		manifest.Limits.MaxEnvelopeBytes != workflowcontrol.MaxShadowEnvelopeBytes ||
		len(manifest.Artifacts) != 3 || len(manifest.BundleFiles) != 4 {
		t.Fatalf("shadow contract manifest drift: %#v", manifest)
	}
	for path, artifact := range manifest.Artifacts {
		if path != artifact.Path {
			t.Fatalf("artifact key/path drift: %q != %q", path, artifact.Path)
		}
		body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(body)
		if len(body) != artifact.ByteLength || hex.EncodeToString(digest[:]) != artifact.SHA256 {
			t.Fatalf("artifact bytes drifted: %s", path)
		}
	}

	var vectors struct {
		Schema    string `json:"schema"`
		Authority string `json:"authority"`
		Vectors   []struct {
			Envelope workflowcontrol.ShadowEnvelope `json:"envelope"`
			Expected struct {
				Body               string `json:"body"`
				IdempotencyKey     string `json:"idempotencyKey"`
				RequestFingerprint string `json:"requestFingerprint"`
			} `json:"expected"`
		} `json:"vectors"`
	}
	decodeJSON(t, filepath.Join(root, "golden-vectors.json"), &vectors)
	if vectors.Schema != "openslack.workflow_control_shadow_golden_vectors.v1" ||
		vectors.Authority != workflowcontrol.Authority || len(vectors.Vectors) == 0 {
		t.Fatalf("shadow golden vector identity drift: %#v", vectors)
	}
	for _, vector := range vectors.Vectors {
		body, err := workflowcontrol.CanonicalShadowEnvelopeBytes(vector.Envelope)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, []byte(vector.Expected.Body)) {
			t.Fatal("Go canonical shadow body differs from the TypeScript golden body")
		}
		prepared, err := shadowstore.PrepareObservation(body)
		if err != nil {
			t.Fatal(err)
		}
		if shadowstore.ExpectedIdempotencyKey(prepared) != vector.Expected.IdempotencyKey ||
			shadowstore.RequestFingerprint(prepared) != vector.Expected.RequestFingerprint {
			t.Fatal("Go exact-body request bindings differ from the TypeScript golden vector")
		}
	}
}

func decodeJSON(t *testing.T, path string, destination any) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(destination); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("%s contains trailing JSON", path)
	}
}

func shadowContractRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve shadow contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "packages", "workflows", "contracts", "workflow-control-shadow", "v1"))
}
