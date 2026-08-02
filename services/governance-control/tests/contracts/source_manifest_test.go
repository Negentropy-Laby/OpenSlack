package contracts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type manifestReference struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type sourceManifest struct {
	Schema  string `json:"schema"`
	Status  string `json:"status"`
	Service struct {
		GoModule       string `json:"goModule"`
		TargetPath     string `json:"targetPath"`
		MigrationPhase string `json:"migrationPhase"`
		RuntimeProfile string `json:"runtimeProfile"`
		Authority      string `json:"authority"`
	} `json:"service"`
	ContainerInputs map[string]string            `json:"containerInputs"`
	SourceInputs    map[string]manifestReference `json:"sourceInputs"`
	ContractInputs  map[string]manifestReference `json:"contractInputs"`
	LegalInputs     struct {
		License           manifestReference `json:"license"`
		Notice            manifestReference `json:"notice"`
		ThirdPartyNotices struct {
			manifestReference
			ProductionModuleCount int `json:"productionModuleCount"`
		} `json:"thirdPartyNotices"`
		RepositorySBOMInput struct {
			manifestReference
			Scope       string `json:"scope"`
			Attestation string `json:"attestation"`
		} `json:"repositorySbomInput"`
	} `json:"legalInputs"`
	Scope struct {
		Authorizes []string `json:"authorizes"`
		NonClaims  []string `json:"nonClaims"`
	} `json:"scope"`
}

func decodeClosedJSON(t *testing.T, path string, destination any) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("%s contains trailing JSON", path)
	}
}

func assertManifestReference(t *testing.T, repositoryRoot string, reference manifestReference) {
	t.Helper()
	if len(reference.SHA256) != sha256.Size*2 {
		t.Fatalf("invalid SHA-256 for %s", reference.Path)
	}
	if decoded, err := hex.DecodeString(reference.SHA256); err != nil || len(decoded) != sha256.Size {
		t.Fatalf("invalid SHA-256 for %s", reference.Path)
	}
	target := filepath.Clean(filepath.Join(repositoryRoot, filepath.FromSlash(reference.Path)))
	relative, err := filepath.Rel(repositoryRoot, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		t.Fatalf("manifest path escapes repository: %s", reference.Path)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read %s: %v", reference.Path, err)
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != reference.SHA256 {
		t.Fatalf("SHA-256 drift for %s", reference.Path)
	}
}

func TestSourceManifestBindsGS5InputsWithoutAuthorityOrReleaseClaims(t *testing.T) {
	repositoryRoot := filepath.Clean(filepath.Join(serviceRoot(t), "..", ".."))
	var manifest sourceManifest
	decodeClosedJSON(t, filepath.Join(serviceRoot(t), "integration", "source-manifest.v2.json"), &manifest)
	if manifest.Schema != "openslack.governance_control_source.v2" ||
		manifest.Status != "REPOSITORY_SOURCE_INPUT_UNRELEASED" ||
		manifest.Service.GoModule != "github.com/Negentropy-Laby/OpenSlack/services/governance-control" ||
		manifest.Service.TargetPath != "services/governance-control" ||
		manifest.Service.MigrationPhase != "GS5" ||
		manifest.Service.RuntimeProfile != "governance-control-v1" ||
		manifest.Service.Authority != "TYPESCRIPT_GOVERNED_PLAN_AUTHORITY_GO_CREDENTIAL_FREE_SHADOW" {
		t.Fatalf("source manifest identity or authority drifted: %#v", manifest)
	}
	if len(manifest.ContainerInputs) != 6 || manifest.ContainerInputs["goVersion"] != "1.26.5" ||
		len(manifest.SourceInputs) != 3 || len(manifest.ContractInputs) != 3 {
		t.Fatal("source manifest input inventory drifted")
	}
	if strings.Join(manifest.Scope.Authorizes, "\n") != "DURABLE_GOVERNANCE_SHADOW_OBSERVATION\nCREDENTIAL_FREE_PARITY_PROJECTION" {
		t.Fatalf("source manifest widened runtime scope: %v", manifest.Scope.Authorizes)
	}
	wantNonClaims := []string{
		"CONFIRMATION_AUTHORITY", "EXECUTION_AUTHORITY", "GOVERNED_PLAN_WRITE_AUTHORITY", "LIVE_VERIFIED", "PRODUCTION",
		"QODER_VERIFIED", "REGISTRY_INCLUSION", "RELEASE", "SIGNED_PROVENANCE", "WORKFLOW_MUTATION_AUTHORITY",
	}
	actualNonClaims := append([]string(nil), manifest.Scope.NonClaims...)
	sort.Strings(actualNonClaims)
	if strings.Join(actualNonClaims, "\n") != strings.Join(wantNonClaims, "\n") {
		t.Fatalf("source manifest non-claims = %v", manifest.Scope.NonClaims)
	}
	for _, references := range []map[string]manifestReference{manifest.SourceInputs, manifest.ContractInputs} {
		for _, reference := range references {
			assertManifestReference(t, repositoryRoot, reference)
		}
	}
	assertManifestReference(t, repositoryRoot, manifest.LegalInputs.License)
	assertManifestReference(t, repositoryRoot, manifest.LegalInputs.Notice)
	assertManifestReference(t, repositoryRoot, manifest.LegalInputs.ThirdPartyNotices.manifestReference)
	assertManifestReference(t, repositoryRoot, manifest.LegalInputs.RepositorySBOMInput.manifestReference)
	if manifest.LegalInputs.ThirdPartyNotices.ProductionModuleCount != 12 ||
		manifest.LegalInputs.RepositorySBOMInput.Scope != "SELECTED_REPOSITORY_SOURCE_AND_BUILD_INPUTS" ||
		manifest.LegalInputs.RepositorySBOMInput.Attestation != "UNSIGNED" {
		t.Fatal("source manifest legal inventory drifted")
	}
}
