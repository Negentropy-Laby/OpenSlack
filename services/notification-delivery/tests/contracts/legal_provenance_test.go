package contracts_test

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

type productionModule struct {
	Path           string
	Version        string
	PrimaryLicense string
	LicenseFile    string
	LicenseSHA256  string
}

var productionModules = []productionModule{
	{"github.com/go-chi/chi/v5", "v5.2.0", "MIT", "LICENSE", "a2d51b7515acfaff2f7a88688650f2fc4fd99561383e72bba2305e3db59a1647"},
	{"github.com/golang-migrate/migrate/v4", "v4.18.1", "MIT", "LICENSE", "4c250e1d2cb21c738d5ec785f6fb1e03cd1e9adecfab46feb9494847872455be"},
	{"github.com/hashicorp/errwrap", "v1.1.0", "MPL-2.0", "LICENSE", "bef1747eda88b9ed46e94830b0d978c3499dad5dfe38d364971760881901dadd"},
	{"github.com/hashicorp/go-multierror", "v1.1.1", "MPL-2.0", "LICENSE", "a830016911a348a54e89bd54f2f8b0d8fffdeac20aecfba8e36ebbf38a03f5ff"},
	{"github.com/jackc/pgerrcode", "v0.0.0-20220416144525-469b46aa5efa", "MIT", "LICENSE", "ba651777b8362b30d778d60f7a0fcd1f01cdac79aa713d1a6f0a53bf5372fa2f"},
	{"github.com/jackc/pgpassfile", "v1.0.0", "MIT", "LICENSE", "adb1663fda031df8f4344aa68f299fd87d80353e31339406742ded21dae65702"},
	{"github.com/jackc/pgservicefile", "v0.0.0-20240606120523-5a60cdf6a761", "MIT", "LICENSE", "fc505773403fe869ed64cc2235cdd13988a427bb7e3a7e7004a3f4b27420f8fc"},
	{"github.com/jackc/pgx/v5", "v5.7.1", "MIT", "LICENSE", "467f95e074fe23079a5623ed652619682692041b8551da27e3c2ddb9659a1507"},
	{"github.com/jackc/puddle/v2", "v2.2.2", "MIT", "LICENSE", "2d50e98a4900b4d6457a38d39c1432fdc156fc2f7b365f2e33ec9344acbb0057"},
	{"go.uber.org/atomic", "v1.7.0", "MIT", "LICENSE.txt", "edbb5a4d165ac69376c765b551c0662ff42bea87e1f1eda85f42ac90c34b09d0"},
	{"golang.org/x/crypto", "v0.27.0", "BSD-3-Clause", "LICENSE", "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad"},
	{"golang.org/x/sync", "v0.8.0", "BSD-3-Clause", "LICENSE", "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad"},
	{"golang.org/x/text", "v0.18.0", "BSD-3-Clause", "LICENSE", "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad"},
}

func TestLegalAndHistoricalInputsRemainBound(t *testing.T) {
	serviceRoot := repositoryRoot(t)
	openSlackRoot := filepath.Clean(filepath.Join(serviceRoot, "..", ".."))
	expected := map[string]string{
		filepath.Join(openSlackRoot, "LICENSE"):                           "04f9674553a402c48856e9cc3f813a70bb59eb6033f33344980c8fd3a710c8f2",
		filepath.Join(openSlackRoot, "NOTICE"):                            "cab0fcd15bc126c7ca16763a34023aca9a08b71d6bebf1878f19da5771474c5a",
		filepath.Join(serviceRoot, "LICENSE"):                             "04f9674553a402c48856e9cc3f813a70bb59eb6033f33344980c8fd3a710c8f2",
		filepath.Join(serviceRoot, "NOTICE"):                              "1009b641213efcdef8aea6307ea9745c0473e42cf160d6c6c8530a0b61a575d1",
		filepath.Join(serviceRoot, "integration", "source-manifest.json"): "11ca033a6dc07677ed315e676728e18b2ea4be39835b1afdc2d36d2b44c3d87c",
		filepath.Join(serviceRoot, "THIRD_PARTY_NOTICES.md"):              "b537ef415b68027b321ca7db0a3dc065d74241e03829f5f7f70393a1c9f5d43f",
		filepath.Join(serviceRoot, "SBOM.cdx.json"):                       "a22c503aaf5efeec6c36d9a8e3362cebf37280aea3a43e45093516e5141727b7",
	}
	for path, want := range expected {
		if got := fileSHA256(t, path); got != want {
			t.Errorf("%s sha256=%s, want %s", path, got, want)
		}
	}

	rootNotices := readText(t, filepath.Join(openSlackRoot, "THIRD_PARTY_NOTICES.md"))
	tuiNotes := readText(t, filepath.Join(openSlackRoot, "docs", "contributor", "tui-porting-notes.md"))
	for name, text := range map[string]string{"THIRD_PARTY_NOTICES.md": rootNotices, "tui-porting-notes.md": tuiNotes} {
		if !strings.Contains(text, "082be66f5fb604b7ad4c16828ea3f1ac5fd30590") ||
			!strings.Contains(text, "OpenSlack-native") {
			t.Errorf("%s does not bind the OpenSlack-native design-system correction", name)
		}
		for _, forbidden := range []string{
			"Design-system components gated for PR 2",
			"Whether design-system components can be extracted and relicensed. **Gated",
			"design-system/              — ported + adapted primitives",
		} {
			if strings.Contains(text, forbidden) {
				t.Errorf("%s retains stale excluded-Aby claim %q", name, forbidden)
			}
		}
	}
	if !strings.Contains(rootNotices, "is not included in the current OpenSlack CLI archive") {
		t.Fatal("root notice does not preserve the service CLI-archive non-claim")
	}
}

func TestSourceManifestV2ValidatesAgainstClosedSchema(t *testing.T) {
	root := repositoryRoot(t)
	manifest := readJSONMap(t, filepath.Join(root, "integration", "source-manifest.v2.json"))
	schema := readJSONMap(t, filepath.Join(root, "integration", "schemas", "source-manifest.v2.schema.json"))
	assertEveryObjectSchemaIsClosed(t, schema, "$")
	if err := validateClosedJSONSchema(manifest, schema, schema, "$"); err != nil {
		t.Fatalf("source manifest v2 failed its schema: %v", err)
	}

	expectedBindings := []struct {
		path []string
		want string
	}{
		{[]string{"$schema"}, "./schemas/source-manifest.v2.schema.json"},
		{[]string{"schema"}, "negentropy_laby.notification_delivery_source.v2"},
		{[]string{"status"}, "REPOSITORY_IMPORTED_UNRELEASED"},
		{[]string{"historical_binding", "v1_manifest", "sha256"}, "11ca033a6dc07677ed315e676728e18b2ea4be39835b1afdc2d36d2b44c3d87c"},
		{[]string{"historical_binding", "review_baseline", "commit"}, "7976962e7de1c6ffcd234d2962b89dc4b23c95c0"},
		{[]string{"historical_binding", "archive_tag", "name"}, "integration-archive/rc-wsman-pre-ib6"},
		{[]string{"historical_binding", "archive_tag", "object"}, "b3d87f5074eb6ac7733e21d240bd5e2cf8e27a97"},
		{[]string{"historical_binding", "frozen_source", "repository"}, "https://github.com/wsman/rc_wsman.git"},
		{[]string{"historical_binding", "frozen_source", "commit"}, "982db466b2ba2c20bec150b7688bd398e4f52714"},
		{[]string{"historical_binding", "frozen_source", "tree"}, "7ac5144aeab9d453f39e2b6d2fbea828e7a89017"},
		{[]string{"import_binding", "pure_import", "commit"}, "141caadc2541490c32f3d5940f057de7bf703410"},
		{[]string{"import_binding", "pure_import", "tree"}, "f9c7c835e9385db1500a66b7fa5f354a07410695"},
		{[]string{"import_binding", "pure_import", "first_parent"}, "4eefd75abf490257c226bd596cfd58122edd879f"},
		{[]string{"import_binding", "pure_import", "second_parent"}, "982db466b2ba2c20bec150b7688bd398e4f52714"},
		{[]string{"import_binding", "openslack_merge", "commit"}, "bb3f234f93a9a86602693ee6dc3717f930c87213"},
		{[]string{"import_binding", "openslack_merge", "tree"}, "f9c7c835e9385db1500a66b7fa5f354a07410695"},
		{[]string{"import_binding", "openslack_merge", "first_parent"}, "4eefd75abf490257c226bd596cfd58122edd879f"},
		{[]string{"import_binding", "openslack_merge", "second_parent"}, "141caadc2541490c32f3d5940f057de7bf703410"},
		{[]string{"import_binding", "target_repository"}, "https://github.com/Negentropy-Laby/OpenSlack.git"},
		{[]string{"import_binding", "target_path"}, "services/notification-delivery"},
		{[]string{"relocation", "go_module"}, "github.com/Negentropy-Laby/OpenSlack/services/notification-delivery"},
		{[]string{"relocation", "registry_relocation", "status"}, "N/A_CURRENT_BASELINE"},
		{[]string{"relocation", "registry_relocation", "next"}, "DEFERRED_TO_PX0"},
		{[]string{"container_inputs", "dockerfile_frontend"}, "docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89"},
		{[]string{"container_inputs", "builder_image"}, "golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647"},
		{[]string{"container_inputs", "runtime_image"}, "debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"},
		{[]string{"container_inputs", "go_version"}, "1.26.5"},
		{[]string{"phase_f_receipt", "status"}, "PENDING_PHASE_F"},
		{[]string{"phase_f_receipt", "path_base"}, "OPENSLACK_REPOSITORY_ROOT"},
		{[]string{"phase_f_receipt", "expected_path"}, "integration/gates/ib6-history-import.json"},
	}
	for _, binding := range expectedBindings {
		if got := nestedValue(t, manifest, binding.path...); got != binding.want {
			t.Errorf("%s=%v, want %s", strings.Join(binding.path, "."), got, binding.want)
		}
	}
	if got := nestedValue(t, manifest, "historical_binding", "frozen_source", "commit_count"); got != float64(36) {
		t.Fatalf("frozen source commit count=%v, want 36", got)
	}
	for _, binding := range []struct {
		key      string
		path     string
		wantPath string
	}{
		{"license", "LICENSE", "LICENSE"},
		{"notice", "NOTICE", "NOTICE"},
		{"third_party_notices", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"},
		{"dependency_license_inventory", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"},
		{"repository_sbom_input", "SBOM.cdx.json", "SBOM.cdx.json"},
	} {
		if got := nestedValue(t, manifest, "legal_inputs", binding.key, "path"); got != binding.wantPath {
			t.Fatalf("%s path=%v, want %s", binding.key, got, binding.wantPath)
		}
		if got := nestedValue(t, manifest, "legal_inputs", binding.key, "sha256"); got != fileSHA256(t, filepath.Join(root, binding.path)) {
			t.Fatalf("%s binding=%v, want repository bytes", binding.key, got)
		}
	}
	if got := nestedValue(t, manifest, "legal_inputs", "dependency_license_inventory", "production_module_count"); got != float64(13) {
		t.Fatalf("dependency license production module count=%v, want 13", got)
	}
	if got := nestedValue(t, manifest, "legal_inputs", "repository_sbom_input", "scope"); got != "REPOSITORY_SOURCE_AND_BUILD_INPUTS" {
		t.Fatalf("repository SBOM scope=%v", got)
	}
	if got := nestedValue(t, manifest, "legal_inputs", "repository_sbom_input", "attestation"); got != "UNSIGNED" {
		t.Fatalf("repository SBOM attestation=%v", got)
	}
	if authorizes := nestedValue(t, manifest, "scope", "authorizes").([]any); len(authorizes) != 0 {
		t.Fatalf("source manifest authorizes=%v, want empty", authorizes)
	}
	if got := nestedValue(t, manifest, "scope", "non_claims"); !reflect.DeepEqual(got, []any{
		"RELEASE",
		"REGISTRY_INCLUSION",
		"SIGNED_PROVENANCE",
		"EXTERNAL_READINESS",
		"LIVE_VERIFIED",
		"G4",
		"G5_POST_IMPORT_QUALIFICATION",
		"IB7",
		"PRODUCTION",
		"CLI_ARCHIVE_INCLUSION",
		"STANDALONE_REPOSITORY_ARCHIVE",
		"DESTRUCTIVE_CLEANUP",
	}) {
		t.Fatalf("source manifest non-claims=%v", got)
	}
}

func TestSourceManifestV2RejectsGovernanceDrift(t *testing.T) {
	root := repositoryRoot(t)
	original := readJSONMap(t, filepath.Join(root, "integration", "source-manifest.v2.json"))
	schema := readJSONMap(t, filepath.Join(root, "integration", "schemas", "source-manifest.v2.schema.json"))
	mutations := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"historical-manifest", func(v map[string]any) { setNested(v, "changed", "historical_binding", "v1_manifest", "sha256") }},
		{"source-object", func(v map[string]any) { setNested(v, "changed", "historical_binding", "frozen_source", "commit") }},
		{"import-object", func(v map[string]any) { setNested(v, "changed", "import_binding", "pure_import", "commit") }},
		{"legal-hash", func(v map[string]any) { setNested(v, "changed", "legal_inputs", "notice", "sha256") }},
		{"container-digest", func(v map[string]any) { setNested(v, "changed", "container_inputs", "runtime_image") }},
		{"registry-disposition", func(v map[string]any) { setNested(v, "MOVED", "relocation", "registry_relocation", "status") }},
		{"phase-f-receipt", func(v map[string]any) { setNested(v, "PASS", "phase_f_receipt", "status") }},
		{"added-authority", func(v map[string]any) { setNested(v, []any{"RELEASE"}, "scope", "authorizes") }},
		{"dropped-non-claim", func(v map[string]any) {
			scope := v["scope"].(map[string]any)
			claims := scope["non_claims"].([]any)
			scope["non_claims"] = claims[:len(claims)-1]
		}},
		{"unknown-property", func(v map[string]any) { v["secret_value"] = "forbidden" }},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			candidate := cloneJSONMap(t, original)
			tc.mutate(candidate)
			if err := validateClosedJSONSchema(candidate, schema, schema, "$"); err == nil {
				t.Fatal("mutated source manifest unexpectedly passed")
			}
		})
	}
}

func TestProductionDependencyNoticesAndSBOMMatchGoList(t *testing.T) {
	root := repositoryRoot(t)
	want := make([]string, 0, len(productionModules))
	for _, module := range productionModules {
		want = append(want, module.Path+"@"+module.Version)
	}

	goBinary := filepath.Join(runtime.GOROOT(), "bin", "go")
	cmd := exec.Command(goBinary, "list", "-mod=readonly", "-deps", "-f", "{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}}{{end}}{{end}}", "./cmd/...")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN=local")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list production dependencies: %v\n%s", err, stderr.String())
	}
	actualSet := make(map[string]bool)
	for _, line := range strings.Split(string(output), "\n") {
		if line != "" {
			actualSet[line] = true
		}
	}
	actual := make([]string, 0, len(actualSet))
	for module := range actualSet {
		actual = append(actual, module)
	}
	sort.Strings(actual)
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("production modules=%v, want %v", actual, want)
	}
	moduleCacheCommand := exec.Command(goBinary, "env", "GOMODCACHE")
	moduleCacheCommand.Dir = root
	moduleCacheCommand.Env = append(os.Environ(), "GOTOOLCHAIN=local")
	moduleCacheOutput, err := moduleCacheCommand.Output()
	if err != nil {
		t.Fatalf("resolve Go module cache: %v", err)
	}
	moduleCache := strings.TrimSpace(string(moduleCacheOutput))
	for _, module := range productionModules {
		upstreamLicense := filepath.Join(
			moduleCache,
			filepath.FromSlash(module.Path+"@"+module.Version),
			module.LicenseFile,
		)
		if got := fileSHA256(t, upstreamLicense); got != module.LicenseSHA256 {
			t.Fatalf("%s@%s upstream %s sha256=%s, want %s", module.Path, module.Version, module.LicenseFile, got, module.LicenseSHA256)
		}
	}

	notices := readText(t, filepath.Join(root, "THIRD_PARTY_NOTICES.md"))
	var noticeRows [][]string
	for _, line := range strings.Split(notices, "\n") {
		if !strings.HasPrefix(line, "| `") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) != 6 {
			t.Fatalf("invalid notice inventory row %q", line)
		}
		row := make([]string, 0, 4)
		for _, part := range parts[1:5] {
			row = append(row, strings.Trim(strings.TrimSpace(part), "`"))
		}
		noticeRows = append(noticeRows, row)
	}
	if len(noticeRows) != len(productionModules) {
		t.Fatalf("notice inventory rows=%d, want %d", len(noticeRows), len(productionModules))
	}
	licenseCounts := map[string]int{}
	for index, module := range productionModules {
		wantRow := []string{module.Path, module.Version, module.PrimaryLicense, module.LicenseSHA256}
		if !reflect.DeepEqual(noticeRows[index], wantRow) {
			t.Fatalf("notice row[%d]=%v, want %v", index, noticeRows[index], wantRow)
		}
		licenseCounts[module.PrimaryLicense]++

		section := "### " + module.Path + "@" + module.Version + "\n\nPrimary license: " + module.PrimaryLicense + "\n\n```text\n"
		start := strings.Index(notices, section)
		if start < 0 {
			t.Fatalf("complete upstream license section missing: %s@%s", module.Path, module.Version)
		}
		start += len(section)
		end := strings.Index(notices[start:], "```\n")
		if end < 0 {
			t.Fatalf("unterminated upstream license section: %s@%s", module.Path, module.Version)
		}
		if got := fmt.Sprintf("%x", sha256.Sum256([]byte(notices[start:start+end]))); got != module.LicenseSHA256 {
			t.Fatalf("%s@%s embedded license sha256=%s, want %s", module.Path, module.Version, got, module.LicenseSHA256)
		}
	}
	if !reflect.DeepEqual(licenseCounts, map[string]int{"MIT": 8, "MPL-2.0": 2, "BSD-3-Clause": 3}) {
		t.Fatalf("primary license counts=%v", licenseCounts)
	}

	var bom struct {
		BOMFormat   string `json:"bomFormat"`
		SpecVersion string `json:"specVersion"`
		Version     int    `json:"version"`
		Metadata    struct {
			Component struct {
				Type    string `json:"type"`
				BOMRef  string `json:"bom-ref"`
				Group   string `json:"group"`
				Name    string `json:"name"`
				Version string `json:"version"`
				PURL    string `json:"purl"`
			} `json:"component"`
			Properties []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"properties"`
		} `json:"metadata"`
		Components []struct {
			Type     string `json:"type"`
			BOMRef   string `json:"bom-ref"`
			Name     string `json:"name"`
			Version  string `json:"version"`
			PURL     string `json:"purl"`
			Licenses []struct {
				License struct {
					ID string `json:"id"`
				} `json:"license"`
			} `json:"licenses"`
			Hashes []struct {
				Algorithm string `json:"alg"`
				Content   string `json:"content"`
			} `json:"hashes"`
			Properties []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"properties"`
		} `json:"components"`
		Dependencies []struct {
			Ref       string   `json:"ref"`
			DependsOn []string `json:"dependsOn"`
		} `json:"dependencies"`
	}
	readLegalJSON(t, filepath.Join(root, "SBOM.cdx.json"), &bom)
	rawBOM := readJSONMap(t, filepath.Join(root, "SBOM.cdx.json"))
	if _, present := rawBOM["timestamp"]; present {
		t.Fatal("deterministic repository SBOM must not contain a timestamp")
	}
	if _, present := rawBOM["serialNumber"]; present {
		t.Fatal("deterministic repository SBOM must not contain a generated serial number")
	}
	const rootPURL = "pkg:golang/github.com/negentropy-laby/openslack/services/notification-delivery@unreleased"
	if bom.BOMFormat != "CycloneDX" || bom.SpecVersion != "1.6" || bom.Version != 1 ||
		bom.Metadata.Component.Type != "application" ||
		bom.Metadata.Component.BOMRef != rootPURL ||
		bom.Metadata.Component.Group != "github.com/Negentropy-Laby/OpenSlack/services" ||
		bom.Metadata.Component.Name != "notification-delivery" ||
		bom.Metadata.Component.Version != "unreleased" ||
		bom.Metadata.Component.PURL != rootPURL {
		t.Fatalf("repository SBOM root component=%+v", bom.Metadata.Component)
	}
	if len(bom.Components) != len(productionModules)+4 {
		t.Fatalf("SBOM components=%d, want 13 modules plus four build inputs", len(bom.Components))
	}
	for i, module := range productionModules {
		component := bom.Components[i]
		wantLicenseIDs := []string{module.PrimaryLicense}
		if module.Path == "github.com/jackc/pgerrcode" {
			wantLicenseIDs = append(wantLicenseIDs, "PostgreSQL")
		}
		var licenseIDs []string
		for _, license := range component.Licenses {
			licenseIDs = append(licenseIDs, license.License.ID)
		}
		if component.Type != "library" || component.Name != module.Path || component.Version != module.Version ||
			component.BOMRef != "pkg:golang/"+module.Path+"@"+module.Version ||
			component.PURL != component.BOMRef || !reflect.DeepEqual(licenseIDs, wantLicenseIDs) ||
			len(component.Properties) != 1 ||
			propertyValue(component.Properties, "openslack:upstream-license-file-sha256") != module.LicenseSHA256 {
			t.Fatalf("SBOM production component[%d]=%+v, want %s@%s/%s", i, component, module.Path, module.Version, module.PrimaryLicense)
		}
	}
	if got := []string{bom.Components[13].BOMRef, bom.Components[14].BOMRef, bom.Components[15].BOMRef, bom.Components[16].BOMRef}; !reflect.DeepEqual(got, []string{
		"pkg:generic/go@1.26.5",
		"pkg:oci/docker/dockerfile@sha256%3A87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89",
		"pkg:oci/golang@sha256%3A3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647",
		"pkg:oci/debian@sha256%3A7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818",
	}) {
		t.Fatalf("SBOM build inputs=%v", got)
	}
	if bom.Components[13].Type != "platform" || bom.Components[13].Name != "Go toolchain" ||
		bom.Components[13].Version != "1.26.5" || bom.Components[13].PURL != bom.Components[13].BOMRef ||
		len(bom.Components[13].Properties) != 1 ||
		propertyValue(bom.Components[13].Properties, "openslack:role") != "compiler" {
		t.Fatalf("SBOM Go toolchain input=%+v", bom.Components[13])
	}
	for index, expected := range []struct {
		name    string
		version string
		digest  string
		role    string
	}{
		{"docker/dockerfile", "1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89", "87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89", "dockerfile-frontend"},
		{"golang", "1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647", "3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647", "builder-image"},
		{"debian", "bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818", "7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818", "runtime-image"},
	} {
		component := bom.Components[index+14]
		if component.Type != "container" || component.Name != expected.name ||
			component.Version != expected.version || component.PURL != component.BOMRef ||
			len(component.Hashes) != 1 || component.Hashes[0].Algorithm != "SHA-256" ||
			component.Hashes[0].Content != expected.digest || len(component.Properties) != 1 ||
			propertyValue(component.Properties, "openslack:role") != expected.role {
			t.Fatalf("SBOM OCI input[%d]=%+v", index, component)
		}
	}
	if len(bom.Dependencies) != 1 || bom.Dependencies[0].Ref != rootPURL ||
		!reflect.DeepEqual(bom.Dependencies[0].DependsOn, prefixedModules(want)) {
		t.Fatalf("SBOM dependency order=%v", bom.Dependencies)
	}
	if len(bom.Metadata.Properties) != 5 {
		t.Fatalf("SBOM metadata properties=%d, want exact five non-claims", len(bom.Metadata.Properties))
	}
	properties := make(map[string]string)
	for _, property := range bom.Metadata.Properties {
		if _, duplicate := properties[property.Name]; duplicate {
			t.Fatalf("duplicate SBOM metadata property %q", property.Name)
		}
		properties[property.Name] = property.Value
	}
	if !reflect.DeepEqual(properties, map[string]string{
		"openslack:inventory-scope":      "repository-source-and-build-inputs",
		"openslack:release-status":       "unreleased",
		"openslack:attestation-status":   "unsigned-repository-input",
		"openslack:final-oci-filesystem": "not-inventoried",
		"openslack:registry-status":      "not-published",
	}) {
		t.Fatalf("SBOM non-claims=%v", properties)
	}
}

func TestBothFinalContainerTargetsInheritTheFixedLegalBundle(t *testing.T) {
	root := repositoryRoot(t)
	dockerfile := readText(t, filepath.Join(root, "Dockerfile"))
	app := strings.Index(dockerfile, " AS app\n")
	canary := strings.Index(dockerfile, "\nFROM app AS canary-webhook-receiver\n")
	if app < 0 || canary <= app {
		t.Fatal("canary final target does not inherit the app legal-bundle stage")
	}
	for _, line := range []string{
		"COPY --chmod=0444 LICENSE NOTICE THIRD_PARTY_NOTICES.md SBOM.cdx.json /usr/share/doc/openslack-notification-delivery/",
		"COPY --chmod=0444 integration/source-manifest.v2.json /usr/share/doc/openslack-notification-delivery/source-manifest.v2.json",
		"COPY --chmod=0444 integration/schemas/source-manifest.v2.schema.json /usr/share/doc/openslack-notification-delivery/schemas/source-manifest.v2.schema.json",
	} {
		index := strings.Index(dockerfile, line)
		if index < app || index >= canary {
			t.Fatalf("legal bundle line is absent from inherited app stage: %s", line)
		}
	}
}

func fileSHA256(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func readLegalJSON(t *testing.T, path string, target any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

func readJSONMap(t *testing.T, path string) map[string]any {
	t.Helper()
	var value map[string]any
	readLegalJSON(t, path, &value)
	return value
}

func cloneJSONMap(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var clone map[string]any
	if err := json.Unmarshal(data, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}

func nestedValue(t *testing.T, value map[string]any, path ...string) any {
	t.Helper()
	var current any = value
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%v is not an object before %q", path, key)
		}
		current, ok = object[key]
		if !ok {
			t.Fatalf("%v missing %q", path, key)
		}
	}
	return current
}

func setNested(value map[string]any, replacement any, path ...string) {
	current := value
	for _, key := range path[:len(path)-1] {
		current = current[key].(map[string]any)
	}
	current[path[len(path)-1]] = replacement
}

func assertEveryObjectSchemaIsClosed(t *testing.T, value any, path string) {
	t.Helper()
	switch node := value.(type) {
	case map[string]any:
		if node["type"] == "object" && node["additionalProperties"] != false {
			t.Errorf("%s object schema is not closed", path)
		}
		for key, child := range node {
			assertEveryObjectSchemaIsClosed(t, child, path+"."+key)
		}
	case []any:
		for index, child := range node {
			assertEveryObjectSchemaIsClosed(t, child, fmt.Sprintf("%s[%d]", path, index))
		}
	}
}

func validateClosedJSONSchema(value any, schema map[string]any, root map[string]any, path string) error {
	if reference, ok := schema["$ref"].(string); ok {
		const prefix = "#/$defs/"
		if !strings.HasPrefix(reference, prefix) {
			return fmt.Errorf("%s unsupported reference %q", path, reference)
		}
		definitions := root["$defs"].(map[string]any)
		target, ok := definitions[strings.TrimPrefix(reference, prefix)].(map[string]any)
		if !ok {
			return fmt.Errorf("%s unresolved reference %q", path, reference)
		}
		return validateClosedJSONSchema(value, target, root, path)
	}
	if expected, ok := schema["const"]; ok && !reflect.DeepEqual(value, expected) {
		return fmt.Errorf("%s=%v, want const %v", path, value, expected)
	}
	switch schema["type"] {
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("%s is not an object", path)
		}
		properties, _ := schema["properties"].(map[string]any)
		if schema["additionalProperties"] == false {
			for key := range object {
				if _, known := properties[key]; !known {
					return fmt.Errorf("%s has unknown property %q", path, key)
				}
			}
		}
		if required, ok := schema["required"].([]any); ok {
			for _, item := range required {
				key := item.(string)
				if _, present := object[key]; !present {
					return fmt.Errorf("%s missing required property %q", path, key)
				}
			}
		}
		for key, child := range object {
			childSchema, ok := properties[key].(map[string]any)
			if !ok {
				return fmt.Errorf("%s.%s has no schema", path, key)
			}
			if err := validateClosedJSONSchema(child, childSchema, root, path+"."+key); err != nil {
				return err
			}
		}
	case "array":
		items, ok := value.([]any)
		if !ok {
			return fmt.Errorf("%s is not an array", path)
		}
		if maximum, ok := schema["maxItems"].(float64); ok && len(items) > int(maximum) {
			return fmt.Errorf("%s has %d items, maximum %d", path, len(items), int(maximum))
		}
	case "string":
		if _, ok := value.(string); !ok {
			return fmt.Errorf("%s is not a string", path)
		}
	}
	return nil
}

func propertyValue(properties []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}, name string) string {
	for _, property := range properties {
		if property.Name == name {
			return property.Value
		}
	}
	return ""
}

func prefixedModules(modules []string) []string {
	result := make([]string, len(modules))
	for i, module := range modules {
		result[i] = "pkg:golang/" + module
	}
	return result
}
