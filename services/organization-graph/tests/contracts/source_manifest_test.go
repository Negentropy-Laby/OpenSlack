package contracts

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

func assertManifestReference(t *testing.T, repositoryRoot string, reference manifestReference) {
	t.Helper()
	if len(reference.SHA256) != sha256.Size*2 {
		t.Fatalf("invalid SHA-256 for %s", reference.Path)
	}
	decoded, err := hex.DecodeString(reference.SHA256)
	if err != nil || len(decoded) != sha256.Size {
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
	actual := sha256.Sum256(body)
	if hex.EncodeToString(actual[:]) != reference.SHA256 {
		t.Fatalf("SHA-256 drift for %s", reference.Path)
	}
}

func TestSourceManifestBindsRepositoryInputsWithoutReleaseClaims(t *testing.T) {
	root := filepath.Clean(filepath.Join(serviceRoot(t), "..", ".."))
	var manifest sourceManifest
	decodeClosedJSON(
		t,
		filepath.Join(serviceRoot(t), "integration", "source-manifest.v2.json"),
		&manifest,
	)
	if manifest.Schema != "openslack.organization_graph_source.v2" ||
		manifest.Status != "REPOSITORY_SOURCE_INPUT_UNRELEASED" ||
		manifest.Service.GoModule != "github.com/Negentropy-Laby/OpenSlack/services/organization-graph" ||
		manifest.Service.TargetPath != "services/organization-graph" ||
		manifest.Service.MigrationPhase != "GS1-C" ||
		manifest.Service.Authority != "GO_SHADOW_TS_LOCAL_WRITER" ||
		len(manifest.Scope.Authorizes) != 0 {
		t.Fatalf("source manifest widened authority: %#v", manifest)
	}
	if len(manifest.ContainerInputs) != 6 ||
		manifest.ContainerInputs["goVersion"] != "1.26.5" ||
		len(manifest.SourceInputs) != 3 ||
		len(manifest.ContractInputs) != 2 {
		t.Fatalf("source manifest input inventory drifted")
	}
	requiredNonClaims := []string{
		"GO_WRITE_AUTHORITY",
		"LIVE_VERIFIED",
		"PRODUCTION",
		"QODER_VERIFIED",
		"READ_CUTOVER",
		"REGISTRY_INCLUSION",
		"RELEASE",
		"SIGNED_PROVENANCE",
	}
	actualNonClaims := append([]string(nil), manifest.Scope.NonClaims...)
	sort.Strings(actualNonClaims)
	if strings.Join(actualNonClaims, "\n") != strings.Join(requiredNonClaims, "\n") {
		t.Fatalf("source manifest non-claims = %v", manifest.Scope.NonClaims)
	}
	for _, references := range []map[string]manifestReference{
		manifest.SourceInputs,
		manifest.ContractInputs,
	} {
		for _, reference := range references {
			assertManifestReference(t, root, reference)
		}
	}
	assertManifestReference(t, root, manifest.LegalInputs.License)
	assertManifestReference(t, root, manifest.LegalInputs.Notice)
	assertManifestReference(t, root, manifest.LegalInputs.ThirdPartyNotices.manifestReference)
	assertManifestReference(t, root, manifest.LegalInputs.RepositorySBOMInput.manifestReference)
	if manifest.LegalInputs.ThirdPartyNotices.ProductionModuleCount != 12 ||
		manifest.LegalInputs.RepositorySBOMInput.Scope != "SELECTED_REPOSITORY_SOURCE_AND_BUILD_INPUTS" ||
		manifest.LegalInputs.RepositorySBOMInput.Attestation != "UNSIGNED" {
		t.Fatalf("source manifest distribution scope drifted")
	}
}

func TestRepositorySBOMIsAnUnsignedTwelveModuleInputInventory(t *testing.T) {
	var sbom struct {
		BOMFormat   string `json:"bomFormat"`
		SpecVersion string `json:"specVersion"`
		Components  []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"components"`
	}
	decodeJSON(t, filepath.Join(serviceRoot(t), "SBOM.cdx.json"), &sbom)
	if sbom.BOMFormat != "CycloneDX" || sbom.SpecVersion != "1.6" ||
		len(sbom.Components) != 12 {
		t.Fatalf("unexpected repository SBOM identity or inventory size: %#v", sbom)
	}
	unique := make(map[string]struct{}, len(sbom.Components))
	for _, component := range sbom.Components {
		identity := component.Name + "@" + component.Version
		unique[identity] = struct{}{}
	}
	if len(unique) != 12 {
		t.Fatalf("repository SBOM component identities are not distinct")
	}
}

func TestComposePublishesDevelopmentPortsOnLoopbackOnly(t *testing.T) {
	body, err := os.ReadFile(filepath.Join(serviceRoot(t), "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, binding := range []string{
		`127.0.0.1:${GRAPH_DB_PORT:-5432}:5432`,
		`127.0.0.1:${GRAPH_APP_PORT:-8080}:8080`,
		`127.0.0.1:${GRAPH_PROMETHEUS_PORT:-9090}:9090`,
	} {
		if !strings.Contains(source, binding) {
			t.Fatalf("docker-compose.yml is missing loopback-only port binding %q", binding)
		}
	}
}
