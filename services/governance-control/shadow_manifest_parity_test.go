package governancecontrol_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

type shadowArtifact struct {
	Path       string `json:"path"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type shadowManifest struct {
	Schema    string                    `json:"schema"`
	Authority string                    `json:"authority"`
	Artifacts map[string]shadowArtifact `json:"artifacts"`
}

func TestGovernanceShadowMirrorMatchesTypeScriptAuthorityExactly(t *testing.T) {
	const mirrorRoot = "internal/contractmirror/generated/shadow/v1"
	const authorityRoot = "../../packages/operator/contracts/governed-plan-shadow/v1"
	mirrorManifest, err := os.ReadFile(filepath.Join(mirrorRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	authorityManifest, err := os.ReadFile(filepath.Join(authorityRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mirrorManifest, authorityManifest) {
		t.Fatal("governance shadow manifest mirror is not exact authority bytes")
	}
	var manifest shadowManifest
	if err := json.Unmarshal(mirrorManifest, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Schema != "openslack.governance_shadow_contract_manifest.v1" || manifest.Authority != "typescript" || len(manifest.Artifacts) != 3 {
		t.Fatalf("unexpected shadow manifest identity: %#v", manifest)
	}
	for name, artifact := range manifest.Artifacts {
		if name != artifact.Path {
			t.Fatalf("artifact key/path drift: %q != %q", name, artifact.Path)
		}
		mirror, err := os.ReadFile(filepath.Join(mirrorRoot, filepath.FromSlash(artifact.Path)))
		if err != nil {
			t.Fatal(err)
		}
		authority, err := os.ReadFile(filepath.Join(authorityRoot, filepath.FromSlash(artifact.Path)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(mirror, authority) || len(mirror) != artifact.ByteLength {
			t.Fatalf("artifact %s is not exact authority bytes", artifact.Path)
		}
		digest := sha256.Sum256(mirror)
		if hex.EncodeToString(digest[:]) != artifact.SHA256 {
			t.Fatalf("artifact %s digest drift", artifact.Path)
		}
	}
}

func TestGovernanceShadowGoldenFingerprintMatchesAuthority(t *testing.T) {
	raw, err := os.ReadFile("internal/contractmirror/generated/shadow/v1/golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Vectors []struct {
			Expected struct {
				Body               string `json:"body"`
				IdempotencyKey     string `json:"idempotencyKey"`
				RequestFingerprint string `json:"requestFingerprint"`
			} `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Vectors) != 1 {
		t.Fatalf("golden vector count = %d", len(vectors.Vectors))
	}
	vector := vectors.Vectors[0].Expected
	prepared, err := shadowstore.PrepareObservation([]byte(vector.Body))
	if err != nil {
		t.Fatal(err)
	}
	if actual := shadowstore.RequestFingerprint(prepared); actual != vector.RequestFingerprint {
		t.Fatalf("fingerprint = %s, want %s", actual, vector.RequestFingerprint)
	}
	if err := shadowstore.ValidateIdempotencyKey(vector.IdempotencyKey); err != nil {
		t.Fatalf("authority idempotency key rejected: %v", err)
	}
	if actual := shadowstore.ExpectedIdempotencyKey(prepared); actual != vector.IdempotencyKey {
		t.Fatalf("idempotency key = %s, want %s", actual, vector.IdempotencyKey)
	}
}
